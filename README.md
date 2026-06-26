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
├─ app/src-tauri/        Tauri host: terminal_spawn/write/resize/kill commands
├─ crates/zpwr-embed-terminal   shared PTY engine (submodule)
└─ frontend/
   ├─ index.html · main.js      mounts ZGui.appShell + the fullscreen terminal
   └─ lib/zgui-core             the shared widget library (submodule)
```

## Features (MVP)

- The full `zemacs` modal editor (Helix fork) in a native window — **same core, GUI shell**
- zgui-core baseline: ⌘K command palette, colour‑scheme picker, settings, CRT/splash
- Mouse + truecolor in the embedded terminal
- *Roadmap:* native tabs / menu bar, open‑save dialogs, drag‑and‑drop, deeper LSP/GUI integration

## Build

Requires the `zemacs` binary on `PATH` (built from the [`zemacs`](https://github.com/MenkeTechnologies/zemacs) repo).

```sh
pnpm install
pnpm tauri dev      # or: pnpm tauri build
```

## Links

- **Core editor** — [`zemacs`](https://github.com/MenkeTechnologies/zemacs)
- **App store** — https://menketechnologies.github.io/app-store/

## License

Free / OSS — MPL-2.0 (zemacs / Helix lineage). See [LICENSE](LICENSE).
