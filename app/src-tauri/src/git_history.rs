//! Git history recovery and search — the Magit surfaces beside the plain repository log in
//! `git_more.rs`:
//!
//! * **Reflog** (`magit-reflog`) — where a ref has pointed, newest first: every commit, checkout,
//!   reset, rebase step and amend, including the commits no branch reaches any more. Each entry is
//!   split into the operation (`commit`, `checkout`, `reset`, …) and its message.
//! * **Branch at a revision** (`magit-branch-create` on a reflog line) — create a branch at any
//!   revision without checking it out: the way a dropped or reset-away commit is recovered. Its
//!   inverse, `git_branch_delete_at`, deletes the branch only while it still points at the commit
//!   it was created at (git's own compare-and-delete, `update-ref -d <ref> <old>`), so undoing the
//!   creation can never drop work committed on that branch since.
//! * **History search** (`magit-log` with `-S` / `-G` / `--grep`, Emacs `vc-log-search`) — the
//!   commits that added or removed a string (pickaxe), whose diff touches a line matching a regex,
//!   or whose message matches, optionally scoped to a path.
//!
//! Same host contract as the other git modules: `git_ext::git_in`, and every user-supplied name or
//! revision is flag-guarded before it reaches git. A search string is passed glued to its option
//! (`-S<text>`), so it is always that option's value and never a flag of its own.

use crate::git_ext::{git_in, valid_ref};
use crate::git_more::{fmt_date, parse_repo_log, RepoCommit};
use serde::{Deserialize, Serialize};

// ── reflog ─────────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct ReflogEntry {
    pub hash: String,
    /// First 8 characters of `hash`.
    pub short: String,
    /// The reflog selector, `HEAD@{3}` — what `git show` / `git branch x HEAD@{3}` accept.
    pub selector: String,
    /// The operation that moved the ref: `commit`, `commit (amend)`, `checkout`, `reset`,
    /// `rebase (finish)`, `merge feature`, … — the text before the first `: `.
    pub action: String,
    /// The rest of the reflog subject (a commit subject, `moving from a to b`, …).
    pub message: String,
    /// When the ref moved (the reflog entry's own time), `YYYY-MM-DD`.
    pub date: String,
}

/// Parse `%H\x1f%gd\x1f%gs` lines produced under `--date=unix`. git has no reflog-time placeholder;
/// what it has is the date form of the selector: under a `--date` format `%gd` prints
/// `HEAD@{1609459200}` (when the ref moved) instead of `HEAD@{0}`. Both are wanted, so the time is
/// read from that selector and the positional selector is rebuilt from the line index — exact,
/// because the walk is unfiltered (no pathspec), so line `i` is entry `@{i}`. A subject with no
/// `: ` (a hand-written `update-ref -m`) is all action. Pure — unit tested.
fn parse_reflog(out: &str) -> Vec<ReflogEntry> {
    out.lines()
        .filter(|line| !line.is_empty())
        .enumerate()
        .filter_map(|(i, line)| {
            let mut f = line.split('\x1f');
            let (hash, dated, subject) = (f.next()?, f.next()?, f.next()?);
            if hash.is_empty() {
                return None;
            }
            let (base, at) = dated.strip_suffix('}')?.rsplit_once("@{")?;
            let (action, message) = match subject.split_once(": ") {
                Some((a, m)) => (a.to_string(), m.to_string()),
                None => (subject.to_string(), String::new()),
            };
            Some(ReflogEntry {
                short: hash.chars().take(8).collect(),
                hash: hash.to_string(),
                selector: format!("{base}@{{{i}}}"),
                action,
                message,
                date: fmt_date(at.parse().unwrap_or(0)),
            })
        })
        .collect()
}

