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
//!
//! ── SEALING: a compensation that refuses rather than clobbers ────────────────────────────────────
//!
//! A bare snapshot is a *promise* to restore. It is not a safe one: `restore` writes the recorded
//! bytes over whatever is at each path NOW, and "now" is not necessarily "what the verb left". The
//! user's own editor, a formatter-on-save, an LSP code action, or one of the other app instances
//! driving this same tree can all touch a file between the forward step and the abort. Restoring
//! then destroys work the transaction never made, and reports success while doing it.
//!
//! [`seal`] closes that hole. After a mutating verb has landed, the caller seals its token: every
//! recorded path is re-read and fingerprinted AS THE VERB LEFT IT, into [`Entry::after`]. A sealed
//! [`restore`] compares the current fingerprint to that one, and where they differ it does not
//! write. It parks the pre-image beside the file as `<name>.zmax-undo-<token>` and reports the path
//! under [`RestoreReport::conflicted`], so nothing is lost in either direction: not the third
//! party's edit, not the pre-state.
//!
//! An UNSEALED token restores blind, exactly as before — the two are distinguished by
//! [`Manifest::sealed`] rather than by the presence of a fingerprint, because "sealed, and the path
//! was absent afterwards" and "never sealed" are both `after: None` and mean opposite things.
//!
//! ── JOURNAL: a transaction that outlives the process ─────────────────────────────────────────────
//!
//! The snapshots above are only half of a transaction. The other half — which step ran, in what
//! order, and whether the whole run finished — lived in the webview's `automation.js` journal, in
//! memory. That is enough to unwind a failure, and nothing at all if the app dies mid-run: the
//! partially-rewritten tree is left on disk, and the tokens that could put it back become the
//! orphans `list` reports without saying what they belong to.
//!
//! [`journal_open`] / [`journal_append`] / [`journal_close`] write that ordering to disk *before*
//! each step is taken, under `<base>/journals/<id>.json`, each write landing through a
//! sync-then-rename so a crash sees either the previous journal or the next one and never a torn
//! file. A journal with no `closed` outcome is a transaction that was interrupted;
//! [`journal_pending`] enumerates them at the next launch and [`journal_unwind`] compensates one,
//! newest step first, through the same sealed, conflict-refusing [`restore`].

use std::fs;
use std::io::Write;
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
    /// Fingerprint of the path AS THE VERB LEFT IT, filled in by [`seal`]. `None` means the path did
    /// not exist after the verb ran. Only meaningful when [`Manifest::sealed`] is true.
    #[serde(default)]
    pub after: Option<String>,
}

/// The manifest written to `<base>/<token>/manifest.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Manifest {
    pub entries: Vec<Entry>,
    /// True once [`seal`] has recorded every entry's post-verb fingerprint. Restoring a sealed
    /// manifest refuses any path the world has moved past; restoring an unsealed one writes blind.
    #[serde(default)]
    pub sealed: bool,
}

/// A path a sealed restore declined to overwrite, because it no longer holds what the verb left.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Conflict {
    /// The path that was NOT restored.
    pub path: String,
    /// Where the pre-image was parked instead, when there was one to park.
    pub parked: Option<String>,
    /// Why the restore was declined, in the user's terms.
    pub reason: String,
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
    /// Paths a sealed restore refused to touch because something outside the transaction changed
    /// them after the verb ran. Empty for an unsealed token, which cannot detect the case.
    #[serde(default)]
    pub conflicted: Vec<Conflict>,
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

/// Reject any id that could address something outside `base`. Ids are generated by [`new_token`],
/// never supplied by a script, but they arrive back over the bus as strings.
fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(format!("bad snapshot token: {id}"));
    }
    Ok(())
}

fn token_dir(base: &Path, token: &str) -> Result<PathBuf, String> {
    safe_id(token)?;
    Ok(base.join(token))
}

