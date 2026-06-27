//! Filesystem helpers backing the zgui file-open dialog (ZGui.modal + ZGui.tree). Read-only directory
//! listing only — the actual open happens by the frontend writing `:open <path>` into the PTY, so the
//! GUI never edits files itself, it drives the editor. The MacVim "native open/save dialog" analog,
//! built from zgui widgets instead of a native NSOpenPanel.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct DirListing {
    /// Absolute path of the directory that was listed.
    pub dir: String,
    /// Parent directory, or `None` at the filesystem root (drives the "↑" row).
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// List a directory for the open dialog. `path` defaults to the process cwd (which the PTY shares),
/// falling back to `$HOME`. Hidden dotfiles are included only when `show_hidden` is set.
#[tauri::command]
pub fn list_dir(path: Option<String>, show_hidden: Option<bool>) -> Result<DirListing, String> {
    let dir = match path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => std::env::current_dir().unwrap_or_else(|_| home()),
    };
    let dir = dir.canonicalize().unwrap_or(dir);
    let hidden = show_hidden.unwrap_or(false);

    let mut entries = Vec::new();
    for ent in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let name = ent.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(DirEntry {
            name,
            path: ent.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    // Directories first, then case-insensitive by name — matches Finder/MacVim ordering.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        dir: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// The user's home directory — the dialog's default landing point.
#[tauri::command]
pub fn home_dir() -> String {
    home().to_string_lossy().into_owned()
}
