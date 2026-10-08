//! Applying commits — `magit-cherry-pick` / `magit-revert` and the in-progress-operation controls
//! Magit shows while one of them (or a merge / rebase) stops on a conflict:
//!
//! * **Cherry-pick** a commit onto the current branch (optionally recording `(cherry picked from
//!   commit …)` with `-x`, or staging the change without committing).
//! * **Revert** a commit — a new commit that undoes it (or the undo left staged with `--no-commit`).
//! * **Operation state** — which operation is stopped mid-way (`cherry-pick`, `revert`, `merge`,
//!   `rebase`) and the paths still unmerged; **abort** it, or **continue** it once every conflict is
//!   resolved and staged.
//!
//! A stop on conflicts is a *result*, not an error: the command returns `stopped: true` with the
//! conflicted paths, which is what the Merge Conflicts panel (`conflicts.rs`) then resolves. git is
//! never allowed to open an editor here — every run sets `GIT_EDITOR=true` and the commands that
//! would prompt for a message take `--no-edit` — because the host has no terminal for it and a
//! blocked `git` would hang the command forever.

use crate::git_ext::valid_ref;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// `git -C <dir> <args…>` with the editor disabled. Ok(stdout) on success, Err(stderr) otherwise.
fn git_noedit(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ── operation state ────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct OpState {
    /// `cherry-pick`, `revert`, `merge`, `rebase`, or `None` when nothing is in progress.
    pub op: Option<String>,
    /// Paths git still records as unmerged (`git diff --name-only --diff-filter=U`).
    pub unmerged: Vec<String>,
}

/// Resolve a `git rev-parse --git-path` answer (relative to `root` unless absolute).
fn git_path(root: &str, name: &str) -> Option<std::path::PathBuf> {
    let p = git_noedit(root, &["rev-parse", "--git-path", name]).ok()?;
    let p = Path::new(p.trim());
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(root).join(p)
    })
}

/// Which operation is stopped. A pseudo-ref (`CHERRY_PICK_HEAD`, …) marks the first three; a
/// rebase is a state directory. Checked rebase-first: a rebase replays its commits through the
/// sequencer, so while one is stopped its state directory is the authority whatever pseudo-refs the
/// stopped step left, and the right abort is the rebase's.
pub(crate) fn current_op(root: &str) -> Option<&'static str> {
    if ["rebase-merge", "rebase-apply"]
        .iter()
        .any(|d| git_path(root, d).is_some_and(|p| p.is_dir()))
    {
        return Some("rebase");
    }
    [
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("MERGE_HEAD", "merge"),
    ]
    .into_iter()
    .find(|(head, _)| git_noedit(root, &["rev-parse", "--verify", "-q", head]).is_ok())
    .map(|(_, op)| op)
}

