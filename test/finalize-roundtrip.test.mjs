// Finalize round-trip property test (otc-fkl / T4).
// Run with: node test/finalize-roundtrip.test.mjs
//
// RECAST from a false oracle. The original "reading-mode === finalize" equality
// is false by construction (DEFAULT_FINALIZE strips highlights; reading.ts keeps
// the <mark>; reading.ts is DOM-only and not Node-runnable). Instead we mirror
// diff-to-edits.test.mjs and assert a genuine round-trip property over the
// fixture corpus:
//
//   1. applyEdits(src, finalizeEdits(parse(src), ACCEPT_ALL)) re-parses to ZERO
//      CriticMarkup nodes — finalize fully resolves every mark.
//   2. That string equals an INDEPENDENTLY computed all-accepted buffer (built
//      by hand-splicing parsed.nodes, NOT by calling finalizeEdits/applyEdits).
//   3. Idempotence: finalizing the resolved buffer is a no-op.
//   4. The same three properties hold for a REJECT_ALL finalize.
//
// The independent oracle walks parse()'s nodes (which already skip code blocks),
// so markup-inside-code in the corpus stays untouched on both sides — no global
// regex strip that would diverge from finalize on the Code Samples fixture.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
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
  const code = out.outputFiles[0].text;
  return await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { applyEdits, finalizeEdits } = await loadTs("../src/operations.ts");
const { parse } = await loadTs("../src/parser.ts");

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

// finalize options: accept everything (strip highlights) and reject everything.
const ACCEPT_ALL = {
  additions: "accept",
  deletions: "accept",
  substitutions: "accept",
  stripHighlights: true,
};
const REJECT_ALL = {
  additions: "reject",
  deletions: "reject",
  substitutions: "reject",
  stripHighlights: true,
};

/**
 * Independent oracle: compute the finalized string by hand-splicing the parsed
 * nodes, WITHOUT calling finalizeEdits or applyEdits. For each node, pick its
 * resolved replacement directly from the node's text fields per the documented
 * accept/reject semantics, then stitch the gaps between nodes verbatim. Because
 * it iterates parse()'s nodes, anything the parser left out (markup in code)
 * is copied through untouched.
 */
function expectedFinalized(src, opts) {
  const { nodes } = parse(src);
  // nodes are non-overlapping; splice them in document order.
  const sorted = [...nodes].sort((a, b) => a.from - b.from);
  let out = "";
  let cursor = 0;
  for (const n of sorted) {
    out += src.slice(cursor, n.from);
    switch (n.kind) {
      case "comment":
        out += ""; // comments always stripped
        break;
      case "addition":
        out += opts.additions === "accept" ? n.text : "";
        break;
      case "deletion":
        out += opts.deletions === "accept" ? "" : n.text;
        break;
      case "substitution":
        out += opts.substitutions === "accept" ? n.newText : n.oldText;
        break;
      case "highlight":
        out += opts.stripHighlights ? n.text : src.slice(n.from, n.to);
        break;
      default:
        throw new Error(`unknown node kind: ${n.kind}`);
    }
    cursor = n.to;
  }
  out += src.slice(cursor);
  return out;
}

function assertNonOverlapping(edits) {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].from >= sorted[i - 1].to,
      `edits overlap: ${JSON.stringify(sorted[i - 1])} vs ${JSON.stringify(sorted[i])}`,
    );
  }
}

function assertExpectedAnchors(edits, src) {
  for (const e of edits) {
    assert.equal(
      src.slice(e.from, e.to),
      e.expected ?? "",
      `expected anchor mismatch for ${JSON.stringify(e)}`,
    );
  }
}

/**
 * Core property: for the given finalize opts, finalize(src) must
 *  (a) produce non-overlapping, anchor-valid edits,
 *  (b) equal the independent oracle,
 *  (c) re-parse to ZERO nodes, and
 *  (d) be idempotent (finalizing again is a no-op).
 */
