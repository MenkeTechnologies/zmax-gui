//! Merge conflicts — Emacs `smerge-mode` over the project tree instead of one buffer:
//!
//! * **Scan** — every text file under the root that carries conflict markers, with each hunk's
//!   line span, the labels git wrote on its marker lines, and the text of each side (`ours`, the
//!   diff3 / zdiff3 `base` when present, `theirs`). The markers come from any producer — a merge,
//!   a rebase, a cherry-pick or revert, a `stash pop` — so the scan does not ask git which paths
//!   are unmerged; it reads the files.
//! * **Resolve** — rewrite one hunk (or every hunk) of a file to the chosen side: `ours`
//!   (`smerge-keep-upper`), `theirs` (`smerge-keep-lower`), `base` (`smerge-keep-base`, diff3 hunks
//!   only), `both` (ours then theirs, git's union merge) or `all` (`smerge-keep-all`: ours, base,
//!   theirs). A preview reports what would change and writes nothing; only `apply` writes.
//!
//! A marker is exactly seven marker characters followed by a space or the end of the line, the way
//! git writes them — so a Markdown `========` rule or a `<<<<<<<<` banner is not mistaken for one.
//! A file whose markers do not close (an opening marker with no `=======`, a separator with no
//! closing marker, a nested opening marker) is reported as **malformed** and refused for resolution:
//! guessing where a broken hunk ends would rewrite text that was never part of it. The file's line
//! ending and final-newline state survive a resolution, like every other file transform here.

use crate::line_filter::{read_text, split};
use crate::project::{looks_binary, walk_files, MAX_GREP_FILE_BYTES};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// How many lines of each side a scan carries back per hunk. The counts are always exact.
const SIDE_CAP: usize = 400;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Hunk {
    /// 0-based position among the file's hunks — the address `resolve_conflicts` takes.
    pub index: usize,
    /// 1-based line of the `<<<<<<<` marker.
    pub start_line: usize,
    /// 1-based line of the `>>>>>>>` marker.
    pub end_line: usize,
    /// Text after the opening marker (`HEAD`, a branch, a commit and subject).
    pub ours_label: String,
    /// Text after the closing marker.
    pub theirs_label: String,
    /// Text after the `|||||||` marker; `None` when the hunk is not in diff3 style.
    pub base_label: Option<String>,
    pub ours: Vec<String>,
    /// `None` when the hunk has no base section (plain `merge` conflict style).
    pub base: Option<Vec<String>>,
    pub theirs: Vec<String>,
    pub ours_lines: usize,
    pub base_lines: usize,
    pub theirs_lines: usize,
}

/// The parse of one file: its hunks in order, or why it cannot be resolved safely.
#[derive(Debug, PartialEq)]
struct Parsed {
    hunks: Vec<Span>,
    /// `Some((line, reason))` when the markers do not form well-nested hunks.
    malformed: Option<(usize, String)>,
}

/// One hunk's line indices (0-based) within the file's line vector.
#[derive(Debug, Clone, PartialEq)]
struct Span {
    open: usize,
    base: Option<usize>,
    sep: usize,
    close: usize,
}

/// `Some(label)` when `line` is the marker `ch` repeated exactly seven times, then a space and a
/// label or nothing at all. Pure — unit tested.
fn marker<'a>(line: &'a str, ch: char) -> Option<&'a str> {
    let mut chars = line.char_indices();
    for _ in 0..7 {
        match chars.next() {
            Some((_, c)) if c == ch => {}
            _ => return None,
        }
    }
    match chars.next() {
        None => Some(""),
        Some((i, ' ')) => Some(line[i + 1..].trim_end()),
        Some(_) => None,
    }
}

/// The separator is a bare `=======` (git writes nothing after it).
fn is_separator(line: &str) -> bool {
    line.trim_end() == "======="
}

