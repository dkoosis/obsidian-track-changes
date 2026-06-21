// cm-4: comment + substitute builders, validators, and the Decision-B `before`
// anchor / snap-out helpers. Run with:
//   node test/comment-substitute.test.mjs
//
// Covers spec edge cases E2 (snap-out comment recovers on round-trip),
// E4 (reject substitution markup), E5 (reject comment closer), E8 (extend the
// before anchor for a short line prefix), plus builder shapes and round-trips.

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
const {
  commentOnSelection,
  commentAtPoint,
  substituteSelection,
  validateSubstitution,
  validateReplyText,
  validateHighlightContent,
  beforeAnchor,
  snapOutOffset,
  applyEdits,
} = await load("../src/operations.ts");

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

console.log("comment-substitute:");

// --- builder shapes ---
test("commentOnSelection wraps selection as highlight + comment, anchors the span", () => {
  const edit = commentOnSelection(2, 6, "word", "Phil: nice");
  assert.deepEqual(edit, {
    from: 2,
    to: 6,
    insert: "{==word==}{>>Phil: nice<<}",
    expected: "word",
  });
});

test("commentAtPoint is a zero-width insertion anchored by before", () => {
  const edit = commentAtPoint(10, "a note", "line prefix");
  assert.deepEqual(edit, {
    from: 10,
    to: 10,
    insert: "{>>a note<<}",
    expected: "",
    before: "line prefix",
  });
});

test("substituteSelection wraps old~>new, anchors the old span", () => {
  const edit = substituteSelection(0, 3, "cat", "dog");
  assert.deepEqual(edit, {
    from: 0,
    to: 3,
    insert: "{~~cat~>dog~~}",
    expected: "cat",
  });
});

// --- round-trips ---
test("commentOnSelection round-trips to a highlight + comment pair", () => {
  const src = "x word y";
  const from = src.indexOf("word"), to = from + 4;
  const out = applyEdits(src, [commentOnSelection(from, to, src.slice(from, to), "hi")]);
  assert.equal(out, "x {==word==}{>>hi<<} y");
  const r = parse(out);
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].kind, "highlight");
  assert.equal(r.nodes[0].text, "word");
  assert.equal(r.nodes[1].kind, "comment");
  assert.equal(r.nodes[1].text, "hi");
});

test("substituteSelection round-trips to one substitution node", () => {
  const src = "the cat sat";
  const from = src.indexOf("cat"), to = from + 3;
  const out = applyEdits(src, [substituteSelection(from, to, "cat", "dog")]);
  assert.equal(out, "the {~~cat~>dog~~} sat");
  const r = parse(out);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "cat");
  assert.equal(r.nodes[0].newText, "dog");
});

// --- E2: a comment whose selection intersects a mark snaps out past it ---
test("E2: snapOutOffset returns the to of the intersecting node", () => {
  const src = "x {==word==} y"; // highlight spans [2,12)
  const r = parse(src);
  assert.equal(r.nodes[0].from, 2);
  assert.equal(r.nodes[0].to, 12);
  assert.equal(snapOutOffset(r.nodes, 5, 9), 12); // selection inside "word"
});

test("E2: snapped bare comment round-trips and recovers (not nested/dropped)", () => {
  const src = "x {==word==} y";
  const r = parse(src);
  const at = snapOutOffset(r.nodes, 5, 9);
  const out = applyEdits(src, [commentAtPoint(at, "note", beforeAnchor(src, at))]);
  assert.equal(out, "x {==word==}{>>note<<} y");
  const r2 = parse(out);
  assert.equal(r2.nodes.length, 2);
  const comment = r2.nodes.find((n) => n.kind === "comment");
  assert.ok(comment, "comment node recovered");
  assert.equal(comment.text, "note");
});

test("snapOutOffset is null when the selection clears every node", () => {
  const src = "x {==word==} clean";
  const r = parse(src);
  const s = src.indexOf("clean"), e = s + 5;
  assert.equal(snapOutOffset(r.nodes, s, e), null);
});

// --- E4: reject substitution markup on either side ---
test("E4: validateSubstitution rejects ~> or ~~ in the old text", () => {
  assert.ok(validateSubstitution("a~>b", "x"));
  assert.ok(validateSubstitution("a~~b", "x"));
});

test("E4: validateSubstitution rejects ~> or ~~ in the new text", () => {
  assert.ok(validateSubstitution("x", "a~>b"));
  assert.ok(validateSubstitution("x", "a~~b"));
});

test("E4: validateSubstitution passes clean text", () => {
  assert.equal(validateSubstitution("cat", "dog"), null);
});

// --- E5: reject a comment body carrying the closing marker ---
test("E5: validateReplyText rejects a body containing <<}", () => {
  assert.ok(validateReplyText("oops <<} here"));
});

test("E5: validateReplyText passes a clean body", () => {
  assert.equal(validateReplyText("a normal comment"), null);
});

// --- E13: reject a selection carrying the highlight closer (otc-zhr) ---
test("E13: validateHighlightContent rejects a selection containing ==}", () => {
  assert.ok(validateHighlightContent("foo ==} bar"));
});

test("E13: validateHighlightContent passes a clean selection", () => {
  assert.equal(validateHighlightContent("a normal selection"), null);
});

test("E13: a trailing single = is safe (kept in the node body, not rejected)", () => {
  // The lazy {==…==} parser absorbs the extra = rather than closing early, so
  // there's nothing to reject — confirm both the validator and a round-trip.
  assert.equal(validateHighlightContent("x ="), null);
  const out = applyEdits("a x = b", [commentOnSelection(2, 5, "x =", "note")]);
  assert.equal(out, "a {==x ===}{>>note<<} b");
  const r = parse(out);
  const hl = r.nodes.find((n) => n.kind === "highlight");
  assert.equal(hl.text, "x =", "the trailing = round-trips intact");
});

test("E13: without the guard, a ==} selection would truncate the highlight", () => {
  // Documents the corruption the guard prevents: the wrapper closes at the
  // selection's ==} and the tail leaks as stray text.
  const src = "p q==} r";
  const from = src.indexOf("q"), to = from + "q==}".length;
  const out = applyEdits(src, [commentOnSelection(from, to, src.slice(from, to), "note")]);
  const r = parse(out);
  const hl = r.nodes.find((n) => n.kind === "highlight");
  assert.notEqual(hl.text, "q==}", "highlight is truncated — why the guard rejects this");
});

// --- E8: extend the before anchor when the line prefix is short ---
test("E8: short line prefix extends across the newline (up to 40)", () => {
  const src = "preceding context line\n- x";
  const at = src.length; // line prefix "- x" is only 3 chars
  const before = beforeAnchor(src, at);
  assert.equal(before, "preceding context line\n- x");
  assert.ok(before.length > "- x".length, "extended past the bare line prefix");
});

test("E8: extension caps at 40 preceding chars", () => {
  const src = "X".repeat(50) + "\n- y";
  const at = src.length; // line prefix "- y" (3) < 8 -> extend
  const before = beforeAnchor(src, at);
  assert.equal(before.length, 40);
});

test("a line prefix of >= 8 chars is used as-is", () => {
  const src = "a longer prefix here|tail";
  const at = src.indexOf("|");
  assert.equal(beforeAnchor(src, at), "a longer prefix here");
});
