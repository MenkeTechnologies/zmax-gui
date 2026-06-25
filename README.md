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

## Features

- GUI front-end over the zemacs terminal editor — **same modal core, native window**
- Native tabs, menu bar, and toolbar; GUI font rendering and mouse support
- Native open/save dialogs and drag-and-drop
- Modal editing, tree-sitter syntax, and LSP inherited from the zemacs core
- Cross-platform

## Build

```sh
cargo build
cargo run
```

## Links

- **Core editor** — [`zemacs`](https://github.com/MenkeTechnologies/zemacs)
- **App store** — https://menketechnologies.github.io/app-store/

## License

Free / OSS — MPL-2.0 (zemacs / Helix lineage). See [LICENSE](LICENSE).
