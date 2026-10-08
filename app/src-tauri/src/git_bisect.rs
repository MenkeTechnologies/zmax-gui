//! Git bisect — `magit-bisect`: binary-search the history for the commit that introduced a change.
//!
//! * **Start** between a known-bad revision (HEAD by default) and one or more known-good ones;
//!   git checks out the midpoint.
//! * **Mark** the checked-out commit (or a named one) `good`, `bad` or `skip`; git checks out the
//!   next midpoint, or names the first bad commit.
//! * **Run** a shell command at every step (`git bisect run`): exit 0 is good, 125 is skip, any
//!   other 1–127 is bad — the whole search with no clicks.
//! * **State** — whether a bisect is in progress, the commit under test, every verdict so far and,
//!   once found, the first bad commit; **reset** ends the bisect and returns to the original branch.
//!
//! The state is read back from `git bisect log`, which is git's own record of the session, so it is
//! the same after an app restart or when the bisect was started in a terminal. Every bisect command
//! runs under `LC_ALL=C`: the progress line and the log comments this module parses are translated
//! by git otherwise.

use regex::Regex;
use serde::Serialize;
use std::process::Command;
use std::sync::OnceLock;

/// `git -C <dir> <args…>` in the C locale. Ok(stdout) or Err(stderr, else stdout).
fn git_c(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_EDITOR", "true")
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

/// A revision the user typed: no leading `-` (it would be read as an option), no whitespace or
/// control characters.
fn valid_rev(rev: &str) -> bool {
    !rev.is_empty()
        && !rev.starts_with('-')
        && !rev.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct BisectCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct BisectVerdict {
    /// `good`, `bad` or `skip`.
    pub verdict: String,
    pub commit: BisectCommit,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct BisectState {
    pub active: bool,
    /// The commit checked out for testing (HEAD), while active.
    pub current: Option<BisectCommit>,
    /// Every verdict, in the order given — the start's own bad / good revisions first.
    pub log: Vec<BisectVerdict>,
    /// Set once git has narrowed the range to one commit.
    pub first_bad: Option<BisectCommit>,
    /// From the progress line of the command just run: revisions left after this step and the
    /// rough number of steps. `None` on a plain state read and once the search is over.
    pub remaining: Option<usize>,
    pub steps: Option<usize>,
    /// What the command just run printed (the run's per-step output included); empty on a read.
    pub output: String,
}

fn commit(hash: &str, subject: &str) -> BisectCommit {
    BisectCommit {
        hash: hash.to_string(),
        short: hash.chars().take(8).collect(),
        subject: subject.to_string(),
    }
}

/// Read the verdicts and the first bad commit out of `git bisect log`. Its comment lines are
/// `# good: [<hash>] <subject>`, `# bad: …`, `# skip: …` and `# first bad commit: […] …` (git 2.45+
/// quotes the term: `# first 'bad' commit:`). Command lines (`git bisect …`) repeat the verdicts
/// and are ignored. Pure — unit tested.
fn parse_log(out: &str) -> (Vec<BisectVerdict>, Option<BisectCommit>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^# (good|bad|skip|first '?bad'? commit): \[([0-9a-f]{7,64})\] ?(.*)$").unwrap()
    });
    let mut log = Vec::new();
    let mut first_bad = None;
    for line in out.lines() {
        let Some(c) = re.captures(line) else { continue };
        let found = commit(&c[2], &c[3]);
        match &c[1] {
            v @ ("good" | "bad" | "skip") => log.push(BisectVerdict {
                verdict: v.to_string(),
                commit: found,
            }),
            _ => first_bad = Some(found),
        }
    }
    (log, first_bad)
}

/// `Bisecting: 3 revisions left to test after this (roughly 2 steps)` → (3, 2). Pure — unit tested.
fn parse_progress(out: &str) -> Option<(usize, usize)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"Bisecting: (\d+) revisions? left to test after this \(roughly (\d+) steps?\)")
            .unwrap()
    });
    let c = re.captures_iter(out).last()?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?))
}

/// The bisect as git records it. Not bisecting is `active: false`, not an error.
#[tauri::command]
pub fn git_bisect_state(root: String) -> Result<BisectState, String> {
    git_c(&root, &["rev-parse", "--git-dir"])?;
    let Ok(log) = git_c(&root, &["bisect", "log"]) else {
        return Ok(BisectState::default());
    };
    let (log, first_bad) = parse_log(&log);
    let current = git_c(&root, &["log", "-1", "--format=%H\x1f%s", "HEAD", "--"])
        .ok()
        .and_then(|s| s.trim_end().split_once('\x1f').map(|(h, s)| commit(h, s)));
    Ok(BisectState {
        active: true,
        current,
        log,
        first_bad,
        ..Default::default()
    })
}

