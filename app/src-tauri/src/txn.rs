//! Content snapshots that make a file-mutating bus verb *reversible*.
//!
//! The GUI Automation Bus (`GUI_AUTOMATION_BUS.md` §4, `zgui-core/webui/automation.js`) classifies
//! every verb as `pure` / `inverse` / `irreversible`, and a verb may only claim `inverse` if it
//! ships an `undo()` that actually puts the world back. For a *read* verb that is trivial. For
//! zmax-gui's workbench — project-wide replace, batch rename, sort/cleanup/align/transcode — the
//! effect is bytes already written to disk, so the only honest compensation is the bytes that were
//! there before. This module records them.
//!
//! The shape is deliberately narrow:
//!
//! * `snapshot(base, paths)` copies the CURRENT content of each path into a token directory and
//!   returns the token. A path that does not exist yet is recorded as absent — the compensation for
//!   "the verb created it" is "delete it", which needs that distinction.
//! * `restore(base, token)` writes every recorded file back to its recorded path and removes every
//!   path recorded as absent. It is idempotent: restoring twice writes the same bytes twice.
//! * `discard(base, token)` drops the token directory (a committed transaction never compensates).
//!
//! Everything is keyed by absolute path, not by an index into a plan, so a compensation cannot be
//! applied to the wrong file if the caller re-orders its arguments between the forward call and the
//! abort.
//!
//! Directories are snapshotted recursively: `delete_path` on a folder is only reversible if every
//! file under it was recorded. Symlinks are recorded as absent-or-file by their *target* bytes and
//! restored as regular files — an honest limit, stated here and in the verb's `label`, rather than
//! a silent partial restore.
//!
//! The core functions take their storage root as an argument so they are unit-testable without a
//! Tauri `AppHandle`; the `#[tauri::command]` wrappers pass [`default_base`].

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A single recorded path inside a snapshot.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// The absolute path this entry restores to.
    pub path: String,
    /// Blob file name inside `<token>/blobs`, or `None` when the path did not exist.
    pub blob: Option<String>,
    /// True when the path existed as a directory (restored by re-creating it, empty if it had no
    /// files — its children get their own entries).
    pub dir: bool,
}

/// The manifest written to `<base>/<token>/manifest.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Manifest {
    pub entries: Vec<Entry>,
}

/// What a restore actually did, so the caller can report a partial compensation rather than claim a
/// clean one. `failed` is never fatal: every entry is attempted, matching `txnAbort`'s per-step
/// isolation in `automation.js`.
#[derive(Serialize, Default, Debug)]
pub struct RestoreReport {
    /// Paths whose previous content was written back.
    pub restored: Vec<String>,
    /// Paths that did not exist before and were removed again.
    pub removed: Vec<String>,
    /// `(path, reason)` for entries that could not be compensated.
    pub failed: Vec<(String, String)>,
}

/// Snapshot storage root. Under the OS temp dir rather than the app data dir on purpose: a snapshot
/// is live only for the span of one bus transaction, and a crash mid-transaction should not leave
/// copies of the user's source tree in a directory that is backed up.
pub fn default_base() -> PathBuf {
    std::env::temp_dir().join("zmax-gui-txn")
}

/// Monotonic-ish token: process id + a nanosecond clock. Collision would require two snapshots in
/// the same process within the same nanosecond, which the borrow of the directory below rejects
/// anyway (`create_dir` fails if it exists).
fn new_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

fn token_dir(base: &Path, token: &str) -> Result<PathBuf, String> {
    // A token is generated here, never supplied by a script, but it arrives back over the bus as a
    // string — so reject anything that could escape the base directory.
    if token.is_empty() || token.contains(['/', '\\']) || token.contains("..") {
        return Err(format!("bad snapshot token: {token}"));
    }
    Ok(base.join(token))
}

/// Record every file under `path` (or `path` itself when it is a file) into `dir`, appending one
/// [`Entry`] per path. `next` numbers the blobs.
fn record(path: &Path, blobs: &Path, entries: &mut Vec<Entry>, next: &mut usize) -> Result<(), String> {
    let abs = path.to_string_lossy().into_owned();
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        // Absent is a legitimate recording, not an error: it is what makes "the verb created this
        // file" reversible.
        Err(_) => {
            entries.push(Entry { path: abs, blob: None, dir: false });
            return Ok(());
        }
    };
    if meta.is_dir() {
        entries.push(Entry { path: abs, blob: None, dir: true });
        let mut children: Vec<PathBuf> = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .collect();
        // Deterministic order so a manifest is reproducible and diffable.
        children.sort();
        for child in children {
            record(&child, blobs, entries, next)?;
        }
        return Ok(());
    }
    let name = format!("{next}");
    *next += 1;
    fs::copy(path, blobs.join(&name)).map_err(|e| format!("{abs}: {e}"))?;
    entries.push(Entry { path: abs, blob: Some(name), dir: false });
    Ok(())
}