/// Find every hunk in `lines`. Pure — unit tested.
fn parse(lines: &[&str]) -> Parsed {
    let mut hunks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if marker(lines[i], '<').is_none() {
            if marker(lines[i], '>').is_some() {
                return Parsed {
                    hunks,
                    malformed: Some((i + 1, "closing marker with no opening marker".into())),
                };
            }
            i += 1;
            continue;
        }
        let open = i;
        let (mut base, mut sep, mut close) = (None, None, None);
        let mut j = open + 1;
        while j < lines.len() {
            let l = lines[j];
            if marker(l, '<').is_some() {
                return Parsed {
                    hunks,
                    malformed: Some((j + 1, "nested opening marker".into())),
                };
            }
            if sep.is_none() && base.is_none() && marker(l, '|').is_some() {
                base = Some(j);
            } else if sep.is_none() && is_separator(l) {
                sep = Some(j);
            } else if marker(l, '>').is_some() {
                if sep.is_none() {
                    return Parsed {
                        hunks,
                        malformed: Some((
                            j + 1,
                            "closing marker before the ======= separator".into(),
                        )),
                    };
                }
                close = Some(j);
                break;
            }
            j += 1;
        }
        let (Some(sep), Some(close)) = (sep, close) else {
            return Parsed {
                hunks,
                malformed: Some((open + 1, "conflict is not closed".into())),
            };
        };
        hunks.push(Span {
            open,
            base,
            sep,
            close,
        });
        i = close + 1;
    }
    Parsed {
        hunks,
        malformed: None,
    }
}

fn capped(lines: &[&str]) -> Vec<String> {
    lines
        .iter()
        .take(SIDE_CAP)
        .map(|l| (*l).to_string())
        .collect()
}

fn describe(lines: &[&str], index: usize, s: &Span) -> Hunk {
    let ours_end = s.base.unwrap_or(s.sep);
    let ours = &lines[s.open + 1..ours_end];
    let base = s.base.map(|b| &lines[b + 1..s.sep]);
    let theirs = &lines[s.sep + 1..s.close];
    Hunk {
        index,
        start_line: s.open + 1,
        end_line: s.close + 1,
        ours_label: marker(lines[s.open], '<').unwrap_or("").to_string(),
        theirs_label: marker(lines[s.close], '>').unwrap_or("").to_string(),
        base_label: s
            .base
            .map(|b| marker(lines[b], '|').unwrap_or("").to_string()),
        ours: capped(ours),
        base: base.map(capped),
        theirs: capped(theirs),
        ours_lines: ours.len(),
        base_lines: base.map_or(0, <[&str]>::len),
        theirs_lines: theirs.len(),
    }
}

// ── scan ───────────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct ConflictFile {
    pub path: String,
    /// Path relative to the scanned root.
    pub rel: String,
    pub hunks: Vec<Hunk>,
    /// 1-based line where the markers stop making sense; such a file is listed but not resolvable.
    pub malformed_line: Option<usize>,
    pub malformed: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ConflictScan {
    pub files: Vec<ConflictFile>,
    /// Hunks across every listed file.
    pub total_hunks: usize,
    /// True when `limit` stopped the walk before the tree was exhausted.
    pub truncated: bool,
}

/// The conflicts in one text, or `None` when it carries no markers at all.
fn conflicts_in(path: &Path, root: &Path, content: &str) -> Option<ConflictFile> {
    // Cheap reject before splitting: no opening or closing marker run anywhere.
    if !content.contains("<<<<<<<") && !content.contains(">>>>>>>") {
        return None;
    }
    let src = split(content);
    let parsed = parse(&src.lines);
    if parsed.hunks.is_empty() && parsed.malformed.is_none() {
        return None;
    }
    let (malformed_line, malformed) = match parsed.malformed {
        Some((l, why)) => (Some(l), Some(why)),
        None => (None, None),
    };
    Some(ConflictFile {
        path: path.to_string_lossy().into_owned(),
        rel: path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned(),
        hunks: parsed
            .hunks
            .iter()
            .enumerate()
            .map(|(i, s)| describe(&src.lines, i, s))
            .collect(),
        malformed_line,
        malformed,
    })
}

/// Every file under `root` with conflict markers, in walk order, capped at `limit` files.
#[tauri::command]
pub fn conflict_scan(
    root: String,
    show_hidden: Option<bool>,
    limit: Option<usize>,
) -> Result<ConflictScan, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err("not a directory".into());
    }
    let limit = limit.unwrap_or(500).max(1);
    let mut files = Vec::new();
    let mut truncated = false;
    for path in walk_files(root_path, show_hidden.unwrap_or(false)) {
        if fs::metadata(&path)
            .map(|m| m.len() > MAX_GREP_FILE_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if looks_binary(&bytes) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        if let Some(f) = conflicts_in(&path, root_path, &content) {
            if files.len() == limit {
                truncated = true;
                break;
            }
            files.push(f);
        }
    }
    let total_hunks = files.iter().map(|f| f.hunks.len()).sum();
    Ok(ConflictScan {
        files,
        total_hunks,
        truncated,
    })
}

