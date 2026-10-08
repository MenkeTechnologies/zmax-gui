//! Line-range history — Emacs `vc-region-history` / `magit-log-trace-definition`: the commits that
//! changed a range of lines (or one function) in a file, each with the patch restricted to that
//! range, following the range as it moves through the file (`git log -L`).
//!
//! Two ways to name the range, as `git log -L` has:
//!
//! * **lines** `start..=end` (1-based, inclusive) — `-L<start>,<end>:<path>`;
//! * **function** — a regex git matches against the file's function headers (the userdiff driver
//!   for its language), `-L:<funcname>:<path>` — so the range is the whole function however long
//!   it grew.
//!
//! The range and the path travel glued into one `-L` argument, so neither can be read as an option.

use crate::git_ext::git_in;
use crate::git_more::fmt_date;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Default)]
pub struct LineLogOpts {
    /// First line, 1-based. With `end`, names a line range; ignored when `funcname` is set.
    pub start: Option<usize>,
    /// Last line, inclusive.
    pub end: Option<usize>,
    /// A function-name regex instead of a line range.
    pub funcname: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Serialize, Debug)]
pub struct LineCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Author date, `YYYY-MM-DD`.
    pub date: String,
    pub subject: String,
    /// The diff this commit made to the traced range (only that range, not the whole commit).
    pub patch: String,
}

/// The `-L` argument. Pure — unit tested.
fn range_arg(path: &str, o: &LineLogOpts) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("no file to trace".into());
    }
    if path.contains('\0') {
        return Err("path contains a NUL byte".into());
    }
    if let Some(f) = o
        .funcname
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        // git ends the regex at the next ':' — a ':' inside it would move part of the regex into
        // the path.
        if f.contains(':') || f.contains('\0') {
            return Err("a function name cannot contain ':'".into());
        }
        return Ok(format!("-L:{f}:{path}"));
    }
    match (o.start, o.end) {
        (Some(s), Some(e)) if s >= 1 && e >= s => Ok(format!("-L{s},{e}:{path}")),
        (Some(s), None) if s >= 1 => Ok(format!("-L{s},{s}:{path}")),
        _ => Err("give a function name, or a line range with 1 <= start <= end".into()),
    }
}

const SEP: char = '\x1e';

/// Split `git log -L` output, produced with `--format=%x1e%H%x1f%an%x1f%at%x1f%s`, into commits:
/// each record is the header line followed by that commit's range patch. Pure — unit tested.
fn parse_line_log(out: &str) -> Vec<LineCommit> {
    out.split(SEP)
        .filter_map(|rec| {
            let (head, patch) = rec.split_once('\n').unwrap_or((rec, ""));
            let mut f = head.split('\x1f');
            let (hash, author, at, subject) = (f.next()?, f.next()?, f.next()?, f.next()?);
            if hash.len() < 7 {
                return None;
            }
            Some(LineCommit {
                short: hash.chars().take(8).collect(),
                hash: hash.to_string(),
                author: author.to_string(),
                date: fmt_date(at.trim().parse().unwrap_or(0)),
                subject: subject.to_string(),
                patch: patch.trim_matches('\n').to_string(),
            })
        })
        .collect()
}