/// Copy the current content of `paths` into a fresh token directory under `base`.
pub fn snapshot(base: &Path, paths: &[String]) -> Result<String, String> {
    let token = new_token();
    let dir = token_dir(base, &token)?;
    let blobs = dir.join("blobs");
    fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    let mut next = 0usize;
    for p in paths {
        record(Path::new(p), &blobs, &mut entries, &mut next)?;
    }
    let manifest = Manifest { entries };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join("manifest.json"), json).map_err(|e| e.to_string())?;
    Ok(token)
}

/// Read a token's manifest.
pub fn manifest(base: &Path, token: &str) -> Result<Manifest, String> {
    let dir = token_dir(base, token)?;
    let raw = fs::read(dir.join("manifest.json"))
        .map_err(|e| format!("no such snapshot: {token} ({e})"))?;
    serde_json::from_slice(&raw).map_err(|e| e.to_string())
}

/// Put every recorded path back. Deepest paths first, so a directory that has to be removed is
/// emptied by its own children's entries before the directory entry is reached.
pub fn restore(base: &Path, token: &str) -> Result<RestoreReport, String> {
    let dir = token_dir(base, token)?;
    let blobs = dir.join("blobs");
    let man = manifest(base, token)?;
    let mut report = RestoreReport::default();

    let mut entries = man.entries;
    entries.sort_by_key(|e| std::cmp::Reverse(e.path.matches(std::path::MAIN_SEPARATOR).count()));

    for e in entries {
        let target = PathBuf::from(&e.path);
        let outcome = if e.dir {
            // Recorded as a directory: make sure one exists again (its files are separate entries).
            fs::create_dir_all(&target)
                .map(|_| Outcome::Restored)
                .map_err(|err| err.to_string())
        } else if let Some(blob) = e.blob.as_ref() {
            (|| {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                let bytes = fs::read(blobs.join(blob)).map_err(|err| err.to_string())?;
                fs::write(&target, bytes).map_err(|err| err.to_string())?;
                Ok(Outcome::Restored)
            })()
        } else {
            // Recorded as absent: the forward verb created it, so the compensation removes it. A
            // path that is still absent is already compensated — not an error.
            match fs::symlink_metadata(&target) {
                Err(_) => Ok(Outcome::Removed),
                Ok(m) if m.is_dir() => fs::remove_dir_all(&target)
                    .map(|_| Outcome::Removed)
                    .map_err(|err| err.to_string()),
                Ok(_) => fs::remove_file(&target)
                    .map(|_| Outcome::Removed)
                    .map_err(|err| err.to_string()),
            }
        };
        match outcome {
            Ok(Outcome::Restored) => report.restored.push(e.path),
            Ok(Outcome::Removed) => report.removed.push(e.path),
            Err(reason) => report.failed.push((e.path, reason)),
        }
    }
    Ok(report)
}

enum Outcome {
    Restored,
    Removed,
}