/// One file's conflicts (empty `hunks` when it has none).
#[tauri::command]
pub fn conflict_file(path: String) -> Result<ConflictFile, String> {
    let p = Path::new(&path);
    let content = read_text(p)?;
    let parent = p.parent().unwrap_or(p);
    Ok(conflicts_in(p, parent, &content).unwrap_or(ConflictFile {
        path: path.clone(),
        rel: p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        hunks: Vec::new(),
        malformed_line: None,
        malformed: None,
    }))
}

// ── resolve ────────────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Take {
    Ours,
    Theirs,
    Base,
    /// Ours, then theirs (git's `union` merge driver).
    Both,
    /// Ours, base, theirs (`smerge-keep-all`).
    All,
}

#[derive(Deserialize)]
pub struct ResolveOpts {
    pub take: Take,
    /// The hunk to resolve; every hunk when omitted.
    pub hunk: Option<usize>,
    pub apply: Option<bool>,
}

#[derive(Serialize, Debug)]
pub struct ResolveResult {
    pub hunks_before: usize,
    pub resolved: usize,
    /// Hunks still in the file after this resolution.
    pub remaining: usize,
    pub lines_before: usize,
    pub lines_after: usize,
    pub differs: bool,
    pub applied: bool,
}

/// The lines a hunk resolves to for `take`. `base` on a hunk without a base section is an error,
/// not an empty result: deleting both sides is never what was asked. Pure — unit tested.
fn kept<'a>(lines: &[&'a str], s: &Span, take: Take) -> Result<Vec<&'a str>, String> {
    let ours = &lines[s.open + 1..s.base.unwrap_or(s.sep)];
    let base = s.base.map(|b| &lines[b + 1..s.sep]);
    let theirs = &lines[s.sep + 1..s.close];
    let need_base = || {
        base.ok_or_else(|| {
            format!(
                "conflict at line {} has no base section (not diff3 style)",
                s.open + 1
            )
        })
    };
    Ok(match take {
        Take::Ours => ours.to_vec(),
        Take::Theirs => theirs.to_vec(),
        Take::Base => need_base()?.to_vec(),
        Take::Both => [ours, theirs].concat(),
        Take::All => [ours, need_base()?, theirs].concat(),
    })
}

/// Rewrite `content` with the selected hunk(s) resolved: the new text and the report (minus
/// `applied`). Pure — unit tested.
fn resolve_text(
    content: &str,
    take: Take,
    hunk: Option<usize>,
) -> Result<(String, ResolveResult), String> {
    let src = split(content);
    let parsed = parse(&src.lines);
    if let Some((line, why)) = parsed.malformed {
        return Err(format!("malformed conflict markers at line {line}: {why}"));
    }
    if parsed.hunks.is_empty() {
        return Err("no conflicts in this file".into());
    }
    if let Some(h) = hunk {
        if h >= parsed.hunks.len() {
            return Err(format!(
                "no conflict #{h}: the file has {}",
                parsed.hunks.len()
            ));
        }
    }
    let mut out: Vec<&str> = Vec::with_capacity(src.lines.len());
    let mut cursor = 0;
    let mut resolved = 0;
    for (i, s) in parsed.hunks.iter().enumerate() {
        if hunk.is_some_and(|h| h != i) {
            continue;
        }
        out.extend_from_slice(&src.lines[cursor..s.open]);
        out.extend(kept(&src.lines, s, take)?);
        cursor = s.close + 1;
        resolved += 1;
    }
    out.extend_from_slice(&src.lines[cursor..]);
    let mut text = out.join(src.eol);
    if src.trailing_nl && !out.is_empty() {
        text.push_str(src.eol);
    }
    let res = ResolveResult {
        hunks_before: parsed.hunks.len(),
        resolved,
        remaining: parsed.hunks.len() - resolved,
        lines_before: src.lines.len(),
        lines_after: out.len(),
        differs: text != content,
        applied: false,
    };
    Ok((text, res))
}

