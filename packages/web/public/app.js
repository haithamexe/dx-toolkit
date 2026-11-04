// dx dashboard. Plain JavaScript, no framework. Everything from the projects (names, commit
// messages, dev server output) is put on the page as text, never as HTML.

const TOKEN = document.querySelector('meta[name="dx-token"]')?.content ?? "";
const main = document.getElementById("main");
const nav = document.getElementById("nav");

// ------------------------------------------------------------------ helpers

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "X-DX-Token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach dx. Is `dx ui` still running in your terminal?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

/** h("button", { class: "btn", onclick }, "Text", child) */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style") Object.assign(el.style, value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, ...children);
  return el;
}

function append(el, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  new: "M12 5v14M5 12h14",
  ports: "M7 3v5M17 3v5M5 8h14v3a7 7 0 0 1-14 0zM12 18v3",
  journal: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  summary: "M4 19V9M10 19V5M16 19v-7M22 19H2",
  cleanup: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  deps: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4",
  health: "M3 12h4l3-8 4 16 3-8h4",
  activity: "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4",
  key: "M10.8 13.2L20 4M16.5 7.5l2.5 2.5M14 10l2 2M7.5 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  play: "M7 4l13 8-13 8z",
  stop: "M6 6h12v12H6z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  terminal: "M4 6l6 6-6 6M12 18h8",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  refresh: "M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  save: "M5 4h11l3 3v13H5zM8 4v5h7M8 20v-6h8v6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  log: "M4 6h16M4 12h16M4 18h10",
  template: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16 14v6M13 17h6",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  warn: "M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5L20 7",
  git: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  right: "M5 12h14M13 6l6 6-6 6",
  left: "M19 12H5M11 6l-6 6 6 6",
  tag: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.info);
  if (name === "more") path.setAttribute("stroke-width", "3.5"); // dots need a thicker pen to be seen
  svg.append(path);
  return svg;
}

function btn(label, onclick, { kind = "", iconName, small = false, disabled = false, title, type = "button", name } = {}) {
  return h(
    "button",
    { type, class: `btn ${kind ? `btn-${kind}` : ""} ${small ? "btn-sm" : ""}`.trim(), onclick, disabled, title, "aria-label": name },
    iconName ? icon(iconName) : null,
    label,
  );
}

/** Runs an action from a button: disables it, shows "…" text while busy, reports errors. */
async function busy(button, busyLabel, fn) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), busyLabel);
  try {
    return await fn();
  } catch (err) {
    toast(err.message, "error");
    return undefined;
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.replaceChildren(...original);
    }
  }
}

function toast(message, kind = "ok") {
  const el = h("div", { class: `toast ${kind === "error" ? "toast-error" : ""}` }, h("div", null, message));
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4500);
}

function confirmDialog({ title, text, confirm = "Confirm", danger = true }) {
  const dialog = document.getElementById("confirm");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").replaceChildren(...(Array.isArray(text) ? text : [text]).map((t) => (t instanceof Node ? t : h("p", null, t))));
  const ok = document.getElementById("confirm-ok");
  ok.textContent = confirm;
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

function stateView(title, text, ...actions) {
  return h("div", { class: "state" }, h("p", { class: "state-title" }, title), text ? h("p", null, text) : null, actions.length ? h("div", { class: "toolbar" }, actions) : null);
}

function loadingView(text) {
  return h("div", { class: "state", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("p", null, text));
}

function errorView(err, retry) {
  return h(
    "div",
    { class: "note note-danger", role: "alert" },
    icon("warn"),
    h("div", null, h("p", null, err.message), retry ? h("p", null, btn("Try again", retry, { small: true, iconName: "refresh" })) : null),
  );
}

function pageHead(title, sub, ...actions) {
  return h(
    "div",
    { class: "page-head" },
    h("div", null, h("h1", { class: "page-title" }, title), sub ? h("p", { class: "page-sub" }, sub) : null),
    actions.length ? h("div", { class: "toolbar" }, actions) : null,
  );
}

function segmented(label, options, value, onchange) {
  const group = h("div", { class: "segmented", role: "group", "aria-label": label });
  for (const [v, text] of options) {
    group.append(
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(v === value),
          onclick: () => {
            for (const b of group.children) b.setAttribute("aria-pressed", "false");
            group.querySelector(`[data-v="${v}"]`)?.setAttribute("aria-pressed", "true");
            onchange(v);
          },
          dataset: { v: String(v) },
        },
        text,
      ),
    );
  }
  return group;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(y, m - 1, d);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return "Today";
  if (at.toDateString() === yesterday.toDateString()) return "Yesterday";
  return `${WEEKDAYS[at.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

function relativeTime(ms) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

const ROLE_LABELS = { data: "database", backend: "back end", frontend: "front end" };

const STACK_SOURCES = {
  devrc: ".devrc.json",
  procfile: "the Procfile",
  runner: "the monorepo's dev script",
  scripts: "the dev:* scripts",
  workspaces: "the workspaces",
  compose: "docker-compose",
};

const KIND_LABELS = { typescript: "TypeScript", build: "Build", runtime: "Runtime", python: "Python", go: "Go", exit: "Crashed", error: "Error" };

/** A file path as seen from its project: "C:/work/shop/src/App.tsx" → "src/App.tsx". */
function inProject(file, dir) {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
  return f.toLowerCase().startsWith(`${d.toLowerCase()}/`) ? f.slice(d.length + 1) : tildify(file);
}

function tildify(p) {
  return p.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~").replace(/^\/(Users|home)\/[^/]+/, "~");
}

function pref(key, fallback) {
  try {
    return localStorage.getItem(`dx.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(`dx.${key}`, String(value));
  } catch {
    // private window: preferences just aren't remembered
  }
}

// ------------------------------------------------------------------ viewers: payloads, stacks, console

/**
 * Details are shown "visual" (JSON as a tree, forms as tables, stacks as frames, a request's
 * status and time at a glance) or "raw" (the exact text). One choice for the whole dashboard,
 * remembered, and every open detail follows it.
 */
let detailMode = pref("detailMode", "visual") === "raw" ? "raw" : "visual";
const liveDetails = new Set();

function setDetailMode(mode) {
  detailMode = mode;
  setPref("detailMode", mode);
  for (const d of [...liveDetails]) {
    if (d.el.isConnected) d.draw();
    else liveDetails.delete(d);
  }
}

/** A detail that redraws itself when Visual/Raw changes; `draw(mode)` returns its content. */
function liveDetail(draw) {
  const el = h("div", { class: "detail" });
  const entry = {
    el,
    draw: () =>
      el.replaceChildren(
        h(
          "div",
          { class: "detail-bar" },
          segmented("Show details as", [["visual", "Visual"], ["raw", "Raw"]], detailMode, setDetailMode),
        ),
        ...[draw(detailMode)].flat(Infinity).filter(Boolean),
      ),
  };
  entry.draw();
  liveDetails.add(entry);
  el.redraw = entry.draw;
  return el;
}

function copyButton(text, label = "Copy") {
  return btn(label, async (ev) => {
    const b = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      b.replaceChildren(icon("check"), "Copied");
      setTimeout(() => b.isConnected && b.replaceChildren(icon("copy"), label), 1500);
    } catch {
      toast("Couldn't copy: the browser didn't allow it", "error");
    }
  }, { small: true, kind: "ghost", iconName: "copy" });
}

function parseJson(text) {
  if (typeof text !== "string" || !/^\s*[[{"\d-]|^\s*(true|false|null)\s*$/.test(text)) return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** A JSON value as a tree: objects and arrays fold, the first two levels start open. */
function jsonTree(value, depth = 0) {
  if (value === null) return h("span", { class: "json-literal" }, "null");
  if (typeof value === "boolean") return h("span", { class: "json-literal" }, String(value));
  if (typeof value === "number") return h("span", { class: "json-number" }, String(value));
  if (typeof value === "string") return h("span", { class: "json-string" }, JSON.stringify(value));
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  if (!entries.length) return h("span", { class: "json-punct" }, `${open}${close}`);
  const count = isArray ? plural(entries.length, "item") : plural(entries.length, "key");
  return h(
    "details",
    { class: "json-node", open: depth < 2 && entries.length <= 50 ? true : undefined },
    h("summary", null, h("span", { class: "json-punct" }, open), h("span", { class: "json-count" }, ` ${count} `), h("span", { class: "json-punct json-close-inline" }, close)),
    h(
      "ul",
      { class: "json-tree" },
      entries.slice(0, 500).map(([k, v]) => h("li", null, h("span", { class: isArray ? "json-index" : "json-key" }, isArray ? `${k}` : JSON.stringify(k)), h("span", { class: "json-punct" }, ": "), jsonTree(v, depth + 1))),
      entries.length > 500 ? h("li", { class: "dim" }, `… ${entries.length - 500} more`) : null,
    ),
    h("span", { class: "json-punct" }, close),
  );
}

/** key=value&… as a table. */
function formTable(text) {
  const rows = text.split("&").filter(Boolean).map((pair) => {
    const [k, ...rest] = pair.split("=");
    const dec = (s) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return s;
      }
    };
    return [dec(k), dec(rest.join("="))];
  });
  return keyValueTable(rows);
}

function keyValueTable(rows) {
  return h("div", { class: "table-wrap" }, h("table", { class: "table kv-table" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", { scope: "row", class: "mono" }, k), h("td", { class: "mono" }, v))))));
}

/** A request or response body: a JSON tree, a form table, or text; Raw is the exact text. */
function bodyBlock(label, body, type = "", note = "") {
  const json = parseJson(body);
  const isForm = /x-www-form-urlencoded/i.test(type) && !json;
  return (mode) =>
    h(
      "section",
      { class: "detail-section" },
      h(
        "div",
        { class: "detail-head" },
        h("strong", null, label),
        h("span", { class: "dim" }, [type.split(";")[0], formatBytes(new TextEncoder().encode(body).length), note].filter(Boolean).join(" · ")),
        copyButton(() => (json && mode === "visual" ? JSON.stringify(json.value, null, 2) : body)),
      ),
      mode === "raw" || (!json && !isForm)
        ? h("pre", { class: "log-snippet raw-text" }, mode === "raw" ? body : body)
        : json
          ? h("div", { class: "json-view" }, jsonTree(json.value))
          : formTable(body),
    );
}

function headersBlock(req = {}, res = {}) {
  return (mode) => {
    const reqRows = Object.entries(req);
    const resRows = Object.entries(res);
    if (mode === "raw") {
      return h("pre", { class: "log-snippet raw-text" }, [...reqRows.map(([k, v]) => `> ${k}: ${v}`), ...resRows.map(([k, v]) => `< ${k}: ${v}`)].join("\n"));
    }
    return [
      resRows.length ? h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "Response headers")), keyValueTable(resRows)) : null,
      reqRows.length ? h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "Request headers")), keyValueTable(reqRows)) : null,
    ];
  };
}

/** Frames out of a V8 or Firefox stack; the lines before the first frame are the message. */
function parseStack(stack) {
  const head = [];
  const frames = [];
  for (const line of String(stack).split("\n")) {
    const v8 = /^\s*at (?:(.+?) \()?((?:[a-z]+:\/\/|[A-Za-z]:\\|\/)?[^()]*?):(\d+)(?::(\d+))?\)?\s*$/.exec(line);
    const ff = !v8 && /^(.*?)@(.+?):(\d+)(?::(\d+))?$/.exec(line.trim());
    const m = v8 || ff;
    if (m) frames.push({ fn: m[1] || "(anonymous)", file: m[2], line: Number(m[3]), column: m[4] ? Number(m[4]) : undefined });
    else if (!frames.length && line.trim()) head.push(line);
  }
  return { head, frames };
}

const LIBRARY_FRAME = /node_modules|^node:|node:internal|\(internal\/|^internal\/|\.vite\/deps|\/chunk-[\w-]+\.js|webpack-internal|<anonymous>|dx-recorder\.js|^native$/;

/** Where in a project a location is, for opening it: the browser names files by address, the server by path. */
function projectFile(location) {
  const file = String(location).replace(/^https?:\/\/[^/]+/, "").replace(/^webpack:\/\/\/?/, "").replace(/\?.*$/, "").replace(/^\/(?=[^/]+\/)/, "");
  if (LIBRARY_FRAME.test(location) || /^\/?@|^\/?__/.test(file)) return undefined;
  return file;
}

/** A button that opens a file in your editor at a line, or the location as text when it isn't one of the project's files. */
function openAt(dir, location, line, column) {
  const file = projectFile(location);
  const label = `${file ? inProject(file, dir) : location}:${line}${column ? `:${column}` : ""}`;
  if (!file || !dir) return h("span", { class: "dim mono" }, label);
  return btn(label, (ev) => busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir, file, line, column } })).message)), {
    small: true,
    kind: "ghost",
    iconName: "code",
    title: "Open in your editor at this line",
    name: `Open ${label} in editor`,
  });
}

/** A stack as frames: yours first-class, libraries folded into one line. */
function stackBlock(stack, dir) {
  return (mode) => {
    const parsed = parseStack(stack);
    if (mode === "raw" || !parsed.frames.length) {
      return h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "Stack"), copyButton(stack)), h("pre", { class: "log-snippet raw-text" }, stack));
    }
    const items = [];
    let folded = [];
    const flush = () => {
      if (!folded.length) return;
      const list = folded;
      folded = [];
      items.push(
        h(
          "li",
          { class: "frame frame-lib" },
          h("details", null, h("summary", { class: "dim" }, `${plural(list.length, "frame")} in libraries and the runtime`), h("ul", { class: "frames" }, list.map((f) => h("li", { class: "frame dim mono" }, `${f.fn} · ${f.file}:${f.line}`)))),
        ),
      );
    };
    for (const f of parsed.frames) {
      if (LIBRARY_FRAME.test(f.file) || LIBRARY_FRAME.test(f.fn)) {
        folded.push(f);
        continue;
      }
      flush();
      items.push(h("li", { class: "frame" }, h("span", { class: "frame-fn mono" }, f.fn), openAt(dir, f.file, f.line, f.column)));
    }
    flush();
    return h(
      "section",
      { class: "detail-section" },
      h("div", { class: "detail-head" }, h("strong", null, "Stack"), h("span", { class: "dim" }, plural(parsed.frames.length, "frame")), copyButton(stack)),
      parsed.head.length > 1 ? h("pre", { class: "log-snippet raw-text" }, parsed.head.join("\n")) : null,
      h("ol", { class: "frames" }, items),
    );
  };
}

/** A console line: the text, with any object or array in it as a tree. */
function consoleBlock(text) {
  return (mode) => {
    if (mode === "raw") return h("pre", { class: "log-snippet raw-text" }, text);
    const parts = [];
    let rest = text;
    while (rest) {
      const at = rest.search(/[[{]/);
      if (at < 0) break;
      const end = matchingBracket(rest, at);
      const json = end > at ? parseJson(rest.slice(at, end + 1)) : undefined;
      if (!json || typeof json.value !== "object" || json.value === null) {
        parts.push(rest.slice(0, at + 1));
        rest = rest.slice(at + 1);
        continue;
      }
      if (at) parts.push(rest.slice(0, at));
      parts.push(h("div", { class: "json-view" }, jsonTree(json.value)));
      rest = rest.slice(end + 1);
    }
    if (rest) parts.push(rest);
    // Adjacent text pieces as one line.
    const merged = [];
    for (const p of parts) {
      if (typeof p === "string" && typeof merged[merged.length - 1] === "string") merged[merged.length - 1] += p;
      else merged.push(p);
    }
    return h("div", { class: "console-view" }, merged.map((p) => (typeof p === "string" ? (p.trim() ? h("p", { class: "mono console-text" }, p.trim()) : null) : p)));
  };
}

/** The index of the bracket closing the one at `start`, skipping brackets inside strings; -1 if none. */
function matchingBracket(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A request at a glance: method, status, address, how long it took, and how big it was. */
function requestSummary(e) {
  const status = e.status ?? 0;
  const tone = e.error || status >= 500 ? "danger" : status >= 400 ? "warn" : status >= 300 ? "accent" : "ok";
  const ms = e.ms;
  const speed = ms === undefined ? "" : ms < 200 ? "fast" : ms < 1000 ? "ok" : "slow";
  const size = (s) => (s ? formatBytes(new TextEncoder().encode(s).length) : undefined);
  return h(
    "div",
    { class: "req-summary" },
    h("span", { class: "badge mono req-method" }, e.method ?? "GET"),
    h("span", { class: `badge badge-${tone}` }, e.error ? `failed: ${e.error}` : String(status || "…")),
    h("span", { class: "mono req-url" }, e.url ?? e.text),
    ms !== undefined
      ? h(
          "span",
          { class: "req-time", title: `${ms} ms` },
          h("span", { class: "req-bar" }, h("span", { class: `req-bar-fill req-${speed}`, style: { width: `${Math.max(4, Math.min(100, (ms / Math.max(1000, ms)) * 100))}%` } })),
          h("span", { class: "dim" }, `${ms} ms`),
        )
      : null,
    h("span", { class: "dim" }, [size(e.requestBody) && `sent ${size(e.requestBody)}`, size(e.responseBody) && `got ${size(e.responseBody)}`].filter(Boolean).join(" · ")),
  );
}

/** A request's whole detail: the summary, then its response, request and headers as tabs. */
function requestDetail(e, tab = { current: undefined }) {
  const tabs = [];
  if (e.responseBody) tabs.push(["response", "Response"]);
  if (e.requestBody) tabs.push(["request", "Request"]);
  if ((e.requestHeaders && Object.keys(e.requestHeaders).length) || (e.responseHeaders && Object.keys(e.responseHeaders).length)) tabs.push(["headers", "Headers"]);
  tab.current ??= tabs[0]?.[0];
  const blocks = {
    response: () => bodyBlock("Response", e.responseBody, e.responseHeaders?.["content-type"] ?? "", e.truncated ? "cut short" : ""),
    request: () => bodyBlock("Request", e.requestBody, e.requestHeaders?.["content-type"] ?? ""),
    headers: () => headersBlock(e.requestHeaders, e.responseHeaders),
  };
  let view;
  view = liveDetail((mode) => [
    requestSummary(e),
    tabs.length > 1
      ? segmented("Part of the request", tabs, tab.current, (v) => {
          tab.current = v;
          view.redraw();
        })
      : null,
    tab.current ? blocks[tab.current]()(mode) : h("p", { class: "dim" }, "No body was kept for this request."),
  ]);
  return view;
}

/** Where a diff block starts: "@@ -12,5 +12,7 @@ function name" → { old: 12, new: 12, context: "function name" }. */
function hunkStart(header) {
  const m = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@+ ?(.*)$/.exec(header);
  return m ? { old: Number(m[1]), new: Number(m[2]), context: m[3] } : { old: 0, new: 0, context: "" };
}

const DIFF_ROWS_MAX = 3000;

/**
 * One block of a diff side by side: unchanged lines on both sides, each removed line next to the
 * added line that replaced it. Under 860px the sides stack into one column. `budget.rows` caps
 * how many rows a whole diff draws.
 */
function hunkView(header, lines, { action, budget = { rows: DIFF_ROWS_MAX } } = {}) {
  const start = hunkStart(header);
  let oldNo = start.old;
  let newNo = start.new;
  // A block that only adds (a new file) or only removes needs one side, not two.
  const oneSide = lines.every((l) => l[0] === "+" || l[0] === "\\") || lines.every((l) => l[0] === "-" || l[0] === "\\");
  const grid = h("div", { class: `diff-grid${oneSide ? " diff-grid-one" : ""}` });
  const cells = (side, kind, no, text) => [
    h("span", { class: `diff-no diff-${side} diff-${kind}`, "aria-hidden": "true" }, no ?? ""),
    h("span", { class: `diff-text diff-${side} diff-${kind}` }, kind === "del" ? h("span", { class: "visually-hidden" }, "removed: ") : kind === "add" ? h("span", { class: "visually-hidden" }, "added: ") : null, text ?? ""),
  ];
  let dels = [];
  let adds = [];
  let cut = 0;
  const row = (cls, ...children) => {
    if (budget.rows <= 0) return void cut++;
    budget.rows--;
    grid.append(h("div", { class: `diff-row ${cls}` }, children));
  };
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      row("diff-row-change", d ? cells("left", "del", d.no, d.text) : cells("left", "empty"), a ? cells("right", "add", a.no, a.text) : cells("right", "empty"));
    }
    dels = [];
    adds = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "-") {
      if (adds.length) flush();
      dels.push({ no: oldNo++, text });
    } else if (mark === "+") adds.push({ no: newNo++, text });
    else if (mark === "\\") continue; // "\ No newline at end of file"
    else {
      flush();
      row("diff-row-ctx", cells("left", "ctx", oldNo++, text), cells("right", "ctx", newNo++, text));
    }
  }
  flush();
  return h(
    "div",
    { class: "diff-hunk" },
    h("div", { class: "diff-hunk-head" }, h("span", { class: "mono" }, header.replace(/ @@+ .*$/, " @@")), start.context ? h("span", { class: "diff-context mono" }, start.context) : null, action ?? null),
    grid,
    cut ? h("p", { class: "dim diff-cut" }, `${plural(cut, "more line")} not drawn. Raw shows them all.`) : null,
  );
}