/// SHA-256, hex, of a file's bytes — or `None` when the path does not exist. Streamed, so a large
/// document costs one buffer rather than its own size in memory.
///
/// A directory answers `None` too: [`seal`] never fingerprints a directory entry, because
/// re-creating a directory is idempotent and cannot destroy anything, so there is nothing for a
/// conflict check to protect.
fn fingerprint(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.is_dir() {
        return None;
    }
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut f, &mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Write `bytes` to `path` so a crash sees either the whole previous file or the whole new one.
/// The temp file is flushed to the device BEFORE the rename, because a rename that lands ahead of
/// the data it points at is exactly the torn journal this is here to prevent.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("writing");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
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
            entries.push(Entry { path: abs, blob: None, dir: false, after: None });
            return Ok(());
        }
    };
    if meta.is_dir() {
        entries.push(Entry { path: abs, blob: None, dir: true, after: None });
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
    entries.push(Entry { path: abs, blob: Some(name), dir: false, after: None });
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
    let manifest = Manifest { entries, sealed: false };
    write_manifest(&dir, &manifest)?;
    Ok(token)
}

fn write_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("manifest.json"), &json)
}

/// Read a token's manifest.
pub fn manifest(base: &Path, token: &str) -> Result<Manifest, String> {
    let dir = token_dir(base, token)?;
    let raw = fs::read(dir.join("manifest.json"))
        .map_err(|e| format!("no such snapshot: {token} ({e})"))?;
    serde_json::from_slice(&raw).map_err(|e| e.to_string())
}

/// Record what the mutating verb LEFT at every recorded path, and mark the token sealed.
///
/// Called after the forward verb returns and before its result is handed to the caller, so the
/// fingerprints describe the verb's own output. From that moment the token's [`restore`] can tell
/// "still as the verb left it" from "something else has been here", and refuses the second case
/// instead of overwriting it.
///
/// Sealing twice re-reads the paths, which would record a THIRD party's content as the verb's own
/// and silently re-arm a clobbering restore — so an already-sealed token is refused.
pub fn seal(base: &Path, token: &str) -> Result<usize, String> {
    let dir = token_dir(base, token)?;
    let mut man = manifest(base, token)?;
    if man.sealed {
        return Err(format!("snapshot {token} is already sealed"));
    }
    let mut fingerprinted = 0usize;
    for e in man.entries.iter_mut() {
        if e.dir {
            continue;
        }
        e.after = fingerprint(Path::new(&e.path));
        if e.after.is_some() {
            fingerprinted += 1;
        }
    }
    man.sealed = true;
    write_manifest(&dir, &man)?;
    Ok(fingerprinted)
}

/// Put every recorded path back. Deepest paths first, so a directory that has to be removed is
/// emptied by its own children's entries before the directory entry is reached.
///
/// On a SEALED token every file entry is checked against the fingerprint [`seal`] took: a path that
/// no longer holds what the verb left is not written. Its pre-image is parked next to it as
/// `<name>.zmax-undo-<token>` and it is reported under [`RestoreReport::conflicted`], so the
/// compensation costs neither the third party's edit nor the transaction's pre-state. An unsealed
/// token has nothing to compare against and restores blind, as it always did.
pub fn restore(base: &Path, token: &str) -> Result<RestoreReport, String> {
    let dir = token_dir(base, token)?;
    let blobs = dir.join("blobs");
    let man = manifest(base, token)?;
    let sealed = man.sealed;
    let mut report = RestoreReport::default();

    let mut entries = man.entries;
    entries.sort_by_key(|e| std::cmp::Reverse(e.path.matches(std::path::MAIN_SEPARATOR).count()));

    for e in entries {
        let target = PathBuf::from(&e.path);
        // A sealed entry whose file no longer matches what the verb left belongs to someone else
        // now. Refuse it, and park the bytes we would have written so the choice stays the user's.
        if sealed && !e.dir {
            let now = fingerprint(&target);
            if now != e.after {
                report.conflicted.push(decline(&target, &e, &blobs, token));
                continue;
            }
        }
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

/// Decline to compensate one entry, and say what happened to the bytes.
///
/// When there IS a pre-image (the verb overwrote an existing file) it is written beside the target
/// as `<name>.zmax-undo-<token>` — beside it rather than into the snapshot store, because the store
/// is temporary and the user is going to want the file in front of them. When there is not (the
/// verb created the file and someone has since edited it) the compensation would have been a
/// delete, and refusing to delete is the whole answer.
fn decline(target: &Path, e: &Entry, blobs: &Path, token: &str) -> Conflict {
    let parked = e.blob.as_ref().and_then(|blob| {
        let mut name = target.file_name()?.to_string_lossy().into_owned();
        name.push_str(&format!(".zmax-undo-{token}"));
        let side = target.with_file_name(name);
        let bytes = fs::read(blobs.join(blob)).ok()?;
        fs::write(&side, bytes).ok()?;
        Some(side.to_string_lossy().into_owned())
    });
    let reason = if e.blob.is_some() {
        "changed outside this transaction after the step ran — the previous content was parked \
         instead of overwriting it"
    } else {
        "created by this transaction and edited since — refusing to delete a file that is no \
         longer what the step left"
    };
    Conflict { path: e.path.clone(), parked, reason: reason.to_string() }
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

// ── the journal ─────────────────────────────────────────────────────────────────────────────────

/// One executed step of a transaction: which verb ran, and the token that puts it back.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub verb: String,
    pub token: String,
}

/// A transaction's on-disk record. Written before the first step and rewritten after each one, so
/// what survives a crash is the list of steps that had definitely been *attempted*.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Journal {
    pub id: String,
    /// What the user was doing, for the recovery prompt — "Batch Plan: 12 steps", not an id.
    pub label: String,
    /// Wall clock at open, milliseconds since the epoch. Orders the recovery list.
    pub opened_ms: u128,
    pub steps: Vec<Step>,
    /// `None` while the transaction is in flight. `Some("committed")` / `Some("unwound")` once it
    /// reached an end — which is exactly what makes `None` mean "this one was interrupted".
    #[serde(default)]
    pub closed: Option<String>,
}

fn journals_dir(base: &Path) -> PathBuf {
    base.join("journals")
}

fn journal_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    safe_id(id)?;
    Ok(journals_dir(base).join(format!("{id}.json")))
}

