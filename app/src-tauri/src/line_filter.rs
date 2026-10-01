//! Line filters — the Emacs line-deletion family applied to a file on disk, beside the reordering
//! (`text_tools.rs` sort) and reshaping (`edit_ops.rs` align / comment) transforms:
//!
//! * **Keep / flush lines** — Emacs `keep-lines` / `flush-lines`: delete every line that does NOT
//!   match a pattern, or every line that DOES. Literal or regex, optionally case-insensitive.
//! * **Delete duplicate lines** — Emacs `delete-duplicate-lines`: drop repeated lines while keeping
//!   the file's order (unlike Sort Lines' *unique*, which only works on a sorted file). Keeps the
//!   first occurrence by default or the last (`keep_last`), can restrict itself to adjacent runs
//!   (`adjacent_only`, a `uniq` without the sort), and can leave blank lines alone (`keep_blanks`).
//!   Comparison can fold case and ignore surrounding whitespace.
//!
//! Both report what they would remove — count plus the first lines with their original line numbers
//! — and only the `apply` path writes. The file's dominant line ending and its trailing-newline
//! state are preserved; binary and oversized files are refused, like every other file transform.

use crate::project::{looks_binary, MAX_GREP_FILE_BYTES};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// How many removed lines a preview carries back. The count is always exact; only the listing is
/// capped.
const SAMPLE_CAP: usize = 200;

#[derive(Serialize, Debug, PartialEq)]
pub struct RemovedLine {
    /// 1-based line number in the file as it is before the edit.
    pub line: usize,
    pub text: String,
}

#[derive(Serialize, Debug)]
pub struct LineEditResult {
    pub lines_before: usize,
    pub lines_after: usize,
    pub removed: usize,
    /// The first `SAMPLE_CAP` removed lines.
    pub sample: Vec<RemovedLine>,
    /// True when `removed` exceeds the sample.
    pub sample_truncated: bool,
    pub differs: bool,
    pub applied: bool,
}

/// A text file split into lines, with what is needed to put it back together byte-for-byte.
struct Lines<'a> {
    lines: Vec<&'a str>,
    eol: &'static str,
    trailing_nl: bool,
}

fn split(content: &str) -> Lines<'_> {
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let trailing_nl = content.ends_with('\n');
    let mut lines: Vec<&str> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if trailing_nl || content.is_empty() {
        lines.pop();
    }
    Lines {
        lines,
        eol,
        trailing_nl,
    }
}

/// Rejoin the lines the mask keeps. A file that ended in a newline still does, unless nothing is
/// left at all.
fn join_kept(src: &Lines, keep: &[bool]) -> String {
    let kept: Vec<&str> = src
        .lines
        .iter()
        .zip(keep)
        .filter_map(|(l, k)| k.then_some(*l))
        .collect();
    let mut out = kept.join(src.eol);
    if src.trailing_nl && !kept.is_empty() {
        out.push_str(src.eol);
    }
    out
}

// ── keep / flush lines ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct FilterOpts {
    pub pattern: String,
    /// true = keep matching lines (`keep-lines`); false = delete them (`flush-lines`).
    pub keep: Option<bool>,
    pub regex: Option<bool>,
    pub case_insensitive: Option<bool>,
    pub apply: Option<bool>,
}

/// Compile the pattern (escaped unless `regex`). An empty pattern matches every line, which would
/// make keep a no-op and flush an erase-all — refused rather than guessed at.
fn filter_regex(opts: &FilterOpts) -> Result<regex::Regex, String> {
    if opts.pattern.is_empty() {
        return Err("pattern is empty".into());
    }
    let src = if opts.regex.unwrap_or(false) {
        opts.pattern.clone()
    } else {
        regex::escape(&opts.pattern)
    };
    regex::RegexBuilder::new(&src)
        .case_insensitive(opts.case_insensitive.unwrap_or(false))
        .build()
        .map_err(|e| format!("invalid regex: {e}"))
}