/** A patch ("diff --git …") split into files, each with its blocks and what kind of change it is. */
function parsePatch(patch) {
  const files = [];
  let file;
  let hunk;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { head: [line], hunks: [], path: "", from: "", additions: 0, deletions: 0, kind: "modified", binary: false };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line === "") continue;
      hunk.lines.push(line);
      if (line[0] === "+") file.additions++;
      else if (line[0] === "-") file.deletions++;
    } else {
      file.head.push(line);
      if (line.startsWith("+++ ")) file.path = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("--- ")) file.from = line.slice(4).replace(/^a\//, "");
      else if (line.startsWith("rename from ")) (file.from = line.slice(12)), (file.kind = "renamed");
      else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("new file mode")) file.kind = "added";
      else if (line.startsWith("deleted file mode")) file.kind = "deleted";
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
    }
  }
  for (const f of files) {
    if (!f.path || f.path === "/dev/null") f.path = f.from && f.from !== "/dev/null" ? f.from : (/ b\/(.+)$/.exec(f.head[0])?.[1] ?? "");
    if (f.kind !== "renamed") f.from = "";
  }
  return files;
}

const CHANGE_LABELS = { modified: "M", added: "A", deleted: "D", renamed: "R" };

/** A patch, Visual (files folded, blocks side by side) or Raw (the exact text). */
function diffBlock(patch, { truncated = false } = {}) {
  return (mode) => {
    const cutNote = truncated ? h("p", { class: "dim" }, "The patch is cut at 512 KB; the rest isn't shown in either view.") : null;
    if (mode === "raw" || !patch.startsWith("diff --git")) {
      return h(
        "section",
        { class: "detail-section" },
        h("div", { class: "detail-head" }, h("strong", null, "Patch"), copyButton(patch)),
        h("pre", { class: "log-snippet raw-text diff-raw" }, patch || "No changes."),
        cutNote,
      );
    }
    const files = parsePatch(patch);
    const budget = { rows: DIFF_ROWS_MAX };
    return h(
      "section",
      { class: "detail-section" },
      h("div", { class: "detail-head" }, h("strong", null, plural(files.length, "file")), h("span", { class: "diff-add-count" }, `+${files.reduce((n, f) => n + f.additions, 0)}`), h("span", { class: "diff-del-count" }, `−${files.reduce((n, f) => n + f.deletions, 0)}`), copyButton(patch)),
      h(
        "div",
        { class: "diff-files" },
        files.map((f, i) => {
          const body = h("div", { class: "diff-file-body" });
          // The files open at first share one budget; one opened later gets its own.
          const fill = (rows = { rows: DIFF_ROWS_MAX }) => {
            if (body.childElementCount) return;
            if (f.binary) body.append(h("p", { class: "dim" }, "A binary file: its changes can't be shown as text."));
            else if (!f.hunks.length) body.append(h("p", { class: "dim" }, f.kind === "renamed" ? "Renamed, with no changes inside." : "Only the file's mode changed."));
            else body.append(...f.hunks.map((hk) => hunkView(hk.header, hk.lines, { budget: rows })));
          };
          const open = i < 6;
          const el = h(
            "details",
            { class: "diff-file", open: open || undefined, ontoggle: (e) => e.target.open && fill() },
            h(
              "summary",
              { class: "diff-file-head" },
              h("span", { class: `git-code git-code-${CHANGE_LABELS[f.kind]}`, title: f.kind }, CHANGE_LABELS[f.kind]),
              h("span", { class: "diff-file-name mono" }, f.from ? `${f.from} → ${f.path}` : f.path),
              f.binary ? h("span", { class: "badge" }, "binary") : h("span", { class: "diff-file-counts" }, h("span", { class: "diff-add-count" }, `+${f.additions}`), " ", h("span", { class: "diff-del-count" }, `−${f.deletions}`)),
            ),
            body,
          );
          if (open) fill(budget);
          return el;
        }),
      ),
      cutNote,
    );
  };
}

/**
 * Which terminal projects open in: the installed ones, saved to the settings on change. Used on
 * the Projects page and in Health & settings.
 */
function terminalSelect({ withLabel = false } = {}) {
  const select = h("select", {
    id: withLabel ? "cfg-terminal" : undefined,
    "aria-label": withLabel ? undefined : "Terminal projects open in",
    title: "The terminal the Terminal buttons open",
    disabled: true,
    onchange: async (e) => {
      const value = e.target.value;
      try {
        await api("/api/config", { method: "POST", body: { terminal: value } });
        toast(`Projects open in ${e.target.selectedOptions[0]?.textContent ?? value}`);
      } catch (err) {
        toast(err.message, "error");
      }
    },
  });
  (async () => {
    try {
      const list = await api("/api/terminals");
      const installed = list.filter((t) => t.installed);
      select.replaceChildren(...installed.map((t) => h("option", { value: t.id, selected: t.selected }, withLabel ? t.name : `Terminal: ${t.name}`)));
      select.disabled = installed.length < 2;
    } catch {
      select.hidden = true;
    }
  })();
  if (!withLabel) return h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Terminal projects open in"), select);
  return h("label", { class: "field", for: "cfg-terminal" }, h("span", { class: "field-label" }, "Terminal"), select, h("span", { class: "field-hint" }, "Where the Terminal buttons and Run in a terminal window open. Only terminals on this computer are listed."));
}

// ------------------------------------------------------------------ router

const pages = [
  { id: "projects", label: "Projects", icon: "projects", render: projectsPage },
  { id: "new", label: "New project", icon: "new", render: newProjectPage },
  { id: "ports", label: "Ports", icon: "ports", render: portsPage },
  { id: "git", label: "Git", icon: "git", render: gitPage },
  { id: "activity", label: "Activity", icon: "activity", render: activityPage },
  { id: "env", label: "Env & secrets", icon: "key", render: envPage },
  { id: "journal", label: "Journal", icon: "journal", render: journalPage },
  { id: "summary", label: "Summary", icon: "summary", render: summaryPage },
  { id: "cleanup", label: "Cleanup", icon: "cleanup", render: cleanupPage },
  { id: "deps", label: "Dependencies", icon: "deps", render: depsPage },
  { id: "health", label: "Health & settings", icon: "health", render: healthPage },
];

let leaveCurrent = () => {};

function renderNav(active) {
  nav.replaceChildren(
    ...pages.map((p) =>
      h(
        "a",
        { href: `#/${p.id}`, "aria-current": p.id === active ? "page" : undefined, dataset: { page: p.id } },
        icon(p.icon),
        h("span", { class: "nav-label" }, p.label),
        p.id === "projects" ? h("span", { class: "count", id: "running-count", hidden: true }) : null,
      ),
    ),
  );
}

