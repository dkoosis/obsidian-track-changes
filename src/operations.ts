// Write operations on the markdown source. All operations return one or more
// SourceEdits; the caller writes them back via the Obsidian Vault API.
//
// Every SourceEdit can carry an optional `expected` (the substring currently
// at [from, to)) and an optional `before` (the substring immediately preceding
// `from`). These act as anchors so an edit produced from a stale parse can be
// safely rebased against the current document content via `rebaseEdit` before
// being dispatched. Without this, a doc that drifted between parse-time and
// apply-time (because the user typed, or the AI re-edited the file) would be
// corrupted by stale offsets.

import type { CriticNode, Thread, ParseResult, CommentNode, HighlightNode } from "./parser";

export interface SourceEdit {
  from: number;
  to: number;
  insert: string;
  /** Substring expected at [from, to) in the doc. Used by rebaseEdit to verify and re-locate. */
  expected?: string;
  /** Substring expected immediately preceding `from`. Used to anchor insertions (where expected==""). */
  before?: string;
}

const COMMENT_CLOSE = "<<}";
const HIGHLIGHT_CLOSE = "==}";
const DELETION_CLOSE = "--}";

export function validateReplyText(text: string): string | null {
  if (text.includes(COMMENT_CLOSE)) {
    return "Replies cannot contain the CriticMarkup comment closing marker <<}.";
  }
  return null;
}

/**
 * Reject a selection that can't be safely wrapped as a highlight (E11): the
 * span-anchored comment builder emits `{==selected==}`, so a literal `==}`
 * inside the selection closes the highlight early — the parser then slices a
 * truncated node and leaks the tail as stray text. The highlight-side analogue
 * of `validateSubstitution` (~~/~>) and `validateReplyText` (<<}). A trailing
 * single `=` is safe: the lazy parser keeps it in the node body, so only the
 * literal closer is rejected. Returns an error message or null.
 */
export function validateHighlightContent(selected: string): string | null {
  if (selected.includes(HIGHLIGHT_CLOSE)) {
    return "Selection cannot contain the CriticMarkup highlight closing marker ==}.";
  }
  return null;
}

/**
 * Reject a selection carrying the deletion closer `--}` — the delete-side
 * analogue of `validateHighlightContent` (==}) and `validateReplyText` (<<}).
 * `deleteSelection` emits `{--selected--}`; an embedded `--}` would close the
 * node early and leave the rest of the selection as raw text outside the mark.
 */
export function validateDeletionContent(selected: string): string | null {
  if (selected.includes(DELETION_CLOSE)) {
    return "Selection cannot contain the CriticMarkup deletion closing marker --}.";
  }
  return null;
}

// --- Authoring builders (UI-initiated marks; spec §5) ---
// These wrap a live selection in CriticMarkup. The author prefix (`Name:`) is
// applied by the caller, not here — builders stay settings-unaware. cm-4 adds
// the comment/substitute builders alongside this one.

/** Wrap a selection as a deletion: `[from,to)` -> `{--selected--}`. */
export function deleteSelection(from: number, to: number, selected: string): SourceEdit {
  return { from, to, insert: `{--${selected}--}`, expected: selected };
}

/**
 * True if `[s,e)` intersects any parsed node's *full* range (delimiters and
 * body). Caller passes `parse(src).nodes`. Used to refuse a destructive author
 * action that would land inside or across an existing mark — wrapping there
 * would nest markup the parser's dedup then silently drops. Half-open overlap:
 * `s < n.to && n.from < e`.
 */
export function selectionOverlapsNodes(nodes: CriticNode[], s: number, e: number): boolean {
  return nodes.some((n) => s < n.to && n.from < e);
}

/**
 * Wrap a selection as a highlight + comment pair (a span-anchored comment):
 * `[from,to)` -> `{==selected==}{<metaPrefix>>>body<<}`. The `body` is the
 * author's text; `metaPrefix` is the optional `author="…"` attribute prefix the
 * caller builds (same grammar as replies — see `appendReply`), stamped on the
 * comment mark so the human's authorship is attributed. `expected` anchors the
 * selected span.
 */
