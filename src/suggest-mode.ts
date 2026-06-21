// Suggesting-mode state (TA-MODE/BASE, spec §6 Phase A, R-SUG-1/2, R-ENTRY-3).
//
// Per-file flag: while a file is in suggesting mode the user edits ordinary
// plain text (no transaction interception — N2); the diff overlay (cm-1.3) and
// the commit-materialize (cm-1.4) read the snapshotted `baseline` to compute
// `diff(baseline, current)`. This module owns only the state — the toggle UI
// (panel header / ribbon / status bar) and the diff are layered on top.
//
// Keyed by file path. A rename mid-session drops the mode (path changes); that
// is an accepted v1 edge — suggesting mode is a transient per-session state, not
// persisted across reloads, and `N5` single-writer means no concurrent renamer.

export class SuggestModeState {
  /** path -> baseline accepted-text snapshot taken at mode entry. */
  private baselines = new Map<string, string>();

  /** True if `path` is currently in suggesting mode. */
  isActive(path: string): boolean {
    return this.baselines.has(path);
  }

  /** The baseline snapshot for `path`, or null if not in suggesting mode. */
  baselineFor(path: string): string | null {
    const b = this.baselines.get(path);
    return b === undefined ? null : b;
  }

  /**
   * Enter suggesting mode for `path`, snapshotting `baseline` (the current
   * accepted text). Re-entering an already-active file refreshes the baseline —
   * harmless, and matches the "snapshot at entry" contract (R-SUG-1).
   */
  enter(path: string, baseline: string): void {
    this.baselines.set(path, baseline);
  }

  /** Exit suggesting mode for `path`; returns the baseline that was in effect (or null). */
  exit(path: string): string | null {
    const b = this.baselines.get(path);
    if (b === undefined) return null;
    this.baselines.delete(path);
    return b;
  }

  /**
   * Toggle suggesting mode for `path`. Entering snapshots `currentText` as the
   * baseline; exiting clears it. Returns the new active state.
   */
  toggle(path: string, currentText: string): boolean {
    if (this.isActive(path)) {
      this.exit(path);
      return false;
    }
    this.enter(path, currentText);
    return true;
  }

  /** Drop all state (plugin unload). */
  clear(): void {
    this.baselines.clear();
  }
}
