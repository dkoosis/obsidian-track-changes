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

// T2 (otc-gxn): one happy-path e2e per axis-1 panel action, each routed through
// the T1 round-trip helper (seed -> live editor -> mount panel -> drive the real
// affordance -> read file bytes -> assert). Same un-fakeable path as
// roundtrip.e2e.ts: every action runs through the live CM6 dispatch / command
// callback, not a Node re-implementation of operations.ts.
//
// Cards are addressable by their `data-tc-card-offset` (= the node's `from`).
// Inline chips / sub-arrows are addressable by `data-tc-offset` in the editor.
//
// Each block seeds a fresh note (unique name) so the cases stay independent and
// order-free; settings that gate confirmation dialogs (confirmBeforeDelete) are
// forced off so the delete actions write without a modal.

/**
 * Poll the on-disk bytes for `path` until they equal `want`, forcing a flush
 * each round so a slow autosave debounce can't time us out. Mirrors the wait in
 * roundtrip.e2e.ts: swallow the timeout so the final assertion surfaces the real
 * bytes as a diff instead of an opaque "condition timed out".
 */
async function expectNoteBytes(path: string, want: string): Promise<void> {
  let actual = "";
  await browser
    .waitUntil(
      async () => {
        await flushNote(path);
        actual = await readNote(path);
        return actual === want;
      },
      { timeout: 10000 },
    )
    .catch(() => undefined);
  expect(actual).toBe(want);
}

/**
 * Turn off the delete-confirmation modal so delete-message / delete-thread write
 * straight through. Reads the live setting (host.confirmBeforeDelete), so
 * flipping it on the loaded plugin instance is enough — no reload needed.
 * Best-effort: if the setting key drifts, the modal would appear and the byte
 * assertion would surface it.
 */
async function disableDeleteConfirm(): Promise<void> {
  // TODO(otc-gxn): verify setting key — `confirmBeforeDelete` is read via the
  // PanelHost; the persisted settings key is assumed to match. If the modal
  // appears in a run, accept it explicitly or adjust this key.
  await browser.executeObsidian(({ app }, id: string) => {
    const plugin = (app as any).plugins?.plugins?.[id];
    if (plugin?.settings) {
      plugin.settings.confirmBeforeDelete = false;
    }
  }, "track-changes");
}

describe("track-changes: accept addition", function () {
  const NOTE = "PA-accept-addition.md";
  const SEEDED = "Keep: {++added ++}word.\n";
  const OFFSET = 6; // index of `{` in "Keep: "
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("strips markup, keeps inserted text", async function () {
    await expect(browser.$(`.tc-panel [data-tc-card-offset="${OFFSET}"]`)).toExist();
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-accept`);
    await expectNoteBytes(NOTE, "Keep: added word.\n");
  });
});

describe("track-changes: reject addition", function () {
  const NOTE = "PA-reject-addition.md";
  const SEEDED = "Keep: {++added ++}word.\n";
  const OFFSET = 6;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("removes the whole block", async function () {
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-reject`);
    await expectNoteBytes(NOTE, "Keep: word.\n");
  });
});

describe("track-changes: accept deletion", function () {
  const NOTE = "PA-accept-deletion.md";
  const SEEDED = "Keep: {--remove --}word.\n";
  const OFFSET = 6;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("removes the whole block", async function () {
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-accept`);
    await expectNoteBytes(NOTE, "Keep: word.\n");
  });
});

describe("track-changes: reject deletion", function () {
  const NOTE = "PA-reject-deletion.md";
  const SEEDED = "Keep: {--remove --}word.\n";
  const OFFSET = 6;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("keeps the inner text, strips markup", async function () {
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-reject`);
    await expectNoteBytes(NOTE, "Keep: remove word.\n");
  });
});

describe("track-changes: accept substitution", function () {
  const NOTE = "PA-accept-substitution.md";
  const SEEDED = "Say {~~hello~>goodbye~~} now.\n";
  const OFFSET = 4; // index of `{` after "Say "
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("replaces with the new text", async function () {
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-accept`);
    await expectNoteBytes(NOTE, "Say goodbye now.\n");
  });
});

describe("track-changes: reject substitution", function () {
  const NOTE = "PA-reject-substitution.md";
  const SEEDED = "Say {~~hello~>goodbye~~} now.\n";
  const OFFSET = 4;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("restores the old text", async function () {
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-reject`);
    await expectNoteBytes(NOTE, "Say hello now.\n");
  });
});

