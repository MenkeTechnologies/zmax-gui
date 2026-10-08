//! Worktrees — `magit-worktree`: more than one checkout of the same repository, each in its own
//! directory, sharing one object store. Check out a branch for a review or a hotfix without
//! stashing the work in progress.
//!
//! * **List** every worktree with its HEAD, its branch (or detached), and git's `locked` /
//!   `prunable` flags with their reasons.
//! * **Add** one at a path: on an existing branch, on a new branch (`-b`, optionally from a
//!   revision), or detached at a revision.
//! * **Remove** one. Without `force`, git refuses a worktree with modified or untracked files, which
//!   is what makes remove a safe inverse for add: it can only take away a checkout nobody has
//!   written into. The main worktree is never removable.
//! * **Prune** the administrative records of worktrees whose directory was deleted by hand.
//!
//! Every name, revision and path is flag-guarded; paths are passed after `--` where git accepts it.

use crate::git_ext::{git_in, valid_ref};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Worktree {
    pub path: String,
    /// The checked-out commit (empty for a bare repository's entry).
    pub head: String,
    /// The checked-out branch, short name; `None` when detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    /// The first entry git lists: the repository's own working tree.
    pub main: bool,
    /// `Some(reason)` when locked (the reason may be empty).
    pub locked: Option<String>,
    /// `Some(reason)` when git would prune it (its directory is gone).
    pub prunable: Option<String>,
}

/// Parse `git worktree list --porcelain`: one block per worktree, blank-line separated, each line
/// `<attr>[ <value>]`. Pure — unit tested.
fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut list: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let (attr, value) = line.split_once(' ').unwrap_or((line, ""));
        if attr == "worktree" {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree {
                path: value.to_string(),
                main: list.is_empty(),
                ..Default::default()
            });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        match attr {
            "HEAD" => w.head = value.to_string(),
            "branch" => {
                w.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                )
            }
            "detached" => w.detached = true,
            "bare" => w.bare = true,
            "locked" => w.locked = Some(value.to_string()),
            "prunable" => w.prunable = Some(value.to_string()),
            _ => {}
        }
    }
    list
}

/// Every worktree of the repository at `root`, the main one first.
#[tauri::command]
pub fn git_worktrees(root: String) -> Result<Vec<Worktree>, String> {
    Ok(parse_worktrees(&git_in(
        &root,
        &["worktree", "list", "--porcelain"],
    )?))
}

/// `path` resolved against `root` when relative.
fn resolve(root: &str, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(root).join(p)
    }
}

/// Two spellings of one directory (`/tmp` vs `/private/tmp`, a trailing `..`) compare equal.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn find(root: &str, path: &Path) -> Result<Worktree, String> {
    git_worktrees(root.to_string())?
        .into_iter()
        .find(|w| same_dir(Path::new(&w.path), path))
        .ok_or_else(|| format!("{} is not a worktree of this repository", path.display()))
}

/// The `git worktree add` argument list. Pure — unit tested.
fn add_args(
    path: &str,
    branch: Option<&str>,
    new_branch: bool,
    rev: Option<&str>,
) -> Result<Vec<String>, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("no worktree path".into());
    }
    let branch = branch.map(str::trim).filter(|b| !b.is_empty());
    let rev = rev.map(str::trim).filter(|r| !r.is_empty());
    if branch.is_some_and(|b| !valid_ref(b)) {
        return Err("invalid branch name".into());
    }
    if rev.is_some_and(|r| !valid_ref(r)) {
        return Err("invalid revision".into());
    }
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    match (branch, new_branch) {
        (Some(b), true) => args.extend(["-b".to_string(), b.to_string()]),
        (Some(_), false) if rev.is_some() => {
            return Err("an existing branch is checked out at its own tip — no revision".into())
        }
        (Some(_), false) => {}
        (None, true) => return Err("name the new branch".into()),
        (None, false) => args.push("--detach".into()),
    }
    // `--` ends the options: a path that starts with `-` is still a path.
    args.push("--".into());
    args.push(path.to_string());
    match (branch, new_branch) {
        (Some(b), false) => args.push(b.to_string()),
        _ => args.extend(rev.map(str::to_string)),
    }
    Ok(args)
}

/// Add a worktree at `path` (relative to `root` or absolute): on `branch` (created from `rev`, or
/// HEAD, when `new_branch`), or detached at `rev` (HEAD) when no branch is named. Returns it.
#[tauri::command]
pub fn git_worktree_add(
    root: String,
    path: String,
    branch: Option<String>,
    new_branch: Option<bool>,
    rev: Option<String>,
) -> Result<Worktree, String> {
    let target = resolve(&root, path.trim());
    let target_s = target.to_string_lossy().into_owned();
    let args = add_args(
        &target_s,
        branch.as_deref(),
        new_branch.unwrap_or(false),
        rev.as_deref(),
    )?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git_in(&root, &refs)?;
    find(&root, &target)
}

/// Remove the worktree at `path`. Without `force`, git refuses one with modified or untracked
/// files, and a locked one; the main worktree is refused here outright.
#[tauri::command]
pub fn git_worktree_remove(root: String, path: String, force: Option<bool>) -> Result<(), String> {
    let target = resolve(&root, path.trim());
    let w = find(&root, &target)?;
    if w.main {
        return Err("the main worktree cannot be removed".into());
    }
    let mut args = vec!["worktree", "remove"];
    if force.unwrap_or(false) {
        args.push("--force");
    }
    args.push("--");
    args.push(&w.path);
    git_in(&root, &args).map(|_| ())
}