/// The reflog of `refname` (HEAD when omitted), newest first, capped at `limit`.
#[tauri::command]
pub fn git_reflog(
    root: String,
    refname: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ReflogEntry>, String> {
    let r = refname
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "HEAD".into());
    if !valid_ref(&r) {
        return Err("invalid ref".into());
    }
    let max = format!("-n{}", limit.unwrap_or(300).clamp(1, 5000));
    // `--date=unix` turns `%gd` into the timestamped selector `parse_reflog` reads. `--` keeps a
    // ref that happens to share its name with a file from being read as a path.
    let out = git_in(
        &root,
        &[
            "log",
            "-g",
            &max,
            "--format=%H\x1f%gd\x1f%gs",
            "--date=unix",
            &r,
            "--",
        ],
    )?;
    Ok(parse_reflog(&out))
}

// ── branch at a revision (and its compare-and-delete inverse) ──────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct BranchAt {
    pub name: String,
    /// The full commit hash the new branch points at — what its inverse compares against.
    pub hash: String,
}

/// Create branch `name` at `rev` without checking it out (`git branch <name> <rev>`). Fails (git's
/// message) when the name exists. Returns the commit it points at.
#[tauri::command]
pub fn git_branch_at(root: String, name: String, rev: String) -> Result<BranchAt, String> {
    let name = name.trim().to_string();
    let rev = rev.trim();
    if !valid_ref(&name) {
        return Err("invalid branch name".into());
    }
    if !valid_ref(rev) {
        return Err("invalid revision".into());
    }
    git_in(&root, &["branch", "--no-track", &name, rev])?;
    let hash = git_in(&root, &["rev-parse", &format!("refs/heads/{name}")])?
        .trim()
        .to_string();
    Ok(BranchAt { name, hash })
}

/// Delete branch `name` only if it still points at `hash` and is not checked out. The test and the
/// delete are one atomic `update-ref`, so a commit landing on the branch in between makes this fail
/// instead of losing that commit.
#[tauri::command]
pub fn git_branch_delete_at(root: String, name: String, hash: String) -> Result<(), String> {
    if !valid_ref(&name) {
        return Err("invalid branch name".into());
    }
    if hash.len() < 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("a full commit hash is required".into());
    }
    let full = format!("refs/heads/{name}");
    if let Ok(cur) = git_in(&root, &["symbolic-ref", "-q", "HEAD"]) {
        if cur.trim() == full {
            return Err(format!("{name} is checked out"));
        }
    }
    git_in(&root, &["update-ref", "-d", &full, &hash]).map(|_| ())
}

// ── history search ─────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// `-S` — commits that change the number of occurrences of the string (added or removed it).
    Pickaxe,
    /// `-G` — commits whose diff adds or removes a line matching the regex.
    Regex,
    /// `--grep` — commits whose message matches the regex.
    Message,
}

#[derive(Deserialize)]
pub struct LogSearchOpts {
    pub mode: SearchMode,
    pub ignore_case: Option<bool>,
    /// Restrict to commits touching this path (file or directory), relative to the root.
    pub path: Option<String>,
    /// Search every ref, not only the current branch.
    pub all: Option<bool>,
    pub limit: Option<usize>,
}

/// The `git log` argument list for a search. Pure — unit tested.
fn log_search_args(query: &str, o: &LogSearchOpts) -> Result<Vec<String>, String> {
    if query.is_empty() {
        return Err("search text is empty".into());
    }
    if query.contains('\0') {
        return Err("search text contains a NUL byte".into());
    }
    let mut args = vec![
        "log".to_string(),
        format!("-n{}", o.limit.unwrap_or(300).clamp(1, 5000)),
        "--format=%H\x1f%an\x1f%at\x1f%s\x1f%D".to_string(),
    ];
    args.push(match o.mode {
        SearchMode::Pickaxe => format!("-S{query}"),
        SearchMode::Regex => format!("-G{query}"),
        SearchMode::Message => format!("--grep={query}"),
    });
    // `-i` folds case for -G and --grep; for -S git applies it too (the pickaxe honours
    // --regexp-ignore-case), which the round-trip test pins.
    if o.ignore_case.unwrap_or(false) {
        args.push("--regexp-ignore-case".into());
    }
    if o.all.unwrap_or(false) {
        args.push("--all".into());
    }
    args.push("--".into());
    if let Some(p) = o.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        args.push(p.to_string());
    }
    Ok(args)
}