export function commentOnSelection(
  from: number,
  to: number,
  selected: string,
  body: string,
  metaPrefix = "",
): SourceEdit {
  return { from, to, insert: `{==${selected}==}{${metaPrefix}>>${body}<<}`, expected: selected };
}

/**
 * Insert a bare comment at a point (collapsed selection, or the snap-out target
 * when a selection intersects a mark — E2/E10). Zero-width insertion, so it
 * carries no `expected`; the `before` anchor (Decision B — see `beforeAnchor`)
 * lets `rebaseEdit` relocate it if the doc drifts. `metaPrefix` is the optional
 * `author="…"` attribute prefix stamped on the mark.
 */
export function commentAtPoint(
  at: number,
  body: string,
  before: string,
  metaPrefix = "",
): SourceEdit {
  return { from: at, to: at, insert: `{${metaPrefix}>>${body}<<}`, expected: "", before };
}

/**
 * Wrap a selection as a substitution: `[from,to)` -> `{~~oldText~>newText~~}`.
 * Validate both sides with `validateSubstitution` first. `expected` anchors the
 * old span.
 */
export function substituteSelection(
  from: number,
  to: number,
  oldText: string,
  newText: string,
): SourceEdit {
  return { from, to, insert: `{~~${oldText}~>${newText}~~}`, expected: oldText };
}

/**
 * Reject a substitution whose old or new side carries substitution markup
 * (`~~`, `~>`, or the `~~}` closer) — it would break the delimiter grammar and
 * the parser would mis-slice the node. Returns an error message or null.
 */
export function validateSubstitution(oldText: string, newText: string): string | null {
  const bad = /~~|~>/;
  if (bad.test(oldText)) return "Selection contains substitution markup.";
  if (bad.test(newText)) return "Replacement contains substitution markup.";
  return null;
}

/**
 * Decision B: the `before` anchor for a bare-comment insertion. Line-start to
 * cursor, extended back to <=40 preceding chars when the line prefix is shorter
 * than 8 — so a short prefix (e.g. start of a list item) still anchors uniquely
 * within the +-200 rebase window.
 */
const BEFORE_MIN = 8;
const BEFORE_MAX = 40;

export function beforeAnchor(source: string, at: number): string {
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const linePrefix = source.slice(lineStart, at);
  if (linePrefix.length >= BEFORE_MIN) return linePrefix;
  return source.slice(Math.max(0, at - BEFORE_MAX), at);
}

/**
 * Snap-out target for a comment whose selection intersects existing marks
 * (E2/E10): the `to` offset just past the last intersecting node, where a bare
 * comment can sit without nesting inside markup the parser's dedup would drop.
 * Returns null when nothing intersects (caller uses `commentOnSelection`).
 */
export function snapOutOffset(nodes: CriticNode[], s: number, e: number): number | null {
  const hit = nodes.filter((n) => s < n.to && n.from < e);
  if (hit.length === 0) return null;
  return Math.max(...hit.map((n) => n.to));
}

/** Apply a list of edits to a source string. Edits must be non-overlapping. */
export function applyEdits(source: string, edits: SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from);
  // Descending order: sorted[i+1].from < sorted[i].from. Non-overlap requires
  // sorted[i+1].to <= sorted[i].from. Catch contract violations early — silent
  // overlap would corrupt the source via the slice/splice loop below.
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1]!.to > sorted[i]!.from) { // safe: i < sorted.length - 1
      throw new Error("applyEdits: overlapping edits");
    }
  }
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/**
 * Rebase an edit against the current document. If the edit's `from..to` still
 * matches `expected` (and `before` if provided), the edit is returned as-is.
 * If the original range no longer matches, only edits with an explicit `before`
 * anchor may relocate. Plain `expected` edits intentionally fail closed: a raw
 * CriticMarkup block like `{++x++}` is too weak to safely distinguish from an
 * identical nearby block.
 *
 * If `expected` and `before` are both undefined, we trust the offsets and
 * return as-is (backwards-compatible default).
 */