function route() {
  const id = location.hash.replace(/^#\/?/, "").split("?")[0] || "projects";
  const page = pages.find((p) => p.id === id) ?? pages[0];
  leaveCurrent();
  leaveCurrent = () => {};
  renderNav(page.id);
  document.title = `${page.label} · dx`;
  const container = h("div", { class: "page" });
  main.replaceChildren(container);
  const cleanup = page.render(container);
  if (typeof cleanup === "function") leaveCurrent = cleanup;
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  void updateRunningCount();
}

async function updateRunningCount() {
  try {
    const servers = await api("/api/dev");
    const running = servers.filter((s) => s.status === "starting" || s.status === "ready").length;
    const el = document.getElementById("running-count");
    if (el) {
      el.hidden = running === 0;
      el.textContent = String(running);
      el.title = `${plural(running, "dev server")} running`;
    }
  } catch {
    // shown on the page itself
  }
}

// ------------------------------------------------------------------ Projects

function projectsPage(root) {
  let projects = [];
  let query = "";
  const openLogs = new Set(JSON.parse(pref("openLogs", "[]")));
  const openErrors = new Set(JSON.parse(pref("openErrors", "[]")));
  const logState = new Map(); // dir -> { after, el }
  const errorPanels = new Map(); // dir -> { el, dir, sig }
  const pageChecks = new Map(); // dir -> what the headless browser saw last time
  const envChecks = new Map(); // dir -> the last .env check
  const testRuns = new Map(); // dir -> the last test run
  const openTraffic = new Set(JSON.parse(pref("openTraffic", "[]")));
  const trafficPanels = new Map(); // dir -> { el, dir, sig }
  let unsaved = null;
  let stopped = false;

  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search projects",
    "aria-label": "Search projects",
    oninput: (e) => {
      query = e.target.value.trim().toLowerCase();
      renderList();
    },
  });
  const terminalPicker = terminalSelect();
  const devSection = h("section", { class: "section", "aria-labelledby": "dev-title", hidden: true });
  const unsavedSection = h("section", { class: "section", "aria-label": "Work that isn't backed up", hidden: true });
  const listSection = h("section", { class: "section", "aria-label": "All projects" });
  const listHolder = h("div", { class: "card" }, loadingView("Finding your projects…"));
  append(listSection, listHolder);

  append(
    root,
    pageHead(
      "Projects",
      "Open a project, run its dev server here, or open it in the browser.",
      search,
      terminalPicker,
      h("a", { class: "btn", href: "#/new" }, icon("new"), "New project"),
      btn("Refresh", () => (load(), loadUnsaved()), { iconName: "refresh", kind: "ghost" }),
    ),
    devSection,
    unsavedSection,
    listSection,
  );

  async function load() {
    try {
      projects = await api("/api/projects");
      renderList();
      renderDev();
    } catch (err) {
      listHolder.replaceChildren(errorView(err, load));
    }
  }

  // Slower than the list (git in every repository), so it fills in after.
  async function loadUnsaved() {
    try {
      unsaved = await api("/api/unsaved");
    } catch {
      unsaved = null;
    }
    renderUnsaved();
  }

  function renderUnsaved() {
    const list = unsaved ?? [];
    unsavedSection.hidden = list.length === 0;
    if (!list.length) return;
    const risky = list.filter((w) => w.unpushed || w.noRemote).length;
    const details = h(
      "details",
      { class: "card unsaved", open: pref("unsavedOpen", "") === "1" ? true : undefined, ontoggle: (e) => setPref("unsavedOpen", e.currentTarget.open ? "1" : "") },
      h(
        "summary",
        { class: "unsaved-summary" },
        icon("warn"),
        h("strong", null, `${plural(list.length, "project")} with work that isn't backed up`),
        risky ? h("span", { class: "badge badge-danger" }, `${risky} not pushed anywhere`) : null,
      ),
      h("ul", { class: "unsaved-list" }, list.map(unsavedRow)),
    );
    unsavedSection.replaceChildren(details);
  }

  function unsavedRow(w) {
    const parts = [];
    if (w.noRemote) parts.push(h("span", { class: "badge badge-danger" }, "No remote"));
    if (w.unpushed) parts.push(h("span", { class: "badge badge-danger" }, `${plural(w.unpushed, "unpushed commit")}`));
    if (w.changed) parts.push(h("span", { class: "badge badge-warn" }, plural(w.changed, "changed file")));
    if (w.untracked) parts.push(h("span", { class: "badge" }, plural(w.untracked, "new file")));
    if (w.stashes) parts.push(h("span", { class: "badge" }, `${plural(w.stashes, "stash", "stashes")}${w.oldestStash ? `, oldest ${relativeTime(Date.parse(w.oldestStash))}` : ""}`));
    return h(
      "li",
      null,
      h("strong", null, w.project),
      w.branch ? h("span", { class: "dim mono" }, w.branch) : null,
      parts,
      w.unpushedBranches.length && w.unpushedBranches.some((b) => b !== w.branch)
        ? h("span", { class: "dim" }, `on ${w.unpushedBranches.join(", ")}`)
        : null,
    );
  }

  function renderList() {
    const list = query ? projects.filter((p) => p.name.toLowerCase().includes(query) || p.dir.toLowerCase().includes(query)) : projects;
    if (projects.length === 0) {
      listHolder.replaceChildren(
        stateView("No projects found", "dx looks for folders with a package.json, go.mod, .git and similar in your projects folders.", h("a", { class: "btn btn-primary", href: "#/health" }, "Add a projects folder")),
      );
      return;
    }
    if (list.length === 0) {
      listHolder.replaceChildren(stateView(`No project matches "${query}"`, null, btn("Clear search", () => ((search.value = ""), (query = ""), renderList()))));
      return;
    }
    listHolder.replaceChildren(h("div", { class: "project-list" }, list.map(projectRow)));
  }

  function projectRow(p) {
    const running = p.dev && (p.dev.status === "starting" || p.dev.status === "ready");
    const kind = p.packageManager ? `${p.kind} · ${p.packageManager}` : p.kind;
    return h(
      "div",
      { class: "project" },
      h(
        "div",
        null,
        h(
          "div",
          { class: "project-name" },
          p.name,
          h("span", { class: "badge" }, kind),
          p.stack ? h("span", { class: "badge badge-accent", title: `Found from ${STACK_SOURCES[p.stack.source] ?? "the project"}` }, `Stack: ${p.stack.services.map((s) => s.name).join(", ")}`) : null,
          running ? statusBadge(p.dev.status) : null,
        ),
        h(
          "div",
          { class: "project-meta" },
          h("span", null, `Active ${relativeTime(p.lastActive)}`),
          p.stack ? h("span", null, `${plural(p.stack.services.length, "service")}, started in order`) : p.devCommand ? h("span", { class: "mono" }, p.devCommand) : h("span", null, "No dev command"),
          h("span", { class: "mono" }, tildify(p.dir)),
        ),
        p.session?.note
          ? h(
              "p",
              { class: "project-note" },
              h("strong", null, p.session.noteBy === "ai" ? "Note from your AI agent: " : "Your note: "),
              p.session.note,
              p.session.noteAt ? h("span", { class: "dim" }, ` · ${relativeTime(Date.parse(p.session.noteAt))}`) : null,
            )
          : null,
      ),
      h(
        "div",
        { class: "project-actions" },
        running
          ? btn("Stop", (e) => stopDev(e.currentTarget, p.dir), { iconName: "stop", small: true, name: `Stop ${p.name}` })
          : p.devCommand || p.stack
            ? btn("Run", (e) => startDev(e.currentTarget, p.dir), {
                kind: "primary",
                iconName: "play",
                small: true,
                title: p.stack ? `Run its ${p.stack.services.length} services here` : `Run ${p.devCommand} here`,
                name: `Run ${p.name}`,
              })
            : null,
        btn("Open in editor", (e) => open(e.currentTarget, p, "editor"), { iconName: "code", small: true, name: `Open ${p.name} in editor` }),
        btn("Terminal", (e) => open(e.currentTarget, p, "shell"), { iconName: "terminal", small: true, name: `Open ${p.name} in a terminal`, title: "Open a terminal in this project's folder" }),
        moreMenu(p),
      ),
      testRuns.has(p.dir.toLowerCase()) ? testPanel(p, testRuns.get(p.dir.toLowerCase())) : null,
      envChecks.has(p.dir.toLowerCase()) ? envPanel(p, envChecks.get(p.dir.toLowerCase())) : null,
    );
  }

  async function leaveNote(p) {
    const note = prompt(`A note on ${p.name} for next time: what you were doing, the next step. Leave it empty to remove the note.`, p.session?.note ?? "");
    if (note === null) return;
    try {
      await api("/api/note", { method: "POST", body: { dir: p.dir, note } });
      toast(note.trim() ? `Noted on ${p.name}. dx go and dx resume show it.` : `Removed the note on ${p.name}.`);
      load();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function runTestsOf(p) {
    const key = p.dir.toLowerCase();
    testRuns.set(key, { running: true });
    renderList();
    try {
      testRuns.set(key, await api("/api/tests", { method: "POST", body: { dir: p.dir } }));
    } catch (err) {
      testRuns.delete(key);
      toast(err.message, "error");
    }
    renderList();
  }

  /** A test run under a project's row: each failure with where it is and expected against actual. */
  function testPanel(p, r) {
    const close = btn("Close", () => (testRuns.delete(p.dir.toLowerCase()), renderList()), { iconName: "x", small: true, kind: "ghost", name: "Close the test results" });
    if (r.running) return h("div", { class: "project-panel" }, h("div", { class: "page-check-head" }, h("p", { class: "dev-errors-empty", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), `Running ${p.name}'s tests…`)));
    const summary = `${r.passed} passed, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ""} in ${(r.ms / 1000).toFixed(1)}s (${r.framework})`;
    const items = r.failures.map((f) => {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null;
      return h(
        "li",
        { class: "dev-error" },
        h("div", { class: "dev-error-head" }, h("span", { class: "badge badge-danger" }, "Failed"), h("strong", { class: "dev-error-message" }, f.name)),
        where ? btn(where, (ev) => busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir: p.dir, file: f.file, line: f.line } })).message)), { small: true, kind: "ghost", iconName: "code" }) : null,
        h("pre", { class: "log-snippet" }, [f.message, f.expected !== undefined || f.actual !== undefined ? `expected: ${f.expected ?? "?"}\nactual:   ${f.actual ?? "?"}` : null].filter(Boolean).join("\n\n")),
      );
    });
    return h(
      "div",
      { class: "project-panel", "aria-live": "polite" },
      h("div", { class: "page-check-head" }, h("p", { class: "dev-errors-empty" }, icon(r.ok ? "check" : "warn"), r.error && !r.failures.length ? `${summary}. ${r.error}` : summary), close),
      items.length ? h("ul", { class: "dev-error-list" }, items) : null,
      !r.ok && !items.length && r.outputTail.length ? h("pre", { class: "log-snippet" }, r.outputTail.slice(-20).join("\n")) : null,
    );
  }

  async function checkEnvOf(p) {
    try {
      envChecks.set(p.dir.toLowerCase(), await api(`/api/env?dir=${encodeURIComponent(p.dir)}`));
      renderList();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /** The .env check under a project's row: what to fill in, what not to commit. */
  function envPanel(p, r) {
    const base = (f) => f.split(/[\\/]/).pop();
    const items = [];
    const add = (kind, label, text) => items.push(h("li", null, h("span", { class: `badge badge-${kind}` }, label), h("span", null, text)));
    if (r.exampleFile && !r.envFiles.length) add("warn", "No .env", `Copy ${base(r.exampleFile)} to .env and fill it in.`);
    if (r.missing.length) add("warn", "Missing", r.missing.join(", "));
    if (r.empty.length) add("warn", "Empty", r.empty.join(", "));
    for (const f of r.tracked) add("danger", "Committed", `${f}: its values are in the repository. Remove it from git and change those secrets.`);
    for (const f of r.notIgnored) add("warn", "Not ignored", `${f} isn't in .gitignore, so git add . would commit it.`);
    for (const s of r.secrets) add("danger", s.kind, `${s.file}:${s.line} (${s.preview}). Move it to .env and revoke it.`);
    const summary = items.length
      ? `${plural(items.length, "thing")} to look at in ${p.name}'s settings`
      : !r.exampleFile && !r.envFiles.length
        ? `${p.name} has no .env files${r.scanned ? ", and no keys or tokens in tracked files" : ""}.`
        : `${r.exampleFile ? `Every variable in ${base(r.exampleFile)} has a value` : "No .env.example to compare with"}${r.scanned ? "; no keys or tokens in tracked files" : ""}.`;
    return h(
      "div",
      { class: "project-panel", "aria-live": "polite" },
      h(
        "div",
        { class: "page-check-head" },
        h("p", { class: "dev-errors-empty" }, icon(items.length ? "warn" : "check"), summary),
        btn("Close", () => (envChecks.delete(p.dir.toLowerCase()), renderList()), { iconName: "x", small: true, kind: "ghost", name: "Close the .env check" }),
      ),
      items.length ? h("ul", { class: "env-list" }, items) : null,
    );
  }

  function moreMenu(p) {
    const details = h("details", { class: "menu" });
    const close = () => details.removeAttribute("open");
    const item = (label, iconName, fn, disabled = false) =>
      h("button", { type: "button", disabled, onclick: async () => (close(), fn()) }, icon(iconName), label);
    append(
      details,
      h("summary", { class: "btn btn-sm", "aria-label": `More actions for ${p.name}` }, icon("more"), "More"),
      h(
        "div",
        { class: "menu-list" },
        item("Open in browser", "external", () => open(null, p, "browser", p.dev?.localUrl ?? p.dev?.url ?? p.url), !(p.dev?.localUrl ?? p.dev?.url ?? p.url)),
        item("Run in a terminal window", "terminal", () => open(null, p, "terminal"), !p.devCommand),
        item("Show in folder", "folder", () => open(null, p, "folder")),
        item(p.session?.note ? "Change the note…" : "Leave a note…", "journal", () => leaveNote(p)),
        item("Run tests", "check", () => runTestsOf(p)),
        item("Check .env and secrets", "deps", () => checkEnvOf(p)),
        item("Save as template…", "template", () => saveTemplate(p)),
      ),
    );
    return details;
  }

  async function open(button, p, action, url) {
    const run = async () => toast((await api("/api/projects/open", { method: "POST", body: { dir: p.dir, action, url } })).message);
    if (button) await busy(button, "Opening…", run);
    else await run().catch((err) => toast(err.message, "error"));
  }

  async function saveTemplate(p) {
    const name = prompt(`Template name for ${p.name} (lowercase, e.g. vite-app):`, p.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"));
    if (!name) return;
    try {
      const r = await api("/api/templates/save", { method: "POST", body: { dir: p.dir, name } });
      toast(`Saved template ${r.name} (${plural(r.files, "file")}). Use it on the New project page.`);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function startDev(button, dir) {
    await busy(button, "Starting…", async () => {
      await api("/api/dev/start", { method: "POST", body: { dir } });
      openLogs.add(dir.toLowerCase());
      setPref("openLogs", JSON.stringify([...openLogs]));
      await load();
      void updateRunningCount();
    });
  }

  async function stopDev(button, dir) {
    await busy(button, "Stopping…", async () => {
      await api("/api/dev/stop", { method: "POST", body: { dir } });
      await new Promise((r) => setTimeout(r, 600));
      await load();
      void updateRunningCount();
    });
  }

  function statusBadge(status) {
    const map = {
      starting: ["badge-warn", "Starting", true],
      ready: ["badge-ok", "Running", false],
      stopped: ["", "Stopped", false],
      failed: ["badge-danger", "Failed", false],
    };
    const [cls, text, pulse] = map[status] ?? ["", status, false];
    return h("span", { class: `badge ${cls}` }, h("span", { class: `dot ${pulse ? "dot-pulse" : ""}` }), text);
  }

  function renderDev() {
    const servers = projects.filter((p) => p.dev).map((p) => p.dev);
    devSection.hidden = servers.length === 0;
    if (!servers.length) return;
    devSection.replaceChildren(
      h("h2", { class: "section-title", id: "dev-title" }, "Dev servers"),
      h("div", { class: "dev-list" }, servers.map(devCard)),
    );
  }

  function devCard(s) {
    const key = s.dir.toLowerCase();
    const live = s.status === "starting" || s.status === "ready";
    const logEl = h("pre", { class: "log", tabindex: "0", "aria-label": `Output of ${s.project}` });
    const showing = openLogs.has(key);
    const showingErrors = openErrors.has(key);
    const errorsEl = h("div", { class: "dev-errors", "aria-live": "polite", "aria-label": `Errors in ${s.project}` });
    const toggle = (set, prefKey) => {
      if (set.has(key)) set.delete(key);
      else set.add(key);
      setPref(prefKey, JSON.stringify([...set]));
      renderDev();
    };
    const card = h(
      "article",
      { class: "card dev" },
      h(
        "div",
        { class: "dev-head" },
        h(
          "div",
          { class: "dev-title" },
          h("strong", null, s.project),
          statusBadge(s.status),
          s.startedBy === "ai" ? h("span", { class: "badge badge-accent", title: "Started by an AI agent through dx's MCP tools" }, "Started by AI") : null,
          s.errorCount ? h("span", { class: "badge badge-danger" }, plural(s.errorCount, "error")) : null,
          addressLink(s) ?? h("span", { class: "dim mono" }, s.command),
        ),
        h(
          "div",
          { class: "toolbar" },
          (s.localUrl ?? s.url) && s.status === "ready"
            ? btn("Open in browser", (e) => open(e.currentTarget, { dir: s.dir }, "browser", s.localUrl ?? s.url), { iconName: "external", small: true, kind: "primary" })
            : null,
          (s.localUrl ?? s.url) && s.status === "ready"
            ? btn("Check page", (e) => checkInBrowser(e.currentTarget, s), {
                iconName: "check",
                small: true,
                title: "Load the page in a headless browser and list console errors, exceptions and failed requests",
              })
            : null,
          s.localUrl
            ? btn(openTraffic.has(key) ? "Hide requests" : "Requests", () => toggle(openTraffic, "openTraffic"), { iconName: "ports", small: true, title: `Requests made through ${s.localUrl}` })
            : null,
          s.errorCount || showingErrors
            ? btn(showingErrors ? "Hide errors" : "Show errors", () => toggle(openErrors, "openErrors"), { iconName: "warn", small: true })
            : null,
          btn(showing ? "Hide output" : "Show output", () => toggle(openLogs, "openLogs"), { iconName: "log", small: true }),
          live
            ? btn("Stop", (e) => stopDev(e.currentTarget, s.dir), { iconName: "stop", small: true })
            : [
                btn("Run again", (e) => startDev(e.currentTarget, s.dir), { iconName: "play", small: true }),
                btn("Dismiss", async () => {
                  await api("/api/dev/clear", { method: "POST", body: { dir: s.dir } }).catch(() => null);
                  logState.delete(key);
                  load();
                }, { iconName: "x", small: true, kind: "ghost" }),
              ],
        ),
      ),
      s.services ? h("ul", { class: "stack-services", "aria-label": `Services of ${s.project}` }, s.services.map(serviceRow)) : null,
      s.note ? h("p", { class: "stack-note" }, icon("warn"), s.note) : null,
      pageChecks.has(key) ? pagePanel(key, pageChecks.get(key)) : null,
      openTraffic.has(key) && s.localUrl ? trafficPanel(key, s) : null,
      showingErrors ? errorsEl : null,
      showing && s.services ? outputFilter(key, s.services) : null,
      showing ? logEl : null,
    );
    if (showing) {
      const state = logState.get(key) ?? { after: 0, lines: [] };
      logState.set(key, state);
      state.el = logEl;
      state.stack = !!s.services;
      renderLines(state, state.lines, true);
    }
    if (showingErrors) {
      errorPanels.set(key, { el: errorsEl, dir: s.dir });
      void refreshErrors(key);
    }
    return card;
  }

  function trafficPanel(key, s) {
    const el = h("div", { class: "dev-errors", "aria-label": `Requests to ${s.project}` });
    trafficPanels.set(key, { el, dir: s.dir });
    void refreshTraffic(key);
    return el;
  }

  async function refreshTraffic(key) {
    const panel = trafficPanels.get(key);
    if (!panel) return;
    let list;
    try {
      list = await api(`/api/traffic?dir=${encodeURIComponent(panel.dir)}&limit=40`);
    } catch {
      return;
    }
    // The card may have been redrawn meanwhile; the new one has its own panel.
    if (!panel.el.isConnected) return;
    const sig = list.map((e) => `${e.id}:${e.status}`).join(",");
    if (panel.sig === sig) return;
    panel.sig = sig;
    panel.el.replaceChildren(
      list.length
        ? h("ul", { class: "traffic-list" }, [...list].reverse().map(trafficRow))
        : h("p", { class: "dev-errors-empty" }, icon("info"), "No API requests yet. They're recorded when the app is opened at its .localhost address."),
    );
  }

  function trafficRow(e) {
    const bad = e.error || (e.status ?? 0) >= 400;
    const status = h("span", { class: `badge ${bad ? "badge-danger" : "badge-ok"}` }, e.error ? "failed" : String(e.status ?? "…"));
    const head = [h("span", { class: "mono traffic-method" }, e.method), status, e.service ? h("span", { class: "badge" }, e.service) : null, h("span", { class: "mono traffic-path" }, e.path), e.ms !== undefined ? h("span", { class: "dim" }, `${e.ms} ms`) : null];
    if (!e.requestBody && !e.responseBody) return h("li", { class: "traffic-row" }, head);
    // The same request view as the Activity page, drawn when the row is opened.
    const body = h("div", { class: "traffic-detail" });
    return h(
      "li",
      null,
      h(
        "details",
        { ontoggle: (ev) => ev.target.open && !body.firstChild && body.append(requestDetail({ ...e, url: e.path })) },
        h("summary", { class: "traffic-row" }, head),
        body,
      ),
    );
  }

  async function checkInBrowser(button, s) {
    const r = await busy(button, "Checking…", () => api("/api/check", { method: "POST", body: { dir: s.dir, browser: true } }));
    if (!r) return;
    pageChecks.set(s.dir.toLowerCase(), r);
    renderDev();
  }

  /** What the headless browser saw: the problems first, or that there were none. */
  function pagePanel(key, r) {
    const p = r.page;
    const items = [];
    const add = (label, kind, text, where) =>
      items.push(h("li", { class: "dev-error" }, h("div", { class: "dev-error-head" }, h("span", { class: `badge badge-${kind}` }, label), h("strong", { class: "dev-error-message" }, text)), where ? h("span", { class: "dim mono" }, where) : null));
    if (p.error) add("Didn't load", "danger", p.error);
    if (p.overlay) add("Error overlay", "danger", p.overlay);
    for (const m of p.exceptions) add("Exception", "danger", m.text, m.source);
    for (const m of p.consoleErrors) add("Console error", "danger", m.text, m.source);
    for (const f of p.failedRequests) add(f.status ? `HTTP ${f.status}` : "Request failed", "danger", `${f.method ?? "GET"} ${f.url}`, f.error);
    for (const m of p.consoleWarnings.slice(0, 5)) add("Warning", "warn", m.text, m.source);
    const summary = p.ok
      ? `No browser errors on ${r.url} (${p.browser}, ${p.ms} ms).`
      : `${plural(items.length, "problem")} on ${r.url} in ${p.browser}.`;
    return h(
      "div",
      { class: "dev-errors", "aria-live": "polite", "aria-label": "What the browser saw" },
      h(
        "div",
        { class: "page-check-head" },
        h("p", { class: "dev-errors-empty" }, icon(p.ok ? "check" : "warn"), summary),
        btn("Close", () => {
          pageChecks.delete(key);
          renderDev();
        }, { iconName: "x", small: true, kind: "ghost", name: "Close the page check" }),
      ),
      items.length ? h("ul", { class: "dev-error-list" }, items) : null,
    );
  }

  /** The address to show: the local domain when there is one, the dev server's own otherwise. */
  function addressLink(s) {
    const href = s.localUrl ?? s.url;
    if (!href) return null;
    return h("a", { href, target: "_blank", rel: "noreferrer", class: "mono", title: s.localUrl && s.url ? `Also at ${s.url}` : undefined }, href.replace(/^http:\/\//, ""));
  }

  function serviceRow(svc) {
    return h(
      "li",
      null,
      statusBadge(svc.status),
      h("strong", null, svc.service),
      svc.role && svc.role !== "other" ? h("span", { class: "dim" }, ROLE_LABELS[svc.role] ?? svc.role) : null,
      svc.errorCount ? h("span", { class: "badge badge-danger" }, plural(svc.errorCount, "error")) : null,
      addressLink(svc) ?? h("span", { class: "dim mono stack-cmd" }, svc.command),
    );
  }

  /** All | api | web: which service's output the log shows. */
  function outputFilter(key, services) {
    const state = logState.get(key) ?? { after: 0, lines: [] };
    logState.set(key, state);
    const options = [["", "All"], ...services.map((svc) => [svc.service, svc.service])];
    return h(
      "div",
      { class: "log-filter" },
      segmented("Show output from", options, state.filter ?? "", (v) => {
        state.filter = v || undefined;
        renderLines(state, state.lines, true);
      }),
    );
  }

  async function refreshErrors(key) {
    const panel = errorPanels.get(key);
    if (!panel?.el.isConnected) return;
    let result;
    try {
      [result] = await api(`/api/dev/errors?dir=${encodeURIComponent(panel.dir)}`);
    } catch {
      return;
    }
    const errors = result?.errors ?? [];
    const sig = errors.map((e) => `${e.id}:${e.count}`).join(",");
    if (panel.sig === sig) return;
    panel.sig = sig;
    panel.el.replaceChildren(
      errors.length
        ? h("ul", { class: "dev-error-list" }, errors.map((e) => errorItem(e, panel.dir)))
        : h("p", { class: "dev-errors-empty" }, icon("info"), "No errors. They clear when the dev server rebuilds cleanly."),
    );
  }

  function errorItem(e, dir) {
    const where = e.file ? `${inProject(e.file, dir)}${e.line ? `:${e.line}` : ""}${e.column ? `:${e.column}` : ""}` : null;
    const detail = e.lines.slice(1, 8).join("\n");
    return h(
      "li",
      { class: "dev-error" },
      h(
        "div",
        { class: "dev-error-head" },
        h("span", { class: "badge badge-danger" }, KIND_LABELS[e.kind] ?? "Error"),
        e.service ? h("span", { class: "badge" }, e.service) : null,
        h("strong", { class: "dev-error-message" }, e.message),
        e.count > 1 ? h("span", { class: "dim" }, `×${e.count}`) : null,
      ),
      where
        ? btn(where, (ev) =>
            busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir, file: e.file, line: e.line, column: e.column } })).message)),
            { small: true, kind: "ghost", iconName: "code", title: "Open in your editor at this line", name: `Open ${where} in editor` },
          )
        : null,
      detail ? h("pre", { class: "log log-snippet" }, detail) : null,
    );
  }

  function renderLines(state, lines, replace) {
    const el = state.el;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (replace) el.replaceChildren();
    for (const l of lines) {
      if (state.filter && l.service !== state.filter) continue;
      el.append(
        h(
          "span",
          { class: l.stream === "err" ? "err" : l.stream === "dx" ? "dx" : "" },
          state.stack && l.service && !state.filter ? h("span", { class: "svc" }, `${l.service} │ `) : null,
          l.text + "\n",
        ),
      );
    }
    if (!el.childNodes.length) el.append(h("span", { class: "empty" }, "No output yet."));
    if (replace || nearBottom) el.scrollTop = el.scrollHeight;
  }

  async function pollLogs() {
    if (stopped) return;
    let changed = false;
    for (const [key, state] of logState) {
      if (!openLogs.has(key) || !state.el?.isConnected) continue;
      const p = projects.find((x) => x.dir.toLowerCase() === key);
      if (!p) continue;
      try {
        const { lines, server } = await api(`/api/dev/logs?dir=${encodeURIComponent(p.dir)}&after=${state.after}`);
        if (lines.length) {
          if (state.el.querySelector(".empty")) state.el.replaceChildren();
          state.lines.push(...lines);
          if (state.lines.length > 2000) state.lines.splice(0, state.lines.length - 2000);
          state.after = lines[lines.length - 1].n;
          renderLines(state, lines, false);
        }
        if (server && (server.status !== p.dev?.status || server.errorCount !== p.dev?.errorCount)) changed = true;
      } catch {
        // dashboard stopped; the next load shows the error
      }
    }
    for (const key of errorPanels.keys()) {
      if (openErrors.has(key)) await refreshErrors(key);
      else errorPanels.delete(key);
    }
    if (changed) await load();
    if (!stopped) timer = setTimeout(pollLogs, 1000);
  }

  const abort = new AbortController();
  // One listener closes any open ⋯ menu when you click elsewhere or press Escape.
  document.addEventListener("click", (e) => {
    for (const m of root.querySelectorAll("details.menu[open]")) if (!m.contains(e.target)) m.removeAttribute("open");
  }, { signal: abort.signal });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const m of root.querySelectorAll("details.menu[open]")) m.removeAttribute("open");
  }, { signal: abort.signal });
  let timer = setTimeout(pollLogs, 1000);
  // Also picks up dev servers an AI agent starts while the page is open.
  const statusTimer = setInterval(async () => {
    const servers = await api("/api/dev").catch(() => null);
    const differs = (s) => {
      const dev = projects.find((p) => p.dir === s.dir)?.dev;
      return dev?.status !== s.status || dev?.errorCount !== s.errorCount;
    };
    if (servers && (servers.some(differs) || servers.length !== projects.filter((p) => p.dev).length)) load();
    for (const key of trafficPanels.keys()) void refreshTraffic(key);
  }, 3000);
  load();
  loadUnsaved();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(statusTimer);
    abort.abort();
  };
}

// ------------------------------------------------------------------ New project

function newProjectPage(root) {
  const holder = h("div", null, loadingView("Loading templates and projects…"));
  append(root, pageHead("New project", "Start from one of your templates or a copy of an existing project."), holder);

  async function load() {
    let data;
    try {
      data = await api("/api/templates");
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
      return;
    }
    const source = h(
      "select",
      { id: "new-source", required: true },
      h("option", { value: "" }, "Choose…"),
      data.templates.length ? h("optgroup", { label: "Your templates" }, data.templates.map((t) => h("option", { value: `template:${t}` }, t))) : null,
      h("optgroup", { label: "Copy a project" }, data.projects.map((p) => h("option", { value: `project:${p.dir}` }, p.name))),
    );
    const name = h("input", { class: "input", id: "new-name", required: true, placeholder: "my-app", pattern: "[a-z0-9][a-z0-9._\\-]*", autocomplete: "off", spellcheck: "false" });
    const where = h("select", { id: "new-in" }, data.roots.map((r) => h("option", { value: r }, tildify(r))));
    const git = h("input", { type: "checkbox", checked: true });
    const install = h("input", { type: "checkbox", checked: true });
    const openEditor = h("input", { type: "checkbox", checked: true });
    const submit = btn("Create project", null, { kind: "primary", type: "submit", iconName: "new" });
    const result = h("div", { "aria-live": "polite" });

    const form = h(
      "form",
      {
        class: "card card-pad section",
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (!source.value) return toast("Choose what to start from.", "error"), source.focus();
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(name.value)) return toast("Use lowercase letters, digits, - _ or . for the name, e.g. my-app.", "error"), name.focus();
          const r = await busy(submit, install.checked ? "Creating and installing…" : "Creating…", () =>
            api("/api/new", { method: "POST", body: { source: source.value, name: name.value, in: where.value, git: git.checked, install: install.checked, open: openEditor.checked } }),
          );
          if (!r) return;
          toast(`Created ${r.name}`);
          result.replaceChildren(
            h(
              "div",
              { class: "note" },
              icon("info"),
              h(
                "div",
                { class: "section" },
                h("p", null, h("strong", null, r.name), " is ready in ", h("span", { class: "mono" }, tildify(r.dir))),
                h("ul", { class: "bullets" }, r.steps.map((s) => h("li", null, s))),
                h(
                  "div",
                  { class: "toolbar" },
                  btn("Run its dev server", async (e) => {
                    await busy(e.currentTarget, "Starting…", async () => {
                      await api("/api/dev/start", { method: "POST", body: { dir: r.dir } });
                      location.hash = "#/projects";
                    });
                  }, { kind: "primary", iconName: "play", small: true }),
                  h("a", { class: "btn btn-sm", href: "#/projects" }, "Go to projects"),
                ),
              ),
            ),
          );
          form.reset();
          git.checked = install.checked = openEditor.checked = true;
        },
      },
      h(
        "div",
        { class: "form-grid" },
        h("label", { class: "field", for: "new-source" }, h("span", { class: "field-label" }, "Start from"), source, h("span", { class: "field-hint" }, "A project is copied without its .git, node_modules, build output and .env files.")),
        h("label", { class: "field", for: "new-name" }, h("span", { class: "field-label" }, "Name"), name, h("span", { class: "field-hint" }, "Lowercase letters, digits, - _ or .")),
        h("label", { class: "field", for: "new-in" }, h("span", { class: "field-label" }, "Create it in"), where),
      ),
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "check" }, git, "Create a git repository"),
        h("label", { class: "check" }, install, "Install packages"),
        h("label", { class: "check" }, openEditor, "Open in editor"),
      ),
      h("div", { class: "form-actions" }, submit),
    );

    holder.replaceChildren(
      h("div", { class: "section" }, form, result),
      cloneSection(),
      h(
        "section",
        { class: "section", "aria-labelledby": "tpl-title" },
        h("h2", { class: "section-title", id: "tpl-title" }, "Your templates"),
        data.templates.length
          ? h("div", { class: "chips" }, data.templates.map((t) => h("span", { class: "chip" }, t)))
          : h("p", { class: "dim" }, "No templates yet. On the Projects page, open a project's ⋯ menu and choose Save as template."),
      ),
    );
  }
  /** Clone a repository and get it ready: packages installed, .env made from .env.example. */
  function cloneSection() {
    const url = h("input", { class: "input", id: "clone-url", required: true, placeholder: "https://github.com/octocat/todo-app or octocat/todo-app", autocomplete: "off", spellcheck: "false" });
    const name = h("input", { class: "input", id: "clone-name", placeholder: "the repository's name", pattern: "[a-z0-9A-Z][a-zA-Z0-9._\\-]*", autocomplete: "off", spellcheck: "false" });
    const install = h("input", { type: "checkbox", checked: true });
    const submit = btn("Clone and set up", null, { kind: "primary", type: "submit", iconName: "play" });
    const result = h("div", { "aria-live": "polite" });
    const form = h(
      "form",
      {
        class: "card card-pad section",
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (!url.value.trim()) return toast("Paste the repository's address.", "error"), url.focus();
          const r = await busy(submit, install.checked ? "Cloning and installing…" : "Cloning…", () =>
            api("/api/clone", { method: "POST", body: { url: url.value.trim(), name: name.value.trim() || undefined, install: install.checked } }),
          );
          if (!r) return;
          toast(r.ok ? `${r.name} is ready` : `${r.name} is cloned; a step needs you`, r.ok ? "ok" : "error");
          result.replaceChildren(
            h(
              "div",
              { class: r.ok ? "note" : "note note-warn" },
              icon(r.ok ? "info" : "warn"),
              h(
                "div",
                { class: "section" },
                h("p", null, h("strong", null, r.name), " is in ", h("span", { class: "mono" }, tildify(r.dir)), r.runs ? ` and runs ${r.runs}.` : "."),
                h(
                  "ul",
                  { class: "bullets" },
                  r.steps.map((s) => h("li", null, s.ok ? "" : h("strong", null, "Needs you: "), `${s.name}: ${s.detail ?? ""}`, s.fix ? h("span", { class: "dim" }, ` (${s.fix})`) : null)),
                ),
                h(
                  "div",
                  { class: "toolbar" },
                  r.project
                    ? btn("Run it", async (ev) => {
                        await busy(ev.currentTarget, "Starting…", async () => {
                          await api("/api/dev/start", { method: "POST", body: { dir: r.dir } });
                          location.hash = "#/projects";
                        });
                      }, { kind: "primary", iconName: "play", small: true })
                    : null,
                  h("a", { class: "btn btn-sm", href: "#/projects" }, "Go to projects"),
                ),
              ),
            ),
          );
          form.reset();
          install.checked = true;
        },
      },
      h(
        "div",
        { class: "form-grid" },
        h("label", { class: "field", for: "clone-url" }, h("span", { class: "field-label" }, "Repository"), url, h("span", { class: "field-hint" }, "A git address, or owner/repo for GitHub. Private ones need git signed in (gh auth login or an SSH key).")),
        h("label", { class: "field", for: "clone-name" }, h("span", { class: "field-label" }, "Folder name (optional)"), name),
      ),
      h("div", { class: "toolbar" }, h("label", { class: "check" }, install, "Install packages and create .env")),
      h("div", { class: "form-actions" }, submit),
    );
    return h(
      "section",
      { class: "section", "aria-labelledby": "clone-title" },
      h("h2", { class: "section-title", id: "clone-title" }, "Clone a repository"),
      h("p", { class: "dim" }, "Clones it into your first projects folder, installs its packages with the tool it uses, and creates .env from .env.example."),
      form,
      result,
    );
  }
  load();
}