/// Read one journal.
pub fn journal(base: &Path, id: &str) -> Result<Journal, String> {
    let raw = fs::read(journal_path(base, id)?).map_err(|e| format!("no such transaction: {id} ({e})"))?;
    serde_json::from_slice(&raw).map_err(|e| e.to_string())
}

fn put_journal(base: &Path, j: &Journal) -> Result<(), String> {
    let dir = journals_dir(base);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(j).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(format!("{}.json", j.id)), &json)
}

/// Start a transaction's on-disk record and return its id.
pub fn journal_open(base: &Path, label: &str) -> Result<String, String> {
    let j = Journal {
        id: new_token(),
        label: label.to_string(),
        opened_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        steps: Vec::new(),
        closed: None,
    };
    put_journal(base, &j)?;
    Ok(j.id)
}

/// Record that `verb` ran and that `token` compensates it.
///
/// Appending to a CLOSED journal is refused rather than reopening it: a step recorded after the
/// outcome would be unwound by a recovery pass that believes the transaction already ended, and the
/// tokens of a committed transaction have been released, so the record would point at nothing.
pub fn journal_append(base: &Path, id: &str, verb: &str, token: &str) -> Result<(), String> {
    safe_id(token)?;
    let mut j = journal(base, id)?;
    if let Some(outcome) = &j.closed {
        return Err(format!("transaction {id} is already {outcome}"));
    }
    j.steps.push(Step { verb: verb.to_string(), token: token.to_string() });
    put_journal(base, &j)
}

/// End a transaction and release its snapshots. `outcome` is `"committed"` (the run finished; the
/// files keep their new content) or `"unwound"` ([`journal_unwind`] has already compensated).
///
/// Both outcomes drop the tokens, because in both cases the pre-images have served their purpose —
/// but the pre-images a conflicted restore PARKED live beside the user's files, not in the store, so
/// nothing that was declined is lost here.
pub fn journal_close(base: &Path, id: &str, outcome: &str) -> Result<(), String> {
    if outcome != "committed" && outcome != "unwound" {
        return Err(format!("unknown transaction outcome: {outcome}"));
    }
    let mut j = journal(base, id)?;
    for s in &j.steps {
        let _ = discard(base, &s.token);
    }
    j.closed = Some(outcome.to_string());
    put_journal(base, &j)
}

/// Every transaction that was never closed, newest first — the ones the app died inside.
pub fn journal_pending(base: &Path) -> Result<Vec<Journal>, String> {
    let dir = journals_dir(base);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<Journal> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|raw| serde_json::from_slice::<Journal>(&raw).ok())
        .filter(|j| j.closed.is_none())
        .collect();
    out.sort_by(|a, b| b.opened_ms.cmp(&a.opened_ms));
    Ok(out)
}

