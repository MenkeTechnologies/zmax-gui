//! Git write-side operations beside the read-mostly surfaces in `git_tools.rs` / `git_more.rs` and
//! the branch/stash management in `git_ext.rs`:
//!
//! * **Commit** — record the staged index as a commit (`git commit -m`), optionally **amending** the
//!   tip and optionally adding a `Signed-off-by` trailer. `git_commit_info` feeds the panel: the
//!   current branch, the staged paths that will go into the commit, and the tip's message (what an
//!   amend starts from).
//! * **Tags** — list tags (annotated and lightweight, newest first), create one at HEAD or at a
//!   given revision (annotated when a message is given, lightweight otherwise), delete one, and show
//!   what a tag points at (`git show refs/tags/<name>`).
//!
//! Same host contract as the rest of the app: these shell out to `git` through `git_ext::git_in`,
//! and every name / revision is flag-guarded with `git_ext::valid_ref` before it reaches git.

use crate::git_ext::{git_in, valid_ref};
use serde::Serialize;

// ── commit ─────────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StagedPath {
    /// `git diff --cached --name-status` letter: `A`, `M`, `D`, `R`, `C`, `T`.
    pub status: String,
    /// Repo-relative path (for a rename, the destination).
    pub path: String,
}

#[derive(Serialize)]
pub struct CommitInfo {
    /// Current branch name (`HEAD` when detached).
    pub branch: String,
    /// False on an unborn branch (no commit yet), where amend is impossible.
    pub has_head: bool,
    /// What the next commit will record.
    pub staged: Vec<StagedPath>,
    /// Full message of the tip commit (empty without one) — the starting point of an amend.
    pub last_message: String,
}

/// Parse `git diff --cached --name-status` output. A rename/copy line carries a score and two
/// paths (`R100\told\tnew`); the destination is the path the commit records. Pure — unit tested.
fn parse_name_status(out: &str) -> Vec<StagedPath> {
    out.lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let code = cols.next()?;
            let path = cols.last()?;
            let status = code.chars().next()?.to_string();
            Some(StagedPath {
                status,
                path: path.to_string(),
            })
        })
        .collect()
}

/// Branch, staged paths and the tip message for the commit panel.
#[tauri::command]
pub fn git_commit_info(root: String) -> Result<CommitInfo, String> {
    let has_head = git_in(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    // `symbolic-ref` answers on an unborn branch too, where `rev-parse --abbrev-ref HEAD` fails.
    let branch = git_in(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let staged = parse_name_status(&git_in(&root, &["diff", "--cached", "--name-status"])?);
    let last_message = if has_head {
        git_in(&root, &["log", "-1", "--format=%B"])?
            .trim_end()
            .to_string()
    } else {
        String::new()
    };
    Ok(CommitInfo {
        branch,
        has_head,
        staged,
        last_message,
    })
}

/// The `git commit` argument list for a message / amend / sign-off choice. An empty message is only
/// valid for an amend, where it means "keep the tip's message" (`--no-edit`). Pure — unit tested.
fn commit_args(message: &str, amend: bool, sign_off: bool) -> Result<Vec<String>, String> {
    let msg = message.trim();
    if msg.is_empty() && !amend {
        return Err("commit message is empty".into());
    }
    let mut args = vec!["commit".to_string(), "-q".to_string()];
    if amend {
        args.push("--amend".into());
    }
    if sign_off {
        args.push("--signoff".into());
    }
    if msg.is_empty() {
        args.push("--no-edit".into());
    } else {
        args.push("-m".into());
        args.push(msg.to_string());
    }
    Ok(args)
}

#[derive(Serialize, Debug)]
pub struct CommitResult {
    pub hash: String,
    /// First 8 characters of `hash`, for the toast.
    pub short: String,
    pub subject: String,
}

/// Commit the staged index. Refuses a non-amend commit with nothing staged (git's own refusal is a
/// multi-line status dump; this states the reason). Returns the new tip.
#[tauri::command]
pub fn git_commit(
    root: String,
    message: String,
    amend: Option<bool>,
    sign_off: Option<bool>,
) -> Result<CommitResult, String> {
    let amend = amend.unwrap_or(false);
    let args = commit_args(&message, amend, sign_off.unwrap_or(false))?;
    if !amend
        && parse_name_status(&git_in(&root, &["diff", "--cached", "--name-status"])?).is_empty()
    {
        return Err("nothing staged to commit".into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git_in(&root, &refs)?;
    let hash = git_in(&root, &["rev-parse", "HEAD"])?.trim().to_string();
    let subject = git_in(&root, &["log", "-1", "--format=%s"])?
        .trim()
        .to_string();
    Ok(CommitResult {
        short: hash.chars().take(8).collect(),
        hash,
        subject,
    })
}

// ── tags ───────────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct Tag {
    pub name: String,
    /// True for an annotated tag object, false for a lightweight ref straight to a commit.
    pub annotated: bool,
    /// Abbreviated hash of the commit the tag resolves to.
    pub target: String,
    /// Tagger date (annotated) or commit date (lightweight), `YYYY-MM-DD`.
    pub date: String,
    /// Tag message subject (annotated) or the commit subject (lightweight).
    pub subject: String,
}

/// `for-each-ref` format: name, object type, own object, peeled object, creator date, subject.
/// For an annotated tag `%(objecttype)` is `tag` and `%(*objectname)` is the commit it peels to;
/// for a lightweight tag the ref already names the commit and the peeled field is empty.
const TAG_FORMAT: &str = "--format=%(refname:short)\x1f%(objecttype)\x1f%(objectname:short)\x1f%(*objectname:short)\x1f%(creatordate:short)\x1f%(contents:subject)";

/// Parse the `TAG_FORMAT` stream. Pure — unit tested.
fn parse_tags(out: &str) -> Vec<Tag> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\x1f').collect();
            if f.len() < 6 || f[0].is_empty() {
                return None;
            }
            let annotated = f[1] == "tag";
            let target = if annotated && !f[3].is_empty() {
                f[3]
            } else {
                f[2]
            };
            Some(Tag {
                name: f[0].to_string(),
                annotated,
                target: target.to_string(),
                date: f[4].to_string(),
                subject: f[5].to_string(),
            })
        })
        .collect()
}

