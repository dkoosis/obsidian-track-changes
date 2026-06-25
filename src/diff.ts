import type { SourceEdit } from "./operations";
import { beforeAnchor } from "./operations";

export interface DiffRun {
  text: string;
  changed: boolean;
}

export interface CharDiff {
  oldRuns: DiffRun[];
  newRuns: DiffRun[];
}

const LCS_CAP = 250_000;

export function diffChars(oldText: string, newText: string): CharDiff {
  let p = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (p < minLen && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;

  let s = 0;
  const maxSuffix = minLen - p;
  while (
    s < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)
  ) {
    s++;
  }

  const midOld = oldText.slice(p, oldText.length - s);
  const midNew = newText.slice(p, newText.length - s);

  const oldRuns: DiffRun[] = [];
  const newRuns: DiffRun[] = [];

  if (p > 0) {
    const common: DiffRun = { text: oldText.slice(0, p), changed: false };
    oldRuns.push(common);
    newRuns.push({ text: common.text, changed: false });
  }

  // Char-level highlight only when a shared edge (prefix or suffix) signals a
  // typo/inflection — the eye is in letter-mode (recieve->receive, colour->color,
  // cat->bat). With no shared edge it's a whole-word swap; the reader is in
  // word-mode, so scatter-matching stray letters (Context/Reason share "on") just
  // adds noise. Render those solid instead.
  const sharedEdge = p > 0 || s > 0;
  if (
    sharedEdge &&
    midOld.length > 0 &&
    midNew.length > 0 &&
    midOld.length * midNew.length <= LCS_CAP
  ) {
    const [midOldRuns, midNewRuns] = lcsRuns(midOld, midNew);
    for (const r of midOldRuns) oldRuns.push(r);
    for (const r of midNewRuns) newRuns.push(r);
  } else {
    if (midOld.length > 0) oldRuns.push({ text: midOld, changed: true });
    if (midNew.length > 0) newRuns.push({ text: midNew, changed: true });
  }

  if (s > 0) {
    const common: DiffRun = { text: oldText.slice(oldText.length - s), changed: false };
    oldRuns.push(common);
    newRuns.push({ text: common.text, changed: false });
  }

  return { oldRuns: coalesce(oldRuns), newRuns: coalesce(newRuns) };
}

function lcsRuns(a: string, b: string): [DiffRun[], DiffRun[]] {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * w + j;
      if (a.charCodeAt(i) === b.charCodeAt(j)) {
        dp[idx] = dp[(i + 1) * w + (j + 1)]! + 1; // safe: indices in [0, dp.length)
      } else {
        const down = dp[(i + 1) * w + j]!; // safe: index in bounds
        const right = dp[i * w + (j + 1)]!; // safe: index in bounds
        dp[idx] = down >= right ? down : right;
      }
    }
  }

  const aRuns: DiffRun[] = [];
  const bRuns: DiffRun[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) {
      pushChar(aRuns, a[i]!, false); // safe: i < n
      pushChar(bRuns, b[j]!, false); // safe: j < m
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) { // safe: indices in bounds
      pushChar(aRuns, a[i]!, true); // safe: i < n
      i++;
    } else {
      pushChar(bRuns, b[j]!, true); // safe: j < m
      j++;
    }
  }
  while (i < n) pushChar(aRuns, a[i++]!, true); // safe: i < n
  while (j < m) pushChar(bRuns, b[j++]!, true); // safe: j < m
  return [aRuns, bRuns];
}

function pushChar(runs: DiffRun[], ch: string, changed: boolean): void {
  const last = runs[runs.length - 1];
  if (last && last.changed === changed) last.text += ch;
  else runs.push({ text: ch, changed });
}

function coalesce(runs: DiffRun[]): DiffRun[] {
  const out: DiffRun[] = [];
  for (const r of runs) {
    if (r.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.changed === r.changed) last.text += r.text;
    else out.push({ text: r.text, changed: r.changed });
  }
  return out;
}

// --- Word-level diff -> CriticMarkup edits (TA-DIFF, spec §9 / Phase A) ---
//
// `diffToEdits(baseline, current)` is the suggest-mode materialize engine. The
// user enters suggesting mode, edits ordinary plain text (no transaction
// interception — N2), and on commit we diff the snapshotted `baseline` against
// the `current` buffer and turn each changed region into a CriticMarkup mark.
//
// The edits apply to `current` (that is what sits in the buffer at commit), so
// each non-deletion edit anchors on the *new* text via `expected`. This inverts
// the operations.ts select-and-mark builders, whose buffer holds the *old* text
// — hence the edits are built here directly rather than reusing those builders.
//
// Word granularity (vs the char-level `diffChars` used for render) keeps the
// materialized marks clean: a within-word typo becomes one whole-token
// substitution, not a scatter of single-char inserts/deletes.

const WORD_LCS_CAP = 1_000_000; // token-product ceiling; over this we fall back

type DiffOp = { kind: "eq" | "del" | "ins"; text: string };

/** Lossless tokenizer: alternating whitespace and non-whitespace runs. */
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

/**
 * Token-level diff: common prefix/suffix stripped, the middle aligned by LCS
 * (forward DP + greedy backtrack, mirroring `lcsRuns`). Over the product cap the
 * middle degrades to a single delete-then-insert block. The op stream
 * reconstructs `baseline` (eq+del in order) and `current` (eq+ins in order).
 */