describe("track-changes: remove highlight", function () {
  const NOTE = "PA-remove-highlight.md";
  // A bare highlight (no adjacent comment) renders its own card with a
  // "Remove highlight" button (.tc-btn-reject inside .tc-card-highlight).
  const SEEDED = "Note {==important==} here.\n";
  const OFFSET = 5; // index of `{` after "Note "
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("strips the highlight wrapper, keeps the text", async function () {
    await clickPanelAction(
      `[data-tc-card-offset="${OFFSET}"].tc-card-highlight .tc-btn-reject`,
    );
    await expectNoteBytes(NOTE, "Note important here.\n");
  });
});

describe("track-changes: thread reply", function () {
  const NOTE = "PA-thread-reply.md";
  // A bare comment (no `Name:` prefix) is a single-message "You" thread; the
  // reply composer is the textarea + "Reply" primary button on the card.
  const SEEDED = "Body {>>first<<} text.\n";
  const OFFSET = 5; // index of `{` after "Body "
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("appends an adjacent reply comment", async function () {
    const ta = browser.$(`.tc-panel [data-tc-card-offset="${OFFSET}"] .tc-reply-input`);
    await ta.waitForExist();
    await ta.setValue("second");
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-primary`);
    // appendReply inserts `{>>second<<}` with no whitespace right after the root
    // so the parser threads them.
    await expectNoteBytes(NOTE, "Body {>>first<<}{>>second<<} text.\n");
  });
});

describe("track-changes: delete message", function () {
  const NOTE = "PA-delete-message.md";
  // Two-message thread; delete the first message via its per-message trash btn.
  const SEEDED = "Body {>>first<<}{>>second<<} text.\n";
  const OFFSET = 5;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
    await disableDeleteConfirm();
  });
  it("removes one comment node from the thread", async function () {
    // First message's delete is the first .tc-icon-btn[aria-label="Delete message"].
    const del = browser.$(
      `.tc-panel [data-tc-card-offset="${OFFSET}"] .tc-message [aria-label="Delete message"]`,
    );
    await del.waitForClickable();
    await del.click();
    await expectNoteBytes(NOTE, "Body {>>second<<} text.\n");
  });
});

describe("track-changes: delete thread", function () {
  const NOTE = "PA-delete-thread.md";
  const SEEDED = "Body {>>first<<}{>>second<<} text.\n";
  const OFFSET = 5;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
    await disableDeleteConfirm();
  });
  it("removes the entire thread markup", async function () {
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-danger`);
    await expectNoteBytes(NOTE, "Body  text.\n");
  });
});

describe("track-changes: resolve span comment", function () {
  const NOTE = "PA-resolve-span.md";
  // A highlight immediately followed (inline) by a comment is a span-anchored
  // comment: one paired card whose primary action is "Resolve" (.tc-btn-accept).
  // Resolve strips the highlight (keeps its text) and deletes the thread.
  const SEEDED = "See {==target==}{>>note<<} end.\n";
  const OFFSET = 4; // index of `{` after "See "; the highlight's `{`.
  // The paired card's data-tc-card-offset is thread.from (the comment's `{`),
  // right after the highlight {==target==} (4..16) closes — so the `{>>` is at 16.
  const THREAD_FROM = 16;
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("strips the highlight and deletes the comment", async function () {
    // The paired card carries .tc-card-paired and is keyed by the thread offset.
    // TODO(otc-gxn): verify THREAD_FROM (16) is the card offset — it is
    // thread.from, the comment's opening `{`, not the highlight's.
    await clickPanelAction(`[data-tc-card-offset="${THREAD_FROM}"] .tc-btn-accept`);
    await expectNoteBytes(NOTE, "See target end.\n");
  });
  void OFFSET;
});

describe("track-changes: composer submit on selection", function () {
  const NOTE = "PA-composer-selection.md";
  const SEEDED = "Alpha bravo charlie.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("wraps the selection as {==sel==}{>>body<<}", async function () {
    // Select "bravo" (offsets 6..11) in the live editor, then run the
    // comment-on-selection command, which opens the composer card.
    await browser.executeObsidian(({ app, obsidian }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
      const leaf = app.workspace
        .getLeavesOfType("markdown")
        .find((l: any) => l.view?.file?.path === p);
      const editor = (leaf?.view as any)?.editor;
      if (!editor) throw new Error("no editor for note");
      editor.setSelection(editor.offsetToPos(6), editor.offsetToPos(11));
    }, NOTE);
    await runCommand("comment-on-selection");
    const ta = browser.$(".tc-panel .tc-card-composer .tc-reply-input");
    await ta.waitForExist();
    await ta.setValue("look here");
    await clickPanelAction(".tc-card-composer .tc-btn-primary");
    // commentOnSelection builder: {==bravo==}{>>look here<<} — author prefix is
    // added by the host; with no prefix configured the body is bare.
    // TODO(otc-gxn): verify the host doesn't prepend a `You:`-style prefix in
    // the test vault's default settings.
    await expectNoteBytes(NOTE, "Alpha {==bravo==}{>>look here<<} charlie.\n");
  });
});