pub(crate) fn unmerged(root: &str) -> Vec<String> {
    git_noedit(root, &["diff", "--name-only", "--diff-filter=U"])
        .map(|s| {
            s.lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The stopped operation (if any) and the paths still unmerged.
#[tauri::command]
pub fn git_op_state(root: String) -> Result<OpState, String> {
    git_noedit(&root, &["rev-parse", "--git-dir"])?;
    Ok(OpState {
        op: current_op(&root).map(str::to_string),
        unmerged: unmerged(&root),
    })
}

/// Abort the stopped operation, restoring the pre-operation branch and index.
#[tauri::command]
pub fn git_op_abort(root: String) -> Result<(), String> {
    let op = current_op(&root).ok_or("no cherry-pick, revert, merge or rebase in progress")?;
    git_noedit(&root, &[op, "--abort"]).map(|_| ())
}

/// Continue the stopped operation. Refused while any path is still unmerged — git's own refusal
/// for that is a multi-line hint; this names the files.
#[tauri::command]
pub fn git_op_continue(root: String) -> Result<OpState, String> {
    let op = current_op(&root).ok_or("no cherry-pick, revert, merge or rebase in progress")?;
    let left = unmerged(&root);
    if !left.is_empty() {
        return Err(format!("still unmerged: {}", left.join(", ")));
    }
    git_noedit(&root, &[op, "--continue"])?;
    git_op_state(root)
}

// ── cherry-pick / revert ───────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct PickResult {
    /// True when git stopped on conflicts; `unmerged` lists them and `op` names what to continue.
    pub stopped: bool,
    pub op: Option<String>,
    pub unmerged: Vec<String>,
    /// The new tip when a commit was made (not with `no_commit`, not when stopped).
    pub hash: Option<String>,
    pub subject: Option<String>,
}

/// The argument list for a cherry-pick or revert. Pure — unit tested.
fn pick_args(
    kind: &str,
    rev: &str,
    no_commit: bool,
    record_origin: bool,
) -> Result<Vec<String>, String> {
    if !valid_ref(rev) {
        return Err("invalid revision".into());
    }
    let mut args = vec![kind.to_string()];
    if no_commit {
        args.push("--no-commit".into());
    } else if kind == "revert" {
        // Without it, revert opens an editor for the message.
        args.push("--no-edit".into());
    }
    if record_origin && kind == "cherry-pick" && !no_commit {
        args.push("-x".into());
    }
    args.push(rev.to_string());
    Ok(args)
}

fn run_pick(root: &str, args: Vec<String>, no_commit: bool) -> Result<PickResult, String> {
    let before = git_noedit(root, &["rev-parse", "-q", "--verify", "HEAD"]).ok();
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Err(err) = git_noedit(root, &refs) {
        // A conflict stop leaves the operation in progress with unmerged paths; anything else
        // (dirty tree, bad revision, a merge commit without -m) is a real failure.
        let left = unmerged(root);
        let op = current_op(root);
        if op.is_some() && !left.is_empty() {
            return Ok(PickResult {
                stopped: true,
                op: op.map(str::to_string),
                unmerged: left,
                hash: None,
                subject: None,
            });
        }
        return Err(err);
    }
    let after = git_noedit(root, &["rev-parse", "HEAD"])?.trim().to_string();
    let committed = !no_commit && before.as_deref().map(str::trim) != Some(after.as_str());
    let subject = if committed {
        Some(
            git_noedit(root, &["log", "-1", "--format=%s"])?
                .trim()
                .to_string(),
        )
    } else {
        None
    };
    Ok(PickResult {
        stopped: false,
        op: None,
        unmerged: Vec::new(),
        hash: committed.then_some(after),
        subject,
    })
}

/// Apply the change a commit introduced onto the current branch.
#[tauri::command]
pub fn git_cherry_pick(
    root: String,
    rev: String,
    no_commit: Option<bool>,
    record_origin: Option<bool>,
) -> Result<PickResult, String> {
    let nc = no_commit.unwrap_or(false);
    let args = pick_args(
        "cherry-pick",
        rev.trim(),
        nc,
        record_origin.unwrap_or(false),
    )?;
    run_pick(&root, args, nc)
}

/// Undo the change a commit introduced, as a new commit (or staged, with `no_commit`).
#[tauri::command]
pub fn git_revert(
    root: String,
    rev: String,
    no_commit: Option<bool>,
) -> Result<PickResult, String> {
    let nc = no_commit.unwrap_or(false);
    let args = pick_args("revert", rev.trim(), nc, false)?;
    run_pick(&root, args, nc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ext::git_in;

    #[test]
    fn pick_args_by_kind() {
        assert_eq!(
            pick_args("revert", "abc", false, false).unwrap(),
            vec!["revert", "--no-edit", "abc"]
        );
        assert_eq!(
            pick_args("revert", "abc", true, false).unwrap(),
            vec!["revert", "--no-commit", "abc"]
        );
        assert_eq!(
            pick_args("cherry-pick", "abc", false, true).unwrap(),
            vec!["cherry-pick", "-x", "abc"]
        );
        // -x only annotates a commit that is made.
        assert_eq!(
            pick_args("cherry-pick", "abc", true, true).unwrap(),
            vec!["cherry-pick", "--no-commit", "abc"]
        );
        assert!(pick_args("cherry-pick", "--continue", false, false).is_err());
        assert!(pick_args("revert", "", false, false).is_err());
    }

    fn temp_repo() -> Option<(std::path::PathBuf, String)> {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-gitpick-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        if git_in(&root, &["init", "-q", "-b", "main"]).is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
        for (k, v) in [
            ("user.email", "t@t"),
            ("user.name", "t"),
            ("commit.gpgSign", "false"),
        ] {
            git_in(&root, &["config", k, v]).unwrap();
        }
        Some((dir, root))
    }

    fn commit(root: &str, dir: &Path, file: &str, body: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), body).unwrap();
        git_in(root, &["add", file]).unwrap();
        git_in(root, &["commit", "-q", "-m", msg]).unwrap();
        git_in(root, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string()
    }

    #[test]
    fn cherry_pick_and_revert_commit_cleanly() {
        let Some((dir, root)) = temp_repo() else {
            return;
        };
        commit(&root, &dir, "a.txt", "a\n", "base");
        git_in(&root, &["checkout", "-q", "-b", "topic"]).unwrap();
        let topic = commit(&root, &dir, "b.txt", "b\n", "add b");
        git_in(&root, &["checkout", "-q", "main"]).unwrap();

        let r = git_cherry_pick(root.clone(), topic.clone(), None, Some(true)).unwrap();
        assert!(!r.stopped);
        assert_eq!(r.subject.as_deref(), Some("add b"));
        let body = git_in(&root, &["log", "-1", "--format=%B"]).unwrap();
        assert!(
            body.contains(&format!("(cherry picked from commit {topic})")),
            "{body}"
        );
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "b\n");

        let rv = git_revert(root.clone(), "HEAD".into(), None).unwrap();
        assert!(rv.subject.unwrap().starts_with("Revert \"add b\""));
        assert!(
            !dir.join("b.txt").exists(),
            "the revert must undo the picked file"
        );

        // --no-commit stages the change and makes no commit.
        let tip = git_in(&root, &["rev-parse", "HEAD"]).unwrap();
        let nc = git_cherry_pick(root.clone(), topic, Some(true), None).unwrap();
        assert!(nc.hash.is_none());
        assert_eq!(git_in(&root, &["rev-parse", "HEAD"]).unwrap(), tip);
        assert_eq!(
            git_in(&root, &["diff", "--cached", "--name-only"])
                .unwrap()
                .trim(),
            "b.txt"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A conflicting pick stops with the conflicted path, the state names it, continue is refused
    // until the path is resolved and staged, and abort restores the branch.
    #[test]
    fn conflict_stops_then_continue_or_abort() {
        let Some((dir, root)) = temp_repo() else {
            return;
        };
        commit(&root, &dir, "f.txt", "one\n", "base");
        git_in(&root, &["checkout", "-q", "-b", "topic"]).unwrap();
        let theirs = commit(&root, &dir, "f.txt", "topic\n", "topic edit");
        git_in(&root, &["checkout", "-q", "main"]).unwrap();
        let main_tip = commit(&root, &dir, "f.txt", "main\n", "main edit");

        assert_eq!(
            git_op_state(root.clone()).unwrap(),
            OpState {
                op: None,
                unmerged: vec![]
            }
        );
        assert!(git_op_abort(root.clone()).is_err(), "nothing to abort");

        let r = git_cherry_pick(root.clone(), theirs.clone(), None, None).unwrap();
        assert!(r.stopped);
        assert_eq!(r.op.as_deref(), Some("cherry-pick"));
        assert_eq!(r.unmerged, vec!["f.txt"]);
        let st = git_op_state(root.clone()).unwrap();
        assert_eq!(st.op.as_deref(), Some("cherry-pick"));
        assert!(git_op_continue(root.clone()).unwrap_err().contains("f.txt"));

        git_op_abort(root.clone()).unwrap();
        assert_eq!(git_op_state(root.clone()).unwrap().op, None);
        assert_eq!(
            git_in(&root, &["rev-parse", "HEAD"]).unwrap().trim(),
            main_tip
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap(),
            "main\n"
        );

        // Again, then resolve + stage + continue: the pick lands as a commit with no editor.
        git_cherry_pick(root.clone(), theirs, None, None).unwrap();
        std::fs::write(dir.join("f.txt"), "merged\n").unwrap();
        git_in(&root, &["add", "f.txt"]).unwrap();
        let done = git_op_continue(root.clone()).unwrap();
        assert_eq!(
            done,
            OpState {
                op: None,
                unmerged: vec![]
            }
        );
        assert_eq!(
            git_in(&root, &["log", "-1", "--format=%s"]).unwrap().trim(),
            "topic edit"
        );

        // A revert that conflicts reports `revert`.
        let base_edit = commit(&root, &dir, "f.txt", "x\n", "x");
        commit(&root, &dir, "f.txt", "y\n", "y");
        let rv = git_revert(root.clone(), base_edit, None).unwrap();
        assert!(rv.stopped);
        assert_eq!(rv.op.as_deref(), Some("revert"));
        git_op_abort(root.clone()).unwrap();

        // A failure that is not a conflict stop is an error, not a stop.
        assert!(git_cherry_pick(root.clone(), "no-such-rev".into(), None, None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
