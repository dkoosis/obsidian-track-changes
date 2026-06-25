// Tests for diffToEdits (TA-DIFF / cm-1.1). Run with: node test/diff-to-edits.test.mjs
//
// The headline property is round-trip (R-SUG-5): materialize the diff into the
// `current` buffer, parse it, then accept-all -> current and reject-all ->
// baseline. That single property exercises the whole engine end to end, so most
// cases assert it rather than the exact edit shape.

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
  const code = out.outputFiles[0].text;
  return await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { diffToEdits } = await loadTs("../src/diff.ts");
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

const ACCEPT_ALL = {
  additions: "accept",
  deletions: "accept",
  substitutions: "accept",
  stripHighlights: false,
};
const REJECT_ALL = {
  additions: "reject",
  deletions: "reject",
  substitutions: "reject",
  stripHighlights: false,
};

function materialize(baseline, current) {
  const edits = diffToEdits(baseline, current);
  // Contract: edits apply cleanly to `current` (non-overlap asserted inside).
  return { edits, marked: applyEdits(current, edits) };
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

function assertExpectedAnchors(edits, current) {
  for (const e of edits) {
    assert.equal(
      current.slice(e.from, e.to),
      e.expected ?? "",
      `expected anchor mismatch for ${JSON.stringify(e)}`,
    );
    if (e.from === e.to) {
      assert.equal(typeof e.before, "string", `point edit must carry a before anchor: ${JSON.stringify(e)}`);
    }
  }
}

function roundTrip(baseline, current) {
  const { edits, marked } = materialize(baseline, current);
  assertNonOverlapping(edits);
  assertExpectedAnchors(edits, current);

  const parsed = parse(marked);
  const accepted = applyEdits(marked, finalizeEdits(parsed, ACCEPT_ALL));
  const rejected = applyEdits(marked, finalizeEdits(parsed, REJECT_ALL));

  assert.equal(accepted, current, `accept-all should recover current\n  marked: ${JSON.stringify(marked)}`);
  assert.equal(rejected, baseline, `reject-all should recover baseline\n  marked: ${JSON.stringify(marked)}`);
  return { edits, marked };
}

console.log("diffToEdits:");

test("identical inputs -> no edits", () => {
  const { edits } = materialize("hello world", "hello world");
  assert.deepEqual(edits, []);
});

test("pure insertion in the middle", () => {
  const { edits } = roundTrip("the cat sat", "the big cat sat");
  assert.ok(edits.length >= 1);
  assert.ok(edits.every((e) => e.insert.startsWith("{++") || e.insert.startsWith("{~~")));
});

test("pure deletion in the middle", () => {
  const { edits } = roundTrip("the big cat sat", "the cat sat");
  assert.ok(edits.some((e) => e.insert.startsWith("{--")));
});

test("word substitution", () => {
  const { marked } = roundTrip("the cat sat", "the dog sat");
  assert.ok(marked.includes("{~~cat~>dog~~}"), `marked was ${marked}`);
});

test("within-word typo coarsens to a whole-token substitution", () => {
  const { marked } = roundTrip("color", "colour");
  assert.ok(marked.includes("{~~color~>colour~~}"), `marked was ${marked}`);
});

test("multi-region change", () => {
  roundTrip("the cat sat on the mat", "the dog sat on the rug");
});

test("prefix-only change", () => {
  roundTrip("Xtail end", "Ytail end");
});

test("suffix-only change", () => {
  roundTrip("head middle X", "head middle Y");
});

test("insertion at the very start", () => {
  roundTrip("world", "hello world");
});

test("insertion at the very end", () => {
  roundTrip("hello", "hello world");
});

test("deletion at the start", () => {
  roundTrip("hello world", "world");
});

test("deletion at the end", () => {
  roundTrip("hello world", "hello");
});

test("baseline empty -> all insertion", () => {
  roundTrip("", "brand new text");
});

test("current empty -> delete everything", () => {
  roundTrip("delete all of this", "");
});

test("both empty", () => {
  const { edits } = materialize("", "");
  assert.deepEqual(edits, []);
});

test("newline / paragraph edit", () => {
  roundTrip("first line\nsecond line\nthird", "first line\nSECOND line edited\nthird");
});

test("adding a whole paragraph", () => {
  roundTrip("para one", "para one\n\npara two added");
});

test("removing a whole paragraph", () => {
  roundTrip("para one\n\npara two removed", "para one");
});

test("interleaved del/ins inside one block", () => {
  roundTrip("alpha beta gamma delta", "alpha ZETA delta");
});

test("CAP fallback: huge distinct middles are fast and round-trip", () => {
  const baseline = "head " + "a ".repeat(2000) + "tail";
  const current = "head " + "b ".repeat(2000) + "tail";
  const start = Date.now();
  roundTrip(baseline, current);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, "cap fallback should stay fast, took " + elapsed + "ms");
});