/// Drop a token directory. Idempotent — discarding an already-discarded token is a no-op, because a
/// commit path must not fail on a snapshot the caller already cleaned up.
pub fn discard(base: &Path, token: &str) -> Result<(), String> {
    let dir = token_dir(base, token)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every live snapshot token, newest first. Exposed so the bus can report (and a script can clean
/// up) snapshots stranded by a transaction that never committed or aborted.
pub fn list(base: &Path) -> Result<Vec<String>, String> {
    if !base.exists() {
        return Ok(Vec::new());
    }
    let mut tokens: Vec<String> = fs::read_dir(base)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().join("manifest.json").exists())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    tokens.sort();
    tokens.reverse();
    Ok(tokens)
}

// ── Tauri commands (the bus verbs in `verbs.js` call these) ─────────────────────────────────────

/// Snapshot `paths` before a mutating verb runs; the returned token rides in the verb's result so
/// its `undo()` can hand it straight back to [`txn_restore`].
#[tauri::command]
pub fn txn_snapshot(paths: Vec<String>) -> Result<String, String> {
    snapshot(&default_base(), &paths)
}

/// Compensate a mutating verb by restoring its snapshot.
#[tauri::command]
pub fn txn_restore(token: String) -> Result<RestoreReport, String> {
    restore(&default_base(), &token)
}

/// Release a snapshot (transaction committed, or the verb's effect is being kept).
#[tauri::command]
pub fn txn_discard(token: String) -> Result<(), String> {
    discard(&default_base(), &token)
}

/// Live snapshot tokens — stranded ones included, which is the point.
#[tauri::command]
pub fn txn_list() -> Result<Vec<String>, String> {
    list(&default_base())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private base per test so the suite can run in parallel without sharing a token space.
    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zmax-gui-txn-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn restores_the_bytes_a_verb_overwrote() {
        let base = temp_base("overwrite");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"before\n").unwrap();

        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"AFTER, rewritten by the verb\n").unwrap();

        let report = restore(&base, &token).unwrap();
        assert!(report.failed.is_empty(), "failed: {:?}", report.failed);
        assert_eq!(fs::read(&f).unwrap(), b"before\n");
    }

    #[test]
    fn removes_a_path_that_did_not_exist_before() {
        let base = temp_base("created");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("new.txt");
        assert!(!f.exists());

        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"the verb created me\n").unwrap();

        let report = restore(&base, &token).unwrap();
        assert!(report.failed.is_empty(), "failed: {:?}", report.failed);
        assert!(!f.exists(), "a path recorded as absent must be removed again");
        assert_eq!(report.removed, vec![f.to_string_lossy().into_owned()]);
    }

    #[test]
    fn a_rename_is_reversible_because_both_sides_are_recorded() {
        let base = temp_base("rename");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let from = work.join("old.rs");
        let to = work.join("new.rs");
        fs::write(&from, b"fn main() {}\n").unwrap();

        let token = snapshot(
            &base,
            &[
                from.to_string_lossy().into_owned(),
                to.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        fs::rename(&from, &to).unwrap();
        assert!(!from.exists() && to.exists());

        restore(&base, &token).unwrap();
        assert!(from.exists(), "the source must come back");
        assert!(!to.exists(), "the destination must go away again");
        assert_eq!(fs::read(&from).unwrap(), b"fn main() {}\n");
    }

    #[test]
    fn a_deleted_directory_comes_back_with_its_files() {
        let base = temp_base("deltree");
        let work = base.join("work");
        fs::create_dir_all(work.join("sub")).unwrap();
        fs::write(work.join("sub/one.txt"), b"1\n").unwrap();
        fs::write(work.join("sub/two.txt"), b"2\n").unwrap();

        let token = snapshot(&base, &[work.join("sub").to_string_lossy().into_owned()]).unwrap();
        fs::remove_dir_all(work.join("sub")).unwrap();

        restore(&base, &token).unwrap();
        assert_eq!(fs::read(work.join("sub/one.txt")).unwrap(), b"1\n");
        assert_eq!(fs::read(work.join("sub/two.txt")).unwrap(), b"2\n");
    }

    #[test]
    fn restore_is_idempotent() {
        let base = temp_base("idem");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"v1\n").unwrap();
        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"v2\n").unwrap();

        restore(&base, &token).unwrap();
        restore(&base, &token).unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"v1\n");
    }

    #[test]
    fn discard_is_idempotent_and_drops_the_blobs() {
        let base = temp_base("discard");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"x\n").unwrap();
        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        assert!(base.join(&token).exists());

        discard(&base, &token).unwrap();
        discard(&base, &token).unwrap();
        assert!(!base.join(&token).exists());
        assert!(restore(&base, &token).is_err(), "a discarded token has nothing to restore");
    }

    #[test]
    fn a_token_cannot_escape_the_base_directory() {
        let base = temp_base("escape");
        for bad in ["../evil", "a/b", "", ".."] {
            assert!(
                token_dir(&base, bad).is_err(),
                "token {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn list_reports_live_tokens_and_forgets_discarded_ones() {
        let base = temp_base("list");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"x\n").unwrap();

        let t1 = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        assert!(list(&base).unwrap().contains(&t1));
        discard(&base, &t1).unwrap();
        assert!(!list(&base).unwrap().contains(&t1));
    }
}