/// What one journalled step's compensation did.
#[derive(Serialize, Debug)]
pub struct StepReport {
    pub verb: String,
    pub token: String,
    /// `None` when the token could not be restored at all (its snapshot is gone).
    pub report: Option<RestoreReport>,
    pub error: Option<String>,
}

/// The result of compensating an interrupted transaction.
#[derive(Serialize, Debug, Default)]
pub struct UnwindReport {
    pub id: String,
    pub label: String,
    pub steps: Vec<StepReport>,
    /// Paths written back, paths removed again, and paths a conflict declined — summed across steps,
    /// so the prompt can say "38 restored, 2 left alone" without walking the detail.
    pub restored: usize,
    pub removed: usize,
    pub conflicted: usize,
    pub failed: usize,
}

/// Compensate an interrupted transaction: every recorded step, newest first, through the same
/// conflict-refusing [`restore`], then close the journal as `"unwound"`.
///
/// Newest first for the same reason `txnAbort` unwinds in reverse: a later step may have rewritten
/// what an earlier one produced, so restoring forwards would put back a file the next restore is
/// about to overwrite with older content.
///
/// A step whose snapshot has vanished (the OS reclaimed the store between the crash and the
/// recovery) is reported and skipped — the rest of the transaction is still worth unwinding, and a
/// partial compensation the user can see beats an all-or-nothing refusal they cannot act on.
pub fn journal_unwind(base: &Path, id: &str) -> Result<UnwindReport, String> {
    let j = journal(base, id)?;
    if let Some(outcome) = &j.closed {
        return Err(format!("transaction {id} is already {outcome}"));
    }
    let mut out = UnwindReport { id: j.id.clone(), label: j.label.clone(), ..Default::default() };
    for s in j.steps.iter().rev() {
        match restore(base, &s.token) {
            Ok(r) => {
                out.restored += r.restored.len();
                out.removed += r.removed.len();
                out.conflicted += r.conflicted.len();
                out.failed += r.failed.len();
                out.steps.push(StepReport {
                    verb: s.verb.clone(),
                    token: s.token.clone(),
                    report: Some(r),
                    error: None,
                });
            }
            Err(e) => {
                out.failed += 1;
                out.steps.push(StepReport {
                    verb: s.verb.clone(),
                    token: s.token.clone(),
                    report: None,
                    error: Some(e),
                });
            }
        }
    }
    journal_close(base, id, "unwound")?;
    Ok(out)
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

/// Record what the verb left, so this token's compensation can refuse a file the world moved past.
/// Returns how many paths were fingerprinted.
#[tauri::command]
pub fn txn_seal(token: String) -> Result<usize, String> {
    seal(&default_base(), &token)
}

/// Open a transaction's on-disk record; the id rides with every subsequent step.
#[tauri::command]
pub fn txn_open(label: String) -> Result<String, String> {
    journal_open(&default_base(), &label)
}

/// Record one executed step against an open transaction.
#[tauri::command]
pub fn txn_append(id: String, verb: String, token: String) -> Result<(), String> {
    journal_append(&default_base(), &id, &verb, &token)
}

/// End a transaction — `"committed"` or `"unwound"` — and release its snapshots.
#[tauri::command]
pub fn txn_close(id: String, outcome: String) -> Result<(), String> {
    journal_close(&default_base(), &id, &outcome)
}

/// Transactions that were never closed: what the app was in the middle of when it died.
#[tauri::command]
pub fn txn_pending() -> Result<Vec<Journal>, String> {
    journal_pending(&default_base())
}

/// Compensate an interrupted transaction, newest step first.
#[tauri::command]
pub fn txn_unwind(id: String) -> Result<UnwindReport, String> {
    journal_unwind(&default_base(), &id)
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

    // ── sealing: the compensation that refuses ──────────────────────────────────────────────────

    /// The whole point of sealing. A verb rewrites a file; the user (or a formatter, or another
    /// instance) then edits it; the transaction aborts. A blind restore silently destroys that
    /// edit. A sealed one must not — and must not lose the pre-state either.
    #[test]
    fn a_sealed_restore_refuses_a_file_someone_else_changed_and_parks_the_pre_image() {
        let base = temp_base("seal-conflict");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"original\n").unwrap();

        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"what the verb wrote\n").unwrap();
        seal(&base, &token).unwrap();
        // Someone outside the transaction edits the same file afterwards.
        fs::write(&f, b"what the USER wrote afterwards\n").unwrap();

        let report = restore(&base, &token).unwrap();
        assert_eq!(
            fs::read(&f).unwrap(),
            b"what the USER wrote afterwards\n",
            "a sealed restore must not overwrite an edit made after the step ran"
        );
        assert!(report.restored.is_empty(), "nothing may be reported as restored");
        assert_eq!(report.conflicted.len(), 1, "the refusal must be reported: {report:?}");
        let parked = report.conflicted[0].parked.clone().expect("the pre-image must be parked");
        assert_eq!(
            fs::read(&parked).unwrap(),
            b"original\n",
            "the parked file must hold the pre-state, so nothing is lost either way"
        );
    }

    /// The other half of the same rule: when the file IS still what the verb left, a sealed restore
    /// behaves exactly like an unsealed one. A conflict check that refused everything would be
    /// indistinguishable from a broken undo.
    #[test]
    fn a_sealed_restore_still_compensates_an_untouched_file() {
        let base = temp_base("seal-clean");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"before\n").unwrap();

        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"after\n").unwrap();
        seal(&base, &token).unwrap();

        let report = restore(&base, &token).unwrap();
        assert!(report.conflicted.is_empty(), "an untouched file must not conflict: {report:?}");
        assert_eq!(fs::read(&f).unwrap(), b"before\n");
    }

    /// A file the verb CREATED, then someone edited: the compensation would be a delete, and there
    /// is no pre-image to park. Deleting it would destroy the only copy of their work.
    #[test]
    fn a_sealed_restore_refuses_to_delete_a_created_file_that_was_edited_since() {
        let base = temp_base("seal-created");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("new.txt");

        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"the verb created me\n").unwrap();
        seal(&base, &token).unwrap();
        fs::write(&f, b"and then I was edited\n").unwrap();

        let report = restore(&base, &token).unwrap();
        assert!(f.exists(), "a created-then-edited file must survive the compensation");
        assert_eq!(report.conflicted.len(), 1, "the refusal must be reported: {report:?}");
        assert!(report.conflicted[0].parked.is_none(), "there was no pre-image to park");
        assert!(report.removed.is_empty());
    }

    /// Sealing twice would record a third party's content as the verb's own output, which re-arms
    /// exactly the clobbering restore the seal exists to prevent.
    #[test]
    fn a_token_cannot_be_sealed_twice() {
        let base = temp_base("seal-twice");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"x\n").unwrap();
        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        seal(&base, &token).unwrap();
        assert!(seal(&base, &token).is_err(), "re-sealing must be refused");
    }

    // ── the journal: a transaction that outlives the process ────────────────────────────────────

    /// The capability in one test: a multi-step run is journalled to disk step by step; the process
    /// "dies" (nothing closes the journal); a later pass finds it and unwinds every step that
    /// landed, newest first, leaving the tree exactly as it was before the run.
    #[test]
    fn an_interrupted_transaction_is_found_and_unwound_at_the_next_launch() {
        let base = temp_base("journal-crash");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let a = work.join("a.txt");
        let b = work.join("b.txt");
        fs::write(&a, b"a-before\n").unwrap();
        fs::write(&b, b"b-before\n").unwrap();

        let id = journal_open(&base, "Batch Plan: 3 steps").unwrap();
        for (path, after) in [(&a, "a-after\n"), (&b, "b-after\n")] {
            let token = snapshot(&base, &[path.to_string_lossy().into_owned()]).unwrap();
            fs::write(path, after.as_bytes()).unwrap();
            seal(&base, &token).unwrap();
            journal_append(&base, &id, "zmax.cleanup.apply", &token).unwrap();
        }
        // …and here the app dies. Nothing calls journal_close.

        let pending = journal_pending(&base).unwrap();
        assert_eq!(pending.len(), 1, "the interrupted transaction must be visible");
        assert_eq!(pending[0].label, "Batch Plan: 3 steps", "the prompt needs the user's own words");
        assert_eq!(pending[0].steps.len(), 2, "both landed steps must be on record");

        let report = journal_unwind(&base, &id).unwrap();
        assert_eq!(report.restored, 2, "both files must come back: {report:?}");
        assert_eq!(report.conflicted, 0);
        assert_eq!(fs::read(&a).unwrap(), b"a-before\n");
        assert_eq!(fs::read(&b).unwrap(), b"b-before\n");
        assert!(journal_pending(&base).unwrap().is_empty(), "an unwound transaction is not pending");
    }

    /// Reverse order is load-bearing, not cosmetic: two steps over the SAME file only restore to
    /// the true pre-state if the newest is undone first.
    #[test]
    fn unwind_replays_steps_newest_first() {
        let base = temp_base("journal-order");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"v0\n").unwrap();
        let p = f.to_string_lossy().into_owned();

        let id = journal_open(&base, "two steps, one file").unwrap();
        for v in ["v1\n", "v2\n"] {
            let token = snapshot(&base, &[p.clone()]).unwrap();
            fs::write(&f, v.as_bytes()).unwrap();
            seal(&base, &token).unwrap();
            journal_append(&base, &id, "zmax.sort.apply", &token).unwrap();
        }

        journal_unwind(&base, &id).unwrap();
        assert_eq!(
            fs::read(&f).unwrap(),
            b"v0\n",
            "unwinding forwards would leave v1 — the second step's pre-state, not the run's"
        );
    }

    /// A committed transaction is not a recovery candidate, and its snapshots are released — a
    /// journal that stayed pending after a clean run would prompt the user to undo work they kept.
    #[test]
    fn a_committed_transaction_is_not_pending_and_frees_its_snapshots() {
        let base = temp_base("journal-commit");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"x\n").unwrap();

        let id = journal_open(&base, "clean run").unwrap();
        let token = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        journal_append(&base, &id, "zmax.sort.apply", &token).unwrap();
        journal_close(&base, &id, "committed").unwrap();

        assert!(journal_pending(&base).unwrap().is_empty(), "a committed run must not prompt");
        assert!(!list(&base).unwrap().contains(&token), "its snapshot must be released");
        assert!(journal_unwind(&base, &id).is_err(), "a closed transaction cannot be unwound");
    }

    /// A step recorded after the outcome would be unwound by a recovery pass that believes the run
    /// already ended — and its token has already been released, so the record points at nothing.
    #[test]
    fn a_closed_transaction_refuses_further_steps() {
        let base = temp_base("journal-closed");
        let id = journal_open(&base, "done").unwrap();
        journal_close(&base, &id, "committed").unwrap();
        assert!(journal_append(&base, &id, "zmax.sort.apply", "tok").is_err());
        assert!(journal_close(&base, &id, "sideways").is_err(), "only known outcomes are accepted");
    }

    /// Recovery runs against a store the OS may have reclaimed since the crash. A missing snapshot
    /// must cost that one step, not the whole unwind.
    #[test]
    fn unwind_survives_a_step_whose_snapshot_is_gone() {
        let base = temp_base("journal-gone");
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let f = work.join("a.txt");
        fs::write(&f, b"before\n").unwrap();

        let id = journal_open(&base, "one good, one lost").unwrap();
        let lost = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        journal_append(&base, &id, "zmax.sort.apply", &lost).unwrap();
        let good = snapshot(&base, &[f.to_string_lossy().into_owned()]).unwrap();
        fs::write(&f, b"after\n").unwrap();
        seal(&base, &good).unwrap();
        journal_append(&base, &id, "zmax.cleanup.apply", &good).unwrap();
        discard(&base, &lost).unwrap();

        let report = journal_unwind(&base, &id).unwrap();
        assert_eq!(report.failed, 1, "the lost step must be reported: {report:?}");
        assert_eq!(report.restored, 1, "the surviving step must still be compensated");
        assert_eq!(fs::read(&f).unwrap(), b"before\n");
    }

    /// The journal store shares a base with the snapshot store, so an id that could address a
    /// sibling path would let a bus caller read or overwrite another token's manifest.
    #[test]
    fn a_journal_id_cannot_escape_the_base_directory() {
        let base = temp_base("journal-escape");
        for bad in ["../evil", "a/b", "", ".."] {
            assert!(journal_path(&base, bad).is_err(), "id {bad:?} must be rejected");
        }
        // A journal directory must not read as a snapshot token, or `list` would offer it to
        // `restore`, which would fail on a manifest that is not one.
        journal_open(&base, "x").unwrap();
        assert!(!list(&base).unwrap().contains(&"journals".to_string()));
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