describe("track-changes: composer submit at cursor", function () {
  const NOTE = "PA-composer-cursor.md";
  const SEEDED = "Alpha bravo charlie.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("inserts a bare {>>body<<} at the collapsed cursor", async function () {
    // Collapsed cursor at offset 5 (end of "Alpha"): comment-on-selection with
    // from==to inserts a bare comment at that point.
    await browser.executeObsidian(({ app, obsidian }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
      const leaf = app.workspace
        .getLeavesOfType("markdown")
        .find((l: any) => l.view?.file?.path === p);
      const editor = (leaf?.view as any)?.editor;
      if (!editor) throw new Error("no editor for note");
      editor.setCursor(editor.offsetToPos(5));
    }, NOTE);
    await runCommand("comment-on-selection");
    const ta = browser.$(".tc-panel .tc-card-composer .tc-reply-input");
    await ta.waitForExist();
    await ta.setValue("aside");
    await clickPanelAction(".tc-card-composer .tc-btn-primary");
    // TODO(otc-gxn): verify bare-cursor insert lands exactly at offset 5 — the
    // host may snap the anchor; expected bytes assume a literal point insert.
    await expectNoteBytes(NOTE, "Alpha{>>aside<<} bravo charlie.\n");
  });
});

describe("track-changes: composer Cmd+Enter submits", function () {
  const NOTE = "PA-composer-cmd-enter.md";
  const SEEDED = "Alpha bravo charlie.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("submits the composer on Cmd/Ctrl+Enter", async function () {
    await browser.executeObsidian(({ app, obsidian }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
      const leaf = app.workspace
        .getLeavesOfType("markdown")
        .find((l: any) => l.view?.file?.path === p);
      const editor = (leaf?.view as any)?.editor;
      if (!editor) throw new Error("no editor for note");
      editor.setSelection(editor.offsetToPos(6), editor.offsetToPos(11));
    }, NOTE);
    await runCommand("comment-on-selection");
    const ta = browser.$(".tc-panel .tc-card-composer .tc-reply-input");
    await ta.waitForExist();
    await ta.click();
    await ta.setValue("kbd");
    // Cmd+Enter (mac) / Ctrl+Enter — the composer keydown handler submits.
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "Enter"]);
    await expectNoteBytes(NOTE, "Alpha {==bravo==}{>>kbd<<} charlie.\n");
  });
});

describe("track-changes: composer Esc cancels", function () {
  const NOTE = "PA-composer-esc.md";
  const SEEDED = "Alpha bravo charlie.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("Esc discards the draft and writes nothing", async function () {
    await browser.executeObsidian(({ app, obsidian }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
      const leaf = app.workspace
        .getLeavesOfType("markdown")
        .find((l: any) => l.view?.file?.path === p);
      const editor = (leaf?.view as any)?.editor;
      if (!editor) throw new Error("no editor for note");
      editor.setSelection(editor.offsetToPos(6), editor.offsetToPos(11));
    }, NOTE);
    await runCommand("comment-on-selection");
    const ta = browser.$(".tc-panel .tc-card-composer .tc-reply-input");
    await ta.waitForExist();
    await ta.click();
    await ta.setValue("discard me");
    await browser.keys(["Escape"]);
    // Composer gone, file unchanged.
    await expect(browser.$(".tc-panel .tc-card-composer")).not.toExist();
    await flushNote(NOTE);
    expect(await readNote(NOTE)).toBe(SEEDED);
  });
});

describe("track-changes: inline chip click opens panel", function () {
  const NOTE = "PA-inline-chip.md";
  const SEEDED = "Body {>>chip note<<} text.\n";
  const OFFSET = 5; // `{` after "Body "
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    // Do NOT pre-open the panel — the chip click is what should mount/focus it.
  });
  it("clicking the comment chip focuses its card in the panel", async function () {
    // Thread chips always open the panel on a bare mousedown (no modifier).
    const chip = browser.$(`.cm-editor .tc-chip[data-tc-offset="${OFFSET}"]`);
    await chip.waitForExist();
    await chip.click();
    // handleInlineClick opens the panel and focuses the matching card.
    await expect(
      browser.$(`.tc-panel [data-tc-card-offset="${OFFSET}"]`),
    ).toExist();
  });
});