function assertFinalizeRoundTrip(src, opts, label) {
  const parsed = parse(src);
  const edits = finalizeEdits(parsed, opts);
  assertNonOverlapping(edits);
  assertExpectedAnchors(edits, src);

  const out = applyEdits(src, edits);

  // (b) equals the independently-computed buffer.
  assert.equal(
    out,
    expectedFinalized(src, opts),
    `${label}: finalize output diverges from independent oracle\n  src: ${JSON.stringify(src)}`,
  );

  // (c) zero remaining CriticMarkup nodes.
  const reparsed = parse(out);
  assert.equal(
    reparsed.nodes.length,
    0,
    `${label}: ${reparsed.nodes.length} node(s) survived finalize\n  out: ${JSON.stringify(out)}`,
  );

  // (d) idempotence: finalizing the resolved buffer changes nothing.
  const again = applyEdits(out, finalizeEdits(reparsed, opts));
  assert.equal(again, out, `${label}: finalize is not idempotent\n  out: ${JSON.stringify(out)}`);

  return out;
}

// --- Corpus: the on-disk fixture vault (real, dense markdown the e2e specs use). ---
const FIXTURE_FILES = [
  "vaults/fixtures/Fixtures.md",
  "vaults/fixtures/Code Samples.md",
  "vaults/fixtures/Meeting Notes.md",
];

const CORPUS = FIXTURE_FILES.map((rel) => ({
  name: rel,
  src: readFileSync(resolve(__dirname, rel), "utf8"),
}));

// A few inline cases too, so the property is exercised on tight, known shapes
// (every kind, threads, adjacent marks, empty doc, plain prose).
const INLINE = [
  ["empty document", ""],
  ["plain prose, no markup", "just some prose, nothing fancy."],
  ["one of each kind", "a {++ins++} b {--del--} c {~~old~>new~~} d {>>Claude: note<<} e {==hl==} f"],
  ["adjacent marks", "{++a1++}{++a2++}{--d1--}{~~o~>n~~}{==h==}{>>c<<}"],
  ["a thread", "text.{>>Sam: q?<<} {>>Alex: agreed.<<}"],
  ["markup only inside inline code stays put", "use `{++x++}` and `{--y--}` literally"],
];

console.log("finalize round-trip:");

for (const { name, src } of CORPUS) {
  test(`corpus ${name}: ACCEPT_ALL round-trips to zero nodes & oracle`, () => {
    assertFinalizeRoundTrip(src, ACCEPT_ALL, `accept:${name}`);
  });
  test(`corpus ${name}: REJECT_ALL round-trips to zero nodes & oracle`, () => {
    assertFinalizeRoundTrip(src, REJECT_ALL, `reject:${name}`);
  });
}

for (const [name, src] of INLINE) {
  test(`inline ${name}: ACCEPT_ALL round-trips`, () => {
    assertFinalizeRoundTrip(src, ACCEPT_ALL, `accept:${name}`);
  });
  test(`inline ${name}: REJECT_ALL round-trips`, () => {
    assertFinalizeRoundTrip(src, REJECT_ALL, `reject:${name}`);
  });
}

// Code-skip is a hard contract: the Code Samples fixture has markup ONLY inside
// code, so finalize must be a no-op on it (the independent oracle agrees because
// it walks parse()'s nodes, which already exclude code).
test("markup-in-code fixture: finalize is a complete no-op", () => {
  const src = CORPUS.find((c) => c.name.includes("Code Samples")).src;
  assert.equal(parse(src).nodes.length, 0, "fixture should have no parseable nodes (all in code)");
  for (const opts of [ACCEPT_ALL, REJECT_ALL]) {
    const out = applyEdits(src, finalizeEdits(parse(src), opts));
    assert.equal(out, src, "finalize must not touch markup inside code");
  }
});

// Code-skip must hold under CRLF too. A Windows checkout (autocrlf) surfaced an
// indented-code detector bug where a "blank" line read as "\r", so prevBlank
// went false and the indented block never opened — markup in indented code then
// leaked. Force CRLF here so the guard is deterministic on every OS, not only
// where git happens to check out CRLF.
test("markup-in-code fixture stays skipped under CRLF line endings", () => {
  const lf = CORPUS.find((c) => c.name.includes("Code Samples")).src.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(parse(crlf).nodes.length, 0, "CRLF doc: markup in code must still be skipped");
  for (const opts of [ACCEPT_ALL, REJECT_ALL]) {
    assert.equal(applyEdits(crlf, finalizeEdits(parse(crlf), opts)), crlf, "CRLF finalize must be a no-op");
  }
});

console.log("done.");
