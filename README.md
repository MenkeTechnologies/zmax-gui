```
███████╗███████╗███╗   ███╗ █████╗  ██████╗███████╗       ██████╗ ██╗   ██╗██╗
╚══███╔╝██╔════╝████╗ ████║██╔══██╗██╔════╝██╔════╝      ██╔════╝ ██║   ██║██║
  ███╔╝ █████╗  ██╔████╔██║███████║██║     ███████╗█████╗██║  ███╗██║   ██║██║
 ███╔╝  ██╔══╝  ██║╚██╔╝██║██╔══██║██║     ╚════██║╚════╝██║   ██║██║   ██║██║
███████╗███████╗██║ ╚═╝ ██║██║  ██║╚██████╗███████║      ╚██████╔╝╚██████╔╝██║
╚══════╝╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝       ╚═════╝  ╚═════╝ ╚═╝
```

![Rust](https://img.shields.io/badge/Rust-2021-05d9e8?style=flat-square)
![GUI](https://img.shields.io/badge/GUI-windowed%20editor-ff2a6d?style=flat-square)
![license](https://img.shields.io/badge/license-MPL--2.0-39ff14?style=flat-square)

### `[A NATIVE DESKTOP GUI FOR ZEMACS // THE WAY MACVIM WRAPS VIM]`

**zemacs-gui** is a native desktop GUI for the
[`zemacs`](https://github.com/MenkeTechnologies/zemacs) editor — the Rust Emacs
port (a Helix/Vim-style modal core built out toward Spacemacs). It wraps the
zemacs modal-editing core in a windowed front-end, the way MacVim wraps the Vim
CLI editor: the same editor underneath, a native window on top. Free and open
source.

## Architecture

A thin **Tauri v2** shell that runs the `zemacs` binary in an **embedded PTY terminal**
([`zpwr-embed-terminal`](https://github.com/MenkeTechnologies/zpwr-embed-terminal)) filling the
window, wrapped in the shared **zgui-core** app baseline (`ZGui.appShell`: command palette, colour
schemes, settings, CRT/splash). The editor is the same modal core; the window, chrome and theming are
the GUI. Standard MenkeTechnologies GUI layout — see `GUI_APP_ARCHITECTURE.md` in the meta repo.

```
zemacs-gui/
├─ app/src-tauri/        Tauri host: terminal + fs + window + open-intake + project commands
│   ├─ terminal.rs       PTY spawn/write/resize/kill
│   ├─ fs_ops.rs         list_dir/home_dir — backs the Open dialog
│   ├─ window_ops.rs     fullscreen / translucency (blur) / focus
│   ├─ project.rs        fuzzy find-files, find-in-files (regex), tree file ops, recent files,
│   │                    file stats, git status/branch/diff — the project workbench backend
│   ├─ editor_tools.rs   bookmarks, project search & replace, go-to-symbol, TODO/markers
│   ├─ git_tools.rs      git blame, per-file history + show-commit, stage/unstage/discard, file compare
│   ├─ git_ext.rs        git branches (list/checkout/create) + stash (save/list/pop/drop/show)
│   ├─ text_tools.rs     file cleanup/convert, sort lines, find-definition, batch rename
│   ├─ workbench_ext.rs  persisted snippets + project code-stats (files/lines by extension)
│   └─ open_intake.rs    CLI / Finder / mvim:// file opens → :open in the PTY
├─ crates/
│   ├─ zemacs            the editor — vendored submodule, built → bundled sidecar
│   └─ zpwr-embed-terminal   shared PTY engine (submodule)
├─ scripts/
│   ├─ mvim              terminal launcher (open files in the running window)
│   └─ prepare-{zemacs,stryke}-sidecar.mjs   stage the bundled binaries
└─ frontend/
   ├─ index.html · main.js      mounts ZGui.appShell + the fullscreen terminal
   ├─ menu.js                   the MacVim GUI surface (all zgui widgets → PTY)
   ├─ panels.js · panels.css    the project workbench overlays (quick-open, find-in-files, …)
   └─ lib/zgui-core             the shared widget library (submodule)
```

## Project workbench

On top of the MacVim menu surface, the app adds an IDE-style **project workbench** — all reachable
from the **⌘K command palette** (and dedicated shortcuts). Every result is opened by driving the
editor (`:open <path>:<line>:<col>`); the OS-side work (walking the tree, grepping, filesystem
mutations, git) lives in the Rust `project.rs` / `editor_tools.rs` / `git_tools.rs` / `git_ext.rs` /
`text_tools.rs` / `workbench_ext.rs` commands, so results are fast and the editor stays the single
source of truth.

- **Quick Open** (`⌘P`) — fuzzy file finder over the project tree (VCS/build dirs pruned), boundary-
  and run-aware ranking; type to filter, `↑`/`↓`/`Enter` to open.
- **Find in Files** (`⇧⌘J`) — project-wide text search with **regex**, **match-case** and
  **whole-word** toggles; click a match to jump to its exact `line:col`, or **★** to bookmark it.
- **Search & Replace** (`⇧⌘H`) — project-wide replace with **regex** (including `$1` capture
  references), match-case and whole-word; a live **preview** of every before → after line, then
  **Replace All** rewrites the matching files on disk (confirmed first). Binary/oversized files are
  skipped, like the search.
- **Go to Symbol** (`⇧⌘O`) — a workspace outline picker: functions, structs/classes/enums/traits,
  types, modules, methods and Markdown headings across the tree (Rust, JS/TS, Python, Go, C/C++,
  Ruby, shell, Lua, stryke/Perl, Markdown); type to filter, `Enter` to jump.
- **Find Definition** (`⇧⌘D`) — jump to where an *exact* symbol name is **declared** (not every
  occurrence): reuses the Go-to-Symbol language rules to locate `fn`/`struct`/`class`/`def`/… sites
  across the tree; type a name, `Enter` to jump.
- **TODO / Markers** (`⇧⌘T`) — a scan for `TODO` / `FIXME` / `HACK` / `XXX` / `BUG` / `NOTE` /
  `OPTIMIZE` / `WARNING` comment markers across the tree; filter and jump to each.
- **Bookmarks** (`⌘B`) — a persisted list of named `file:line` marks (survives restarts); add from a
  file picker or the **★** button on a search hit, jump on click, remove per-row or **Clear**.
- **Recent Files** (`⌘E`) — a persisted MRU list (survives restarts; every open, from any route, is
  recorded), filterable, with **Clear**.
- **Project Files** (`⇧⌘E`) — a tree file manager: **New File / New Folder**, **Rename**,
  **Duplicate**, **Delete** (confirmed), and **File Info** (line/word/char/byte counts) via the
  right-click menu; click a file to open it.
- **Batch Rename** — rename every file whose **base name** matches a find → replace rule (literal or
  **regex** with `$1` capture refs); a live **preview** of every `from → to` (collisions flagged),
  then **Rename All** applies it on disk (confirmed). Files stay in their directory.
- **Sort Lines** — reorder a file's lines on disk: **reverse**, **ignore-case**, **numeric** and
  **unique** (a sorted `uniq`) toggles, with a dry-run preview of the line-count delta; the file is
  reloaded in the editor after apply.
- **File Cleanup** — normalise a file: convert line endings (**LF**/**CRLF**), **trim trailing
  whitespace**, **expand tabs → spaces** or **tabify** leading indent, and **ensure a final
  newline**; a preview reports the changed-line count and byte delta before apply. Binary/oversized
  files are skipped, like the search tools.
- **Snippets** (`⇧⌘I`) — a persisted named text library; pick one to insert it into the editor via
  bracketed paste (multi-line bodies land verbatim, no auto-indent), add / remove / **Clear**.
- **Git Changes** — the current branch + `git status` list; click a file for its unified **diff**;
  **Stage** / **Unstage** / **Discard** (confirmed) each file inline, **Refresh**, jump to **Blame**,
  or open it in the editor.
- **Git Blame** (`⇧⌘B`) — per-line commit / author / date for a chosen file (`git blame`
  `--line-porcelain`); click a line to jump there.
- **File History** — the commit log touching a file (`git log --follow`); click a commit for the
  **diff it introduced** (`git show`), or open the file.
- **Compare Files** — a unified **diff** between any two files picked from the tree
  (`git diff --no-index`, so it works outside a repo too).
- **Git Branches** — the local branches (most-recently-committed first, current flagged); click to
  **checkout** (confirmed), or **New Branch** to create and switch (`checkout -b`). Ref names are
  flag-guarded.
- **Git Stash** — the stash list; click an entry for its **patch** (`stash show -p`), **Pop**
  (apply + drop, confirmed) or **Drop** (confirmed) per entry, and **Stash Changes** to save the
  working tree (including untracked) with an optional message.
- **Project Stats** — a read-only report of file / line / byte counts across the tree, broken down by
  extension (binary and oversized files skipped for line counting).

All surfaces are modal overlays (like the Open dialog) built from zgui-core widgets — no docked pane,
so the embedded terminal is never reflowed.

## MacVim-style GUI

The GUI wraps the modal core the way MacVim wraps Vim. Every surface is a **zgui-core widget**; each
action is bridged to the editor by writing an ex-command into the PTY (the GUI never edits files
itself, it drives `zemacs`). Because zemacs is a Helix fork, MacVim "tabs" map to **buffers**.

- **Menu bar** (`ZGui.menubar`) — File / Edit / View / Buffers / Window / Help.
- **Toolbar** (`ZGui.buttonBar`) — new / open / save / buffer nav / find / split / full screen.
- **Command palette** (`⌘K`) — every menu action, fuzzy-searchable.
- **Cmd-shortcuts** — ⌘S save, ⇧⌘S Save As, ⌘O open, ⌘W close buffer, ⌘N new, ⌘Z/⇧⌘Z undo/redo,
  ⌘F find, ⌘G/⇧⌘G next/prev, ⌘{ ⌘} buffer cycle, ⌃⌘F full screen.
- **Open / Save As / Help** dialogs (`ZGui.modal` + `ZGui.tree` file browser).
- **Right-click context menu** in the editor (`ZGui.contextMenu`).
- **Drag-and-drop** files to open (`ZGui.fileDrag`).
- **Full screen** + **translucent background** (window-vibrancy); **Preferences** panel.
- **Open from the terminal / Finder / `mvim://` URL**, forwarded into the running window
  (single-instance + deep-link). Use `scripts/mvim file…`.

Out of scope (no surface in a PTY/WebView host — they need a native text view): native font rendering
(ligatures, thin strokes, antialias), Touch Bar, macOS Services, Force Click / dictionary lookup,
trackpad gesture pseudo-keys, find-pasteboard sharing. A live buffer **tabline** is omitted on
purpose — a faithful one needs editor↔GUI introspection the raw PTY doesn't expose, and a drifting
strip would lie about state.

## Bundled binaries (self-contained)

The app **bundles** both the `zemacs` editor and the `stryke` runtime as Tauri `externalBin` sidecars —
it never depends on either being on the user's `PATH`. Before each dev/build,
`scripts/prepare-{zemacs,stryke}-sidecar.mjs` stage the binaries into
`app/src-tauri/binaries/<name>-<target-triple>` (the name `externalBin` requires); at runtime
`sidecar.rs` resolves the sidecar beside the executable (or the dev staging dir) and the editor is
launched by absolute path, with `STRYKE_BIN` exported to the bundled stryke. The staged binaries are
gitignored build artifacts.

- **zemacs** — vendored as the **`crates/zemacs` submodule** and built by the prep script
  (`cargo build --bin zemacs`); override with `ZEMACS_SIDECAR_BIN`.
- **stryke** — pulled from the **latest [strykelang](https://github.com/MenkeTechnologies/strykelang)
  GitHub release** for the host triple (cached by release tag); falls back to a local stryke offline;
  override with `STRYKE_SIDECAR_BIN`.

## Build

```sh
git submodule update --init --recursive   # zgui-core, zpwr-embed-terminal, zemacs
pnpm install
pnpm tauri dev      # or: pnpm tauri build
```

The first run builds `crates/zemacs` (Helix-fork workspace — a few minutes) and downloads the stryke
release; both are cached afterward.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the macOS app on Apple-silicon
(`aarch64`) and Intel (`x86_64`) runners and attaches the per-arch `.dmg` + zipped `.app` to the
GitHub release. The bundled zemacs (release build of the submodule) and stryke (latest release) sidecars
are staged automatically by `beforeBuildCommand`, so each `.app` is self-contained.

```sh
git tag v0.1.0 && git push --tags
```

## Links

- **Core editor** — [`zemacs`](https://github.com/MenkeTechnologies/zemacs)
- **App store** — https://menketechnologies.github.io/app-store/

## License

Free / OSS — MPL-2.0 (zemacs / Helix lineage). See [LICENSE](LICENSE).
