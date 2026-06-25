// buildCommentEdit branch selection (cm-1.5). The wrap path
// ({==sel==}{>>body<<}) is reserved for a clean, non-whitespace selection that
// doesn't intersect a mark. A real-range selection that OVERLAPS an existing
// mark is refused (returns null) — inline CriticMarkup can't nest, and the
// caller surfaces "Selections can't overlap comments or suggestions." (otc-785,
// supersedes the old snap-out). A collapsed cursor or whitespace-only selection
// still degrades to a bare {>>body<<} point comment (Decision C):
//   - collapsed cursor has no range to highlight;
//   - whitespace-only selection would wrap to a contentless {== ==} highlight
//     that the editor renders as a runaway highlight.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
async function loadTs(rel) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  return await import(
    "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
  );
}

const { buildCommentEdit, applyEdits } = await loadTs("../src/operations.ts");
const { parse } = await loadTs("../src/parser.ts");

function edit(src, from, to, body = "c") {
  return buildCommentEdit(parse(src).nodes, src, from, to, body, "");
}
let pass = 0;
function ok(name) {
  console.log("  ok  - " + name);
  pass++;
}

// 1. clean word selection -> span-anchored wrap
{
  const src = "the quick brown fox";
  const from = src.indexOf("brown");
  const e = edit(src, from, from + "brown".length);
  assert.equal(applyEdits(src, [e]), "the quick {==brown==}{>>c<<} fox");
  ok("clean selection -> {==sel==}{>>body<<}");
}

// 2. collapsed cursor -> bare point comment, no empty {====}
{
  const src = "the quick brown fox";
  const at = src.indexOf("brown");
  const e = edit(src, at, at);
  const out = applyEdits(src, [e]);
  assert.equal(out, "the quick {>>c<<}brown fox");
  assert.ok(!out.includes("{=="), "no highlight braces for a collapsed cursor");
  ok("collapsed cursor -> bare {>>body<<}, no {====}");
}

// 3. whitespace-only selection -> bare point comment, never {== ==}
{
  const src = "alpha beta";
  const from = src.indexOf(" ");
  const e = edit(src, from, from + 1);
  const out = applyEdits(src, [e]);
  assert.ok(!out.includes("{== "), "must not wrap whitespace in a highlight: " + out);
  assert.ok(out.includes("{>>c<<}"), "still places a comment: " + out);
  ok("whitespace-only selection -> bare comment, no degenerate {== ==}");
}

// 4. selection straddling existing marks -> refused (null), no edit emitted
{
  const src = "x {~~old~>new~~} y {~~a~>b~~} z";
  // select from inside the new-side of mark 1 through inside the new-side of mark 2
  const from = src.indexOf("new");
  const to = src.indexOf("b") + 1;
  const e = edit(src, from, to);
  assert.equal(e, null, "straddling selection must be refused, not degraded");
  ok("straddling selection -> null (refused)");
}

// 5. selection fully CONTAINING a mark (with clean text around it) -> refused.
// This is the case the old snap-out got wrong: it dropped the comment past the
// mark, where the parser threaded it as a surprise reply.
{
  const src = "before {==word==}{>>note<<} after";
  const from = 0;
  const to = src.length;
  const e = edit(src, from, to);
  assert.equal(e, null, "selection containing a mark must be refused");
  ok("containing selection -> null (refused)");
}

console.log(`\ncomment-edit: ${pass} passed`);
