# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Operational gates (build/test/invariants): @.claude/rules/ts.md

## Project

Obsidian plugin that reviews CriticMarkup suggestions (typically authored by an AI) in a side panel — accept/reject/reply. No sidecar state; everything lives as `{++…++}`, `{--…--}`, `{~~old~>new~~}`, `{>>comment<<}`, `{==highlight==}` directly in the markdown.

## Commands

```sh
npm install              # one-time
npm run dev              # esbuild watch -> main.js (with inline sourcemaps)
npm run build            # tsc --noEmit + esbuild production bundle
npm run typecheck        # tsc --noEmit -skipLibCheck
npm test                 # runs all six test files sequentially
node test/parser.test.mjs        # run a single test file
```

Tests are plain Node ESM scripts (`.mjs`) under `test/` — no test framework. They import compiled TS via Node's TS loader path or by re-implementing fixtures; check an existing test before adding one.

To load the dev build into Obsidian: symlink or copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/track-changes/`.

## Architecture

Entry point `src/main.ts` is the `Plugin` subclass. It wires four things into Obsidian and owns nothing else of substance:

1. **Right-side panel view** (`src/panel/view.ts`, `REVIEW_VIEW_TYPE`) — the review UI. `main.ts` constructs a `PanelHost` adapter so the panel never imports the `Plugin` directly; the panel calls back through `host.applyEdits`, `host.revealOffset`.
2. **CodeMirror 6 decoration extension** (`src/editor/decorations.ts`) — inline highlighting of CriticMarkup ranges in Live Preview / Source mode. Click handler routes back into `main.handleInlineClick` which opens the panel and focuses the offset.
3. **Reading-mode post-processor** (`src/reading.ts`) — renders markup in preview mode either as accepted preview or side-by-side, based on settings.
4. **Commands**: open panel, finalize for publish (`src/finalize.ts`).

### Data flow: parse → edits → rebase → apply

- `src/parser.ts` scans source text and emits a `ParseResult` with `nodes` (the five CriticMarkup kinds) and `threads` (adjacent `{>>…<<}` blocks group). Comments expose `authorName: string | null` — the captured `<Name>:` prefix (original casing) or `null` if unprefixed. **Code blocks are skipped** — markup inside fenced (```` ``` ````, `~~~`), indented (4-space / tab), or inline-backtick code is left alone.
- `src/operations.ts` turns user actions (accept, reject, reply, delete-thread, …) into `SourceEdit[]`. Each edit carries optional `expected` (text at `[from, to)`) and `before` (text immediately preceding `from`) as anchors.
- `rebaseEdits` re-validates each edit against the *current* document right before write. If the doc drifted since parse (user typed, AI re-edited via another channel), it searches a ±200-char window for the `before+expected` anchor; non-unique matches are dropped rather than risk corrupting unrelated text. This is critical — never apply raw stale offsets.
- `main.applyEditsToFile` prefers the live CM6 `EditorView.dispatch` (so changes coalesce with the user's undo stack), falls back to `Editor.setValue`, then to `Vault.process` for unopened files.

### Threading

A thread is a run of `{>>…<<}` blocks with only inline whitespace (no blank line) between them in the same paragraph. First is root, rest are replies. Authorship is detected from a `<Name>:` prefix on each comment (single token, alpha-leading, ≤30 chars — see `src/authors.ts`). Comments without a recognised prefix render as "You" (the local user). Treat this as a hard contract; don't add other heuristics.

### Settings

`src/settings.ts` holds `TrackChangesSettings`. The shape of this object is persisted via `loadData()` / `saveData()` — if you rename a key, write a migration in `loadSettings()` so existing users don't lose their config. Defaults are merged shallowly except `finalize`, which is merged one level deep — preserve that when adding nested setting groups.

## Conventions

- TypeScript strict, ES2018 target, CJS bundle (Obsidian requirement). External modules listed in `esbuild.config.mjs` — don't bundle `obsidian` or any `@codemirror/*` packages.
- Source edits must be non-overlapping; `applyEdits` asserts this and throws on violation. Construct edits with that contract in mind.
- When adding a new mutation, always set `expected` (and `before` for insertions) so it survives `rebaseEdits`.
- Companion-agent behavior is documented in `docs/SKILL.md` (the example reviewer-skill template shipped with the plugin). When changing thread/prefix semantics, update both this file and that one.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