// ------------------------------------------------------------------ Ports

function portsPage(root) {
  let showAll = false;
  const holder = h("div", { class: "card" }, loadingView("Reading listening ports…"));
  append(
    root,
    pageHead(
      "Ports",
      "What's listening on this computer, and what started it.",
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((showAll = e.target.checked), load()) }), "Include system ports"),
      btn("Refresh", () => load(), { iconName: "refresh" }),
    ),
    holder,
  );

  async function load() {
    try {
      const entries = await api(`/api/ports${showAll ? "?all=1" : ""}`);
      if (!entries.length) {
        holder.replaceChildren(stateView("Nothing is listening", showAll ? "No listening ports." : "No program is listening on ports 1024 and up."));
        return;
      }
      holder.replaceChildren(
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", null, h("tr", null, h("th", { scope: "col" }, "Port"), h("th", { scope: "col" }, "Process"), h("th", { scope: "col", class: "num" }, "PID"), h("th", { scope: "col" }, "Command"), h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")))),
            h(
              "tbody",
              null,
              entries.map((e) =>
                h(
                  "tr",
                  null,
                  h("td", null, h("strong", { class: "mono" }, e.port), e.port < 1024 ? h("span", { class: "dim" }, " system") : null),
                  h("td", null, e.processName ?? "unknown"),
                  h("td", { class: "num mono" }, e.pid),
                  h("td", { class: "cmd", title: e.commandLine ?? "" }, e.commandLine ?? "—"),
                  h("td", { class: "actions" }, e.system ? h("span", { class: "dim" }, "System") : btn("Stop", (ev) => kill(ev.currentTarget, e), { kind: "danger-ghost", small: true, iconName: "stop" })),
                ),
              ),
            ),
          ),
        ),
      );
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
    }
  }

  async function kill(button, e) {
    const ok = await confirmDialog({
      title: `Stop ${e.processName ?? "the process"} on port ${e.port}?`,
      text: [`PID ${e.pid} and its child processes will be stopped.`, e.commandLine ? h("p", { class: "mono" }, e.commandLine) : null].filter(Boolean),
      confirm: "Stop it",
    });
    if (!ok) return;
    await busy(button, "Stopping…", async () => {
      const r = await api("/api/ports/kill", { method: "POST", body: { port: e.port } });
      toast(r.message);
      await load();
    });
  }
  load();
}

// ------------------------------------------------------------------ Journal

function journalPage(root) {
  let days = Number(pref("journalDays", "7"));
  const holder = h("div", { class: "card" }, loadingView("Reading your journal…"));
  const input = h("input", { class: "input input-wide", id: "journal-text", placeholder: "What did you do? e.g. fixed the seat map overflow", autocomplete: "off", maxlength: "500" });
  const add = btn("Add", null, { kind: "primary", type: "submit" });
  const form = h(
    "form",
    {
      class: "card card-pad toolbar",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return input.focus();
        const r = await busy(add, "Adding…", () => api("/api/journal", { method: "POST", body: { text: input.value } }));
        if (!r) return;
        input.value = "";
        toast(`Logged at ${r.time}`);
        load();
        input.focus();
      },
    },
    h("label", { class: "visually-hidden", for: "journal-text" }, "Journal entry"),
    input,
    add,
  );
  append(
    root,
    pageHead(
      "Journal",
      "One line per thing you did. It feeds your weekly summary.",
      segmented("Show", [[7, "7 days"], [30, "30 days"], [90, "90 days"]], days, (v) => ((days = v), setPref("journalDays", v), load())),
    ),
    form,
    holder,
  );

  async function load() {
    try {
      const entries = await api(`/api/journal?days=${days}`);
      if (!entries.length) {
        holder.replaceChildren(stateView(`Nothing logged in the last ${days} days`, "Add what you did above, one line at a time."));
        return;
      }
      const byDay = new Map();
      for (const e of entries) (byDay.get(e.date) ?? byDay.set(e.date, []).get(e.date)).push(e);
      holder.replaceChildren(
        ...[...byDay.entries()].reverse().map(([date, list]) =>
          h("section", { class: "day" }, h("h2", { class: "day-title" }, dayLabel(date)), h("ul", { class: "entries" }, [...list].reverse().map((e) => h("li", null, h("span", { class: "time" }, e.time), h("span", null, e.text))))),
        ),
      );
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
    }
  }
  load();
  setTimeout(() => input.focus(), 0);
}

// ------------------------------------------------------------------ Env

function envPage(root) {
  let list = [];
  let query = "";
  let show = pref("envShow", "problems");
  const open = new Set(); // project dirs opened
  const deep = new Map(); // dir -> full audit with the key scan
  const holder = h("div", { class: "section" }, h("div", { class: "card" }, loadingView("Looking for .env files in your projects…")));
  const summary = h("div");
  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search projects",
    "aria-label": "Search projects",
    oninput: (e) => ((query = e.target.value.trim().toLowerCase()), render()),
  });
  append(
    root,
    pageHead(
      "Env & secrets",
      "Every project's .env files, and whether git could leak them. Keys, certificates and .env files never belong in git (OWASP).",
      search,
      segmented("Show", [["problems", "Needs attention"], ["all", "All projects"]], show, (v) => ((show = v), setPref("envShow", v), render())),
      btn("Check again", () => load(), { iconName: "refresh", kind: "ghost" }),
    ),
    summary,
    holder,
  );

  async function load() {
    try {
      list = await api("/api/env/all");
      deep.clear();
      render();
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
    }
  }

  async function reloadProject(dir) {
    const fresh = await api(`/api/env/project?dir=${encodeURIComponent(dir)}`);
    deep.set(dir, fresh);
    list = list.map((p) => (p.dir === dir ? fresh : p));
    render();
  }

  function render() {
    const withProblems = list.filter((p) => p.problems > 0);
    const files = list.reduce((n, p) => n + p.files.filter((f) => !f.example).length, 0);
    summary.replaceChildren(
      withProblems.length
        ? h("div", { class: "note note-warn", role: "status" }, icon("warn"), h("p", null, `${plural(withProblems.length, "project")} of ${list.length} could leak secrets or are missing .gitignore rules. ${plural(files, ".env file")} in all.`))
        : h("div", { class: "note", role: "status" }, icon("check"), h("p", null, `No problems in ${plural(list.length, "project")}: every .env file is kept out of git. ${plural(files, ".env file")} in all.`)),
    );
    const shown = list.filter((p) => (show === "all" || p.problems > 0 || open.has(p.dir)) && (!query || p.name.toLowerCase().includes(query)));
    if (!shown.length) {
      holder.replaceChildren(h("div", { class: "card" }, stateView(query ? "No project matches" : "Nothing needs attention", query ? "Try another name." : "Pick All projects to see every project's .env files.")));
      return;
    }
    holder.replaceChildren(...shown.map((p) => projectCard(deep.get(p.dir) ?? p)));
  }

  function projectCard(p) {
    const isOpen = open.has(p.dir) || (p.problems > 0 && show === "problems" && !open.size);
    const badge = p.problems ? h("span", { class: "badge badge-danger" }, `${p.problems} to fix`) : h("span", { class: "badge badge-ok" }, "ok");
    const body = h("div", { class: "env-body" });
    const details = h(
      "details",
      {
        class: "card env-project",
        open: isOpen || undefined,
        ontoggle: (e) => {
          if (e.target.open) {
            open.add(p.dir);
            fill();
          } else open.delete(p.dir);
        },
      },
      h(
        "summary",
        { class: "env-head" },
        h("strong", null, p.name),
        badge,
        h("span", { class: "dim" }, p.files.length ? plural(p.files.filter((f) => !f.example).length, ".env file") : "no .env files"),
        !p.gitignore ? h("span", { class: "badge badge-danger" }, "no .gitignore") : null,
        !p.git ? h("span", { class: "badge" }, "not a git repository") : null,
      ),
      body,
    );
    const fill = () => body.replaceChildren(...projectBody(p));
    if (isOpen) fill();
    return details;
  }

  function projectBody(p) {
    const out = [];
    // The files, with what git would do with each.
    const real = p.files.filter((f) => !f.example);
    const examples = p.files.filter((f) => f.example);
    const rows = [...real, ...examples].map((f) => fileRow(p, f));
    out.push(
      h(
        "section",
        { class: "env-section" },
        h("h3", { class: "env-title" }, "Files"),
        rows.length ? h("ul", { class: "env-files" }, rows) : h("p", { class: "dim" }, "No .env files in this project."),
        !real.some((f) => f.name === ".env") && examples.length
          ? h(
              "p",
              null,
              btn("Create .env from the example", async (ev) => {
                const r = await busy(ev.currentTarget, "Creating…", () => api("/api/env/create", { method: "POST", body: { dir: p.dir } }));
                if (r) (toast(`Created ${r.name}; fill in its values`), reloadProject(p.dir));
              }, { small: true, iconName: "new" }),
            )
          : null,
      ),
    );

    if (real.some((f) => f.tracked)) {
      out.push(
        h(
          "div",
          { class: "note note-danger" },
          icon("warn"),
          h(
            "div",
            null,
            h("p", null, `${real.filter((f) => f.tracked).map((f) => f.name).join(", ")} ${real.filter((f) => f.tracked).length === 1 ? "is" : "are"} committed to git, so the values are in the repository's history.`),
            h("p", null, "Take it out of git with ", h("code", null, `git rm --cached ${real.find((f) => f.tracked).name}`), ", add it to .gitignore, and change the keys it held: anyone with the repository has the old ones."),
          ),
        ),
      );
    }

    // .gitignore: what it's missing, and a button that adds it.
    const missing = p.rules.filter((r) => !r.covered);
    const gi = [h("h3", { class: "env-title" }, ".gitignore")];
    if (!p.gitignore) gi.push(h("div", { class: "note note-danger" }, icon("warn"), h("p", null, "This project has no .gitignore: a git add . would commit everything, .env files and keys included.")));
    if (p.exampleIgnored) gi.push(h("div", { class: "note note-warn" }, icon("warn"), h("p", null, ".env.example is ignored too, so the list of variables isn't shared with the code. dx adds !.env.example to keep it.")));
    if (missing.length) {
      gi.push(
        h("p", null, `Missing ${plural(missing.length, "rule")} for keeping secrets out of git:`),
        h("ul", { class: "env-rules" }, missing.map((r) => h("li", null, h("code", null, r.pattern), h("span", { class: "dim" }, ` ${r.why}`)))),
        h(
          "p",
          null,
          btn(`Add ${plural(missing.length, "rule")} to .gitignore`, async (ev) => {
            // The event's currentTarget is gone once the dialog has been waited for.
            const button = ev.currentTarget;
            const yes = await confirmDialog({
              title: `Add to ${p.name}'s .gitignore?`,
              text: `These lines go at the end of ${p.gitignore ? "its .gitignore" : "a new .gitignore"}: ${missing.map((r) => r.pattern).join(", ")}. Files that match stop showing in git status; nothing is deleted.`,
              confirm: "Add them",
              danger: false,
            });
            if (!yes) return;
            const r = await busy(button, "Adding…", () => api("/api/env/gitignore", { method: "POST", body: { dir: p.dir, patterns: missing.map((m) => m.pattern) } }));
            if (r) (toast(r.added.length ? `.gitignore now has ${r.added.join(", ")}` : ".gitignore already had them"), reloadProject(p.dir));
          }, { small: true, kind: "primary", iconName: "check" }),
        ),
      );
    } else if (p.gitignore) gi.push(h("p", { class: "env-ok" }, icon("check"), "Covers .env files, private keys, certificates and keystores."));
    out.push(h("section", { class: "env-section" }, gi));

    // Variables the example lists that no .env sets.
    if (p.missingVars.length || p.emptyVars.length) {
      out.push(
        h(
          "section",
          { class: "env-section" },
          h("h3", { class: "env-title" }, "Variables"),
          p.missingVars.length ? h("p", null, "In the example but not set: ", p.missingVars.map((k, i) => [i ? ", " : "", h("code", null, k)])) : null,
          p.emptyVars.length ? h("p", { class: "dim" }, "Set but empty: ", p.emptyVars.map((k, i) => [i ? ", " : "", h("code", null, k)])) : null,
        ),
      );
    }

    // Keys and tokens in tracked files: a full scan, on request.
    const keys = h("section", { class: "env-section" }, h("h3", { class: "env-title" }, "Keys in committed files"));
    if (deep.has(p.dir)) {
      if (!p.scanned) keys.append(h("p", { class: "dim" }, "Only git repositories are scanned."));
      else if (!p.secrets.length) keys.append(h("p", { class: "env-ok" }, icon("check"), "No API keys, tokens or private keys in files git tracks."));
      else
        keys.append(
          h(
            "ul",
            { class: "env-rules" },
            p.secrets.map((s) =>
              h(
                "li",
                null,
                h("span", { class: "badge badge-danger" }, s.kind),
                " ",
                btn(`${s.file}:${s.line}`, (ev) => busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir: p.dir, file: s.file, line: s.line } })).message)), { small: true, kind: "ghost", iconName: "code" }),
                h("span", { class: "dim mono" }, ` ${s.preview}`),
              ),
            ),
          ),
          h("p", { class: "dim" }, "Move each into a .env file and change it: it's in the repository's history."),
        );
    } else {
      keys.append(h("p", null, btn("Scan committed files for keys", async (ev) => void (await busy(ev.currentTarget, "Scanning…", () => reloadProject(p.dir))), { small: true, iconName: "deps" })));
    }
    out.push(keys);
    return out;
  }

  function fileRow(p, f) {
    const panel = h("div", { class: "env-panel" });
    const badges = [
      f.example ? h("span", { class: "badge" }, "example") : null,
      f.tracked ? h("span", { class: "badge badge-danger" }, "committed to git") : null,
      f.notIgnored ? (p.git ? h("span", { class: "badge badge-danger" }, "git would commit it") : h("span", { class: "badge badge-warn" }, "not in .gitignore")) : null,
      !f.example && !f.tracked && !f.notIgnored && p.git ? h("span", { class: "badge badge-ok" }, "ignored by git") : null,
    ];
    return h(
      "li",
      null,
      h(
        "div",
        { class: "env-file" },
        h("span", { class: "mono env-name" }, f.name),
        badges,
        h("span", { class: "dim" }, plural(f.keys, "variable")),
        h(
          "span",
          { class: "toolbar env-actions" },
          btn("View", () => view(p, f, panel), { small: true, kind: "ghost", name: `View ${f.name}` }),
          btn("Edit", () => edit(p, f, panel), { small: true, kind: "ghost", name: `Edit ${f.name}` }),
          btn("Open", (ev) => busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir: p.dir, file: f.name } })).message)), { small: true, kind: "ghost", iconName: "code", name: `Open ${f.name} in your editor` }),
        ),
      ),
      panel,
    );
  }

  /** The variables with their values hidden until asked for, one at a time or all. */
  async function view(p, f, panel) {
    if (panel.dataset.mode === "view") return void (panel.replaceChildren(), (panel.dataset.mode = ""));
    let content;
    try {
      content = (await api(`/api/env/file?dir=${encodeURIComponent(p.dir)}&name=${encodeURIComponent(f.name)}`)).content;
    } catch (err) {
      return toast(err.message, "error");
    }
    panel.dataset.mode = "view";
    const rows = [];
    const reveal = [];
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
      if (!m) {
        if (line.trim()) rows.push(h("tr", null, h("td", { colspan: "3", class: "dim mono" }, line)));
        continue;
      }
      const value = h("span", { class: "mono env-value" }, m[3] ? "•••" : "(empty)");
      const toggle = btn("Show", () => {
        const hidden = value.textContent === "•••";
        value.textContent = hidden ? m[3] : "•••";
        toggle.textContent = hidden ? "Hide" : "Show";
      }, { small: true, kind: "ghost", name: `Show ${m[2]}` });
      if (!m[3]) toggle.hidden = true;
      reveal.push(() => {
        if (m[3]) ((value.textContent = m[3]), (toggle.textContent = "Hide"));
      });
      rows.push(h("tr", null, h("th", { scope: "row", class: "mono" }, m[2]), h("td", null, value), h("td", { class: "actions" }, toggle)));
    }
    panel.replaceChildren(
      h(
        "div",
        { class: "env-viewer" },
        h("div", { class: "toolbar" }, btn("Show all values", () => reveal.forEach((r) => r()), { small: true }), btn("Close", () => ((panel.dataset.mode = ""), panel.replaceChildren()), { small: true, kind: "ghost", iconName: "x" })),
        rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "table env-table" }, h("tbody", null, rows))) : h("p", { class: "dim" }, "The file is empty."),
      ),
    );
  }

  /** The whole file as text, saved in one go. */
  async function edit(p, f, panel) {
    let content;
    try {
      content = (await api(`/api/env/file?dir=${encodeURIComponent(p.dir)}&name=${encodeURIComponent(f.name)}`)).content;
    } catch (err) {
      return toast(err.message, "error");
    }
    panel.dataset.mode = "edit";
    const id = `env-edit-${Math.random().toString(36).slice(2, 8)}`;
    const area = h("textarea", { id, class: "input env-editor", spellcheck: "false", autocomplete: "off", rows: String(Math.min(24, Math.max(6, content.split("\n").length + 1))) });
    area.value = content;
    const save = btn("Save", async (ev) => {
      if (area.value === content) return toast("Nothing changed");
      const r = await busy(ev.currentTarget, "Saving…", () => api("/api/env/file", { method: "POST", body: { dir: p.dir, name: f.name, content: area.value } }));
      if (!r) return;
      toast(`Saved ${f.name}. A running dev server may need a restart to read it.`);
      panel.dataset.mode = "";
      panel.replaceChildren();
      reloadProject(p.dir);
    }, { small: true, kind: "primary", iconName: "save" });
    panel.replaceChildren(
      h(
        "div",
        { class: "env-viewer" },
        h("label", { for: id, class: "field-hint" }, `${f.name}: values are shown while you edit. One KEY=value per line; # starts a comment.`),
        area,
        h("div", { class: "toolbar" }, save, btn("Cancel", () => ((panel.dataset.mode = ""), panel.replaceChildren()), { small: true, kind: "ghost" })),
      ),
    );
    area.focus();
  }

  load();
}

