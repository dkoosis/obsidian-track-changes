import { browser, expect } from "@wdio/globals";
import {
  seed,
  openInLivePreview,
  openPanel,
  clickPanelAction,
  flushNote,
  readNote,
  runCommand,
} from "./helpers.js";

// T5 (otc-e5a): integration-only e2e — the four scenarios that CANNOT be faked
// in a Node unit test because they need a real CodeMirror 6 instance, the live
// EditorView.dispatch apply-path, and/or Obsidian's reading-mode HTML renderer.
//
// Each `describe` is one self-contained scenario with its own seeded note, so a
// failure in one doesn't cascade. None of these run in CI without a display;
// they compile here and execute under the wdio-obsidian harness (`make e2e`).
//
// Where an exact selector or post-render DOM shape is inferred from source
// rather than observed live, the assertion is marked `// TODO(otc-e5a): verify`
// so the first real run can confirm or tighten it.

// ---------------------------------------------------------------------------
// Scenario 1 — Drift mid-review: edit the doc, THEN click a panel action.
//
// The card is built from a parse taken at panel-mount. Before clicking accept
// we splice extra prose into the live CM6 doc via a real dispatch, shifting the
// addition node's offsets. The accept edit carries `expected`/`before` anchors;
// `rebaseEdits` must re-locate it in the ±200-char window (operations.ts) and
// apply against the *current* doc, not the stale offsets — otherwise the file
// is corrupted. We assert the file ends up with the addition accepted AND the
// drifted prose intact.
// ---------------------------------------------------------------------------
describe("track-changes: drift mid-review rebases under live CM6 dispatch", function () {
  const NOTE = "DriftMidReview.md";
  // The addition `{++ fast ++}` sits after "The quick" — offset of `{` is 9.
  const SEEDED = "The quick{++ brown ++}fox.\n";
  const OFFSET = 9;
  // Prose we inject at the very start of the doc *after* the panel parses, so
  // every node offset shifts right by INSERT.length. The anchor relocation in
  // rebaseEdit is the only thing that keeps the accept correct.
  const INSERT = "PREFIX-DRIFT ";

  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
    // Panel has now parsed at the seeded offsets. Confirm the card exists
    // before we drift the doc out from under it.
    await browser.$(`.tc-panel [data-tc-card-offset="${OFFSET}"]`).waitForExist();
  });

  it("rebases the stale accept edit onto the drifted doc", async function () {
    // Drift: insert prose at offset 0 through a real CM6 dispatch, so the live
    // doc no longer matches the panel's parse-time offsets.
    await browser.executeObsidian(
      async ({ app, obsidian }, args: { path: string; insert: string }) => {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view as any;
          if (view?.file?.path === args.path && view.editor) {
            // cm is the live EditorView behind Obsidian's Editor wrapper.
            const cm = (view.editor as any).cm;
            if (cm && typeof cm.dispatch === "function") {
              cm.dispatch({ changes: { from: 0, insert: args.insert } });
              return;
            }
            // Fallback if the private handle moves: setValue still drifts the doc.
            const cur = await app.vault.read(view.file as any);
            void obsidian;
            view.editor.setValue(args.insert + cur);
            return;
          }
        }
        throw new Error(`no live editor for ${args.path}`);
      },
      { path: NOTE, insert: INSERT },
    );

    // The card still carries the parse-time offset; clicking accept produces an
    // edit anchored by expected/before, which rebaseEdits must relocate by
    // INSERT.length before applying.
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-accept`);

    // Expected end state: drifted prefix survives, addition accepted (markup
    // stripped, " brown " body kept).
    const EXPECTED = `${INSERT}The quick brown fox.\n`;
    let actual = "";
    await browser
      .waitUntil(
        async () => {
          await flushNote(NOTE);
          actual = await readNote(NOTE);
          return actual === EXPECTED;
        },
        { timeout: 10000 },
      )
      .catch(() => undefined);
    expect(actual).toBe(EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Suggest-mode round-trip: type → exit → materialize.
//
// Enter suggesting mode (snapshots the baseline), edit the plain text in the
// live CM6 doc, then toggle suggesting mode OFF. Exit is the commit trigger
// (main.ts toggleSuggestMode → commitSuggestions → diffToEdits(baseline,
// current)), which materializes the baseline→current diff as CriticMarkup.
// We assert the resulting file carries the suggestion as `{++…++}` markup.
// This needs the real per-file SuggestModeState + the live doc to diff against;
// a Node test of diffToEdits can't exercise the toggle wiring or the editor
// read.
// ---------------------------------------------------------------------------
describe("track-changes: suggest-mode round-trip materializes typed text", function () {
  const NOTE = "SuggestMode.md";
  const SEEDED = "Hello world.\n";

  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
  });

  it("typing in suggest mode then exiting yields CriticMarkup", async function () {
    // Enter suggesting mode for the active file (snapshots SEEDED as baseline).
    await runCommand("toggle-suggesting-mode");

    // Type an insertion into the live CM6 doc: turn "Hello world." into
    // "Hello brave world." by inserting "brave " before "world". `Hello ` is 6
    // chars, so the insertion point is offset 6.
    await browser.executeObsidian(
      async ({ app }, args: { path: string; at: number; insert: string }) => {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view as any;
          if (view?.file?.path === args.path && view.editor) {
            const cm = (view.editor as any).cm;
            if (cm && typeof cm.dispatch === "function") {
              cm.dispatch({ changes: { from: args.at, insert: args.insert } });
              return;
            }
          }
        }
        throw new Error(`no live editor for ${args.path}`);
      },
      { path: NOTE, at: 6, insert: "brave " },
    );

    // Exit suggesting mode — this materializes the diff as CriticMarkup.
    await runCommand("toggle-suggesting-mode");

    // diffToEdits should wrap the inserted "brave " as an addition. The exact
    // whitespace boundary (`{++brave ++}` vs `{++brave++} `) is decided by
    // diff.ts segmentation; assert on the un-ambiguous invariant — the file is
    // valid CriticMarkup whose accepted form is the typed text — rather than a
    // brittle exact string.
    let actual = "";
    await browser
      .waitUntil(
        async () => {
          await flushNote(NOTE);
          actual = await readNote(NOTE);
          return actual.includes("{++") && actual.includes("++}");
        },
        { timeout: 10000 },
      )
      .catch(() => undefined);

    // The materialized markup must contain an addition carrying "brave".
    expect(actual).toContain("{++");
    expect(actual).toContain("++}");
    // TODO(otc-e5a): verify exact whitespace grouping; diff.ts may emit
    // `{++brave ++}` or `{++brave++} `. Both accept to "Hello brave world.\n".
    expect(actual.replace(/\{\+\+|\+\+\}/g, "")).toBe("Hello brave world.\n");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Reading-mode render of a comment fragmented across DOM nodes.
//
// The col-6 DOM-fragmentation case: a `{>>…<<}` comment whose body contains
// markdown (**bold**, a [link]) so Obsidian's renderer splits the markup's
// open/body/close across <strong>/<a>/text nodes. The reading post-processor's
// source-aware path (reading.ts → locateLiteral walking text nodes) must still
// find the `{>>` and `<<}` tokens across the fragmentation and strip the whole
// comment, leaving the surrounding prose clean (and, with showComments on, a
// `.tc-rm-comment` icon). A per-text-node regex could never span these nodes —
// this is the un-fakeable assertion.
// ---------------------------------------------------------------------------
describe("track-changes: reading-mode renders a DOM-fragmented comment", function () {
  const NOTE = "ReadingFrag.md";
  // The comment body holds markdown that Obsidian renders to <strong> and <a>,
  // fragmenting the `{>>…<<}` span across multiple DOM text/element nodes.
  const SEEDED = "Before. {>>see **bold** and [a link](http://x)<<} After.\n";

  before(async function () {
    await seed(NOTE, SEEDED);
    // Reading mode (preview), not Live Preview — exercises the post-processor.
    await browser.executeObsidian(async ({ app, obsidian }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
      const leaf = app.workspace.getLeaf();
      await leaf.openFile(file, { active: true });
      await leaf.setViewState({
        type: "markdown",
        state: { mode: "preview" },
        active: true,
      });
    }, NOTE);
  });

  it("strips the fragmented comment markup and leaves prose clean", async function () {
    // The rendered preview must not leak any raw comment delimiters.
    let previewText = "";
    await browser
      .waitUntil(
        async () => {
          previewText = await browser.executeObsidian((_obs, p: string) => {
            const w: any = (window as any);
            void w;
            const doc = document;
            const containers = Array.from(
              doc.querySelectorAll(".markdown-reading-view .markdown-preview-view"),
            );
            // Fall back to the broadest preview container if the scoped one
            // isn't matched in this Obsidian version.
            const root =
              (containers[0] as HTMLElement | undefined) ??
              (doc.querySelector(".markdown-preview-view") as HTMLElement | null);
            void p;
            return root ? root.textContent ?? "" : "";
          }, NOTE);
          // Wait until the preview has rendered the surrounding prose.
          return previewText.includes("Before.") && previewText.includes("After.");
        },
        { timeout: 10000 },
      )
      .catch(() => undefined);

    // Surrounding prose survives.
    expect(previewText).toContain("Before.");
    expect(previewText).toContain("After.");
    // No raw comment delimiters leaked — the fragmented `{>>…<<}` was found and
    // stripped across the <strong>/<a> nodes.
    expect(previewText).not.toContain("{>>");
    expect(previewText).not.toContain("<<}");
    // TODO(otc-e5a): verify — with default showComments, the stripped comment
    // leaves a `.tc-rm-comment` icon. Assert its presence so a regression that
    // silently drops the comment (rather than iconizing it) is caught.
    await expect(browser.$(".markdown-preview-view .tc-rm-comment")).toExist();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Selection touching a node boundary must NOT hide adjacent prose.
//
// In Live Preview the decoration extension replaces a comment thread with a
// chip widget (decorations.ts: Decoration.replace). But when the selection
// *touches* the node's [from,to) — rangeTouchesSelection: range.from <= to &&
// range.to >= from — the chip is skipped (`continue`), revealing the raw
// markup so the user can edit it. The risk: an off-by-one in that boundary
// test could over-extend the replace decoration and swallow adjacent prose.
// We place the cursor exactly at the node boundary and assert the adjacent
// prose is still present in the editor's visible text.
// ---------------------------------------------------------------------------
describe("track-changes: boundary selection keeps adjacent prose visible", function () {
  const NOTE = "BoundaryChip.md";
  // A comment thread between two runs of prose. "Keep-left " is 10 chars, so
  // the comment `{>>note<<}` starts at offset 10 and the trailing " keep-right"
  // prose follows it.
  const SEEDED = "Keep-left {>>note<<} keep-right.\n";
  const COMMENT_FROM = 10;
  const COMMENT_TO = 19; // index just past `<<}` of `{>>note<<}` (10..19 inclusive of close)

  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
  });

  it("cursor at the node boundary does not eat surrounding prose", async function () {
    // Put the selection cursor exactly at the comment's `to` boundary. By
    // rangeTouchesSelection (range.from <= to && range.to >= from), a collapsed
    // cursor at `COMMENT_TO` touches the node, so the chip is skipped and the
    // raw markup is shown — but the surrounding prose must be untouched either
    // way.
    await browser.executeObsidian(
      async ({ app }, args: { path: string; pos: number }) => {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view as any;
          if (view?.file?.path === args.path && view.editor) {
            const cm = (view.editor as any).cm;
            if (cm && typeof cm.dispatch === "function") {
              cm.dispatch({ selection: { anchor: args.pos, head: args.pos } });
              return;
            }
          }
        }
        throw new Error(`no live editor for ${args.path}`);
      },
      { path: NOTE, pos: COMMENT_TO },
    );

    // Read the document text the CM6 editor actually holds. The decoration is
    // a *display* replacement — it must never alter doc content — so both the
    // left and right prose runs are always present in the doc.
    const docText = await browser.executeObsidian((_obs, p: string) => {
      const w: any = window;
      void w;
      // Pull doc text straight from the live CM6 state.
      const app = (window as any).app;
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as any;
        if (view?.file?.path === p && view.editor) {
          const cm = (view.editor as any).cm;
          if (cm?.state?.doc) return cm.state.doc.toString();
        }
      }
      return "";
    }, NOTE);

    // The doc content is intact: the boundary handling is a display concern and
    // never removes prose.
    expect(docText).toBe(SEEDED);

    // The visible editor text (DOM) must still show both prose runs — a chip
    // that over-extended past the boundary would swallow " keep-right".
    const visible = await browser.executeObsidian((_obs, p: string) => {
      const app = (window as any).app;
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as any;
        if (view?.file?.path === p) {
          const cmRoot =
            view.contentEl?.querySelector(".cm-editor") ?? view.contentEl;
          return (cmRoot as HTMLElement | null)?.textContent ?? "";
        }
      }
      return "";
    }, NOTE);

    // Adjacent prose on both sides survives the chip-replace decision.
    expect(visible).toContain("Keep-left");
    expect(visible).toContain("keep-right");
    void COMMENT_FROM;
    // TODO(otc-e5a): verify — with the cursor on the boundary the chip is
    // suppressed, so raw `{>>note<<}` should be visible. If decorations.ts is
    // later changed to keep the chip on a boundary-touch, swap this for an
    // assertion that `.tc-chip` exists; either way prose must survive.
  });
});