const REBASE_WINDOW = 200;

export function rebaseEdit(currentDoc: string, edit: SourceEdit): SourceEdit | null {
  if (edit.expected === undefined && edit.before === undefined) return edit;

  const expected = edit.expected ?? "";
  const before = edit.before ?? "";
  const currentExpected = currentDoc.slice(edit.from, edit.to);
  const currentBefore =
    before === "" ? "" : currentDoc.slice(Math.max(0, edit.from - before.length), edit.from);
  if (currentExpected === expected && currentBefore === before) return edit;

  if (edit.before === undefined) return null;

  const needle = before + expected;
  if (needle === "") return null;

  const searchStart = Math.max(0, edit.from - before.length - REBASE_WINDOW);
  const searchEnd = Math.min(
    currentDoc.length,
    edit.from + REBASE_WINDOW + needle.length,
  );
  const window = currentDoc.slice(searchStart, searchEnd);

  const matches: number[] = [];
  let idx = window.indexOf(needle);
  while (idx !== -1) {
    matches.push(searchStart + idx);
    idx = window.indexOf(needle, idx + 1);
  }

  // Ambiguous (zero or multiple) — refuse. Relocation must be uniquely anchored
  // by context, otherwise a stale action could edit an identical nearby block.
  if (matches.length !== 1) return null;

  const newFrom = matches[0]! + before.length; // safe: matches.length === 1
  return {
    ...edit,
    from: newFrom,
    to: newFrom + expected.length,
  };
}

/** Rebase a list of edits; returns the survivors and the count that couldn't be rebased. */
export function rebaseEdits(
  currentDoc: string,
  edits: SourceEdit[],
): { edits: SourceEdit[]; dropped: number } {
  const out: SourceEdit[] = [];
  let dropped = 0;
  for (const e of edits) {
    const r = rebaseEdit(currentDoc, e);
    if (r) out.push(r);
    else dropped++;
  }
  return { edits: out, dropped };
}

/** Accept an addition: keep the inner text, strip the markup. */
export function acceptAddition(node: CriticNode): SourceEdit {
  if (node.kind !== "addition") throw new Error("acceptAddition: wrong node kind");
  return { from: node.from, to: node.to, insert: node.text, expected: node.raw };
}

/** Reject an addition: remove the whole block. */
export function rejectAddition(node: CriticNode): SourceEdit {
  if (node.kind !== "addition") throw new Error("rejectAddition: wrong node kind");
  return { from: node.from, to: node.to, insert: "", expected: node.raw };
}

/** Accept a deletion: remove the whole block. */
export function acceptDeletion(node: CriticNode): SourceEdit {
  if (node.kind !== "deletion") throw new Error("acceptDeletion: wrong node kind");
  return { from: node.from, to: node.to, insert: "", expected: node.raw };
}

/** Reject a deletion: keep the inner text, strip the markup. */
export function rejectDeletion(node: CriticNode): SourceEdit {
  if (node.kind !== "deletion") throw new Error("rejectDeletion: wrong node kind");
  return { from: node.from, to: node.to, insert: node.text, expected: node.raw };
}

/** Accept a substitution: replace with the new text. */
export function acceptSubstitution(node: CriticNode): SourceEdit {
  if (node.kind !== "substitution") throw new Error("acceptSubstitution: wrong node kind");
  return { from: node.from, to: node.to, insert: node.newText, expected: node.raw };
}

/** Reject a substitution: replace with the old text. */
export function rejectSubstitution(node: CriticNode): SourceEdit {
  if (node.kind !== "substitution") throw new Error("rejectSubstitution: wrong node kind");
  return { from: node.from, to: node.to, insert: node.oldText, expected: node.raw };
}

