// Parser invariants the authoring layer (cm-1 epic) relies on. Pinned BEFORE
// any edit builder exists, so later phases can't silently break them.
// Run with: node test/parser.invariants.test.mjs
//
// Coverage map (spec §6 T0-PARSER):
//   (a) node.raw is verbatim across all 5 kinds
//   (b) parse().nodes are non-overlapping post-dedup
//   (c) delete/substitution bodies with newline AND blank line each stay ONE node
//   (d) E10: a delimiter sitting in a code region yields no node (one assertion;
//       fence mechanics are owned by parser.edge.test.mjs — not re-tested here)
//   (e) {==sel==}{>>body<<} is TWO adjacent nodes; remove + delete + apply -> clean text

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function load(rel) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  const code = out.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { parse } = await load("../src/parser.ts");
const { removeHighlight, deleteCommentNode, applyEdits } = await load("../src/operations.ts");

// authorName for a comment, or null when no recognised <Name>: prefix. Helper
// so the author-edge cases below read against the *real* parse() contract, not
// the AUTHOR_RE regex in isolation (that lives in authors.test.mjs).
function authorOf(src) {
  const r = parse(src);
  const c = r.nodes.find((n) => n.kind === "comment");
  return c ? c.authorName : undefined;
}

function test(name, fn) {
  try {
    fn();
    console.log("  ok  -", name);
  } catch (err) {
    console.error("  FAIL -", name);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("parser.invariants:");

// (a) node.raw verbatim across all 5 kinds.
test("(a) node.raw is the verbatim source slice for all 5 kinds", () => {
  const src =
    "{++add++} {--del--} {~~old~>new~~} {>>Bob: comment<<} {==highlight==}";
  const r = parse(src);
  assert.equal(r.nodes.length, 5);
  const byKind = Object.fromEntries(r.nodes.map((n) => [n.kind, n]));
  assert.equal(byKind.addition.raw, "{++add++}");
  assert.equal(byKind.deletion.raw, "{--del--}");
  assert.equal(byKind.substitution.raw, "{~~old~>new~~}");
  assert.equal(byKind.comment.raw, "{>>Bob: comment<<}");
  assert.equal(byKind.highlight.raw, "{==highlight==}");
  // raw must always equal the slice it claims to span — the anchor contract.
  for (const n of r.nodes) {
    assert.equal(n.raw, src.slice(n.from, n.to), `${n.kind} raw != slice`);
  }
});

// (b) accepted nodes are non-overlapping post-dedup. A substitution's interior
// (`{++ins++}`) re-matches as a smaller addition; dedup must drop the contained
// node so the returned list never overlaps.
test("(b) parse().nodes are sorted and non-overlapping post-dedup", () => {
  const src = "before {~~{++ins++}~>out~~} after {==hi==} {>>note<<}";
  const r = parse(src);
  let lastEnd = -1;
  for (const n of r.nodes) {
    assert.ok(n.from >= lastEnd, `node at ${n.from} overlaps prev end ${lastEnd}`);
    assert.ok(n.to > n.from, "node has non-positive span");
    lastEnd = n.to;
  }
  // The interior {++ins++} must NOT survive as its own node.
  assert.ok(
    !r.nodes.some((n) => n.kind === "addition" && n.raw === "{++ins++}"),
    "interior addition leaked past dedup"
  );
});

// (c) Multiline bodies stay one node — regexes are non-greedy over [\s\S], so a
// newline or a blank line inside the body must not split it.
test("(c) deletion body with newline parses as ONE node", () => {
  const r = parse("{--line1\nline2--}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "line1\nline2");
});

test("(c) deletion body with blank line parses as ONE node", () => {
  const r = parse("{--line1\n\nline2--}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "line1\n\nline2");
});

test("(c) substitution body with newline parses as ONE node", () => {
  const r = parse("{~~old\nold2~>new\nnew2~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old\nold2");
  assert.equal(r.nodes[0].newText, "new\nnew2");
});

test("(c) substitution body with blank line parses as ONE node", () => {
  const r = parse("{~~old\n\nold2~>new\n\nnew2~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old\n\nold2");
  assert.equal(r.nodes[0].newText, "new\n\nnew2");
});

// (d) E10, grounding assertion only: a delimiter whose endpoint sits inside a
// code region is inert — no node emitted. Fence mechanics live in
// parser.edge.test.mjs (parser.ts:179 rangeEndpointInCode); don't duplicate.
test("(d) E10: delimiter inside inline code yields no node", () => {
  const r = parse("text `{==hi==}` more");
  assert.equal(r.nodes.length, 0);
});

// (e) Adjacent highlight + comment are two distinct nodes, and the documented
// "clear annotation" path (removeHighlight + deleteCommentNode + applyEdits)
// restores clean prose.
test("(e) {==sel==}{>>body<<} is two adjacent nodes restored to clean text", () => {
  const src = "{==sel==}{>>body<<}";
  const r = parse(src);
  assert.equal(r.nodes.length, 2);
  const [first, second] = r.nodes;
  assert.equal(first.kind, "highlight");
  assert.equal(second.kind, "comment");
  assert.equal(first.to, second.from); // genuinely adjacent

  const edits = [removeHighlight(first), deleteCommentNode(second)];
  const out = applyEdits(src, edits);
  assert.equal(out, "sel");
});

// (f) Thread adjacency seam (otc-859 axis-2). Grouping rule (parser.ts:297) is
// `/^[ \t]*$/` over the gap between two {>>…<<} markers — ONLY inline spaces or
// tabs make a reply. A newline, CRLF, blank line, or any prose splits them into
// separate threads. CRLF is the dangerous case: `\r` is not in `[ \t]`, so a
// CRLF gap must split. Pin it so a future "be lenient about whitespace" change
// can't silently merge comments across a line boundary (which would let a chip
// widget swallow the text between them).
test("(f) two comments with a space gap form ONE thread (root + reply)", () => {
  const r = parse("{>>root<<} {>>reply<<}");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
  assert.equal(r.nodeThread[0], 0);
  assert.equal(r.nodeThread[1], 0);
});

test("(f) two comments with a tab gap form ONE thread", () => {
  const r = parse("{>>root<<}\t{>>reply<<}");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("(f) LF between two comments SPLITS into two threads", () => {
  const r = parse("{>>a<<}\n{>>b<<}");
  assert.equal(r.threads.length, 2);
  assert.equal(r.threads[0].replyIndexes.length, 0);
  assert.equal(r.threads[1].replyIndexes.length, 0);
});

test("(f) CRLF between two comments SPLITS into two threads (\\r not whitespace-grouped)", () => {
  const r = parse("{>>a<<}\r\n{>>b<<}");
  assert.equal(r.threads.length, 2, "CRLF gap must not group comments into one thread");
  assert.equal(r.threads[0].replyIndexes.length, 0);
  assert.equal(r.threads[1].replyIndexes.length, 0);
});

test("(f) a lone CR between two comments SPLITS into two threads", () => {
  const r = parse("{>>a<<}\r{>>b<<}");
  assert.equal(r.threads.length, 2, "bare CR gap must not group comments");
});

test("(f) blank line between two comments SPLITS into two threads", () => {
  const r = parse("{>>a<<}\n\n{>>b<<}");
  assert.equal(r.threads.length, 2);
});

test("(f) trailing-space-then-CRLF gap still SPLITS (mixed inline + line break)", () => {
  // A reply requires the WHOLE gap to be inline whitespace. " \r\n" contains a
  // line break, so it must not group even though it starts with a space.
  const r = parse("{>>a<<} \r\n{>>b<<}");
  assert.equal(r.threads.length, 2);
});

test("(f) prose between two comments SPLITS into two threads", () => {
  const r = parse("{>>a<<} and {>>b<<}");
  assert.equal(r.threads.length, 2);
});

// (g) Author-prefix detection through parse() -> CommentNode.authorName. The raw
// regex is unit-tested in authors.test.mjs; here we pin the *parser-visible*
// contract (otc-859 author edges): which prefixes surface a name vs fall back to
// null (rendered "You"). AUTHOR_RE = /^\s*([A-Za-z][\w.-]{0,29})\s*:\s*/.
test("(g) author prefix: lowercase name is captured verbatim (original casing)", () => {
  assert.equal(authorOf("{>>gpt: hi<<}"), "gpt");
});

test("(g) author prefix: trailing space before the colon still matches", () => {
  // `\s*:` is permissive about space before the colon for a single-token name.
  assert.equal(authorOf("{>>Claude : hi<<}"), "Claude");
});

test("(g) author prefix: no space after the colon still matches", () => {
  assert.equal(authorOf("{>>Claude:hi<<}"), "Claude");
});

test("(g) author prefix: name of exactly 30 chars is captured", () => {
  const name = "a".repeat(30);
  assert.equal(authorOf(`{>>${name}: hi<<}`), name);
});

test("(g) author prefix: name longer than 30 chars => null (renders 'You')", () => {
  const name = "a".repeat(31);
  assert.equal(authorOf(`{>>${name}: hi<<}`), null);
});

test("(g) author prefix: underscore-LEADING name => null (must be alpha-leading)", () => {
  assert.equal(authorOf("{>>_foo: hi<<}"), null);
});

test("(g) author prefix: underscore WITHIN an alpha-leading name is captured", () => {
  // `\w` includes `_`, so it's legal inside the token — only the lead must be alpha.
  assert.equal(authorOf("{>>foo_bar: hi<<}"), "foo_bar");
});

test("(g) author prefix: digit-leading name => null", () => {
  assert.equal(authorOf("{>>4chan: hi<<}"), null);
});

test("(g) author prefix: multi-word phrase before colon => null", () => {
  assert.equal(authorOf("{>>see line 4: bad<<}"), null);
});

test("(g) author prefix: empty body => authorName null", () => {
  assert.equal(authorOf("{>><<}"), null);
});

// (h) CriticMarkup at code-region boundaries (otc-859 code-boundary). A marker
// whose endpoints sit inside a code span/fence is inert (E10). These pin the
// BOUNDARY positions — markup hugging the very start/end of an inline span, and
// abutting a fence's opening/closing line — to guard the off-by-one seam where
// "just inside" vs "just outside" code is decided.
test("(h) markup flush against the inside edge of an inline span is inert", () => {
  // No space between the backtick and the marker on either side.
  const r = parse("text `{++x++}` more");
  assert.equal(r.nodes.length, 0, "marker wholly inside an inline span yields no node");
});

test("(h) markup immediately AFTER a closing backtick parses", () => {
  const src = "a `code`{++real++} b";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "real");
});

test("(h) markup immediately BEFORE an opening backtick parses", () => {
  const src = "a {++real++}`code` b";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("(h) markup on the line directly after a fence closer parses", () => {
  const src = "```\ncode\n```\n{++real++}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("(h) markup on the line directly before a fence opener parses", () => {
  const src = "{++real++}\n```\ncode\n```";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("(h) marker on the fence's opening line (after the info string) is inert", () => {
  // The opener line is part of the code region's boundary; a marker riding on it
  // must not parse, while real prose after the close still does.
  const src = "```js {++fake++}\ncode\n```\n{++real++}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});