describe("track-changes: inline sub-arrow click opens panel", function () {
  const NOTE = "PA-inline-sub-arrow.md";
  const SEEDED = "Say {~~hello~>goodbye~~} now.\n";
  const OFFSET = 4; // `{` after "Say "
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
  });
  it("clicking the substitution arrow focuses its card", async function () {
    // The sub-arrow widget always opens the panel on bare mousedown.
    // TODO(otc-gxn): verify the .tc-sub-arrow widget renders in Live Preview for
    // this seeded substitution (it's a replace-decoration widget, present only
    // when the range is not touched by the selection).
    const arrow = browser.$(`.cm-editor .tc-sub-arrow[data-tc-offset="${OFFSET}"]`);
    await arrow.waitForExist();
    await arrow.click();
    await expect(
      browser.$(`.tc-panel [data-tc-card-offset="${OFFSET}"]`),
    ).toExist();
  });
});

describe("track-changes: suggest-mode enter", function () {
  const NOTE = "PA-suggest-enter.md";
  const SEEDED = "Plain text only.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("toggling suggesting mode on reflects in the header toggle", async function () {
    await runCommand("toggle-suggesting-mode");
    // The header suggest toggle flips to is-active / aria-pressed="true".
    const toggle = browser.$(".tc-panel .tc-suggest-toggle");
    await toggle.waitForExist();
    await browser.waitUntil(
      async () => (await toggle.getAttribute("aria-pressed")) === "true",
      { timeout: 5000 },
    );
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    // Entering mode is a no-op on bytes — baseline snapshot, no write.
    await flushNote(NOTE);
    expect(await readNote(NOTE)).toBe(SEEDED);
  });
});

describe("track-changes: suggest-mode materialize on exit", function () {
  const NOTE = "PA-suggest-materialize.md";
  const SEEDED = "Plain text only.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("typing in suggesting mode then exiting materializes CriticMarkup", async function () {
    // Enter suggesting mode (snapshots baseline), type into the live editor,
    // then exit — exit diffs baseline->current and writes the diff as markup.
    await runCommand("toggle-suggesting-mode");
    await browser.executeObsidian(({ app, obsidian }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
      const leaf = app.workspace
        .getLeavesOfType("markdown")
        .find((l: any) => l.view?.file?.path === p);
      const editor = (leaf?.view as any)?.editor;
      if (!editor) throw new Error("no editor for note");
      // Insert "new " at offset 6 ("Plain " -> "Plain new text only.").
      editor.replaceRange("new ", editor.offsetToPos(6));
    }, NOTE);
    await runCommand("toggle-suggesting-mode");
    // commitSuggestions diffs baseline ("Plain text only.\n") vs current
    // ("Plain new text only.\n") and emits an addition for the inserted run.
    // TODO(otc-gxn): verify exact diff framing — the diff engine may anchor the
    // {++…++} differently (e.g. "{++new ++}" vs "{++ new++}"). Asserting the
    // most faithful framing; adjust to the diff engine's actual output if it
    // brackets the inserted token differently.
    await expectNoteBytes(NOTE, "Plain {++new ++}text only.\n");
  });
});

describe("track-changes: finalize for publish", function () {
  const NOTE = "PA-finalize.md";
  // One of each kind; finalize defaults: accept additions, reject deletions,
  // reject substitutions (keep old), strip highlights, strip comments.
  const SEEDED =
    "A {++ins ++}B {--del --}C {~~old~>new~~}D {==hi==}E {>>c<<}F.\n";
  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });
  it("resolves every mark per the default finalize policy", async function () {
    // finalize-for-publish may show a confirmation modal summarizing the work.
    await runCommand("finalize-for-publish");
    // TODO(otc-gxn): verify whether finalize prompts a confirm modal in the
    // test vault's default settings; if so, click its confirm button before the
    // byte assertion. The expected bytes below assume the default policy ran:
    //   addition accepted -> "ins ", deletion rejected -> "del ",
    //   substitution rejected -> "old", highlight stripped -> "hi",
    //   comment stripped -> "".
    const confirm = browser.$(".mod-warning");
    if (await confirm.isExisting()) {
      await confirm.click();
    }
    await expectNoteBytes(NOTE, "A ins B del C oldD hiE F.\n");
  });
});