/// Keep mask for keep/flush. Pure — unit tested.
fn filter_mask(lines: &[&str], re: &regex::Regex, keep_matching: bool) -> Vec<bool> {
    lines
        .iter()
        .map(|l| re.is_match(l) == keep_matching)
        .collect()
}

// ── delete duplicate lines ─────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct DedupeOpts {
    /// Keep the last occurrence of each line instead of the first.
    pub keep_last: Option<bool>,
    /// Only collapse runs of identical neighbouring lines.
    pub adjacent_only: Option<bool>,
    pub case_insensitive: Option<bool>,
    /// Compare lines with leading/trailing whitespace ignored.
    pub trim: Option<bool>,
    /// Never delete blank lines (so paragraph spacing survives).
    pub keep_blanks: Option<bool>,
    pub apply: Option<bool>,
}

/// Keep mask for delete-duplicate-lines. Pure — unit tested.
fn dedupe_mask(lines: &[&str], opts: &DedupeOpts) -> Vec<bool> {
    let fold = opts.case_insensitive.unwrap_or(false);
    let trim = opts.trim.unwrap_or(false);
    let keep_blanks = opts.keep_blanks.unwrap_or(false);
    let keys: Vec<String> = lines
        .iter()
        .map(|l| {
            let s = if trim { l.trim() } else { l };
            if fold {
                s.to_lowercase()
            } else {
                s.to_string()
            }
        })
        .collect();
    let protected = |i: usize| keep_blanks && lines[i].trim().is_empty();
    let n = lines.len();
    let mut keep = vec![true; n];

    // Walk from the end when the last occurrence is the one that survives.
    let order: Vec<usize> = if opts.keep_last.unwrap_or(false) {
        (0..n).rev().collect()
    } else {
        (0..n).collect()
    };
    if opts.adjacent_only.unwrap_or(false) {
        // `prev` is the previously visited line in walk order, so a run keeps its first-visited
        // member: the top of the run, or the bottom when walking backwards.
        let mut prev: Option<usize> = None;
        for i in order {
            if let Some(p) = prev {
                if keys[i] == keys[p] && !protected(i) {
                    keep[i] = false;
                }
            }
            prev = Some(i);
        }
    } else {
        let mut seen: HashSet<&str> = HashSet::new();
        for i in order {
            if protected(i) {
                continue;
            }
            if !seen.insert(keys[i].as_str()) {
                keep[i] = false;
            }
        }
    }
    keep
}

// ── shared preview / apply ─────────────────────────────────────────────────────────────────────────

