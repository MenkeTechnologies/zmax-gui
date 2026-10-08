//! Remotes and the network half of git — the Magit sections and transients beside the local-only
//! history in `git_more.rs` / `git_history.rs`:
//!
//! * **Remotes** (`magit-remote`) — every remote with its fetch and push URL; **add** one, and
//!   **remove** one. The removal takes an optional expected URL so the add's inverse can refuse to
//!   drop a remote that has been re-pointed since it was added.
//! * **Upstream status** (Magit's status header + its *Unpushed to* / *Unpulled from* sections) —
//!   the current branch, its upstream, how far ahead / behind it is, and the commits on each side.
//! * **Fetch** (`magit-fetch`) — one remote or all of them, optionally pruning deleted branches.
//! * **Pull** (`magit-pull`) — fast-forward only, rebase, or merge. A pull that stops on conflicts
//!   is a *result* (`stopped: true` with the unmerged paths), the same contract as cherry-pick in
//!   `git_pick.rs`, so the Merge Conflicts panel takes over.
//! * **Push** (`magit-push`) — to the upstream, or to a named remote (optionally setting it as the
//!   upstream), with `--force-with-lease` as the only force on offer: a plain `--force` would
//!   overwrite commits it has never seen.
//!
//! The network commands run with `GIT_TERMINAL_PROMPT=0` and the editor disabled: the host has no
//! terminal, so a credential prompt or a merge-message editor would block the command forever.
//! Failing with git's own "could not read Username" is the right outcome there.

use crate::git_ext::{git_in, valid_ref};
use crate::git_more::{parse_repo_log, RepoCommit};
use crate::git_pick::{current_op, unmerged};
use serde::Serialize;
use std::process::Command;

/// `git -C <dir> <args…>` with no credential prompt and no editor. Ok(stdout + stderr) on success
/// (fetch / push report what they did on stderr), Err(stderr) otherwise.
fn git_net(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let err = stderr.trim();
        return Err(if err.is_empty() {
            stdout.trim().to_string()
        } else {
            err.to_string()
        });
    }
    Ok(format!("{}{}", stdout, stderr).trim().to_string())
}

/// A URL (or local path) for `git remote add`: non-empty, no leading `-`, no whitespace / control
/// characters. Positional args already rule out shell injection; this rules out a value git would
/// read as an option.
fn valid_url(url: &str) -> bool {
    !url.is_empty()
        && !url.starts_with('-')
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

// ── remotes ────────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    /// The push URL — the fetch URL unless `remote.<name>.pushurl` says otherwise.
    pub push_url: String,
}

/// Parse `git remote -v` (`name\turl (fetch|push)` per line) into one entry per remote, in the
/// order git lists them. A remote with no `(push)` line pushes to its fetch URL. Pure — unit tested.
fn parse_remotes(out: &str) -> Vec<Remote> {
    let mut remotes: Vec<Remote> = Vec::new();
    for line in out.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let Some((url, kind)) = rest.rsplit_once(' ') else {
            continue;
        };
        let idx = match remotes.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                remotes.push(Remote {
                    name: name.to_string(),
                    fetch_url: String::new(),
                    push_url: String::new(),
                });
                remotes.len() - 1
            }
        };
        match kind {
            "(fetch)" => remotes[idx].fetch_url = url.to_string(),
            "(push)" => remotes[idx].push_url = url.to_string(),
            _ => {}
        }
    }
    for r in &mut remotes {
        if r.push_url.is_empty() {
            r.push_url = r.fetch_url.clone();
        }
    }
    remotes
}

/// Every configured remote.
#[tauri::command]
pub fn git_remotes(root: String) -> Result<Vec<Remote>, String> {
    Ok(parse_remotes(&git_in(&root, &["remote", "-v"])?))
}