/// Every tag, newest first.
#[tauri::command]
pub fn git_tags(root: String) -> Result<Vec<Tag>, String> {
    let out = git_in(
        &root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            TAG_FORMAT,
            "refs/tags",
        ],
    )?;
    Ok(parse_tags(&out))
}

/// The `git tag` argument list. Annotated (`-a -m`) when `message` is non-blank, lightweight
/// otherwise; `rev` defaults to HEAD. Pure — unit tested.
fn tag_create_args(name: &str, message: &str, rev: &str) -> Result<Vec<String>, String> {
    if !valid_ref(name) {
        return Err("invalid tag name".into());
    }
    let rev = rev.trim();
    if !rev.is_empty() && !valid_ref(rev) {
        return Err("invalid revision".into());
    }
    let mut args = vec!["tag".to_string()];
    let msg = message.trim();
    if !msg.is_empty() {
        args.push("-a".into());
        args.push("-m".into());
        args.push(msg.to_string());
    }
    args.push(name.to_string());
    if !rev.is_empty() {
        args.push(rev.to_string());
    }
    Ok(args)
}

/// Create a tag at `rev` (HEAD when omitted). Fails (git's message) when the name already exists.
#[tauri::command]
pub fn git_tag_create(
    root: String,
    name: String,
    message: Option<String>,
    rev: Option<String>,
) -> Result<(), String> {
    let args = tag_create_args(
        &name,
        message.as_deref().unwrap_or(""),
        rev.as_deref().unwrap_or(""),
    )?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git_in(&root, &refs).map(|_| ())
}

/// Delete a tag (`git tag -d`). Confirmed in the UI: an annotated tag's message is lost with it.
#[tauri::command]
pub fn git_tag_delete(root: String, name: String) -> Result<(), String> {
    if !valid_ref(&name) {
        return Err("invalid tag name".into());
    }
    git_in(&root, &["tag", "-d", &name]).map(|_| ())
}