// --- Seeded fuzz: random edits to a base text, both round-trip directions ---

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const WORDS = ["the", "cat", "dog", "sat", "on", "a", "mat", "rug", "and", "ran", "fast", "slow", "big", "red"];

function randomText(rng, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(WORDS[Math.floor(rng() * WORDS.length)]);
    if (rng() < 0.15) out.push("\n");
    else out.push(" ");
  }
  return out.join("").trim();
}

function mutate(rng, text) {
  let tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const rounds = 1 + Math.floor(rng() * 5);
  for (let r = 0; r < rounds; r++) {
    if (tokens.length === 0) break;
    const i = Math.floor(rng() * tokens.length);
    const roll = rng();
    if (roll < 0.33) {
      tokens.splice(i, 1); // delete
    } else if (roll < 0.66) {
      tokens.splice(i, 0, WORDS[Math.floor(rng() * WORDS.length)], " "); // insert
    } else {
      tokens[i] = WORDS[Math.floor(rng() * WORDS.length)]; // substitute
    }
  }
  return tokens.join("");
}

test("fuzz: 400 random baseline/current pairs round-trip both directions", () => {
  const rng = makeRng(0x9e3779b9);
  for (let trial = 0; trial < 400; trial++) {
    const baseline = randomText(rng, 3 + Math.floor(rng() * 12));
    const current = mutate(rng, baseline);
    try {
      roundTrip(baseline, current);
    } catch (err) {
      console.error(`fuzz trial ${trial} failed:`);
      console.error(`  baseline: ${JSON.stringify(baseline)}`);
      console.error(`  current:  ${JSON.stringify(current)}`);
      throw err;
    }
  }
});

// --- author stamping (otc-deq) -------------------------------------------
// The commit call site passes a `metaPrefix` (built from localAuthorName) so a
// suggest-mode author tags every materialized edit. The prefix sits between `{`
// and the sigil, parses back as metaAuthor, and is stripped on accept/reject.

const PREFIX = 'author="dk"';

function roundTripStamped(baseline, current) {
  const edits = diffToEdits(baseline, current, PREFIX);
  assertNonOverlapping(edits);
  assertExpectedAnchors(edits, current);
  const marked = applyEdits(current, edits);

  // Every emitted mark carries the prefix immediately after the opening brace.
  for (const e of edits) {
    assert.ok(
      e.insert.startsWith(`{${PREFIX}`),
      `edit missing author prefix: ${JSON.stringify(e)}`,
    );
  }

  // The prefix resolves to metaAuthor on every parsed node.
  const parsed = parse(marked);
  assert.ok(parsed.nodes.length >= 1, `expected marks in ${JSON.stringify(marked)}`);
  for (const n of parsed.nodes) {
    assert.equal(n.metaAuthor, "dk", `node not attributed: ${JSON.stringify(n.raw)}`);
  }

  // Round-trip survives the prefix: accept-all -> current, reject-all -> baseline
  // (proves the prefix is stripped by finalize, never leaking into output).
  const accepted = applyEdits(marked, finalizeEdits(parsed, ACCEPT_ALL));
  const rejected = applyEdits(marked, finalizeEdits(parsed, REJECT_ALL));
  assert.equal(accepted, current, `accept-all should recover current\n  marked: ${JSON.stringify(marked)}`);
  assert.equal(rejected, baseline, `reject-all should recover baseline\n  marked: ${JSON.stringify(marked)}`);
  return { edits, marked };
}

test("stamp: insertion carries author= and round-trips", () => {
  const { marked } = roundTripStamped("the cat sat", "the big cat sat");
  assert.ok(marked.includes(`{${PREFIX}++`), `marked was ${marked}`);
});

test("stamp: deletion carries author= and round-trips", () => {
  const { marked } = roundTripStamped("the big cat sat", "the cat sat");
  assert.ok(marked.includes(`{${PREFIX}--`), `marked was ${marked}`);
});

test("stamp: substitution carries author= and round-trips", () => {
  const { marked } = roundTripStamped("the cat sat", "the dog sat");
  assert.ok(marked.includes(`{${PREFIX}~~cat~>dog~~}`), `marked was ${marked}`);
});

test("stamp: empty prefix (default) yields bare marks", () => {
  const edits = diffToEdits("the cat sat", "the dog sat", "");
  assert.ok(edits.every((e) => /^\{[+~-]/.test(e.insert)), "default must emit bare marks");
});

test("stamp: fuzz 200 pairs round-trip with the author prefix", () => {
  const rng = makeRng(0x1234abcd);
  for (let trial = 0; trial < 200; trial++) {
    const baseline = randomText(rng, 3 + Math.floor(rng() * 12));
    const current = mutate(rng, baseline);
    if (baseline === current) continue;
    try {
      roundTripStamped(baseline, current);
    } catch (err) {
      console.error(`stamp fuzz trial ${trial} failed:`);
      console.error(`  baseline: ${JSON.stringify(baseline)}`);
      console.error(`  current:  ${JSON.stringify(current)}`);
      throw err;
    }
  }
});

console.log("done.");