/// Add remote `name` at `url` (no fetch). Returns the new remote.
#[tauri::command]
pub fn git_remote_add(root: String, name: String, url: String) -> Result<Remote, String> {
    let (name, url) = (name.trim().to_string(), url.trim().to_string());
    if !valid_ref(&name) {
        return Err("invalid remote name".into());
    }
    if !valid_url(&url) {
        return Err("invalid remote URL".into());
    }
    git_in(&root, &["remote", "add", &name, &url])?;
    git_remotes(root)?
        .into_iter()
        .find(|r| r.name == name)
        .ok_or_else(|| format!("remote {name} was not created"))
}

/// Remove remote `name` (with its remote-tracking branches). With `expect_url`, only while the
/// remote still fetches from that URL — the inverse of an add must not drop a remote that has been
/// re-pointed since.
#[tauri::command]
pub fn git_remote_remove(
    root: String,
    name: String,
    expect_url: Option<String>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if !valid_ref(&name) {
        return Err("invalid remote name".into());
    }
    if let Some(want) = expect_url {
        let cur = git_remotes(root.clone())?
            .into_iter()
            .find(|r| r.name == name)
            .ok_or_else(|| format!("no remote {name}"))?;
        if cur.fetch_url != want.trim() {
            return Err(format!(
                "{name} now points at {}, not {}",
                cur.fetch_url,
                want.trim()
            ));
        }
    }
    git_in(&root, &["remote", "remove", &name]).map(|_| ())
}

// ── upstream status ────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct UpstreamStatus {
    /// The checked-out branch, `None` on a detached HEAD.
    pub branch: Option<String>,
    /// Its upstream (`origin/main`), `None` when it has none.
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// Commits on the branch the upstream lacks, newest first (Magit's *Unpushed to*).
    pub unpushed: Vec<RepoCommit>,
    /// Commits on the upstream the branch lacks, newest first (Magit's *Unpulled from*).
    pub unpulled: Vec<RepoCommit>,
}

