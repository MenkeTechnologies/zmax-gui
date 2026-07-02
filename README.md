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
mutations, git) lives in the Rust `project.rs` commands, so results are fast and the editor stays the
single source of truth.

- **Quick Open** (`⌘P`) — fuzzy file finder over the project tree (VCS/build dirs pruned), boundary-
  and run-aware ranking; type to filter, `↑`/`↓`/`Enter` to open.
- **Find in Files** (`⇧⌘J`) — project-wide text search with **regex**, **match-case** and
  **whole-word** toggles; click a match to jump to its exact `line:col`.
- **Recent Files** (`⌘E`) — a persisted MRU list (survives restarts; every open, from any route, is
  recorded), filterable, with **Clear**.
- **Project Files** (`⇧⌘E`) — a tree file manager: **New File / New Folder**, **Rename**,
  **Duplicate**, **Delete** (confirmed), and **File Info** (line/word/char/byte counts) via the
  right-click menu; click a file to open it.
- **Git Changes** — the current branch + `git status` list; click a file for its unified **diff**, or
  open it in the editor.

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