fn read_text(path: &Path) -> Result<String, String> {
    if fs::metadata(path)
        .map(|m| m.len() > MAX_GREP_FILE_BYTES)
        .unwrap_or(true)
    {
        return Err("file too large or unreadable".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

/// Apply a keep mask to `content`: the rewritten text and the report (minus `applied`).
fn edit_with_mask(
    content: &str,
    mask_of: impl FnOnce(&[&str]) -> Vec<bool>,
) -> (String, LineEditResult) {
    let src = split(content);
    let keep = mask_of(&src.lines);
    let out = join_kept(&src, &keep);
    let mut sample = Vec::new();
    let mut removed = 0usize;
    for (i, (line, k)) in src.lines.iter().zip(&keep).enumerate() {
        if !k {
            removed += 1;
            if sample.len() < SAMPLE_CAP {
                sample.push(RemovedLine {
                    line: i + 1,
                    text: (*line).to_string(),
                });
            }
        }
    }
    let differs = out != content;
    let res = LineEditResult {
        lines_before: src.lines.len(),
        lines_after: src.lines.len() - removed,
        removed,
        sample_truncated: removed > SAMPLE_CAP,
        sample,
        differs,
        applied: false,
    };
    (out, res)
}

fn finish(
    path: &Path,
    out: String,
    mut res: LineEditResult,
    apply: bool,
) -> Result<LineEditResult, String> {
    if apply && res.differs {
        fs::write(path, out.as_bytes()).map_err(|e| e.to_string())?;
        res.applied = true;
    }
    Ok(res)
}

/// Preview (or apply) keep-lines / flush-lines over one file.
#[tauri::command]
pub fn filter_file_lines(path: String, opts: FilterOpts) -> Result<LineEditResult, String> {
    let re = filter_regex(&opts)?;
    let p = Path::new(&path);
    let content = read_text(p)?;
    let keep_matching = opts.keep.unwrap_or(true);
    let (out, res) = edit_with_mask(&content, |lines| filter_mask(lines, &re, keep_matching));
    finish(p, out, res, opts.apply.unwrap_or(false))
}

/// Preview (or apply) delete-duplicate-lines over one file.
#[tauri::command]
pub fn dedupe_file_lines(path: String, opts: Option<DedupeOpts>) -> Result<LineEditResult, String> {
    let opts = opts.unwrap_or_default();
    let p = Path::new(&path);
    let content = read_text(p)?;
    let (out, res) = edit_with_mask(&content, |lines| dedupe_mask(lines, &opts));
    finish(p, out, res, opts.apply.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_filter(content: &str, opts: &FilterOpts) -> String {
        let re = filter_regex(opts).unwrap();
        edit_with_mask(content, |l| filter_mask(l, &re, opts.keep.unwrap_or(true))).0
    }

    fn run_dedupe(content: &str, opts: &DedupeOpts) -> String {
        edit_with_mask(content, |l| dedupe_mask(l, opts)).0
    }

    #[test]
    fn keep_and_flush_are_complements() {
        let src = "use a;\nfn x() {}\nuse b;\n";
        let keep = FilterOpts {
            pattern: "use ".into(),
            ..Default::default()
        };
        assert_eq!(run_filter(src, &keep), "use a;\nuse b;\n");
        let flush = FilterOpts {
            pattern: "use ".into(),
            keep: Some(false),
            ..Default::default()
        };
        assert_eq!(run_filter(src, &flush), "fn x() {}\n");
    }

    #[test]
    fn literal_pattern_is_escaped_and_regex_is_not() {
        let src = "a.b\naxb\n";
        let lit = FilterOpts {
            pattern: "a.b".into(),
            ..Default::default()
        };
        assert_eq!(
            run_filter(src, &lit),
            "a.b\n",
            "literal '.' must not match 'x'"
        );
        let rx = FilterOpts {
            pattern: "^a.b$".into(),
            regex: Some(true),
            ..Default::default()
        };
        assert_eq!(run_filter(src, &rx), src);
        let ci = FilterOpts {
            pattern: "TODO".into(),
            case_insensitive: Some(true),
            ..Default::default()
        };
        assert_eq!(run_filter("todo: x\nok\n", &ci), "todo: x\n");
    }

    #[test]
    fn empty_and_invalid_patterns_are_refused() {
        assert!(filter_regex(&FilterOpts::default()).is_err());
        let bad = FilterOpts {
            pattern: "(".into(),
            regex: Some(true),
            ..Default::default()
        };
        assert!(filter_regex(&bad).unwrap_err().starts_with("invalid regex"));
    }

    #[test]
    fn crlf_and_missing_final_newline_are_preserved() {
        let flush = FilterOpts {
            pattern: "x".into(),
            keep: Some(false),
            ..Default::default()
        };
        assert_eq!(run_filter("a\r\nx\r\nb\r\n", &flush), "a\r\nb\r\n");
        assert_eq!(run_filter("a\nx\nb", &flush), "a\nb");
        // Removing everything leaves an empty file, not a lone newline.
        let all = FilterOpts {
            pattern: "".into(),
            regex: Some(true),
            ..Default::default()
        };
        assert!(filter_regex(&all).is_err());
        let wipe = FilterOpts {
            pattern: "x".into(),
            keep: Some(true),
            ..Default::default()
        };
        assert_eq!(run_filter("a\nb\n", &wipe), "");
    }

    #[test]
    fn dedupe_keeps_order_first_or_last() {
        let src = "b\na\nb\nc\na\n";
        assert_eq!(run_dedupe(src, &DedupeOpts::default()), "b\na\nc\n");
        let last = DedupeOpts {
            keep_last: Some(true),
            ..Default::default()
        };
        assert_eq!(run_dedupe(src, &last), "b\nc\na\n");
    }

    #[test]
    fn dedupe_adjacent_only_is_uniq() {
        let src = "a\na\nb\na\na\n";
        let adj = DedupeOpts {
            adjacent_only: Some(true),
            ..Default::default()
        };
        assert_eq!(run_dedupe(src, &adj), "a\nb\na\n");
        // keep_last within a run keeps the run's last member — visible once case is folded.
        let adj_last = DedupeOpts {
            adjacent_only: Some(true),
            keep_last: Some(true),
            case_insensitive: Some(true),
            ..Default::default()
        };
        assert_eq!(run_dedupe("x\nX\ny\n", &adj_last), "X\ny\n");
    }

    #[test]
    fn dedupe_fold_trim_and_blank_protection() {
        let fold = DedupeOpts {
            case_insensitive: Some(true),
            trim: Some(true),
            ..Default::default()
        };
        assert_eq!(run_dedupe("Foo\n  foo \nbar\n", &fold), "Foo\nbar\n");
        let src = "p1\n\np2\n\np3\n";
        assert_eq!(run_dedupe(src, &DedupeOpts::default()), "p1\n\np2\np3\n");
        let blanks = DedupeOpts {
            keep_blanks: Some(true),
            ..Default::default()
        };
        assert_eq!(run_dedupe(src, &blanks), src);
    }

    #[test]
    fn report_counts_and_original_line_numbers() {
        let (_, r) = edit_with_mask("a\nb\na\nb\n", |l| dedupe_mask(l, &DedupeOpts::default()));
        assert_eq!((r.lines_before, r.lines_after, r.removed), (4, 2, 2));
        assert_eq!(
            r.sample,
            vec![
                RemovedLine {
                    line: 3,
                    text: "a".into()
                },
                RemovedLine {
                    line: 4,
                    text: "b".into()
                },
            ]
        );
        assert!(r.differs && !r.sample_truncated);
        let many: String = (0..SAMPLE_CAP + 5).map(|_| "dup\n").collect();
        let (_, r) = edit_with_mask(&many, |l| dedupe_mask(l, &DedupeOpts::default()));
        assert_eq!(r.removed, SAMPLE_CAP + 4);
        assert_eq!(r.sample.len(), SAMPLE_CAP);
        assert!(r.sample_truncated);
    }

    #[test]
    fn commands_preview_without_writing_and_apply_writes() {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-linefilter-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.txt");
        fs::write(&f, "a\nb\na\n").unwrap();
        let path = f.to_string_lossy().into_owned();

        let r = dedupe_file_lines(path.clone(), None).unwrap();
        assert!(r.differs && !r.applied);
        assert_eq!(
            fs::read_to_string(&f).unwrap(),
            "a\nb\na\n",
            "preview wrote the file"
        );

        let r = dedupe_file_lines(
            path.clone(),
            Some(DedupeOpts {
                apply: Some(true),
                ..Default::default()
            }),
        )
        .unwrap();
        assert!(r.applied);
        assert_eq!(fs::read_to_string(&f).unwrap(), "a\nb\n");

        let r = filter_file_lines(
            path.clone(),
            FilterOpts {
                pattern: "b".into(),
                keep: Some(false),
                apply: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.applied);
        assert_eq!(fs::read_to_string(&f).unwrap(), "a\n");

        // A no-op apply reports applied:false (so the reversible bus verb releases its snapshot).
        let r = filter_file_lines(
            path.clone(),
            FilterOpts {
                pattern: "zzz".into(),
                keep: Some(false),
                apply: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!r.differs && !r.applied);

        fs::write(&f, b"a\0b").unwrap();
        assert_eq!(dedupe_file_lines(path, None).unwrap_err(), "binary file");
        let _ = fs::remove_dir_all(&dir);
    }
}