// ------------------------------------------------------------------ Git

const SVG_NS = "http://www.w3.org/2000/svg";
const LANE_COLOURS = 6;
const MAX_LANES = 12;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const GIT_CODES = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", N: "New file" };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * One commit's slice of the graph, in a 16 × 32 grid per lane: lines from its children above, to
 * its parents below, and the lanes passing by. The SVG scales with the row's height in CSS.
 */
function graphCell(row, lanes, merge) {
  const w = lanes * 16;
  const svg = svgEl("svg", { class: "graph-cell", viewBox: `0 0 ${w} 32`, width: w, height: 32, "aria-hidden": "true" });
  const x = (lane) => lane * 16 + 8;
  const path = (d, lane) => svg.append(svgEl("path", { d, class: `graph-line lane-${lane % LANE_COLOURS}` }));
  const curve = (x1, y1, x2, y2) => (x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
  for (const l of row.through) if (l < lanes) path(`M${x(l)} 0V32`, l);
  // A branch joining the line on its left: straight down to the dot's height, then across.
  for (const [from, to] of row.moves ?? []) if (from < lanes && to < lanes) path(`M${x(from)} 0V16C${x(from)} 26 ${x(to)} 24 ${x(to)} 32`, from);
  for (const l of row.up) if (l < lanes) path(curve(x(l), 0, x(row.lane), 16), l);
  for (const l of row.down) if (l < lanes) path(curve(x(row.lane), 16, x(l), 32), l);
  if (row.lane < lanes) svg.append(svgEl("circle", { cx: x(row.lane), cy: 16, r: merge ? 4 : 4.5, class: `graph-dot lane-${row.lane % LANE_COLOURS}${merge ? " graph-dot-merge" : ""}` }));
  return svg;
}

/** The lanes that go on past a commit, drawn down the side of its open detail so the graph doesn't break. */
function laneStrip(row, lanes) {
  const w = lanes * 16;
  const svg = svgEl("svg", { class: "graph-strip", viewBox: `0 0 ${w} 32`, width: w, preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const l of new Set([...row.through, ...row.down])) {
    if (l < lanes) svg.append(svgEl("path", { d: `M${l * 16 + 8} 0V32`, class: `graph-line lane-${l % LANE_COLOURS}`, "vector-effect": "non-scaling-stroke" }));
  }
  return svg;
}

function refBadge(ref) {
  const kind = ref.current ? "current" : ref.kind;
  const label = ref.kind === "head" ? "HEAD" : ref.name;
  const title = { current: "The branch you're on", branch: "Branch", remote: "Branch on the remote", tag: "Tag", head: "HEAD is here, on no branch" }[kind];
  return h("span", { class: `graph-ref graph-ref-${kind}`, title }, ref.kind === "tag" ? icon("tag") : ref.current ? icon("git") : null, label);
}

/** FLIP: where each keyed element is now, so after the DOM changes it can slide from there. */
function rememberPlaces(container) {
  const places = new Map();
  for (const el of container.querySelectorAll("[data-key]")) places.set(el.dataset.key, el.getBoundingClientRect());
  return places;
}

/** Slides each keyed element from where it was (or, for a card that changed column, from its other self). */
function slideFromPlaces(container, places) {
  if (reducedMotion.matches || !places.size) return;
  for (const el of container.querySelectorAll("[data-key]")) {
    const [col, ...rest] = el.dataset.key.split(":");
    const was = places.get(el.dataset.key) ?? places.get(`${col === "changes" ? "staged" : "changes"}:${rest.join(":")}`);
    const now = el.getBoundingClientRect();
    if (!was) {
      el.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }
}

/** Commit messages being written, per project, kept while you visit other pages. */
const gitDrafts = new Map();

function gitPage(root) {
  const fromLink = new URLSearchParams(location.hash.split("?")[1] ?? "").get("dir");
  let dir = fromLink || pref("gitDir", "");
  let projects = [];
  let status = null;
  let statusSig = "";
  let graph = null;
  let graphHead;
  let limit = 200;
  let drag = null; // { from: "changes" | "staged", paths, hunk? }
  let working = 0; // actions on their way: polling waits for them
  let selected = new Set(); // "changes:path" / "staged:path"
  let lastClicked = null;
  let openFile = null; // { path, staged }
  let openCommit = null; // hash
  let newCommit = null; // the hash just committed, to animate in
  let historyList = null;
  let stopped = false;
  const drafts = gitDrafts;

  const live = h("p", { class: "visually-hidden", "aria-live": "polite" });
  const say = (text) => (live.textContent = text);
  const projectSelect = h("select", {
    disabled: true,
    onchange: (e) => {
      drafts.set(dir, message.value);
      dir = e.target.value;
      setPref("gitDir", dir);
      load();
    },
  });
  const headInfo = h("div", { class: "card card-pad git-branch", "aria-live": "polite" }, loadingView("Reading the repository…"));
  const filePanel = h("div", { class: "git-file-panel" });
  const history = h("div", { class: "card graph-card" }, loadingView("Reading the history…"));

  const columns = { changes: makeColumn("changes"), staged: makeColumn("staged") };
  const message = h("textarea", {
    class: "input git-message",
    rows: 4,
    placeholder: "What does this commit do?",
    "aria-label": "Commit message",
    oninput: () => updateCommitBox(),
    onkeydown: (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!commitButton.disabled) commitButton.click();
      }
    },
  });
  const commitSummary = h("p", { class: "dim git-commit-summary" });
  const commitButton = btn("Commit", (ev) => commit(ev.currentTarget), { kind: "primary", iconName: "check" });
  const commitBox = h(
    "section",
    { class: "card git-col git-commit", "aria-labelledby": "git-commit-title" },
    h("div", { class: "git-col-head" }, h("h2", { class: "git-col-title", id: "git-commit-title" }, "Commit")),
    message,
    commitSummary,
    h("div", { class: "toolbar" }, commitButton, h("span", { class: "dim git-hint" }, h("kbd", null, "Ctrl"), "+", h("kbd", null, "Enter"))),
  );
  dropZone(commitBox, "staged");
  const board = h("div", { class: "git-board" }, columns.changes.col, columns.staged.col, commitBox);

  append(
    root,
    pageHead(
      "Git",
      "Drag your changes into the next commit, and see every branch's history as a graph.",
      h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Project"), projectSelect),
      btn("Refresh", () => load({ keep: true }), { iconName: "refresh", kind: "ghost" }),
    ),
    headInfo,
    board,
    filePanel,
    h("section", { class: "section", "aria-labelledby": "git-history-title" }, h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "git-history-title" }, "History")), history),
    live,
  );

  /** replaceChildren, skipping null and taking arrays, the way h() does. */
  function put(el, ...children) {
    el.replaceChildren();
    append(el, ...children);
  }

  function makeColumn(kind) {
    const title = kind === "changes" ? "Changes" : "Staged";
    const count = h("span", { class: "badge" }, "0");
    const all = btn(kind === "changes" ? "Stage all" : "Unstage all", () => {
      const keys = [...selected].filter((k) => k.startsWith(`${kind}:`));
      const paths = keys.length ? keys.map((k) => k.slice(kind.length + 1)) : filesIn(kind).map((f) => f.path);
      move(kind, paths);
    }, { small: true, kind: "ghost", iconName: kind === "changes" ? "right" : "left" });
    const list = h("ul", { class: "git-cards", "aria-label": `${title} files` });
    const empty = h("p", { class: "git-empty dim" });
    const col = h(
      "section",
      { class: `card git-col git-col-${kind}`, "aria-labelledby": `git-${kind}-title` },
      h("div", { class: "git-col-head" }, h("h2", { class: "git-col-title", id: `git-${kind}-title` }, title), count, all),
      list,
      empty,
    );
    dropZone(col, kind);
    return { col, list, count, all, empty };
  }

  /** A column (or the commit box) that takes cards and blocks dragged from the other column. */
  function dropZone(el, target) {
    el.addEventListener("dragover", (e) => {
      if (!drag || drag.from === target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      const d = drag;
      drag = null;
      if (!d || d.from === target) return;
      if (d.hunk) moveHunk(d);
      else move(d.from, d.paths);
    });
  }

  const filesIn = (kind) => (status?.files ?? []).filter((f) => (kind === "changes" ? f.unstaged : f.staged));

  function card(f, kind) {
    const key = `${kind}:${f.path}`;
    const code = f.conflicted ? "U" : f.untracked ? "N" : kind === "staged" ? f.index : f.worktree;
    const slash = f.path.lastIndexOf("/");
    const isOpen = openFile?.path === f.path && openFile.staged === (kind === "staged");
    const li = h(
      "li",
      { class: `git-card${selected.has(key) ? " selected" : ""}${isOpen ? " open" : ""}`, draggable: "true", dataset: { key } },
      h("span", { class: `git-code git-code-${code}`, title: GIT_CODES[code] ?? code }, code),
      h(
        "button",
        { type: "button", class: "git-card-main", title: "Show the changes. Ctrl+click or Shift+click to select several.", "aria-pressed": String(selected.has(key)), onclick: (e) => cardClick(e, f, kind) },
        h("span", { class: "git-name" }, f.path.slice(slash + 1)),
        slash >= 0 ? h("span", { class: "git-folder" }, f.path.slice(0, slash + 1)) : null,
        f.from ? h("span", { class: "git-folder" }, `from ${f.from}`) : null,
      ),
      f.staged && f.unstaged && !f.conflicted ? h("span", { class: "badge", title: "Part of this file is staged, part isn't" }, "partly") : null,
      f.conflicted ? h("span", { class: "badge badge-danger" }, "conflict") : null,
      btn(null, () => move(kind, [f.path]), { small: true, kind: "ghost", iconName: kind === "changes" ? "right" : "left", title: kind === "changes" ? "Stage" : "Unstage", name: `${kind === "changes" ? "Stage" : "Unstage"} ${f.path}` }),
    );
    li.addEventListener("dragstart", (e) => {
      if (!selected.has(key)) {
        selected = new Set([key]);
        markSelected();
      }
      const paths = [...selected].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
      drag = { from: kind, paths };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", paths.join("\n"));
      requestAnimationFrame(() => board.querySelectorAll(".git-card.selected").forEach((c) => c.classList.add("dragging")));
    });
    li.addEventListener("dragend", endDrag);
    return li;
  }

  function endDrag() {
    drag = null;
    for (const el of root.querySelectorAll(".dragging, .drop-target")) el.classList.remove("dragging", "drop-target");
  }

  function cardClick(e, f, kind) {
    const key = `${kind}:${f.path}`;
    if (e.ctrlKey || e.metaKey) {
      for (const k of [...selected]) if (!k.startsWith(`${kind}:`)) selected.delete(k);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      lastClicked = key;
      return markSelected();
    }
    if (e.shiftKey && lastClicked?.startsWith(`${kind}:`)) {
      const keys = filesIn(kind).map((x) => `${kind}:${x.path}`);
      const [a, b] = [keys.indexOf(lastClicked), keys.indexOf(key)].sort((x, y) => x - y);
      if (a >= 0) {
        selected = new Set(keys.slice(a, b + 1));
        return markSelected();
      }
    }
    selected.clear();
    lastClicked = key;
    markSelected();
    openDiff(f.path, kind === "staged");
  }

  function markSelected() {
    for (const el of board.querySelectorAll(".git-card")) {
      const on = selected.has(el.dataset.key);
      el.classList.toggle("selected", on);
      el.querySelector(".git-card-main")?.setAttribute("aria-pressed", String(on));
    }
    for (const kind of ["changes", "staged"]) {
      const n = [...selected].filter((k) => k.startsWith(`${kind}:`)).length;
      const verb = kind === "changes" ? "Stage" : "Unstage";
      columns[kind].all.replaceChildren(icon(kind === "changes" ? "right" : "left"), n ? `${verb} ${n} selected` : `${verb} all`);
    }
  }

  function renderBoard({ animate = true } = {}) {
    const places = animate ? rememberPlaces(board) : new Map();
    for (const kind of ["changes", "staged"]) {
      const files = filesIn(kind);
      const c = columns[kind];
      c.count.textContent = String(files.length);
      c.all.disabled = files.length === 0;
      c.list.replaceChildren(...files.map((f) => card(f, kind)));
      c.empty.hidden = files.length > 0;
      c.empty.textContent =
        kind === "changes"
          ? status?.files.length ? "Everything changed is staged." : "Nothing changed since the last commit."
          : "Drag files here, or press the arrow on a card, to put them in the next commit.";
    }
    for (const k of [...selected]) if (!board.querySelector(`[data-key="${CSS.escape(k)}"]`)) selected.delete(k);
    markSelected();
    updateCommitBox();
    slideFromPlaces(board, places);
  }

  function updateCommitBox() {
    const staged = filesIn("staged");
    commitSummary.textContent = staged.length ? `${plural(staged.length, "file")} go${staged.length === 1 ? "es" : ""} in this commit.` : "Stage some changes first.";
    commitButton.disabled = !staged.length || !message.value.trim() || working > 0 || staged.some((f) => f.conflicted) || (status?.files ?? []).some((f) => f.conflicted);
  }

  function renderHead() {
    const s = status;
    const sync = !s.upstream
      ? h("span", { class: "dim" }, s.hasCommits ? "Not pushed anywhere yet: this branch has no upstream." : "No commits yet.")
      : s.ahead || s.behind
        ? [
            s.ahead ? h("span", { class: "badge badge-warn" }, `${s.ahead} to push`) : null,
            s.behind ? h("span", { class: "badge badge-accent" }, `${s.behind} to pull`) : null,
            h("span", { class: "dim" }, `compared with ${s.upstream}`),
          ]
        : h("span", { class: "dim" }, `Up to date with ${s.upstream}.`);
    put(headInfo,
      h("span", { class: "graph-ref graph-ref-current git-branch-name" }, icon("git"), s.detached ? "No branch (detached HEAD)" : (s.branch ?? "No branch")),
      sync,
      s.truncated ? h("span", { class: "badge badge-warn" }, "Only the first 1000 changed files are listed") : null,
    );
  }

  function setStatus(fresh) {
    status = fresh;
    statusSig = JSON.stringify(fresh);
    renderHead();
    renderBoard();
    if (graph && fresh.head !== graphHead) loadGraph();
  }

  async function loadStatus({ quiet = false } = {}) {
    const forDir = dir;
    try {
      const fresh = await api(`/api/git/status?dir=${encodeURIComponent(dir)}`);
      if (forDir !== dir || stopped) return;
      if (JSON.stringify(fresh) === statusSig) return;
      setStatus(fresh);
      if (openFile && quiet) refreshOpenFile();
    } catch (err) {
      if (quiet) return;
      headInfo.replaceChildren(errorView(err, () => load()));
    }
  }

  /** What the board will look like once git has done it: shown at once, replaced by git's answer. */
  function expected(paths, stage) {
    const set = new Set(paths);
    return {
      ...status,
      files: status.files.map((f) => {
        if (!set.has(f.path)) return f;
        if (stage) return { ...f, staged: true, unstaged: false, untracked: false, index: f.untracked ? "A" : f.index === "." ? f.worktree : f.index, worktree: "." };
        return { ...f, staged: false, unstaged: true, untracked: f.index === "A", index: ".", worktree: f.index === "A" ? "?" : f.worktree === "." ? f.index : f.worktree };
      }),
    };
  }

  async function move(from, paths) {
    if (!paths.length || !status) return;
    const stage = from === "changes";
    const before = status;
    working++;
    status = expected(paths, stage);
    selected.clear();
    renderBoard();
    try {
      setStatus(await api(`/api/git/${stage ? "stage" : "unstage"}`, { method: "POST", body: { dir, paths } }));
      say(`${stage ? "Staged" : "Unstaged"} ${paths.length === 1 ? paths[0] : plural(paths.length, "file")}`);
    } catch (err) {
      status = before;
      renderBoard();
      toast(err.message, "error");
      loadStatus();
    } finally {
      working--;
      updateCommitBox();
    }
    refreshOpenFile();
  }

  async function moveHunk({ from, path, hunk }) {
    const unstage = from === "staged";
    working++;
    try {
      setStatus(await api("/api/git/hunk", { method: "POST", body: { dir, path, hunk, staged: unstage } }));
      say(`${unstage ? "Unstaged" : "Staged"} a block of ${path}`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      working--;
      updateCommitBox();
    }
    refreshOpenFile();
  }

  // ---------------------------------------------------------------- one file's changes

  function refreshOpenFile() {
    if (!openFile || !status) return;
    const f = status.files.find((x) => x.path === openFile.path);
    if (f && (openFile.staged ? f.staged : f.unstaged)) return void openDiff(openFile.path, openFile.staged, { quiet: true });
    // Staged whole (or unstaged): follow the file to the column it's in now.
    if (f) return void openDiff(f.path, f.staged && !f.unstaged, { quiet: true });
    closeFile();
  }

  function closeFile() {
    openFile = null;
    filePanel.replaceChildren();
    for (const el of board.querySelectorAll(".git-card.open")) el.classList.remove("open");
  }

  async function openDiff(file, staged, { quiet = false } = {}) {
    openFile = { path: file, staged };
    for (const el of board.querySelectorAll(".git-card")) el.classList.toggle("open", el.dataset.key === `${staged ? "staged" : "changes"}:${file}`);
    if (!quiet) filePanel.replaceChildren(h("div", { class: "card card-pad" }, loadingView(`Reading ${file}…`)));
    try {
      const d = await api(`/api/git/diff?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(file)}&staged=${staged}`);
      if (openFile?.path !== file || openFile.staged !== staged) return;
      renderFile(d);
      if (!quiet) filePanel.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
    } catch (err) {
      if (openFile?.path === file) filePanel.replaceChildren(h("div", { class: "card card-pad" }, errorView(err)));
    }
  }

  function renderFile(d) {
    const from = d.staged ? "staged" : "changes";
    const firstLine = d.hunks.length ? hunkStart(d.hunks[0].header).new : undefined;
    const hunkAction = (hk) =>
      btn(d.staged ? "Unstage block" : "Stage block", (ev) => {
        ev.currentTarget.disabled = true;
        moveHunk({ from, path: d.path, hunk: hk.id });
      }, { small: true, iconName: d.staged ? "left" : "right" });
    const detail = liveDetail((mode) => {
      if (mode === "raw") return h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "Diff"), copyButton(d.patch)), h("pre", { class: "log-snippet raw-text diff-raw" }, d.patch || "No changes to show."));
      if (d.binary) return h("p", { class: "dim" }, "A binary file: its changes can't be shown as text.");
      if (!d.hunks.length) return h("p", { class: "dim" }, "No changes to show: an empty file, or only its mode changed.");
      const budget = { rows: DIFF_ROWS_MAX };
      return d.hunks.map((hk) => {
        const el = hunkView(hk.header, hk.lines, { action: d.stageable ? hunkAction(hk) : null, budget });
        if (d.stageable) {
          // A block can be dragged to the other column too, by its header.
          const head = el.querySelector(".diff-hunk-head");
          head.draggable = true;
          head.title = `Drag to ${d.staged ? "Changes" : "Staged"}`;
          head.addEventListener("dragstart", (e) => {
            drag = { from, path: d.path, hunk: hk.id };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", hk.header);
            el.classList.add("dragging");
          });
          head.addEventListener("dragend", endDrag);
        }
        return el;
      });
    });
    filePanel.replaceChildren(
      h(
        "section",
        { class: "card card-pad section git-file", "aria-labelledby": "git-file-title" },
        h(
          "div",
          { class: "section-head" },
          h("div", { class: "git-file-title" }, h("h2", { class: "section-title mono", id: "git-file-title" }, d.path), h("span", { class: "badge" }, d.staged ? "Staged" : d.untracked ? "New file" : "Not staged")),
          h(
            "div",
            { class: "toolbar" },
            btn(d.staged ? "Unstage file" : "Stage file", () => move(from, [d.path]), { small: true, iconName: d.staged ? "left" : "right" }),
            btn("Open in editor", (ev) => busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir, file: d.path, line: firstLine } })).message)), { small: true, kind: "ghost", iconName: "code" }),
            btn(null, () => closeFile(), { small: true, kind: "ghost", iconName: "x", name: "Close the changes", title: "Close" }),
          ),
        ),
        d.truncated ? h("p", { class: "dim" }, "This file's changes are cut at 512 KB, so it can only be staged whole.") : null,
        !d.stageable && d.hunks.length && !d.truncated ? h("p", { class: "dim" }, "New, deleted and renamed files go whole: stage or unstage the file.") : null,
        detail,
      ),
    );
  }

  // ---------------------------------------------------------------- commit

  async function commit(button) {
    const text = message.value;
    const flying = [...columns.staged.list.children];
    working++;
    updateCommitBox();
    const r = await busy(button, "Committing…", () => api("/api/git/commit", { method: "POST", body: { dir, message: text } }));
    working--;
    if (!r) return updateCommitBox();
    message.value = "";
    drafts.delete(dir);
    newCommit = r.hash;
    say(`Committed ${r.short}: ${r.subject}`);
    toast(`Committed ${r.short}: ${r.subject}`);
    await flyToHistory(flying);
    closeFile();
    await Promise.all([loadStatus(), loadGraph()]);
  }

  /** The committed cards fly into the top of the history, where the new commit appears. */
  async function flyToHistory(cards) {
    if (reducedMotion.matches || !cards.length) return;
    const target = (historyList?.firstElementChild ?? history).getBoundingClientRect();
    await Promise.all(
      cards.slice(0, 30).map((c, i) => {
        const r = c.getBoundingClientRect();
        const dx = target.left + 16 - r.left;
        const dy = target.top + target.height / 2 - (r.top + r.height / 2);
        return c
          .animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 }], { duration: 520, delay: Math.min(i, 8) * 40, easing: "cubic-bezier(0.5, 0, 0.2, 1)", fill: "forwards" })
          .finished.catch(() => {});
      }),
    );
  }

  // ---------------------------------------------------------------- history

  async function loadGraph() {
    const forDir = dir;
    try {
      const g = await api(`/api/git/graph?dir=${encodeURIComponent(dir)}&limit=${limit}`);
      if (forDir !== dir || stopped) return;
      graph = g;
      // The commit HEAD is on, as this graph saw it: when the status says HEAD moved, the graph is redrawn.
      graphHead = g.commits.find((c) => c.refs.some((r) => r.current || r.kind === "head"))?.hash ?? status?.head;
      renderGraph();
    } catch (err) {
      history.replaceChildren(errorView(err, () => loadGraph()));
    }
  }

  function renderGraph() {
    if (!graph.commits.length) {
      historyList = null;
      history.replaceChildren(stateView("No commits yet", "Stage your files and make the first commit: it shows up here."));
      return;
    }
    const lanes = Math.min(MAX_LANES, Math.max(1, graph.width));
    historyList = h("ol", { class: "graph", "aria-label": "Commits, newest first" }, graph.commits.map((c) => graphRow(c, lanes)));
    put(history,
      historyList,
      graph.more
        ? h(
            "div",
            { class: "graph-more" },
            btn("Show older commits", (ev) =>
              busy(ev.currentTarget, "Reading…", async () => {
                limit = Math.min(2000, limit + 300);
                await loadGraph();
              }), { small: true, kind: "ghost" }),
          )
        : null,
    );
    newCommit = null;
  }

  function graphRow(c, lanes) {
    const isOpen = openCommit === c.hash;
    const li = h("li", { class: `graph-item${c.hash === newCommit ? " graph-new" : ""}${isOpen ? " open" : ""}`, dataset: { hash: c.hash } });
    li.style.setProperty("--lanes", String(lanes));
    const row = h(
      "button",
      { type: "button", class: "graph-row", "aria-expanded": String(isOpen), onclick: () => toggleCommit(c, lanes) },
      graphCell(c.row, lanes, c.parents.length > 1),
      h("span", { class: "graph-text" }, c.refs.length ? h("span", { class: "graph-refs" }, c.refs.map(refBadge)) : null, h("span", { class: "graph-subject" }, c.subject || "(no message)")),
      h("span", { class: "graph-author" }, c.author),
      h("span", { class: "graph-hash mono" }, c.short),
      h("time", { class: "graph-time", datetime: new Date(c.at).toISOString(), title: new Date(c.at).toLocaleString() }, relativeTime(c.at)),
    );
    li.append(row);
    if (isOpen) li.append(commitDetail(c, lanes));
    return li;
  }

  function toggleCommit(c, lanes) {
    const previous = openCommit;
    openCommit = previous === c.hash ? null : c.hash;
    for (const hash of [previous, c.hash]) {
      const el = hash && historyList?.querySelector(`[data-hash="${hash}"]`);
      const commitOf = hash && graph.commits.find((x) => x.hash === hash);
      if (el && commitOf) el.replaceWith(graphRow(commitOf, lanes));
    }
    historyList?.querySelector(`[data-hash="${c.hash}"] .graph-row`)?.focus();
  }

  function commitDetail(c, lanes) {
    const body = h("div", { class: "graph-detail-body" }, loadingView("Reading the commit…"));
    const box = h("div", { class: "graph-detail" }, laneStrip(c.row, lanes), body);
    (async () => {
      try {
        const d = await api(`/api/git/commit?dir=${encodeURIComponent(dir)}&hash=${c.hash}`);
        const [, ...rest] = d.message.split("\n");
        const more = rest.join("\n").trim();
        put(body,
          h("p", { class: "graph-detail-subject" }, d.subject),
          more ? h("p", { class: "graph-detail-message" }, more) : null,
          h(
            "p",
            { class: "graph-detail-meta dim" },
            d.author,
            " · ",
            new Date(d.at).toLocaleString(),
            " · ",
            h("span", { class: "mono" }, d.short),
            d.parents.length > 1 ? ` · merge of ${d.parents.map((p) => p.slice(0, 7)).join(" and ")}` : null,
            " ",
            copyButton(d.hash, "Copy hash"),
          ),
          d.files.length ? liveDetail(diffBlock(d.patch, { truncated: d.truncated })) : h("p", { class: "dim" }, "No file changes."),
        );
      } catch (err) {
        body.replaceChildren(errorView(err));
      }
    })();
    return box;
  }

  // ---------------------------------------------------------------- loading

  async function load({ keep = false } = {}) {
    if (!keep) {
      message.value = drafts.get(dir) ?? "";
      openFile = null;
      openCommit = null;
      selected.clear();
      filePanel.replaceChildren();
      status = null;
      statusSig = "";
      graph = null;
      limit = 200;
      history.replaceChildren(loadingView("Reading the history…"));
    }
    await Promise.all([loadStatus(), loadGraph()]);
    if (keep && openFile) refreshOpenFile();
  }

  (async () => {
    try {
      projects = (await api("/api/projects")).filter((p) => p.hasGit).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      headInfo.replaceChildren(errorView(err, () => route()));
      return;
    }
    if (!projects.length) {
      board.hidden = true;
      headInfo.replaceChildren(stateView("No git projects", "dx didn't find a project with git in your projects folders.", h("a", { class: "btn", href: "#/projects" }, "Go to projects")));
      history.closest("section").hidden = true;
      return;
    }
    if (!projects.some((p) => p.dir.toLowerCase() === dir.toLowerCase())) dir = [...projects].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0].dir;
    else dir = projects.find((p) => p.dir.toLowerCase() === dir.toLowerCase()).dir;
    projectSelect.replaceChildren(...projects.map((p) => h("option", { value: p.dir, selected: p.dir === dir }, p.name)));
    projectSelect.disabled = false;
    renderBoard({ animate: false });
    load();
  })();

  // Changes made in the editor or a terminal show up on their own; never in the middle of a drag.
  const timer = setInterval(() => {
    if (!document.hidden && !drag && !working && status) loadStatus({ quiet: true });
  }, 4000);
  const onFocus = () => !drag && !working && status && loadStatus({ quiet: true });
  window.addEventListener("focus", onFocus);
  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    drafts.set(dir, message.value);
  };
}

