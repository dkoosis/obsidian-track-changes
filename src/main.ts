import {
  Plugin,
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
  Editor,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { criticDecorationsExtension } from "./editor/decorations";
import { REVIEW_VIEW_TYPE, ReviewPanelView, type PanelHost } from "./panel/view";
import {
  applyEdits,
  rebaseEdits,
  deleteSelection,
  selectionOverlapsNodes,
  commentOnSelection,
  commentAtPoint,
  substituteSelection,
  snapOutOffset,
  beforeAnchor,
  validateHighlightContent,
  validateDeletionContent,
  type SourceEdit,
} from "./operations";
import { parse, selectionInCode } from "./parser";
import { SuggestModeState } from "./suggest-mode";
import { makeReadingPostProcessor } from "./reading";
import { FinalizeModal } from "./finalize";
import { AuthorCaptureModal } from "./capture-modal";
import {
  DEFAULT_SETTINGS,
  TrackChangesCriticMarkupSettingsTab,
  type TrackChangesCriticMarkupSettings,
} from "./settings";

export default class TrackChangesCriticMarkupPlugin extends Plugin {
  settings!: TrackChangesCriticMarkupSettings;

  // Mutable so a settings toggle can swap the decoration extension and force a
  // rebuild via workspace.updateOptions() (the field is otherwise only rebuilt
  // on doc changes).
  private editorExtensions: Extension[] = [];

  // Per-file suggesting-mode state (cm-1.2). The diff overlay (cm-1.3) and
  // commit-materialize (cm-1.4) read its baseline; here it only drives the
  // toggle + the status-bar/ribbon mirror.
  private suggestMode = new SuggestModeState();
  private suggestStatusEl: HTMLElement | null = null;
  private suggestRibbonEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Right-panel view registration.
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => this.makeReviewView(leaf));

    // CodeMirror 6 inline decorations.
    this.editorExtensions.push(this.makeDecorationExtension());
    this.registerEditorExtension(this.editorExtensions);

    // Reading-mode post-processor.
    this.registerMarkdownPostProcessor(
      makeReadingPostProcessor(() => ({
        showComments: this.settings.readingShowComments,
      })),
    );

    // Commands.
    this.addCommand({
      id: "open-review-panel",
      name: "Open review panel",
      callback: () => this.openReviewPanel(),
    });
    this.addCommand({
      id: "mark-selection-deleted",
      name: "Mark selection deleted",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file) return false;
        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        if (from === to) return false; // empty selection
        const source = editor.getValue();
        // Refuse if the selection touches an existing mark — wrapping inside or
        // across a node would nest markup the parser's dedup silently drops.
        // Re-checked on BOTH the show (checking=true) and act runs.
        if (selectionOverlapsNodes(parse(source).nodes, from, to)) return false;
        // Refuse selections inside code — the parser skips code, so the wrapped
        // deletion would be dropped, leaving dead markup in the sample (otc-402).
        if (selectionInCode(source, from, to)) return false;
        if (checking) return true;
        const selected = source.slice(from, to);
        // Refuse a selection carrying the deletion closer --}; wrapping it would
        // close the node early and orphan the tail as raw text (delete-side
        // analogue of the ==} highlight guard).
        const err = validateDeletionContent(selected);
        if (err) {
          new Notice(err);
          return true;
        }
        void this.applyEditsToFile(file, [deleteSelection(from, to, selected)], {
          requireAll: true,
        });
        return true;
      },
    });
    this.addCommand({
      id: "comment-on-selection",
      name: "Comment on selection",
      // Comment never refuses (spec Decision C): a collapsed cursor inserts a
      // bare point-comment; a selection intersecting a mark snaps out past it.
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file) return false;
        if (checking) return true;
        const source = editor.getValue();
        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        const selected = source.slice(from, to);
        // Refuse anything landing in code — the parser skips code, so both the
        // span-anchored highlight+comment and a bare point-comment would be
        // dropped, leaving dead markup in the sample (otc-402). Comment normally
        // never refuses, but in-code has no valid degraded form, so Notice out.
        if (selectionInCode(source, from, to)) {
          new Notice("Cannot comment inside a code block.");
          return true;
        }
        // Only a clean selection takes the span-anchored {==…==} path; a
        // collapsed cursor or a mark-intersecting selection degrades to a bare
        // {>>…<<} that doesn't wrap the selection. So the highlight-content
        // guard (E11) applies only when we'd actually wrap (refuse + Notice).
        if (from !== to && !selectionOverlapsNodes(parse(source).nodes, from, to)) {
          const err = validateHighlightContent(selected);
          if (err) {
            new Notice(err);
            return true;
          }
        }
        new AuthorCaptureModal(
          this.app,
          file,
          source,
          "comment",
          selected,
          async ({ text, source: snapshot }) => {
            const edit = this.buildCommentEdit(snapshot, from, to, text);
            await this.applyEditsToFile(file, [edit], {
              requireAll: true,
              expectedSource: snapshot,
            });
          },
        ).open();
        return true;
      },
    });
    this.addCommand({
      id: "substitute-selection",
      name: "Substitute selection",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file) return false;
        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        if (from === to) return false; // needs a selection
        const source = editor.getValue();
        // Destructive: refuse if the selection touches an existing mark.
        // Re-checked on both the show and the act runs.
        if (selectionOverlapsNodes(parse(source).nodes, from, to)) return false;
        // Refuse selections inside code — wrapped markup would be dropped by the
        // parser, leaving dead markup in the sample (otc-402).
        if (selectionInCode(source, from, to)) return false;
        if (checking) return true;
        const selected = source.slice(from, to);
        new AuthorCaptureModal(
          this.app,
          file,
          source,
          "substitute",
          selected,
          async ({ text, source: snapshot }) => {
            // Validation already ran in the modal; the span-anchored edit drops
            // on drift via expectedSource (E6) / fail-closed rebase (E7).
            const edit = substituteSelection(from, to, selected, text);
            await this.applyEditsToFile(file, [edit], {
              requireAll: true,
              expectedSource: snapshot,
            });
          },
        ).open();
        return true;
      },
    });
    this.addCommand({
      id: "toggle-suggesting-mode",
      name: "Toggle suggesting mode",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.toggleSuggestMode(file);
        return true;
      },
    });
    this.addCommand({
      id: "finalize-for-publish",
      name: "Finalize for publish",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.runFinalize(file);
        return true;
      },
    });

    // Ribbon for quick access.
    this.addRibbonIcon("message-square", "Open CriticMarkup review panel", () =>
      this.openReviewPanel(),
    );
    // Ribbon mirror of suggesting-mode state for the active file (R-ENTRY-3).
    this.suggestRibbonEl = this.addRibbonIcon("pencil", "Toggle suggesting mode", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && file.extension === "md") this.toggleSuggestMode(file);
      else new Notice("Open a markdown note to suggest edits.");
    });

    // Status-bar mirror of suggesting-mode state for the active file.
    this.suggestStatusEl = this.addStatusBarItem();

    // Settings tab.
    this.addSettingTab(new TrackChangesCriticMarkupSettingsTab(this.app, this));

    // Keep the status-bar / ribbon mirror in sync with whichever file is active.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshSuggestUI()),
    );

    // Open panel automatically after layout is ready, if not already.
    this.app.workspace.onLayoutReady(() => {
      // Don't force-open on first run; user can use the ribbon/command.
      this.refreshSuggestUI();
    });
  }

  onunload(): void {
    // Leaves of our view type are detached automatically when their root is.
    // (Obsidian guidance: do NOT call detachLeavesOfType in onunload.)
    this.suggestMode.clear();
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<TrackChangesCriticMarkupSettings>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      finalize: { ...DEFAULT_SETTINGS.finalize, ...(stored.finalize ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Force open reading-mode previews to re-run post-processors. */
  rerenderReadingViews(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) view.previewMode?.rerender(true);
    });
  }

  private makeDecorationExtension(): Extension {
    return criticDecorationsExtension({
      onOpenPanel: (offset) => this.handleInlineClick(offset),
      shouldOpenPanel: (event) =>
        this.settings.clickMarksToOpenPanel || event.metaKey || event.ctrlKey,
      highlightChangedChars: () => this.settings.highlightChangedChars,
    });
  }

  /** Repaint the per-character substitution highlight in open editors and the
   * panel after the `highlightChangedChars` setting toggled. */
  refreshCharHighlighting(): void {
    this.editorExtensions.length = 0;
    this.editorExtensions.push(this.makeDecorationExtension());
    this.app.workspace.updateOptions();
    this.getReviewView()?.rebuildCards();
  }

  // ---- host implementation for the panel ----

  private makeReviewView(leaf: WorkspaceLeaf): ReviewPanelView {
    const host: PanelHost = {
      app: this.app,
      getActiveFile: () => {
        const file = this.app.workspace.getActiveFile();
        return file && file.extension === "md" ? file : null;
      },
      getCurrentSource: (file) => {
        const editor = this.findEditorForFile(file);
        if (!editor) return null;
        const cm = (editor as unknown as { cm?: EditorView }).cm;
        return cm ? cm.state.doc.toString() : editor.getValue();
      },
      applyEdits: (file, edits) => this.applyEditsToFile(file, edits),
      revealOffset: (file, offset, length, flashChip) =>
        this.revealOffsetInEditor(file, offset, length, flashChip ?? false),
      isFileOpen: (file) => this.findEditorForFile(file) !== null,
      confirmBeforeDelete: () => this.settings.confirmBeforeDelete,
      highlightChangedChars: () => this.settings.highlightChangedChars,
      isSuggesting: (file) => this.suggestMode.isActive(file.path),
      toggleSuggesting: (file) => this.toggleSuggestMode(file),
    };
    return new ReviewPanelView(leaf, host);
  }

  // ---- suggesting mode (cm-1.2) ----

  /**
   * Toggle suggesting mode for `file`. Entering snapshots the file's current
   * text as the diff baseline (R-SUG-1); the user then edits ordinary plain
   * text (no transaction interception — N2). The overlay (cm-1.3) and commit
   * (cm-1.4) build on this baseline. Returns the new active state.
   */
  private toggleSuggestMode(file: TFile): boolean {
    const active = this.suggestMode.toggle(file.path, this.currentTextFor(file));
    new Notice(active ? "Suggesting mode on." : "Suggesting mode off.");
    this.refreshSuggestUI();
    // Force a rebuild: toggling mode leaves the document text unchanged, so a
    // plain source-refresh short-circuits and the header toggle never repaints.
    // Covers the ribbon/command paths too, not just the panel button's onclick.
    this.getReviewView()?.rebuildCards();
    return active;
  }

  /** Current editor text for a file (live CM6 doc preferred), or "" if unopened. */
  private currentTextFor(file: TFile): string {
    const editor = this.findEditorForFile(file);
    if (!editor) return "";
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    return cm ? cm.state.doc.toString() : editor.getValue();
  }

  /** Repaint the status-bar + ribbon mirror to the active file's mode. */
  private refreshSuggestUI(): void {
    const file = this.app.workspace.getActiveFile();
    const active = !!file && file.extension === "md" && this.suggestMode.isActive(file.path);
    if (this.suggestStatusEl) {
      this.suggestStatusEl.setText(active ? "✎ Suggesting" : "");
      this.suggestStatusEl.toggleClass("tc-suggesting-active", active);
    }
    this.suggestRibbonEl?.toggleClass("is-active", active);
  }

  private async openReviewPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open review panel.");
      return;
    }
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private getReviewView(): ReviewPanelView | null {
    const leaves = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ReviewPanelView) return leaf.view;
    }
    return null;
  }

  // ---- inline-click handler ----

  private handleInlineClick(offset: number): void {
    void (async () => {
      await this.openReviewPanel();
      const file = this.app.workspace.getActiveFile();
      const view = this.getReviewView();
      if (file && view) view.focusOffset(file, offset);
    })();
  }

  /**
   * Pick the right comment builder for a selection against `source`:
   *   - clean non-empty selection -> span-anchored `{==sel==}{>>body<<}`;
   *   - collapsed cursor, or a selection intersecting a mark -> bare
   *     `{>>body<<}` snapped out past the last intersecting node, so it never
   *     nests inside a body (which the parser's dedup would silently drop).
   */
  private buildCommentEdit(
    source: string,
    from: number,
    to: number,
    body: string,
  ): SourceEdit {
    const nodes = parse(source).nodes;
    if (from !== to && !selectionOverlapsNodes(nodes, from, to)) {
      return commentOnSelection(from, to, source.slice(from, to), body);
    }
    const at = from === to ? from : snapOutOffset(nodes, from, to) ?? to;
    return commentAtPoint(at, body, beforeAnchor(source, at));
  }

  // ---- editor edit application ----

  /**
   * Apply edits to a file. If the file is open in an active editor, route
   * through the editor's CM6 transaction so undo coalesces with the user's
   * normal undo stack. Otherwise fall back to Vault.process for an atomic
   * background-file rewrite.
   */
  private async applyEditsToFile(
    file: TFile,
    edits: SourceEdit[],
    options: ApplyEditsOptions = {},
  ): Promise<boolean> {
    if (edits.length === 0) return true;
    const editor = this.findEditorForFile(file);
    // `editor.cm` is undocumented but stable across Obsidian releases; it
    // exposes the underlying CM6 EditorView so our dispatch coalesces with
    // the user's normal undo stack.
    const cm = editor ? (editor as unknown as { cm?: EditorView }).cm : undefined;
    const currentSource = cm ? cm.state.doc.toString() : editor ? editor.getValue() : null;

    // Rebase against the current doc so stale offsets (from a re-parse the
    // panel did some ms ago, while the user was typing or the AI was editing
    // through another channel) can't corrupt unrelated text.
    if (currentSource !== null) {
      const prepared = this.prepareEdits(currentSource, edits, options);
      if (!prepared.ok) {
        this.showEditFailure(prepared.reason, options);
        return false;
      }
      this.showDroppedEdits(prepared.dropped);

      if (cm) {
        cm.dispatch({
          changes: prepared.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
        });
        this.getReviewView()?.refreshFromSource(file, cm.state.doc.toString());
        return true;
      }
      if (editor) {
        const next = applyEdits(currentSource, prepared.edits);
        editor.setValue(next);
        this.getReviewView()?.refreshFromSource(file, next);
        return true;
      }
    }

    let processOk = false;
    let processDropped = edits.length;
    let processReason: EditFailureReason = "moved";
    const next = await this.app.vault.process(file, (latestSource) => {
      const result = this.prepareEdits(latestSource, edits, options);
      if (!result.ok) {
        processOk = false;
        processDropped = result.dropped;
        processReason = result.reason;
        return latestSource;
      }
      const nextSource = applyEdits(latestSource, result.edits);
      processOk = true;
      processDropped = result.dropped;
      return nextSource;
    });
    if (!processOk) {
      this.showEditFailure(processReason, options);
      return false;
    }
    this.showDroppedEdits(processDropped);
    new Notice("Updated file outside the editor undo history.");
    this.getReviewView()?.refreshFromSource(file, next);
    return true;
  }

  private prepareEdits(
    currentSource: string,
    edits: SourceEdit[],
    options: ApplyEditsOptions,
  ): PreparedEdits {
    if (options.expectedSource !== undefined && currentSource !== options.expectedSource) {
      return { ok: false, reason: "stale", dropped: edits.length };
    }

    const { edits: rebased, dropped } = rebaseEdits(currentSource, edits);
    if (rebased.length === 0 || (options.requireAll && dropped > 0)) {
      return { ok: false, reason: "moved", dropped };
    }
    return { ok: true, edits: rebased, dropped };
  }

  private showEditFailure(reason: EditFailureReason, options: ApplyEditsOptions): void {
    if (reason === "stale") {
      new Notice("Edit canceled — the file changed. Reopen the dialog and try again.");
    } else if (options.requireAll) {
      new Notice("Edit canceled — one or more targets moved or changed.");
    } else {
      new Notice("Edit could not be applied — the text moved or was changed.");
    }
  }

  private showDroppedEdits(dropped: number): void {
    if (dropped > 0) {
      new Notice(`Skipped ${dropped} edit(s) — the target text moved or was changed.`);
    }
  }

  private findEditorForFile(file: TFile): Editor | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file === file) {
        return view.editor;
      }
    }
    return null;
  }

  // ---- reveal/scroll ----

  private revealOffsetInEditor(
    file: TFile,
    offset: number,
    length: number,
    flashChip: boolean,
  ): void {
    const editor = this.findEditorForFile(file);
    if (!editor) {
      // Open the file in a new leaf if not visible, then reveal.
      void this.app.workspace.openLinkText(file.path, "", false).then(() => {
        const ed = this.findEditorForFile(file);
        if (ed) this.scrollEditor(ed, offset, length, flashChip);
      });
      return;
    }
    this.scrollEditor(editor, offset, length, flashChip);
  }

  private scrollEditor(
    editor: Editor,
    offset: number,
    length: number,
    flashChip: boolean,
  ): void {
    // See applyEditsToFile for the rationale on accessing `editor.cm`.
    // By default we do NOT move the selection: placing the cursor inside a
    // CriticMarkup range causes Live Preview to unrender the decoration and
    // expose the raw `{>>…<<}` syntax. The `revealMarkupOnCommentJump` setting
    // lets users opt into that behavior — useful for those who want to edit
    // the markup source directly after jumping.
    const revealMarkup = flashChip && this.settings.revealMarkupOnCommentJump;
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (cm) {
      cm.dispatch({
        selection: revealMarkup ? { anchor: offset, head: offset + length } : undefined,
        effects: EditorView.scrollIntoView(offset, { y: "center" }),
      });
      if (flashChip) this.flashChipAt(cm, offset);
      return;
    }
    const from = editor.offsetToPos(offset);
    const to = editor.offsetToPos(offset + length);
    if (revealMarkup) editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  private flashChipAt(cm: EditorView, offset: number): void {
    // The chip may not be in the rendered viewport yet — CM6 renders
    // decorations lazily, and the scrollIntoView effect above triggers a
    // viewport update on the next measure cycle. Wait one frame so the chip
    // element exists in the DOM before we add the flash class.
    window.requestAnimationFrame(() => {
      const chip = cm.dom.querySelector<HTMLElement>(
        `.tc-chip[data-tc-offset="${offset}"]`,
      );
      if (!chip) return;
      chip.removeClass("tc-chip-flash");
      // Force a reflow so re-adding the class restarts the animation if the
      // user clicks the same card twice in quick succession.
      void chip.offsetWidth;
      chip.addClass("tc-chip-flash");
      window.setTimeout(() => chip.removeClass("tc-chip-flash"), 1500);
    });
  }

  // ---- finalize ----

  private async runFinalize(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    new FinalizeModal(
      this.app,
      file,
      source,
      this.settings.finalize,
      async (edits) => {
        await this.applyEditsToFile(file, edits, {
          expectedSource: source,
          requireAll: true,
        });
      },
    ).open();
  }
}

interface ApplyEditsOptions {
  /** Refuse to apply if the document source changed since the action was prepared. */
  expectedSource?: string;
  /** Refuse partial success if any edit cannot be rebased. */
  requireAll?: boolean;
}

type EditFailureReason = "stale" | "moved";

type PreparedEdits =
  | { ok: true; edits: SourceEdit[]; dropped: number }
  | { ok: false; reason: EditFailureReason; dropped: number };