/** Remove a highlight: strip the {==…==} wrapper, keep the inner text. */
export function removeHighlight(node: CriticNode): SourceEdit {
  if (node.kind !== "highlight") throw new Error("removeHighlight: wrong node kind");
  return { from: node.from, to: node.to, insert: node.text, expected: node.raw };
}

/** Delete a single comment node (one message within a thread). */
export function deleteCommentNode(node: CriticNode): SourceEdit {
  if (node.kind !== "comment") throw new Error("deleteCommentNode: wrong node kind");
  return { from: node.from, to: node.to, insert: "", expected: node.raw };
}

/**
 * Delete an entire thread (root + all replies). Range from thread.from to
 * thread.to covers the contiguous markup; surrounding text is untouched.
 */
export function deleteThread(source: string, thread: Thread): SourceEdit {
  return {
    from: thread.from,
    to: thread.to,
    insert: "",
    expected: source.slice(thread.from, thread.to),
  };
}

/**
 * The highlight immediately preceding a thread, if the two are adjacent (only
 * inline whitespace, no newline, between them). This is the shape a human
 * authoring action produces — `{==sel==}{>>body<<}` — so the panel pairs them
 * into one card (anchor = highlight text) and resolves both together. Agent
 * comments are bare `{>>…<<}` with no preceding highlight, so they never pair.
 * Returns null when the node before the thread root isn't an adjacent highlight.
 */
export function adjacentHighlightForThread(
  parsed: ParseResult,
  source: string,
  thread: Thread,
): HighlightNode | null {
  const prev = parsed.nodes[thread.rootIndex - 1];
  if (!prev || prev.kind !== "highlight") return null;
  // Mirror the parser's threading adjacency: inline whitespace only.
  if (!/^[ \t]*$/.test(source.slice(prev.to, thread.from))) return null;
  return prev;
}

/**
 * Resolve a span-anchored comment (R-COM-6 / E9): strip the highlight wrapper
 * (keep its inner text) and delete the whole thread, in one batch. Net result
 * is the formerly highlighted text as plain prose with the comment gone. The
 * two edits don't overlap — the highlight ends at or before the thread start.
 */
export function resolveSpanComment(
  source: string,
  highlight: HighlightNode,
  thread: Thread,
): SourceEdit[] {
  return [removeHighlight(highlight), deleteThread(source, thread)];
}

/**
 * Strip characters that could break the quoted metadata prefix or its
 * rendering: control / line-separator chars (newline, NUL, U+2028/9) and the
 * three structural chars the quoted-value class forbids \u2014 `"`, `{`, `}`.
 * Everything else (spaces, `;`, `=`, `-`, \u2026) is safe inside the quotes, so a
 * name like `J. O'Reilly-Smith, Jr.` survives intact.
 */
