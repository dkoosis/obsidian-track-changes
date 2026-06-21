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

  if (midOld.length > 0 && midNew.length > 0 && midOld.length * midNew.length <= LCS_CAP) {
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
        dp[idx] = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * w + j];
        const right = dp[i * w + (j + 1)];
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
      pushChar(aRuns, a[i], false);
      pushChar(bRuns, b[j], false);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      pushChar(aRuns, a[i], true);
      i++;
    } else {
      pushChar(bRuns, b[j], true);
      j++;
    }
  }
  while (i < n) pushChar(aRuns, a[i++], true);
  while (j < m) pushChar(bRuns, b[j++], true);
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
  for (let i = 0; i < p; i++) ops.push({ kind: "eq", text: a[i] });

  const midA = a.slice(p, a.length - suf);
  const midB = b.slice(p, b.length - suf);

  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= WORD_LCS_CAP) {
    pushLcsOps(midA, midB, ops);
  } else {
    for (const t of midA) ops.push({ kind: "del", text: t });
    for (const t of midB) ops.push({ kind: "ins", text: t });
  }

  for (let i = a.length - suf; i < a.length; i++) ops.push({ kind: "eq", text: a[i] });
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
        dp[idx] = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * w + j];
        const right = dp[i * w + (j + 1)];
        dp[idx] = down >= right ? down : right;
      }
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "ins", text: b[j++] });
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
  const ops = diffTokens(tokenize(baseline), tokenize(current));
  const edits: SourceEdit[] = [];

  let ci = 0; // offset into `current`
  let oldBuf = "";
  let newBuf = "";
  let blockCi = 0;
  let inBlock = false;

  const flush = () => {
    if (!inBlock) return;
    if (oldBuf && newBuf) {
      edits.push({
        from: blockCi,
        to: blockCi + newBuf.length,
        insert: `{~~${oldBuf}~>${newBuf}~~}`,
        expected: newBuf,
      });
    } else if (newBuf) {
      edits.push({
        from: blockCi,
        to: blockCi + newBuf.length,
        insert: `{++${newBuf}++}`,
        expected: newBuf,
      });
    } else {
      // Deletion: re-insert the removed text wrapped, at the point in `current`
      // where it used to sit. Zero-width, so it anchors via `before`.
      edits.push({
        from: blockCi,
        to: blockCi,
        insert: `{--${oldBuf}--}`,
        expected: "",
        before: beforeAnchor(current, blockCi),
      });
    }
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

  return edits;
}