/// The commits that changed a line range (or a function) of `path`, newest first, each with the
/// patch restricted to the range.
#[tauri::command]
pub fn git_log_lines(
    root: String,
    path: String,
    opts: LineLogOpts,
) -> Result<Vec<LineCommit>, String> {
    let range = range_arg(&path, &opts)?;
    let max = format!("-n{}", opts.limit.unwrap_or(100).clamp(1, 2000));
    let out = git_in(
        &root,
        &[
            "log",
            &max,
            "--format=%x1e%H%x1f%an%x1f%at%x1f%s",
            "--no-color",
            &range,
        ],
    )?;
    Ok(parse_line_log(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: usize, e: usize) -> LineLogOpts {
        LineLogOpts {
            start: Some(s),
            end: Some(e),
            ..Default::default()
        }
    }

    #[test]
    fn range_arg_forms() {
        assert_eq!(
            range_arg("src/a:b.rs", &lines(3, 9)).unwrap(),
            "-L3,9:src/a:b.rs"
        );
        let one = LineLogOpts {
            start: Some(4),
            ..Default::default()
        };
        assert_eq!(range_arg("a.rs", &one).unwrap(), "-L4,4:a.rs");
        let f = LineLogOpts {
            funcname: Some(" parse ".into()),
            ..lines(1, 2)
        };
        assert_eq!(
            range_arg("a.rs", &f).unwrap(),
            "-L:parse:a.rs",
            "a function wins over lines"
        );
        assert!(range_arg("a.rs", &lines(5, 4)).is_err());
        assert!(
            range_arg("a.rs", &lines(0, 4)).is_err(),
            "lines are 1-based"
        );
        assert!(range_arg("", &lines(1, 1)).is_err());
        let colon = LineLogOpts {
            funcname: Some("a:b".into()),
            ..Default::default()
        };
        assert!(range_arg("a.rs", &colon).is_err());
        assert!(range_arg("a.rs", &LineLogOpts::default()).is_err());
    }

    #[test]
    fn records_split_on_the_separator() {
        let out = "\x1eaaaaaaaaaa\x1fann\x1f1609459200\x1fsecond: x\n\ndiff --git a/f b/f\n@@ -2,1 +2,1 @@\n-1\n+2\n\
                   \x1ebbbbbbbbbb\x1fbob\x1f0\x1ffirst\n\ndiff --git a/f b/f\n@@ -0,0 +2,1 @@\n+1\n";
        let c = parse_line_log(out);
        assert_eq!(c.len(), 2);
        assert_eq!(
            (c[0].subject.as_str(), c[0].date.as_str()),
            ("second: x", "2021-01-01")
        );
        assert!(c[0].patch.starts_with("diff --git") && c[0].patch.ends_with("+2"));
        assert_eq!(c[1].author, "bob");
        assert_eq!(c[1].short, "bbbbbbbb");
    }

    // The traced range follows the function as lines are inserted above it, and a commit that only
    // touched other lines is not in its history.
    #[test]
    fn traces_a_range_and_a_function_through_real_history() {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-trace-{}-{}",
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
            return;
        }
        for (k, v) in [
            ("user.email", "t@t"),
            ("user.name", "t"),
            ("commit.gpgSign", "false"),
        ] {
            git_in(&root, &["config", k, v]).unwrap();
        }
        let commit = |body: &str, msg: &str| {
            std::fs::write(dir.join("m.c"), body).unwrap();
            git_in(&root, &["add", "m.c"]).unwrap();
            git_in(&root, &["commit", "-q", "-m", msg]).unwrap();
        };
        commit("int a;\n\nint f(void)\n{\n  return 1;\n}\n", "add f");
        commit(
            "int a;\nint b;\nint c;\n\nint f(void)\n{\n  return 1;\n}\n",
            "globals above",
        );
        commit(
            "int a;\nint b;\nint c;\n\nint f(void)\n{\n  return 2;\n}\n",
            "f returns 2",
        );

        let by_fn = git_log_lines(
            root.clone(),
            "m.c".into(),
            LineLogOpts {
                funcname: Some("^int f".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let subjects: Vec<&str> = by_fn.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(
            subjects,
            ["f returns 2", "add f"],
            "the globals commit did not touch f"
        );
        assert!(
            by_fn[0].patch.contains("+  return 2;"),
            "{}",
            by_fn[0].patch
        );

        // Line 7 now (`return 2;`) was line 5 when it was first written: the range moved with it.
        let by_line = git_log_lines(root.clone(), "m.c".into(), lines(7, 7)).unwrap();
        let subjects: Vec<&str> = by_line.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["f returns 2", "add f"]);

        // Past the end of the file is git's refusal, surfaced as an error.
        assert!(git_log_lines(root.clone(), "m.c".into(), lines(50, 60)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