/// `rev-list --left-right --count A...B` prints `left\tright`. Pure — unit tested.
fn parse_counts(out: &str) -> Option<(usize, usize)> {
    let mut it = out.split_whitespace();
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

const LOG_FMT: &str = "--format=%H\x1f%an\x1f%at\x1f%s\x1f%D";

/// The current branch against its upstream. A detached HEAD or a branch with no upstream is a
/// normal answer (the `None`s), not an error; only "not a repository" is.
#[tauri::command]
pub fn git_upstream_status(root: String) -> Result<UpstreamStatus, String> {
    git_in(&root, &["rev-parse", "--git-dir"])?;
    let branch = git_in(&root, &["symbolic-ref", "-q", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let upstream = branch.as_ref().and_then(|_| {
        git_in(
            &root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    });
    let mut st = UpstreamStatus {
        branch,
        upstream,
        ahead: 0,
        behind: 0,
        unpushed: Vec::new(),
        unpulled: Vec::new(),
    };
    if st.upstream.is_some() {
        let counts = git_in(
            &root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )?;
        (st.ahead, st.behind) = parse_counts(&counts).unwrap_or((0, 0));
        st.unpushed = parse_repo_log(&git_in(
            &root,
            &["log", "-n200", LOG_FMT, "@{upstream}..HEAD", "--"],
        )?);
        st.unpulled = parse_repo_log(&git_in(
            &root,
            &["log", "-n200", LOG_FMT, "HEAD..@{upstream}", "--"],
        )?);
    }
    Ok(st)
}

// ── fetch / pull / push ────────────────────────────────────────────────────────────────────────────

/// The `git fetch` argument list. Pure — unit tested.
fn fetch_args(remote: Option<&str>, prune: bool) -> Result<Vec<String>, String> {
    let mut args = vec!["fetch".to_string()];
    if prune {
        args.push("--prune".into());
    }
    match remote.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) if !valid_ref(r) => return Err("invalid remote name".into()),
        Some(r) => args.push(r.to_string()),
        None => args.push("--all".into()),
    }
    Ok(args)
}

#[derive(Serialize)]
pub struct NetResult {
    /// What git reported (fetch and push write their summary to stderr).
    pub output: String,
    /// The upstream picture after the operation.
    pub status: UpstreamStatus,
}

/// Fetch `remote` (every remote when omitted), pruning deleted remote branches with `prune`.
#[tauri::command]
pub fn git_fetch(
    root: String,
    remote: Option<String>,
    prune: Option<bool>,
) -> Result<NetResult, String> {
    let args = fetch_args(remote.as_deref(), prune.unwrap_or(false))?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_net(&root, &refs)?;
    Ok(NetResult {
        output,
        status: git_upstream_status(root)?,
    })
}

/// The `git pull` argument list for a mode. Pure — unit tested.
fn pull_args(mode: &str) -> Result<Vec<&'static str>, String> {
    Ok(match mode {
        "ff-only" => vec!["pull", "--ff-only"],
        "rebase" => vec!["pull", "--rebase"],
        "merge" => vec!["pull", "--no-rebase", "--no-edit"],
        other => {
            return Err(format!(
                "unknown pull mode {other:?} (ff-only, rebase, merge)"
            ))
        }
    })
}

#[derive(Serialize, Debug)]
pub struct PullResult {
    /// True when the pull stopped on conflicts; `unmerged` lists them, `op` is what to continue.
    pub stopped: bool,
    pub op: Option<String>,
    pub unmerged: Vec<String>,
    /// HEAD before and after (`None` before the first commit).
    pub before: Option<String>,
    pub after: Option<String>,
    pub output: String,
}

/// Pull the upstream into the current branch: `ff-only` (the default — never makes a commit),
/// `rebase`, or `merge`.
#[tauri::command]
pub fn git_pull(root: String, mode: Option<String>) -> Result<PullResult, String> {
    let args = pull_args(mode.as_deref().unwrap_or("ff-only"))?;
    let head = |root: &str| {
        git_in(root, &["rev-parse", "-q", "--verify", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
    };
    let before = head(&root);
    match git_net(&root, &args) {
        Ok(output) => Ok(PullResult {
            stopped: false,
            op: None,
            unmerged: Vec::new(),
            after: head(&root),
            before,
            output,
        }),
        Err(err) => {
            // A merge or rebase that stopped on conflicts leaves the operation in progress with
            // unmerged paths; anything else (no upstream, diverged under ff-only, network) is a
            // real failure.
            let left = unmerged(&root);
            match current_op(&root) {
                Some(op) if !left.is_empty() => Ok(PullResult {
                    stopped: true,
                    op: Some(op.to_string()),
                    unmerged: left,
                    after: head(&root),
                    before,
                    output: err,
                }),
                _ => Err(err),
            }
        }
    }
}

/// The `git push` argument list. Pure — unit tested.
fn push_args(
    remote: Option<&str>,
    branch: Option<&str>,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<Vec<String>, String> {
    let remote = remote.map(str::trim).filter(|r| !r.is_empty());
    let branch = branch.map(str::trim).filter(|b| !b.is_empty());
    if remote.is_some_and(|r| !valid_ref(r)) {
        return Err("invalid remote name".into());
    }
    if branch.is_some_and(|b| !valid_ref(b)) {
        return Err("invalid branch name".into());
    }
    if branch.is_some() && remote.is_none() {
        return Err("a branch to push needs a remote".into());
    }
    if set_upstream && remote.is_none() {
        return Err("setting the upstream needs a remote".into());
    }
    let mut args = vec!["push".to_string()];
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if force_with_lease {
        args.push("--force-with-lease".into());
    }
    args.extend(remote.map(str::to_string));
    args.extend(branch.map(str::to_string));
    Ok(args)
}

/// Push the current branch: to its upstream when `remote` is omitted, else to `remote` (branch
/// `branch`, default the current one), optionally recording that as the upstream. The only force
/// is `--force-with-lease`.
#[tauri::command]
pub fn git_push(
    root: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: Option<bool>,
    force_with_lease: Option<bool>,
) -> Result<NetResult, String> {
    let mut branch = branch;
    if remote.as_deref().is_some_and(|r| !r.trim().is_empty())
        && branch.as_deref().map_or(true, |b| b.trim().is_empty())
    {
        // Name the branch explicitly: with a remote and no refspec, git falls back to push.default,
        // which under `simple` refuses a branch whose upstream lives on another remote.
        branch = git_in(&root, &["symbolic-ref", "-q", "--short", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());
        if branch.is_none() {
            return Err("HEAD is detached: name the branch to push".into());
        }
    }
    let args = push_args(
        remote.as_deref(),
        branch.as_deref(),
        set_upstream.unwrap_or(false),
        force_with_lease.unwrap_or(false),
    )?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_net(&root, &refs)?;
    Ok(NetResult {
        output,
        status: git_upstream_status(root)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn remotes_pair_fetch_and_push_urls() {
        let out = "origin\tgit@h:a/b.git (fetch)\norigin\tgit@h:a/b.git (push)\n\
                   mirror\t/srv/m.git (fetch)\nmirror\tssh://push/m.git (push)\n\
                   solo\t../path with space (fetch)\n";
        let r = parse_remotes(out);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].fetch_url, "git@h:a/b.git");
        assert_eq!(
            r[1].push_url, "ssh://push/m.git",
            "a pushurl is its own value"
        );
        assert_eq!(r[1].fetch_url, "/srv/m.git");
        assert_eq!(
            (r[2].fetch_url.as_str(), r[2].push_url.as_str()),
            ("../path with space", "../path with space"),
            "only the last space separates the kind; no push line means push to the fetch URL"
        );
    }

    #[test]
    fn argument_lists_guard_their_values() {
        assert_eq!(fetch_args(None, false).unwrap(), ["fetch", "--all"]);
        assert_eq!(
            fetch_args(Some(" up "), true).unwrap(),
            ["fetch", "--prune", "up"]
        );
        assert!(fetch_args(Some("--upload-pack=x"), false).is_err());
        assert_eq!(pull_args("ff-only").unwrap(), ["pull", "--ff-only"]);
        assert_eq!(
            pull_args("merge").unwrap(),
            ["pull", "--no-rebase", "--no-edit"]
        );
        assert!(pull_args("octopus").is_err());
        assert_eq!(push_args(None, None, false, false).unwrap(), ["push"]);
        assert_eq!(
            push_args(Some("origin"), Some("topic"), true, true).unwrap(),
            [
                "push",
                "--set-upstream",
                "--force-with-lease",
                "origin",
                "topic"
            ]
        );
        assert!(
            push_args(None, Some("topic"), false, false).is_err(),
            "a branch with no remote"
        );
        assert!(
            push_args(None, None, true, false).is_err(),
            "-u with no remote"
        );
        assert!(push_args(Some("origin"), Some("--mirror"), false, false).is_err());
        assert!(push_args(Some("--all"), None, false, false).is_err());
        assert_eq!(parse_counts("3\t1\n"), Some((3, 1)));
        assert_eq!(parse_counts(""), None);
        assert!(!valid_url("--upload-pack=touch x"));
        assert!(!valid_url("a b"));
        assert!(valid_url("https://h/x.git"));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-remote-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn configure(root: &str) {
        for (k, v) in [
            ("user.email", "t@t"),
            ("user.name", "t"),
            ("commit.gpgSign", "false"),
        ] {
            git_in(root, &["config", k, v]).unwrap();
        }
    }

    fn commit(root: &str, dir: &Path, file: &str, body: &str, msg: &str) {
        std::fs::write(dir.join(file), body).unwrap();
        git_in(root, &["add", file]).unwrap();
        git_in(root, &["commit", "-q", "-m", msg]).unwrap();
    }

    // Two clones of one bare remote: push sets the upstream, the other side fetches and sees the
    // commit as unpulled, a fast-forward pull takes it, a diverged ff-only pull is refused, a merge
    // pull that conflicts is a stop, and a lease push refuses to overwrite unseen work.
    #[test]
    fn push_fetch_pull_round_trip_through_a_bare_remote() {
        let base = temp_dir("net");
        let bare = base.join("hub.git");
        let (a, b) = (base.join("a"), base.join("b"));
        let s = |p: &Path| p.to_string_lossy().into_owned();
        if git_in(
            &s(&base),
            &["init", "-q", "--bare", "-b", "main", &s(&bare)],
        )
        .is_err()
        {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        std::fs::create_dir_all(&a).unwrap();
        git_in(&s(&a), &["init", "-q", "-b", "main"]).unwrap();
        configure(&s(&a));
        commit(&s(&a), &a, "f.txt", "one\n", "first");

        // No upstream yet: a status, not an error.
        let st = git_upstream_status(s(&a)).unwrap();
        assert_eq!(
            (st.branch.as_deref(), st.upstream.as_deref()),
            (Some("main"), None)
        );

        let added = git_remote_add(s(&a), "origin".into(), s(&bare)).unwrap();
        assert_eq!(added.push_url, s(&bare));
        assert!(
            git_remote_add(s(&a), "origin".into(), s(&bare)).is_err(),
            "the name exists"
        );
        let pushed = git_push(s(&a), Some("origin".into()), None, Some(true), None).unwrap();
        assert_eq!(pushed.status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((pushed.status.ahead, pushed.status.behind), (0, 0));

        git_in(&s(&base), &["clone", "-q", &s(&bare), &s(&b)]).unwrap();
        configure(&s(&b));
        commit(&s(&b), &b, "g.txt", "g\n", "from b");
        git_push(s(&b), None, None, None, None).unwrap();

        // a has not fetched: it does not know yet.
        assert_eq!(git_upstream_status(s(&a)).unwrap().behind, 0);
        let f = git_fetch(s(&a), None, Some(true)).unwrap();
        assert_eq!((f.status.ahead, f.status.behind), (0, 1));
        assert_eq!(f.status.unpulled[0].subject, "from b");
        let p = git_pull(s(&a), None).unwrap();
        assert!(
            !p.stopped && p.before != p.after,
            "a fast-forward moves HEAD"
        );
        assert_eq!(std::fs::read_to_string(a.join("g.txt")).unwrap(), "g\n");

        // Diverge on the same line: ff-only refuses outright, merge stops on the conflict.
        commit(&s(&a), &a, "f.txt", "a side\n", "a edit");
        commit(&s(&b), &b, "f.txt", "b side\n", "b edit");
        git_push(s(&b), None, None, None, None).unwrap();
        git_fetch(s(&a), Some("origin".into()), None).unwrap();
        let st = git_upstream_status(s(&a)).unwrap();
        assert_eq!((st.ahead, st.behind), (1, 1));
        assert_eq!(st.unpushed[0].subject, "a edit");
        assert!(git_pull(s(&a), Some("ff-only".into())).is_err());
        let stop = git_pull(s(&a), Some("merge".into())).unwrap();
        assert!(stop.stopped);
        assert_eq!(stop.op.as_deref(), Some("merge"));
        assert_eq!(stop.unmerged, vec!["f.txt"]);
        git_in(&s(&a), &["merge", "--abort"]).unwrap();

        // b moves on again; a's lease (its stale view of origin/main) must refuse the overwrite.
        commit(&s(&b), &b, "h.txt", "h\n", "unseen");
        git_push(s(&b), None, None, None, None).unwrap();
        assert!(git_push(s(&a), None, None, None, Some(true)).is_err());

        // The add's inverse refuses a re-pointed remote, then removes the one it made.
        git_in(&s(&a), &["remote", "set-url", "origin", &s(&base)]).unwrap();
        assert!(git_remote_remove(s(&a), "origin".into(), Some(s(&bare))).is_err());
        git_remote_remove(s(&a), "origin".into(), Some(s(&base))).unwrap();
        assert!(git_remotes(s(&a)).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }
}
