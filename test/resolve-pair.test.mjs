// cm-5: panel resolve-pairing + the rebase survive/drop contract for the
// authoring commands. Run with:
//   node test/resolve-pair.test.mjs
//
// Covers spec E9 / R-COM-6 (a span-anchored comment pairs with its preceding
// highlight and resolves both to clean text) and the acceptance line "cursor
// comment survives via before; drifted span replace drops" (E6/E7 / R-APPLY-3).

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
  adjacentHighlightForThread,
  resolveSpanComment,
  commentAtPoint,
  substituteSelection,
  beforeAnchor,
  rebaseEdit,
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

console.log("resolve-pair:");

// --- pairing detection (R-COM-6) ---
test("pairs a comment with its immediately-preceding highlight", () => {
  const src = "x {==word==}{>>note<<} y";
  const r = parse(src);
  const h = adjacentHighlightForThread(r, src, r.threads[0]);
  assert.ok(h, "highlight paired");
  assert.equal(h.kind, "highlight");
  assert.equal(h.text, "word");
});

test("inline whitespace between highlight and comment still pairs", () => {
  const src = "x {==word==} {>>note<<} y";
  const r = parse(src);
  const h = adjacentHighlightForThread(r, src, r.threads[0]);
  assert.ok(h, "paired across a single space");
  assert.equal(h.text, "word");
});

test("a bare agent comment does not pair", () => {
  const src = "x {>>Claude: bare note<<} y";
  const r = parse(src);
  assert.equal(adjacentHighlightForThread(r, src, r.threads[0]), null);
});

test("a highlight separated by prose does not pair", () => {
  const src = "{==word==} some prose {>>note<<}";
  const r = parse(src);
  assert.equal(adjacentHighlightForThread(r, src, r.threads[0]), null);
});

test("a highlight separated by a newline does not pair", () => {
  const src = "{==word==}\n{>>note<<}";
  const r = parse(src);
  assert.equal(adjacentHighlightForThread(r, src, r.threads[0]), null);
});

// --- resolve strips both to clean text (E9) ---
test("resolveSpanComment leaves the highlighted text as plain prose", () => {
  const src = "before {==word==}{>>my note<<} after";
  const r = parse(src);
  const h = adjacentHighlightForThread(r, src, r.threads[0]);
  const edits = resolveSpanComment(src, h, r.threads[0]);
  const out = applyEdits(src, edits);
  assert.equal(out, "before word after");
  assert.equal(parse(out).nodes.length, 0, "no markup remains");
});

test("resolve strips a multi-message thread + its highlight", () => {
  const src = "a {==w==}{>>root<<}{>>Claude: reply<<} b";
  const r = parse(src);
  assert.equal(r.threads[0].replyIndexes.length, 1);
  const h = adjacentHighlightForThread(r, src, r.threads[0]);
  const out = applyEdits(src, resolveSpanComment(src, h, r.threads[0]));
  assert.equal(out, "a w b");
});

// --- rebase contract: cursor comment survives, span replace drops ---
test("cursor comment survives a drift via its before anchor", () => {
  const doc1 = "alpha beta gamma";
  const at = "alpha beta ".length; // 11
  const edit = commentAtPoint(at, "note", beforeAnchor(doc1, at));
  const doc2 = "PREFIX " + doc1; // everything shifted right by 7
  const rebased = rebaseEdit(doc2, edit);
  assert.ok(rebased, "relocated, not dropped");
  assert.equal(rebased.from, doc2.indexOf("gamma"));
  assert.equal(rebased.to, rebased.from);
});

test("drifted span-anchored replace drops (expected no longer matches)", () => {
  const doc1 = "the cat sat";
  const from = doc1.indexOf("cat"), to = from + 3;
  const edit = substituteSelection(from, to, "cat", "dog");
  const doc2 = "the dog sat"; // the span already changed out from under us
  assert.equal(rebaseEdit(doc2, edit), null);
});