/// Commits matching a pickaxe / diff-regex / message search, newest first.
#[tauri::command]
pub fn git_log_search(
    root: String,
    query: String,
    opts: LogSearchOpts,
) -> Result<Vec<RepoCommit>, String> {
    let args = log_search_args(&query, &opts)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(parse_repo_log(&git_in(&root, &refs)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflog_splits_action_from_message() {
        let out = "aaaaaaaaaaaa\x1fHEAD@{1609459200}\x1fcommit (amend): fix: x: y\n\
                   bbbbbbbbbbbb\x1fHEAD@{0}\x1fcheckout: moving from main to dev\n\
                   cccccccccccc\x1fHEAD@{0}\x1fmanual move\n";
        let e = parse_reflog(out);
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].action, "commit (amend)");
        assert_eq!(
            e[0].message, "fix: x: y",
            "only the FIRST ': ' separates the action"
        );
        assert_eq!(e[0].short, "aaaaaaaa");
        assert_eq!(e[0].date, "2021-01-01", "the time is the dated selector's");
        assert_eq!(
            e[0].selector, "HEAD@{0}",
            "the selector is positional, not the timestamp"
        );
        assert_eq!(e[1].selector, "HEAD@{1}");
        let branch = parse_reflog("dddd\x1fdev/x@{1609459200}\x1fbranch: Created from HEAD\n");
        assert_eq!(branch[0].selector, "dev/x@{0}");
        assert_eq!(
            (e[2].action.as_str(), e[2].message.as_str()),
            ("manual move", "")
        );
    }

    fn opts(mode: SearchMode) -> LogSearchOpts {
        LogSearchOpts {
            mode,
            ignore_case: None,
            path: None,
            all: None,
            limit: None,
        }
    }

    #[test]
    fn search_args_keep_the_query_a_value() {
        let a = log_search_args("--all", &opts(SearchMode::Pickaxe)).unwrap();
        assert!(a.contains(&"-S--all".to_string()), "{a:?}");
        assert!(
            !a.contains(&"--all".to_string()),
            "the query became a flag: {a:?}"
        );
        let g = log_search_args("fn \\w+", &opts(SearchMode::Regex)).unwrap();
        assert!(g.contains(&"-Gfn \\w+".to_string()));
        let m = LogSearchOpts {
            ignore_case: Some(true),
            path: Some(" src/ ".into()),
            all: Some(true),
            ..opts(SearchMode::Message)
        };
        let m = log_search_args("fix", &m).unwrap();
        assert!(m.contains(&"--grep=fix".to_string()));
        assert!(m.contains(&"--regexp-ignore-case".to_string()));
        assert!(m.contains(&"--all".to_string()));
        assert_eq!(
            &m[m.len() - 2..],
            ["--", "src/"],
            "the path follows -- so it is never a rev"
        );
        assert!(log_search_args("", &opts(SearchMode::Pickaxe)).is_err());
    }

    fn temp_repo(tag: &str) -> Option<(std::path::PathBuf, String)> {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-{tag}-{}-{}",
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

    fn commit(root: &str, dir: &std::path::Path, file: &str, body: &str, msg: &str) {
        std::fs::write(dir.join(file), body).unwrap();
        git_in(root, &["add", file]).unwrap();
        git_in(root, &["commit", "-q", "-m", msg]).unwrap();
    }

    // A commit reset away is still in the reflog; branching at its entry recovers it, and the
    // branch's compare-and-delete refuses once the branch has moved on.
    #[test]
    fn reflog_recovers_a_reset_commit_and_delete_is_compare_and_swap() {
        let Some((dir, root)) = temp_repo("reflog") else {
            return;
        };
        commit(&root, &dir, "f.txt", "one\n", "first");
        commit(&root, &dir, "f.txt", "one\ntwo\n", "second");
        git_in(&root, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();

        let log = git_reflog(root.clone(), None, None).unwrap();
        assert_eq!(log[0].action, "reset");
        let lost = log
            .iter()
            .find(|e| e.message == "second")
            .expect("the reset-away commit");
        assert_eq!(lost.action, "commit");

        let b = git_branch_at(root.clone(), "rescue".into(), lost.selector.clone()).unwrap();
        assert_eq!(b.hash, lost.hash);
        let head = git_in(&root, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        assert_eq!(
            head.trim(),
            "main",
            "creating the branch must not check it out"
        );
        assert!(git_branch_at(root.clone(), "rescue".into(), "HEAD".into()).is_err());
        assert!(git_branch_at(root.clone(), "-D".into(), "HEAD".into()).is_err());
        assert!(git_reflog(root.clone(), Some("--all".into()), None).is_err());

        // Work lands on the branch: the old hash no longer matches, so the delete refuses.
        git_in(&root, &["checkout", "-q", "rescue"]).unwrap();
        assert!(
            git_branch_delete_at(root.clone(), "rescue".into(), b.hash.clone())
                .unwrap_err()
                .contains("checked out")
        );
        commit(&root, &dir, "g.txt", "g\n", "third");
        git_in(&root, &["checkout", "-q", "main"]).unwrap();
        assert!(git_branch_delete_at(root.clone(), "rescue".into(), b.hash.clone()).is_err());
        assert!(git_in(&root, &["rev-parse", "--verify", "-q", "refs/heads/rescue"]).is_ok());

        // At the hash it was created at, the delete goes through.
        let c = git_branch_at(root.clone(), "again".into(), "main".into()).unwrap();
        git_branch_delete_at(root.clone(), "again".into(), c.hash).unwrap();
        assert!(git_in(&root, &["rev-parse", "--verify", "-q", "refs/heads/again"]).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_modes_find_different_commits() {
        let Some((dir, root)) = temp_repo("logsearch") else {
            return;
        };
        commit(&root, &dir, "a.rs", "fn alpha() {}\n", "add alpha");
        commit(
            &root,
            &dir,
            "a.rs",
            "fn alpha() {}\nfn Beta() {}\n",
            "Feature: beta",
        );
        commit(&root, &dir, "b.txt", "alpha mention\n", "docs");
        commit(&root, &dir, "a.rs", "fn Beta() {}\n", "remove alpha");

        let subjects = |q: &str, o: LogSearchOpts| -> Vec<String> {
            git_log_search(root.clone(), q.into(), o)
                .unwrap()
                .into_iter()
                .map(|c| c.subject)
                .collect()
        };
        // Pickaxe: every commit that changed the occurrence count of the string.
        assert_eq!(
            subjects("fn alpha", opts(SearchMode::Pickaxe)),
            vec!["remove alpha", "add alpha"]
        );
        // Scoped to a path, the docs commit's mention elsewhere does not count.
        let scoped = LogSearchOpts {
            path: Some("b.txt".into()),
            ..opts(SearchMode::Pickaxe)
        };
        assert_eq!(subjects("alpha", scoped), vec!["docs"]);
        // -G: a regex over changed lines.
        assert_eq!(
            subjects("^fn B", opts(SearchMode::Regex)),
            vec!["Feature: beta"]
        );
        // Message search, case-sensitive then folded.
        assert!(subjects("feature", opts(SearchMode::Message)).is_empty());
        let ci = LogSearchOpts {
            ignore_case: Some(true),
            ..opts(SearchMode::Message)
        };
        assert_eq!(subjects("feature", ci), vec!["Feature: beta"]);
        // -i folds the pickaxe too.
        let ci = LogSearchOpts {
            ignore_case: Some(true),
            ..opts(SearchMode::Pickaxe)
        };
        assert_eq!(subjects("FN BETA", ci), vec!["Feature: beta"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