/// Preview (or apply) resolving one hunk, or every hunk, of a file to one side.
#[tauri::command]
pub fn resolve_conflicts(path: String, opts: ResolveOpts) -> Result<ResolveResult, String> {
    let p = Path::new(&path);
    let content = read_text(p)?;
    let (text, mut res) = resolve_text(&content, opts.take, opts.hunk)?;
    if opts.apply.unwrap_or(false) && res.differs {
        fs::write(p, text.as_bytes()).map_err(|e| e.to_string())?;
        res.applied = true;
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Written as one line so no line of THIS source file starts with a marker: a conflict scan of
    // this repository must not report its own test fixture.
    const DIFF3: &str = "head\n<<<<<<< HEAD\nours 1\nours 2\n||||||| merged common ancestors\nbase\n=======\ntheirs\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\ntail\n";

    fn lines(s: &str) -> Vec<&str> {
        split(s).lines
    }

    #[test]
    fn markers_need_exactly_seven_and_a_space_or_eol() {
        assert_eq!(marker("<<<<<<< HEAD", '<'), Some("HEAD"));
        assert_eq!(marker("<<<<<<<", '<'), Some(""));
        assert_eq!(
            marker(">>>>>>> a1b2 (subject)  ", '>'),
            Some("a1b2 (subject)")
        );
        assert_eq!(
            marker("<<<<<<<< eight", '<'),
            None,
            "eight markers is not git's"
        );
        assert_eq!(marker("<<<<<<<HEAD", '<'), None, "no space after the run");
        assert_eq!(marker("<<<<<< six", '<'), None);
        assert_eq!(marker(" <<<<<<< indented", '<'), None);
        assert!(is_separator("======="));
        assert!(
            !is_separator("========"),
            "a Markdown rule is not a separator"
        );
    }

    #[test]
    fn parse_reads_diff3_and_merge_style_hunks() {
        let ls = lines(DIFF3);
        let p = parse(&ls);
        assert_eq!(p.malformed, None);
        assert_eq!(p.hunks.len(), 2);
        let h0 = describe(&ls, 0, &p.hunks[0]);
        assert_eq!((h0.start_line, h0.end_line), (2, 9));
        assert_eq!(h0.ours, vec!["ours 1", "ours 2"]);
        assert_eq!(h0.base, Some(vec!["base".to_string()]));
        assert_eq!(h0.base_label.as_deref(), Some("merged common ancestors"));
        assert_eq!(h0.theirs, vec!["theirs"]);
        assert_eq!(
            (h0.ours_label.as_str(), h0.theirs_label.as_str()),
            ("HEAD", "feature")
        );
        let h1 = describe(&ls, 1, &p.hunks[1]);
        assert_eq!(h1.base, None, "a merge-style hunk has no base section");
        assert_eq!((h1.ours_lines, h1.theirs_lines), (1, 1));
    }

    #[test]
    fn a_separator_line_inside_a_side_is_content_after_the_first() {
        // Only the FIRST bare ======= splits the hunk; a later one is theirs-side text.
        let ls = lines("<<<<<<< a\nx\n=======\ny\n=======\n>>>>>>> b\n");
        let p = parse(&ls);
        assert_eq!(p.hunks.len(), 1);
        assert_eq!(describe(&ls, 0, &p.hunks[0]).theirs, vec!["y", "======="]);
    }

    #[test]
    fn broken_markers_are_malformed_not_guessed() {
        let open = parse(&lines("a\n<<<<<<< HEAD\nx\n=======\ny\n"));
        assert_eq!(open.malformed.map(|m| m.0), Some(2));
        let nested = parse(&lines("<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> c\n"));
        assert_eq!(nested.malformed.map(|m| m.0), Some(2));
        let early = parse(&lines("<<<<<<< a\nx\n>>>>>>> b\n"));
        assert_eq!(early.malformed.map(|m| m.0), Some(3));
        let stray = parse(&lines("ok\n>>>>>>> b\n"));
        assert_eq!(stray.malformed.map(|m| m.0), Some(2));
        assert!(resolve_text("<<<<<<< a\nx\n", Take::Ours, None).is_err());
    }

    #[test]
    fn resolve_every_side() {
        let take = |t, h| resolve_text(DIFF3, t, h).map(|r| r.0);
        assert_eq!(
            take(Take::Ours, None).unwrap(),
            "head\nours 1\nours 2\nmiddle\na\ntail\n"
        );
        assert_eq!(
            take(Take::Theirs, None).unwrap(),
            "head\ntheirs\nmiddle\nb\ntail\n"
        );
        assert_eq!(
            take(Take::Both, Some(1)).unwrap(),
            DIFF3.replace("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n", "a\nb\n")
        );
        assert_eq!(
            take(Take::All, Some(0)).unwrap(),
            DIFF3.replace(
                "<<<<<<< HEAD\nours 1\nours 2\n||||||| merged common ancestors\nbase\n=======\ntheirs\n>>>>>>> feature\n",
                "ours 1\nours 2\nbase\ntheirs\n"
            )
        );
        assert_eq!(
            take(Take::Base, Some(0)).unwrap(),
            DIFF3.replace(
                "<<<<<<< HEAD\nours 1\nours 2\n||||||| merged common ancestors\nbase\n=======\ntheirs\n>>>>>>> feature\n",
                "base\n"
            )
        );
        // Base on a merge-style hunk is refused, and so is "all hunks" when one lacks a base.
        assert!(take(Take::Base, Some(1)).unwrap_err().contains("no base"));
        assert!(take(Take::Base, None).is_err());
        assert!(take(Take::Ours, Some(2))
            .unwrap_err()
            .contains("no conflict #2"));
    }

    #[test]
    fn one_hunk_leaves_the_others_and_counts_them() {
        let (_, r) = resolve_text(DIFF3, Take::Theirs, Some(0)).unwrap();
        assert_eq!((r.hunks_before, r.resolved, r.remaining), (2, 1, 1));
        assert_eq!(r.lines_before, 16);
        assert_eq!(r.lines_after, 16 - 8 + 1);
        assert!(r.differs);
    }

    #[test]
    fn crlf_and_missing_final_newline_survive() {
        let crlf = "x\r\n<<<<<<< a\r\no\r\n=======\r\nt\r\n>>>>>>> b\r\ny";
        let (out, _) = resolve_text(crlf, Take::Theirs, None).unwrap();
        assert_eq!(out, "x\r\nt\r\ny");
        // Resolving to an empty side may leave an empty file; it gains no stray newline.
        let (empty, _) =
            resolve_text("<<<<<<< a\n=======\nt\n>>>>>>> b\n", Take::Ours, None).unwrap();
        assert_eq!(empty, "");
    }

    #[test]
    fn commands_scan_preview_and_apply() {
        let dir = std::env::temp_dir().join(format!(
            "zmax-gui-conflicts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/a.rs"), DIFF3).unwrap();
        fs::write(dir.join("clean.md"), "title\n========\n").unwrap();
        fs::write(dir.join("broken.txt"), "<<<<<<< HEAD\nx\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let scan = conflict_scan(root.clone(), None, None).unwrap();
        let mut rels: Vec<&str> = scan.files.iter().map(|f| f.rel.as_str()).collect();
        rels.sort_unstable();
        assert_eq!(
            rels,
            vec!["broken.txt", "src/a.rs"],
            "a Markdown rule is not a conflict"
        );
        assert_eq!(scan.total_hunks, 2);
        let broken = scan.files.iter().find(|f| f.rel == "broken.txt").unwrap();
        assert_eq!(broken.malformed_line, Some(1));
        assert!(!scan.truncated);
        assert!(
            conflict_scan(root.clone(), None, Some(1))
                .unwrap()
                .truncated
        );

        let a = dir.join("src/a.rs").to_string_lossy().into_owned();
        let preview = resolve_conflicts(
            a.clone(),
            ResolveOpts {
                take: Take::Ours,
                hunk: Some(1),
                apply: None,
            },
        )
        .unwrap();
        assert!(preview.differs && !preview.applied);
        assert_eq!(
            fs::read_to_string(&a).unwrap(),
            DIFF3,
            "a preview wrote the file"
        );

        let applied = resolve_conflicts(
            a.clone(),
            ResolveOpts {
                take: Take::Ours,
                hunk: Some(1),
                apply: Some(true),
            },
        )
        .unwrap();
        assert!(applied.applied);
        assert_eq!(applied.remaining, 1);
        let left = conflict_file(a.clone()).unwrap();
        assert_eq!(left.hunks.len(), 1);
        assert_eq!(left.hunks[0].start_line, 2);

        let last = resolve_conflicts(
            a.clone(),
            ResolveOpts {
                take: Take::Theirs,
                hunk: None,
                apply: Some(true),
            },
        )
        .unwrap();
        assert_eq!(last.remaining, 0);
        assert_eq!(
            fs::read_to_string(&a).unwrap(),
            "head\ntheirs\nmiddle\na\ntail\n"
        );
        assert!(conflict_file(a.clone()).unwrap().hunks.is_empty());
        assert!(
            resolve_conflicts(
                a,
                ResolveOpts {
                    take: Take::Ours,
                    hunk: None,
                    apply: Some(true)
                }
            )
            .is_err(),
            "a file with no conflicts left is refused, not rewritten"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