/// State after a bisect command, carrying that command's progress line and output.
fn after(root: String, output: String) -> Result<BisectState, String> {
    let mut st = git_bisect_state(root)?;
    if st.first_bad.is_none() {
        if let Some((remaining, steps)) = parse_progress(&output) {
            st.remaining = Some(remaining);
            st.steps = Some(steps);
        }
    }
    st.output = output.trim().to_string();
    Ok(st)
}

/// The `git bisect start` argument list. Pure — unit tested.
fn start_args(bad: Option<&str>, good: &[String]) -> Result<Vec<String>, String> {
    let bad = bad
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or("HEAD");
    let good: Vec<&str> = good
        .iter()
        .map(|g| g.trim())
        .filter(|g| !g.is_empty())
        .collect();
    if good.is_empty() {
        return Err("name at least one good revision".into());
    }
    if let Some(bad_rev) = std::iter::once(bad)
        .chain(good.iter().copied())
        .find(|r| !valid_rev(r))
    {
        return Err(format!("invalid revision {bad_rev:?}"));
    }
    let mut args = vec!["bisect".to_string(), "start".to_string(), bad.to_string()];
    args.extend(good.iter().map(|g| g.to_string()));
    // Ends the revision list: nothing after it can be read as one.
    args.push("--".into());
    Ok(args)
}

/// Start bisecting between `bad` (HEAD when omitted) and the `good` revisions. Refused while a
/// bisect is already in progress — `git bisect start` would silently discard it.
#[tauri::command]
pub fn git_bisect_start(
    root: String,
    bad: Option<String>,
    good: Vec<String>,
) -> Result<BisectState, String> {
    let args = start_args(bad.as_deref(), &good)?;
    if git_bisect_state(root.clone())?.active {
        return Err("a bisect is already in progress — reset it first".into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git_c(&root, &refs)?;
    after(root, out)
}

/// Mark `rev` (the checked-out commit when omitted) good, bad or skip.
#[tauri::command]
pub fn git_bisect_mark(
    root: String,
    verdict: String,
    rev: Option<String>,
) -> Result<BisectState, String> {
    if !matches!(verdict.as_str(), "good" | "bad" | "skip") {
        return Err(format!("unknown verdict {verdict:?} (good, bad, skip)"));
    }
    let rev = rev.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    if rev.as_deref().is_some_and(|r| !valid_rev(r)) {
        return Err("invalid revision".into());
    }
    if !git_bisect_state(root.clone())?.active {
        return Err("no bisect in progress".into());
    }
    let mut args = vec!["bisect", verdict.as_str()];
    args.extend(rev.as_deref());
    let out = git_c(&root, &args)?;
    after(root, out)
}

/// Run `command` (through `sh -c`) at every step until git names the first bad commit.
#[tauri::command]
pub fn git_bisect_run(root: String, command: String) -> Result<BisectState, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("the test command is empty".into());
    }
    if !git_bisect_state(root.clone())?.active {
        return Err("no bisect in progress".into());
    }
    let out = git_c(&root, &["bisect", "run", "sh", "-c", command])?;
    after(root, out)
}