/// Prune the records of worktrees whose directory is gone. Returns the paths pruned.
#[tauri::command]
pub fn git_worktree_prune(root: String) -> Result<Vec<String>, String> {
    let before: Vec<String> = git_worktrees(root.clone())?
        .into_iter()
        .filter(|w| w.prunable.is_some())
        .map(|w| w.path)
        .collect();
    git_in(&root, &["worktree", "prune"])?;
    let after = git_worktrees(root)?;
    Ok(before
        .into_iter()
        .filter(|p| !after.iter().any(|w| &w.path == p))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_blocks() {
        let out = "worktree /r\nHEAD aaaa\nbranch refs/heads/main\n\n\
                   worktree /r-wt\nHEAD bbbb\ndetached\nlocked usb disk\n\n\
                   worktree /gone\nHEAD cccc\nbranch refs/heads/feat/x\nlocked\nprunable gitdir file points to non-existent location\n";
        let w = parse_worktrees(out);
        assert_eq!(w.len(), 3, "the last block has no trailing blank line");
        assert!(w[0].main && !w[1].main);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert!(w[1].detached && w[1].branch.is_none());
        assert_eq!(w[1].locked.as_deref(), Some("usb disk"));
        assert_eq!(
            w[2].branch.as_deref(),
            Some("feat/x"),
            "only the refs/heads/ prefix is stripped"
        );
        assert_eq!(
            w[2].locked.as_deref(),
            Some(""),
            "locked without a reason is still locked"
        );
        assert!(w[2].prunable.as_deref().unwrap().starts_with("gitdir"));
    }

    #[test]
    fn add_args_by_shape() {
        assert_eq!(
            add_args("/w", None, false, None).unwrap(),
            ["worktree", "add", "--detach", "--", "/w"]
        );
        assert_eq!(
            add_args("/w", Some("hot"), true, Some("v1")).unwrap(),
            ["worktree", "add", "-b", "hot", "--", "/w", "v1"]
        );
        assert_eq!(
            add_args("-w", Some("dev"), false, None).unwrap(),
            ["worktree", "add", "--", "-w", "dev"]
        );
        assert!(add_args("/w", Some("dev"), false, Some("v1")).is_err());
        assert!(add_args("/w", None, true, None).is_err());
        assert!(add_args("/w", Some("-f"), true, None).is_err());
        assert!(add_args("/w", None, false, Some("--orphan")).is_err());
        assert!(add_args(" ", None, false, None).is_err());
    }

    // Add on a new branch, refuse to remove it once it holds work, force-remove it, and prune a
    // worktree whose directory was deleted behind git's back.
    #[test]
    fn add_remove_prune_round_trip() {
        let base = std::env::temp_dir().join(format!(
            "zmax-gui-wt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let root = repo.to_string_lossy().into_owned();
        if git_in(&root, &["init", "-q", "-b", "main"]).is_err() {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        for (k, v) in [
            ("user.email", "t@t"),
            ("user.name", "t"),
            ("commit.gpgSign", "false"),
        ] {
            git_in(&root, &["config", k, v]).unwrap();
        }
        std::fs::write(repo.join("f"), "1\n").unwrap();
        git_in(&root, &["add", "f"]).unwrap();
        git_in(&root, &["commit", "-q", "-m", "one"]).unwrap();

        let hot = git_worktree_add(
            root.clone(),
            "../hot".into(),
            Some("hotfix".into()),
            Some(true),
            None,
        )
        .unwrap();
        assert_eq!(hot.branch.as_deref(), Some("hotfix"));
        assert!(!hot.main);
        assert!(base.join("hot").join("f").exists());
        assert!(
            git_worktree_add(
                root.clone(),
                "../hot2".into(),
                Some("main".into()),
                None,
                None
            )
            .is_err(),
            "git refuses a branch already checked out elsewhere"
        );
        let det = git_worktree_add(
            root.clone(),
            base.join("det").to_string_lossy().into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(det.detached);
        assert_eq!(git_worktrees(root.clone()).unwrap().len(), 3);

        // Work lands in the new checkout: a plain remove refuses, a forced one goes through.
        std::fs::write(base.join("hot").join("new.txt"), "x\n").unwrap();
        assert!(git_worktree_remove(root.clone(), "../hot".into(), None).is_err());
        assert!(
            base.join("hot").join("new.txt").exists(),
            "a refused remove must not delete anything"
        );
        git_worktree_remove(root.clone(), "../hot".into(), Some(true)).unwrap();
        assert!(!base.join("hot").exists());
        assert!(git_worktree_remove(root.clone(), root.clone(), Some(true))
            .unwrap_err()
            .contains("main"));

        // The detached one's directory vanishes by hand: prune reports exactly it.
        std::fs::remove_dir_all(base.join("det")).unwrap();
        let pruned = git_worktree_prune(root.clone()).unwrap();
        assert_eq!(pruned.len(), 1);
        assert!(pruned[0].ends_with("det"), "{pruned:?}");
        assert_eq!(git_worktrees(root.clone()).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }
}