export function sanitizeAuthorName(name: string): string {
  return name
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x1f\x7f\u2028\u2029]/g, "")
    .replace(/["{}]/g, "");
}

export type ReplyDateStyle = "date" | "datetime";

// Real-clock stamp. "date" → YYYY-MM-DD (local); "datetime" → second-precision
// UTC ISO. The bare "date" form has no zone marker, so it reflects the user's
// local calendar day — UTC would read a day ahead in negative-offset zones near
// midnight. "datetime" keeps Z because it carries an explicit zone.
function formatReplyDate(style: ReplyDateStyle): string {
  const d = new Date();
  if (style === "datetime") {
    return `${d.toISOString().slice(0, 19)}Z`;
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Insert a human reply adjacent to the last message of a thread, stamped with
 * the new metadata prefix. The reply ALWAYS carries `date=<today>`; if
 * `localAuthorName` is non-empty it also carries `author=<sanitized name>`
 * (otherwise no `author=`, so the parser resolves it to "You"). `localAuthorName`
 * is passed in from the panel/host — operations never reads settings directly.
 */
export function appendReply(
  _source: string,
  thread: Thread,
  parsed: ParseResult,
  text: string,
  localAuthorName = "",
  dateStyle: ReplyDateStyle = "date",
): SourceEdit {
  const validationError = validateReplyText(text);
  if (validationError) throw new Error(validationError);

  const lastIdx =
    thread.replyIndexes.length > 0
      ? thread.replyIndexes[thread.replyIndexes.length - 1]! // safe: length > 0
      : thread.rootIndex;
  const last = parsed.nodes[lastIdx] as CommentNode;

  // Pairs are space-separated and the closing quote abuts the `>>` sigil — no
  // trailing `;`. A reply with no author= (or the user's own name) is "You".
  const date = formatReplyDate(dateStyle);
  const author = sanitizeAuthorName((localAuthorName ?? "").trim());
  const prefix = author ? `author="${author}" date="${date}"` : `date="${date}"`;
  const reply = `{${prefix}>>${text}<<}`;
  // Insert with no whitespace so the threading parser groups it.
  return {
    from: last.to,
    to: last.to,
    insert: reply,
    expected: "",
    before: last.raw,
  };
}

/**
 * Finalize for publish: resolve every remaining suggestion and strip every
 * comment thread. Returns the edits in document order (they don't overlap
 * because nodes don't overlap).
 *
 * Defaults match the spec's conservative recommendation: accept additions,
 * reject deletions (keep original prose), accept substitutions to their old
 * value (keep original). User can override via settings.
 */
export interface FinalizeOptions {
  additions: "accept" | "reject";
  deletions: "accept" | "reject";
  substitutions: "accept" | "reject";
  /** Also strip highlights (default true; they are non-semantic visual marks). */
  stripHighlights: boolean;
}

export const DEFAULT_FINALIZE: FinalizeOptions = {
  additions: "accept",
  deletions: "reject",
  substitutions: "reject",
  stripHighlights: true,
};

export function finalizeEdits(
  parsed: ParseResult,
  opts: FinalizeOptions = DEFAULT_FINALIZE,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  for (const n of parsed.nodes) {
    switch (n.kind) {
      case "comment":
        edits.push({ from: n.from, to: n.to, insert: "", expected: n.raw });
        break;
      case "addition":
        edits.push(opts.additions === "accept" ? acceptAddition(n) : rejectAddition(n));
        break;
      case "deletion":
        edits.push(opts.deletions === "accept" ? acceptDeletion(n) : rejectDeletion(n));
        break;
      case "substitution":
        edits.push(
          opts.substitutions === "accept" ? acceptSubstitution(n) : rejectSubstitution(n),
        );
        break;
      case "highlight":
        if (opts.stripHighlights) edits.push(removeHighlight(n));
        break;
    }
  }
  return edits;
}

/**
 * Summary describing what finalize will do — for the confirmation dialog.
 */
export interface FinalizeSummary {
  comments: number;
  additionsAccepted: number;
  additionsRejected: number;
  deletionsAccepted: number;
  deletionsRejected: number;
  substitutionsAccepted: number;
  substitutionsRejected: number;
  highlights: number;
}

export function summarizeFinalize(
  parsed: ParseResult,
  opts: FinalizeOptions = DEFAULT_FINALIZE,
): FinalizeSummary {
  const s: FinalizeSummary = {
    comments: 0,
    additionsAccepted: 0,
    additionsRejected: 0,
    deletionsAccepted: 0,
    deletionsRejected: 0,
    substitutionsAccepted: 0,
    substitutionsRejected: 0,
    highlights: 0,
  };
  for (const n of parsed.nodes) {
    if (n.kind === "comment") s.comments++;
    else if (n.kind === "addition") {
      if (opts.additions === "accept") s.additionsAccepted++;
      else s.additionsRejected++;
    } else if (n.kind === "deletion") {
      if (opts.deletions === "accept") s.deletionsAccepted++;
      else s.deletionsRejected++;
    } else if (n.kind === "substitution") {
      if (opts.substitutions === "accept") s.substitutionsAccepted++;
      else s.substitutionsRejected++;
    } else if (n.kind === "highlight") {
      s.highlights++;
    }
  }
  return s;
}