/// End the bisect and check out the branch it started from.
#[tauri::command]
pub fn git_bisect_reset(root: String) -> Result<(), String> {
    if !git_bisect_state(root.clone())?.active {
        return Err("no bisect in progress".into());
    }
    git_c(&root, &["bisect", "reset"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ext::git_in;

    #[test]
    fn log_comments_carry_verdicts_and_the_answer() {
        let log = "# bad: [23cd251c001754cf4d1f48c7b94b8eaa138ea8c7] c8\n\
                   # good: [4b9b902d6ac2418261b06b4f27208aa65fdcee58] c1\n\
                   git bisect start 'HEAD' 'HEAD~7' '--'\n\
                   # skip: [85004904cb288e434dffeb46c82a3cf117cda645] fix: [x] y\n\
                   git bisect skip 85004904cb288e434dffeb46c82a3cf117cda645\n\
                   # first 'bad' commit: [35001ceaed437a3fdab9810ae50dff740dd9c860] c5\n";
        let (v, first) = parse_log(log);
        let verdicts: Vec<&str> = v.iter().map(|e| e.verdict.as_str()).collect();
        assert_eq!(
            verdicts,
            ["bad", "good", "skip"],
            "command lines are not verdicts"
        );
        assert_eq!(
            v[2].commit.subject, "fix: [x] y",
            "a subject may contain brackets"
        );
        assert_eq!(v[0].commit.short, "23cd251c");
        assert_eq!(first.unwrap().subject, "c5");
        // Before git 2.45 the term was not quoted.
        let (_, old) = parse_log("# first bad commit: [35001ceaed437a3f] c5\n");
        assert_eq!(old.unwrap().hash, "35001ceaed437a3f");
    }

    #[test]
    fn progress_line_singular_and_plural() {
        assert_eq!(
            parse_progress(
                "Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[abc] c4\n"
            ),
            Some((3, 2))
        );
        assert_eq!(
            parse_progress("Bisecting: 1 revision left to test after this (roughly 1 step)"),
            Some((1, 1))
        );
        assert_eq!(parse_progress("abc is the first 'bad' commit"), None);
    }

    #[test]
    fn start_args_guard_revisions() {
        assert_eq!(
            start_args(None, &["v1".into(), " ".into()]).unwrap(),
            ["bisect", "start", "HEAD", "v1", "--"]
        );
        assert!(start_args(Some("main"), &[]).is_err(), "no good revision");
        assert!(start_args(Some("--term-new=x"), &["v1".into()]).is_err());
        assert!(start_args(None, &["--no-checkout".into()]).is_err());
    }

    fn temp_repo() -> Option<(std::path::PathBuf, String)> {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-bisect-{}-{}",
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
        // c1..c8; the value file turns "broken" at c5.
        for i in 1..=8 {
            let v = if i >= 5 { "broken" } else { "ok" };
            std::fs::write(dir.join("value"), format!("{v}\n")).unwrap();
            std::fs::write(dir.join("n"), format!("{i}\n")).unwrap();
            git_in(&root, &["add", "."]).unwrap();
            git_in(&root, &["commit", "-q", "-m", &format!("c{i}")]).unwrap();
        }
        Some((dir, root))
    }

    // Answer each midpoint from the file contents: the search must land on c5, then reset must put
    // the branch back.
    #[test]
    fn manual_marks_converge_on_the_first_bad_commit() {
        let Some((dir, root)) = temp_repo() else {
            return;
        };
        assert!(!git_bisect_state(root.clone()).unwrap().active);
        assert!(
            git_bisect_mark(root.clone(), "good".into(), None).is_err(),
            "nothing to mark"
        );

        let mut st = git_bisect_start(root.clone(), None, vec!["HEAD~7".into()]).unwrap();
        assert!(st.active && st.remaining.is_some());
        assert_eq!(
            st.log.len(),
            2,
            "the start's bad and good are the first verdicts"
        );
        assert!(
            git_bisect_start(root.clone(), None, vec!["HEAD~1".into()]).is_err(),
            "a second start must not discard the running bisect"
        );
        let mut rounds = 0;
        while st.first_bad.is_none() {
            rounds += 1;
            assert!(rounds < 8, "the search did not converge");
            let broken = std::fs::read_to_string(dir.join("value")).unwrap() == "broken\n";
            st = git_bisect_mark(
                root.clone(),
                if broken { "bad" } else { "good" }.into(),
                None,
            )
            .unwrap();
        }
        assert_eq!(st.first_bad.as_ref().unwrap().subject, "c5");
        assert_eq!(st.remaining, None, "a finished search has nothing left");
        // A read after the fact (a restarted app) sees the same answer.
        assert_eq!(
            git_bisect_state(root.clone()).unwrap().first_bad,
            st.first_bad
        );

        git_bisect_reset(root.clone()).unwrap();
        assert!(!git_bisect_state(root.clone()).unwrap().active);
        assert_eq!(
            git_in(&root, &["symbolic-ref", "--short", "HEAD"])
                .unwrap()
                .trim(),
            "main"
        );
        assert!(git_bisect_mark(root.clone(), "maybe".into(), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_finds_it_unattended() {
        let Some((dir, root)) = temp_repo() else {
            return;
        };
        git_bisect_start(root.clone(), Some("main".into()), vec!["main~7".into()]).unwrap();
        let st = git_bisect_run(root.clone(), "grep -q '^ok$' value".into()).unwrap();
        assert_eq!(st.first_bad.unwrap().subject, "c5");
        assert!(st.output.contains("first"), "{}", st.output);
        git_bisect_reset(root.clone()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