// ------------------------------------------------------------------ Activity

const ACTIVITY_LABELS = { request: "Request", page: "Page", route: "Route", action: "Click", console: "Console", error: "Error", server: "Server", "server-error": "Server error" };

function isProblemEvent(e) {
  if (e.type === "error" || e.type === "server-error") return true;
  if (e.type === "request" || e.type === "page") return !!e.error || (e.status ?? 0) >= 400;
  if (e.type === "console") return e.level === "error" || e.level === "warn";
  return e.level === "error";
}

const ACTIVITY_VIEWS = [
  ["sessions", "Sessions"],
  ["apis", "APIs"],
  ["errors", "Errors"],
  ["console", "Console"],
];

function activityPage(root) {
  let dir = pref("activityDir", "");
  let view = pref("activityView", "sessions");
  if (!ACTIVITY_VIEWS.some(([v]) => v === view)) view = "sessions";
  let since = pref("activitySince", "today");
  let search = "";
  let events = [];
  let lastId = 0;
  let projects = [];
  let stopped = false;
  let searchTimer = 0;
  const replays = new Map(); // visit key -> what its last replay found

  const holder = h("div", { class: "card" }, loadingView("Reading the history…"));
  const hint = h("div", { class: "section", "aria-live": "polite" });
  const overview = h("div", { class: "activity-projects" });
  const viewPicker = segmented("View", ACTIVITY_VIEWS, view, (v) => ((view = v), setPref("activityView", v), render()));
  viewPicker.classList.add("segmented-wrap");
  const opened = new Set(); // API endpoints and errors opened, by key
  let openRows = new Set(); // single events opened, by id
  const projectSelect = h("select", { onchange: (e) => ((dir = e.target.value), setPref("activityDir", dir), load()) }, h("option", { value: "" }, "All projects"));
  const searchInput = h("input", {
    class: "input input-wide",
    type: "search",
    placeholder: "Search addresses, payloads, messages…",
    "aria-label": "Search the history",
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => ((search = searchInput.value.trim()), load()), 300);
    },
  });
  const clear = btn(
    "Clear history",
    async (ev) => {
      const button = ev.currentTarget;
      const name = dir ? (projects.find((p) => p.dir === dir)?.name ?? "this project") : "every project";
      const yes = await confirmDialog({ title: "Clear the history?", text: `This deletes the recorded requests, routes, clicks, console output and errors of ${name}. It can't be undone.`, confirm: "Clear history" });
      if (!yes) return;
      const r = await busy(button, "Clearing…", () => api("/api/activity/clear", { method: "POST", body: dir ? { dir } : {} }));
      if (!r) return;
      toast("History cleared");
      load();
    },
    { kind: "danger-ghost", iconName: "cleanup" },
  );

  append(
    root,
    pageHead(
      "Activity",
      "What happened in your apps: each visit's steps, every API with its payloads, responses and times, errors and console output.",
      h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Project"), projectSelect),
      segmented("Since", [["1h", "Last hour"], ["today", "Today"], ["7d", "7 days"]], since, (v) => ((since = v), setPref("activitySince", v), load())),
      clear,
    ),
    overview,
    h("div", { class: "card card-pad toolbar" }, viewPicker, searchInput),
    hint,
    holder,
  );

  /**
   * A running app with nothing from its browser side is usually open at localhost:<port>,
   * which dx doesn't see: say where to open it instead.
   */
  async function updateHint() {
    let running = [];
    try {
      running = await api("/api/dev");
    } catch {
      return;
    }
    const recorded = new Set(events.filter((e) => e.from === "browser").map((e) => e.dir.toLowerCase()));
    const missing = running.filter((s) => s.localUrl && s.status === "ready" && !recorded.has(s.dir.toLowerCase()) && (!dir || s.dir === dir));
    hint.replaceChildren(
      ...missing.slice(0, 3).map((s) =>
        h(
          "div",
          { class: "note" },
          icon("info"),
          h(
            "p",
            null,
            ...(s.recorded && s.url
              ? [
                  `Nothing from ${s.project}'s browser side yet. Open it at `,
                  h("a", { href: s.url, target: "_blank", rel: "noreferrer", class: "mono" }, s.url.replace(/^https?:\/\//, "")),
                  " or ",
                  h("a", { href: s.localUrl, target: "_blank", rel: "noreferrer", class: "mono" }, s.localUrl.replace(/^https?:\/\//, "")),
                  " in any browser: its clicks, routes, console and API calls show up here.",
                ]
              : [
                  `Nothing from ${s.project}'s browser side yet. Open it at `,
                  h("a", { href: s.localUrl, target: "_blank", rel: "noreferrer", class: "mono" }, s.localUrl.replace(/^https?:\/\//, "")),
                  ` to record its clicks, routes and console${s.url ? `; at ${s.url.replace(/^https?:\/\//, "")} dx doesn't see it (its tool can't be moved to another port)` : ""}.`,
                ]),
          ),
        ),
      ),
    );
  }

  function query(extra = {}) {
    const q = new URLSearchParams({ limit: "2000", ...extra });
    if (dir) q.set("dir", dir);
    if (search) q.set("q", search);
    return q;
  }

  async function load() {
    try {
      events = await api(`/api/activity?${query({ since })}`);
      lastId = Math.max(lastId, ...events.map((e) => e.id));
      render();
      void updateHint();
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
    }
  }

  async function poll() {
    if (stopped) return;
    if (document.visibilityState === "visible" && lastId) {
      try {
        const next = await api(`/api/activity?${query({ after: String(lastId) })}`);
        if (!stopped && next.length) {
          // In the order things happened: a page's clicks arrive a moment after the requests they caused.
          events = [...events, ...next].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id).slice(-2000);
          lastId = Math.max(lastId, ...next.map((e) => e.id));
          render();
          if (hint.childElementCount) void updateHint();
        }
      } catch {
        // the next poll tries again
      }
    }
    if (!stopped) setTimeout(poll, 2000);
  }

  function render() {
    renderOverview();
    if (!events.length) {
      holder.replaceChildren(
        stateView(
          search ? "Nothing matches" : "Nothing recorded yet",
          search
            ? "Try other words, or a longer time."
            : "Start an app from the Projects page and open it in your browser. Its requests, routes, clicks, console output and errors show up here as they happen.",
          search ? null : h("a", { class: "btn", href: "#/projects" }, "Go to projects"),
        ),
      );
      return;
    }
    const many = !dir && new Set(events.map((e) => e.dir)).size > 1;
    // Rows people opened stay open when new events come in.
    openRows = new Set([...holder.querySelectorAll("details[open][data-id]")].map((d) => d.dataset.id));
    if (view === "apis") return renderApis(many);
    if (view === "errors") return renderErrors(many);
    if (view === "console") return renderConsole(many);
    renderSessions(many);
  }

  /** Each project with its visits, API calls and problems; a click shows only that project. */
  function renderOverview() {
    if (dir) return overview.replaceChildren();
    const byDir = new Map();
    for (const e of events) {
      const s = byDir.get(e.dir) ?? byDir.set(e.dir, { dir: e.dir, project: e.project, visits: new Set(), calls: 0, problems: 0, last: e.at }).get(e.dir);
      if (e.visit) s.visits.add(e.visit);
      if (e.type === "request") s.calls++;
      if (isProblemEvent(e)) s.problems++;
      s.last = e.at;
    }
    const list = [...byDir.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
    overview.replaceChildren(
      ...list.map((s) =>
        h(
          "button",
          {
            type: "button",
            class: "card activity-project",
            title: `Show only ${s.project}`,
            onclick: () => {
              dir = s.dir;
              projectSelect.value = s.dir;
              setPref("activityDir", dir);
              load();
            },
          },
          h("strong", null, s.project),
          h("span", { class: "dim" }, `${plural(s.visits.size, "visit")} · ${plural(s.calls, "API call")} · ${relativeTime(Date.parse(s.last))}`),
          s.problems ? h("span", { class: "badge badge-danger" }, plural(s.problems, "problem")) : h("span", { class: "badge badge-ok" }, "no problems"),
        ),
      ),
    );
  }

  /** The address an API call is grouped by: ids, numbers and long hex in its path become :id. */
  function endpointOf(e) {
    let path = e.url ?? e.text.split(" ")[1] ?? "";
    let host = "";
    try {
      const u = new URL(path, "http://same.origin");
      if (u.host !== "same.origin") host = u.host;
      path = u.pathname;
    } catch {
      path = path.split("?")[0];
    }
    const norm = path
      .split("/")
      .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) ? ":id" : seg))
      .join("/");
    return `${(e.method ?? "GET").toUpperCase()} ${host}${norm || "/"}`;
  }

  /** Every API with its calls: how often, how fast, how many failed; open one for each call's payload and response. */
  function renderApis(many) {
    const groups = new Map();
    for (const e of events) {
      if (e.type !== "request") continue;
      const key = `${e.dir}|${endpointOf(e)}`;
      const g = groups.get(key) ?? groups.set(key, { key, endpoint: endpointOf(e), project: e.project, service: e.service, calls: [] }).get(key);
      g.calls.push(e);
    }
    if (!groups.size) return holder.replaceChildren(stateView("No API calls", "Requests your app makes to its API show up here, each endpoint with its calls, payloads, responses and times."));
    const list = [...groups.values()].sort((a, b) => Date.parse(b.calls[b.calls.length - 1].at) - Date.parse(a.calls[a.calls.length - 1].at));
    holder.replaceChildren(
      h(
        "div",
        { class: "api-list" },
        h("div", { class: "api-row api-header", "aria-hidden": "true" }, h("span", null, "Endpoint"), h("span", null, "Calls"), h("span", null, "Avg"), h("span", null, "Slowest"), h("span", null, "Last")),
        list.map((g) => {
          const times = g.calls.map((c) => c.ms).filter((ms) => ms !== undefined);
          const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : undefined;
          const slow = times.length ? Math.max(...times) : undefined;
          const failed = g.calls.filter(isProblemEvent).length;
          const last = g.calls[g.calls.length - 1];
          const [method, ...rest] = g.endpoint.split(" ");
          return h(
            "details",
            {
              class: "api-group",
              open: opened.has(g.key) || undefined,
              ontoggle: (e) => (e.target.open ? opened.add(g.key) : opened.delete(g.key)),
            },
            h(
              "summary",
              { class: "api-row" },
              h(
                "span",
                { class: "api-endpoint" },
                h("span", { class: "badge mono" }, method),
                h("span", { class: "mono" }, rest.join(" ")),
                many ? h("span", { class: "badge" }, g.project) : null,
                g.service ? h("span", { class: "badge" }, g.service) : null,
                failed ? h("span", { class: "badge badge-danger" }, `${failed} failed`) : null,
              ),
              h("span", null, String(g.calls.length)),
              h("span", { class: "dim" }, avg === undefined ? "–" : `${avg} ms`),
              h("span", { class: slow !== undefined && slow > 1000 ? "api-slow" : "dim" }, slow === undefined ? "–" : `${slow} ms`),
              h("span", null, h("span", { class: `badge ${isProblemEvent(last) ? "badge-danger" : "badge-ok"}` }, last.error ? "failed" : String(last.status ?? "…")), h("span", { class: "dim" }, ` ${relativeTime(Date.parse(last.at))}`)),
            ),
            h("ul", { class: "activity-list api-calls" }, [...g.calls].reverse().slice(0, 50).map((c) => activityRow(c, false, openRows.has(String(c.id))))),
          );
        }),
      ),
    );
  }

  /** Errors grouped by what they say, most recent first, each with every time it happened. */
  function renderErrors(many) {
    const groups = new Map();
    for (const e of events) {
      if (!isProblemEvent(e) || (e.type === "console" && e.level === "warn")) continue;
      const kind = e.type === "server-error" ? "Server" : e.type === "error" ? "Browser" : e.type === "console" ? "Console" : "Request";
      const message = e.type === "request" || e.type === "page" ? `${endpointOf(e)} → ${e.error ?? e.status}` : e.text.split("\n")[0].replace(/\d+/g, "#");
      const key = `${e.dir}|${kind}|${message}`;
      const g = groups.get(key) ?? groups.set(key, { key, kind, project: e.project, all: [] }).get(key);
      g.all.push(e);
    }
    if (!groups.size) return holder.replaceChildren(stateView("No errors", "Uncaught exceptions, console errors, failed requests and server errors show up here, grouped, with each time they happened."));
    const list = [...groups.values()].sort((a, b) => Date.parse(b.all[b.all.length - 1].at) - Date.parse(a.all[a.all.length - 1].at));
    holder.replaceChildren(
      h(
        "div",
        { class: "api-list" },
        list.map((g) => {
          const last = g.all[g.all.length - 1];
          const first = g.all[0];
          return h(
            "details",
            { class: "api-group", open: opened.has(g.key) || undefined, ontoggle: (e) => (e.target.open ? opened.add(g.key) : opened.delete(g.key)) },
            h(
              "summary",
              { class: "error-row" },
              h("span", { class: "badge badge-danger" }, g.kind),
              h("span", { class: "error-message" }, last.text.split("\n")[0]),
              many ? h("span", { class: "badge" }, g.project) : null,
              last.source ? h("span", { class: "dim mono" }, last.source) : null,
              h("span", { class: "dim" }, `${g.all.length > 1 ? `${g.all.length}× · ` : ""}${g.all.length > 1 ? `first ${relativeTime(Date.parse(first.at))}, ` : ""}last ${relativeTime(Date.parse(last.at))}`),
            ),
            h("ul", { class: "activity-list api-calls" }, [...g.all].reverse().slice(0, 20).map((e) => activityRow(e, false, openRows.has(String(e.id))))),
          );
        }),
      ),
    );
  }

  /** Console output, newest first; the same line repeated is one row with a count. */
  function renderConsole(many) {
    const lines = events.filter((e) => e.type === "console");
    if (!lines.length) return holder.replaceChildren(stateView("No console output", "console.log, info, warn and error from your app's pages show up here, with the file and line that wrote them."));
    const rows = [];
    for (const e of [...lines].reverse()) {
      const prev = rows[rows.length - 1];
      if (prev && prev.e.text === e.text && prev.e.level === e.level && prev.e.dir === e.dir) prev.count++;
      else rows.push({ e, count: 1 });
    }
    holder.replaceChildren(
      h(
        "ul",
        { class: "activity-list console-list" },
        rows.slice(0, 500).map(({ e, count }) => {
          const row = activityRow(e, many, openRows.has(String(e.id)));
          if (count > 1) row.querySelector(".activity-text")?.append(h("span", { class: "badge" }, ` ×${count}`));
          return row;
        }),
      ),
    );
  }

  function renderSessions(many) {
    // Keep what people opened open when new events come in; the newest visit, and visits with problems, start open.
    const seen = holder.querySelector("[data-group]") !== null;
    const open = new Set([...holder.querySelectorAll("details[open]")].map((d) => d.dataset.id ?? d.dataset.group));
    const groups = visitsOf(events);
    const byDay = new Map();
    for (const g of groups) {
      const d = new Date(g.events[0].at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      (byDay.get(key) ?? byDay.set(key, []).get(key)).push(g);
    }
    const newest = groups[groups.length - 1]?.key;
    holder.replaceChildren(
      ...[...byDay.entries()].reverse().map(([day, list]) =>
        h(
          "section",
          { class: "day" },
          h("h2", { class: "day-title" }, dayLabel(day)),
          [...list].reverse().map((g) => visitView(g, many, seen ? open.has(g.key) : g.key === newest || g.problems > 0, open)),
        ),
      ),
    );
  }

  /**
   * Events in groups: a visit is one page load in one tab and what followed it (the page's own
   * events carry its id; requests and server errors join the visit they happened in), and the
   * dev server's own lines are a group of their own.
   */
  function visitsOf(list) {
    const groups = [];
    const current = new Map(); // dir -> the open group
    const byVisit = new Map(); // visit id -> its group
    const start = (e, extra) => {
      const g = { key: `g${e.id}`, dir: e.dir, project: e.project, events: [], problems: 0, ...extra };
      groups.push(g);
      current.set(e.dir, g);
      return g;
    };
    for (const e of list) {
      let g = current.get(e.dir);
      const last = g?.events[g.events.length - 1];
      const recent = last && Date.parse(e.at) - Date.parse(last.at) < 30_000;
      if (e.type === "server") {
        if (g?.kind !== "server") g = start(e, { kind: "server" });
      } else if (e.visit) {
        const known = byVisit.get(e.visit);
        if (known) {
          g = known;
          current.set(e.dir, g);
        } else if (g && g.kind === "visit" && !g.visit && recent) g.visit = e.visit; // the page load that started it
        else g = start(e, { kind: "visit", visit: e.visit });
        byVisit.set(e.visit, g);
      } else if (e.type === "page") {
        // A page load starts a visit, unless one has just started and its page hasn't spoken yet.
        const starting = g?.kind === "visit" && !g.visit && last && Date.parse(e.at) - Date.parse(last.at) < 5000;
        if (!starting) g = start(e, { kind: "visit" });
      } else if (!g || g.kind === "server" || !recent) {
        g = start(e, { kind: "requests" });
      }
      g.events.push(e);
      if (isProblemEvent(e)) g.problems++;
    }
    // A visit's id is the right key once known: it stays the same as events come in.
    for (const g of groups) if (g.visit) g.key = `v${g.visit}`;
    return groups;
  }

  function visitView(g, many, isOpen, open) {
    const first = g.events[0];
    const last = g.events[g.events.length - 1];
    const time = (e) => new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const pageOf = first.type === "page" ? first.url : g.events.find((e) => e.page)?.page;
    let path = "";
    try {
      path = pageOf ? new URL(pageOf, "http://x").pathname : "";
    } catch {
      path = pageOf ?? "";
    }
    const title = g.kind === "server" ? "Dev server" : g.kind === "requests" ? "Requests" : `Visit${path ? ` to ${path}` : ""}`;
    const clicks = g.events.filter((e) => e.type === "action" && e.text.startsWith("Clicked")).length;
    const fromCheck = g.events.some((e) => e.from === "check") && !g.events.some((e) => e.from === "browser");
    const result = h("div", { class: "visit-result" }, replays.get(g.key) ?? null);
    const actions = [];
    if (g.visit && clicks && !fromCheck) {
      actions.push(
        btn("Replay", (ev) => replay(ev.currentTarget, g), {
          small: true,
          iconName: "play",
          title: "Open the page in a headless browser and click what was clicked here, in order, then list what broke",
          name: `Replay this visit to ${path || g.project}`,
        }),
      );
    }
    return h(
      "details",
      { class: "visit", open: isOpen || undefined, dataset: { group: g.key } },
      h(
        "summary",
        { class: "visit-head" },
        h("span", { class: "time" }, first === last || time(first) === time(last) ? time(first) : `${time(first)}–${time(last)}`),
        h("strong", { class: "visit-title" }, title),
        many ? h("span", { class: "badge" }, g.project) : null,
        fromCheck ? h("span", { class: "badge" }, "headless check") : null,
        h("span", { class: "dim" }, `${plural(g.events.length, "event")}${clicks ? `, ${plural(clicks, "click")}` : ""}`),
        g.problems ? h("span", { class: "badge badge-danger" }, plural(g.problems, "problem")) : null,
      ),
      actions.length ? h("div", { class: "toolbar visit-actions" }, actions) : null,
      result,
      h("ul", { class: "activity-list" }, [...g.events].reverse().map((e) => activityRow(e, many, open.has(String(e.id))))),
    );
  }

  async function replay(button, g) {
    const r = await busy(button, "Replaying…", () => api("/api/activity/replay", { method: "POST", body: { dir: g.dir, visit: g.visit } }));
    if (!r) return;
    const holderEl = h("div");
    const p = r.result.page;
    const items = [];
    for (const s of p?.steps ?? []) items.push(h("li", null, h("span", { class: `badge ${s.ok ? "badge-ok" : "badge-danger"}` }, s.ok ? "ok" : "failed"), ` ${s.action}`, s.error ? h("span", { class: "dim" }, ` · ${s.error}`) : null));
    const problems = [...(p?.exceptions ?? []).map((m) => `Exception: ${m.text}`), ...(p?.consoleErrors ?? []).map((m) => `Console error: ${m.text}`), ...(p?.failedRequests ?? []).map((f) => `${f.method ?? "GET"} ${f.url} → ${f.status ?? f.error}`)];
    holderEl.replaceChildren(
      h(
        "div",
        { class: "note", role: "status" },
        icon(p?.ok ? "check" : "warn"),
        h(
          "div",
          null,
          h("p", null, p?.error ? `The replay couldn't load ${r.replay.url}: ${p.error}` : p?.ok ? `Replayed ${plural(r.replay.steps.length, "step")} on ${r.replay.url}: no problems this time.` : `Replayed ${plural(r.replay.steps.length, "step")} on ${r.replay.url}: ${plural(problems.length, "problem")}.`),
          items.length ? h("ol", { class: "bullets" }, items) : null,
          problems.length ? h("ul", { class: "bullets" }, problems.slice(0, 10).map((t) => h("li", { class: "mono" }, t))) : null,
          r.replay.notes.map((n) => h("p", { class: "dim" }, n)),
        ),
      ),
    );
    // Shown with the visit it replayed; its own events are in the history too, as a headless check.
    replays.set(g.key, holderEl);
    void load();
  }

  async function copyReport(button, e) {
    const r = await busy(button, "Copying…", async () => {
      const report = await api(`/api/activity/report?dir=${encodeURIComponent(e.dir)}&id=${e.id}`);
      await navigator.clipboard.writeText(report.markdown);
      return report;
    });
    if (r) toast("Bug report copied: steps, requests and the error, as markdown");
  }

  function activityRow(e, many, isOpen) {
    const problem = isProblemEvent(e);
    const tone = problem ? (e.level === "warn" ? "badge-warn" : "badge-danger") : e.type === "action" || e.type === "route" ? "badge-accent" : "";
    const label = e.type === "console" && e.level && e.level !== "log" ? `Console ${e.level}` : ACTIVITY_LABELS[e.type] ?? e.type;
    const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const firstLine = e.text.split("\n")[0];
    const head = [
      h("span", { class: "time" }, time),
      h("span", { class: `badge ${tone}` }, label),
      many ? h("span", { class: "badge" }, e.project) : null,
      e.service ? h("span", { class: "badge" }, e.service) : null,
      h("span", { class: `activity-text${e.type === "request" || e.type === "page" || e.type === "console" ? " mono" : ""}` }, firstLine),
      e.ms !== undefined && (e.type === "request" || e.type === "page") ? h("span", { class: "dim" }, `${e.ms} ms`) : null,
    ];
    const details = [];
    if (problem) {
      details.push(
        h(
          "p",
          { class: "activity-meta" },
          btn("Copy as bug report", (ev) => copyReport(ev.currentTarget, e), { small: true, iconName: "copy", title: "Copy the steps that led here, the requests and the error, as markdown for an issue or an AI chat" }),
        ),
      );
    }
    if (e.trimmed) details.push(h("p", { class: "dim activity-meta" }, "Bodies and stack weren't kept: this day's history had reached its size limit."));
    if (e.page && e.type !== "page") details.push(h("p", { class: "dim mono activity-meta" }, `on ${e.page}`));
    if (e.type === "request" || e.type === "page") {
      details.push(requestDetail(e));
    } else if (e.type === "console") {
      details.push(
        liveDetail((mode) => [
          consoleBlock(e.text)(mode),
          e.source ? h("p", { class: "activity-meta" }, sourceButton(e)) : null,
          e.stack && problem ? stackBlock(e.stack, e.dir)(mode) : null,
        ]),
      );
    } else if (e.type === "error" || e.type === "server-error") {
      const extra = e.text.includes("\n") ? e.text : "";
      details.push(
        liveDetail((mode) => [
          // A stack's first frame says where already.
          e.source && (mode === "raw" || !e.stack || !parseStack(e.stack).frames.length) ? h("p", { class: "activity-meta" }, "Where: ", sourceButton(e)) : null,
          e.stack ? stackBlock(e.stack, e.dir)(mode) : extra ? h("pre", { class: "log-snippet raw-text" }, extra) : null,
        ]),
      );
    } else {
      if (e.text.includes("\n")) details.push(h("pre", { class: "log-snippet" }, e.text));
      if (e.source) details.push(h("p", { class: "activity-meta" }, sourceButton(e)));
    }
    if (!details.length) return h("li", { class: "activity-row" }, head);
    return h("li", null, h("details", { open: isOpen || undefined, dataset: { id: String(e.id) } }, h("summary", { class: "activity-row" }, head), h("div", { class: "activity-detail" }, details)));
  }

  /** The event's file and line as a button that opens your editor there, when it's one of the project's files. */
  function sourceButton(e) {
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(e.source);
    if (!m) return h("span", { class: "dim mono" }, e.source);
    return openAt(e.dir, m[1], Number(m[2]), m[3] ? Number(m[3]) : undefined);
  }

  (async () => {
    try {
      projects = await api("/api/projects");
      projectSelect.append(...projects.map((p) => h("option", { value: p.dir, selected: p.dir === dir }, p.name)));
      if (dir && !projects.some((p) => p.dir === dir)) ((dir = ""), setPref("activityDir", ""));
    } catch {
      // the list stays "All projects"
    }
    await load();
    setTimeout(poll, 2000);
  })();
  return () => {
    stopped = true;
    clearTimeout(searchTimer);
  };
}

// ------------------------------------------------------------------ Summary

function summaryPage(root) {
  let days = pref("summaryDays", "7") === "year" ? "year" : Number(pref("summaryDays", "7"));
  let github = pref("summaryGithub", "1") === "1";
  let everyone = false;
  let markdown = "";
  const holder = h("div", { class: "section" }, loadingView("Reading git history across your projects…"));
  const copy = btn("Copy as markdown", async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast("Copied. Paste it into Slack, an email or your notes.");
    } catch {
      toast("Couldn't copy. Select the text and copy it yourself.", "error");
    }
  }, { iconName: "copy", disabled: true });
  const save = btn("Save to file", async (e) => {
    if (days === "year") {
      const r = await busy(e.currentTarget, "Saving…", () => api(`/api/summary/year?save=1&github=${github ? 1 : 0}&allAuthors=${everyone ? 1 : 0}`));
      if (r) toast(`Saved as ${r.year}-in-review.md in ~/.dx/summaries`);
      return;
    }
    const r = await busy(e.currentTarget, "Saving…", () => api("/api/summary/save", { method: "POST", body: { days, github, allAuthors: everyone } }));
    if (r) toast(`Saved to ${tildify(r.file)}`);
  }, { iconName: "save", disabled: true });

  append(
    root,
    pageHead("Summary", "Your commits, pull requests and journal, ready to send.", copy, save),
    h(
      "div",
      { class: "toolbar" },
      segmented("Period", [[1, "Today"], [7, "7 days"], [30, "30 days"], ["year", "This year"]], days, (v) => ((days = v), setPref("summaryDays", v), load())),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: github, onchange: (e) => ((github = e.target.checked), setPref("summaryGithub", github ? "1" : "0"), load()) }), "GitHub pull requests"),
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((everyone = e.target.checked), load()) }), "Everyone's commits"),
    ),
    holder,
  );

  async function load() {
    copy.disabled = save.disabled = true;
    holder.replaceChildren(loadingView(days === "year" ? "Reading a year of git history across your projects…" : "Reading git history across your projects…"));
    try {
      if (days === "year") {
        const y = await api(`/api/summary/year?github=${github ? 1 : 0}&allAuthors=${everyone ? 1 : 0}`);
        markdown = y.markdown;
        copy.disabled = save.disabled = false;
        holder.replaceChildren(
          h("div", { class: "stats" }, stat(y.commits, y.commits === 1 ? "commit" : "commits", `in ${plural(y.projects, "project")}`), stat(y.activeDays, y.activeDays === 1 ? "day with commits" : "days with commits")),
          h("div", { class: "card card-pad" }, h("pre", { class: "md-doc" }, y.markdown)),
        );
        return;
      }
      const r = await api(`/api/summary?days=${days}&github=${github ? 1 : 0}&allAuthors=${everyone ? 1 : 0}`);
      markdown = r.markdown;
      copy.disabled = save.disabled = false;
      holder.replaceChildren(...renderSummary(r.summary));
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
    }
  }

  function renderSummary(s) {
    const commits = s.projects.reduce((n, p) => n + p.commits.length, 0);
    const gh = s.github && "user" in s.github ? s.github : null;
    const out = [
      h(
        "div",
        { class: "stats" },
        stat(commits, commits === 1 ? "commit" : "commits", `in ${plural(s.projects.length, "project")}`),
        gh ? stat(gh.merged.length, gh.merged.length === 1 ? "pull request merged" : "pull requests merged", `${gh.reviewed.length} reviewed`) : null,
        stat(s.journal.length, s.journal.length === 1 ? "journal entry" : "journal entries"),
        stat(s.time.length, s.time.length === 1 ? "project touched" : "projects touched"),
      ),
    ];
    if (!commits && !s.journal.length && !(gh && gh.merged.length + gh.reviewed.length)) {
      out.push(h("div", { class: "card" }, stateView("Nothing to report yet", `No commits and no journal entries in the last ${plural(s.days, "day")}.`, h("a", { class: "btn", href: "#/journal" }, "Write in your journal"))));
    }
    if (s.journal.length) {
      const byDay = new Map();
      for (const e of s.journal) (byDay.get(e.date) ?? byDay.set(e.date, []).get(e.date)).push(e);
      out.push(
        section("Journal", h("div", { class: "card" }, [...byDay.entries()].map(([date, list]) => h("div", { class: "day" }, h("h3", { class: "day-title" }, dayLabel(date)), h("ul", { class: "bullets" }, list.map((e) => h("li", null, e.text))))))),
      );
    }
    if (gh && gh.merged.length + gh.reviewed.length) {
      const prList = (title, prs) =>
        prs.length
          ? h("div", { class: "day" }, h("h3", { class: "day-title" }, title), h("ul", { class: "bullets" }, prs.map((pr) => h("li", null, pr.title, " ", h("a", { href: pr.url, target: "_blank", rel: "noreferrer", class: "mono" }, `${pr.repo}#${pr.number}`)))))
          : null;
      out.push(section("Pull requests", h("div", { class: "card" }, prList("Merged", gh.merged), prList("Reviewed", gh.reviewed))));
    }
    if (s.projects.length) {
      out.push(
        section(
          "Commits",
          h(
            "div",
            { class: "card" },
            s.projects.map((p) => {
              const seen = new Map();
              for (const c of [...p.commits].reverse()) {
                const key = c.subject.toLowerCase();
                const first = seen.get(key);
                seen.set(key, first ? { c: first.c, n: first.n + 1 } : { c, n: 1 });
              }
              return h(
                "div",
                { class: "day" },
                h("h3", { class: "day-title" }, `${p.project} `, h("span", { class: "dim" }, `(${p.commits.length})`)),
                h("ul", { class: "bullets" }, [...seen.values()].map(({ c, n }) => h("li", null, c.subject || "(no message)", n > 1 ? h("span", { class: "dim" }, ` ×${n}`) : null, h("span", { class: "dim" }, ` · ${dayLabel(c.date)}`)))),
              );
            }),
          ),
        ),
      );
    }
    if (s.time.length) {
      const max = Math.max(...s.time.map((t) => t.days), 1);
      out.push(
        section(
          "Where the time went",
          h(
            "div",
            { class: "card card-pad section" },
            s.time.map((t) =>
              h(
                "div",
                { class: "bar-row" },
                h("strong", null, t.project),
                h(
                  "div",
                  { class: "bar-track" },
                  h("div", { class: "bar", style: { width: `${Math.max(4, (t.days / max) * 100)}%` }, role: "img", "aria-label": plural(t.days, "day") }),
                  h("span", { class: "bar-label" }, [plural(t.days, "day"), t.commits ? plural(t.commits, "commit") : null, t.opens ? `opened ${t.opens}×` : null, t.devMs >= 60000 ? `${Math.round(t.devMs / 60000)} min dev server` : null].filter(Boolean).join(" · ")),
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (s.uncommitted.length) {
      out.push(
        section(
          "Not committed yet",
          h("div", { class: "note note-warn" }, icon("warn"), h("div", null, h("p", null, "These projects have changes you haven't committed. It's a reminder for you, and it's in the copied text too: delete that part before sending if you like."), h("ul", { class: "bullets" }, s.uncommitted.map((u) => h("li", null, h("strong", null, u.project), `: ${plural(u.files, "changed file")}`))))),
        ),
      );
    }
    const notes = [];
    if (s.skipped.length) notes.push(`Couldn't read ${s.skipped.map((x) => `${x.project} (${x.reason})`).join(", ")}.`);
    if (s.github && "error" in s.github) notes.push(`No pull requests: ${s.github.error}.`);
    else if (gh && !gh.authenticated) notes.push("Pull requests come from public repos only. To include private ones, sign in once with the GitHub CLI (gh auth login); dx uses that login from then on. A GITHUB_TOKEN set before dx ui starts works too.");
    if (notes.length) out.push(h("div", { class: "note" }, icon("info"), h("div", null, notes.map((n) => h("p", null, n)))));
    out.push(h("p", { class: "dim" }, `Commits by ${s.author}.`));
    return out;
  }

  function stat(value, label, sub) {
    return h("div", { class: "card stat" }, h("div", { class: "stat-value" }, value), h("div", { class: "stat-label" }, label), sub ? h("div", { class: "stat-label" }, sub) : null);
  }
  function section(title, ...content) {
    return h("section", { class: "section" }, h("h2", { class: "section-title" }, title), content);
  }
  load();
}

// ------------------------------------------------------------------ Cleanup

function cleanupPage(root) {
  let days = Number(pref("cleanupDays", "30"));
  let scan = null;
  const selected = new Set();
  const holder = h("div", { class: "section" }, loadingView("Measuring build folders in idle projects…"));
  append(
    root,
    pageHead(
      "Cleanup",
      "Free disk space: node_modules and build folders in projects you haven't touched lately.",
      h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Idle for"), h("select", { onchange: (e) => ((days = Number(e.target.value)), setPref("cleanupDays", days), load()) }, [30, 60, 90, 180, 365].map((d) => h("option", { value: d, selected: d === days }, `Idle for ${d}+ days`)))),
      btn("Scan again", () => load(), { iconName: "refresh" }),
    ),
    h("div", { class: "note" }, icon("info"), h("p", null, "Only folders an install or a build recreates are listed. In a git repo, only folders git ignores, so a committed build folder is never touched. Run npm install in a project to get its node_modules back.")),
    holder,
  );

  async function load() {
    holder.replaceChildren(loadingView("Measuring build folders in idle projects…"));
    try {
      scan = await api(`/api/cleanup?days=${days}`);
      selected.clear();
      for (const i of scan.items) selected.add(i.dir);
      render();
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
    }
  }

  function render() {
    if (!scan.items.length) {
      holder.replaceChildren(h("div", { class: "card" }, stateView("Nothing to clean", scan.projectsScanned ? `${plural(scan.projectsScanned, "project")} idle for ${days}+ days, and none has build folders left.` : `No project has been idle for ${days}+ days.`)));
      return;
    }
    const chosen = scan.items.filter((i) => selected.has(i.dir));
    const chosenBytes = chosen.reduce((n, i) => n + i.bytes, 0);
    const all = h("input", {
      type: "checkbox",
      "aria-label": "Select all",
      checked: chosen.length === scan.items.length,
      indeterminate: chosen.length > 0 && chosen.length < scan.items.length,
      onchange: (e) => {
        selected.clear();
        if (e.target.checked) for (const i of scan.items) selected.add(i.dir);
        render();
      },
    });
    holder.replaceChildren(
      h(
        "div",
        { class: "stats" },
        h("div", { class: "card stat" }, h("div", { class: "stat-value" }, formatBytes(scan.totalBytes)), h("div", { class: "stat-label" }, "can be freed")),
        h("div", { class: "card stat" }, h("div", { class: "stat-value" }, scan.items.length), h("div", { class: "stat-label" }, `folders in ${plural(new Set(scan.items.map((i) => i.project)).size, "project")}`)),
      ),
      h(
        "div",
        { class: "card table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, h("th", { scope: "col" }, all), h("th", { scope: "col" }, "Project"), h("th", { scope: "col" }, "Folder"), h("th", { scope: "col", class: "num" }, "Size"), h("th", { scope: "col" }, "Idle"))),
          h(
            "tbody",
            null,
            scan.items.map((i) =>
              h(
                "tr",
                null,
                h("td", null, h("input", { type: "checkbox", "aria-label": `${i.project} ${i.relative}`, checked: selected.has(i.dir), onchange: (e) => (e.target.checked ? selected.add(i.dir) : selected.delete(i.dir), render()) })),
                h("td", null, h("strong", null, i.project)),
                h("td", { class: "mono" }, i.relative),
                h("td", { class: "num" }, formatBytes(i.bytes)),
                h("td", { class: "dim" }, relativeTime(i.lastActive)),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "sticky-bar" },
        h("span", null, chosen.length ? `${plural(chosen.length, "folder")} selected · ${formatBytes(chosenBytes)}` : "Nothing selected"),
        btn(`Delete ${chosen.length ? formatBytes(chosenBytes) : ""}`.trim(), (e) => remove(e.currentTarget, chosen, chosenBytes), { kind: "danger", iconName: "cleanup", disabled: !chosen.length }),
      ),
    );
  }

  async function remove(button, chosen, bytes) {
    const projects = [...new Set(chosen.map((i) => i.project))];
    const ok = await confirmDialog({
      title: `Delete ${plural(chosen.length, "folder")} (${formatBytes(bytes)})?`,
      text: [`From ${projects.join(", ")}.`, "They're recreated by npm install or a build. This can't be undone."],
      confirm: `Delete ${formatBytes(bytes)}`,
    });
    if (!ok) return;
    await busy(button, "Deleting…", async () => {
      const r = await api("/api/cleanup/delete", { method: "POST", body: { days, dirs: chosen.map((i) => i.dir) } });
      toast(`Freed ${formatBytes(r.freed)} (${plural(r.deleted, "folder")} deleted)`);
      for (const f of r.failed) toast(`${tildify(f.dir)}: ${f.message}`, "error");
      await load();
    });
  }
  load();
}

// ------------------------------------------------------------------ Dependencies

function depsPage(root) {
  let active = pref("depsActive", "");
  const expanded = new Set();
  let timer;
  const runButton = btn("Run audit", () => run(), { kind: "primary", iconName: "deps" });
  const holder = h("div", { class: "section" });
  append(
    root,
    pageHead(
      "Dependencies",
      "Outdated packages and known vulnerabilities in every Node project. Nothing is changed.",
      h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Which projects"), h("select", { onchange: (e) => ((active = e.target.value), setPref("depsActive", active)) }, [["", "All projects"], ["30", "Active in the last 30 days"], ["90", "Active in the last 90 days"]].map(([v, t]) => h("option", { value: v, selected: v === active }, t)))),
      runButton,
    ),
    holder,
  );

  async function run() {
    try {
      await api("/api/deps/run", { method: "POST", body: { activeDays: active } });
      poll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function poll() {
    clearTimeout(timer);
    let job;
    try {
      job = await api("/api/deps");
    } catch (err) {
      holder.replaceChildren(errorView(err, poll));
      return;
    }
    runButton.disabled = job.running;
    if (job.running) {
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      holder.replaceChildren(
        h(
          "div",
          { class: "card card-pad section", role: "status" },
          h("p", null, job.total ? `Checking ${Math.min(job.done + 1, job.total)} of ${job.total}: ` : "Finding your Node projects…", job.current ? h("strong", null, job.current) : null),
          h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, h("div", { style: { width: `${pct}%` } })),
          h("p", { class: "dim" }, "It asks the npm registry, so it takes a few seconds per project. You can leave this page; it keeps running."),
        ),
      );
      timer = setTimeout(poll, 1000);
      return;
    }
    if (job.error) {
      holder.replaceChildren(errorView(new Error(job.error), run));
      return;
    }
    if (!job.reports) {
      holder.replaceChildren(h("div", { class: "card" }, stateView("No audit yet", "Run it to check every Node project. It takes about 5 seconds per project.", btn("Run audit", () => run(), { kind: "primary", iconName: "deps" }))));
      return;
    }
    render(job);
  }

  function render(job) {
    const reports = job.reports;
    const checked = reports.filter((r) => !r.skipped);
    const vulnerable = checked.filter((r) => (r.vulnerabilities?.total ?? 0) > 0);
    const critical = checked.reduce((n, r) => n + (r.vulnerabilities?.critical ?? 0), 0);
    const outdated = checked.reduce((n, r) => n + r.outdated.length, 0);
    holder.replaceChildren(
      h(
        "div",
        { class: "stats" },
        stat(vulnerable.length, vulnerable.length === 1 ? "project with vulnerabilities" : "projects with vulnerabilities", `of ${checked.length} checked`),
        stat(critical, critical === 1 ? "critical vulnerability" : "critical vulnerabilities"),
        stat(outdated, outdated === 1 ? "outdated package" : "outdated packages"),
      ),
      h(
        "div",
        { class: "card table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, h("th", { scope: "col" }, "Project"), h("th", { scope: "col" }, "Vulnerabilities"), h("th", { scope: "col", class: "num" }, "Outdated"), h("th", { scope: "col", class: "num" }, "Major"), h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Details")))),
          h("tbody", null, reports.flatMap((r) => rows(r))),
        ),
      ),
      h("p", { class: "dim" }, `Checked ${relativeTime(Date.parse(job.finishedAt))}. Open a project's details to update its packages.`),
    );
  }

  function rows(r) {
    const open = expanded.has(r.dir);
    const toggle = () => (open ? expanded.delete(r.dir) : expanded.add(r.dir), poll());
    const main = h(
      "tr",
      null,
      h("td", null, h("strong", null, r.project), h("div", { class: "dim mono" }, tildify(r.dir))),
      h("td", null, r.skipped ? h("span", { class: "dim" }, r.skipped) : vulnBadges(r.vulnerabilities)),
      h("td", { class: "num" }, r.skipped ? "—" : r.outdated.length),
      h("td", { class: "num" }, r.skipped ? "—" : r.outdated.filter((p) => p.major).length),
      h("td", { class: "actions" }, !r.skipped && (r.outdated.length || r.notes.length) ? btn(open ? "Hide" : "Details", toggle, { small: true, kind: "ghost", title: `Packages in ${r.project}` }) : null),
    );
    if (!open) return [main];
    return [
      main,
      h(
        "tr",
        { class: "row-detail" },
        h(
          "td",
          { colspan: "5" },
          h(
            "div",
            { class: "section" },
            r.notes.map((n) => h("p", { class: "dim" }, n)),
            r.outdated.length
              ? h(
                  "table",
                  { class: "table" },
                  h("thead", null, h("tr", null, h("th", null, "Package"), h("th", null, "Installed"), h("th", null, "Wanted"), h("th", null, "Latest"))),
                  h("tbody", null, r.outdated.map((p) => h("tr", null, h("td", { class: "mono" }, p.name), h("td", { class: "mono" }, p.current ?? "—"), h("td", { class: "mono" }, p.wanted ?? "—"), h("td", { class: "mono" }, p.latest, p.major ? h("span", { class: "badge badge-warn" }, " major") : null)))),
                )
              : null,
            h(
              "div",
              { class: "toolbar" },
              r.outdated.some((p) => !p.major) || (r.vulnerabilities?.total ?? 0) > 0 ? btn("Update packages", (e) => fixProject(e.currentTarget, r), { small: true, kind: "primary", iconName: "refresh", title: "Update within package.json's ranges and apply non-breaking audit fixes" }) : null,
              btn("Open in editor", (e) => busy(e.currentTarget, "Opening…", async () => toast((await api("/api/projects/open", { method: "POST", body: { dir: r.dir, action: "editor" } })).message)), { small: true, iconName: "code" }),
            ),
          ),
        ),
      ),
    ];
  }

  async function fixProject(button, r) {
    const commands = { npm: "npm update and npm audit fix", pnpm: "pnpm update", bun: "bun update", yarn: "yarn upgrade" }[r.packageManager] ?? "an update";
    const yes = await confirmDialog({
      title: `Update ${r.project}'s packages?`,
      text: [`This runs ${commands} in ${tildify(r.dir)}: packages move to the newest version package.json allows, and non-breaking security fixes are applied.`, "Major versions are left alone, since they may need code changes. Commit first if you want an easy way back."],
      confirm: "Update packages",
      danger: false,
    });
    if (!yes) return;
    const result = await busy(button, "Updating…", () => api("/api/deps/fix", { method: "POST", body: { dir: r.dir } }));
    if (!result) return;
    const failed = result.steps.filter((s) => !s.ok);
    toast(failed.length ? `${failed.map((s) => s.command).join(", ")} failed: ${failed[0].output ?? ""}` : `Updated ${r.project}: ${result.after?.outdated.length ?? "?"} outdated left`, failed.length ? "error" : "ok");
    poll();
  }

  function vulnBadges(v) {
    if (!v) return h("span", { class: "dim" }, "Couldn't check");
    const parts = [
      ["critical", "badge-danger"],
      ["high", "badge-danger"],
      ["moderate", "badge-warn"],
      ["low", ""],
    ].filter(([k]) => v[k] > 0);
    if (!parts.length) return h("span", { class: "badge badge-ok" }, "None");
    return h("div", { class: "chips" }, parts.map(([k, cls]) => h("span", { class: `badge ${cls}` }, `${v[k]} ${k}`)));
  }

  function stat(value, label, sub) {
    return h("div", { class: "card stat" }, h("div", { class: "stat-value" }, value), h("div", { class: "stat-label" }, label), sub ? h("div", { class: "stat-label" }, sub) : null);
  }

  poll();
  return () => clearTimeout(timer);
}

// ------------------------------------------------------------------ Health & settings

function healthPage(root) {
  const holder = h("div", { class: "section" }, loadingView("Checking your setup…"));
  append(root, pageHead("Health & settings", "Checks that dx works on this computer, its settings, and what it ran recently.", btn("Check again", () => load(), { iconName: "refresh" })), holder);

  async function load() {
    let data;
    try {
      data = await api("/api/health");
    } catch (err) {
      holder.replaceChildren(errorView(err, load));
      return;
    }
    const symbol = { ok: "✓", warn: "!", fail: "✗" };
    const checks = h(
      "ul",
      { class: "checks card" },
      data.checks.map((c) =>
        h(
          "li",
          null,
          h("span", { class: `status-${c.status}`, "aria-label": c.status }, symbol[c.status]),
          h("strong", null, c.name),
          h("span", { class: "dim", style: { overflowWrap: "anywhere" } }, c.detail, c.fix ? h("span", { class: "check-fix" }, "Fix: ", h("span", { class: "mono" }, c.fix)) : null),
        ),
      ),
    );

    const aiTools = h("div", null, loadingView("Looking for AI tools…"));
    void loadAiTools(aiTools);

    const config = data.config;
    const newRoot = h("input", { class: "input input-wide", placeholder: "C:\\Users\\you\\code", "aria-label": "Folder to add" });
    const editor = h("input", { class: "input", id: "cfg-editor", value: config.editor });
    const github = h("input", { class: "input", id: "cfg-github", value: config.githubUser ?? "", placeholder: "Guessed from your repos" });
    const depth = h("select", { id: "cfg-depth" }, [1, 2, 3].map((d) => h("option", { value: d, selected: d === config.scanDepth }, d === 1 ? "Only the folders inside" : `${d} levels deep`)));
    const activityOn = h("input", { type: "checkbox", id: "cfg-activity", checked: config.activity !== false });
    const localhostOn = h("input", { type: "checkbox", id: "cfg-localhost", checked: config.localhostRecording !== false });
    const activityDays = h("select", { id: "cfg-activity-days" }, [1, 3, 7, 14, 30, 90].map((d) => h("option", { value: d, selected: d === (config.activityDays ?? 7) }, plural(d, "day"))));
    const activityMax = h("select", { id: "cfg-activity-max" }, [100, 250, 500, 1000, 2000, 5000].map((mb) => h("option", { value: mb, selected: mb === (config.activityMaxMB ?? 500) }, mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`)));
    const activityUse = h("span", { class: "field-hint" });
    api("/api/activity/usage")
      .then((u) => activityUse.replaceChildren(u.bytes ? `Now ${formatBytes(u.bytes)}${u.projects.length > 1 ? ` across ${plural(u.projects.length, "project")}` : ""}. The oldest days go first when it's full.` : "Nothing recorded yet."))
      .catch(() => {});
    const save = btn("Save settings", null, { kind: "primary", type: "submit" });

    const settings = h(
      "form",
      {
        class: "card card-pad section",
        onsubmit: async (e) => {
          e.preventDefault();
          const body = { editor: editor.value, githubUser: github.value, scanDepth: Number(depth.value), activity: activityOn.checked, localhostRecording: localhostOn.checked, activityDays: Number(activityDays.value), activityMaxMB: Number(activityMax.value) };
          const r = await busy(save, "Saving…", () => api("/api/config", { method: "POST", body }));
          if (r) toast("Settings saved");
        },
      },
      h("h2", { class: "section-title" }, "Settings"),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field-label" }, "Projects folders"),
        h(
          "div",
          { class: "chips" },
          config.projectsRoots.map((r) =>
            h("span", { class: "chip" }, tildify(r), h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Remove ${r}`, title: "Remove", onclick: () => updateRoots({ removeRoot: r }) }, icon("x"))),
          ),
        ),
        h("div", { class: "toolbar" }, newRoot, btn("Add folder", () => newRoot.value.trim() && updateRoots({ addRoot: newRoot.value }), { iconName: "new" })),
      ),
      h(
        "div",
        { class: "form-grid" },
        h("label", { class: "field", for: "cfg-editor" }, h("span", { class: "field-label" }, "Editor command"), editor, h("span", { class: "field-hint" }, "code, cursor, or a full path in quotes")),
        h("label", { class: "field", for: "cfg-github" }, h("span", { class: "field-label" }, "GitHub username"), github, h("span", { class: "field-hint" }, "For pull requests in the summary")),
        h("label", { class: "field", for: "cfg-depth" }, h("span", { class: "field-label" }, "Look for projects"), depth),
        terminalSelect({ withLabel: true }),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Activity history"),
          h("label", { class: "check", for: "cfg-activity" }, activityOn, "Keep a history of requests, routes, clicks, console and errors"),
          h("label", { class: "check", for: "cfg-localhost" }, localhostOn, "Record apps at localhost:<port> too (dx answers there and moves the dev server)"),
          h("label", { class: "toolbar", for: "cfg-activity-days" }, h("span", { class: "field-hint" }, "Keep it for"), activityDays),
          h("label", { class: "toolbar", for: "cfg-activity-max" }, h("span", { class: "field-hint" }, "At most"), activityMax),
          activityUse,
        ),
      ),
      h("div", { class: "form-actions" }, save),
    );

    const runs = data.runs.length
      ? h(
          "div",
          { class: "card table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Tool"), h("th", null, "From"), h("th", null, "Result"), h("th", null, "Detail"))),
            h(
              "tbody",
              null,
              data.runs.map((r) =>
                h("tr", null, h("td", { class: "dim" }, relativeTime(Date.parse(r.at))), h("td", { class: "mono" }, r.tool), h("td", { class: "dim" }, r.source ?? "cli"), h("td", null, r.ok ? h("span", { class: "badge badge-ok" }, "ok") : h("span", { class: "badge badge-danger" }, "failed")), h("td", { class: "cmd", title: r.detail ?? "" }, r.detail ?? "")),
              ),
            ),
          ),
        )
      : h("div", { class: "card" }, stateView("Nothing run yet", "Opening projects, killing ports and other things dx does show up here."));

    holder.replaceChildren(
      h("section", { class: "section" }, h("h2", { class: "section-title" }, "Checks"), checks),
      h(
        "section",
        { class: "section" },
        h("h2", { class: "section-title" }, "AI tools"),
        h("p", { class: "page-sub" }, "Connected tools can run your apps, read their output and errors, and check pages through dx. dx connects new ones by itself."),
        aiTools,
      ),
      settings,
      h("section", { class: "section" }, h("h2", { class: "section-title" }, "Recent runs"), runs),
    );
  }

  async function loadAiTools(holderEl) {
    let tools;
    try {
      tools = await api("/api/ai-tools");
    } catch (err) {
      holderEl.replaceChildren(errorView(err, () => loadAiTools(holderEl)));
      return;
    }
    const act = (button, path, ids, label) =>
      busy(button, label, async () => {
        const results = await api(path, { method: "POST", body: { ids } });
        for (const r of results) toast(`${r.name}: ${r.message}`, r.ok ? "ok" : "error");
        await loadAiTools(holderEl);
      });
    const state = (t) =>
      !t.installed && !t.connected
        ? ["", "–", "Not installed"]
        : t.connected && t.current
          ? ["status-ok", "✓", "Connected"]
          : t.connected
            ? ["status-warn", "!", "Points at an old copy of dx"]
            : ["status-warn", "!", "Not connected"];
    holderEl.replaceChildren(
      h(
        "ul",
        { class: "checks checks-actions card" },
        tools.map((t) => {
          const [cls, sym, text] = state(t);
          return h(
            "li",
            null,
            h("span", { class: cls, "aria-hidden": "true" }, sym),
            h("strong", null, t.name),
            h("span", { class: "dim" }, text, t.connected && t.current && t.note ? h("span", { class: "check-fix" }, t.note) : null),
            t.connected && t.current
              ? btn("Disconnect", (e) => act(e.currentTarget, "/api/ai-tools/disconnect", [t.id], "Disconnecting…"), { small: true, kind: "ghost", name: `Disconnect ${t.name}` })
              : t.installed || t.connected
                ? btn(t.connected ? "Update" : "Connect", (e) => act(e.currentTarget, "/api/ai-tools/connect", [t.id], "Connecting…"), { small: true, kind: "primary", name: `Connect ${t.name}` })
                : h("span"),
          );
        }),
      ),
    );
  }

  async function updateRoots(body) {
    try {
      await api("/api/config", { method: "POST", body });
      toast(body.addRoot ? "Folder added" : "Folder removed");
      load();
    } catch (err) {
      toast(err.message, "error");
    }
  }
  load();
}

// ------------------------------------------------------------------ start

const themeSelect = document.getElementById("theme");
function applyTheme(value) {
  if (value === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", value);
}
themeSelect.value = pref("theme", "auto");
applyTheme(themeSelect.value);
themeSelect.addEventListener("change", () => (applyTheme(themeSelect.value), setPref("theme", themeSelect.value)));

window.addEventListener("hashchange", route);
setInterval(updateRunningCount, 5000);
route();
