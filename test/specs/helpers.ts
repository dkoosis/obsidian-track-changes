import { browser } from "@wdio/globals";

// Shared e2e helpers. The round-trip path these drive is the whole point of the
// suite: seed real CriticMarkup into a note, open it in a *live* CM6 editor (so
// the EditorView.dispatch apply-path runs, not the Vault.process fallback),
// mount the review panel, click a real action button, then read the resulting
// file bytes back and assert on them.
//
// executeObsidian serializes its callback to the Obsidian process, so anything
// the callback needs is passed as an argument — closures don't survive.

export const PLUGIN_ID = "track-changes";

/** Write `content` to `path` (create or overwrite). Returns the path. */
export async function seed(path: string, content: string): Promise<string> {
  await browser.executeObsidian(async ({ app, obsidian }, args: { path: string; content: string }) => {
    const existing = app.vault.getAbstractFileByPath(args.path);
    if (existing instanceof obsidian.TFile) {
      await app.vault.modify(existing, args.content);
    } else {
      await app.vault.create(args.path, args.content);
    }
  }, { path, content });
  return path;
}

/**
 * Open a note and force Live Preview (mode:source, source:false) so the CM6
 * decoration extension and the live `EditorView.dispatch` apply-path run.
 */
export async function openInLivePreview(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, p: string) => {
    const file = app.vault.getAbstractFileByPath(p);
    if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
    const leaf = app.workspace.getLeaf();
    await leaf.openFile(file, { active: true });
    await leaf.setViewState({
      type: "markdown",
      state: { mode: "source", source: false },
      active: true,
    });
  }, path);
}

/**
 * Mount the review panel via its command (it only mounts on activateView — it
 * is NOT rendered by default), then wait for the panel container to exist.
 */
export async function openPanel(): Promise<void> {
  await runCommand("open-review-panel");
  await browser.$(".tc-panel").waitForExist();
}

/**
 * Execute a plugin command by its bare id (the `${PLUGIN_ID}:` is prepended).
 *
 * Obsidian's `executeCommandById` fires the command's callback and returns
 * synchronously — it does NOT await an async command callback (e.g. the async
 * `activateView` behind open-review-panel). So this resolves once the command
 * has been *dispatched*, not once its async work settles; callers must wait on
 * a post-condition of their own (openPanel waits for `.tc-panel`). We do return
 * and check the boolean so an unregistered id (a future command rename) throws
 * loudly here instead of silently no-op'ing and hanging a downstream waitFor.
 */
export async function runCommand(id: string): Promise<void> {
  const fullId = `${PLUGIN_ID}:${id}`;
  const fired = await browser.executeObsidian(
    ({ app }, cmd: string) => (app as any).commands.executeCommandById(cmd),
    fullId,
  );
  if (!fired) throw new Error(`command not found or did not run: ${fullId}`);
}

/**
 * Click a panel element matched by `selector`, waiting for it to render first.
 * Cards are addressable via their `data-tc-card-offset`, so a stable selector
 * is e.g. `[data-tc-card-offset="12"] .tc-btn-accept`.
 */
export async function clickPanelAction(selector: string): Promise<void> {
  const el = browser.$(`.tc-panel ${selector}`);
  await el.waitForClickable();
  await el.click();
}

/**
 * Force the live markdown editor for `path` to write its in-memory CM6 doc to
 * disk *now*, bypassing Obsidian's ~2s autosave debounce. The accept apply-path
 * dispatches into the CM6 doc (src/main.ts), not to disk, so a disk-read
 * assertion otherwise races the debounce — flaky on slow CI runners. Best
 * effort: if no open editor matches the path, autosave still backstops.
 */
export async function flushNote(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, p: string) => {
    for (const leaf of app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as any;
      if (view?.file?.path === p && typeof view.save === "function") {
        await view.save();
        return;
      }
    }
  }, path);
}

/** Read a note's current bytes back from the vault. */
export async function readNote(path: string): Promise<string> {
  return browser.executeObsidian(async ({ app, obsidian }, p: string) => {
    const file = app.vault.getAbstractFileByPath(p);
    if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
    return app.vault.read(file);
  }, path);
}