/// The tag object (when annotated) plus the commit and diff it points at. The fully qualified
/// `refs/tags/` name keeps a same-named branch or path from being picked instead.
#[tauri::command]
pub fn git_tag_show(root: String, name: String) -> Result<String, String> {
    if !valid_ref(&name) {
        return Err("invalid tag name".into());
    }
    git_in(&root, &["show", &format!("refs/tags/{name}"), "--"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_takes_rename_destination() {
        let rows = parse_name_status("M\tsrc/a.rs\nR087\told.txt\tnew.txt\nA\tb c.md\n");
        let got: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.status.as_str(), r.path.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![("M", "src/a.rs"), ("R", "new.txt"), ("A", "b c.md")]
        );
        assert!(parse_name_status("").is_empty());
    }

    #[test]
    fn commit_args_message_amend_signoff() {
        assert_eq!(
            commit_args("  fix: x  ", false, false).unwrap(),
            vec!["commit", "-q", "-m", "fix: x"]
        );
        assert!(commit_args("   ", false, false).is_err());
        // An empty amend keeps the tip's message rather than erroring.
        assert_eq!(
            commit_args("", true, true).unwrap(),
            vec!["commit", "-q", "--amend", "--signoff", "--no-edit"]
        );
        // A message that looks like a flag is still a message: it is the value of -m.
        assert_eq!(
            commit_args("--force", false, false).unwrap(),
            vec!["commit", "-q", "-m", "--force"]
        );
    }

    #[test]
    fn tag_args_annotated_vs_lightweight_and_guards() {
        assert_eq!(
            tag_create_args("v1.0", "", "").unwrap(),
            vec!["tag", "v1.0"]
        );
        assert_eq!(
            tag_create_args("v1.0", "release", "HEAD~1").unwrap(),
            vec!["tag", "-a", "-m", "release", "v1.0", "HEAD~1"]
        );
        assert!(tag_create_args("-d", "", "").is_err());
        assert!(tag_create_args("v 1", "", "").is_err());
        assert!(tag_create_args("v1", "", "--all").is_err());
    }

    #[test]
    fn parse_tags_peels_annotated_only() {
        let out = "v2\x1ftag\x1faaaa111\x1fbbbb222\x1f2026-01-02\x1frelease two\n\
                   v1\x1fcommit\x1fcccc333\x1f\x1f2025-12-31\x1finitial\n\
                   \x1f\x1f\x1f\x1f\x1f\n";
        let tags = parse_tags(out);
        assert_eq!(tags.len(), 2);
        assert!(tags[0].annotated);
        assert_eq!(
            tags[0].target, "bbbb222",
            "annotated tag reports the commit, not the tag object"
        );
        assert!(!tags[1].annotated);
        assert_eq!(tags[1].target, "cccc333");
        assert_eq!(tags[1].subject, "initial");
    }

    // End-to-end against a throwaway repo: commit, amend, tag (both kinds), show, delete. Skipped
    // when `git` is not on PATH.
    #[test]
    fn commit_and_tag_roundtrip_in_temp_repo() {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-gitops-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        if git_in(&root, &["init", "-q"]).is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let _ = git_in(&root, &["config", "user.email", "t@t"]);
        let _ = git_in(&root, &["config", "user.name", "t"]);
        let _ = git_in(&root, &["config", "tag.gpgSign", "false"]);
        let _ = git_in(&root, &["config", "commit.gpgSign", "false"]);

        // Unborn branch: no head, nothing staged, and a commit is refused with a stated reason.
        let info = git_commit_info(root.clone()).unwrap();
        assert!(!info.has_head);
        assert!(info.staged.is_empty());
        assert_eq!(
            git_commit(root.clone(), "x".into(), None, None).unwrap_err(),
            "nothing staged to commit"
        );

        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        git_in(&root, &["add", "f.txt"]).unwrap();
        let info = git_commit_info(root.clone()).unwrap();
        assert_eq!(info.staged.len(), 1);
        assert_eq!(info.staged[0].path, "f.txt");
        assert_eq!(info.staged[0].status, "A");

        let c1 = git_commit(root.clone(), "first\n\nbody".into(), None, None).unwrap();
        assert_eq!(c1.subject, "first");
        let info = git_commit_info(root.clone()).unwrap();
        assert!(info.has_head);
        assert_eq!(info.last_message, "first\n\nbody");

        // Amend with a new message rewrites the tip; with none it keeps the message.
        let c2 = git_commit(root.clone(), "first, amended".into(), Some(true), None).unwrap();
        assert_ne!(c1.hash, c2.hash);
        assert_eq!(c2.subject, "first, amended");
        let count = git_in(&root, &["rev-list", "--count", "HEAD"]).unwrap();
        assert_eq!(count.trim(), "1", "amend must not add a commit");
        let c3 = git_commit(root.clone(), String::new(), Some(true), Some(true)).unwrap();
        assert_eq!(c3.subject, "first, amended");
        let body = git_in(&root, &["log", "-1", "--format=%B"]).unwrap();
        assert!(body.contains("Signed-off-by: t <t@t>"), "{body}");

        // Tags: one lightweight, one annotated; both resolve to the tip commit.
        git_tag_create(root.clone(), "light".into(), None, None).unwrap();
        git_tag_create(
            root.clone(),
            "v1.0".into(),
            Some("release one".into()),
            None,
        )
        .unwrap();
        let tags = git_tags(root.clone()).unwrap();
        assert_eq!(tags.len(), 2);
        let short = &c3.hash[..7];
        for t in &tags {
            assert!(
                t.target.starts_with(short) || short.starts_with(&t.target),
                "{t:?}"
            );
        }
        let ann = tags.iter().find(|t| t.name == "v1.0").unwrap();
        assert!(ann.annotated);
        assert_eq!(ann.subject, "release one");
        assert!(!tags.iter().find(|t| t.name == "light").unwrap().annotated);
        assert!(git_tag_show(root.clone(), "v1.0".into())
            .unwrap()
            .contains("release one"));
        // A duplicate name is git's refusal, surfaced.
        assert!(git_tag_create(root.clone(), "light".into(), None, None).is_err());

        git_tag_delete(root.clone(), "light".into()).unwrap();
        let names: Vec<String> = git_tags(root.clone())
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, vec!["v1.0"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
