// zmax-gui's TYPED verb surface for the GUI Automation Bus (GUI_AUTOMATION_BUS.md §4).
//
// The appShell already registers every ⌘K row as an `appshell.<id>` verb, but a palette row is a
// *button*: it declares no parameters, returns nothing, and — because the shell cannot know an
// app command's inverse — defaults to `irreversible`, so a transaction refuses it. That is the
// right default and the wrong ceiling. This file publishes the workbench itself: the Rust project
// commands as parameterised verbs with declared return types and, for the ones that rewrite files,
// a real `undo()`.
//
// The reversibility contract (`zgui-core/webui/automation.js`) has three classes and this surface
// uses all three deliberately:
//
//   pure          every read + every DRY RUN. A preview computes what would change and writes
//                 nothing, so it runs inside a transaction unjournalled.
//   inverse       every file mutation. `run()` snapshots the exact paths the mutation will touch
//                 (via the `txn_*` commands, `app/src-tauri/src/txn.rs`) BEFORE invoking it, and
//                 carries the snapshot token out in the result; `undo()` hands that token back to
//                 `txn_restore`, which writes the previous bytes to the recorded paths.
//   irreversible  repository-level state (branch checkout, stash) and anything that drives the
//                 editor PTY. A transaction refuses these at call time rather than stranding a
//                 chain it cannot unwind.
//
// Two honesty rules are load-bearing, because the alternative in each case is a verb that *looks*
// reversible and is not:
//
//   1. A multi-file mutation learns its file list from its OWN dry run. If that dry run reports
//      `truncated` — the result cap cut the list short — the snapshot would be incomplete, so the
//      verb REFUSES to run inside a transaction instead of half-covering itself.
//   2. A verb whose mutation did not actually land (`applied: false` — a preview, or nothing
//      differed) discards its snapshot immediately and reports `rev: null`, so a later abort does
//      not rewrite a file that this verb never touched.
//
// Loaded after automation.js and before main.js installs the automation host.
(function () {
  "use strict";

  function core() { return window.__TAURI__ && window.__TAURI__.core; }
  function invoke(cmd, args) {
    var T = core();
    if (!T) return Promise.reject(new Error("no tauri host"));
    return T.invoke(cmd, args || {});
  }

  // ── snapshot plumbing ─────────────────────────────────────────────────────────────────────────
  function snapshot(paths) {
    var list = (paths || []).filter(function (p) { return typeof p === "string" && p; });
    if (!list.length) return Promise.resolve(null);
    return invoke("txn_snapshot", { paths: list });
  }
  function discard(token) {
    if (!token) return Promise.resolve();
    return invoke("txn_discard", { token: token }).catch(function () {});
  }

  /**
   * Build a file-mutating verb that compensates by content snapshot.
   *
   *   plan(args)  -> Promise<{ paths: string[], truncated?: boolean }>   what the mutation will touch
   *   apply(args) -> Promise<result>                                     the real, applying invoke
   *   landed(res) -> boolean                                             did anything actually change
   *
   * The returned verb's result is the command's own result with a `txn` field added (the snapshot
   * token, or null when nothing landed) — additive, so a script that ignores it sees the raw shape.
   */
  function reversible(spec) {
    return {
      id: spec.id,
      label: spec.label,
      params: spec.params || [],
      returns: spec.returns || "object",
      rev: "inverse",
      run: function (args) {
        var a = args || {};
        return Promise.resolve(spec.plan(a)).then(function (plan) {
          plan = plan || {};
          if (plan.truncated) {
            // The preview was capped, so the path list is a PREFIX of what the mutation will edit.
            // Snapshotting it would produce a compensation that silently misses files.
            return Promise.reject(new Error(
              "refusing " + spec.id + ": the preview is truncated, so the snapshot would be incomplete " +
              "— narrow the query or raise maxResults"));
          }
          return snapshot(plan.paths).then(function (token) {
            return Promise.resolve(spec.apply(a)).then(function (res) {
              var landed = spec.landed ? spec.landed(res) : true;
              if (!landed) {
                // Nothing was written. Keeping the snapshot would let an abort rewrite files this
                // verb never touched.
                return discard(token).then(function () { return withTxn(res, null); });
              }
              return withTxn(res, token);
            }, function (err) {
              // The mutation threw: its effect (if any) is unknown to us, but the snapshot is the
              // pre-state either way, so keep it and let the caller compensate explicitly.
              return discard(token).then(function () { return Promise.reject(err); });
            });
          });
        });
      },
      undo: function (args, result) {
        var token = result && result.txn;
        if (!token) return Promise.resolve({ restored: [], removed: [], failed: [] });
        return invoke("txn_restore", { token: token }).then(function (report) {
          emit("zmax.txn.compensated", { verb: spec.id, report: report });
          return discard(token).then(function () { return report; });
        });
      },
    };
  }

  function withTxn(res, token) {
    if (res && typeof res === "object" && !Array.isArray(res)) { res.txn = token; return res; }
    return { result: res, txn: token };
  }

  function emit(id, payload) {
    var A = window.ZGui && window.ZGui.automation;
    if (A && typeof A.emit === "function") { try { A.emit(id, payload); } catch (e) { /* no sink */ } }
  }

  // A read verb: no state change, so it is `pure` and a transaction runs it unjournalled.
  function pure(id, label, cmd, params, returns) {
    return {
      id: id,
      label: label,
      params: params || [],
      returns: returns || "object",
      rev: "pure",
      run: function (args) { return invoke(cmd, args || {}); },
    };
  }

  // A verb whose inverse is ANOTHER command (not a snapshot) — stage/unstage, add/remove.
  function paired(id, label, cmd, inverseCmd, params, returns) {
    return {
      id: id,
      label: label,
      params: params || [],
      returns: returns || "null",
      rev: "inverse",
      run: function (args) { return invoke(cmd, args || {}); },
      undo: function (args) { return invoke(inverseCmd, args || {}); },
    };
  }

  // A verb with a real effect and no compensation this app can honestly perform.
  function oneWay(id, label, cmd, params, returns) {
    return {
      id: id,
      label: label,
      params: params || [],
      returns: returns || "null",
      rev: "irreversible",
      run: function (args) { return invoke(cmd, args || {}); },
    };
  }

  var P = function (name, type, required) { return { name: name, type: type, required: !!required }; };

  // ── project root ──────────────────────────────────────────────────────────────────────────────
  // `list_dir(null)` answers with the host's current directory, the same root panels.js works from.
  var rootCache = null;
  function projectRoot() {
    if (rootCache) return Promise.resolve(rootCache);
    return invoke("list_dir", { path: null }).then(function (l) { rootCache = l && l.dir; return rootCache; });
  }
  function withRoot(args) {
    var a = args || {};
    if (a.root) return Promise.resolve(a);
    return projectRoot().then(function (r) {
      var out = {};
      Object.keys(a).forEach(function (k) { out[k] = a[k]; });
      out.root = r;
      return out;
    });
  }

  // ── dry-run planners (what a mutation will touch) ─────────────────────────────────────────────
  function planReplace(args) {
    return withRoot(args).then(function (a) {
      var opts = Object.assign({}, a.opts || {}, { apply: false });
      return invoke("replace_project", {
        root: a.root, query: a.query, replacement: a.replacement, opts: opts,
      }).then(function (res) {
        var paths = {};
        (res.hits || []).forEach(function (h) { if (h && h.path) paths[h.path] = 1; });
        (res.doc_hits || []).forEach(function (h) { if (h && h.path) paths[h.path] = 1; });
        return { paths: Object.keys(paths), truncated: !!res.truncated };
      });
    });
  }

  function planBatchRename(args) {
    return withRoot(args).then(function (a) {
      var opts = Object.assign({}, a.opts || {}, { apply: false });
      return invoke("batch_rename", {
        root: a.root, find: a.find, replace: a.replace, opts: opts,
      }).then(function (res) {
        var paths = {};
        // BOTH sides: the source has to come back and the destination has to go away again.
        (res.plans || []).forEach(function (p) {
          if (!p || p.skipped) return;
          if (p.from) paths[p.from] = 1;
          if (p.to) paths[p.to] = 1;
        });
        return { paths: Object.keys(paths), truncated: !!res.truncated };
      });
    });
  }

  function onePath(args) { return Promise.resolve({ paths: [(args || {}).path] }); }

  function applied(res) { return !!(res && res.applied); }

  // ── the surface ───────────────────────────────────────────────────────────────────────────────
  function buildVerbs() {
    return [
      // ── reads: the project ──────────────────────────────────────────────────────────────────
      {
        id: "zmax.project.root", label: "Project root", params: [], returns: "string", rev: "pure",
        run: function () { return projectRoot(); },
      },
      {
        id: "zmax.project.findFiles", label: "Fuzzy file finder", rev: "pure", returns: "array",
        params: [P("query", "string"), P("limit", "number"), P("root", "string"), P("showHidden", "boolean")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("find_files", a); }); },
      },
      {
        id: "zmax.project.search", label: "Find in files (text + documents)", rev: "pure", returns: "object",
        params: [P("query", "string", true), P("opts", "object"), P("root", "string")],
        run: function (args) {
          return withRoot(args).then(function (a) { return invoke("search_project", a); })
            .then(function (res) { emit("zmax.search.run", { hits: (res && res.total) || 0 }); return res; });
        },
      },
      {
        id: "zmax.project.searchDocuments", label: "Search binary documents only", rev: "pure", returns: "object",
        params: [P("query", "string", true), P("root", "string"), P("opts", "object")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("search_documents", a); }); },
      },
      {
        id: "zmax.project.symbols", label: "Workspace symbols", rev: "pure", returns: "array",
        params: [P("root", "string")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("project_symbols", a); }); },
      },
      {
        id: "zmax.project.markers", label: "TODO / FIXME markers", rev: "pure", returns: "array",
        params: [P("root", "string")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("scan_markers", a); }); },
      },
      {
        id: "zmax.project.stats", label: "Code statistics by extension", rev: "pure", returns: "object",
        params: [P("root", "string"), P("showHidden", "boolean"), P("top", "number")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("project_stats", a); }); },
      },
      {
        id: "zmax.project.findDefinition", label: "Find a symbol's declaration", rev: "pure", returns: "array",
        params: [P("name", "string", true), P("root", "string")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("find_definition", a); }); },
      },
      pure("zmax.file.stats", "File line / word / byte counts", "file_stats", [P("path", "string", true)]),
      pure("zmax.file.detectEncoding", "Detect a file's encoding", "detect_encoding", [P("path", "string", true)]),
      pure("zmax.file.list", "List a directory", "list_dir", [P("path", "string")]),

      // ── reads: git ──────────────────────────────────────────────────────────────────────────
      {
        id: "zmax.git.status", label: "Working-tree status", rev: "pure", returns: "array",
        params: [P("root", "string")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("git_status", a); }); },
      },
      {
        id: "zmax.git.branch", label: "Current branch", rev: "pure", returns: "string",
        params: [P("root", "string")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("git_branch", a); }); },
      },
      {
        id: "zmax.git.branches", label: "Local branches", rev: "pure", returns: "array",
        params: [P("root", "string")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("git_branches", a); }); },
      },
      {
        id: "zmax.git.log", label: "Repository log", rev: "pure", returns: "array",
        params: [P("root", "string"), P("limit", "number")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("git_log_repo", a); }); },
      },
      {
        id: "zmax.git.graph", label: "Commit graph", rev: "pure", returns: "string",
        params: [P("root", "string"), P("limit", "number")],
        run: function (args) { return withRoot(args).then(function (a) { return invoke("git_graph", a); }); },
      },
      {
        id: "zmax.git.diffRevs", label: "Diff two revisions", rev: "pure", returns: "string",
        params: [P("a", "string", true), P("b", "string", true), P("path", "string"), P("root", "string")],
        run: function (args) { return withRoot(args).then(function (x) { return invoke("git_diff_revs", x); }); },
      },
      pure("zmax.git.blame", "Per-line blame", "git_blame", [P("path", "string", true)], "array"),
      pure("zmax.git.logFile", "A file's history", "git_log_file", [P("path", "string", true)], "array"),
      pure("zmax.git.show", "The diff a commit introduced", "git_show", [P("path", "string"), P("rev", "string", true)], "string"),
      pure("zmax.git.fileDiff", "A file's unstaged diff", "git_file_diff", [P("path", "string", true)], "string"),
      pure("zmax.git.stashList", "Stash entries", "git_stash_list", [P("root", "string")], "array"),
      pure("zmax.git.compare", "Diff two files", "diff_files", [P("a", "string", true), P("b", "string", true)], "string"),

      // ── reads: documents (zoffice-core / zpdf-core, linked in-process) ──────────────────────
      pure("zmax.doc.blame", "Blame a document at its own addresses", "doc_blame", [P("path", "string", true)], "object"),

      // ── dry runs: pure by construction, and the exact preview the applying verb will act on ──
      {
        id: "zmax.replace.preview", label: "Preview a project-wide replace", rev: "pure", returns: "object",
        params: [P("query", "string", true), P("replacement", "string", true), P("opts", "object"), P("root", "string")],
        run: function (args) {
          return withRoot(args).then(function (a) {
            return invoke("replace_project", {
              root: a.root, query: a.query, replacement: a.replacement,
              opts: Object.assign({}, a.opts || {}, { apply: false }),
            });
          });
        },
      },
      {
        id: "zmax.rename.preview", label: "Preview a batch rename", rev: "pure", returns: "object",
        params: [P("find", "string", true), P("replace", "string", true), P("opts", "object"), P("root", "string")],
        run: function (args) {
          return withRoot(args).then(function (a) {
            return invoke("batch_rename", {
              root: a.root, find: a.find, replace: a.replace,
              opts: Object.assign({}, a.opts || {}, { apply: false }),
            });
          });
        },
      },
      {
        id: "zmax.sort.preview", label: "Preview a line sort", rev: "pure", returns: "object",
        params: [P("path", "string", true), P("opts", "object")],
        run: function (args) {
          var a = args || {};
          return invoke("sort_file_lines", { path: a.path, opts: Object.assign({}, a.opts || {}, { apply: false }) });
        },
      },
      {
        id: "zmax.cleanup.preview", label: "Preview a whitespace / line-ending cleanup", rev: "pure", returns: "object",
        params: [P("path", "string", true), P("opts", "object")],
        run: function (args) {
          var a = args || {};
          return invoke("convert_file", { path: a.path, opts: Object.assign({}, a.opts || {}, { apply: false }) });
        },
      },
      {
        id: "zmax.align.preview", label: "Preview a column alignment", rev: "pure", returns: "object",
        params: [P("path", "string", true), P("opts", "object", true)],
        run: function (args) {
          var a = args || {};
          return invoke("align_columns", { path: a.path, opts: Object.assign({}, a.opts || {}, { apply: false }) });
        },
      },
      {
        id: "zmax.comment.preview", label: "Preview a comment toggle", rev: "pure", returns: "object",
        params: [P("path", "string", true), P("startLine", "number", true), P("endLine", "number", true)],
        run: function (args) {
          var a = args || {};
          return invoke("comment_toggle", { path: a.path, startLine: a.startLine, endLine: a.endLine, apply: false });
        },
      },
      {
        id: "zmax.encoding.preview", label: "Preview a transcode", rev: "pure", returns: "object",
        params: [P("path", "string", true), P("to", "string", true)],
        run: function (args) {
          var a = args || {};
          return invoke("convert_encoding", { path: a.path, to: a.to, apply: false });
        },
      },
      pure("zmax.txn.snapshots", "Live compensation snapshots", "txn_list", [], "array"),

      // ── mutations: every one snapshots the exact paths it will rewrite ──────────────────────
      reversible({
        id: "zmax.replace.apply",
        label: "Project-wide replace (reversible)",
        params: [P("query", "string", true), P("replacement", "string", true), P("opts", "object"), P("root", "string")],
        plan: planReplace,
        apply: function (args) {
          return withRoot(args).then(function (a) {
            return invoke("replace_project", {
              root: a.root, query: a.query, replacement: a.replacement,
              opts: Object.assign({}, a.opts || {}, { apply: true }),
            });
          });
        },
        landed: applied,
      }),
      reversible({
        id: "zmax.rename.apply",
        label: "Batch rename (reversible)",
        params: [P("find", "string", true), P("replace", "string", true), P("opts", "object"), P("root", "string")],
        plan: planBatchRename,
        apply: function (args) {
          return withRoot(args).then(function (a) {
            return invoke("batch_rename", {
              root: a.root, find: a.find, replace: a.replace,
              opts: Object.assign({}, a.opts || {}, { apply: true }),
            });
          });
        },
        landed: function (res) { return !!(res && res.applied && res.renamed); },
      }),
      reversible({
        id: "zmax.sort.apply",
        label: "Sort a file's lines (reversible)",
        params: [P("path", "string", true), P("opts", "object")],
        plan: onePath,
        apply: function (args) {
          var a = args || {};
          return invoke("sort_file_lines", { path: a.path, opts: Object.assign({}, a.opts || {}, { apply: true }) });
        },
        landed: applied,
      }),
      reversible({
        id: "zmax.cleanup.apply",
        label: "Clean up a file (reversible)",
        params: [P("path", "string", true), P("opts", "object")],
        plan: onePath,
        apply: function (args) {
          var a = args || {};
          return invoke("convert_file", { path: a.path, opts: Object.assign({}, a.opts || {}, { apply: true }) });
        },
        landed: applied,
      }),
      reversible({
        id: "zmax.align.apply",
        label: "Align a file's columns (reversible)",
        params: [P("path", "string", true), P("opts", "object", true)],
        plan: onePath,
        apply: function (args) {
          var a = args || {};
          return invoke("align_columns", { path: a.path, opts: Object.assign({}, a.opts || {}, { apply: true }) });
        },
        landed: applied,
      }),
      reversible({
        id: "zmax.comment.apply",
        label: "Comment / uncomment a line range (reversible)",
        params: [P("path", "string", true), P("startLine", "number", true), P("endLine", "number", true)],
        plan: onePath,
        apply: function (args) {
          var a = args || {};
          return invoke("comment_toggle", { path: a.path, startLine: a.startLine, endLine: a.endLine, apply: true });
        },
        landed: applied,
      }),
      reversible({
        id: "zmax.encoding.apply",
        label: "Transcode a file (reversible)",
        params: [P("path", "string", true), P("to", "string", true)],
        plan: onePath,
        apply: function (args) {
          var a = args || {};
          return invoke("convert_encoding", { path: a.path, to: a.to, apply: true });
        },
        landed: applied,
      }),
      reversible({
        id: "zmax.doc.replace",
        label: "Replace inside binary documents (reversible)",
        params: [P("query", "string", true), P("replacement", "string", true), P("root", "string"), P("opts", "object")],
        plan: function (args) {
          return withRoot(args).then(function (a) {
            return invoke("search_documents", { root: a.root, query: a.query, opts: a.opts || {} })
              .then(function (res) {
                var paths = {};
                ((res && res.hits) || []).forEach(function (h) { if (h && h.path) paths[h.path] = 1; });
                return { paths: Object.keys(paths), truncated: !!(res && res.truncated) };
              });
          });
        },
        apply: function (args) {
          return withRoot(args).then(function (a) {
            return invoke("replace_documents", {
              root: a.root, query: a.query, replacement: a.replacement,
              opts: Object.assign({}, a.opts || {}, { apply: true }),
            });
          });
        },
        landed: applied,
      }),

      // ── mutations: filesystem ───────────────────────────────────────────────────────────────
      reversible({
        id: "zmax.file.create", label: "Create a file or folder (reversible)",
        params: [P("path", "string", true), P("isDir", "boolean")],
        plan: onePath,
        apply: function (args) { var a = args || {}; return invoke("create_path", { path: a.path, isDir: !!a.isDir }); },
        landed: function () { return true; },
      }),
      reversible({
        id: "zmax.file.rename", label: "Rename / move a path (reversible)",
        params: [P("from", "string", true), P("to", "string", true)],
        plan: function (args) { var a = args || {}; return Promise.resolve({ paths: [a.from, a.to] }); },
        apply: function (args) { return invoke("rename_path", args || {}); },
        landed: function () { return true; },
      }),
      reversible({
        id: "zmax.file.copy", label: "Copy a path (reversible)",
        params: [P("from", "string", true), P("to", "string", true)],
        // Only the DESTINATION changes; the source is untouched, so snapshotting it would make the
        // compensation rewrite a file the verb never edited.
        plan: function (args) { return Promise.resolve({ paths: [(args || {}).to] }); },
        apply: function (args) { return invoke("copy_path", args || {}); },
        landed: function () { return true; },
      }),
      reversible({
        id: "zmax.file.delete", label: "Delete a path (reversible)",
        params: [P("path", "string", true)],
        plan: onePath,
        apply: function (args) { return invoke("delete_path", args || {}); },
        landed: function () { return true; },
      }),
      reversible({
        id: "zmax.git.discard", label: "Discard a file's changes (reversible)",
        // `git checkout -- <path>` throws the working copy away; the snapshot is the only thing that
        // can bring it back, which is exactly why this is `inverse` rather than `irreversible`.
        params: [P("path", "string", true)],
        plan: onePath,
        apply: function (args) { return invoke("git_discard", args || {}); },
        landed: function () { return true; },
      }),

      // ── mutations whose inverse is another command ──────────────────────────────────────────
      paired("zmax.git.stage", "Stage a file", "git_stage", "git_unstage", [P("path", "string", true)]),
      paired("zmax.git.unstage", "Unstage a file", "git_unstage", "git_stage", [P("path", "string", true)]),
      {
        id: "zmax.bookmark.add", label: "Add a bookmark", rev: "inverse", returns: "null",
        params: [P("path", "string", true), P("line", "number", true), P("label", "string")],
        run: function (args) { return invoke("bookmark_add", args || {}); },
        undo: function (args) { return invoke("bookmark_remove", args || {}); },
      },
      {
        id: "zmax.snippet.add", label: "Add a snippet", rev: "inverse", returns: "null",
        params: [P("name", "string", true), P("body", "string", true)],
        run: function (args) { return invoke("snippet_add", args || {}); },
        undo: function (args) { return invoke("snippet_remove", { name: (args || {}).name }); },
      },

      // ── one-way: repository state and the editor itself ─────────────────────────────────────
      oneWay("zmax.git.checkout", "Check out a branch", "git_checkout_branch", [P("root", "string"), P("name", "string", true)]),
      oneWay("zmax.git.createBranch", "Create and switch to a branch", "git_create_branch", [P("root", "string"), P("name", "string", true)]),
      oneWay("zmax.git.stashSave", "Stash the working tree", "git_stash_save", [P("root", "string"), P("message", "string")]),
      oneWay("zmax.git.stashPop", "Pop a stash entry", "git_stash_pop", [P("root", "string"), P("index", "number")]),
      oneWay("zmax.git.stashDrop", "Drop a stash entry", "git_stash_drop", [P("root", "string"), P("index", "number")]),
      {
        // Drives the editor PTY: the buffer state afterwards is the editor's, not ours, so there is
        // nothing this app could restore.
        id: "zmax.editor.open", label: "Open a file in the editor", rev: "irreversible", returns: "null",
        params: [P("path", "string", true), P("line", "number"), P("col", "number")],
        run: function (args) {
          var a = args || {};
          var api = window.ZmaxPanels;
          if (api && typeof api.openInEditor === "function") {
            api.openInEditor(a.path, a.line, a.col);
            emit("zmax.file.opened", { path: a.path, line: a.line || null });
            return null;
          }
          return Promise.reject(new Error("the editor bridge is not mounted"));
        },
      },
      // ── the in-app document pane (doc-view.js over mountZpdf / mountZoffice) ────────────────
      // Irreversible, both of them: opening replaces whatever the single pane was showing and
      // closing forgets it, and neither one records what it displaced. The ids sit under
      // `zmax.doc.`, namespaced against the panes' own `zoffice.view.*` — ZGui.automation keeps ONE
      // flat registry and a later id silently wins, so a collision here would replace the pane's
      // verb with the host's (or the reverse, depending on mount order).
      {
        id: "zmax.doc.open", rev: "irreversible", returns: "object",
        label: "Open a document (pdf/docx/odt/xlsx/ods/pptx/odp) in the in-app pane",
        params: [P("path", "string", true)],
        run: function (args) {
          var api = window.ZmaxDocView;
          if (!api) return Promise.reject(new Error("the document pane is not mounted"));
          return api.open((args || {}).path).then(function () { return api.state(); });
        },
      },
      {
        id: "zmax.doc.close", rev: "irreversible", returns: "object",
        label: "Close the in-app document pane", params: [],
        run: function () {
          var api = window.ZmaxDocView;
          if (!api) return Promise.reject(new Error("the document pane is not mounted"));
          api.close();
          return api.state();
        },
      },
      {
        id: "zmax.editor.ex", label: "Run an ex command in the editor", rev: "irreversible", returns: "null",
        params: [P("command", "string", true)],
        run: function (args) {
          var cmd = String((args || {}).command || "");
          if (!cmd) return Promise.reject(new Error("empty ex command"));
          // ESC first so the editor is in normal mode regardless of where the user left it.
          return invoke("terminal_write", { data: "\x1b" }).then(function () {
            return invoke("terminal_write", { data: ":" + cmd + "\r" });
          });
        },
      },
    ];
  }

  function buildState() {
    return [
      { id: "zmax.root", label: "Project root", returns: "string", get: function () { return projectRoot(); } },
      { id: "zmax.recent", label: "Recent files", returns: "array", get: function () { return invoke("recent_list"); } },
      { id: "zmax.bookmarks", label: "Bookmarks", returns: "array", get: function () { return invoke("bookmark_list"); } },
      { id: "zmax.snippets", label: "Snippets", returns: "array", get: function () { return invoke("snippet_list"); } },
      {
        id: "zmax.branch", label: "Current git branch", returns: "string",
        get: function () { return projectRoot().then(function (r) { return invoke("git_branch", { root: r }); }); },
      },
      {
        id: "zmax.locale", label: "Active UI locale", returns: "string",
        get: function () {
          return (typeof window.savedLocale === "function" && window.savedLocale()) ||
                 (typeof window.detectLocale === "function" && window.detectLocale()) || "en";
        },
      },
      {
        id: "zmax.doc.state", label: "The in-app document pane (path, engine, view state)", returns: "object",
        get: function () {
          var api = window.ZmaxDocView;
          return api ? api.state() : { open: false, path: null, kind: null };
        },
      },
      {
        id: "zmax.txn.open", label: "The open bus transaction, or null", returns: "number",
        get: function () {
          var A = window.ZGui && window.ZGui.automation;
          return A && typeof A.txnActive === "function" ? A.txnActive() : null;
        },
      },
    ];
  }

  function buildEvents() {
    return [
      { id: "zmax.file.opened", payload: "{ path, line }" },
      { id: "zmax.file.saved", payload: "{ path }" },
      { id: "zmax.search.run", payload: "{ hits }" },
      { id: "zmax.git.committed", payload: "{ root }" },
      { id: "zmax.txn.compensated", payload: "{ verb, report }" },
    ];
  }

  function register() {
    var A = window.ZGui && window.ZGui.automation;
    if (!A || typeof A.register !== "function") return false;
    A.register({
      app: "zmax-gui",
      verbs: buildVerbs(),
      state: buildState(),
      events: buildEvents(),
    });
    return true;
  }

  // Exported for the headless bridge tests (which have no ZGui) and so a future embedded core can
  // merge its own namespaced verbs into the same surface.
  window.ZmaxVerbs = {
    register: register,
    verbs: buildVerbs,
    state: buildState,
    events: buildEvents,
    reversible: reversible,
  };

  register();
})();
