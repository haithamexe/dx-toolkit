// The Search page: files by name and what is inside them, for a project or all of them.
// A classic script that app.js asks for the page (window.dxSearch), given the helpers it needs, so the
// page has a file of its own. Everything is built with h() and text nodes: nothing from a result is ever
// put in as HTML. See docs/design.md for the standards it follows.
window.dxSearch = function dxSearch(deps) {
  const { h, fill, api, btn, icon, plural, pref, setPref, hashParams, setHashParams, currentProject, toast, announce, morph, problemBlock, loadingView, errorView } = deps;

  // ---------------------------------------------------------------- a little syntax tint for the preview
  const SLASH = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cs", "php", "scss", "less", "dart", "vue", "svelte", "json5"]);
  const HASH = new Set(["py", "sh", "bash", "zsh", "rb", "yml", "yaml", "toml", "ini", "conf", "env", "pl", "r", "ps1", "dockerfile", "mk"]);
  const DASH = new Set(["sql", "lua", "hs"]);
  const KEYWORDS = new Set(
    "const let var function return if else for while do switch case break continue class extends implements interface type enum import export from default async await new try catch finally throw typeof instanceof in of void yield static public private protected readonly abstract namespace module declare def fn pub struct impl trait use mod package func go defer chan select range lambda pass raise with as is not and or None True False null undefined true false this self super".split(" "),
  );

  function tokenize(text, ext) {
    const out = [];
    let plain = "";
    const flush = () => {
      if (plain) out.push(["", plain]);
      plain = "";
    };
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if ((SLASH.has(ext) && text.startsWith("//", i) && text[i - 1] !== ":") || (HASH.has(ext) && ch === "#") || (DASH.has(ext) && text.startsWith("--", i))) {
        flush();
        out.push(["tok-c", text.slice(i)]);
        return out;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== ch) {
          if (text[j] === "\\") j++;
          j++;
        }
        flush();
        out.push(["tok-s", text.slice(i, Math.min(j + 1, text.length))]);
        i = j + 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < text.length && /[\w$]/.test(text[j])) j++;
        const word = text.slice(i, j);
        if (KEYWORDS.has(word)) {
          flush();
          out.push(["tok-k", word]);
        } else plain += word;
        i = j;
        continue;
      }
      if (/\d/.test(ch) && !/[\w$]/.test(text[i - 1] ?? " ")) {
        let j = i + 1;
        while (j < text.length && /[\d._]/.test(text[j])) j++;
        flush();
        out.push(["tok-n", text.slice(i, j)]);
        i = j;
        continue;
      }
      plain += ch;
      i++;
    }
    flush();
    return out;
  }

  /** A line of code as spans: tinted by what each part is, the matches marked (bold and underlined, not colour alone). */
  function codeLine(text, ext, ranges = []) {
    const tokens = tokenize(text, ext);
    const cuts = new Set([0, text.length]);
    let pos = 0;
    for (const [, t] of tokens) {
      pos += t.length;
      cuts.add(pos);
    }
    for (const [a, b] of ranges) {
      cuts.add(Math.max(0, Math.min(a, text.length)));
      cuts.add(Math.max(0, Math.min(b, text.length)));
    }
    const points = [...cuts].sort((a, b) => a - b);
    const spans = [];
    let start = 0;
    let ti = 0;
    let tokenEnd = tokens[0]?.[1].length ?? 0;
    for (const end of points) {
      if (end <= start) continue;
      while (ti < tokens.length && start >= tokenEnd) {
        ti++;
        tokenEnd += tokens[ti]?.[1].length ?? 0;
      }
      const cls = tokens[ti]?.[0] ?? "";
      const marked = ranges.some(([a, b]) => start >= a && end <= b);
      const piece = text.slice(start, end);
      const node = cls ? h("span", { class: cls }, piece) : piece;
      spans.push(marked ? h("mark", { class: "hit-mark" }, node) : node);
      start = end;
    }
    return spans;
  }

  /** A path with its folder dim and its name strong; the letters a name search matched marked. */
  function pathView(rel, ranges = []) {
    const slash = rel.lastIndexOf("/") + 1;
    const marks = new Set();
    for (const [a, b] of ranges) for (let i = a; i < b; i++) marks.add(i);
    const part = (from, to, cls) => {
      const nodes = [];
      let run = "";
      let on = false;
      const flush = () => {
        if (run) nodes.push(on ? h("mark", { class: "hit-mark" }, run) : run);
        run = "";
      };
      for (let i = from; i < to; i++) {
        const m = marks.has(i);
        if (m !== on) {
          flush();
          on = m;
        }
        run += rel[i];
      }
      flush();
      // A folder can break after each slash; a file's name stays whole.
      const broken = [];
      for (const n of nodes) {
        if (typeof n === "string" && cls === "result-dir") n.split(/(?<=\/)/).forEach((piece, i) => (i ? broken.push(h("wbr", null), piece) : broken.push(piece)));
        else broken.push(n);
      }
      return h("span", { class: cls }, broken);
    };
    return h("span", { class: "result-path" }, slash ? part(0, slash, "result-dir") : null, part(slash, rel.length, "result-name"));
  }

  const lastUsed = () => {
    try {
      return JSON.parse(pref("searchRecent", "[]")) ?? [];
    } catch {
      return [];
    }
  };
  const remember = (q) => {
    if (q.trim().length < 2) return;
    const list = [q, ...lastUsed().filter((x) => x !== q)].slice(0, 8);
    setPref("searchRecent", JSON.stringify(list));
  };

  // ---------------------------------------------------------------- the page
  return function searchPage(root) {
    const params = hashParams();
    const list = (v) => new Set((v ?? "").split(",").filter(Boolean));
    const state = {
      q: params.get("q") ?? "",
      mode: ["all", "files", "content"].includes(params.get("mode")) ? params.get("mode") : pref("searchMode", "all"),
      scope: params.get("scope") === "all" ? "all" : "project",
      word: params.get("word") === "1",
      regex: params.get("regex") === "1",
      cs: params.get("case") === "1" ? "1" : params.get("case") === "0" ? "0" : "",
      ext: list(params.get("ext")),
      folder: list(params.get("folder")),
    };
    let dir = currentProject();
    let result;
    let rows = [];
    let sel = -1;
    let seq = 0;
    let controller;
    let timer = 0;
    let rememberTimer = 0;
    let previewTimer = 0;
    let previewSeq = 0;
    let stopped = false;

    // ---- the box
    const input = h("input", { class: "search-input", type: "search", id: "search-q", value: state.q, placeholder: "Find a file or a word, like cartserv or useState", "aria-label": "Search", autocomplete: "off", spellcheck: "false", autofocus: true });
    const toggle = (label, title, key, on, flip) => {
      const b = h("button", { type: "button", class: "search-toggle", "aria-pressed": String(on()), title, "aria-label": title, onclick: () => (flip(), b.setAttribute("aria-pressed", String(on())), run(true)) }, label);
      return b;
    };
    const caseBtn = toggle("Aa", "Match case (otherwise only when you type a capital letter)", "cs", () => state.cs === "1", () => (state.cs = state.cs === "1" ? "" : "1"));
    const wordBtn = toggle("ab", "Whole words only", "word", () => state.word, () => (state.word = !state.word));
    const regexBtn = toggle(".*", "Regular expression", "regex", () => state.regex, () => (state.regex = !state.regex));
    wordBtn.classList.add("is-word");
    const bar = h("span", { class: "search-bar", "aria-hidden": "true" });
    const scope = h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Where" },
      [["project", "This project"], ["all", "All projects"]].map(([v, t]) =>
        h("button", { type: "button", "aria-pressed": String(state.scope === v), dataset: { v }, onclick: () => ((state.scope = v), (state.ext = new Set()), (state.folder = new Set()), syncControls(), run(true)) }, t),
      ),
    );
    const mode = h(
      "div",
      { class: "segmented", role: "group", "aria-label": "What" },
      [["all", "Everything"], ["files", "File names"], ["content", "Inside files"]].map(([v, t]) =>
        h("button", { type: "button", "aria-pressed": String(state.mode === v), dataset: { v }, onclick: () => ((state.mode = v), setPref("searchMode", v), syncControls(), run(true)) }, t),
      ),
    );
    function syncControls() {
      for (const b of scope.children) b.setAttribute("aria-pressed", String(b.dataset.v === state.scope));
      for (const b of mode.children) b.setAttribute("aria-pressed", String(b.dataset.v === state.mode));
      caseBtn.setAttribute("aria-pressed", String(state.cs === "1"));
      wordBtn.setAttribute("aria-pressed", String(state.word));
      regexBtn.setAttribute("aria-pressed", String(state.regex));
    }
    const status = h("p", { class: "search-status dim", role: "status", "aria-live": "polite" });
    const facets = h("aside", { class: "search-facets", "aria-label": "Narrow the results" });
    const list$ = h("div", { class: "search-results" });
    const preview = h("aside", { class: "search-preview", "aria-label": "Preview" });

    const layout = h("div", { class: "search-layout is-bare" }, facets, list$, preview);
    const box = h(
      "div",
      { class: "card card-pad search-box" },
      h("div", { class: "search-field" }, icon("search"), input, h("span", { class: "search-toggles" }, caseBtn, wordBtn, regexBtn), bar),
      h("div", { class: "search-controls" }, mode, scope, status),
    );

    fill(
      root,
      h("div", { class: "page-head" }, h("div", null, h("h1", { class: "page-title" }, "Search"))),
      box,
      layout,
    );
    // The project switcher is the project: this page follows it.
    if (!dir && state.scope !== "all") state.scope = "all";

    // ---- asking
    function url() {
      const p = new URLSearchParams({ q: state.q, mode: state.mode });
      if (state.scope === "all") p.set("scope", "all");
      else p.set("dir", dir);
      if (state.word) p.set("word", "1");
      if (state.regex) p.set("regex", "1");
      if (state.cs) p.set("case", state.cs);
      if (state.ext.size) p.set("ext", [...state.ext].join(","));
      if (state.folder.size && state.scope !== "all") p.set("folder", [...state.folder].join(","));
      return `/api/search?${p}`;
    }

    function writeAddress() {
      setHashParams({ q: state.q, mode: state.mode === "all" ? "" : state.mode, scope: state.scope === "all" ? "all" : "", word: state.word ? "1" : "", regex: state.regex ? "1" : "", case: state.cs, ext: [...state.ext].join(","), folder: [...state.folder].join(",") });
    }

    function run(now = false) {
      clearTimeout(timer);
      writeAddress();
      if (!state.q.trim()) {
        seq++;
        controller?.abort();
        bar.classList.remove("is-busy");
        result = undefined;
        return drawEmpty();
      }
      timer = setTimeout(go, now ? 0 : 110);
    }

    async function go() {
      controller?.abort();
      controller = new AbortController();
      const mine = ++seq;
      bar.classList.add("is-busy");
      try {
        const data = await api(url(), { signal: controller.signal });
        if (mine !== seq || stopped) return;
        result = data;
        draw();
        clearTimeout(rememberTimer);
        if (data.files.length) rememberTimer = setTimeout(() => remember(state.q), 1500);
      } catch (err) {
        if (err.name === "AbortError" || mine !== seq || stopped) return;
        fill(list$, h("div", { class: "card card-pad" }, errorView(err, () => run(true))));
        fill(facets);
        fill(status);
      } finally {
        if (mine === seq) bar.classList.remove("is-busy");
      }
    }

    // ---- drawing
    function drawEmpty() {
      layout.classList.add("is-bare");
      rows = [];
      sel = -1;
      fill(facets);
      fill(status);
      fill(preview, h("p", { class: "dim search-preview-empty" }, "A match shows here, with its lines around it."));
      const recent = lastUsed();
      fill(
        list$,
        h(
          "div",
          { class: "card card-pad search-start" },
          h("p", { class: "search-start-title" }, "Find any file or any line"),
          h("ul", { class: "search-tips" },
            h("li", null, h("code", null, "cartserv"), " finds ", h("code", null, "CartService.ts"), ": a few letters of a name are enough"),
            h("li", null, h("code", null, "total rounded"), " finds files whose path has both, or lines with the phrase"),
            h("li", null, "Turn on ", h("code", null, ".*"), " for a regular expression, ", h("code", null, "ab"), " for whole words"),
          ),
          recent.length ? h("div", { class: "search-recent" }, h("span", { class: "dim" }, "Recent"), recent.map((q) => h("button", { type: "button", class: "chip", onclick: () => ((state.q = q), (input.value = q), run(true), input.focus()) }, q))) : null,
        ),
      );
    }

    function facetSection(title, items, selected, key, label) {
      if (!items.length) return null;
      const max = Math.max(...items.map((x) => x.count));
      return h(
        "section",
        { class: "facet-group" },
        h("h2", { class: "label-pixel" }, title),
        h(
          "ul",
          { class: "facet-list" },
          items.map((f) =>
            h(
              "li",
              null,
              h(
                "button",
                {
                  type: "button",
                  class: "facet-row",
                  "aria-pressed": String(selected.has(f.value)),
                  onclick: () => {
                    selected.has(f.value) ? selected.delete(f.value) : selected.add(f.value);
                    run(true);
                  },
                },
                h("span", { class: "facet-name mono" }, label(f.value)),
                h("span", { class: "facet-count" }, String(f.count)),
                h("span", { class: "facet-bar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.max(6, Math.round((f.count / max) * 100))}%` } })),
              ),
            ),
          ),
        ),
      );
    }

    function hitRow(file, hit, index) {
      const row = h(
        "div",
        { class: "hit", dataset: { row: String(index) }, onclick: () => select(index), ondblclick: () => open(index) },
        h("span", { class: "hit-line mono" }, String(hit.line)),
        hit.kind ? h("span", { class: `hit-kind hit-${hit.kind}` }, hit.kind === "definition" ? "def" : hit.kind === "import" ? "imp" : "//") : h("span", { class: "hit-kind" }),
        h("code", { class: "hit-code" }, codeLine(hit.text, file.ext, hit.ranges)),
        h(
          "div",
          { class: "hit-context mono" },
          [...hit.before.map((c) => [c, "ctx"]), [{ line: hit.line, text: hit.text }, "now"], ...hit.after.map((c) => [c, "ctx"])].map(([c, kind]) =>
            h("div", { class: `ctx-line ${kind}` }, h("span", { class: "hit-line" }, String(c.line)), h("code", null, kind === "now" ? codeLine(c.text, file.ext, hit.ranges) : codeLine(c.text, file.ext))),
          ),
        ),
      );
      return row;
    }

    function draw() {
      const r = result;
      rows = [];
      // Facets and the preview only when there is something to narrow or to show.
      layout.classList.toggle("is-bare", !r.files.length || !!r.patternError);
      const files = r.files;
      const maxMatches = Math.max(1, ...files.map((f) => f.matches));
      if (r.patternError) {
        fill(list$, h("div", { class: "card card-pad" }, problemBlock({ code: "pattern", message: `${r.patternError}`, fixes: [] })));
        fill(facets);
        fill(status, "That isn't a pattern dx can use.");
        return;
      }
      const all = state.scope === "all";
      fill(
        facets,
        facetSection("Kinds", r.facets.ext, state.ext, "ext", (v) => (v === "(none)" ? "no extension" : `.${v}`)),
        all ? facetSection("Projects", r.facets.folder, state.folder, "folder", (v) => v) : facetSection("Folders", r.facets.folder, state.folder, "folder", (v) => (v === "(root)" ? "top level" : v)),
      );
      // The project facet in "all" is a filter by project name: sent as folders it would mean nothing, so it narrows here.
      let shown = files;
      if (all && state.folder.size) shown = files.filter((f) => state.folder.has(f.project));
      const tail = [];
      if (r.partial) tail.push("stopped early: narrow it");
      if (r.truncated) tail.push(`showing ${shown.length} of ${r.totals.files}`);
      fill(status, `${plural(r.totals.files, "file")}${r.totals.matches ? `, ${plural(r.totals.matches, "match", "matches")}` : ""} · ${r.totals.ms} ms${tail.length ? ` · ${tail.join(" · ")}` : ""}`);
      announce(`${plural(r.totals.files, "file")} found`);
      if (!shown.length) {
        fill(
          list$,
          h(
            "div",
            { class: "card card-pad search-none" },
            h("p", { class: "search-start-title" }, `Nothing for “${r.query}”`),
            h("ul", { class: "search-tips" }, [
              state.word ? h("li", null, "Whole words is on: ", h("button", { type: "button", class: "btn btn-sm", onclick: () => ((state.word = false), syncControls(), run(true)) }, "Turn it off")) : null,
              state.mode !== "all" ? h("li", null, "Only ", state.mode === "files" ? "file names" : "the inside of files", " is searched: ", h("button", { type: "button", class: "btn btn-sm", onclick: () => ((state.mode = "all"), syncControls(), run(true)) }, "Search everything")) : null,
              state.scope !== "all" ? h("li", null, h("button", { type: "button", class: "btn btn-sm", onclick: () => ((state.scope = "all"), syncControls(), run(true)) }, "Search all projects")) : null,
              state.ext.size || state.folder.size ? h("li", null, h("button", { type: "button", class: "btn btn-sm", onclick: () => ((state.ext = new Set()), (state.folder = new Set()), run(true)) }, "Clear the kinds and folders")) : null,
            ]),
          ),
        );
        fill(preview, h("p", { class: "dim search-preview-empty" }, ""));
        sel = -1;
        return;
      }
      const cards = shown.map((f, fi) => {
        const base = rows.length;
        const hits = f.hits.length ? f.hits : [];
        if (!hits.length) rows.push({ file: f, line: 1 });
        else for (const hit of hits) rows.push({ file: f, line: hit.line, hit });
        const hitEls = hits.map((hit, hi) => hitRow(f, hit, base + hi));
        const nameRow = !hits.length ? h("div", { class: "hit hit-name", dataset: { row: String(base) }, onclick: () => select(base), ondblclick: () => open(base) }, h("span", { class: "dim" }, "Name matches")) : null;
        const more = f.lines > hits.length ? h("p", { class: "hit-more dim" }, `…and ${plural(f.matches - hits.reduce((n, x) => n + x.ranges.length, 0), "more match", "more matches")}`) : null;
        const fold = hitEls.length > 3;
        const holder = h("div", { class: `hits${fold ? " is-folded" : ""}` }, hitEls, nameRow, more);
        const card = h(
          "article",
          { class: "result", style: { "--i": String(Math.min(fi, 12)) }, dataset: { file: f.path } },
          h(
            "header",
            { class: "result-head" },
            all ? h("span", { class: "badge", title: "The project" }, f.project) : null,
            h("span", { class: "result-ext mono" }, f.ext || "·"),
            pathView(f.path, f.nameRanges),
            f.matches ? h("span", { class: "badge result-count" }, plural(f.matches, "match", "matches")) : h("span", { class: "badge" }, "name"),
            h("span", { class: "result-actions toolbar" }, btn("", () => open(base), { small: true, kind: "ghost", iconName: "code", title: "Open in your editor", name: `Open ${f.path} in editor` }), btn("", (ev) => copy(ev.currentTarget, f.path), { small: true, kind: "ghost", iconName: "copy", title: "Copy the path", name: `Copy the path of ${f.path}` })),
          ),
          f.matches ? h("div", { class: "result-heat", "aria-hidden": "true" }, h("span", { style: { width: `${Math.max(3, Math.round((f.matches / maxMatches) * 100))}%` } })) : null,
          holder,
          fold ? h("button", { type: "button", class: "hits-toggle", onclick: (ev) => { holder.classList.toggle("is-folded"); ev.currentTarget.textContent = holder.classList.contains("is-folded") ? `Show ${hitEls.length - 3} more lines` : "Show fewer"; } }, `Show ${hitEls.length - 3} more lines`) : null,
        );
        return card;
      });
      fill(list$, cards);
      if (sel < 0 || sel >= rows.length) sel = 0;
      select(sel, { scroll: false });
    }

    function copy(button, text) {
      navigator.clipboard?.writeText(text).then(
        () => {
          const was = [...button.childNodes];
          button.replaceChildren(icon("check"));
          setTimeout(() => button.isConnected && button.replaceChildren(...was), 1300);
        },
        () => toast("Couldn't copy: the browser didn't allow it", "error"),
      );
    }

    // ---- the selection and the preview
    function select(i, { scroll = true } = {}) {
      if (!rows.length) return;
      sel = Math.max(0, Math.min(i, rows.length - 1));
      for (const el of list$.querySelectorAll(".hit.is-selected")) {
        el.classList.remove("is-selected");
        el.removeAttribute("aria-current");
      }
      const el = list$.querySelector(`[data-row="${sel}"]`);
      if (el) {
        el.classList.add("is-selected");
        el.setAttribute("aria-current", "true");
        // A folded file opens when you move into it.
        const holder = el.closest(".hits");
        if (holder?.classList.contains("is-folded") && !el.matches(".hit:nth-child(-n+3)")) {
          holder.classList.remove("is-folded");
          const t = holder.parentElement.querySelector(".hits-toggle");
          if (t) t.textContent = "Show fewer";
        }
        if (scroll) el.scrollIntoView({ block: "nearest" });
      }
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => drawPreview(rows[sel]), 70);
    }

    async function drawPreview(row) {
      if (!row) return;
      const mine = ++previewSeq;
      const file = row.file;
      const fileDir = file.dir ?? dir;
      const head = h(
        "header",
        { class: "preview-head" },
        h("span", { class: "result-ext mono" }, file.ext || "·"),
        pathView(file.path),
        h("span", { class: "toolbar" }, btn("Open in editor", () => open(sel), { small: true, kind: "primary", iconName: "code" })),
      );
      if (!preview.firstChild || preview.dataset.file !== `${fileDir}|${file.path}`) fill(preview, head, h("div", { class: "preview-body" }, loadingView("Reading…")));
      try {
        const w = await api(`/api/search/preview?dir=${encodeURIComponent(fileDir)}&file=${encodeURIComponent(file.path)}&line=${row.line}&around=22`);
        if (mine !== previewSeq) return;
        const known = new Map((file.hits ?? []).map((x) => [x.line, x.ranges]));
        const body = h(
          "div",
          { class: "preview-body" },
          h("div", { class: "preview-code mono", role: "region", "aria-label": `${file.path} around line ${row.line}`, tabindex: "0" },
            w.lines.map((l) =>
              h("div", { class: `pv-line${l.line === row.line ? " is-focus" : ""}${known.has(l.line) ? " is-hit" : ""}`, dataset: { line: String(l.line) } }, h("span", { class: "pv-no" }, String(l.line)), h("code", { class: "pv-text" }, l.text ? codeLine(l.text, w.ext, known.get(l.line) ?? []) : "​")),
            ),
          ),
          h("p", { class: "dim preview-foot" }, `Lines ${w.lines[0]?.line ?? 1} to ${w.lines[w.lines.length - 1]?.line ?? 1} of ${w.total}`),
        );
        fill(preview, head, body);
        preview.dataset.file = `${fileDir}|${file.path}`;
        body.querySelector(".is-focus")?.scrollIntoView({ block: "center" });
      } catch (err) {
        if (mine !== previewSeq) return;
        fill(preview, head, h("div", { class: "preview-body" }, h("p", { class: "dim" }, err.message)));
      }
    }

    async function open(i) {
      const row = rows[i];
      if (!row) return;
      try {
        const r = await api("/api/open-file", { method: "POST", body: { dir: row.file.dir ?? dir, file: row.file.path, line: row.line } });
        toast(r.message);
      } catch (err) {
        toast(err.message, "error");
      }
    }

    // ---- keys: the arrows move through the matches, Enter opens one, Esc clears
    function onKey(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = e.target instanceof Element && e.target.closest("textarea, select, input:not(#search-q)");
      if (typing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!rows.length) return;
        e.preventDefault();
        select(sel + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter" && rows.length && (e.target === input || e.target === document.body || e.target.closest?.(".search-results"))) {
        e.preventDefault();
        open(sel);
      } else if (e.key === "Escape" && state.q) {
        state.q = "";
        input.value = "";
        run(true);
      }
    }
    document.addEventListener("keydown", onKey);
    input.addEventListener("input", () => {
      state.q = input.value;
      run();
    });

    drawEmpty();
    if (state.q.trim()) run(true);
    input.focus();
    input.select();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      clearTimeout(rememberTimer);
      clearTimeout(previewTimer);
      document.removeEventListener("keydown", onKey);
    };
  };
};