function diffTokens(a: string[], b: string[]): DiffOp[] {
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a[p] === b[p]) p++;
  let suf = 0;
  while (suf < minLen - p && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const ops: DiffOp[] = [];
  for (let i = 0; i < p; i++) ops.push({ kind: "eq", text: a[i]! }); // safe: i < p <= a.length

  const midA = a.slice(p, a.length - suf);
  const midB = b.slice(p, b.length - suf);

  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= WORD_LCS_CAP) {
    pushLcsOps(midA, midB, ops);
  } else {
    for (const t of midA) ops.push({ kind: "del", text: t });
    for (const t of midB) ops.push({ kind: "ins", text: t });
  }

  for (let i = a.length - suf; i < a.length; i++) ops.push({ kind: "eq", text: a[i]! }); // safe: i < a.length
  return ops;
}

function pushLcsOps(a: string[], b: string[], ops: DiffOp[]): void {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * w + j;
      if (a[i] === b[j]) {
        dp[idx] = dp[(i + 1) * w + (j + 1)]! + 1; // safe: index in bounds
      } else {
        const down = dp[(i + 1) * w + j]!; // safe: index in bounds
        const right = dp[i * w + (j + 1)]!; // safe: index in bounds
        dp[idx] = down >= right ? down : right;
      }
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i]! }); // safe: i < n
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) { // safe: indices in bounds
      ops.push({ kind: "del", text: a[i]! }); // safe: i < n
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j]! }); // safe: j < m
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! }); // safe: i < n
  while (j < m) ops.push({ kind: "ins", text: b[j++]! }); // safe: j < m
}

/**
 * A maximal changed region between `baseline` and `current`: the removed
 * baseline text (`old`), the inserted current text (`new`), and `from` — the
 * offset into `current` where the block begins. Blocks are ordered and
 * separated by ≥1 unchanged token. `old==="" ` → pure insert; `new===""` →
 * pure deletion (zero-width in `current`); both set → substitution.
 *
 * The single segmentation both `diffToEdits` (materialize) and `diffToOverlay`
 * (render) consume — so the overlay can never show a split the commit wouldn't
 * produce.
 */
interface DiffBlock {
  from: number;
  old: string;
  new: string;
}

function diffBlocks(baseline: string, current: string): DiffBlock[] {
  const ops = diffTokens(tokenize(baseline), tokenize(current));
  const blocks: DiffBlock[] = [];

  let ci = 0; // offset into `current`
  let oldBuf = "";
  let newBuf = "";
  let blockCi = 0;
  let inBlock = false;

  const flush = () => {
    if (!inBlock) return;
    blocks.push({ from: blockCi, old: oldBuf, new: newBuf });
    oldBuf = "";
    newBuf = "";
    inBlock = false;
  };

  for (const op of ops) {
    if (op.kind === "eq") {
      flush();
      ci += op.text.length;
    } else {
      if (!inBlock) {
        inBlock = true;
        blockCi = ci;
      }
      if (op.kind === "ins") {
        newBuf += op.text;
        ci += op.text.length;
      } else {
        oldBuf += op.text;
      }
    }
  }
  flush();

  return blocks;
}

/**
 * Diff `baseline` against `current` and emit the CriticMarkup edits that, when
 * applied to `current`, materialize the change as `{++}` / `{--}` /
 * `{~~old~>new~~}`. Edits are ordered and non-overlapping (change blocks are
 * separated by at least one unchanged token), each carrying `expected` (and
 * `before` for the point-insertion that represents a deletion) so they survive
 * `rebaseEdit`. Identical inputs yield `[]`.
 */
export function diffToEdits(baseline: string, current: string): SourceEdit[] {
  const edits: SourceEdit[] = [];
  for (const b of diffBlocks(baseline, current)) {
    if (b.old && b.new) {
      edits.push({
        from: b.from,
        to: b.from + b.new.length,
        insert: `{~~${b.old}~>${b.new}~~}`,
        expected: b.new,
      });
    } else if (b.new) {
      edits.push({
        from: b.from,
        to: b.from + b.new.length,
        insert: `{++${b.new}++}`,
        expected: b.new,
      });
    } else {
      // Deletion: re-insert the removed text wrapped, at the point in `current`
      // where it used to sit. Zero-width, so it anchors via `before`.
      edits.push({
        from: b.from,
        to: b.from,
        insert: `{--${b.old}--}`,
        expected: "",
        before: beforeAnchor(current, b.from),
      });
    }
  }
  return edits;
}

/** A render-shaped diff op against `current` offsets, for the live overlay. */
export interface OverlayOp {
  /** `ins` styles inserted text in-place; `del` is a zero-width phantom. */
  kind: "ins" | "del";
  /** Offset into `current`. For `del` this is a point (`to === from`). */
  from: number;
  to: number;
  /** `ins`: the inserted text (informational). `del`: the removed baseline text. */
  text: string;
}

/**
 * Diff `baseline` against `current` for the live overlay (cm-1.3): inserted
 * spans as in-place `ins` ops, deletions as zero-width `del` points carrying
 * the removed text (rendered as a phantom widget — never in the buffer). A
 * substitution emits both: a `del` point at the block start plus an `ins` span
 * over the new text. Ops are ordered by `from`; for a substitution the `del`
 * point shares the `ins` span's start. Identical inputs yield `[]`.
 *
 * Shares `diffBlocks` with `diffToEdits`, so the overlay and the commit always
 * agree on where the changes are.
 */
export function diffToOverlay(baseline: string, current: string): OverlayOp[] {
  const ops: OverlayOp[] = [];
  for (const b of diffBlocks(baseline, current)) {
    if (b.old) ops.push({ kind: "del", from: b.from, to: b.from, text: b.old });
    if (b.new) ops.push({ kind: "ins", from: b.from, to: b.from + b.new.length, text: b.new });
  }
  return ops;
}
