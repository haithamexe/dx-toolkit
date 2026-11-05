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
  machine: "M3 5h18v11H3zM8 20h8M12 16v4",
  requests: "M4 8h13l-4-4M20 16H7l4 4",
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
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  fix: "M4 20L14 10M14 4v2M14 14v2M8 7H6M22 7h-2M18.5 3.5l-1.4 1.4M18.5 10.5l-1.4-1.4M10.9 3.5l1.4 1.4",
  ai: "M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  image: "M4 5h16v14H4zM4 16l4.5-4.5 4 4 3-3L20 17M15.5 9.5h.01",
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

function toast(message, kind = "ok", { ms } = {}) {
  const el = h("div", { class: `toast ${kind === "error" ? "toast-error" : ""}` }, h("div", null, message));
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), ms ?? (kind === "error" ? 9000 : 4500));
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

/** "Mocked: 12 endpoints" while a project's mock mode is on, so a front end answered by dx isn't mistaken for the real API. */
function mockBadge(m, dir) {
  if (!m?.on) return null;
  return h(
    "a",
    { class: "badge badge-warn", href: "#/activity", onclick: () => dir && setPref("activitySel", `p:${dir}`), title: `Its API calls are answered by dx from recordings${m.strict ? "; others get a 404" : ""}. Turn it off on the Activity page or with dx mock off.` },
    `Mocked: ${plural(m.enabled, "endpoint")}`,
  );
}

/** Saves data as a .json file through the browser's own download, from this page's script (a Blob, no server address). */
function downloadJson(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

// ------------------------------------------------------------------ Ask Claude to fix

/**
 * An error goes to Claude Code with the code around it, only on the button, and its patch comes
 * back to review: Visual side by side or Raw, then Apply fix, Ask again or Dismiss. The server
 * looks the error up and keeps the patch itself; nothing changes in your files until Apply.
 */
let fixCheck;
function claudeCanFix() {
  if (!fixCheck || Date.now() - fixCheck.at > 60_000) fixCheck = { at: Date.now(), ok: api("/api/fix/available").then((r) => !!r.claude, () => false) };
  return fixCheck.ok;
}

const FIX_TITLE =
  "Claude Code (claude -p) looks at this error and the code around it, and proposes a patch for you to review. This sends the error, nearby code and your uncommitted changes to your Claude account, and only when you click. Nothing changes in your files until you apply it.";

/** Each error's panel, by "dir|place": it outlives the list redrawing as new output comes in. */
const fixPanels = new Map();

/** The Ask Claude to fix button for one error, and the panel its proposal opens in. */
function fixControls(dir, source, id, label, place = id) {
  const key = `${dir}|${source}|${place}`;
  let state = fixPanels.get(key);
  if (!state) {
    state = { el: h("div", { class: "fix-panel", hidden: true, "aria-live": "polite" }), busy: false };
    fixPanels.set(key, state);
  }
  const button = btn("Ask Claude to fix", () => askClaude(state, dir, source, id), { small: true, kind: "ghost", iconName: "fix", title: FIX_TITLE, name: `Ask Claude to fix: ${label}` });
  button.hidden = true;
  button.disabled = state.busy;
  state.button = button;
  claudeCanFix().then((ok) => (button.hidden = !ok));
  return { button, panel: state.el };
}

async function askClaude(state, dir, source, id) {
  if (state.busy) return;
  state.busy = true;
  if (state.button) state.button.disabled = true;
  const panel = state.el;
  panel.hidden = false;
  panel.replaceChildren(h("div", { class: "fix-busy", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Claude is looking at the error and the code around it…"));
  if (state.id) api("/api/fix/dismiss", { method: "POST", body: { id: state.id } }).catch(() => {});
  state.id = undefined;
  try {
    const r = await api("/api/fix/propose", { method: "POST", body: { dir, source, id } });
    state.id = r.ok ? r.id : undefined;
    drawFix(state, dir, source, id, r);
  } catch (err) {
    panel.replaceChildren(errorView(err, () => askClaude(state, dir, source, id)), h("div", { class: "toolbar" }, btn("Dismiss", () => closeFix(state), { small: true, kind: "ghost", iconName: "x" })));
  } finally {
    state.busy = false;
    if (state.button) state.button.disabled = false;
  }
}

function drawFix(state, dir, source, errorId, r) {
  const again = btn("Ask again", () => askClaude(state, dir, source, errorId), { small: true, iconName: "refresh", title: "Ask Claude for another patch. This sends the error and the code again." });
  const dismiss = btn("Dismiss", () => closeFix(state), { small: true, kind: "ghost", iconName: "x" });
  const explanation = r.explanation ? h("p", { class: "fix-explanation" }, r.explanation) : null;
  if (!r.ok) {
    state.el.replaceChildren(
      h("div", { class: "fix-head" }, icon("fix"), h("strong", null, "Claude's answer can't be applied")),
      h("div", { class: "note note-warn" }, icon("warn"), h("p", null, r.reason)),
      explanation,
      h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "Claude's answer, as it said it"), copyButton(r.answer)), h("pre", { class: "log-snippet raw-text" }, r.answer)),
      h("div", { class: "toolbar" }, again, dismiss),
    );
    return;
  }
  const apply = btn("Apply fix", (ev) => applyClaudeFix(ev.currentTarget, state, dir, r), {
    kind: "primary",
    small: true,
    iconName: "check",
    title: "Write the patch into your files. It shows on the Git page as changes, and Undo puts the files back.",
  });
  state.el.replaceChildren(
    h("div", { class: "fix-head" }, icon("fix"), h("strong", null, "Claude's fix"), h("span", { class: "dim mono fix-files" }, r.files.join(", "))),
    explanation,
    liveDetail(diffBlock(r.patch)),
    h("div", { class: "toolbar" }, apply, again, dismiss),
    h("p", { class: "dim fix-hint" }, "Nothing has changed in your files yet. Applied, the fix shows on the Git page as changes you can stage, commit or undo."),
  );
}

async function applyClaudeFix(button, state, dir, r) {
  const done = await busy(button, "Applying…", () => api("/api/fix/apply", { method: "POST", body: { dir, id: r.id } }));
  if (!done) return;
  state.id = undefined;
  const gitLink = () => h("a", { href: `#/git?dir=${encodeURIComponent(dir)}` }, "review it on the Git page");
  const undo = () => btn("Undo", (ev) => undoClaudeFix(ev.currentTarget, state, dir, done.undoId), { small: true, kind: "ghost", iconName: "left", title: "Put the files back as they were before the fix" });
  state.el.replaceChildren(
    h("div", { class: "note note-ok" }, icon("check"), h("p", null, `The fix is in ${done.files.join(", ")}: `, gitLink(), ".")),
    h("div", { class: "toolbar" }, undo(), btn("Close", () => closeFix(state), { small: true, kind: "ghost", iconName: "x" })),
  );
  toast(h("span", { class: "toast-line" }, h("span", null, "The fix is in your files: ", gitLink(), "."), undo()), "ok", { ms: 10_000 });
}

async function undoClaudeFix(button, state, dir, undoId) {
  const r = await busy(button, "Undoing…", () => api("/api/git/action", { method: "POST", body: { dir, action: "undo", id: undoId } }));
  if (!r) return;
  toast(r.message);
  closeFix(state);
}

function closeFix(state) {
  if (state.id) api("/api/fix/dismiss", { method: "POST", body: { id: state.id } }).catch(() => {});
  state.id = undefined;
  state.el.hidden = true;
  state.el.replaceChildren();
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
  { id: "machine", label: "Machine", icon: "machine", render: machinePage },
  { id: "git", label: "Git", icon: "git", render: gitPage },
  { id: "activity", label: "Activity", icon: "activity", render: activityPage },
  { id: "requests", label: "Requests", icon: "requests", render: requestsPage },
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
  let focusDir = new URLSearchParams(location.hash.split("?")[1] ?? "").get("dir") ?? "";
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
      // Snapshots (a project as it was at a commit) show here while their dev server is around.
      const [list, snaps] = await Promise.all([api("/api/projects"), api("/api/snapshots").catch(() => [])]);
      projects = [...list, ...snaps.filter((s) => s.dev).map((s) => ({ name: s.name, dir: s.dir, snapshot: s, dev: s.dev }))];
      renderList();
      renderDev();
      // Linked from the AI lane (#/projects?dir=…): bring that server's card into view, once.
      if (focusDir) {
        const card = [...devSection.querySelectorAll("article.dev")].find((el) => el.dataset.dir?.toLowerCase() === focusDir.toLowerCase());
        focusDir = "";
        if (card) {
          card.scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "auto" : "smooth" });
          card.classList.add("dev-linked");
          setTimeout(() => card.classList.remove("dev-linked"), 2000);
        }
      }
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
    const own = projects.filter((p) => !p.snapshot);
    const list = query ? own.filter((p) => p.name.toLowerCase().includes(query) || p.dir.toLowerCase().includes(query)) : own;
    if (own.length === 0) {
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
          mockBadge(p.mocks, p.dir),
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

  /**
   * Getting it ready before it runs: the steps that had something to do (install, .env, Docker,
   * migrations…), while starting or when one failed; later, only the ones worth a look.
   */
  function prepareList(s) {
    const steps = (s.prepare ?? []).filter((x) => x.status !== "ok");
    const attention = steps.filter((x) => x.status === "warn" || x.status === "skip" || x.status === "failed");
    const shown = s.status === "starting" || s.status === "failed" ? steps : attention;
    if (!shown.length) return null;
    const mark = {
      running: () => h("span", { class: "spinner", "aria-hidden": "true" }),
      done: () => icon("check"),
      failed: () => icon("x"),
      warn: () => icon("warn"),
      skip: () => icon("info"),
      todo: () => h("span", { class: "prepare-dot", "aria-hidden": "true" }),
    };
    const words = { running: "running", done: "done", failed: "failed", warn: "needs a look", skip: "skipped", todo: "to do" };
    return h(
      "ul",
      { class: "prepare-list", "aria-label": `Getting ${s.project} ready` },
      shown.map((x) =>
        h(
          "li",
          { class: `prepare-step prepare-${x.status}` },
          (mark[x.status] ?? mark.todo)(),
          h(
            "div",
            null,
            h("span", { class: "visually-hidden" }, `${words[x.status] ?? x.status}: `),
            h("strong", null, x.title),
            h("span", { class: "dim" }, ` · ${x.why}`),
            x.status === "failed" && x.output ? h("code", { class: "prepare-output" }, x.output) : null,
            (x.status === "failed" || x.status === "warn" || x.status === "skip") && x.fix ? h("div", { class: "prepare-fix" }, x.fix) : null,
          ),
        ),
      ),
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
      { class: "card dev", dataset: { dir: s.dir } },
      h(
        "div",
        { class: "dev-head" },
        h(
          "div",
          { class: "dev-title" },
          h("strong", null, s.snapshot ? s.project.replace("@", " @ ") : s.project),
          s.snapshot ? h("span", { class: "badge badge-accent", title: "The project as it was at a commit, run from its own folder in ~/.dx/snapshots" }, "snapshot") : null,
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
          live && s.startedBy === "ai"
            ? btn("Take over", (e) => takeOverServer(e.currentTarget, s, load), { iconName: "user", small: true, title: "Make this server yours: it's labelled as started from the dashboard and keeps running after the agent is done" })
            : null,
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
          s.snapshot
            ? btn("Remove", async (e) => {
                const snap = projects.find((p) => p.dir === s.dir)?.snapshot;
                if (snap && (await removeSnapshotFlow(snap, e.currentTarget))) {
                  logState.delete(key);
                  load();
                  void updateRunningCount();
                }
              }, { iconName: "cleanup", small: true, kind: "danger-ghost", name: `Remove ${s.project}` })
            : null,
        ),
      ),
      prepareList(s),
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
    // Ask Claude to fix needs git: the patch is checked with it, and Undo brings the files back from it.
    const fixer = projects.find((p) => p.dir === dir)?.hasGit && !e.resolved ? fixControls(dir, "dev", e.id, e.message) : null;
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
      where || fixer
        ? h(
            "div",
            { class: "toolbar dev-error-actions" },
            where
              ? btn(where, (ev) =>
                  busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir, file: e.file, line: e.line, column: e.column } })).message)),
                  { small: true, kind: "ghost", iconName: "code", title: "Open in your editor at this line", name: `Open ${where} in editor` },
                )
              : null,
            fixer?.button,
          )
        : null,
      detail ? h("pre", { class: "log log-snippet" }, detail) : null,
      fixer?.panel,
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
      return dev?.status !== s.status || dev?.errorCount !== s.errorCount || dev?.startedBy !== s.startedBy;
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

// ------------------------------------------------------------------ Requests

/** What another page hands the Requests page: a request to resend, or an endpoint to make a rule for. */
let labDraft = null;
function openLab(dir, tab, draft) {
  labDraft = { dir, tab, draft };
  setPref("labDir", dir);
  setPref("labTab", tab);
  location.hash = "#/requests";
}

const LAB_TABS = [
  ["intercept", "Intercept"],
  ["repeater", "Repeater"],
  ["rules", "Rules"],
  ["api", "API & mocks"],
];
const LAB_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const MOCK_SOURCES = { recorded: "recorded", cache: "cached", spec: "spec example", generated: "made up", ai: "AI" };

/** "name: value" lines ⇄ a header map. */
function headersText(h) {
  return Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
function parseHeadersText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (!line.trim()) continue;
    if (i < 1) throw new Error(`"${line.trim()}" isn't a header: write name: value`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
/** JSON edits as lines: `user.name = "Ada"` sets (a JSON value, or text), `- user.token` removes. */
function jsonEditsText(edits) {
  return (edits ?? []).map((e) => (e.remove ? `- ${e.path}` : `${e.path} = ${JSON.stringify(e.value)}`)).join("\n");
}
function parseJsonEditsText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("-")) {
      out.push({ path: t.slice(1).trim(), remove: true });
      continue;
    }
    const i = t.indexOf("=");
    if (i < 1) throw new Error(`"${t}" isn't a change: write path = value, or - path to remove it`);
    const raw = t.slice(i + 1).trim();
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    out.push({ path: t.slice(0, i).trim(), value });
  }
  return out;
}

function requestsPage(root) {
  let dir = pref("labDir", "");
  let tab = pref("labTab", "repeater");
  if (!LAB_TABS.some(([t]) => t === tab)) tab = "repeater";
  let projects = [];
  let stopped = false;
  let pollTimer = 0;
  const draft = labDraft;
  labDraft = null;
  if (draft) ((dir = draft.dir), (tab = draft.tab));

  const holder = h("div", { class: "section" });
  const projectSelect = h("select", { onchange: (e) => ((dir = e.target.value), setPref("labDir", dir), draw()) });
  const tabs = segmented("Tool", LAB_TABS, tab, (v) => ((tab = v), setPref("labTab", v), draw()));
  tabs.classList.add("segmented-wrap");
  append(
    root,
    pageHead(
      "Requests",
      "Change what your app sends and gets back: hold requests to edit them, resend them, set rules, and give the app an API spec and a mock server of its own.",
      h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Project"), projectSelect),
    ),
    h("div", { class: "card card-pad toolbar" }, tabs),
    holder,
  );

  (async () => {
    try {
      projects = await api("/api/projects");
    } catch (err) {
      holder.replaceChildren(errorView(err));
      return;
    }
    if (!projects.some((p) => p.dir === dir)) dir = projects[0]?.dir ?? "";
    projectSelect.replaceChildren(...projects.map((p) => h("option", { value: p.dir, selected: p.dir === dir }, p.name)));
    draw();
  })();

  function project() {
    return projects.find((p) => p.dir === dir);
  }
  const q = () => `dir=${encodeURIComponent(dir)}`;

  function draw() {
    clearTimeout(pollTimer);
    if (!dir) return holder.replaceChildren(h("div", { class: "card" }, stateView("No projects", "dx looks for projects in your projects folders.")));
    ({ intercept: interceptTab, repeater: repeaterTab, rules: rulesTab, api: apiTab })[tab]();
  }

  // ---------------------------------------------------------------- Intercept

  function interceptTab() {
    const list = h("div", { class: "section", "aria-live": "polite" });
    const editors = new Map(); // id -> card, kept while it's held so typing isn't lost
    const empty = h(
      "div",
      { class: "card" },
      stateView(
        "Nothing is held",
        "A rule with Hold set catches matching requests (or their answers) here, to edit before they go on. Held ones go on by themselves after a minute, so the app never hangs.",
        btn("Make a rule", () => ((tab = "rules"), setPref("labTab", "rules"), tabs.querySelector('[data-v="rules"]')?.click()), { iconName: "new" }),
      ),
    );
    holder.replaceChildren(
      h(
        "div",
        { class: "section-head" },
        h("p", { class: "dim" }, `Requests to ${project()?.name ?? "the project"} that a rule holds. They're kept in memory only, with their real headers and body, so you can edit them.`),
        btn("Send all on", async (ev) => {
          const b = ev.currentTarget;
          const r = await busy(b, "Sending…", () => api("/api/lab/intercept/release", { method: "POST", body: { dir } }));
          if (r) toast(`${plural(r.released, "request")} sent on unchanged`);
        }, { small: true, kind: "ghost" }),
      ),
      list,
    );
    const poll = async () => {
      if (stopped || tab !== "intercept") return;
      try {
        const held = await api(`/api/lab/intercept?${q()}`);
        for (const [id, card] of editors) if (!held.some((x) => x.id === id)) (card.remove(), editors.delete(id));
        for (const item of held) if (!editors.has(item.id)) editors.set(item.id, heldCard(item, () => (editors.get(item.id)?.remove(), editors.delete(item.id))));
        if (!held.length) list.replaceChildren(empty);
        else {
          empty.remove();
          for (const card of editors.values()) if (!card.isConnected) list.append(card);
        }
        for (const card of editors.values()) card.tick?.();
      } catch {
        // the next poll tries again
      }
      pollTimer = setTimeout(poll, 1000);
    };
    poll();
  }

  function heldCard(item, gone) {
    const isReq = item.phase === "request";
    const method = h("select", { "aria-label": "Method", disabled: !isReq }, LAB_METHODS.map((m) => h("option", { selected: m === item.method }, m)));
    const url = h("input", { class: "input input-wide mono", value: item.url, "aria-label": "Address", disabled: !isReq });
    const status = h("input", { class: "input lab-status", type: "number", min: 100, max: 599, value: item.status ?? "", "aria-label": "Status" });
    const headers = h("textarea", { class: "input lab-text mono", rows: 6, "aria-label": "Headers, one name: value per line" });
    headers.value = headersText(item.headers);
    const body = h("textarea", { class: "input lab-text mono", rows: 8, "aria-label": "Body", disabled: !!item.binary });
    body.value = item.binary ? "(not text: it can be sent on or dropped, not edited)" : item.body;
    const left = h("span", { class: "dim" });
    const send = async (button, action, edited) => {
      let payload = { id: item.id, action };
      if (edited) {
        try {
          payload = { ...payload, headers: parseHeadersText(headers.value), ...(item.binary ? {} : { body: body.value }) };
        } catch (err) {
          return toast(err.message, "error");
        }
        if (isReq) payload = { ...payload, method: method.value, url: url.value };
        else if (status.value) payload.status = Number(status.value);
      }
      const r = await busy(button, action === "drop" ? "Dropping…" : "Sending…", () => api("/api/lab/intercept", { method: "POST", body: payload }));
      if (r) (toast(action === "drop" ? "Dropped" : "Sent on"), gone());
    };
    const card = h(
      "div",
      { class: "card card-pad section lab-held" },
      h(
        "div",
        { class: "toolbar" },
        h("span", { class: `badge ${isReq ? "badge-accent" : "badge-warn"}` }, isReq ? "Request" : "Answer"),
        h("strong", { class: "mono" }, `${item.method} ${item.url}`),
        item.service ? h("span", { class: "badge" }, item.service) : null,
        h("span", { class: "dim" }, `held by ${item.rule}`),
        left,
      ),
      h("div", { class: "toolbar" }, isReq ? [method, url] : h("label", { class: "field" }, h("span", { class: "field-label" }, "Status"), status)),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Headers"), headers),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Body"), body),
      h(
        "div",
        { class: "toolbar" },
        btn("Send on as edited", (ev) => send(ev.currentTarget, "forward", true), { kind: "primary", iconName: "play" }),
        btn("Send on unchanged", (ev) => send(ev.currentTarget, "forward", false), { kind: "ghost" }),
        btn("Drop", (ev) => send(ev.currentTarget, "drop", false), { kind: "danger-ghost", iconName: "x", title: "Close the connection: the app gets no answer" }),
      ),
    );
    card.tick = () => {
      const s = Math.max(0, Math.round((Date.parse(item.expiresAt) - Date.now()) / 1000));
      left.textContent = s ? `goes on by itself in ${s} s` : "going on…";
    };
    card.tick();
    return card;
  }

  // ---------------------------------------------------------------- Repeater

  function repeaterTab() {
    const start = draft?.tab === "repeater" ? draft.draft : JSON.parse(pref(`labReq:${dir}`, "null") ?? "null") ?? { method: "GET", path: "/", headers: {}, body: "" };
    const method = h("select", { "aria-label": "Method" }, LAB_METHODS.map((m) => h("option", { selected: m === start.method }, m)));
    const path = h("input", { class: "input input-wide mono", value: start.path, "aria-label": "Path on the app, like /api/orders?page=2", placeholder: "/api/orders?page=2" });
    const headers = h("textarea", { class: "input lab-text mono", rows: 5, "aria-label": "Headers, one name: value per line", placeholder: "content-type: application/json" });
    headers.value = headersText(start.headers);
    const body = h("textarea", { class: "input lab-text mono", rows: 8, "aria-label": "Body", placeholder: '{"qty": 2}' });
    body.value = start.body ?? "";
    const hidden = h("div");
    const result = h("div", { class: "section", "aria-live": "polite" });
    const historyList = h("ul", { class: "lab-history" });
    const warnHidden = () => {
      const has = headers.value.includes("•••") || body.value.includes("•••");
      hidden.replaceChildren(
        ...(has ? [h("div", { class: "note note-warn" }, icon("warn"), h("p", null, "Values shown as ••• were hidden by dx when it recorded them (tokens, cookies, passwords). Type the real ones before sending."))] : []),
      );
    };
    headers.addEventListener("input", warnHidden);
    body.addEventListener("input", warnHidden);
    warnHidden();
    const send = async (ev) => {
      const button = ev.currentTarget;
      let hs;
      try {
        hs = parseHeadersText(headers.value);
      } catch (err) {
        return toast(err.message, "error");
      }
      const req = { method: method.value, path: path.value.trim(), headers: hs, body: body.value };
      setPref(`labReq:${dir}`, JSON.stringify({ ...req, headers: Object.fromEntries(Object.entries(hs).filter(([k]) => !/authorization|cookie|token|key/i.test(k))) }));
      const r = await busy(button, "Sending…", () => api("/api/lab/send", { method: "POST", body: { dir, ...req, body: ["GET", "HEAD"].includes(req.method) && !req.body ? undefined : req.body } }));
      if (!r) return;
      showResult(r);
      loadHistory();
    };
    const showResult = (r) => {
      result.replaceChildren(
        ...[
          r.masked ? h("div", { class: "note note-warn" }, icon("warn"), h("p", null, "The body still had a value dx hid (•••), and it went as it is.")) : null,
          h("div", { class: "card card-pad" }, requestDetail({ ...r, url: r.path, type: "request" }, { current: r.responseBody ? "response" : undefined })),
        ].filter(Boolean),
      );
    };
    const loadHistory = async () => {
      try {
        const list = await api(`/api/lab/history?${q()}`);
        historyList.replaceChildren(
          ...list.slice(0, 20).map((x) =>
            h(
              "li",
              null,
              h(
                "button",
                {
                  type: "button",
                  class: "lab-history-row",
                  title: "Load it into the form (hidden values stay hidden: type them again)",
                  onclick: () => {
                    method.value = x.method;
                    path.value = x.path;
                    headers.value = headersText(x.requestHeaders);
                    body.value = x.requestBody ?? "";
                    warnHidden();
                    showResult(x);
                  },
                },
                h("span", { class: "mono" }, x.method),
                h("span", { class: `badge ${x.error || x.status >= 400 ? "badge-danger" : "badge-ok"}` }, x.error ? "failed" : String(x.status)),
                h("span", { class: "mono lab-history-path" }, x.path),
                h("span", { class: "dim" }, `${x.ms} ms · ${relativeTime(Date.parse(x.at))}`),
              ),
            ),
          ),
        );
        if (!list.length) historyList.replaceChildren(h("li", { class: "dim" }, "What you send shows here, for this dashboard session."));
      } catch {
        // shown when sending
      }
    };
    holder.replaceChildren(
      h(
        "form",
        { class: "card card-pad section", onsubmit: (e) => (e.preventDefault(), send({ currentTarget: e.submitter ?? e.target.querySelector("button[type=submit]") })) },
        h("p", { class: "dim" }, `Sent to ${project()?.name ?? "the project"}'s dev server, the one dx runs, without rules or mocks: what you send is what it gets. Start it from the Projects page first.`),
        h("div", { class: "toolbar" }, method, path, btn("Send", null, { kind: "primary", iconName: "play", type: "submit" })),
        hidden,
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Headers"), headers),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Body"), body),
      ),
      result,
      h("section", { class: "section", "aria-labelledby": "lab-history-title" }, h("h2", { class: "section-title", id: "lab-history-title" }, "Sent"), h("div", { class: "card" }, historyList)),
    );
    loadHistory();
  }

  // ---------------------------------------------------------------- Rules

  function rulesTab() {
    const list = h("div", { class: "card" }, loadingView("Reading the rules…"));
    const editor = h("div");
    holder.replaceChildren(
      h(
        "div",
        { class: "section-head" },
        h("p", { class: "dim" }, "Rules change requests to the dev server and its answers as they pass through dx (at the project's .localhost address, or the address dx records). Mocked calls don't reach them."),
        btn("New rule", () => edit({ on: true, method: draft?.draft?.method ?? "GET", path: draft?.draft?.path ?? "/api/" }), { kind: "primary", iconName: "new" }),
      ),
      editor,
      list,
    );
    const load = async () => {
      try {
        const rules = await api(`/api/lab/rules?${q()}`);
        if (!rules.length) return list.replaceChildren(stateView("No rules yet", "A rule can change a header or a JSON field, replace a body, change a status, add a delay, make a call fail, or hold it in Intercept."));
        list.replaceChildren(
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, h("th", { scope: "col" }, "On"), h("th", { scope: "col" }, "Rule"), h("th", { scope: "col" }, "Does"), h("th", { scope: "col", class: "num" }, "Matched"), h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")))),
              h("tbody", null, rules.map((r) => ruleRow(r, load))),
            ),
          ),
        );
      } catch (err) {
        list.replaceChildren(errorView(err, load));
      }
    };
    const edit = (r) => {
      editor.replaceChildren(ruleEditor(r, () => (editor.replaceChildren(), load())));
      editor.querySelector("input")?.focus();
    };
    rulesTab.edit = edit;
    if (draft?.tab === "rules") edit({ on: true, method: draft.draft.method, path: draft.draft.path, name: "" });
    load();
  }

  function ruleSummary(r) {
    const out = [];
    if (r.request?.setHeaders || r.request?.removeHeaders) out.push("request headers");
    if (r.request?.json) out.push(`request: ${r.request.json.map((j) => j.path).join(", ")}`);
    if (r.request?.body !== undefined) out.push("request body replaced");
    if (r.response?.status) out.push(`status ${r.response.status}`);
    if (r.response?.setHeaders || r.response?.removeHeaders) out.push("answer headers");
    if (r.response?.json) out.push(`answer: ${r.response.json.map((j) => j.path).join(", ")}`);
    if (r.response?.body !== undefined) out.push("answer body replaced");
    if (r.delayMs) out.push(`${r.delayMs} ms slower`);
    if (r.fail) out.push({ 500: "fails with 500", timeout: "never answers", drop: "connection dropped" }[r.fail]);
    if (r.intercept) out.push({ request: "holds the request", response: "holds the answer", both: "holds both" }[r.intercept]);
    return out;
  }

  function ruleRow(r, reload) {
    const toggle = h("input", {
      type: "checkbox",
      checked: r.on,
      "aria-label": `${r.name} on`,
      onchange: async (e) => {
        const box = e.currentTarget;
        try {
          await api("/api/lab/rules", { method: "POST", body: { dir, rule: { ...r, on: box.checked } } });
          toast(`${r.name} ${box.checked ? "on" : "off"}`);
        } catch (err) {
          box.checked = !box.checked;
          toast(err.message, "error");
        }
      },
    });
    return h(
      "tr",
      null,
      h("td", null, toggle),
      h("td", null, h("strong", null, r.name), h("div", { class: "dim mono" }, `${r.method === "*" ? "any" : r.method} ${r.path}${r.service ? ` · ${r.service}` : ""}`)),
      h("td", null, h("div", { class: "machine-badges" }, ruleSummary(r).map((s) => h("span", { class: `badge ${/fails|never|dropped/.test(s) ? "badge-danger" : /holds/.test(s) ? "badge-warn" : ""}` }, s)))),
      h("td", { class: "num" }, r.hits),
      h(
        "td",
        { class: "actions" },
        btn("Edit", () => rulesTab.edit(r), { small: true, kind: "ghost" }),
        btn("Delete", async (ev) => {
          const b = ev.currentTarget;
          if (!(await confirmDialog({ title: `Delete the rule ${r.name}?`, text: "Requests to its endpoint pass through unchanged again.", confirm: "Delete" }))) return;
          const ok = await busy(b, "Deleting…", () => api("/api/lab/rules/remove", { method: "POST", body: { dir, id: r.id } }));
          if (ok) reload();
        }, { small: true, kind: "danger-ghost", iconName: "x" }),
      ),
    );
  }

  function ruleEditor(r, done) {
    const field = (label, control, hint) => h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("span", { class: "field-hint" }, hint) : null);
    const text = (value, rows = 3, placeholder = "") => {
      const t = h("textarea", { class: "input lab-text mono", rows, placeholder });
      t.value = value ?? "";
      return t;
    };
    const name = h("input", { class: "input", value: r.name ?? "", placeholder: "Empty cart" });
    const method = h("select", null, ["*", ...LAB_METHODS].map((m) => h("option", { value: m, selected: m === (r.method ?? "*") }, m === "*" ? "Any method" : m)));
    const path = h("input", { class: "input input-wide mono", value: r.path ?? "/api/", placeholder: "/api/orders/*" });
    const reqSet = text(headersText(r.request?.setHeaders), 2, "x-role: admin");
    const reqRemove = h("input", { class: "input mono", value: (r.request?.removeHeaders ?? []).join(", "), placeholder: "authorization, cookie" });
    const reqJson = text(jsonEditsText(r.request?.json), 3, 'items.0.qty = 5\n- user.token');
    const reqBody = text(r.request?.body, 3, "Leave empty to keep the body");
    const status = h("input", { class: "input lab-status", type: "number", min: 100, max: 599, value: r.response?.status ?? "", placeholder: "200" });
    const resSet = text(headersText(r.response?.setHeaders), 2, "cache-control: no-store");
    const resRemove = h("input", { class: "input mono", value: (r.response?.removeHeaders ?? []).join(", ") });
    const resJson = text(jsonEditsText(r.response?.json), 3, "items = []\ntotal = 0");
    const resBody = text(r.response?.body, 3, "Leave empty to keep the body");
    const delay = h("input", { class: "input lab-status", type: "number", min: 0, max: 30000, step: 100, value: r.delayMs ?? "", placeholder: "0" });
    const fail = h("select", null, [["", "Answer"], ["500", "Fail with 500"], ["timeout", "Never answer"], ["drop", "Drop the connection"]].map(([v, t]) => h("option", { value: v, selected: v === (r.fail ?? "") }, t)));
    const hold = h("select", null, [["", "Don't hold"], ["request", "The request"], ["response", "The answer"], ["both", "Both"]].map(([v, t]) => h("option", { value: v, selected: v === (r.intercept ?? "") }, t)));
    const save = async (ev) => {
      const b = ev.currentTarget;
      let rule;
      try {
        const edits = (set, remove, json, body) => {
          const e = {};
          const s = parseHeadersText(set.value);
          if (Object.keys(s).length) e.setHeaders = s;
          const rm = remove.value.split(",").map((x) => x.trim()).filter(Boolean);
          if (rm.length) e.removeHeaders = rm;
          const j = parseJsonEditsText(json.value);
          if (j.length) e.json = j;
          if (body.value) e.body = body.value;
          return Object.keys(e).length ? e : undefined;
        };
        const response = edits(resSet, resRemove, resJson, resBody);
        rule = {
          id: r.id,
          on: r.on ?? true,
          name: name.value.trim(),
          method: method.value,
          path: path.value.trim(),
          service: r.service,
          request: edits(reqSet, reqRemove, reqJson, reqBody),
          response: status.value ? { ...(response ?? {}), status: Number(status.value) } : response,
          delayMs: delay.value ? Number(delay.value) : undefined,
          fail: fail.value || undefined,
          intercept: hold.value || undefined,
        };
      } catch (err) {
        return toast(err.message, "error");
      }
      const saved = await busy(b, "Saving…", () => api("/api/lab/rules", { method: "POST", body: { dir, rule } }));
      if (saved) (toast(`Rule ${saved.name} saved`), done());
    };
    return h(
      "div",
      { class: "card card-pad section lab-rule" },
      h("h2", { class: "section-title" }, r.id ? `Edit ${r.name}` : "New rule"),
      h("div", { class: "lab-grid" }, field("Name", name), field("Method", method), field("Path", path, "* is one part, ** any number, ?key=value matches a query")),
      h("fieldset", { class: "lab-set" }, h("legend", null, "Request"), h("div", { class: "lab-grid" }, field("Set headers", reqSet, "name: value per line"), field("Remove headers", reqRemove, "comma-separated")), field("Change JSON fields", reqJson, "path = value per line; - path removes it"), field("Replace the body", reqBody)),
      h("fieldset", { class: "lab-set" }, h("legend", null, "Answer"), h("div", { class: "lab-grid" }, field("Status", status), field("Set headers", resSet), field("Remove headers", resRemove)), field("Change JSON fields", resJson, "path = value per line; - path removes it"), field("Replace the body", resBody)),
      h("div", { class: "lab-grid" }, field("Delay, ms", delay, "added before it goes on"), field("Then", fail), field("Hold in Intercept", hold, "to edit it by hand")),
      h("div", { class: "toolbar" }, btn("Save rule", save, { kind: "primary", iconName: "save" }), btn("Cancel", () => done(), { kind: "ghost" })),
    );
  }

  // ---------------------------------------------------------------- API & mocks

  function apiTab() {
    const specCard = h("div", { class: "card card-pad section" }, loadingView("Looking for an API spec…"));
    const serverCard = h("div", { class: "card card-pad section" }, loadingView("Reading the mocks…"));
    const mapCard = h("div");
    const endpoints = h("div");
    holder.replaceChildren(specCard, serverCard, mapCard, endpoints);
    let ai = [];
    api("/api/lab/ai").then((x) => ((ai = x), loadMocks())).catch(() => undefined);

    const loadSpec = async () => {
      try {
        const s = await api(`/api/lab/spec?${q()}`);
        drawSpec(s);
      } catch (err) {
        specCard.replaceChildren(errorView(err, loadSpec));
      }
    };
    const useSpec = async (button, body) => {
      const r = await busy(button, "Reading…", () => api("/api/lab/spec", { method: "POST", body: { dir, ...body } }));
      if (r) (toast(`${r.title}: ${plural(r.map.endpoints.length, "endpoint")}`), loadSpec());
    };
    const drawSpec = (s) => {
      if (!s.spec) {
        const paste = h("textarea", { class: "input lab-text mono", rows: 5, placeholder: "openapi: 3.0.3 …  (or the JSON)", "aria-label": "Paste an OpenAPI or Swagger spec" });
        specCard.replaceChildren(
          h("h2", { class: "section-title" }, "API spec"),
          h("p", { class: "dim" }, "An OpenAPI (Swagger) spec maps every endpoint, checks real answers against it, and makes a mock server that answers from the first call."),
          s.files.length
            ? h("div", { class: "section" }, h("p", null, "Found in the project:"), h("div", { class: "toolbar" }, s.files.map((f) => btn(f, (ev) => useSpec(ev.currentTarget, { file: f }), { small: true, iconName: "check" }))))
            : h("p", { class: "dim" }, "No openapi.json, openapi.yaml or swagger file in the project."),
          h(
            "div",
            { class: "toolbar" },
            btn("Read it from the running app", (ev) => useSpec(ev.currentTarget, {}), { small: true, iconName: "external", disabled: !s.running, title: s.running ? `Looks at ${s.urls.slice(0, 4).join(", ")}…` : "Start the project's dev server first" }),
          ),
          h("label", { class: "field" }, h("span", { class: "field-label" }, "Or paste it"), paste),
          h("div", { class: "toolbar" }, btn("Use it", (ev) => paste.value.trim() && useSpec(ev.currentTarget, { text: paste.value }), { small: true })),
        );
        mapCard.replaceChildren();
        return;
      }
      const sp = s.spec;
      const map = sp.map;
      const called = map.endpoints.filter((e) => e.calls).length;
      const issues = map.endpoints.filter((e) => e.issues.length).length;
      specCard.replaceChildren(
        h("div", { class: "section-head" }, h("div", null, h("h2", { class: "section-title" }, `${sp.title} ${sp.version}`), h("p", { class: "dim" }, `${sp.kind} · from ${sp.source.replace(/^file:/, "").replace(/^url:/, "the app at ")}${sp.basePath ? ` · base ${sp.basePath}` : ""}`)), h("div", { class: "toolbar" }, btn("Make mocks from it", async (ev) => {
          const b = ev.currentTarget;
          const r = await busy(b, "Making…", () => api("/api/lab/spec/mocks", { method: "POST", body: { dir } }));
          if (r) (toast(`${plural(r.endpoints, "mock")}: ${r.added} new, ${r.replaced} updated${r.kept ? `, ${r.kept} you edited kept` : ""}`), loadMocks());
        }, { small: true, kind: "primary", iconName: "template" }), btn("Use another spec", async (ev) => {
          const b = ev.currentTarget;
          const ok = await busy(b, "…", () => api("/api/lab/spec/forget", { method: "POST", body: { dir } }));
          if (ok) loadSpec();
        }, { small: true, kind: "ghost" }))),
        h("div", { class: "stats" }, statTile(map.endpoints.length, "endpoints in the spec"), statTile(`${called}`, "called in the last 7 days"), statTile(issues, issues === 1 ? "endpoint answering off-spec" : "endpoints answering off-spec"), statTile(map.undocumented.length, "calls not in the spec")),
      );
      mapCard.replaceChildren(
        h(
          "section",
          { class: "section", "aria-labelledby": "lab-map-title" },
          h("h2", { class: "section-title", id: "lab-map-title" }, "API map"),
          h(
            "div",
            { class: "card table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, h("th", { scope: "col" }, "Endpoint"), h("th", { scope: "col", class: "num" }, "Calls"), h("th", { scope: "col" }, "Answers"), h("th", { scope: "col" }, "Off the spec"))),
              h(
                "tbody",
                null,
                map.endpoints.map((e) =>
                  h(
                    "tr",
                    null,
                    h("td", null, h("span", { class: "mono" }, `${e.method} ${e.path}`), e.summary || e.operationId ? h("div", { class: "dim" }, e.summary ?? e.operationId) : null),
                    h("td", { class: "num" }, e.calls || h("span", { class: "dim" }, "never")),
                    h("td", null, h("div", { class: "machine-badges" }, e.statuses.map((st) => h("span", { class: `badge ${st >= 400 ? "badge-danger" : "badge-ok"}` }, String(st))))),
                    h("td", null, e.issues.length ? h("ul", { class: "lab-issues" }, e.issues.map((i) => h("li", null, i))) : e.calls ? h("span", { class: "badge badge-ok" }, "fits") : null),
                  ),
                ),
              ),
            ),
          ),
          map.undocumented.length
            ? h("div", { class: "card card-pad" }, h("p", null, h("strong", null, "Called, but not in the spec")), h("ul", { class: "lab-issues" }, map.undocumented.map((u) => h("li", { class: "mono" }, `${u.method} ${u.path} · ${plural(u.calls, "call")}${u.lastStatus ? ` · last ${u.lastStatus}` : ""}`))))
            : null,
        ),
      );
    };

    const loadMocks = async () => {
      try {
        const m = await api(`/api/mocks?${q()}`);
        drawMocks(m);
      } catch (err) {
        serverCard.replaceChildren(errorView(err, loadMocks));
      }
    };
    const mode = async (button, body, label) => {
      const r = await busy(button, "…", () => api("/api/mocks/mode", { method: "POST", body: { dir, ...body } }));
      if (r) (toast(label(r)), loadMocks());
    };
    const drawMocks = (m) => {
      serverCard.replaceChildren();
      const bySource = {};
      for (const e of m.endpoints) bySource[e.source ?? "recorded"] = (bySource[e.source ?? "recorded"] ?? 0) + 1;
      const s = m.server;
      append(
        serverCard,
        h(
          "div",
          { class: "section-head" },
          h("div", null, h("h2", { class: "section-title" }, "Mock server"), h("p", { class: "dim" }, "The project's mocks at an address of their own: they answer from the first call, with or without the dev server, like a Postman mock server.")),
          btn(s ? "Stop" : "Start the mock server", async (ev) => {
            const b = ev.currentTarget;
            const r = await busy(b, "…", () => api("/api/mocks/server", { method: "POST", body: { dir, on: !s } }));
            if (r) (toast(s ? "Mock server stopped" : `Mock server at ${r.url}`), loadMocks());
          }, { kind: s ? "danger-ghost" : "primary", iconName: s ? "stop" : "play", disabled: !s && !m.endpoints.length, title: !m.endpoints.length ? "Make mocks first: from the spec, the cache or the history" : undefined }),
        ),
        s
          ? h(
              "div",
              { class: "section" },
              h("div", { class: "toolbar" }, h("span", { class: "badge badge-ok" }, "Running"), h("a", { class: "mono", href: s.url, target: "_blank", rel: "noreferrer" }, s.url), copyButton(s.url), h("span", { class: "dim" }, "or"), h("span", { class: "mono" }, `http://${s.host}`)),
              h("p", { class: "dim" }, "Pick an answer per request like Postman: the header x-mock-response-code: 404, or x-mock-response-name: <example>. Pages on this computer can call it (CORS); sites elsewhere can't."),
            )
          : null,
        h(
          "div",
          { class: "toolbar" },
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!m.cache, onchange: (e) => mode(e.currentTarget, { cache: e.currentTarget.checked }, (r) => (r.cache ? "Real answers are kept as mocks from now on" : "The cache stopped; what it kept stays")) }), "Keep real answers (cache)"),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!m.on, disabled: !m.endpoints.length, onchange: (e) => mode(e.currentTarget, { on: e.currentTarget.checked }, (r) => (r.on ? "The app's API calls through dx are answered by the mocks" : "API calls go to the dev server again")) }), "Mock mode (answer the app's calls at its .localhost address)"),
        ),
        m.endpoints.length
          ? h(
              "div",
              { class: "toolbar" },
              h("span", { class: "dim" }, `${plural(m.endpoints.length, "mock")}:`),
              Object.entries(bySource).map(([src, n]) =>
                btn(`Purge ${n} ${MOCK_SOURCES[src] ?? src}`, async (ev) => {
                  const b = ev.currentTarget;
                  if (!(await confirmDialog({ title: `Remove the ${plural(n, `${MOCK_SOURCES[src] ?? src} mock`)}?`, text: "They're deleted from the project's mocks, edited ones too. The mock server and mock mode stop answering with them.", confirm: "Purge" }))) return;
                  const r = await busy(b, "Purging…", () => api("/api/mocks/purge", { method: "POST", body: { dir, source: src } }));
                  if (r) (toast(`${plural(r.removed, "mock")} purged`), loadMocks());
                }, { small: true, kind: "danger-ghost", iconName: "cleanup" }),
              ),
            )
          : h("p", { class: "dim" }, "No mocks yet: make them from the API spec above, turn on the cache and use the app, or make them from a visit on the Activity page."),
      );
      drawEndpoints(m);
    };

    const drawEndpoints = (m) => {
      if (!m.endpoints.length) return endpoints.replaceChildren();
      const sorted = [...m.endpoints].sort((a, b) => (a.pattern ?? a.path).localeCompare(b.pattern ?? b.path) || a.method.localeCompare(b.method) || a.status - b.status);
      endpoints.replaceChildren(
        h(
          "section",
          { class: "section", "aria-labelledby": "lab-mocks-title" },
          h("h2", { class: "section-title", id: "lab-mocks-title" }, "Mocks"),
          ai.length ? null : h("p", { class: "dim" }, "Install Claude Code or Codex (and sign in) to have it write realistic data for a mock."),
          h(
            "div",
            { class: "card table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, h("th", { scope: "col" }, "Endpoint"), h("th", { scope: "col" }, "Answer"), h("th", { scope: "col" }, "From"), h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")))),
              h("tbody", null, sorted.flatMap((e) => mockRows(e))),
            ),
          ),
        ),
      );
    };
    const open = new Set();
    const mockRows = (e) => {
      const isOpen = open.has(e.id);
      const main = h(
        "tr",
        null,
        h("td", null, h("span", { class: "mono" }, `${e.method} ${e.pattern ?? e.path}`), e.operation || e.example ? h("div", { class: "dim" }, [e.operation, e.example && `example ${e.example}`].filter(Boolean).join(" · ")) : null),
        h("td", null, h("span", { class: `badge ${e.status >= 400 ? "badge-danger" : "badge-ok"}` }, String(e.status)), e.enabled ? null : h("span", { class: "badge" }, "off"), h("div", { class: "dim mono lab-preview" }, e.preview.slice(0, 120))),
        h("td", null, h("span", { class: `badge ${e.source === "ai" ? "badge-accent" : ""}` }, MOCK_SOURCES[e.source ?? "recorded"]), e.edited ? h("span", { class: "badge" }, "edited") : null),
        h(
          "td",
          { class: "actions" },
          ai.length && /json/i.test(e.contentType) ? btn("Write data", (ev) => aiData(ev.currentTarget, e), { small: true, iconName: "code", title:`${ai[0].name} writes realistic data for this answer, fitting the spec when there is one. Sends the endpoint, its schema and current body to your ${ai[0].name} account.` }) : null,
          btn(isOpen ? "Close" : "Edit", () => (isOpen ? open.delete(e.id) : open.add(e.id), loadMocks()), { small: true, kind: "ghost" }),
        ),
      );
      if (!isOpen) return [main];
      const body = h("textarea", { class: "input lab-text mono", rows: 12, "aria-label": "Body" });
      const status = h("input", { class: "input lab-status", type: "number", value: e.status, "aria-label": "Status" });
      api(`/api/mocks?${q()}&id=${encodeURIComponent(e.id)}`).then((full) => (body.value = full.body)).catch(() => undefined);
      return [
        main,
        h(
          "tr",
          { class: "row-detail" },
          h(
            "td",
            { colspan: "4" },
            h(
              "div",
              { class: "section" },
              h("label", { class: "field" }, h("span", { class: "field-label" }, "Status"), status),
              h("label", { class: "field" }, h("span", { class: "field-label" }, "Body"), body),
              h(
                "div",
                { class: "toolbar" },
                btn("Save", async (ev) => {
                  const b = ev.currentTarget;
                  const r = await busy(b, "Saving…", () => api("/api/mocks/update", { method: "POST", body: { dir, id: e.id, body: body.value, status: Number(status.value) } }));
                  if (r) (toast("Saved"), open.delete(e.id), loadMocks());
                }, { small: true, kind: "primary", iconName: "save" }),
                btn(e.enabled ? "Turn off" : "Turn on", async (ev) => {
                  const b = ev.currentTarget;
                  const r = await busy(b, "…", () => api("/api/mocks/update", { method: "POST", body: { dir, id: e.id, enabled: !e.enabled } }));
                  if (r) loadMocks();
                }, { small: true, kind: "ghost" }),
              ),
            ),
          ),
        ),
      ];
    };
    const aiData = async (button, e) => {
      const note = window.prompt(`Anything ${ai[0].name} should know? (optional, e.g. "12 products, some out of stock")`, "");
      if (note === null) return;
      const r = await busy(button, "Writing…", () => api("/api/mocks/ai", { method: "POST", body: { dir, id: e.id, note, tool: ai[0].tool } }));
      if (!r) return;
      toast(r.issues.length ? `${r.tool} wrote it; off the spec: ${r.issues.join("; ")}` : `${r.tool} wrote new data for ${e.method} ${e.path}`, r.issues.length ? "error" : "ok");
      loadMocks();
    };
    loadSpec();
    loadMocks();
  }

  function statTile(value, label) {
    return h("div", { class: "card stat" }, h("div", { class: "stat-value" }, value), h("div", { class: "stat-label" }, label));
  }

  return () => {
    stopped = true;
    clearTimeout(pollTimer);
  };
}

// ------------------------------------------------------------------ Machine

const TOOL_BADGES = {
  ok: ["badge-ok", "Up to date"],
  update: ["badge-warn", "Update available"],
  ending: ["badge-warn", "Support ends soon"],
  unsupported: ["badge-danger", "No longer supported"],
  unknown: ["", "Not checked"],
};
const TOOL_ORDER = { unsupported: 0, ending: 1, update: 2, unknown: 3, ok: 4 };

const PROCESS_GROUPS = [
  ["server", "Dev servers"],
  ["watcher", "Watchers and test runners"],
  ["other", "Other processes"],
  ["tool", "AI tools and editor helpers"],
  ["dx", "dx"],
];

const DOCKER_PRUNE = {
  containers: ["stopped containers", "Containers that aren't running are removed. Their images stay."],
  images: ["unused images", "Images no container uses are removed, stopped containers' images stay. A project whose images go pulls or builds them again when it next starts, which takes longer once."],
  "build-cache": ["the build cache", "Docker's next build of each project starts from scratch, which takes longer once."],
};

function machinePage(root) {
  let projectsShow = pref("machineProjects", "problems");
  let tools = null;
  let needs = null;
  let processes = null;
  let docker = null;
  const openRows = new Set(); // process PIDs whose details are open
  const stats = h("div", { class: "stats", "aria-live": "polite" });
  const toolsHolder = h("div", { class: "card" }, loadingView("Checking the tools on this computer…"));
  const needsHolder = h("div", { class: "card" }, loadingView("Reading what your projects need…"));
  const processHolder = h("div", { class: "section" }, h("div", { class: "card" }, loadingView("Looking at what's running…")));
  const dockerHolder = h("div", { class: "section" }, h("div", { class: "card" }, loadingView("Asking Docker…")));
  const servicesHolder = h("div", { class: "card" }, loadingView("Looking for database services…"));
  const th = (text, cls) => h("th", { scope: "col", class: cls }, text);
  const hiddenTh = (text) => h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, text));

  append(
    root,
    pageHead(
      "Machine",
      "The tools on this computer, what your projects need from them, and what's running in the background.",
      btn("Check again", (ev) => busy(ev.currentTarget, "Checking…", () => loadAll(true)), { iconName: "refresh", kind: "ghost" }),
    ),
    stats,
    section("machine-tools", "Tools", "Each tool's version, the newest one, and whether yours still gets security fixes. Updates open in a terminal, so you see what runs.", toolsHolder),
    section(
      "machine-projects",
      "Your projects",
      "What each project asks for (.nvmrc, engines, packageManager, lock files, go.mod…) next to what's installed.",
      needsHolder,
      segmented("Show", [["problems", "Needs attention"], ["all", "All projects"]], projectsShow, (v) => {
        projectsShow = v;
        setPref("machineProjects", v);
        if (needs) drawNeeds();
      }),
    ),
    section(
      "machine-processes",
      "Running in the background",
      "Dev servers, watchers and tools that were started on this computer, with the memory and CPU they use now.",
      processHolder,
      btn("Refresh", (ev) => busy(ev.currentTarget, "Refreshing…", loadProcesses), { iconName: "refresh", kind: "ghost", small: true }),
    ),
    section("machine-docker", "Docker", "Containers, and the space Docker keeps on disk.", dockerHolder),
    section("machine-services", "Services", "Databases and Docker installed as services can start with the computer and use memory when no project needs them.", servicesHolder),
  );

  function section(id, title, sub, body, ...actions) {
    return h(
      "section",
      { class: "section", "aria-labelledby": id },
      h("div", { class: "section-head" }, h("div", null, h("h2", { class: "section-title", id }, title), h("p", { class: "dim" }, sub)), actions.length ? h("div", { class: "toolbar" }, actions) : null),
      body,
    );
  }

  function stat(value, label, sub) {
    return h("div", { class: "card stat" }, h("div", { class: "stat-value" }, value), h("div", { class: "stat-label" }, label), sub ? h("div", { class: "stat-label" }, sub) : null);
  }

  function drawStats() {
    const out = [];
    if (tools) {
      const todo = tools.filter((t) => t.installed && TOOL_ORDER[t.status] < 3);
      const unsupported = tools.filter((t) => t.status === "unsupported").length;
      out.push(stat(todo.length, todo.length === 1 ? "tool to update" : "tools to update", unsupported ? `${unsupported} no longer supported` : `of ${tools.filter((t) => t.installed).length} installed`));
    }
    if (needs) {
      const off = needs.filter((p) => p.problems > 0).length;
      out.push(stat(off, off === 1 ? "project that doesn't match" : "projects that don't match", `of ${needs.length}`));
    }
    if (processes) {
      const mine = processes.filter((p) => p.kind !== "dx");
      const left = mine.filter((p) => p.leftBehind).length;
      out.push(stat(left, left === 1 ? "process left behind" : "processes left behind", `${formatBytes(mine.reduce((n, p) => n + p.memory, 0))} used by ${plural(mine.length, "process", "processes")}`));
    }
    if (docker?.running) {
      const free = docker.disk.filter((d) => d.prune).reduce((n, d) => n + d.reclaimableBytes, 0);
      out.push(stat(formatBytes(free), "Docker can free", `${plural(docker.containers.filter((c) => c.state === "running").length, "container")} running`));
    }
    stats.replaceChildren(...out);
  }

  /** A fix: a button that opens it in a terminal, and Copy; advice that isn't a command is only shown. */
  function fixActions(fix, runnable, body, label) {
    if (!fix) return null;
    if (!runnable) return null;
    return h(
      "div",
      { class: "toolbar machine-actions" },
      btn(label.startsWith("Move") || label.startsWith("Update") ? "Update" : "Fix", (ev) => runFix(ev.currentTarget, label, fix, body), { small: true, iconName: "terminal", title: `${label}: ${fix}` }),
      copyButton(fix),
    );
  }

  async function runFix(button, label, fix, body) {
    const yes = await confirmDialog({
      title: `${label}?`,
      text: ["dx opens a terminal and runs:", h("p", { class: "mono" }, fix), "It may ask for your password or for a yes; you answer it there."],
      confirm: "Open terminal",
      danger: false,
    });
    if (!yes) return;
    await busy(button, "Opening…", async () => {
      const r = await api("/api/machine/run", { method: "POST", body });
      toast(`Running in ${r.terminal}. Press Check again when it's done.`);
    });
  }

  // ---- tools

  async function loadTools(refresh) {
    try {
      tools = await api(`/api/machine/tools${refresh ? "?refresh=1" : ""}`);
      drawTools();
    } catch (err) {
      toolsHolder.replaceChildren(errorView(err, () => loadTools(true)));
    }
    drawStats();
  }

  function drawTools() {
    const installed = tools.filter((t) => t.installed).sort((a, b) => TOOL_ORDER[a.status] - TOOL_ORDER[b.status]);
    const missing = tools.filter((t) => !t.installed);
    toolsHolder.replaceChildren(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, th("Tool"), th("Version"), th("Status"), hiddenTh("Actions"))),
          h("tbody", null, installed.map(toolRow)),
        ),
      ),
      missing.length ? h("p", { class: "dim machine-foot" }, `Not installed: ${missing.map((t) => t.name).join(", ")}. A project that needs one says so under Your projects.`) : null,
    );
  }

  function toolRow(t) {
    const [cls, text] = TOOL_BADGES[t.status] ?? TOOL_BADGES.unknown;
    // "24.22.2 is out" repeats the Version column; what's said after it still matters.
    const detail = (t.detail ?? "").replace(/^up to date;?\s*/, "").replace(/^\S+ is out\s*/, "").replace(/^\((.*)\)$/, "$1");
    const label = t.status === "unsupported" && t.newestLine ? `Move ${t.name} to ${t.newestLine}` : `Update ${t.name}`;
    return h(
      "tr",
      null,
      h("td", null, h("strong", null, t.name), t.path ? h("div", { class: "dim mono machine-path", title: t.path }, tildify(t.path)) : null),
      h(
        "td",
        { class: "mono machine-version" },
        t.version,
        t.latest && t.latest !== t.version ? h("span", { class: "dim" }, " → ") : null,
        t.latest && t.latest !== t.version ? h("span", { "aria-label": `newest ${t.latest}` }, t.latest) : null,
      ),
      h(
        "td",
        null,
        h("span", { class: `badge ${cls}` }, text),
        detail ? h("div", { class: "dim" }, detail) : null,
        t.status !== "ok" && t.fix ? h("div", { class: "machine-code" }, t.fix) : null,
      ),
      h("td", { class: "actions" }, t.status !== "ok" ? fixActions(t.fix, t.runnable, { tool: t.id }, label) : null),
    );
  }

  // ---- projects

  async function loadNeeds() {
    try {
      needs = await api("/api/machine/projects");
      drawNeeds();
    } catch (err) {
      needsHolder.replaceChildren(errorView(err, loadNeeds));
    }
    drawStats();
  }

  function drawNeeds() {
    if (!needs.length) {
      needsHolder.replaceChildren(stateView("No projects found", "dx looks for projects in your projects folders.", h("a", { class: "btn", href: "#/health" }, "Add a projects folder")));
      return;
    }
    const shown = needs.filter((p) => projectsShow === "all" || p.problems > 0);
    if (!shown.length) {
      needsHolder.replaceChildren(stateView("Every project matches this computer", `${plural(needs.length, "project")} checked: each one finds the tools and versions it asks for. Pick All projects to see them.`));
      return;
    }
    needsHolder.replaceChildren(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, th("Project"), th("Needs"))),
          h(
            "tbody",
            null,
            shown.map((p) =>
              h(
                "tr",
                null,
                h("td", null, h("strong", null, p.project), h("div", { class: "dim mono machine-path", title: p.dir }, tildify(p.dir))),
                h(
                  "td",
                  null,
                  h(
                    "div",
                    { class: "machine-badges" },
                    p.needs.length ? [...p.needs].sort((a, b) => Number(a.ok) - Number(b.ok)).map((n) => h("span", { class: `badge ${n.ok ? "" : n.problem === "missing" ? "badge-danger" : "badge-warn"}`, title: `From ${n.source}${n.installed ? `; you have ${n.installed}` : ""}` }, n.label)) : h("span", { class: "dim" }, "Nothing it names"),
                  ),
                  p.needs.filter((n) => !n.ok).map((n) =>
                    h(
                      "div",
                      { class: "machine-fix" },
                      h("span", null, n.problem === "missing" ? `${n.label} isn't installed` : `${n.label}, you have ${n.installed}`, h("span", { class: "dim" }, ` (${n.source})`)),
                      n.fix && !n.runnable ? h("span", { class: "dim" }, n.fix) : null,
                      n.fix && n.runnable ? h("span", { class: "machine-code" }, n.fix) : null,
                      fixActions(n.fix, n.runnable, { tool: n.tool, dir: p.dir }, `${n.problem === "missing" ? "Install" : "Switch to"} ${n.label} for ${p.project}`),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---- processes

  async function loadProcesses() {
    try {
      processes = await api("/api/machine/processes");
      drawProcesses();
    } catch (err) {
      processHolder.replaceChildren(h("div", { class: "card" }, errorView(err, loadProcesses)));
    }
    drawStats();
  }

  function drawProcesses() {
    const groups = PROCESS_GROUPS.map(([kind, title]) => [kind, title, processes.filter((p) => p.kind === kind)]).filter(([, , list]) => list.length);
    if (!groups.length) {
      processHolder.replaceChildren(h("div", { class: "card" }, stateView("Nothing running", "No dev servers, watchers or developer tools are running.")));
      return;
    }
    processHolder.replaceChildren(
      ...groups.map(([kind, title, list]) => {
        const memory = list.reduce((n, p) => n + p.memory, 0);
        const left = list.filter((p) => p.leftBehind).length;
        return h(
          "details",
          { class: "card machine-group", open: kind === "server" || kind === "watcher" || left > 0 || undefined },
          h(
            "summary",
            { class: "machine-group-head" },
            h("strong", null, title),
            h("span", { class: "badge" }, String(list.length)),
            left ? h("span", { class: "badge badge-warn" }, `${left} left behind`) : null,
            h("span", { class: "dim" }, formatBytes(memory)),
          ),
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, th("Process"), th("Project"), th("Started", "num"), th("Memory", "num"), th("CPU", "num"), hiddenTh("Actions"))),
              h("tbody", null, list.flatMap(processRows)),
            ),
          ),
        );
      }),
    );
  }

  function processRows(p) {
    const open = openRows.has(p.pid);
    const toggle = () => {
      if (open) openRows.delete(p.pid);
      else openRows.add(p.pid);
      drawProcesses();
    };
    const exposed = p.ports.filter((x) => x.network);
    const main = h(
      "tr",
      null,
      h(
        "td",
        null,
        h("strong", null, p.label),
        p.children.length ? h("span", { class: "dim" }, ` +${plural(p.children.length, "child", "children")}`) : null,
        h(
          "div",
          { class: "machine-badges" },
          p.leftBehind ? h("span", { class: "badge badge-warn", title: "The terminal or program that started it isn't running any more" }, "Left behind") : null,
          p.runByDx ? h("span", { class: "badge badge-accent" }, "Run by dx") : null,
          p.ports.map((x) => h("span", { class: `badge ${x.network ? "badge-warn" : ""}`, title: x.network ? `Listens on ${x.addresses.join(", ")}: other computers on your network can reach it` : `Listens on ${x.addresses.join(", ")}` }, `:${x.port}${x.network ? " open to your network" : ""}`)),
        ),
        h("div", { class: "dim" }, `PID ${p.pid}${p.startedBy ? ` · started by ${p.startedBy}` : ""}`),
      ),
      h("td", null, p.project ?? h("span", { class: "dim" }, "—")),
      h("td", { class: "num" }, p.startedAt ? relativeTime(p.startedAt) : "—"),
      h("td", { class: "num" }, formatBytes(p.memory)),
      h("td", { class: "num" }, p.cpu === undefined || p.cpu === null ? "—" : `${p.cpu}%`),
      h(
        "td",
        { class: "actions" },
        btn(open ? "Hide" : "Details", toggle, { small: true, kind: "ghost", title: `The command line of ${p.label}` }),
        p.kind === "dx"
          ? null
          : p.runByDx
            ? h("a", { class: "btn btn-sm btn-ghost", href: "#/projects" }, "Projects page")
            : btn("Stop", (ev) => stop(ev.currentTarget, p), { kind: "danger-ghost", small: true, iconName: "stop" }),
      ),
    );
    if (!open) return [main];
    return [
      main,
      h(
        "tr",
        { class: "row-detail" },
        h(
          "td",
          { colspan: "6" },
          h(
            "div",
            { class: "section" },
            exposed.length
              ? h(
                  "div",
                  { class: "note note-warn" },
                  icon("warn"),
                  h("p", null, `Other computers on your network can open ${exposed.map((x) => `port ${x.port}`).join(" and ")}. To keep it on this computer, start it listening on 127.0.0.1 only (Vite: leave out --host; Next.js: next dev -H 127.0.0.1).`),
                )
              : null,
            h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "Command line"), copyButton(p.command)), h("pre", { class: "log-snippet raw-text" }, p.command || "—")),
            p.children.length ? h("p", { class: "dim" }, `Child processes: ${p.children.join(", ")}`) : null,
          ),
        ),
      ),
    ];
  }

  async function stop(button, p) {
    const yes = await confirmDialog({
      title: `Stop ${p.label}${p.project ? ` in ${p.project}` : ""}?`,
      text: [
        `PID ${p.pid}${p.children.length ? ` and its ${plural(p.children.length, "child process", "child processes")}` : ""} will be stopped. Anything it hasn't saved is lost.`,
        p.command ? h("p", { class: "mono" }, p.command) : null,
      ].filter(Boolean),
      confirm: "Stop it",
    });
    if (!yes) return;
    await busy(button, "Stopping…", async () => {
      const r = await api("/api/machine/stop", { method: "POST", body: { pid: p.pid } });
      toast(r.message);
      openRows.delete(p.pid);
      await loadProcesses();
    });
  }

  // ---- Docker

  async function loadDocker() {
    try {
      docker = await api("/api/machine/docker");
      drawDocker();
    } catch (err) {
      dockerHolder.replaceChildren(h("div", { class: "card" }, errorView(err, loadDocker)));
    }
    drawStats();
  }

  function drawDocker() {
    if (!docker.installed) {
      dockerHolder.replaceChildren(h("div", { class: "card" }, stateView("Docker isn't installed", "A project with a compose file says so under Your projects.")));
      return;
    }
    if (!docker.running) {
      dockerHolder.replaceChildren(h("div", { class: "card" }, stateView("Docker isn't running", docker.error ?? "Start Docker Desktop, or the docker service, to see its containers and the space it uses.", btn("Check again", (ev) => busy(ev.currentTarget, "Checking…", loadDocker), { small: true, iconName: "refresh" }))));
      return;
    }
    const running = docker.containers.filter((c) => c.state === "running");
    const stopped = docker.containers.filter((c) => c.state !== "running");
    const containerTable = (list) =>
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, th("Container"), th("Image"), th("State"), th("Memory", "num"), th("CPU", "num"), hiddenTh("Actions"))),
          h(
            "tbody",
            null,
            list.map((c) =>
                  h(
                    "tr",
                    null,
                    h("td", null, h("strong", null, c.name), c.composeProject ? h("div", { class: "dim" }, `compose: ${c.composeProject}`) : null, c.ports ? h("div", { class: "dim mono machine-path" }, c.ports) : null),
                    h("td", { class: "mono" }, c.image),
                    h("td", null, h("span", { class: `badge ${c.state === "running" ? "badge-ok" : ""}` }, c.state === "running" ? "Running" : c.state === "exited" ? "Stopped" : c.state), h("div", { class: "dim" }, c.status)),
                    h("td", { class: "num" }, c.memory ?? "—"),
                    h("td", { class: "num" }, c.cpu ?? "—"),
                    h("td", { class: "actions" }, c.state === "running" ? btn("Stop", (ev) => stopContainer(ev.currentTarget, c), { kind: "danger-ghost", small: true, iconName: "stop" }) : null),
                  ),
                ),
              ),
            ),
          );
    dockerHolder.replaceChildren(
      h(
        "div",
        { class: "card" },
        running.length ? containerTable(running) : stateView("No containers running", stopped.length ? `${plural(stopped.length, "stopped container")} below.` : "Docker has no containers."),
      ),
      stopped.length
        ? h(
            "details",
            { class: "card machine-group" },
            h("summary", { class: "machine-group-head" }, h("strong", null, "Stopped containers"), h("span", { class: "badge" }, String(stopped.length)), h("span", { class: "dim" }, "Clean up removes them; their images stay.")),
            containerTable(stopped),
          )
        : null,
      h(
        "div",
        { class: "card table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, th("On disk"), th("Size", "num"), th("Can free", "num"), hiddenTh("Actions"))),
          h(
            "tbody",
            null,
            docker.disk.map((d) =>
              h(
                "tr",
                null,
                h("td", null, h("strong", null, d.type), h("span", { class: "dim" }, ` ${d.count}`), !d.prune && d.type.toLowerCase().includes("volume") ? h("div", { class: "dim" }, "Volumes hold your databases' data: dx never removes them.") : null),
                h("td", { class: "num" }, d.size),
                h("td", { class: "num" }, d.reclaimable),
                h("td", { class: "actions" }, d.prune && d.reclaimableBytes > 0 ? btn("Clean up", (ev) => prune(ev.currentTarget, d), { kind: "danger-ghost", small: true, iconName: "cleanup" }) : null),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function stopContainer(button, c) {
    const yes = await confirmDialog({ title: `Stop ${c.name}?`, text: [`The container stops; its data stays. ${c.composeProject ? `Start it again with docker compose up in ${c.composeProject}, or from the Projects page.` : "Start it again with docker start."}`], confirm: "Stop it" });
    if (!yes) return;
    await busy(button, "Stopping…", async () => {
      const r = await api("/api/machine/docker/stop", { method: "POST", body: { id: c.id } });
      toast(r.message);
      await loadDocker();
    });
  }

  async function prune(button, d) {
    const [what, explain] = DOCKER_PRUNE[d.prune];
    const yes = await confirmDialog({ title: `Remove ${what}?`, text: [`Docker frees about ${d.reclaimable}. ${explain}`, "Volumes, which hold your databases' data, aren't touched."], confirm: "Clean up" });
    if (!yes) return;
    await busy(button, "Cleaning up…", async () => {
      const r = await api("/api/machine/docker/prune", { method: "POST", body: { what: d.prune } });
      toast(r.message);
      await loadDocker();
    });
  }

  // ---- services

  async function loadServices() {
    try {
      const list = await api("/api/machine/services");
      if (!list.length) {
        servicesHolder.replaceChildren(stateView("No database services", "No Postgres, MySQL, Redis, MongoDB or similar is installed as a service on this computer."));
        return;
      }
      const note = list.find((s) => s.note)?.note;
      servicesHolder.replaceChildren(
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", null, h("tr", null, th("Service"), th("State"), th("Starts with the computer"), th("Memory", "num"), th("Commands"))),
            h(
              "tbody",
              null,
              list.map((s) =>
                h(
                  "tr",
                  null,
                  h("td", null, h("strong", null, s.display), s.display !== s.name ? h("div", { class: "dim mono" }, s.name) : null),
                  h("td", null, h("span", { class: `badge ${s.running ? "badge-ok" : ""}` }, s.running ? "Running" : "Stopped")),
                  h("td", null, s.atStartup ? h("span", { class: "badge badge-warn" }, "Yes") : h("span", { class: "dim" }, "No")),
                  h("td", { class: "num" }, s.memory ? formatBytes(s.memory) : "—"),
                  h(
                    "td",
                    null,
                    s.running ? h("div", { class: "machine-fix" }, h("span", { class: "machine-code" }, s.stop), copyButton(s.stop)) : null,
                    s.atStartup ? h("div", { class: "machine-fix" }, h("span", { class: "machine-code" }, s.manual), copyButton(s.manual)) : null,
                    !s.running && !s.atStartup ? h("span", { class: "dim" }, "Nothing to do") : null,
                  ),
                ),
              ),
            ),
          ),
        ),
        h("p", { class: "dim machine-foot" }, `Stopping a service or changing when it starts needs admin rights, so dx gives you the command to run yourself${note ? `, ${note}` : ""}.`),
      );
    } catch (err) {
      servicesHolder.replaceChildren(errorView(err, loadServices));
    }
  }

  function loadAll(refresh) {
    return Promise.all([loadTools(refresh), loadNeeds(), loadProcesses(), loadDocker(), loadServices()]);
  }
  loadAll(false);
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
const MAX_LANES = 10;
const LANE_W = 20;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const GIT_CODES = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", N: "New file" };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** "Octo Cat" → "OC", "octocat" → "OC": what goes in a commit's dot. */
function initials(name) {
  const parts = String(name ?? "").trim().split(/[\s._@-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

/**
 * One commit's slice of the graph, in a 20 × 32 grid per lane: lines from its children above, to
 * its parents below, and the lanes passing by. Every line has pathLength 1, so the stylesheet can
 * draw it in, and data-lane, so hovering can light up a branch's path.
 */
function graphCell(row, lanes, { merge = false, author = "", head = false, look = false } = {}) {
  const w = lanes * LANE_W;
  const svg = svgEl("svg", { class: "graph-cell", viewBox: `0 0 ${w} 32`, width: w, height: 32, "aria-hidden": "true" });
  const x = (lane) => lane * LANE_W + LANE_W / 2;
  const path = (d, lane) => svg.append(svgEl("path", { d, pathLength: 1, class: `graph-line lane-${lane % LANE_COLOURS}`, "data-lane": lane }));
  const curve = (x1, y1, x2, y2) => (x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y1 + (y2 - y1) * 0.75} ${x2} ${y2 - (y2 - y1) * 0.75} ${x2} ${y2}`);
  for (const l of row.through) if (l < lanes) path(`M${x(l)} 0V32`, l);
  // A branch joining the line on its left: straight down to the dot's height, then across.
  for (const [from, to] of row.moves ?? []) if (from < lanes && to < lanes) path(`M${x(from)} 0V14C${x(from)} 26 ${x(to)} 22 ${x(to)} 32`, from);
  for (const l of row.up) if (l < lanes) path(curve(x(l), 0, x(row.lane), 16), l);
  for (const l of row.down) if (l < lanes) path(curve(x(row.lane), 16, x(l), 32), l);
  if (row.lane < lanes) {
    const lane = `lane-${row.lane % LANE_COLOURS}`;
    if (head) svg.append(svgEl("circle", { cx: x(row.lane), cy: 16, r: 9, class: `graph-pulse ${lane}` }));
    // The visual diff: an orange ring when the commit changed how the app looks.
    if (look) svg.append(svgEl("circle", { cx: x(row.lane), cy: 16, r: merge ? 8 : 11, class: "graph-look" }));
    if (merge) svg.append(svgEl("circle", { cx: x(row.lane), cy: 16, r: 5, class: `graph-dot graph-dot-merge ${lane}`, "data-lane": row.lane }));
    else {
      svg.append(svgEl("circle", { cx: x(row.lane), cy: 16, r: 8.5, class: `graph-dot ${lane}`, "data-lane": row.lane }));
      const t = svgEl("text", { x: x(row.lane), y: 16.5, class: "graph-initials", "text-anchor": "middle", "dominant-baseline": "central" });
      t.textContent = initials(author);
      svg.append(t);
    }
  }
  return svg;
}

/** The lanes that go on past a commit, drawn down the side of its open detail so the graph doesn't break. */
function laneStrip(row, lanes) {
  const w = lanes * LANE_W;
  const svg = svgEl("svg", { class: "graph-strip", viewBox: `0 0 ${w} 32`, width: w, preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const l of new Set([...row.through, ...row.down])) {
    if (l < lanes) svg.append(svgEl("path", { d: `M${l * LANE_W + LANE_W / 2} 0V32`, class: `graph-line lane-${l % LANE_COLOURS}`, "vector-effect": "non-scaling-stroke" }));
  }
  return svg;
}

/** A branch or tag on a commit, in the colour of the commit's lane. */
function refBadge(ref, lane = 0) {
  const kind = ref.current ? "current" : ref.kind;
  const label = ref.kind === "head" ? "HEAD" : ref.name;
  const title = { current: "The branch you're on", branch: "Branch", remote: "Branch on the remote", tag: "Tag", head: "HEAD is here, on no branch" }[kind];
  return h("span", { class: `graph-ref graph-ref-${kind} lane-${lane % LANE_COLOURS}`, title }, ref.kind === "tag" ? icon("tag") : ref.current ? icon("git") : null, label);
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
    const other = { changes: "staged", staged: "changes" }[col];
    const was = places.get(el.dataset.key) ?? (other ? places.get(`${other}:${rest.join(":")}`) : undefined);
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

/**
 * A dialog with fields and several answers. Resolves to { choice, values } or null when cancelled.
 * `choices[0]` is the main answer: Enter picks it.
 */
function askDialog({ title, text = [], fields = [], choices = [{ value: "ok", label: "OK", kind: "primary" }], cancel = "Cancel" }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) =>
      f.multiline
        ? h("textarea", { class: "input git-dialog-text", rows: 3, placeholder: f.placeholder ?? "" })
        : h("input", { class: "input", type: "text", placeholder: f.placeholder ?? "", autocomplete: "off", spellcheck: "false" }),
    );
    inputs.forEach((el, i) => (el.value = fields[i].value ?? ""));
    let answer = null;
    const dialog = h("dialog", { class: "dialog" });
    const done = (choice) => {
      answer = choice === null ? null : { choice, values: Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value])) };
      dialog.close();
    };
    dialog.append(
      h(
        "form",
        { class: "dialog-body", onsubmit: (e) => (e.preventDefault(), done(choices[0].value)) },
        h("h2", { class: "dialog-title" }, title),
        h("div", { class: "dialog-text" }, (Array.isArray(text) ? text : [text]).filter(Boolean).map((t) => (t instanceof Node ? t : h("p", null, t)))),
        fields.map((f, i) => h("label", { class: "field" }, h("span", { class: "field-label" }, f.label), inputs[i], f.hint ? h("span", { class: "field-hint" }, f.hint) : null)),
        h(
          "div",
          { class: "dialog-actions" },
          btn(cancel, () => done(null)),
          [...choices].reverse().map((c) => btn(c.label, () => done(c.value), { kind: c.kind ?? "" })),
        ),
      ),
    );
    dialog.addEventListener("close", () => (dialog.remove(), resolve(answer)), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    (inputs[0] ?? dialog.querySelector(".btn-primary, .btn-danger"))?.focus();
  });
}

/** A "More" menu: a button that opens a list of actions. */
function actionMenu(label, items, { name } = {}) {
  const details = h("details", { class: "menu" });
  const close = () => details.removeAttribute("open");
  append(
    details,
    h("summary", { class: "btn btn-sm btn-ghost", "aria-label": name ?? label }, icon("more"), label),
    h(
      "div",
      { class: "menu-list" },
      items.filter(Boolean).map(([text, iconName, fn, disabled]) => h("button", { type: "button", disabled: !!disabled, onclick: () => (close(), fn()) }, icon(iconName), text)),
    ),
  );
  return details;
}

/** Commit messages being written, per project, kept while you visit other pages. */
const gitDrafts = new Map();

// ------------------------------------------------------------------ snapshots (run any commit)

const SNAPSHOT_PHASES = { creating: "Checking out", installing: "Installing packages", starting: "Starting", failed: "Couldn't start" };

/** Being set up, or its dev server starting. */
function snapshotPending(s) {
  return (s.job && s.job.phase !== "failed") || s.dev?.status === "starting";
}

function snapshotBadge(s) {
  if (s.job) {
    const failed = s.job.phase === "failed";
    return h("span", { class: `badge ${failed ? "badge-danger" : "badge-warn"}` }, failed ? null : h("span", { class: "dot dot-pulse" }), SNAPSHOT_PHASES[s.job.phase] ?? s.job.phase);
  }
  const status = s.dev?.status;
  const [cls, text, pulse] =
    status === "ready" ? ["badge-ok", "Running", false] : status === "starting" ? ["badge-warn", "Starting", true] : status === "failed" ? ["badge-danger", "Failed", false] : ["", "Not running", false];
  return h("span", { class: `badge ${cls}` }, h("span", { class: `dot ${pulse ? "dot-pulse" : ""}` }), text);
}

/** Asks first, then stops the snapshot and deletes its folder. True when it's gone. */
async function removeSnapshotFlow(s, button) {
  const yes = await confirmDialog({
    title: `Remove ${s.name.replace("@", " @ ")}?`,
    text: [`This stops its dev server and deletes its folder, ${tildify(s.path ?? s.dir ?? "")}.`, "Your working copy, branches and node_modules aren't touched."],
    confirm: "Remove",
  });
  if (!yes) return false;
  const run = () => api("/api/snapshots/remove", { method: "POST", body: { id: s.id } });
  const r = button?.isConnected ? await busy(button, "Removing…", run) : await run().catch((err) => void toast(err.message, "error"));
  if (!r) return false;
  toast(r.message);
  return true;
}

/** One snapshot: its commit, how it's doing, its address, and Run/Stop/Remove. */
function snapshotRow(s, { onChange }) {
  const live = s.dev && (s.dev.status === "starting" || s.dev.status === "ready");
  const url = s.dev?.status === "ready" ? (s.dev.localUrl ?? s.dev.url) : undefined;
  const busyJob = s.job && s.job.phase !== "failed";
  const lastLine = busyJob ? s.job.lines?.at(-1) : undefined;
  return h(
    "li",
    { class: "snap-row" },
    h("span", { class: "graph-hash mono" }, s.short),
    h("span", { class: "snap-text" }, h("span", { class: "snap-subject" }, s.subject || "(no message)"), lastLine ? h("span", { class: "dim mono snap-line" }, lastLine) : null),
    snapshotBadge(s),
    url ? h("a", { href: url, target: "_blank", rel: "noreferrer", class: "mono snap-url" }, url.replace(/^https?:\/\//, "")) : null,
    h(
      "span",
      { class: "snap-actions" },
      live
        ? btn("Stop", async (ev) => {
            const button = ev.currentTarget;
            await busy(button, "Stopping…", () => api("/api/dev/stop", { method: "POST", body: { dir: s.dir } }));
            setTimeout(onChange, 600);
          }, { small: true, iconName: "stop", name: `Stop ${s.name}` })
        : busyJob
          ? null
          : btn("Run", async (ev) => {
              const button = ev.currentTarget;
              const r = await busy(button, "Starting…", () => api("/api/snapshots/run", { method: "POST", body: { dir: s.projectDir, hash: s.hash } }));
              if (r) onChange();
            }, { small: true, kind: "primary", iconName: "play", name: `Run ${s.name}` }),
      busyJob
        ? null
        : btn("Remove", async (ev) => {
            if (await removeSnapshotFlow(s, ev.currentTarget)) onChange();
          }, { small: true, kind: "danger-ghost", iconName: "cleanup", name: `Remove ${s.name}` }),
    ),
    s.job?.error ? h("p", { class: "snap-error" }, s.job.error) : null,
  );
}

function gitPage(root) {
  const fromLink = new URLSearchParams(location.hash.split("?")[1] ?? "").get("dir");
  let dir = fromLink || pref("gitDir", "");
  let projects = [];
  let status = null;
  let statusSig = "";
  let graph = null;
  let graphHead;
  let refs = null;
  let undo = null;
  let limit = 200;
  /**
   * What's being dragged: { kind: "file", from, paths } | { kind: "hunk", from, path, hunk }
   * | { kind: "stash", oid } | { kind: "branch", name } | { kind: "commit", hash, subject } | { kind: "step", index }.
   */
  let drag = null;
  let working = 0; // actions on their way: polling waits for them
  let selected = new Set(); // "changes:path" / "staged:path"
  let lastClicked = null;
  let openFile = null; // { path, staged, conflict }
  let openCommit = null; // hash
  let newCommit = null; // the hash just committed, to animate in
  let drawIn = true; // the graph draws itself in once per project
  let historyList = null;
  let rebase = null; // the history being edited: { from, steps }
  let stopped = false;
  // Visual diffs: { on, browser, target, capturing, last, folder, commits }, and each commit's entry by hash.
  let visual = null;
  let visualSig = "";
  let visualBy = new Map();
  const visualBar = h("div", { class: "visual-bar", "aria-live": "polite" });
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
  const opBanner = h("div", { class: "git-op", "aria-live": "polite" });
  const filePanel = h("div", { class: "git-file-panel" });
  const rebasePanel = h("div", { class: "git-file-panel" });
  const branchesBody = h("div", { class: "git-branches" });
  const history = h("div", { class: "card graph-card" }, loadingView("Reading the history…"));
  const undoBody = h("div", { class: "git-undo-body" });

  // Run any commit: find one, then run the app as it was there, next to your own dev server.
  let snapshots = []; // this project's snapshots, with their dev servers and set-up jobs
  let snapSig = "";
  let snapTimer = 0;
  let searchList = null; // the last search's commits
  let searchTimer = 0;
  let searchSeq = 0;
  const snapBody = h("ul", { class: "snap-list", "aria-label": "Snapshots of this project", "aria-live": "polite" });
  const searchResults = h("div", { class: "commit-search-results" });
  const commitSearch = h("input", {
    class: "input commit-search-input",
    type: "search",
    placeholder: "Search commits: message, hash, author or file",
    "aria-label": "Search commits: message, hash, author or file",
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(), 300);
    },
  });

  const columns = { changes: makeColumn("changes"), staged: makeColumn("staged") };
  const bin = h("div", { class: "git-bin", "aria-hidden": "true" }, icon("cleanup"), "Drop here to discard the changes");
  columns.changes.col.append(bin);
  dropTarget(bin, (d) => d.kind === "file" && d.from === "changes", (d) => discard(d.paths));

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
  const amendBox = h("input", { type: "checkbox", id: "git-amend", onchange: () => amendChanged() });
  const commitSummary = h("p", { class: "dim git-commit-summary" });
  // Claude Code writes the message: only on this click, since it sends the staged diff to your Claude account.
  const writeButton = btn("Write message", (ev) => writeMessage(ev.currentTarget), {
    small: true,
    kind: "ghost",
    iconName: "journal",
    title: "Claude Code (claude -p) writes a message from the staged changes, in this repository's style, for you to edit. This sends the staged diff to your Claude account, and only when you click.",
  });
  writeButton.hidden = true;
  api("/api/git/ai").then((r) => (writeButton.hidden = !r.claude), () => {});
  const commitButton = btn("Commit", (ev) => commit(ev.currentTarget), { kind: "primary", iconName: "check" });
  const commitBox = h(
    "section",
    { class: "card git-col git-commit", "aria-labelledby": "git-commit-title" },
    h("div", { class: "git-col-head" }, h("h2", { class: "git-col-title", id: "git-commit-title" }, "Commit"), writeButton),
    message,
    h("label", { class: "check", for: "git-amend" }, amendBox, "Amend the last commit"),
    commitSummary,
    h("div", { class: "toolbar" }, commitButton, h("span", { class: "dim git-hint" }, h("kbd", null, "Ctrl"), "+", h("kbd", null, "Enter"))),
  );
  dropTarget(commitBox, (d) => (d.kind === "file" || d.kind === "hunk") && d.from === "changes", (d) => (d.kind === "hunk" ? moveHunk(d) : move("changes", d.paths)));

  const shelf = makeShelf();
  const board = h("div", { class: "git-board" }, columns.changes.col, columns.staged.col, commitBox, shelf.col);

  // The drop targets for a commit dragged out of the graph.
  const dock = h("div", { class: "git-dock", hidden: true, role: "group", "aria-label": "Drop a commit here" });
  const dockZone = (label, iconName, hint, fn) => {
    const el = h("div", { class: "git-dock-zone", title: hint }, icon(iconName), h("span", null, label));
    dropTarget(el, (d) => d.kind === "commit", (d) => fn(d));
    return el;
  };
  append(
    dock,
    dockZone("Run this commit", "play", "Run the app as it was at this commit, next to your own dev server", (d) => runCommit(d.hash)),
    dockZone("Revert", "refresh", "A new commit that undoes this one", (d) => act("revert", { hash: d.hash })),
    dockZone("Copy onto this branch", "copy", "Cherry-pick it onto the branch you're on", (d) => act("cherry-pick", { hash: d.hash })),
    dockZone("New branch here", "git", "Start a branch at this commit", (d) => newBranchAt(d.hash)),
    dockZone("Tag here", "tag", "Mark this commit, for a release say", (d) => newTagAt(d.hash)),
    dockZone("Edit history from here", "log", "Reorder, reword, squash or drop this commit and the ones after it", (d) => openRebase(d.hash)),
    dockZone("Go back here", "left", "Move the branch back to this commit, keeping uncommitted changes", (d) => goBackTo(d.hash, d.subject)),
  );

  append(
    root,
    pageHead(
      "Git",
      "Drag your changes into the next commit, branches onto branches to merge them, and commits onto actions. Every step can be undone.",
      h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Project"), projectSelect),
      btn("Refresh", () => load({ keep: true }), { iconName: "refresh", kind: "ghost" }),
    ),
    headInfo,
    opBanner,
    board,
    filePanel,
    h("section", { class: "section", "aria-labelledby": "git-branches-title" }, h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "git-branches-title" }, "Branches"), h("p", { class: "dim git-section-hint" }, "Drag a branch onto the one you're on to merge it; drag yours onto another to rebase.")), branchesBody),
    rebasePanel,
    h(
      "section",
      { class: "section", "aria-labelledby": "git-run-title" },
      h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "git-run-title" }, "Run any commit"), h("p", { class: "dim git-section-hint" }, "The app as it was, beside yours, in its own folder: your working copy isn't touched.")),
      h("div", { class: "card commit-search" }, h("label", { class: "commit-search-field" }, icon("log"), commitSearch), snapBody, searchResults),
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "git-history-title" },
      h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "git-history-title" }, "History"), h("p", { class: "dim git-section-hint" }, "Drag a commit to revert, copy, branch, tag, edit or go back to it.")),
      visualBar,
      history,
    ),
    h(
      "details",
      { class: "card git-undo", open: pref("gitUndoOpen", "0") === "1" || undefined, ontoggle: (e) => setPref("gitUndoOpen", e.target.open ? "1" : "0") },
      h("summary", { class: "git-undo-head" }, icon("refresh"), h("span", null, "Undo history"), h("span", { class: "dim" }, "what you did here, and git's own record")),
      undoBody,
    ),
    dock,
    live,
  );

  /** replaceChildren, skipping null and taking arrays, the way h() does. */
  function put(el, ...children) {
    el.replaceChildren();
    append(el, ...children);
  }

  // ---------------------------------------------------------------- drag and drop

  /** Something that takes what's dragged when `accepts(drag)` says so, and lights up while it's over it. */
  function dropTarget(el, accepts, onDrop) {
    el.addEventListener("dragover", (e) => {
      if (!drag || !accepts(drag)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target");
    });
    el.addEventListener("drop", (e) => {
      if (!drag || !accepts(drag)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drop-target");
      const d = drag;
      endDrag();
      onDrop(d, e);
    });
  }

  function startDrag(e, what, label) {
    drag = what;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", label);
    root.classList.add(`dragging-${what.kind}`);
    if (what.kind === "file" && what.from === "changes") root.classList.add("dragging-changes");
    if (what.kind === "commit") dock.hidden = false;
  }

  function endDrag() {
    drag = null;
    dock.hidden = true;
    root.classList.remove("dragging-file", "dragging-hunk", "dragging-stash", "dragging-branch", "dragging-commit", "dragging-step", "dragging-tag", "dragging-changes");
    for (const el of root.querySelectorAll(".dragging, .drop-target")) el.classList.remove("dragging", "drop-target");
  }

  // ---------------------------------------------------------------- the board

  function makeColumn(kind) {
    const title = kind === "changes" ? "Changes" : "Staged";
    const count = h("span", { class: "badge" }, "0");
    const all = btn(kind === "changes" ? "Stage all" : "Unstage all", () => {
      const keys = [...selected].filter((k) => k.startsWith(`${kind}:`));
      const paths = keys.length ? keys.map((k) => k.slice(kind.length + 1)) : filesIn(kind).filter((f) => !f.conflicted || kind === "changes").map((f) => f.path);
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
    const other = kind === "changes" ? "staged" : "changes";
    dropTarget(
      col,
      (d) => ((d.kind === "file" || d.kind === "hunk") && d.from === other) || (kind === "changes" && d.kind === "stash"),
      (d) => (d.kind === "stash" ? act("stash-apply", { oid: d.oid, pop: true }) : d.kind === "hunk" ? moveHunk(d) : move(other, d.paths)),
    );
    return { col, list, count, all, empty };
  }

  const filesIn = (kind) => (status?.files ?? []).filter((f) => (kind === "changes" ? f.unstaged : f.staged));

  function card(f, kind) {
    const key = `${kind}:${f.path}`;
    const code = f.conflicted ? "U" : f.untracked ? "N" : kind === "staged" ? f.index : f.worktree;
    const slash = f.path.lastIndexOf("/");
    const isOpen = openFile?.path === f.path && openFile.staged === (kind === "staged");
    const li = h(
      "li",
      { class: `git-card${selected.has(key) ? " selected" : ""}${isOpen ? " open" : ""}${f.conflicted ? " git-card-conflict" : ""}`, draggable: "true", dataset: { key } },
      h("span", { class: `git-code git-code-${code}`, title: GIT_CODES[code] ?? code }, code),
      h(
        "button",
        {
          type: "button",
          class: "git-card-main",
          title: f.conflicted ? "Resolve the conflict" : "Show the changes. Ctrl+click or Shift+click to select several.",
          "aria-pressed": String(selected.has(key)),
          onclick: (e) => cardClick(e, f, kind),
        },
        h("span", { class: "git-name" }, f.path.slice(slash + 1)),
        slash >= 0 ? h("span", { class: "git-folder" }, f.path.slice(0, slash + 1)) : null,
        f.from ? h("span", { class: "git-folder" }, `from ${f.from}`) : null,
      ),
      f.staged && f.unstaged && !f.conflicted ? h("span", { class: "badge", title: "Part of this file is staged, part isn't" }, "partly") : null,
      f.conflicted ? h("span", { class: "badge badge-danger" }, "conflict") : null,
      kind === "changes" && !f.conflicted
        ? btn(null, () => discard([f.path]), { small: true, kind: "danger-ghost", iconName: "cleanup", title: "Discard the changes", name: `Discard the changes to ${f.path}` })
        : null,
      btn(null, () => move(kind, [f.path]), {
        small: true,
        kind: "ghost",
        iconName: kind === "changes" ? "right" : "left",
        title: kind === "changes" ? (f.conflicted ? "Mark as resolved" : "Stage") : "Unstage",
        name: `${kind === "changes" ? "Stage" : "Unstage"} ${f.path}`,
      }),
    );
    li.addEventListener("dragstart", (e) => {
      if (!selected.has(key)) {
        selected = new Set([key]);
        markSelected();
      }
      const paths = [...selected].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
      startDrag(e, { kind: "file", from: kind, paths }, paths.join("\n"));
      requestAnimationFrame(() => board.querySelectorAll(".git-card.selected").forEach((c) => c.classList.add("dragging")));
    });
    li.addEventListener("dragend", endDrag);
    return li;
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
    if (f.conflicted) openConflict(f.path);
    else openDiff(f.path, kind === "staged");
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
    const amend = amendBox.checked;
    const conflicted = (status?.files ?? []).some((f) => f.conflicted);
    commitSummary.textContent = amend
      ? staged.length ? `${plural(staged.length, "file")} go${staged.length === 1 ? "es" : ""} into the last commit too.` : "Only the message changes."
      : staged.length ? `${plural(staged.length, "file")} go${staged.length === 1 ? "es" : ""} in this commit.` : status?.operation === "merge" ? "Finish the merge with Continue above." : "Stage some changes first.";
    commitButton.replaceChildren(icon("check"), amend ? "Amend" : "Commit");
    commitButton.disabled = working > 0 || conflicted || (amend ? !status?.hasCommits : !staged.length || !message.value.trim());
  }

  async function writeMessage(button) {
    if (!filesIn("staged").length) return toast("Stage the changes first: the message is written from what's staged.", "error");
    if (message.value.trim()) {
      const yes = await confirmDialog({ title: "Replace your message?", text: "Claude Code's message takes the place of what's in the box now.", confirm: "Replace it", danger: false });
      if (!yes) return;
    }
    const r = await busy(button, "Writing…", () => api("/api/git/suggest", { method: "POST", body: { dir } }));
    if (!r) return;
    message.value = r.message;
    message.focus();
    updateCommitBox();
    say("Claude Code wrote a message. Edit it, then commit.");
  }

  async function amendChanged() {
    if (amendBox.checked && !message.value.trim() && status?.head) {
      try {
        const d = await api(`/api/git/commit?dir=${encodeURIComponent(dir)}&hash=${status.head}`);
        if (amendBox.checked && !message.value.trim()) message.value = d.message;
      } catch {
        // the message can still be typed
      }
    }
    updateCommitBox();
  }

  // ---------------------------------------------------------------- the shelf (stash)

  function makeShelf() {
    const count = h("span", { class: "badge" }, "0");
    const all = btn("Shelve all", (ev) => act("stash-push", {}, { button: ev.currentTarget, busyText: "Shelving…" }), { small: true, kind: "ghost", iconName: "save" });
    const list = h("ul", { class: "git-cards", "aria-label": "On the shelf" });
    const empty = h("p", { class: "git-empty dim" }, "Drag files here to put them aside without committing. Drag them back to Changes when you want them again.");
    const col = h(
      "section",
      { class: "card git-col git-shelf", "aria-labelledby": "git-shelf-title" },
      h("div", { class: "git-col-head" }, h("h2", { class: "git-col-title", id: "git-shelf-title" }, "Shelf"), count, all),
      list,
      empty,
    );
    dropTarget(col, (d) => d.kind === "file", (d) => act("stash-push", { paths: d.paths }));
    return { col, list, count, all, empty };
  }

  function renderShelf() {
    const stashes = refs?.stashes ?? [];
    const places = rememberPlaces(shelf.list);
    shelf.count.textContent = String(stashes.length);
    shelf.all.disabled = !(status?.files.length);
    shelf.empty.hidden = stashes.length > 0;
    shelf.list.replaceChildren(
      ...stashes.map((s) => {
        const li = h(
          "li",
          { class: "git-card git-stash", draggable: "true", dataset: { key: `stash:${s.oid}` }, title: "Drag to Changes to take it back" },
          h("span", { class: "git-code git-code-S", "aria-hidden": "true" }, icon("save")),
          h("span", { class: "git-card-main git-stash-text" }, h("span", { class: "git-name" }, s.message.replace(/^(On|WIP on) [^:]+: /, "")), h("span", { class: "git-folder" }, relativeTime(s.at))),
          btn(null, () => act("stash-apply", { oid: s.oid, pop: true }), { small: true, kind: "ghost", iconName: "left", title: "Take it back", name: `Take back ${s.message}` }),
          actionMenu("", [
            ["Apply a copy (keep it on the shelf)", "copy", () => act("stash-apply", { oid: s.oid })],
            ["Throw away…", "cleanup", () => dropStash(s)],
          ], { name: `More for ${s.message}` }),
        );
        li.addEventListener("dragstart", (e) => startDrag(e, { kind: "stash", oid: s.oid }, s.message));
        li.addEventListener("dragend", endDrag);
        return li;
      }),
    );
    slideFromPlaces(shelf.list, places);
  }

  async function dropStash(s) {
    const yes = await confirmDialog({ title: "Throw it away?", text: `"${s.message}" leaves the shelf. Undo can still bring it back.`, confirm: "Throw away" });
    if (yes) act("stash-drop", { oid: s.oid });
  }

  // ---------------------------------------------------------------- head, sync, undo, operation in progress

  function renderHead() {
    const s = status;
    const branch = refs?.branches.find((b) => b.current);
    const sync = !s.upstream
      ? h("span", { class: "dim" }, s.hasCommits ? "Not pushed anywhere yet." : "No commits yet.")
      : s.ahead || s.behind
        ? [
            s.ahead ? h("span", { class: "badge badge-warn" }, `↑ ${s.ahead} to push`) : null,
            s.behind ? h("span", { class: "badge badge-accent" }, `↓ ${s.behind} to pull`) : null,
            h("span", { class: "dim" }, `compared with ${s.upstream}`),
          ]
        : h("span", { class: "dim" }, `Up to date with ${s.upstream}.`);
    const onBranch = !!s.branch && !s.detached;
    const latest = undo?.entries.find((e) => !e.undone);
    put(
      headInfo,
      h("span", { class: "graph-ref graph-ref-current lane-0 git-branch-name" }, icon("git"), s.detached ? "No branch (detached HEAD)" : (s.branch ?? "No branch")),
      sync,
      branch?.gone ? h("span", { class: "badge badge-danger" }, "its upstream was deleted") : null,
      s.truncated ? h("span", { class: "badge badge-warn" }, "Only the first 1000 changed files are listed") : null,
      h(
        "div",
        { class: "toolbar git-sync" },
        btn("Fetch", (ev) => act("fetch", {}, { button: ev.currentTarget, busyText: "Fetching…" }), { small: true, kind: "ghost", iconName: "refresh", disabled: !refs?.remotes.length }),
        btn(`Pull${s.behind ? ` ${s.behind}` : ""}`, (ev) => act("pull", {}, { button: ev.currentTarget, busyText: "Pulling…" }), { small: true, iconName: "left", disabled: !onBranch || !s.upstream }),
        btn(`Push${s.ahead ? ` ${s.ahead}` : ""}`, (ev) => act("push", {}, { button: ev.currentTarget, busyText: "Pushing…" }), { small: true, kind: s.ahead || !s.upstream ? "primary" : "", iconName: "right", disabled: !onBranch || !refs?.remotes.length }),
        actionMenu("", [["Force push (with lease)…", "warn", () => forcePush(), !onBranch || !s.upstream]], { name: "More push options" }),
        latest?.undo ? btn(`Undo: ${latest.label}`, (ev) => act("undo", { id: latest.id }, { button: ev.currentTarget, busyText: "Undoing…" }), { small: true, kind: "ghost", iconName: "refresh", title: "Undo the last thing you did here" }) : null,
      ),
    );
  }

  async function forcePush() {
    const yes = await confirmDialog({
      title: `Force push ${status.branch}?`,
      text: [
        `The remote's ${status.upstream} is replaced with your ${status.branch}: commits only the remote has are dropped there.`,
        "It's done with --force-with-lease, so if someone pushed since you last fetched, nothing is overwritten and you're told instead. It can't be undone from here.",
      ],
      confirm: "Force push",
    });
    if (yes) act("push", { force: true });
  }

  function renderOperation() {
    const op = status?.operation;
    if (!op) return opBanner.replaceChildren();
    const conflicts = status.files.filter((f) => f.conflicted).length;
    const what = { merge: "A merge", rebase: "A rebase", "cherry-pick": "A cherry-pick", revert: "A revert" }[op];
    put(
      opBanner,
      h(
        "div",
        { class: `note ${conflicts ? "note-warn" : ""} git-op-note`, role: "status" },
        icon("warn"),
        h(
          "div",
          { class: "git-op-text" },
          h("p", null, h("strong", null, `${what} is waiting for you. `), conflicts ? `${plural(conflicts, "file")} still ${conflicts === 1 ? "has" : "have"} conflicts: open each in Changes, pick a side, and it's staged.` : "Every conflict is resolved: Continue finishes it."),
          h(
            "div",
            { class: "toolbar" },
            btn("Continue", (ev) => act("continue", {}, { button: ev.currentTarget, busyText: "Continuing…" }), { small: true, kind: "primary", iconName: "check", disabled: conflicts > 0 }),
            btn("Abort", async (ev) => {
              const button = ev.currentTarget;
              const yes = await confirmDialog({ title: `Abort the ${op}?`, text: `Everything goes back to how it was before the ${op} started, conflicts and their resolutions included.`, confirm: "Abort" });
              if (yes) act("abort", {}, { button, busyText: "Aborting…" });
            }, { small: true, kind: "danger-ghost", iconName: "x" }),
          ),
        ),
      ),
    );
  }

  function renderUndo() {
    if (!undo) return put(undoBody, loadingView("Reading…"));
    const latest = undo.entries.find((e) => !e.undone);
    put(
      undoBody,
      undo.entries.length
        ? h(
            "ol",
            { class: "git-undo-list" },
            undo.entries.slice(0, 30).map((e) =>
              h(
                "li",
                { class: `git-undo-item${e.undone ? " undone" : ""}` },
                h("span", { class: "git-undo-label" }, e.label),
                h("span", { class: "dim git-undo-time" }, relativeTime(e.at)),
                e.undone
                  ? h("span", { class: "badge" }, "undone")
                  : e === latest && e.undo
                    ? btn("Undo", (ev) => act("undo", { id: e.id }, { button: ev.currentTarget, busyText: "Undoing…" }), { small: true, iconName: "refresh" })
                    : !e.undo
                      ? h("span", { class: "dim git-undo-note" }, e.note ?? "can't be undone")
                      : null,
              ),
            ),
          )
        : h("p", { class: "dim" }, "Nothing done from here yet. Everything you do on this page shows up here, with Undo."),
      undo.reflog.length > 1
        ? h(
            "div",
            { class: "git-reflog" },
            h("h3", { class: "git-subtitle" }, "Where the branch was, from git's reflog"),
            h(
              "ol",
              { class: "git-undo-list" },
              undo.reflog.slice(1, 25).map((r) =>
                h(
                  "li",
                  { class: "git-undo-item" },
                  h("span", { class: "mono dim" }, r.oid.slice(0, 7)),
                  h("span", { class: "git-undo-label" }, r.message),
                  h("span", { class: "dim git-undo-time" }, relativeTime(r.at)),
                  btn("Go back here", () => goBackTo(r.oid, r.message), { small: true, kind: "ghost", iconName: "left" }),
                ),
              ),
            ),
          )
        : null,
    );
  }

  // ---------------------------------------------------------------- running an action

  /** Runs a git action: a toast with what happened, then everything is read again. */
  async function act(action, body = {}, { button, busyText = "Working…" } = {}) {
    working++;
    updateCommitBox();
    let r;
    try {
      const run = () => api("/api/git/action", { method: "POST", body: { dir, action, ...body } });
      if (button) r = await busy(button, busyText, run);
      else {
        try {
          r = await run();
        } catch (err) {
          toast(err.message, "error");
        }
      }
      if (r) {
        toast(r.message, r.ok ? "ok" : "error");
        say(r.message);
      }
    } finally {
      working--;
      await refreshAll();
    }
    return r;
  }

  async function refreshAll() {
    statusSig = "";
    await Promise.all([loadStatus(), loadRefs(), loadGraph(), loadUndo()]);
    refreshOpenFile();
  }

  async function discard(paths) {
    if (!paths.length) return;
    const yes = await confirmDialog({
      title: paths.length === 1 ? `Discard the changes to ${paths[0]}?` : `Discard the changes to ${plural(paths.length, "file")}?`,
      text: ["The file goes back to how it was at the last commit (a new file is deleted).", "dx keeps a copy first, so Undo brings the changes back."],
      confirm: "Discard",
    });
    if (yes) act("discard", { paths });
  }

  async function goBackTo(hash, subject) {
    const yes = await confirmDialog({
      title: `Move ${status?.branch ?? "HEAD"} back to ${hash.slice(0, 7)}?`,
      text: [subject ? `"${subject}" becomes the latest commit on the branch.` : "", "Uncommitted changes are kept. The commits after it stay in the reflog, and Undo moves the branch forward again."],
      confirm: "Go back here",
      danger: false,
    });
    if (yes) act("reset-to", { hash });
  }

  async function newBranchAt(hash) {
    const a = await askDialog({
      title: hash ? `New branch at ${hash.slice(0, 7)}` : "New branch",
      fields: [{ name: "name", label: "Name", placeholder: "feature/checkout" }],
      choices: [{ value: "switch", label: "Create and switch", kind: "primary" }, { value: "create", label: "Create" }],
    });
    if (a?.values.name.trim()) act("branch-create", { name: a.values.name.trim(), at: hash, switchTo: a.choice === "switch" });
  }

  async function newTagAt(hash) {
    const a = await askDialog({
      title: `Tag ${hash ? hash.slice(0, 7) : "this commit"}`,
      fields: [
        { name: "name", label: "Name", placeholder: "v1.2.0" },
        { name: "message", label: "Message (optional)", placeholder: "What's in this release", multiline: true, hint: "With a message it's an annotated tag." },
      ],
      choices: [{ value: "ok", label: "Create tag", kind: "primary" }],
    });
    if (a?.values.name.trim()) act("tag-create", { name: a.values.name.trim(), at: hash, message: a.values.message });
  }

  // ---------------------------------------------------------------- staging

  /** What the board will look like once git has done it: shown at once, replaced by git's answer. */
  function expected(paths, stage) {
    const set = new Set(paths);
    return {
      ...status,
      files: status.files.map((f) => {
        if (!set.has(f.path)) return f;
        if (stage) return { ...f, staged: true, unstaged: false, untracked: false, conflicted: false, index: f.untracked ? "A" : f.index === "." ? f.worktree : f.index, worktree: "." };
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

  // ---------------------------------------------------------------- one file: its changes, or its conflicts

  function refreshOpenFile() {
    if (!openFile || !status) return;
    const f = status.files.find((x) => x.path === openFile.path);
    if (openFile.conflict) return void (f?.conflicted ? openConflict(f.path, { quiet: true }) : f ? openDiff(f.path, f.staged && !f.unstaged, { quiet: true }) : closeFile());
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

  function markOpen(key) {
    for (const el of board.querySelectorAll(".git-card")) el.classList.toggle("open", el.dataset.key === key);
  }

  async function openDiff(file, staged, { quiet = false } = {}) {
    openFile = { path: file, staged };
    markOpen(`${staged ? "staged" : "changes"}:${file}`);
    if (!quiet) filePanel.replaceChildren(h("div", { class: "card card-pad" }, loadingView(`Reading ${file}…`)));
    try {
      const d = await api(`/api/git/diff?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(file)}&staged=${staged}`);
      if (openFile?.path !== file || openFile.staged !== staged || openFile.conflict) return;
      renderFile(d);
      if (!quiet) filePanel.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
    } catch (err) {
      if (openFile?.path === file) filePanel.replaceChildren(h("div", { class: "card card-pad" }, errorView(err)));
    }
  }

  function fileHead(title, badge, ...actions) {
    return h(
      "div",
      { class: "section-head" },
      h("div", { class: "git-file-title" }, h("h2", { class: "section-title mono", id: "git-file-title" }, title), badge),
      h("div", { class: "toolbar" }, ...actions, btn(null, () => closeFile(), { small: true, kind: "ghost", iconName: "x", name: "Close", title: "Close" })),
    );
  }

  function openInEditor(file, line) {
    return btn("Open in editor", (ev) => busy(ev.currentTarget, "Opening…", async () => toast((await api("/api/open-file", { method: "POST", body: { dir, file, line } })).message)), { small: true, kind: "ghost", iconName: "code" });
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
            startDrag(e, { kind: "hunk", from, path: d.path, hunk: hk.id }, hk.header);
            el.classList.add("dragging");
          });
          head.addEventListener("dragend", endDrag);
        }
        return el;
      });
    });
    put(
      filePanel,
      h(
        "section",
        { class: "card card-pad section git-file", "aria-labelledby": "git-file-title" },
        fileHead(
          d.path,
          h("span", { class: "badge" }, d.staged ? "Staged" : d.untracked ? "New file" : "Not staged"),
          btn(d.staged ? "Unstage file" : "Stage file", () => move(from, [d.path]), { small: true, iconName: d.staged ? "left" : "right" }),
          !d.staged ? btn("Discard…", () => discard([d.path]), { small: true, kind: "danger-ghost", iconName: "cleanup" }) : null,
          openInEditor(d.path, firstLine),
        ),
        d.truncated ? h("p", { class: "dim" }, "This file's changes are cut at 512 KB, so it can only be staged whole.") : null,
        !d.stageable && d.hunks.length && !d.truncated ? h("p", { class: "dim" }, "New, deleted and renamed files go whole: stage or unstage the file.") : null,
        detail,
      ),
    );
  }

  /** A conflicted file: each clash side by side, and Mine, Theirs or Both for each. */
  async function openConflict(file, { quiet = false } = {}) {
    openFile = { path: file, staged: false, conflict: true };
    markOpen(`changes:${file}`);
    if (!quiet) filePanel.replaceChildren(h("div", { class: "card card-pad" }, loadingView(`Reading ${file}…`)));
    let c;
    try {
      c = await api(`/api/git/conflict?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(file)}`);
    } catch (err) {
      if (openFile?.path === file) filePanel.replaceChildren(h("div", { class: "card card-pad" }, errorView(err)));
      return;
    }
    if (openFile?.path !== file) return;
    const rebasing = status?.operation === "rebase";
    // In a rebase, "ours" is the branch being rebased onto and "theirs" is your commit being replayed.
    const names = rebasing ? ["Upstream", "Your commit"] : ["Yours", "Incoming"];
    const blocks = c.parts.filter((p) => p.kind === "conflict");
    const choices = blocks.map(() => null);
    const resolveBtn = btn("Resolve and stage", (ev) => act("resolve", { path: file, hash: c.hash, choices }, { button: ev.currentTarget, busyText: "Resolving…" }), { small: true, kind: "primary", iconName: "check", disabled: true });
    const whole = (side) => btn(`Take ${side === "ours" ? names[0].toLowerCase() : names[1].toLowerCase()} (whole file)`, (ev) => act("resolve", { path: file, side }, { button: ev.currentTarget }), { small: true, kind: "ghost" });
    let n = 0;
    const view = c.binary
      ? [h("p", { class: "dim" }, "A binary file: take one side whole.")]
      : c.parts.map((p) => {
          if (p.kind === "text") {
            const lines = p.lines;
            const shown = lines.length > 6 ? [...lines.slice(0, 3), null, ...lines.slice(-3)] : lines;
            return h("pre", { class: "git-conflict-text" }, shown.map((l) => (l === null ? h("span", { class: "dim" }, `  … ${lines.length - 6} lines …\n`) : `${l.replace(/\r$/, "")}\n`)));
          }
          const i = n++;
          const sides = h(
            "div",
            { class: "git-conflict-sides" },
            h("div", { class: "git-conflict-side git-conflict-ours" }, h("div", { class: "git-conflict-label" }, names[0], h("span", { class: "dim mono" }, ` ${p.oursLabel}`)), h("pre", null, p.ours.map((l) => `${l.replace(/\r$/, "")}\n`))),
            h("div", { class: "git-conflict-side git-conflict-theirs" }, h("div", { class: "git-conflict-label" }, names[1], h("span", { class: "dim mono" }, ` ${p.theirsLabel}`)), h("pre", null, p.theirs.map((l) => `${l.replace(/\r$/, "")}\n`))),
          );
          const pick = segmented(`Conflict ${i + 1}`, [["ours", `Keep ${names[0].toLowerCase()}`], ["theirs", `Keep ${names[1].toLowerCase()}`], ["both", "Keep both"]], null, (v) => {
            choices[i] = v;
            el.classList.toggle("picked", true);
            el.dataset.pick = v;
            resolveBtn.disabled = choices.some((x) => !x);
          });
          const el = h("div", { class: "git-conflict" }, h("div", { class: "git-conflict-head" }, h("strong", null, `Conflict ${i + 1} of ${blocks.length}`), pick), sides);
          return el;
        });
    put(
      filePanel,
      h(
        "section",
        { class: "card card-pad section git-file", "aria-labelledby": "git-file-title" },
        fileHead(file, h("span", { class: "badge badge-danger" }, plural(blocks.length || 1, "conflict")), resolveBtn, whole("ours"), whole("theirs"), openInEditor(file)),
        h("p", { class: "dim" }, rebasing ? "While rebasing, your commit is being replayed on top of the upstream: pick what each block keeps." : "Pick what each block keeps. The file is rebuilt from its own text and staged."),
        view,
      ),
    );
    if (!quiet) filePanel.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  // ---------------------------------------------------------------- commit

  async function commit(button) {
    const text = message.value;
    const amend = amendBox.checked;
    if (amend && status?.upstream && status.ahead === 0 && status.hasCommits) {
      const yes = await confirmDialog({ title: "Amend a pushed commit?", text: ["The last commit is already on the remote. Amending it rewrites it, so you'd have to force push afterwards."], confirm: "Amend anyway", danger: false });
      if (!yes) return;
    }
    const flying = [...columns.staged.list.children];
    working++;
    updateCommitBox();
    const r = await busy(button, amend ? "Amending…" : "Committing…", () => api("/api/git/commit", { method: "POST", body: { dir, message: text, amend } }));
    working--;
    if (!r) return updateCommitBox();
    message.value = "";
    amendBox.checked = false;
    drafts.delete(dir);
    newCommit = r.hash;
    if (r.visual) void loadVisual();
    say(`${amend ? "Amended" : "Committed"} ${r.short}: ${r.subject}`);
    // A commit stays on this computer: pushing is a separate step, at the top or by dragging the branch.
    toast(`${amend ? "Amended" : "Committed"} ${r.short}: ${r.subject}.${refs?.remotes.length ? " It's only on this computer until you push." : ""}`);
    await flyToHistory(flying);
    closeFile();
    await refreshAll();
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

  // ---------------------------------------------------------------- branches and tags

  function renderBranches() {
    if (!refs) return put(branchesBody, h("div", { class: "card card-pad" }, loadingView("Reading the branches…")));
    const current = refs.current;
    const local = [...refs.branches].sort((a, b) => Number(b.current) - Number(a.current) || b.at - a.at);
    const nameInput = h("input", { class: "input", type: "text", placeholder: "New branch, e.g. feature/checkout", "aria-label": "New branch name", autocomplete: "off", spellcheck: "false" });
    const switchToo = h("input", { type: "checkbox", id: "git-new-switch", checked: true });
    const form = h(
      "form",
      {
        class: "git-new-branch",
        onsubmit: (e) => {
          e.preventDefault();
          const name = nameInput.value.trim();
          if (name) act("branch-create", { name, switchTo: switchToo.checked }, { button: form.querySelector("button[type=submit]") });
        },
      },
      nameInput,
      h("label", { class: "check", for: "git-new-switch" }, switchToo, "Switch to it"),
      btn("Create branch", null, { small: true, iconName: "new", type: "submit" }),
    );
    const places = rememberPlaces(branchesBody);
    put(
      branchesBody,
      h("ul", { class: "git-branch-list", "aria-label": "Branches on this computer" }, local.map((b) => branchCard(b, current))),
      h("div", { class: "card card-pad git-branch-extra" }, form, remoteAndTags()),
    );
    slideFromPlaces(branchesBody, places);
  }

  function branchCard(b, current) {
    const li = h(
      "li",
      { class: `card git-branch-card${b.current ? " current" : ""}`, draggable: "true", dataset: { key: `branch:${b.name}` }, title: b.current ? "Drop a branch here to merge it in, or a commit to copy it here" : `Drag onto ${current ?? "your branch"} to merge, or drop ${current ?? "your branch"} here to rebase onto it` },
      h(
        "div",
        { class: "git-branch-top" },
        h("span", { class: `graph-ref ${b.current ? "graph-ref-current" : "graph-ref-branch"} lane-${branchLane(b.name) % LANE_COLOURS}` }, icon("git"), b.name),
        b.current ? h("span", { class: "badge badge-accent" }, "you're here") : null,
        b.ahead ? h("span", { class: "badge badge-warn", title: `Commits not on ${b.upstream}` }, `↑${b.ahead}`) : null,
        b.behind ? h("span", { class: "badge badge-accent", title: `Commits on ${b.upstream} you don't have` }, `↓${b.behind}`) : null,
        b.gone ? h("span", { class: "badge badge-danger", title: "Its upstream branch was deleted on the remote" }, "gone") : null,
        !b.current && b.merged ? h("span", { class: "badge badge-ok", title: `Everything on it is in ${current}` }, "merged") : null,
      ),
      h("p", { class: "git-branch-sub" }, h("span", { class: "git-branch-subject" }, b.subject), h("span", { class: "dim" }, ` · ${relativeTime(b.at)}`)),
      h(
        "div",
        { class: "toolbar git-branch-actions" },
        !b.current ? btn("Switch", (ev) => switchTo(b.name, ev.currentTarget), { small: true, iconName: "right" }) : null,
        actionMenu("", [
          !b.current && current ? [`Merge into ${current}…`, "git", () => mergeFlow(b.name)] : null,
          !b.current && current ? [`Rebase ${current} onto this…`, "log", () => rebaseFlow(b.name)] : null,
          ["Rename…", "journal", () => renameBranch(b.name)],
          !b.current ? ["Delete…", "cleanup", () => deleteBranch(b)] : null,
        ], { name: `More for ${b.name}` }),
      ),
    );
    li.addEventListener("dragstart", (e) => startDrag(e, { kind: "branch", name: b.name }, b.name));
    li.addEventListener("dragend", endDrag);
    dropTarget(li, (d) => acceptsOnBranch(d, b.name, b.current), (d) => dropOnBranch(d, b.name, b.current));
    return li;
  }

  /** A lane colour for a branch, the one its tip has in the graph when it's shown. */
  function branchLane(name) {
    const c = graph?.commits.find((x) => x.refs.some((r) => r.kind === "branch" && r.name === name));
    return c ? c.row.lane : [...name].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  }

  function acceptsOnBranch(d, name, isCurrent) {
    if (d.kind === "commit") return isCurrent;
    if (d.kind !== "branch" || d.name === name) return false;
    return isCurrent || d.name === refs?.current;
  }

  function dropOnBranch(d, name, isCurrent) {
    if (d.kind === "commit") return act("cherry-pick", { hash: d.hash });
    if (isCurrent) return mergeFlow(d.name);
    if (d.name === refs?.current) return rebaseFlow(name);
  }

  function remoteAndTags() {
    const remotes = refs.remoteBranches;
    const tags = refs.tags;
    // Pushing is its own step: drop your branch here (or use Push at the top), never part of a commit.
    const pushZone = refs.remotes.length && refs.current
      ? h("div", { class: "git-push-zone", title: `Drop ${refs.current} here to push it` }, icon("right"), `Drop ${refs.current} (or a tag) here to push it to ${refs.remotes.includes("origin") ? "origin" : refs.remotes[0]}`)
      : null;
    if (pushZone) dropTarget(pushZone, (d) => (d.kind === "branch" && d.name === refs.current) || d.kind === "tag", (d) => (d.kind === "tag" ? act("push-tags", { name: d.name }) : act("push")));
    return [
      remotes.length || pushZone
        ? h(
            "div",
            { class: "git-chips-group" },
            h("h3", { class: "git-subtitle" }, "On the remote"),
            pushZone,
            h(
              "ul",
              { class: "git-chips" },
              remotes.slice(0, 60).map((r) => {
                const local = refs.branches.some((b) => b.name === r.branch);
                const li = h(
                  "li",
                  { class: "git-chip", draggable: "true", title: `Drag onto ${refs.current ?? "your branch"} to merge ${r.name} into it` },
                  h("span", { class: `graph-ref graph-ref-remote lane-${branchLane(r.branch) % LANE_COLOURS}` }, r.name),
                  !local ? btn("Check out", (ev) => switchTo(r.name, ev.currentTarget), { small: true, kind: "ghost", title: `A local ${r.branch} that tracks ${r.name}` }) : null,
                );
                li.addEventListener("dragstart", (e) => startDrag(e, { kind: "branch", name: r.name }, r.name));
                li.addEventListener("dragend", endDrag);
                return li;
              }),
            ),
          )
        : refs.remotes.length
          ? null
          : h("p", { class: "dim" }, "No remote: this repository lives only on this computer."),
      tags.length
        ? h(
            "div",
            { class: "git-chips-group" },
            h(
              "div",
              { class: "git-subtitle-row" },
              h("h3", { class: "git-subtitle" }, "Tags"),
              refs.remotes.length ? btn("Push all tags", (ev) => act("push-tags", { all: true }, { button: ev.currentTarget, busyText: "Pushing…" }), { small: true, kind: "ghost", iconName: "right" }) : null,
            ),
            h(
              "ul",
              { class: "git-chips" },
              tags.slice(0, 60).map((t) => {
                const li = h(
                  "li",
                  { class: "git-chip", draggable: refs.remotes.length ? "true" : undefined, title: refs.remotes.length ? "Drag onto the push box to push this tag" : undefined },
                  h("span", { class: "graph-ref graph-ref-tag", title: t.annotated ? "Annotated tag" : "Tag" }, icon("tag"), t.name),
                  refs.remotes.length ? btn(null, (ev) => act("push-tags", { name: t.name }, { button: ev.currentTarget, busyText: "…" }), { small: true, kind: "ghost", iconName: "right", name: `Push the tag ${t.name}`, title: "Push the tag" }) : null,
                  btn(null, () => deleteTag(t.name), { small: true, kind: "ghost", iconName: "x", name: `Delete the tag ${t.name}`, title: "Delete the tag (here only)" }),
                );
                li.addEventListener("dragstart", (e) => startDrag(e, { kind: "tag", name: t.name }, t.name));
                li.addEventListener("dragend", endDrag);
                return li;
              }),
            ),
          )
        : null,
    ];
  }

  async function switchTo(name, button) {
    const dirty = (status?.files ?? []).length > 0;
    let shelve = false;
    if (dirty) {
      const a = await askDialog({
        title: `Switch to ${name}?`,
        text: [`You have ${plural(status.files.length, "changed file")}. Git carries them along if they don't clash with ${name}; or put them on the shelf first and take them back later.`],
        choices: [{ value: "carry", label: "Switch, carry my changes", kind: "primary" }, { value: "shelve", label: "Shelve them and switch" }],
      });
      if (!a) return;
      shelve = a.choice === "shelve";
    }
    const r = await act("switch", { name, shelve }, { button, busyText: "Switching…" });
    if (!r && dirty && !shelve) {
      const again = await confirmDialog({ title: "Shelve and switch?", text: `Your changes would clash with ${name}. Put them on the shelf and switch?`, confirm: "Shelve and switch", danger: false });
      if (again) act("switch", { name, shelve: true });
    }
  }

  async function renameBranch(name) {
    const a = await askDialog({ title: `Rename ${name}`, fields: [{ name: "to", label: "New name", value: name }], choices: [{ value: "ok", label: "Rename", kind: "primary" }] });
    if (a && a.values.to.trim() && a.values.to.trim() !== name) act("branch-rename", { name, to: a.values.to.trim() });
  }

  async function deleteBranch(b) {
    const yes = await confirmDialog({
      title: `Delete ${b.name}?`,
      text: [b.merged ? `Everything on it is already in ${refs.current}, so nothing is lost.` : `It has commits that aren't in ${refs.current} (the latest: "${b.subject}").`, "Undo brings it back, at the same commit."],
      confirm: "Delete branch",
    });
    if (yes) act("branch-delete", { name: b.name });
  }

  async function deleteTag(name) {
    const yes = await confirmDialog({ title: `Delete the tag ${name}?`, text: "Only here: a tag already pushed stays on the remote. Undo brings it back.", confirm: "Delete tag" });
    if (yes) act("tag-delete", { name });
  }

  function commitList(list, count) {
    return h("ul", { class: "git-preview-list" }, list.slice(0, 6).map((c) => h("li", null, h("span", { class: "mono dim" }, c.hash.slice(0, 7)), " ", c.subject)), count > 6 ? h("li", { class: "dim" }, `and ${count - 6} more`) : null);
  }

  function conflictNote(p) {
    if (!p.conflicts) return h("p", { class: "dim" }, "git here is too old to tell conflicts in advance (it needs 2.38).");
    if (!p.conflicts.length) return h("p", { class: "git-preview-ok" }, icon("check"), " No conflicts.");
    return h("p", { class: "git-preview-warn" }, icon("warn"), ` It will conflict in ${p.conflicts.slice(0, 5).join(", ")}${p.conflicts.length > 5 ? ` and ${p.conflicts.length - 5} more` : ""}: you'll pick a side for each block.`);
  }

  async function mergeFlow(name) {
    let p;
    try {
      p = await api(`/api/git/preview?dir=${encodeURIComponent(dir)}&branch=${encodeURIComponent(name)}`);
    } catch (err) {
      return toast(err.message, "error");
    }
    if (p.upToDate) return toast(`${p.current} already has everything from ${name}.`);
    const a = await askDialog({
      title: `Merge ${name} into ${p.current}?`,
      text: [h("p", null, `${plural(p.incomingCount, "commit")} from ${name} come${p.incomingCount === 1 ? "s" : ""} in:`), commitList(p.incoming, p.incomingCount), conflictNote(p)],
      choices: [
        { value: "merge", label: "Merge", kind: "primary" },
        { value: "squash", label: "Squash into one commit" },
        p.fastForward ? { value: "fast-forward", label: "Fast-forward" } : null,
      ].filter(Boolean),
    });
    if (a) act("merge", { branch: name, mode: a.choice });
  }

  async function rebaseFlow(onto) {
    let p;
    try {
      p = await api(`/api/git/preview?dir=${encodeURIComponent(dir)}&branch=${encodeURIComponent(onto)}`);
    } catch (err) {
      return toast(err.message, "error");
    }
    if (p.upToDate) return toast(`${p.current} already sits on top of ${onto}.`);
    const pushed = refs.branches.find((b) => b.current)?.upstream;
    const a = await askDialog({
      title: `Rebase ${p.current} onto ${onto}?`,
      text: [
        h("p", null, `Your ${plural(p.outgoingCount, "commit")} on ${p.current} are replayed on top of ${onto}, which has ${plural(p.incomingCount, "new commit")}:`),
        commitList(p.outgoing, p.outgoingCount),
        conflictNote(p),
        pushed ? h("p", { class: "dim" }, `${p.current} is pushed: after a rebase you'd force push it.`) : null,
      ],
      choices: [{ value: "rebase", label: "Rebase", kind: "primary" }],
    });
    if (a) act("rebase", { onto });
  }

  // ---------------------------------------------------------------- editing history

  async function openRebase(hash) {
    if ((status?.files ?? []).some((f) => !f.untracked)) return toast("Commit, shelve or discard your changes before editing history.", "error");
    let plan;
    try {
      plan = await api(`/api/git/rebase-plan?dir=${encodeURIComponent(dir)}&from=${hash}`);
    } catch (err) {
      return toast(err.message, "error");
    }
    rebase = { from: hash, steps: plan.commits.map((c) => ({ ...c, action: "pick", message: c.subject })) };
    renderRebase();
    rebasePanel.scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  function renderRebase() {
    if (!rebase) return rebasePanel.replaceChildren();
    const places = rememberPlaces(rebasePanel);
    const actions = [["pick", "Keep"], ["reword", "Reword"], ["squash", "Squash into the one above"], ["fixup", "Fold into the one above (drop its message)"], ["drop", "Drop"]];
    const list = h(
      "ol",
      { class: "git-steps" },
      rebase.steps.map((s, i) => {
        const select = h(
          "select",
          { "aria-label": `What happens to ${s.short}`, onchange: (e) => ((s.action = e.target.value), renderRebase()) },
          actions.map(([v, label]) => h("option", { value: v, selected: v === s.action, disabled: i === 0 && (v === "squash" || v === "fixup") }, label)),
        );
        const li = h(
          "li",
          { class: `git-step git-step-${s.action}`, draggable: "true", dataset: { key: `step:${s.hash}` } },
          h("span", { class: "git-step-grip", "aria-hidden": "true" }, "⋮⋮"),
          h("span", { class: "mono dim" }, s.short),
          s.action === "reword"
            ? h("input", { class: "input git-step-message", type: "text", value: s.message, "aria-label": `New message for ${s.short}`, oninput: (e) => (s.message = e.target.value) })
            : h("span", { class: "git-step-subject" }, s.subject),
          h("label", { class: "field" }, h("span", { class: "visually-hidden" }, "Action"), select),
          h(
            "span",
            { class: "git-step-move" },
            btn(null, () => moveStep(i, i - 1), { small: true, kind: "ghost", iconName: "up", name: `Move ${s.short} earlier`, title: "Earlier", disabled: i === 0 }),
            btn(null, () => moveStep(i, i + 1), { small: true, kind: "ghost", iconName: "down", name: `Move ${s.short} later`, title: "Later", disabled: i === rebase.steps.length - 1 }),
          ),
        );
        li.addEventListener("dragstart", (e) => startDrag(e, { kind: "step", index: i }, s.short));
        li.addEventListener("dragend", endDrag);
        dropTarget(li, (d) => d.kind === "step" && d.index !== i, (d, e) => {
          const box = li.getBoundingClientRect();
          moveStep(d.index, e.clientY < box.top + box.height / 2 ? (d.index < i ? i - 1 : i) : d.index < i ? i : i + 1);
        });
        return li;
      }),
    );
    const kept = rebase.steps.filter((s) => s.action !== "drop").length;
    const first = rebase.steps.find((s) => s.action !== "drop");
    const invalid = !kept || first.action === "squash" || first.action === "fixup";
    put(
      rebasePanel,
      h(
        "section",
        { class: "card card-pad section git-file", "aria-labelledby": "git-rebase-title" },
        h(
          "div",
          { class: "section-head" },
          h("div", { class: "git-file-title" }, h("h2", { class: "section-title", id: "git-rebase-title" }, `Edit history from ${rebase.from.slice(0, 7)}`), h("span", { class: "badge" }, plural(rebase.steps.length, "commit"))),
          h(
            "div",
            { class: "toolbar" },
            btn("Rewrite history", (ev) => runRebase(ev.currentTarget), { small: true, kind: "primary", iconName: "check", disabled: invalid }),
            btn("Cancel", () => ((rebase = null), renderRebase()), { small: true, kind: "ghost", iconName: "x" }),
          ),
        ),
        h("p", { class: "dim" }, "Oldest first, the order git replays them in. Drag a commit (or use the arrows) to move it; pick what happens to each. Undo puts everything back."),
        invalid ? h("p", { class: "git-preview-warn" }, icon("warn"), kept ? " The first commit kept can't be squashed: there's nothing above it." : " That drops every commit: use Go back here instead.") : null,
        list,
      ),
    );
    slideFromPlaces(rebasePanel, places);
  }

  function moveStep(from, to) {
    if (!rebase || to < 0 || to >= rebase.steps.length || from === to) return;
    const [s] = rebase.steps.splice(from, 1);
    rebase.steps.splice(to, 0, s);
    if (rebase.steps[0].action === "squash" || rebase.steps[0].action === "fixup") rebase.steps[0].action = "pick";
    renderRebase();
  }

  async function runRebase(button) {
    const pushed = refs?.branches.find((b) => b.current)?.upstream;
    const yes = await confirmDialog({
      title: "Rewrite this history?",
      text: [
        `${plural(rebase.steps.length, "commit")} are replayed in the new order, with your changes to each. Undo puts the branch back as it was.`,
        pushed ? `If these commits are already on ${pushed}, you'd force push afterwards.` : "",
      ].filter(Boolean),
      confirm: "Rewrite history",
      danger: false,
    });
    if (!yes) return;
    const r = await act(
      "rebase-run",
      { from: rebase.from, steps: rebase.steps.map((s) => ({ hash: s.hash, action: s.action, message: s.action === "reword" ? s.message : undefined })) },
      { button, busyText: "Rewriting…" },
    );
    if (r) {
      rebase = null;
      renderRebase();
    }
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
    historyList = h("ol", { class: `graph${drawIn && !reducedMotion.matches ? " graph-draw" : ""}`, "aria-label": "Commits, newest first" }, graph.commits.map((c, i) => graphRow(c, lanes, i)));
    // Once drawn, rows redrawn later (opening a commit) don't draw themselves in again.
    if (drawIn) setTimeout(() => historyList?.classList.remove("graph-draw"), 2000);
    drawIn = false;
    historyList.addEventListener("mouseover", (e) => {
      const li = e.target.closest?.(".graph-item");
      if (li && li.parentElement === historyList) glow([...historyList.children].indexOf(li));
    });
    historyList.addEventListener("mouseleave", clearGlow);
    put(
      history,
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
    renderBranches();
  }

  /** Lights up the path of the hovered commit's branch: its lane, up and down for as long as it runs. */
  function glow(index) {
    clearGlow();
    const rows = graph.commits.map((c) => c.row);
    const lane = rows[index]?.lane;
    if (lane === undefined || !historyList) return;
    const below = (r) => r.down.includes(lane) || r.through.includes(lane) || (r.moves ?? []).some(([, to]) => to === lane);
    const above = (r) => r.up.includes(lane) || r.through.includes(lane) || (r.moves ?? []).some(([from]) => from === lane);
    let lo = index;
    let hi = index;
    while (hi + 1 < rows.length && below(rows[hi])) hi++;
    while (lo > 0 && above(rows[lo])) lo--;
    const items = historyList.children;
    for (let i = lo; i <= hi; i++) for (const el of items[i]?.querySelectorAll(`.graph-cell [data-lane="${lane}"]`) ?? []) el.classList.add("hot");
    historyList.classList.add("hovering");
  }

  function clearGlow() {
    if (!historyList) return;
    historyList.classList.remove("hovering");
    for (const el of historyList.querySelectorAll(".hot")) el.classList.remove("hot");
  }

  function graphRow(c, lanes, index = 0) {
    const isOpen = openCommit === c.hash;
    const isHead = c.hash === (status?.head ?? graphHead);
    const li = h("li", { class: `graph-item${c.hash === newCommit ? " graph-new" : ""}${isOpen ? " open" : ""}${isHead ? " graph-head" : ""}`, dataset: { hash: c.hash }, draggable: "true" });
    li.style.setProperty("--lanes", String(lanes));
    li.style.setProperty("--i", String(Math.min(index, 40)));
    const pills = c.refs.map((r) => {
      const pill = refBadge(r, c.row.lane);
      if (r.kind === "branch" || r.kind === "remote") {
        pill.draggable = true;
        pill.addEventListener("dragstart", (e) => {
          e.stopPropagation();
          startDrag(e, { kind: "branch", name: r.name }, r.name);
        });
        pill.addEventListener("dragend", endDrag);
        if (r.kind === "branch") dropTarget(pill, (d) => acceptsOnBranch(d, r.name, !!r.current), (d) => dropOnBranch(d, r.name, !!r.current));
      }
      return pill;
    });
    const look = visualBy.get(c.hash);
    const row = h(
      "button",
      { type: "button", class: "graph-row", "aria-expanded": String(isOpen), onclick: () => toggleCommit(c, lanes) },
      graphCell(c.row, lanes, { merge: c.parents.length > 1, author: c.author, head: isHead, look: look?.changed === true }),
      h(
        "span",
        { class: "graph-text" },
        look ? visualThumb(look) : null,
        pills.length ? h("span", { class: "graph-refs" }, pills) : null,
        h("span", { class: "graph-subject" }, c.subject || "(no message)"),
      ),
      h("span", { class: "graph-author" }, c.author),
      h("span", { class: "graph-hash mono" }, c.short),
      h("time", { class: "graph-time", datetime: new Date(c.at).toISOString(), title: new Date(c.at).toLocaleString() }, relativeTime(c.at)),
    );
    li.append(row);
    li.addEventListener("dragstart", (e) => {
      if (drag) return;
      startDrag(e, { kind: "commit", hash: c.hash, subject: c.subject }, c.short);
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", endDrag);
    if (isOpen) li.append(commitDetail(c, lanes));
    return li;
  }

  function toggleCommit(c, lanes) {
    const previous = openCommit;
    openCommit = previous === c.hash ? null : c.hash;
    for (const hash of [previous, c.hash]) {
      const el = hash && historyList?.querySelector(`[data-hash="${hash}"]`);
      const index = hash ? graph.commits.findIndex((x) => x.hash === hash) : -1;
      if (el && index >= 0) el.replaceWith(graphRow(graph.commits[index], lanes, index));
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
        const onBranch = !!refs?.current;
        put(
          body,
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
          h(
            "div",
            { class: "toolbar git-commit-actions" },
            btn("Run this commit", (ev) => runCommit(d.hash, ev.currentTarget), { small: true, kind: "primary", iconName: "play", title: "Run the app as it was at this commit, next to your own dev server" }),
            btn("Revert", () => act("revert", { hash: d.hash }), { small: true, iconName: "refresh", title: "A new commit that undoes this one" }),
            btn(`Copy onto ${refs?.current ?? "this branch"}`, () => act("cherry-pick", { hash: d.hash }), { small: true, iconName: "copy", disabled: !onBranch }),
            btn("New branch here…", () => newBranchAt(d.hash), { small: true, kind: "ghost", iconName: "git" }),
            btn("Tag…", () => newTagAt(d.hash), { small: true, kind: "ghost", iconName: "tag" }),
            btn("Edit history from here…", () => openRebase(d.hash), { small: true, kind: "ghost", iconName: "log", disabled: !onBranch }),
            btn("Go back here…", () => goBackTo(d.hash, d.subject), { small: true, kind: "ghost", iconName: "left" }),
          ),
          visualBy.has(c.hash) ? visualViewer(visualBy.get(c.hash)) : null,
          d.files.length ? liveDetail(diffBlock(d.patch, { truncated: d.truncated })) : h("p", { class: "dim" }, "No file changes."),
        );
      } catch (err) {
        body.replaceChildren(errorView(err));
      }
    })();
    return box;
  }

  // ---------------------------------------------------------------- visual diff

  const visualImages = new Map(); // "commit|name|kind|at" → Promise of a data URL

  /** One capture's picture, fetched once: the dashboard reads it from ~/.dx/visual by commit and capture name. */
  function visualImage(commit, name, kind = "shot") {
    const k = `${commit}|${name ?? ""}|${kind}|${visualBy.get(commit)?.at ?? ""}`;
    if (!visualImages.has(k)) {
      if (visualImages.size > 80) visualImages.delete(visualImages.keys().next().value);
      const p = api(`/api/visual/image?dir=${encodeURIComponent(dir)}&commit=${commit}&kind=${kind}${name ? `&name=${encodeURIComponent(name)}` : ""}`).then((r) => r.image);
      p.catch(() => visualImages.delete(k));
      visualImages.set(k, p);
    }
    return visualImages.get(k);
  }

  /** An <img> that fills in when its picture arrives. */
  function visualImg(commit, name, kind, alt, cls = "visual-img") {
    const img = h("img", { class: cls, alt, decoding: "async", draggable: "false" });
    visualImage(commit, name, kind).then(
      (src) => (img.src = src),
      () => img.classList.add("visual-img-missing"),
    );
    return img;
  }

  function visualSummary(e) {
    const ok = e.captures.filter((c) => !c.error);
    if (!ok.length) return "No page could be captured";
    if (e.changed === undefined) return `${plural(ok.length, "page")} captured; nothing to compare with yet`;
    if (!e.changed) return `Looks the same as ${e.against.slice(0, 7)}`;
    const top = ok.filter((c) => c.changed).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0];
    return `On ${top.path}: ${top.text.charAt(0).toLowerCase()}${top.text.slice(1)}`;
  }

  /** The small picture in a commit's row: the first page as it looked. */
  function visualThumb(e) {
    const title = visualSummary(e);
    const cls = `graph-thumb${e.changed ? " changed" : ""}`;
    if (!e.thumb) return h("span", { class: `${cls} graph-thumb-icon`, title }, icon("image"), h("span", { class: "visually-hidden" }, title));
    const img = visualImg(e.commit, null, "thumb", title, cls);
    img.title = title;
    return img;
  }

  function renderVisualBar() {
    if (!visual) return visualBar.replaceChildren();
    const note = visual.capturing
      ? "Screenshotting the pages you use most…"
      : !visual.browser
        ? "Visual diffs need Chrome, Edge, Chromium or Brave on this computer."
        : !visual.target
          ? "Start the dev server from dx to capture how the app looks."
          : !visual.on
            ? "Captures after each commit are off in Health & settings."
            : visual.last
              ? `Last capture: ${visual.last.message}`
              : "Each commit is captured: the pages you use most, compared with the commit before.";
    put(
      visualBar,
      h("span", { class: "dim visual-note" }, visual.capturing ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon("image"), note),
      btn("Capture now", (ev) => captureNow(ev.currentTarget), {
        small: true,
        kind: "ghost",
        disabled: visual.capturing || !visual.target || !visual.browser,
        title: "Screenshot the pages you use most, as the dev server shows them now, and compare them with the commit before's",
      }),
    );
  }

  async function captureNow(button) {
    const r = await busy(button, "Starting…", () => api("/api/visual/capture", { method: "POST", body: { dir } }));
    if (!r) return;
    say("Capturing how the app looks…");
    await loadVisual();
  }

  async function loadVisual() {
    const forDir = dir;
    let v;
    try {
      v = await api(`/api/visual?dir=${encodeURIComponent(dir)}`);
    } catch {
      return; // visual diffs are extra: the rest of the page works without them
    }
    if (forDir !== dir || stopped) return;
    const wasCapturing = visual?.capturing;
    visual = v;
    renderVisualBar();
    if (wasCapturing && !v.capturing && v.last) {
      say(`Capture done: ${v.last.message}`);
      toast(v.last.ok ? `How it looks, ${v.last.message}` : `Couldn't capture how it looks: ${v.last.message}`, v.last.ok ? "ok" : "error");
    }
    const sig = v.commits.map((c) => `${c.commit}:${c.at}`).join(",");
    if (sig === visualSig) return;
    visualSig = sig;
    const before = visualBy;
    visualBy = new Map(v.commits.map((c) => [c.commit, c]));
    if (!graph?.commits.length || !historyList) return;
    // Only the rows whose captures changed are drawn again.
    const lanes = Math.min(MAX_LANES, Math.max(1, graph.width));
    graph.commits.forEach((c, i) => {
      if (before.get(c.hash)?.at === visualBy.get(c.hash)?.at) return;
      historyList.querySelector(`[data-hash="${c.hash}"]`)?.replaceWith(graphRow(c, lanes, i));
    });
  }

  /** Before and after for one commit: a wipe, side by side, or the changed pixels; Raw is the numbers and files. */
  function visualViewer(e) {
    let pick = (e.captures.find((c) => c.changed) ?? e.captures.find((c) => !c.error) ?? e.captures[0])?.name;
    let view = pref("visualView", "wipe");
    const body = h("div", { class: "visual-body" });
    const section = h(
      "section",
      {
        class: "visual",
        "aria-label": "How it looks",
        // Wiping and reading here shouldn't start dragging the commit.
        onpointerdown: () => {
          const li = section.closest(".graph-item");
          if (!li) return;
          li.draggable = false;
          window.addEventListener("pointerup", () => (li.draggable = true), { once: true });
        },
      },
      h("div", { class: "visual-head" }, h("strong", null, "How it looks"), h("span", { class: "dim" }, visualSummary(e))),
      body,
    );
    const draw = () => {
      const c = e.captures.find((x) => x.name === pick) ?? e.captures[0];
      put(
        body,
        e.captures.length > 1
          ? segmented("Page", e.captures.map((x) => [x.name, `${x.path}${x.viewport === "mobile" ? " (phone)" : ""}`]), pick, (v) => {
              pick = v;
              draw();
            })
          : null,
        liveDetail((mode) =>
          mode === "raw"
            ? visualRaw(e, c)
            : visualCapture(e, c, view, (v) => {
                view = v;
                setPref("visualView", v);
                draw();
              }),
        ),
      );
    };
    draw();
    return section;
  }

  function visualCapture(e, c, view, setView) {
    if (c.error) return h("p", { class: "visual-summary" }, icon("warn"), c.text);
    const at = (hash) => h("span", { class: "mono" }, hash.slice(0, 7));
    const summary = h(
      "p",
      { class: `visual-summary${c.changed ? " changed" : ""}` },
      icon(c.changed ? "warn" : c.changed === false ? "check" : "image"),
      h("span", null, c.text),
      e.against && c.changed !== undefined ? h("span", { class: "dim" }, " · against ", at(e.against)) : null,
    );
    const after = (cls) => visualImg(e.commit, c.name, "shot", `${c.path} at ${e.commit.slice(0, 7)}`, cls);
    if (!c.changed) return [summary, h("div", { class: "visual-frame" }, after())];
    const before = (cls) => visualImg(e.against, c.name, "shot", `${c.path} at ${e.against.slice(0, 7)}`, cls);
    const boxEl = () => {
      if (!c.box) return null;
      const b = h("div", { class: "visual-box", "aria-hidden": "true" });
      b.style.left = `${(c.box.x / c.width) * 100}%`;
      b.style.top = `${(c.box.y / c.height) * 100}%`;
      b.style.width = `${(c.box.width / c.width) * 100}%`;
      b.style.height = `${(c.box.height / c.height) * 100}%`;
      return b;
    };
    const fig = (label, hash, img) => h("figure", { class: "visual-fig" }, h("div", { class: "visual-frame" }, img), h("figcaption", { class: "dim" }, label, " · ", at(hash)));
    let stage;
    if (view === "side") {
      stage = h("div", { class: "visual-side" }, fig("Before", e.against, before()), fig("After", e.commit, after()));
    } else if (view === "diff") {
      stage = h("div", { class: "visual-frame" }, visualImg(e.commit, c.name, "diff", "The changed pixels in orange, over a faded copy of the page"), boxEl());
    } else {
      const top = after("visual-img visual-wipe-top");
      const handle = h("div", { class: "visual-wipe-handle", "aria-hidden": "true" });
      const set = (v) => {
        top.style.clipPath = `inset(0 0 0 ${v}%)`;
        handle.style.left = `${v}%`;
      };
      const range = h("input", { type: "range", min: "0", max: "100", value: "50", class: "visual-wipe-range", "aria-label": "Wipe between before (left) and after (right)", oninput: () => set(range.value) });
      set(50);
      stage = h(
        "div",
        { class: "visual-frame visual-wipe" },
        before(),
        top,
        boxEl(),
        range,
        handle,
        h("span", { class: "visual-tag visual-tag-before" }, "Before ", at(e.against)),
        h("span", { class: "visual-tag visual-tag-after" }, "After ", at(e.commit)),
      );
    }
    return [
      summary,
      segmented("Compare as", [["wipe", "Wipe"], ["side", "Side by side"], ["diff", "Changes"]], ["wipe", "side", "diff"].includes(view) ? view : "wipe", setView),
      stage,
    ];
  }

  function visualRaw(e, c) {
    const folder = visual?.folder ?? "";
    const sep = folder.includes("\\") ? "\\" : "/";
    const file = (hash, suffix = "") => [folder, hash, `${c.name}${suffix}.png`].join(sep);
    const text = JSON.stringify(
      {
        commit: e.commit,
        against: e.against ?? null,
        capturedAt: e.at,
        reason: e.reason ?? null,
        browser: e.browser ?? null,
        page: `${e.baseUrl ?? ""}${c.path}`,
        viewport: { name: c.viewport, width: c.width, height: c.height },
        status: c.status ?? null,
        changed: c.changed ?? null,
        ratio: c.ratio ?? null,
        box: c.box ?? null,
        label: c.label ?? null,
        error: c.error ?? null,
        files: {
          after: file(e.commit),
          before: e.against && c.changed !== undefined ? file(e.against) : null,
          diff: c.diff ? file(e.commit, ".diff") : null,
        },
      },
      null,
      2,
    );
    return h("section", { class: "detail-section" }, h("div", { class: "detail-head" }, h("strong", null, "The capture"), copyButton(text)), h("pre", { class: "log-snippet raw-text" }, text));
  }

  // ---------------------------------------------------------------- run any commit

  async function runSearch() {
    const q = commitSearch.value.trim();
    const seq = ++searchSeq;
    const forDir = dir;
    if (!q) {
      searchList = null;
      return searchResults.replaceChildren();
    }
    try {
      const list = await api(`/api/git/search?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(q)}&limit=30`);
      if (seq !== searchSeq || forDir !== dir || stopped) return;
      searchList = { q, list };
      renderSearch();
    } catch (err) {
      if (seq === searchSeq) searchResults.replaceChildren(errorView(err));
    }
  }

  function renderSearch() {
    if (!searchList) return searchResults.replaceChildren();
    const { q, list } = searchList;
    if (!list.length) return put(searchResults, h("p", { class: "dim commit-search-empty" }, `No commit matches "${q}".`));
    put(searchResults, h("ul", { class: "commit-results", "aria-label": `Commits matching ${q}` }, list.map(resultRow)));
  }

  function resultRow(c) {
    const snap = snapshots.find((s) => s.hash === c.hash);
    const files = c.files ?? [];
    return h(
      "li",
      { class: "commit-result" },
      h("span", { class: "graph-hash mono" }, c.short),
      h(
        "span",
        { class: "commit-result-text" },
        h("span", { class: "commit-result-subject" }, c.subject || "(no message)"),
        files.length ? h("span", { class: "dim mono commit-result-files", title: files.join("\n") }, files.slice(0, 2).join(", "), files.length > 2 ? ` +${files.length - 2}` : "") : null,
      ),
      h("span", { class: "dim commit-result-meta" }, `${c.author} · `, h("time", { datetime: new Date(c.at).toISOString(), title: new Date(c.at).toLocaleString() }, relativeTime(c.at))),
      h(
        "span",
        { class: "commit-result-actions" },
        snap
          ? snapshotBadge(snap)
          : btn("Run", (ev) => runCommit(c.hash, ev.currentTarget), { small: true, kind: "primary", iconName: "play", title: "Run this commit: the app as it was, next to your own dev server", name: `Run commit ${c.short}` }),
        btn("Show", () => showCommit(c.hash), { small: true, kind: "ghost", title: "Open it in the history below" }),
        actionMenu(
          "",
          [
            ["Revert", "refresh", () => act("revert", { hash: c.hash })],
            [`Copy onto ${refs?.current ?? "this branch"}`, "copy", () => act("cherry-pick", { hash: c.hash }), !refs?.current],
            ["New branch here…", "git", () => newBranchAt(c.hash)],
            ["Tag…", "tag", () => newTagAt(c.hash)],
            ["Edit history from here…", "log", () => openRebase(c.hash), !refs?.current],
            ["Go back here…", "left", () => goBackTo(c.hash, c.subject)],
          ],
          { name: `More for commit ${c.short}` },
        ),
      ),
    );
  }

  /** Opens a commit in the history and brings it into view. */
  function showCommit(hash) {
    const index = graph?.commits.findIndex((c) => c.hash === hash) ?? -1;
    if (index < 0) return toast("That commit is older than the ones shown. Use Show older commits below the history.");
    const lanes = Math.min(MAX_LANES, Math.max(1, graph.width));
    if (openCommit !== hash) toggleCommit(graph.commits[index], lanes);
    historyList?.querySelector(`[data-hash="${hash}"]`)?.scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  async function runCommit(hash, button) {
    const run = () => api("/api/snapshots/run", { method: "POST", body: { dir, hash } });
    let r;
    if (button) r = await busy(button, "Starting…", run);
    else r = await run().catch((err) => void toast(err.message, "error"));
    if (!r) return;
    const text = r.job ? `Setting up ${r.name}: ${r.job.step.toLowerCase()}…` : `${r.name} is running.`;
    toast(text);
    say(text);
    snapSig = "";
    await loadSnapshots();
  }

  async function loadSnapshots() {
    const forDir = dir;
    clearTimeout(snapTimer);
    let list;
    try {
      list = await api(`/api/snapshots?dir=${encodeURIComponent(dir)}`);
    } catch {
      return;
    }
    if (forDir !== dir || stopped) return;
    const sig = JSON.stringify(list);
    if (sig !== snapSig) {
      snapSig = sig;
      snapshots = list;
      renderSnapshots();
      if (searchList) renderSearch();
    }
    // Being set up or starting: follow it closely.
    if (list.some(snapshotPending)) snapTimer = setTimeout(loadSnapshots, 1000);
  }

  function renderSnapshots() {
    put(snapBody, snapshots.map((s) => snapshotRow(s, { onChange: () => ((snapSig = ""), loadSnapshots()) })));
  }

  // ---------------------------------------------------------------- loading

  function setStatus(fresh) {
    const moved = !status || fresh.head !== status.head || fresh.branch !== status.branch || fresh.operation !== status.operation;
    status = fresh;
    statusSig = JSON.stringify(fresh);
    renderHead();
    renderOperation();
    renderBoard();
    if (graph && fresh.head !== graphHead) loadGraph();
    if (moved && refs) {
      loadRefs();
      loadUndo();
    }
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

  async function loadRefs() {
    const forDir = dir;
    try {
      const r = await api(`/api/git/refs?dir=${encodeURIComponent(dir)}`);
      if (forDir !== dir || stopped) return;
      refs = r;
      renderBranches();
      renderShelf();
      if (status) renderHead();
    } catch (err) {
      put(branchesBody, h("div", { class: "card card-pad" }, errorView(err, () => loadRefs())));
    }
  }

  async function loadUndo() {
    const forDir = dir;
    try {
      const u = await api(`/api/git/undo?dir=${encodeURIComponent(dir)}`);
      if (forDir !== dir || stopped) return;
      undo = u;
      renderUndo();
      if (status) renderHead();
    } catch {
      // the undo list is a convenience: the rest of the page works without it
    }
  }

  async function load({ keep = false } = {}) {
    if (!keep) {
      message.value = drafts.get(dir) ?? "";
      amendBox.checked = false;
      openFile = null;
      openCommit = null;
      selected.clear();
      filePanel.replaceChildren();
      rebase = null;
      rebasePanel.replaceChildren();
      status = null;
      statusSig = "";
      graph = null;
      refs = null;
      undo = null;
      drawIn = true;
      limit = 200;
      history.replaceChildren(loadingView("Reading the history…"));
      renderBranches();
      renderUndo();
      snapshots = [];
      snapSig = "";
      searchList = null;
      snapBody.replaceChildren();
      searchResults.replaceChildren();
      if (commitSearch.value.trim()) void runSearch();
    }
    statusSig = "";
    if (!keep) {
      visual = null;
      visualSig = "";
      visualBy = new Map();
      visualBar.replaceChildren();
    }
    await Promise.all([loadStatus(), loadGraph(), loadRefs(), loadUndo(), loadSnapshots(), loadVisual()]);
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
      for (const el of root.querySelectorAll("section.section, details.git-undo")) el.hidden = true;
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
    if (!document.hidden && !drag && status) void loadSnapshots();
    if (!document.hidden && !drag && status) void loadVisual();
  }, 4000);
  const onFocus = () => !drag && !working && status && (loadStatus({ quiet: true }), loadRefs());
  window.addEventListener("focus", onFocus);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(snapTimer);
    clearTimeout(searchTimer);
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

/** An environment's badge: production stands out, so a click there isn't mistaken for one on staging. */
function envBadge(env) {
  if (!env || env === "local") return null;
  return h("span", { class: `badge ${env === "production" ? "badge-warn" : "badge-accent"}`, title: `Recorded on a ${env} site in the dx browser` }, env);
}

/** The address to open a recorded site at: http for this computer, https elsewhere; none for a wildcard. */
function siteUrl(host) {
  if (host.startsWith("*.")) return null;
  return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|[^:]+\.localhost)(:\d+)?$/i.test(host) ? `http://${host}/` : `https://${host}/`;
}

function activityPage(root) {
  // What's shown: everything (""), one project ("p:<dir>") or a recorded site of its own ("s:<host>").
  let sel = pref("activitySel", null) ?? (pref("activityDir", "") ? `p:${pref("activityDir", "")}` : "");
  // Linked from the AI lane: #/activity?dir=…&who=ai
  const linked = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (linked.get("dir")) sel = `p:${linked.get("dir")}`;
  // "By AI": only the agent's page checks, with its other calls through dx in between.
  let who = (linked.get("who") ?? pref("activityWho", "")) === "ai" ? "ai" : "";
  if (linked.has("dir") || linked.has("who")) {
    // Remembered like a choice made here, and the address goes back to plain #/activity.
    setPref("activitySel", sel);
    setPref("activityWho", who);
    history.replaceState(null, "", "#/activity");
  }
  let aiRuns = [];
  let aiSig = "";
  let dir = sel.startsWith("p:") ? sel.slice(2) : "";
  let siteKey = sel.startsWith("s:") ? sel.slice(2) : "";
  let view = pref("activityView", "sessions");
  if (!ACTIVITY_VIEWS.some(([v]) => v === view)) view = "sessions";
  let since = pref("activitySince", "today");
  let envFilter = "";
  let search = "";
  let events = [];
  let shown = []; // events after the environment filter
  let lastId = 0;
  let projects = [];
  let overviewData = { entries: [], sites: [], browser: { open: false, found: true, recording: true } };
  let overviewAt = 0;
  let stopped = false;
  let searchTimer = 0;
  const replays = new Map(); // visit key -> what its last replay found

  // Mock mode for the project shown: its set (without whole bodies) and the endpoint being edited.
  let mocks = null;
  let mockEdit = null; // { id, el }
  const mockHolder = h("div", { class: "mock-holder" });

  // A bug bundle someone sent, opened from a file: shown next to what replaying it finds now.
  let bundleState = null; // { bundle, name, dir, use, job }
  const bundleHolder = h("div", { class: "bundle-holder" });
  const bundleInput = h("input", {
    type: "file",
    accept: ".json,application/json",
    hidden: true,
    "aria-label": "Bug bundle file",
    onchange: () => {
      const f = bundleInput.files?.[0];
      bundleInput.value = "";
      if (f) void openBundleFile(f);
    },
  });
  const openBundle = btn("Open a bug bundle", () => bundleInput.click(), { iconName: "folder", title: "Open a .dxbug.json file a teammate sent and replay it on your own dev server. You can also drop the file on this page." });
  const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes("Files");
  const onDragOver = (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    root.classList.add("drop-active");
  };
  const onDragLeave = (ev) => {
    if (!ev.relatedTarget || !root.contains(ev.relatedTarget)) root.classList.remove("drop-active");
  };
  const onDrop = (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    root.classList.remove("drop-active");
    const f = ev.dataTransfer.files?.[0];
    if (f) void openBundleFile(f);
  };
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);
  const commits = new Map(); // "dir|hash" -> the commit, null when the project doesn't have it, or "…" while asking

  // Time travel: a moment among the events shown, what happened around it, and the commit HEAD was on then.
  let moment = null; // ms, or null when off
  let ttTimer = 0;
  let ttSeq = 0;
  let ttFound = null; // { at, dir, name, commit }
  const ttRange = h("input", {
    type: "range",
    class: "tt-range",
    min: "0",
    max: "1000",
    step: "1",
    value: "1000",
    "aria-label": "Time travel: pick a moment in the history",
    oninput: () => scrub(false),
    onchange: () => scrub(true),
  });
  const ttTime = h("span", { class: "tt-time mono", "aria-live": "polite" }, "Drag to a moment");
  const ttInfo = h("span", { class: "tt-info" });
  const ttOff = btn("", () => leaveMoment(), { small: true, kind: "ghost", iconName: "x", name: "Leave time travel" });
  ttOff.hidden = true;
  const ttBar = h("div", { class: "card tt", hidden: true }, h("span", { class: "tt-label" }, icon("activity"), "Time travel"), ttRange, ttTime, ttInfo, ttOff);

  const holder = h("div", { class: "card activity-compact" }, loadingView("Reading the history…"));
  const hint = h("div", { class: "section", "aria-live": "polite" });
  const navList = h("ul", { class: "activity-nav-list", "aria-label": "Projects and sites" });
  const browserLine = h("div", { class: "activity-browser", "aria-live": "polite" });
  const envHolder = h("div", { class: "activity-envs" });
  let envKey = "";
  const viewPicker = segmented("View", ACTIVITY_VIEWS, view, (v) => ((view = v), setPref("activityView", v), render()));
  viewPicker.classList.add("segmented-wrap");
  const opened = new Set(); // API endpoints and errors opened, by key
  let openRows = new Set(); // single events opened, by id
  // Under 860px the list becomes this select.
  const projectSelect = h("select", { class: "activity-nav-select", "aria-label": "Project or site", onchange: (e) => choose(e.target.value) });
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
      const name = dir ? (projects.find((p) => p.dir === dir)?.name ?? "this project") : siteKey ? siteKey : "every project and site";
      const yes = await confirmDialog({ title: "Clear the history?", text: `This deletes the recorded requests, routes, clicks, console output and errors of ${name}. It can't be undone.`, confirm: "Clear history" });
      if (!yes) return;
      const r = await busy(button, "Clearing…", () => api("/api/activity/clear", { method: "POST", body: dir ? { dir } : siteKey ? { site: siteKey } : {} }));
      if (!r) return;
      toast("History cleared");
      load();
    },
    { kind: "danger-ghost", iconName: "cleanup", small: true },
  );

  // Record a site: its host, the project it belongs to, and which environment it is.
  const siteForm = h("form", { class: "card card-pad site-form", hidden: true, onsubmit: (ev) => void addSite(ev) });
  const hostInput = h("input", { class: "input", name: "host", required: true, placeholder: "staging.shop-website.dev", autocomplete: "off", spellcheck: "false" });
  const siteProject = h("select", { class: "input", name: "project" }, h("option", { value: "" }, "No project"));
  const envInput = h("input", { class: "input", name: "env", list: "activity-env-names", placeholder: "Guessed from the name", autocomplete: "off" });
  const labelInput = h("input", { class: "input", name: "label", placeholder: "Optional", autocomplete: "off" });
  append(
    siteForm,
    h("h2", { class: "site-form-title" }, "Record a site"),
    h("p", { class: "dim" }, "The dx browser records this site like your local apps: requests and responses, routes, clicks, console and errors, with passwords and tokens masked. Nothing else you browse there is recorded."),
    h(
      "div",
      { class: "form-grid" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Host"), hostInput, h("span", { class: "field-hint" }, "A name or name:port, no path. *.shop-website.dev for every subdomain.")),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Project"), siteProject, h("span", { class: "field-hint" }, "Its activity shows under the project, next to your local runs.")),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Environment"), envInput),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Label"), labelInput),
    ),
    h("datalist", { id: "activity-env-names" }, ["staging", "production", "preview", "qa", "dev", "local"].map((v) => h("option", { value: v }))),
    h("div", { class: "form-actions" }, btn("Record this site", null, { type: "submit", kind: "primary", iconName: "check" }), btn("Cancel", () => (siteForm.hidden = true), { kind: "ghost" })),
  );

  async function addSite(ev) {
    ev.preventDefault();
    const button = siteForm.querySelector("button[type=submit]");
    const r = await busy(button, "Saving…", () =>
      api("/api/sites/add", { method: "POST", body: { host: hostInput.value, dir: siteProject.value || undefined, env: envInput.value || undefined, label: labelInput.value || undefined } }),
    );
    if (!r) return;
    siteForm.reset();
    siteForm.hidden = true;
    toast(`Recording ${r.host} (${r.env}) in the dx browser${r.projectName ? `, under ${r.projectName}` : ""}.`);
    await loadOverview(true);
  }

  const openBrowser = btn("Open dx browser", (ev) => void browserOpen(ev.currentTarget), {
    kind: "primary",
    iconName: "external",
    title: "A browser window with its own profile that records the sites you chose, and apps on this computer",
  });
  const recordSite = btn(
    "Record a site",
    () => {
      siteForm.hidden = !siteForm.hidden;
      if (!siteForm.hidden) hostInput.focus();
    },
    { iconName: "new", title: "Add a deployed site (staging, production) for the dx browser to record" },
  );

  append(
    root,
    pageHead(
      "Activity",
      "What happened in your apps, here and deployed: each visit's steps, every API with its payloads and responses, errors and console output.",
      openBrowser,
      recordSite,
      openBundle,
      bundleInput,
    ),
    siteForm,
    h(
      "div",
      { class: "activity-layout" },
      h(
        "aside",
        { class: "card activity-nav" },
        browserLine,
        h("label", { class: "field activity-nav-pick" }, h("span", { class: "visually-hidden" }, "Project or site"), projectSelect),
        navList,
      ),
      h(
        "div",
        { class: "activity-main" },
        h(
          "div",
          { class: "card card-pad toolbar activity-tools" },
          viewPicker,
          segmented("Since", [["1h", "Last hour"], ["today", "Today"], ["7d", "7 days"]], since, (v) => ((since = v), setPref("activitySince", v), load())),
          segmented("Who", [["", "Everyone"], ["ai", "By AI"]], who, (v) => ((who = v), setPref("activityWho", v), void loadAiRuns().then(render))),
          envHolder,
          searchInput,
          clear,
        ),
        bundleHolder,
        mockHolder,
        ttBar,
        hint,
        holder,
      ),
    ),
  );

  function choose(value) {
    sel = value;
    dir = sel.startsWith("p:") ? sel.slice(2) : "";
    siteKey = sel.startsWith("s:") ? sel.slice(2) : "";
    envFilter = "";
    envKey = "";
    aiSig = "";
    setPref("activitySel", sel);
    setPref("activityDir", dir);
    if (moment !== null) leaveMoment();
    mockEdit = null;
    renderNav();
    load();
    void loadMocks();
  }

  async function browserOpen(button, url) {
    const r = await busy(button, "Opening…", () => api("/api/browser/open", { method: "POST", body: url ? { url } : {} }));
    if (!r) return;
    overviewData.browser = r;
    renderBrowserLine();
    toast(url ? `Opened ${new URL(url).host} in the dx browser` : "The dx browser is open. Sign-ins there stay in its own profile.");
  }

  async function browserClose(button) {
    const r = await busy(button, "Closing…", () => api("/api/browser/close", { method: "POST" }));
    if (!r) return;
    overviewData.browser = r;
    renderBrowserLine();
  }

  async function removeSite(button, s) {
    const yes = await confirmDialog({
      title: `Stop recording ${s.host}?`,
      text: "The dx browser stops recording it. What was recorded stays in the history until you clear it or it gets old.",
      confirm: "Stop recording",
      danger: false,
    });
    if (!yes) return;
    const r = await busy(button, "Removing…", () => api("/api/sites/remove", { method: "POST", body: { host: s.host } }));
    if (!r) return;
    toast(`Stopped recording ${s.host}`);
    await loadOverview(true);
  }

  async function loadOverview(force = false) {
    if (!force && Date.now() - overviewAt < 5000) return;
    overviewAt = Date.now();
    try {
      overviewData = await api(`/api/activity/overview?since=${encodeURIComponent(since)}`);
      if (!stopped) renderNav();
    } catch {
      // the list keeps what it had
    }
  }

  function renderBrowserLine() {
    const b = overviewData.browser ?? {};
    openBrowser.hidden = !!b.open;
    if (b.open) {
      browserLine.replaceChildren(
        h("span", { class: "activity-browser-state" }, h("span", { class: "dot", "aria-hidden": "true" }), `dx browser open${b.browser ? ` (${b.browser}` : ""}${b.pages !== undefined ? `, ${plural(b.pages, "tab")})` : b.browser ? ")" : ""}`),
        btn("Close", (ev) => void browserClose(ev.currentTarget), { small: true, kind: "ghost", iconName: "x", name: "Close the dx browser" }),
      );
    } else if (!b.found) {
      browserLine.replaceChildren(h("p", { class: "dim" }, "The dx browser needs Chrome, Edge, Chromium or Brave. dx doctor says how to install one."));
    } else browserLine.replaceChildren();
    if (b.recording === false) browserLine.append(h("p", { class: "dim" }, "The history is off, so nothing is recorded. Turn it on in Health & settings."));
  }

  /** The list on the left: everything, each project (with the sites linked to it), and sites of their own. */
  function renderNav() {
    renderBrowserLine();
    const entries = overviewData.entries ?? [];
    const sites = overviewData.sites ?? [];
    const norm = (d) => d.toLowerCase();
    const byDir = new Map();
    const ensure = (d, name) => byDir.get(norm(d)) ?? byDir.set(norm(d), { dir: d, project: name, events: 0, problems: 0, last: null, envs: {}, sitesSeen: {}, linked: [] }).get(norm(d));
    for (const e of entries) Object.assign(ensure(e.dir, e.project), { project: e.project, events: e.events, problems: e.problems, last: e.last, envs: e.envs, sitesSeen: e.sites });
    for (const s of sites) {
      if (s.project) ensure(s.project, s.projectName ?? s.project).linked.push(s);
      else ensure(`site:${s.host}`, s.label || s.host).own = s;
    }
    if (dir && !byDir.has(norm(dir))) ensure(dir, projects.find((p) => p.dir === dir)?.name ?? dir);
    if (siteKey && !byDir.has(norm(`site:${siteKey}`))) ensure(`site:${siteKey}`, siteKey);
    const all = [...byDir.values()];
    const local = all.filter((x) => !x.dir.startsWith("site:")).sort((a, b) => (Date.parse(b.last ?? 0) || 0) - (Date.parse(a.last ?? 0) || 0) || a.project.localeCompare(b.project));
    const own = all.filter((x) => x.dir.startsWith("site:")).sort((a, b) => (Date.parse(b.last ?? 0) || 0) - (Date.parse(a.last ?? 0) || 0));
    const total = entries.reduce((n, e) => n + e.events, 0);
    const totalProblems = entries.reduce((n, e) => n + e.problems, 0);

    const counts = (events, problems) =>
      h("span", { class: "activity-nav-counts" }, h("span", { class: "dim" }, String(events)), problems ? h("span", { class: "badge badge-danger", title: plural(problems, "problem") }, String(problems)) : null);
    const item = (value, title, events, problems, extra = [], sub = null) =>
      h(
        "li",
        null,
        h(
          "button",
          { type: "button", class: "activity-nav-item", "aria-current": sel === value ? "true" : undefined, onclick: () => choose(value), title: `Show ${title}` },
          h("span", { class: "activity-nav-name" }, title),
          extra,
          counts(events, problems),
        ),
        sub,
      );
    const siteLine = (s, seen) =>
      h(
        "li",
        { class: "activity-site" },
        envBadge(s.env) ?? h("span", { class: "badge" }, s.env ?? "local"),
        h("span", { class: "mono activity-site-host", title: s.label ? `${s.label} (${s.host})` : s.host }, s.label || s.host),
        seen ? counts(seen.events, seen.problems) : h("span", { class: "dim" }, "0"),
        siteUrl(s.host) ? btn("", (ev) => void browserOpen(ev.currentTarget, siteUrl(s.host)), { small: true, kind: "ghost", iconName: "external", name: `Open ${s.host} in the dx browser`, title: "Open in the dx browser" }) : null,
        btn("", (ev) => void removeSite(ev.currentTarget, s), { small: true, kind: "ghost", iconName: "x", name: `Stop recording ${s.host}`, title: "Stop recording this site" }),
      );
    const seenFor = (x, host) => {
      const list = Object.entries(x.sitesSeen ?? {}).filter(([k]) => (host.startsWith("*.") ? k.endsWith(host.slice(1)) : k === host || k.split(":")[0] === host));
      return list.length ? { events: list.reduce((n, [, v]) => n + v.events, 0), problems: list.reduce((n, [, v]) => n + v.problems, 0) } : undefined;
    };

    navList.replaceChildren();
    append(
      navList,
      item("", "All activity", total, totalProblems),
      local.length ? h("li", { class: "activity-nav-head" }, "Projects") : null,
      local.map((x) => {
        const envs = Object.keys(x.envs ?? {}).filter((e) => e !== "local");
        const mocked = projects.find((p) => p.dir.toLowerCase() === x.dir.toLowerCase())?.mocks;
        const mockTag = mocked?.on ? h("span", { class: "badge badge-warn", title: `Mock mode is on: ${plural(mocked.enabled, "endpoint")} answered by dx` }, "Mocked") : null;
        return item(`p:${x.dir}`, x.project, x.events, x.problems, [...envs.map(envBadge), mockTag], x.linked.length ? h("ul", { class: "activity-sites" }, x.linked.map((s) => siteLine(s, seenFor(x, s.host)))) : null);
      }),
      own.length ? h("li", { class: "activity-nav-head" }, "Sites") : null,
      own.map((x) => {
        const host = x.dir.slice(5);
        const s = x.own;
        const env = s?.env ?? Object.keys(x.envs ?? {})[0];
        return item(
          `s:${host}`,
          x.project,
          x.events,
          x.problems,
          [envBadge(env)],
          s ? h("ul", { class: "activity-sites" }, siteLine(s, x.events ? { events: x.events, problems: x.problems } : undefined)) : null,
        );
      }),
      !sites.length
        ? h("li", { class: "activity-nav-empty dim" }, "Deployed sites you record show up here. ", h("button", { type: "button", class: "link-button", onclick: () => ((siteForm.hidden = false), hostInput.focus()) }, "Record a site"))
        : null,
    );

    projectSelect.replaceChildren();
    append(
      projectSelect,
      h("option", { value: "", selected: sel === "" }, `All activity (${total})`),
      local.length ? h("optgroup", { label: "Projects" }, local.map((x) => h("option", { value: `p:${x.dir}`, selected: sel === `p:${x.dir}` }, `${x.project} (${x.events})`))) : null,
      own.length ? h("optgroup", { label: "Sites" }, own.map((x) => h("option", { value: `s:${x.dir.slice(5)}`, selected: sel === `s:${x.dir.slice(5)}` }, `${x.project} (${x.events})`))) : null,
    );
  }

  /** Filters for local and each environment, when the events shown have more than one. */
  function renderEnvs() {
    const envs = [...new Set(events.map((e) => e.env ?? "local"))].sort((a, b) => (a === "local" ? -1 : b === "local" ? 1 : a.localeCompare(b)));
    if (envFilter && !envs.includes(envFilter)) envFilter = "";
    const key = `${envs.join(",")}|${envFilter}`;
    if (key === envKey) return;
    envKey = key;
    envHolder.replaceChildren();
    if (envs.length > 1) envHolder.append(segmented("Environment", [["", "All"], ...envs.map((e) => [e, e === "local" ? "Local" : e])], envFilter, (v) => ((envFilter = v), (envKey = ""), render())));
  }

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
    else if (siteKey) q.set("site", siteKey);
    if (search) q.set("q", search);
    return q;
  }

  /** The AI agent's calls through dx for what's shown, when "By AI" is on. True when they changed. */
  async function loadAiRuns() {
    if (who !== "ai" || siteKey) {
      const changed = aiRuns.length > 0;
      aiRuns = [];
      aiSig = "";
      return changed;
    }
    try {
      const r = await api(`/api/ai?limit=500${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`);
      const sig = `${r.calls.length}|${r.calls[0]?.at ?? ""}`;
      if (sig === aiSig) return false;
      aiSig = sig;
      aiRuns = r.calls;
      return true;
    } catch {
      return false;
    }
  }

  /** The start of the time shown, in ms, as the server reads "1h", "today" and "7d". */
  function sinceMs() {
    const now = new Date();
    if (since === "1h") return now.getTime() - 3600_000;
    if (since === "7d") return now.getTime() - 7 * 86_400_000;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  function aiInWindow() {
    const from = sinceMs();
    const q = search.toLowerCase();
    return aiRuns.filter((r) => Date.parse(r.at) >= from && (!q || `${r.text} ${r.args ?? ""}`.toLowerCase().includes(q)));
  }

  /** A headless page check is the agent's when one of its check_url or replay_visit calls was running then. */
  function isAiEvent(e) {
    if (e.from !== "check") return false;
    const t = Date.parse(e.at);
    return aiRuns.some((r) => {
      if (r.tool !== "check_url" && r.tool !== "replay_visit") return false;
      if (r.dir && r.dir.toLowerCase() !== String(e.dir).toLowerCase()) return false;
      const end = Date.parse(r.at);
      return t >= end - (r.ms ?? 0) - 3000 && t <= end + 5000;
    });
  }

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    void loadOverview(true);
    try {
      const [list] = await Promise.all([api(`/api/activity?${query({ since })}`), loadAiRuns()]);
      if (seq !== loadSeq || stopped) return;
      events = list;
      lastId = Math.max(lastId, ...events.map((e) => e.id));
      render();
      void updateHint();
    } catch (err) {
      if (seq === loadSeq) holder.replaceChildren(errorView(err, load));
    }
  }

  async function poll() {
    if (stopped) return;
    if (document.visibilityState === "visible" && (lastId || who === "ai")) {
      try {
        const next = lastId ? await api(`/api/activity?${query({ after: String(lastId) })}`) : [];
        if (!stopped && next.length) {
          // In the order things happened: a page's clicks arrive a moment after the requests they caused.
          events = [...events, ...next].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id).slice(-2000);
          lastId = Math.max(lastId, ...next.map((e) => e.id));
          if (who === "ai") await loadAiRuns();
          render();
          if (hint.childElementCount) void updateHint();
          void loadOverview();
        } else if (!stopped && who === "ai" && (await loadAiRuns())) render();
      } catch {
        // the next poll tries again
      }
    }
    if (!stopped) setTimeout(poll, 2000);
  }

  function render() {
    renderEnvs();
    shown = envFilter ? events.filter((e) => (e.env ?? "local") === envFilter) : events;
    if (who === "ai") shown = shown.filter(isAiEvent);
    updateTimeTravel();
    if (who === "ai" && !shown.length && !(view === "sessions" && aiInWindow().length)) {
      holder.replaceChildren(
        stateView(
          "Nothing from your AI agent here",
          siteKey
            ? "AI agents work on your local apps through dx; recorded sites show what you did in the dx browser."
            : "When an agent runs, checks or replays your app through dx's MCP tools, its page checks show here, with its other calls in between. The AI lane at the right edge follows it live.",
          btn("Show everyone's", () => ((who = ""), setPref("activityWho", ""), route()), { small: true }),
        ),
      );
      return;
    }
    if (!shown.length && who !== "ai") {
      const site = siteKey ? (overviewData.sites ?? []).find((s) => s.host === siteKey) : undefined;
      holder.replaceChildren(
        stateView(
          search ? "Nothing matches" : "Nothing recorded yet",
          search
            ? "Try other words, or a longer time."
            : siteKey
              ? `Open ${siteKey} in the dx browser and use it: its requests, routes, clicks, console output and errors show up here.`
              : "Start an app from the Projects page and open it in your browser, or open a deployed site in the dx browser. Its requests, routes, clicks, console output and errors show up here as they happen.",
          search
            ? null
            : siteKey && site && siteUrl(site.host)
              ? btn("Open in the dx browser", (ev) => void browserOpen(ev.currentTarget, siteUrl(site.host)), { kind: "primary", iconName: "external" })
              : siteKey
                ? null
                : h("a", { class: "btn", href: "#/projects" }, "Go to projects"),
        ),
      );
      return;
    }
    const many = !dir && !siteKey && new Set(shown.map((e) => e.dir)).size > 1;
    // Rows people opened stay open when new events come in.
    openRows = new Set([...holder.querySelectorAll("details[open][data-id]")].map((d) => d.dataset.id));
    if (view === "apis") renderApis(many);
    else if (view === "errors") renderErrors(many);
    else if (view === "console") renderConsole(many);
    else renderSessions(many);
    if (moment !== null) markMoment(false);
  }

  // ---------------------------------------------------------------- time travel

  /** The first and last event's time, when they're at least a second apart. */
  function spanOf() {
    if (shown.length < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of shown) {
      const t = Date.parse(e.at);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return hi - lo >= 1000 ? [lo, hi] : null;
  }

  function clock(ms) {
    const s = spanOf();
    const days = s && new Date(s[0]).toDateString() !== new Date(s[1]).toDateString();
    return new Date(ms).toLocaleString([], days ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function updateTimeTravel() {
    const s = spanOf();
    ttBar.hidden = !s;
    if (!s || moment === null) return;
    moment = Math.min(s[1], Math.max(s[0], moment));
    ttRange.value = String(Math.round(((moment - s[0]) / (s[1] - s[0])) * 1000));
  }

  function scrub(settle) {
    const s = spanOf();
    if (!s) return;
    moment = s[0] + (Number(ttRange.value) / 1000) * (s[1] - s[0]);
    ttTime.textContent = clock(moment);
    ttOff.hidden = false;
    markMoment(settle);
    clearTimeout(ttTimer);
    ttTimer = setTimeout(() => lookUp(moment), settle ? 0 : 250);
  }

  function leaveMoment() {
    moment = null;
    ttFound = null;
    ttSeq++;
    ttRange.value = "1000";
    ttTime.textContent = "Drag to a moment";
    ttInfo.replaceChildren();
    ttOff.hidden = true;
    markMoment(false);
  }

  /** How close to the moment an event must be to count as around it. */
  function nearMs() {
    const s = spanOf();
    return s ? Math.max(30_000, (s[1] - s[0]) / 60) : 30_000;
  }

  /** Lights up the events around the moment; when the slider is let go, opens the visit there and scrolls to it. */
  function markMoment(settle) {
    const near = nearMs();
    for (const el of holder.querySelectorAll("[data-at]")) el.classList.toggle("tt-near", moment !== null && Math.abs(Number(el.dataset.at) - moment) <= near);
    for (const el of holder.querySelectorAll("details[data-from]")) {
      const inside = moment !== null && moment >= Number(el.dataset.from) - near && moment <= Number(el.dataset.to) + near;
      el.classList.toggle("tt-near", inside);
      if (settle && inside) el.open = true;
    }
    if (settle) (holder.querySelector("li.tt-near") ?? holder.querySelector(".tt-near"))?.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  /** The git project to look in: the one shown, or the one whose event is nearest the moment. */
  function ttProject(at) {
    const gits = new Map(projects.filter((p) => p.hasGit).map((p) => [p.dir, p]));
    if (dir) return gits.get(dir);
    if (siteKey) return undefined; // a site of its own has no repository here
    let best;
    let bestD = Infinity;
    for (const e of shown) {
      const p = gits.get(e.dir);
      const d = Math.abs(Date.parse(e.at) - at);
      if (p && d < bestD) [best, bestD] = [p, d];
    }
    return best;
  }

  async function lookUp(at) {
    const seq = ++ttSeq;
    const target = ttProject(at);
    if (!target) return ttInfo.replaceChildren(h("span", { class: "dim" }, "No git project in the history at that moment."));
    try {
      const c = await api(`/api/git/at?dir=${encodeURIComponent(target.dir)}&at=${Math.round(at)}`);
      if (seq !== ttSeq || stopped) return;
      ttFound = { at, dir: target.dir, name: target.name, commit: c };
      renderMoment();
    } catch (err) {
      if (seq === ttSeq) ttInfo.replaceChildren(h("span", { class: "dim" }, err.message));
    }
  }

  function renderMoment() {
    const { at, dir: d, name, commit: c } = ttFound;
    if (!c) return ttInfo.replaceChildren(h("span", { class: "dim" }, `${name} had no commits yet at ${clock(at)}.`));
    ttInfo.replaceChildren(
      h(
        "span",
        { class: "tt-text", title: c.from === "reflog" ? "From git's record of where HEAD was" : "The last commit before then" },
        dir ? null : h("span", { class: "badge" }, name),
        ` At ${clock(at)} you were on `,
        h("strong", { class: "mono" }, c.short),
        " ",
        h("span", { class: "tt-subject" }, c.subject || "(no message)"),
      ),
      btn("Run it as it was then", (ev) => runThen(ev.currentTarget, d, c), {
        small: true,
        kind: "primary",
        iconName: "play",
        title: "Check that commit out in its own folder under ~/.dx/snapshots and run it, next to your own dev server",
      }),
    );
  }

  async function runThen(button, d, c) {
    const r = await busy(button, "Starting…", () => api("/api/snapshots/run", { method: "POST", body: { dir: d, hash: c.hash } }));
    if (r) toast(`${r.job ? `Setting up ${r.name}` : `${r.name} is running`}. It's on the Projects page, with its output.`);
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
    for (const e of shown) {
      if (e.type !== "request") continue;
      // Staging's /api/cart and your own are told apart.
      const key = `${e.dir}|${e.env ?? "local"}|${endpointOf(e)}`;
      const g = groups.get(key) ?? groups.set(key, { key, endpoint: endpointOf(e), project: e.project, service: e.service, env: e.env, calls: [] }).get(key);
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
                envBadge(g.env),
                g.service ? h("span", { class: "badge" }, g.service) : null,
                mocks?.endpoints.some((m) => m.enabled && `${m.method} ${m.path}` === g.endpoint)
                  ? h("span", { class: `badge ${mocks.on ? "badge-warn" : ""}`, title: mocks.on ? "Answered by dx's mock mode while it's on" : "Has a mock; mock mode is off" }, mocks.on ? "mocked" : "mock ready")
                  : null,
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
    for (const e of shown) {
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
          // Exceptions, server errors and console errors can go to Claude (the newest time it happened), in git projects.
          const fixable = (last.type === "error" || last.type === "server-error" || (last.type === "console" && last.level === "error")) && projects.find((p) => p.dir.toLowerCase() === last.dir.toLowerCase())?.hasGit;
          const fixer = fixable ? fixControls(last.dir, "activity", last.id, last.text.split("\n")[0], g.key) : null;
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
            fixer ? h("div", { class: "error-fix" }, h("div", { class: "toolbar" }, fixer.button), fixer.panel) : null,
            h("ul", { class: "activity-list api-calls" }, [...g.all].reverse().slice(0, 20).map((e) => activityRow(e, false, openRows.has(String(e.id))))),
          );
        }),
      ),
    );
  }

  /** Console output, newest first; the same line repeated is one row with a count. */
  function renderConsole(many) {
    const lines = shown.filter((e) => e.type === "console");
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
    const groups = visitsOf(shown);
    // "By AI": the agent's other calls through dx sit between its page checks, in time order.
    const items = [...groups.map((g) => ({ at: Date.parse(g.events[0].at), g })), ...(who === "ai" ? aiInWindow().map((r) => ({ at: Date.parse(r.at), r })) : [])].sort((a, b) => a.at - b.at);
    const byDay = new Map();
    for (const item of items) {
      const d = new Date(item.at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      (byDay.get(key) ?? byDay.set(key, []).get(key)).push(item);
    }
    const newest = groups[groups.length - 1]?.key;
    holder.replaceChildren(
      ...[...byDay.entries()].reverse().map(([day, list]) =>
        h(
          "section",
          { class: "day" },
          h("h2", { class: "day-title" }, dayLabel(day)),
          [...list].reverse().map(({ g, r }) => (g ? visitView(g, many, seen ? open.has(g.key) : g.key === newest || g.problems > 0, open) : aiRunRow(r, many))),
        ),
      ),
    );
  }

  /** One of the agent's calls, between the visits: what it did, when, and what it asked. */
  function aiRunRow(r, many) {
    const at = Date.parse(r.at);
    return h(
      "div",
      { class: "ai-run", dataset: { at: String(at) } },
      icon("ai"),
      h("span", { class: "ai-run-time mono" }, new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })),
      h("span", { class: "ai-run-text" }, r.text),
      many && r.project ? h("span", { class: "badge" }, r.project) : null,
      r.ok ? null : h("span", { class: "badge badge-warn" }, "failed"),
      r.args ? h("span", { class: "ai-run-args mono", title: "What the agent asked for (nothing secret is kept)" }, r.args) : null,
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
    // Where it was: a deployed site in the dx browser, and which deployment answered when the site said so.
    const siteEvent = g.events.find((e) => e.site && e.env && e.env !== "local");
    const deploy = g.events.find((e) => e.deploy)?.deploy;
    if (deploy) actions.push(deployView(g.dir, deploy));
    // Only pages on this computer can be replayed, and only from a project.
    if (g.visit && clicks && !fromCheck && !siteEvent && !g.dir.startsWith("site:")) {
      actions.push(
        btn("Replay", (ev) => replay(ev.currentTarget, g), {
          small: true,
          iconName: "play",
          title: "Open the page in a headless browser and click what was clicked here, in order, then list what broke",
          name: `Replay this visit to ${path || g.project}`,
        }),
      );
    }
    const local = !siteEvent && !g.dir.startsWith("site:");
    // The newest error of the visit, as a file a teammate can replay.
    const lastProblem = [...g.events].reverse().find((e) => isProblemEvent(e) && e.level !== "warn");
    if (local && lastProblem && g.kind !== "server") {
      actions.push(
        btn("Download bug bundle", (ev) => downloadBundle(ev.currentTarget, lastProblem), {
          small: true,
          iconName: "save",
          title: "Save this visit's steps, requests and error as a .dxbug.json file a teammate can replay on their own dev server",
          name: `Download a bug bundle for this visit to ${path || g.project}`,
        }),
      );
    }
    // The visit's API calls, as answers mock mode gives back.
    if (local && g.visit && g.events.some((e) => e.type === "request" && e.from === "proxy" && !e.mocked)) {
      actions.push(
        btn("Make mocks", (ev) => makeMocks(ev.currentTarget, g.dir, { visit: g.visit }), {
          small: true,
          iconName: "template",
          title: "Keep this visit's API answers as mocks, so the front end can run on them without the back end",
          name: `Make mocks from this visit to ${path || g.project}`,
        }),
      );
    }
    return h(
      "details",
      { class: "visit", open: isOpen || undefined, dataset: { group: g.key, from: String(Date.parse(first.at)), to: String(Date.parse(last.at)) } },
      h(
        "summary",
        { class: "visit-head" },
        h("span", { class: "time" }, first === last || time(first) === time(last) ? time(first) : `${time(first)}–${time(last)}`),
        h("strong", { class: "visit-title" }, title),
        many ? h("span", { class: "badge" }, g.project) : null,
        siteEvent ? envBadge(siteEvent.env) : null,
        siteEvent ? h("span", { class: "dim mono" }, siteEvent.site) : null,
        fromCheck ? h("span", { class: "badge" }, "headless check") : null,
        h("span", { class: "dim" }, `${plural(g.events.length, "event")}${clicks ? `, ${plural(clicks, "click")}` : ""}`),
        g.problems ? h("span", { class: "badge badge-danger" }, plural(g.problems, "problem")) : null,
      ),
      actions.length ? h("div", { class: "toolbar visit-actions" }, actions) : null,
      result,
      h("ul", { class: "activity-list" }, [...g.events].reverse().map((e) => activityRow(e, many, open.has(String(e.id)), true))),
    );
  }

  /**
   * The deployment a site said answered (a header or meta tag it sent), and, when it names a
   * commit the linked project has, Run this commit: that commit runs from ~/.dx/snapshots.
   */
  function deployView(d, deploy) {
    const what = deploy.commit ? deploy.commit.slice(0, 10) : deploy.version ?? deploy.id;
    const wrap = h(
      "span",
      { class: "deploy" },
      h("span", { class: "badge", title: `From the site's ${deploy.from}${deploy.server ? `, served by ${deploy.server}` : ""}` }, icon("tag"), " ", h("span", { class: "mono" }, what)),
      deploy.version && deploy.commit ? h("span", { class: "dim" }, deploy.version) : null,
    );
    const project = projects.find((p) => p.dir.toLowerCase() === d.toLowerCase());
    if (!deploy.commit || !project?.hasGit) return wrap;
    const key = `${d}|${deploy.commit}`;
    const known = commits.get(key);
    const runButton = (c) =>
      btn("Run this commit", (ev) => runThen(ev.currentTarget, d, c), {
        small: true,
        kind: "primary",
        iconName: "play",
        title: `${c.short} ${c.subject || ""}: check it out under ~/.dx/snapshots and run it, next to your own dev server`,
      });
    if (known && known !== "…") wrap.append(runButton(known));
    else if (known === null) wrap.append(h("span", { class: "dim", title: "The site names a commit this project's repository doesn't have (fetch, or it was built elsewhere)" }, "not in your repository"));
    else if (known === undefined) {
      commits.set(key, "…");
      api(`/api/sites/commit?dir=${encodeURIComponent(d)}&hash=${encodeURIComponent(deploy.commit)}`).then(
        // Drawn again with the answer: the list may have been redrawn in the meantime.
        (c) => {
          commits.set(key, c);
          if (!stopped) render();
        },
        () => {
          commits.set(key, null);
          if (!stopped) render();
        },
      );
    }
    return wrap;
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

  // ---------------------------------------------------------------- bug bundles

  async function downloadBundle(button, e) {
    const r = await busy(button, "Preparing…", () => api(`/api/activity/bundle?dir=${encodeURIComponent(e.dir)}&id=${e.id}`));
    if (!r) return;
    downloadJson(r.file, r.bundle);
    toast(`Saved ${r.file}: the steps, requests and error, without cookies, tokens or your folders. A teammate opens it on their Activity page to replay it.`, "ok", { ms: 7000 });
  }

  async function openBundleFile(file) {
    if (file.size > 2 * 1024 * 1024) return toast("That file is too large for a bug bundle (over 2 MB).", "error");
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast("That file isn't a dx bug bundle: it isn't JSON.", "error");
    }
    if (data?.format !== "dx-bug" || !data.error || typeof data.error !== "object") return toast("That file isn't a dx bug bundle.", "error");
    if (data.version !== 1) return toast(`That bundle is version ${data.version}; this dx reads version 1. Update dx.`, "error");
    const name = String(data.project?.name ?? "");
    const match = projects.find((p) => !p.snapshot && p.name.toLowerCase() === name.toLowerCase());
    bundleState = { bundle: data, name: file.name, dir: match?.dir ?? "", use: data.git ? "commit" : "working", job: null };
    renderBundle();
    bundleHolder.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  /** A bundle's event, drawn with the usual rows: no folder of ours, so nothing opens or is sent from it. */
  function foreignRow(ev, isOpen = false) {
    const b = bundleState.bundle;
    const e = { ...ev, text: String(ev.text ?? ev.type ?? ""), dir: "", project: String(b.project?.name ?? "") };
    return activityRow(e, false, isOpen, true, { foreign: true });
  }

  function renderBundle() {
    const s = bundleState;
    if (!s) return bundleHolder.replaceChildren();
    const b = s.bundle;
    const steps = Array.isArray(b.steps) ? b.steps : [];
    const events = Array.isArray(b.events) ? b.events : [];
    const notes = Array.isArray(b.notes) ? b.notes.filter((n) => typeof n === "string") : [];
    const project = projects.find((p) => p.dir === s.dir);
    const canCommit = !!b.git?.commit && !!project?.hasGit;
    if (!canCommit) s.use = "working";
    const running = s.job && s.job.phase !== "done" && s.job.phase !== "failed";
    const short = String(b.git?.commit ?? "").slice(0, 7);
    const describe = (st) =>
      st.goto ? `Go to ${st.goto}` : st.click ? `Click ${st.click}` : st.type !== undefined ? `Type into ${st.into ?? "the field"}` : st.press ? `Press ${st.press}` : st.waitFor ? `Wait for ${st.waitFor}` : "A step";

    const select = h(
      "select",
      { class: "input", "aria-label": "Project to replay it on", disabled: running || undefined, onchange: (ev) => ((s.dir = ev.target.value), (s.use = b.git ? "commit" : "working"), renderBundle()) },
      h("option", { value: "" }, "Pick a project"),
      projects.filter((p) => !p.snapshot).map((p) => h("option", { value: p.dir, selected: p.dir === s.dir }, p.name)),
    );
    const where = segmented(
      "Replay on",
      canCommit ? [["commit", `Commit ${short}`], ["working", "Your working copy"]] : [["working", "Your working copy"]],
      s.use,
      (v) => (s.use = v),
    );
    const go = btn("Replay", (ev) => void replayBundle(ev.currentTarget), { kind: "primary", iconName: "play", disabled: !s.dir || running, title: "Run it (the commit as a snapshot, or your working copy), then do the steps in a headless browser on that dev server" });

    bundleHolder.replaceChildren(
      h(
        "section",
        { class: "card card-pad bundle", "aria-label": "Bug bundle" },
        h(
          "div",
          { class: "bundle-head" },
          h("div", null, h("p", { class: "bundle-kicker" }, `Bug bundle · ${s.name}`), h("h2", { class: "bundle-title" }, String(b.error.text ?? "").split("\n")[0] || "An error")),
          btn("", () => ((bundleState = null), renderBundle()), { small: true, kind: "ghost", iconName: "x", name: "Close the bug bundle" }),
        ),
        h(
          "p",
          { class: "bundle-meta" },
          h("span", { class: "badge" }, String(b.project?.name ?? "")),
          b.git?.commit
            ? h("span", { class: "badge mono", title: b.git.from === "head" ? "HEAD when it was exported" : "The commit HEAD was on when it happened" }, `${short}${b.git.branch ? ` on ${b.git.branch}` : ""}`)
            : h("span", { class: "badge" }, "no commit"),
          b.git?.dirty ? h("span", { class: "badge badge-warn", title: "The sender's working copy had changes that weren't committed" }, "uncommitted changes") : null,
          h("span", { class: "dim" }, `${plural(steps.length, "step")}, ${plural(events.length, "event")}${b.createdAt ? `, made ${relativeTime(Date.parse(b.createdAt))}` : ""}`),
        ),
        h(
          "div",
          { class: "bundle-compare" },
          h(
            "div",
            { class: "bundle-side" },
            h("h3", { class: "bundle-side-title" }, "Then"),
            h("ul", { class: "activity-list" }, foreignRow(b.error, true)),
            steps.length ? h("ol", { class: "bullets bundle-steps" }, steps.map((st) => h("li", { class: "mono" }, describe(st)))) : h("p", { class: "dim" }, "No clicks before it: a replay loads the page."),
            notes.map((n) => h("p", { class: "dim" }, n)),
            events.length
              ? h("details", { class: "bundle-events" }, h("summary", null, `Everything recorded (${events.length})`), h("ul", { class: "activity-list" }, [...events].reverse().slice(0, 300).map((ev) => foreignRow(ev))))
              : null,
          ),
          h(
            "div",
            { class: "bundle-side" },
            h("h3", { class: "bundle-side-title" }, "Now"),
            h("div", { class: "bundle-controls" }, h("label", { class: "field" }, h("span", { class: "field-label" }, "Project"), select), h("div", { class: "field" }, h("span", { class: "field-label" }, "Run"), where), go),
            !b.git?.commit
              ? h("p", { class: "dim" }, "The bundle doesn't name a commit, so it replays on your working copy.")
              : project && !project.hasGit
                ? h("p", { class: "dim" }, `${project.name} isn't a git repository here, so it replays on your working copy.`)
                : null,
            bundleResult(s),
          ),
        ),
      ),
    );
  }

  function bundleResult(s) {
    const job = s.job;
    if (!job) return h("p", { class: "dim" }, "Its steps run in a headless browser against your own dev server for the project: the bundle's own address is never used.");
    if (job.phase === "failed") return h("div", { class: "note note-danger", role: "alert" }, icon("warn"), h("p", null, job.error ?? "The replay failed."));
    if (job.phase !== "done") return h("div", { class: "note", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("p", null, `${job.step}…`));
    const v = job.verdict;
    const p = job.result?.page;
    const stepItems = (p?.steps ?? []).map((st) => h("li", null, h("span", { class: `badge ${st.ok ? "badge-ok" : "badge-danger"}` }, st.ok ? "ok" : "failed"), ` ${st.action}`, st.error ? h("span", { class: "dim" }, ` · ${st.error}`) : null));
    const exceptions = (p?.exceptions ?? []).filter((m) => m.text.includes("\n"));
    return h(
      "div",
      { class: "bundle-now" },
      h(
        "div",
        { class: `note ${v.reproduced ? "note-warn" : "note-ok"}`, role: "status" },
        icon(v.reproduced ? "warn" : "check"),
        h("div", null, h("p", null, h("strong", null, v.summary)), h("p", { class: "dim" }, `On ${job.target}${job.url ? `, at ${new URL(job.url).pathname}` : ""}.`)),
      ),
      stepItems.length ? h("ol", { class: "bullets" }, stepItems) : null,
      v.now.length ? h("ul", { class: "bullets" }, v.now.slice(0, 10).map((t) => h("li", { class: "mono" }, t))) : null,
      exceptions.slice(0, 2).map((m) => liveDetail((mode) => stackBlock(m.text, "")(mode))),
      h("p", { class: "dim" }, "The replay's own events are in the history too, as a headless check."),
    );
  }

  async function replayBundle(button) {
    const s = bundleState;
    const r = await busy(button, "Starting…", () => api("/api/activity/bundle/replay", { method: "POST", body: { dir: s.dir, bundle: s.bundle, use: s.use } }));
    if (!r || bundleState !== s) return;
    s.job = r;
    renderBundle();
    const poll = async () => {
      if (stopped || bundleState !== s) return;
      try {
        s.job = await api(`/api/activity/bundle/replay?id=${encodeURIComponent(s.job.id)}`);
      } catch (err) {
        s.job = { ...s.job, phase: "failed", error: err.message };
      }
      if (bundleState !== s) return;
      renderBundle();
      if (s.job.phase === "done" || s.job.phase === "failed") return void load();
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 800);
  }

  // ---------------------------------------------------------------- mock mode

  async function loadMocks() {
    const d = dir;
    if (!d) {
      mocks = null;
      return renderMocks();
    }
    try {
      const m = await api(`/api/mocks?dir=${encodeURIComponent(d)}`);
      if (d !== dir || stopped) return;
      mocks = m;
      const p = projects.find((x) => x.dir === d);
      if (p) p.mocks = m.endpoints.length ? { on: m.on, strict: m.strict, endpoints: m.endpoints.length, enabled: m.endpoints.filter((e) => e.enabled).length } : undefined;
    } catch {
      mocks = null;
    }
    renderMocks();
  }

  function renderMocks() {
    if (!dir || !mocks) return mockHolder.replaceChildren();
    const n = mocks.endpoints.length;
    const enabled = mocks.endpoints.filter((e) => e.enabled).length;
    const panel = h(
      "details",
      { class: "card mocks", open: mocks.on || !!mockEdit || pref("mocksOpen", "0") === "1" || undefined, ontoggle: (e) => setPref("mocksOpen", e.target.open ? "1" : "0") },
      h(
        "summary",
        { class: "mocks-head" },
        h("strong", null, "Mock mode"),
        mocks.on
          ? h("span", { class: "badge badge-warn" }, `On · Mocked: ${plural(enabled, "endpoint")}`)
          : h("span", { class: "badge" }, n ? `Off · ${plural(n, "endpoint")} ready` : "Off"),
        mocks.on && mocks.strict ? h("span", { class: "badge", title: "API calls with no mock get a 404" }, "strict") : null,
      ),
      h(
        "div",
        { class: "mocks-body" },
        h(
          "p",
          { class: "dim" },
          "While it's on, this project's API calls are answered by dx from what was recorded, so the front end runs without its back end. Pages and assets still come from the dev server. Values that were masked when recorded (•••) come back masked.",
        ),
        h(
          "div",
          { class: "toolbar" },
          n
            ? btn(mocks.on ? "Turn off" : "Turn on", (ev) => void mockMode(ev.currentTarget, { on: !mocks.on }), { small: true, kind: mocks.on ? "" : "primary", iconName: mocks.on ? "stop" : "play" })
            : null,
          n
            ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: mocks.strict, onchange: (e) => void mockMode(null, { strict: e.target.checked }) }), "Strict: API calls with no mock get a 404")
            : null,
          btn("Make mocks from the last hour", (ev) => void makeMocks(ev.currentTarget, dir, { since: "1h" }), { small: true, iconName: "template" }),
          n ? btn("Remove all", (ev) => void removeAllMocks(ev.currentTarget), { small: true, kind: "danger-ghost", iconName: "cleanup" }) : null,
        ),
        n
          ? h("ul", { class: "mock-list" }, mocks.endpoints.map(mockRow))
          : h("p", { class: "dim" }, "No mocks yet. Use the app at its .localhost address, then make mocks from the last hour, or from one visit with its Make mocks button."),
      ),
    );
    mockHolder.replaceChildren(panel);
  }

  function mockRow(e) {
    const editing = mockEdit?.id === e.id;
    return h(
      "li",
      { class: `mock-row${e.enabled ? "" : " mock-off"}` },
      h("input", { type: "checkbox", checked: e.enabled, "aria-label": `Answer ${e.method} ${e.path} from its mock`, onchange: (ev) => void saveMock(e.id, { enabled: ev.target.checked }) }),
      h("span", { class: "badge mono" }, e.method),
      h("span", { class: "mono mock-path" }, `${e.path}${e.query ?? ""}`, e.bodyKey ? h("span", { class: "dim", title: e.requestBody ?? "" }, " (one request body)") : null),
      h("span", { class: `badge ${e.offline || e.status >= 400 ? "badge-danger" : "badge-ok"}` }, e.offline ? "offline" : String(e.status)),
      e.delayMs ? h("span", { class: "dim" }, `${e.delayMs} ms`) : null,
      e.edited ? h("span", { class: "badge", title: "Changed by hand: making mocks again leaves it as it is" }, "edited") : null,
      btn(editing ? "Close" : "Edit", () => void toggleMockEdit(e), { small: true, kind: "ghost", iconName: editing ? "x" : "code", name: `${editing ? "Close" : "Edit"} the mock for ${e.method} ${e.path}` }),
      editing ? mockEdit.el : null,
    );
  }

  async function toggleMockEdit(e) {
    if (mockEdit?.id === e.id) {
      mockEdit = null;
      return renderMocks();
    }
    try {
      const full = await api(`/api/mocks?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(e.id)}`);
      mockEdit = { id: e.id, el: mockEditor(full) };
      renderMocks();
      mockEdit.el.querySelector("textarea")?.focus();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function mockEditor(ep) {
    const pretty = (text) => {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    };
    const status = h("input", { class: "input", type: "number", min: "100", max: "599", value: String(ep.status), "aria-label": "Status code" });
    const delay = h("input", { class: "input", type: "number", min: "0", max: "30000", step: "100", value: String(ep.delayMs), "aria-label": "Delay in milliseconds" });
    const type = h("input", { class: "input", value: ep.contentType, spellcheck: "false", autocomplete: "off", "aria-label": "Content type" });
    const body = h("textarea", { class: "input mock-body", spellcheck: "false", autocomplete: "off", "aria-label": "Answer body", rows: "10" });
    body.value = pretty(ep.body);
    const problem = h("p", { class: "field-hint mock-problem", "aria-live": "polite" });
    const preview = h("div", { class: "mock-preview" });
    const save = btn("Save", () => void submit(), { kind: "primary", iconName: "check", small: true });
    let timer = 0;
    const check = () => {
      const json = /json/i.test(type.value);
      let error = "";
      if (json && body.value.trim()) {
        try {
          JSON.parse(body.value);
        } catch (err) {
          error = `Not valid JSON: ${err.message}`;
        }
      }
      if (new Blob([body.value]).size > 1024 * 1024) error = "A mock's body can be at most 1 MB.";
      problem.textContent = error;
      problem.classList.toggle("mock-problem-on", !!error);
      save.disabled = !!error;
      if (!error) preview.replaceChildren(liveDetail((mode) => bodyBlock("Answer", body.value, type.value)(mode)));
    };
    body.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(check, 300);
    });
    type.addEventListener("input", check);
    check();

    async function submit() {
      const r = await busy(save, "Saving…", () =>
        api("/api/mocks/update", { method: "POST", body: { dir, id: ep.id, status: Number(status.value), delayMs: Number(delay.value || 0), contentType: type.value, body: body.value } }),
      );
      if (!r) return;
      mockEdit = null;
      toast(`Saved the mock for ${ep.method} ${ep.path}`);
      void loadMocks();
    }
    const preset = async (button, name, label) => {
      const r = await busy(button, "…", () => api("/api/mocks/update", { method: "POST", body: { dir, id: ep.id, preset: name } }));
      if (!r) return;
      mockEdit = { id: ep.id, el: mockEditor(r) };
      toast(`${ep.method} ${ep.path}: ${label}`);
      void loadMocks();
    };
    return h(
      "div",
      { class: "mock-editor" },
      h(
        "div",
        { class: "toolbar mock-presets", role: "group", "aria-label": "Quick presets" },
        [
          ["fail", "Fail with 500"],
          ["empty", "Empty list"],
          ["slow", "Slow (3 s)"],
          ["offline", ep.offline ? "Offline (on)" : "Offline"],
          ["reset", "Reset to recorded"],
        ].map(([name, label]) => btn(label, (ev) => void preset(ev.currentTarget, name, label), { small: true, kind: name === "reset" ? "ghost" : "" })),
      ),
      h(
        "div",
        { class: "mock-fields" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Status"), status),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Delay (ms)"), delay, h("span", { class: "field-hint" }, "Up to 30 000")),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Content type"), type),
      ),
      ep.offline ? h("p", { class: "dim" }, "Offline: the connection is closed with no answer, as when the API is down. Reset to recorded turns it off.") : null,
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Body"), body, problem),
      preview,
      h(
        "div",
        { class: "form-actions" },
        save,
        btn("Remove this mock", (ev) => void removeOneMock(ev.currentTarget, ep), { small: true, kind: "danger-ghost", iconName: "cleanup" }),
      ),
    );
  }

  async function saveMock(id, patch) {
    try {
      await api("/api/mocks/update", { method: "POST", body: { dir, id, ...patch } });
    } catch (err) {
      toast(err.message, "error");
    }
    void loadMocks();
  }

  async function mockMode(button, mode) {
    const call = () => api("/api/mocks/mode", { method: "POST", body: { dir, ...mode } });
    const r = button ? await busy(button, mode.on ? "Turning on…" : "Turning off…", call) : await call().catch((err) => toast(err.message, "error"));
    if (r && mode.on !== undefined) toast(r.on ? `Mock mode is on: ${plural(r.endpoints, "endpoint")} answered by dx` : "Mock mode is off: every call goes to the dev server");
    await loadMocks();
    renderNav();
  }

  async function makeMocks(button, d, body) {
    const r = await busy(button, "Making…", () => api("/api/mocks/make", { method: "POST", body: { dir: d, ...body } }));
    if (!r) return;
    toast(`${plural(r.endpoints, "mocked endpoint")}: ${r.added} new, ${r.replaced} updated${r.kept ? `, ${r.kept} you edited kept` : ""}.${r.on ? "" : " Turn mock mode on to use them."}`);
    if (d === dir) {
      if (!pref("mocksOpen", "") || pref("mocksOpen", "") === "0") setPref("mocksOpen", "1");
      void loadMocks();
    } else choose(`p:${d}`);
  }

  async function removeOneMock(button, ep) {
    const yes = await confirmDialog({ title: `Remove the mock for ${ep.method} ${ep.path}?`, text: "Calls to it go to the dev server again. Make it again from the history any time.", confirm: "Remove mock" });
    if (!yes) return;
    const r = await busy(button, "Removing…", () => api("/api/mocks/remove", { method: "POST", body: { dir, id: ep.id } }));
    if (!r) return;
    mockEdit = null;
    void loadMocks();
  }

  async function removeAllMocks(button) {
    const yes = await confirmDialog({ title: "Remove every mock?", text: "This deletes the project's mocks and turns mock mode off. The activity history isn't touched.", confirm: "Remove all" });
    if (!yes) return;
    const r = await busy(button, "Removing…", () => api("/api/mocks/remove", { method: "POST", body: { dir, all: true } }));
    if (!r) return;
    mockEdit = null;
    toast("Removed every mock");
    await loadMocks();
    renderNav();
  }

  async function copyReport(button, e) {
    const r = await busy(button, "Copying…", async () => {
      const where = e.dir.startsWith("site:") ? `site=${encodeURIComponent(e.dir.slice(5))}` : `dir=${encodeURIComponent(e.dir)}`;
      const report = await api(`/api/activity/report?${where}&id=${e.id}`);
      await navigator.clipboard.writeText(report.markdown);
      return report;
    });
    if (r) toast("Bug report copied: steps, requests and the error, as markdown");
  }

  /** One event. `foreign` is for a bundle's events: shown with the same viewers, without actions on this computer's history. */
  function activityRow(e, many, isOpen, inVisit = false, { foreign = false } = {}) {
    const problem = isProblemEvent(e);
    const tone = problem ? (e.level === "warn" ? "badge-warn" : "badge-danger") : e.type === "action" || e.type === "route" ? "badge-accent" : "";
    const label = e.type === "console" && e.level && e.level !== "log" ? `Console ${e.level}` : ACTIVITY_LABELS[e.type] ?? e.type;
    const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const firstLine = e.mocked ? e.text.split("\n")[0].replace(/ \(mocked\)$/, "") : e.text.split("\n")[0];
    const head = [
      h("span", { class: "time" }, time),
      h("span", { class: `badge ${tone}` }, label),
      many ? h("span", { class: "badge" }, e.project) : null,
      inVisit ? null : envBadge(e.env),
      e.service ? h("span", { class: "badge" }, e.service) : null,
      e.mocked ? h("span", { class: "badge badge-warn", title: "Answered by dx's mock mode from a recording, not by the dev server" }, "mocked") : null,
      h("span", { class: `activity-text${e.type === "request" || e.type === "page" || e.type === "console" ? " mono" : ""}`, title: firstLine.length > 80 ? firstLine : undefined }, firstLine),
      e.ms !== undefined && (e.type === "request" || e.type === "page") ? h("span", { class: "dim" }, `${e.ms} ms`) : null,
    ];
    const details = [];
    if (problem && !foreign) {
      details.push(
        h(
          "p",
          { class: "activity-meta" },
          btn("Copy as bug report", (ev) => copyReport(ev.currentTarget, e), { small: true, iconName: "copy", title: "Copy the steps that led here, the requests and the error, as markdown for an issue or an AI chat" }),
          e.dir.startsWith("site:") || e.level === "warn"
            ? null
            : btn("Download bug bundle", (ev) => downloadBundle(ev.currentTarget, e), {
                small: true,
                iconName: "save",
                title: "Save the steps, requests and this error as a .dxbug.json file a teammate can replay on their own dev server",
              }),
        ),
      );
    }
    if (e.trimmed) details.push(h("p", { class: "dim activity-meta" }, "Bodies and stack weren't kept: this day's history had reached its size limit."));
    if (e.page && e.type !== "page") details.push(h("p", { class: "dim mono activity-meta" }, `on ${e.page}`));
    if (e.type === "request" || e.type === "page") {
      details.push(requestDetail(e));
      if (e.type === "request" && !e.dir.startsWith("site:") && e.url?.startsWith("/"))
        details.push(
          h(
            "p",
            { class: "activity-meta toolbar" },
            btn("Edit and resend", () => openLab(e.dir, "repeater", { method: e.method ?? "GET", path: e.url, headers: e.requestHeaders ?? {}, body: e.requestBody ?? "" }), {
              small: true,
              iconName: "refresh",
              title: "Open it in the Repeater on the Requests page: change anything and send it to the dev server again",
            }),
            btn("Make a rule", () => openLab(e.dir, "rules", { method: e.method ?? "GET", path: (e.url ?? "/").split("?")[0] }), {
              small: true,
              iconName: "new",
              title: "A rule for this endpoint on the Requests page: change its request or answer, slow it down, make it fail, or hold it",
            }),
          ),
        );
    } else if (e.type === "console") {
      details.push(
        liveDetail((mode) => [
          consoleBlock(e.text)(mode),
          e.source ? h("p", { class: "activity-meta" }, sourceButton(e)) : null,
          e.stack && problem ? stackBlock(e.stack, codeDir(e))(mode) : null,
        ]),
      );
    } else if (e.type === "error" || e.type === "server-error") {
      const extra = e.text.includes("\n") ? e.text : "";
      details.push(
        liveDetail((mode) => [
          // A stack's first frame says where already.
          e.source && (mode === "raw" || !e.stack || !parseStack(e.stack).frames.length) ? h("p", { class: "activity-meta" }, "Where: ", sourceButton(e)) : null,
          e.stack ? stackBlock(e.stack, codeDir(e))(mode) : extra ? h("pre", { class: "log-snippet raw-text" }, extra) : null,
        ]),
      );
    } else {
      if (e.text.includes("\n")) details.push(h("pre", { class: "log-snippet" }, e.text));
      if (e.source) details.push(h("p", { class: "activity-meta" }, sourceButton(e)));
    }
    const at = String(Date.parse(e.at));
    if (!details.length) return h("li", { class: "activity-row", dataset: { at } }, head);
    return h("li", { dataset: { at } }, h("details", { open: isOpen || undefined, dataset: { id: String(e.id) } }, h("summary", { class: "activity-row" }, head), h("div", { class: "activity-detail" }, details)));
  }

  /** The event's file and line as a button that opens your editor there, when it's one of the project's files. */
  function sourceButton(e) {
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(e.source);
    if (!m) return h("span", { class: "dim mono" }, e.source);
    return openAt(codeDir(e), m[1], Number(m[2]), m[3] ? Number(m[3]) : undefined);
  }

  /** The project whose files a location can be opened in: none for a deployed site, whose files are its build's. */
  function codeDir(e) {
    return e.dir.startsWith("site:") || (e.env && e.env !== "local") ? "" : e.dir;
  }

  (async () => {
    try {
      projects = await api("/api/projects");
      siteProject.append(...projects.map((p) => h("option", { value: p.dir }, p.name)));
      if (dir && !projects.some((p) => p.dir === dir)) ((dir = ""), (sel = ""), setPref("activitySel", ""), setPref("activityDir", ""));
    } catch {
      // the list shows what has history
    }
    renderNav();
    void loadMocks();
    await load();
    setTimeout(poll, 2000);
  })();
  return () => {
    stopped = true;
    clearTimeout(searchTimer);
    clearTimeout(ttTimer);
    root.classList.remove("drop-active");
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("dragleave", onDragLeave);
    root.removeEventListener("drop", onDrop);
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
  const thisYear = new Date().getFullYear();
  let storyYear = Number(pref("storyYear", String(thisYear)));
  if (!(storyYear >= thisYear - 9 && storyYear <= thisYear)) storyYear = thisYear;
  const yearSelect = h(
    "select",
    { class: "input", "aria-label": "Year", hidden: days !== "year", onchange: (e) => ((storyYear = Number(e.target.value)), setPref("storyYear", storyYear), load()) },
    Array.from({ length: 10 }, (_, i) => thisYear - i).map((y) => h("option", { value: String(y), selected: y === storyYear }, String(y))),
  );
  const save = btn("Save to file", async (e) => {
    if (days === "year") {
      const r = await busy(e.currentTarget, "Saving…", () => api("/api/summary/story/save", { method: "POST", body: { year: storyYear, github, allAuthors: everyone } }));
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
      segmented("Period", [[1, "Today"], [7, "7 days"], [30, "30 days"], ["year", "Your year"]], days, (v) => ((days = v), setPref("summaryDays", v), (yearSelect.hidden = v !== "year"), load())),
      yearSelect,
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: github, onchange: (e) => ((github = e.target.checked), setPref("summaryGithub", github ? "1" : "0"), load()) }), "GitHub pull requests"),
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((everyone = e.target.checked), load()) }), "Everyone's commits"),
    ),
    holder,
  );

  let loadSeq = 0;
  async function load() {
    copy.disabled = save.disabled = true;
    holder.replaceChildren(loadingView(days === "year" ? `Reading ${storyYear}'s git history across your projects…` : "Reading git history across your projects…"));
    const seq = ++loadSeq;
    try {
      if (days === "year") {
        const y = await api(`/api/summary/story?year=${storyYear}&github=${github ? 1 : 0}&allAuthors=${everyone ? 1 : 0}`);
        if (seq !== loadSeq) return;
        markdown = y.markdown;
        copy.disabled = save.disabled = false;
        holder.replaceChildren(yearStory(y, everyone));
        return;
      }
      const r = await api(`/api/summary?days=${days}&github=${github ? 1 : 0}&allAuthors=${everyone ? 1 : 0}`);
      if (seq !== loadSeq) return;
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

// ------------------------------------------------------------------ Your year

const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function niceDate(date, withYear = false) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) });
}

function hoursText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 && hours < 10 ? `${hours}h ${minutes % 60}m` : `${hours.toLocaleString()}h`;
}

/** Counts a big number up from 0 when it scrolls into view; under reduced motion it's just there. */
function countUp(el, value) {
  el.textContent = value.toLocaleString();
  if (reducedMotion.matches || value < 2 || !("IntersectionObserver" in window)) return;
  el.textContent = "0";
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 700);
      el.textContent = Math.round(value * (1 - (1 - t) ** 3)).toLocaleString();
      if (t < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  io.observe(el);
}

/**
 * The year as a story, one card per thing worth telling: a big number or a small chart and a
 * sentence. Drawn from what dx found on this computer; nothing is sent anywhere.
 */
function yearStory(y, everyone) {
  const st = y.story;
  const whose = everyone ? "everyone's" : "your";
  if (!st.commits && !st.journal.entries) {
    return h(
      "div",
      { class: "card" },
      stateView(`Nothing recorded for ${y.year}`, `No commits of ${everyone ? "anyone's" : "yours"} and no journal entries in ${y.year} in your projects folders.`, h("a", { class: "btn", href: "#/journal" }, "Write in your journal")),
    );
  }
  const reveal = !reducedMotion.matches && "IntersectionObserver" in window;
  const io = reveal
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.remove("story-pending");
          e.target.classList.add("story-reveal");
          io.unobserve(e.target);
        }
      }, { rootMargin: "0px 0px -10% 0px" })
    : null;
  const big = (value, unit) => {
    const num = h("span", { class: "story-num" });
    countUp(num, value);
    return h("p", { class: "story-big" }, num, unit ? h("span", { class: "story-unit" }, ` ${unit}`) : null);
  };
  const card = (label, ...content) => {
    const el = h("section", { class: `card story-card${reveal ? " story-pending" : ""}` }, h("h2", { class: "story-label" }, label), content);
    io?.observe(el);
    return el;
  };
  const line = (...text) => h("p", { class: "story-line" }, text);
  const bar = (share) => h("span", { class: "story-bar" }, h("span", { class: "story-bar-fill", style: { width: `${Math.max(3, Math.round(share * 100))}%` } }));

  const cards = [];
  cards.push(
    h(
      "section",
      { class: "story-hero" },
      h("h2", { class: "story-kicker" }, `Your ${y.year}${y.year === new Date().getFullYear() ? ", so far" : ""}`),
      h("div", { class: "story-hero-title" }, big(st.commits, st.commits === 1 ? "commit" : "commits")),
      line(`in ${plural(st.projects, "project")}, on ${plural(st.activeDays, "day")}${st.journal.entries ? `, with ${plural(st.journal.entries, "journal entry", "journal entries")}` : ""}.`),
      h("p", { class: "story-private" }, icon("key"), `Made on this computer from ${whose} git history, your journal and dx's own records. Nothing leaves it.`),
    ),
  );

  if (st.longestStreak) {
    cards.push(
      card(
        "Longest streak",
        big(st.longestStreak.days, st.longestStreak.days === 1 ? "day" : "days in a row"),
        line(st.longestStreak.days > 1 ? `From ${niceDate(st.longestStreak.from)} to ${niceDate(st.longestStreak.to)}, a commit every day.` : "No two days in a row yet; plenty of time."),
      ),
    );
  }
  if (st.busiestWeek) {
    cards.push(card("Busiest week", big(st.busiestWeek.commits, "commits"), line(`The week of ${niceDate(st.busiestWeek.from)} to ${niceDate(st.busiestWeek.to)}.`)));
  }

  // When you code: weekday × hour, shaded by how many commits.
  if (st.peak) {
    const max = Math.max(1, ...st.heat.flat());
    const grid = h("div", { class: "heat", role: "img", "aria-label": `Commits by weekday and hour. Most on ${WEEKDAY_LONG[st.peak.weekday]}s at ${String(st.peak.hour).padStart(2, "0")}:00.` });
    grid.append(h("span", { class: "heat-corner" }));
    for (let hour = 0; hour < 24; hour++) grid.append(h("span", { class: "heat-hour" }, hour % 6 === 0 ? String(hour).padStart(2, "0") : ""));
    st.heat.forEach((row, wd) => {
      grid.append(h("span", { class: "heat-day" }, WEEKDAY_LONG[wd].slice(0, 3)));
      row.forEach((n, hour) => {
        const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
        grid.append(h("span", { class: `heat-cell heat-${level}`, title: `${WEEKDAY_LONG[wd]} ${String(hour).padStart(2, "0")}:00: ${plural(n, "commit")}` }));
      });
    });
    cards.push(
      card(
        "When you code",
        grid,
        h("div", { class: "heat-legend", "aria-hidden": "true" }, "Fewer", [0, 1, 2, 3, 4].map((l) => h("span", { class: `heat-cell heat-${l}` })), "More"),
        line(`Most often on ${WEEKDAY_LONG[st.peak.weekday]}s around ${String(st.peak.hour).padStart(2, "0")}:00. ${Math.round(st.evenings * 100)}% of commits in the evening or at night, ${Math.round(st.weekends * 100)}% at weekends.`),
      ),
    );
    cards[cards.length - 1].classList.add("story-wide");
  }

  if (st.months.length) {
    const max = Math.max(...st.months.map((m) => m.commits));
    cards.push(
      card(
        "The project of each month",
        h(
          "ul",
          { class: "story-months" },
          st.months.map((m) =>
            h("li", null, h("span", { class: "story-month" }, m.month.slice(0, 3)), h("span", { class: "story-month-project" }, m.project ?? ""), bar(m.commits / max), h("span", { class: "story-count" }, String(m.commits))),
          ),
        ),
        line(`${st.months.length === 1 ? "One month" : `${st.months.length} months`} with commits; ${[...st.months].sort((a, b) => b.commits - a.commits)[0].month} was the busiest.`),
      ),
    );
    cards[cards.length - 1].classList.add("story-wide");
  }

  if (st.biggestDay) {
    cards.push(card("Biggest single day", big(st.biggestDay.commits, "commits"), line(`${niceDate(st.biggestDay.date)}, in ${st.biggestDay.projects.join(", ")}.`)));
  }

  if (st.fixes.count) {
    cards.push(
      card(
        "Bugs squashed",
        big(st.fixes.count, st.fixes.count === 1 ? "fix" : "fixes"),
        line(`${Math.round((st.fixes.count / Math.max(1, st.commits)) * 100)}% of the year's commits fix something. The latest:`),
        h("ul", { class: "story-list" }, st.fixes.examples.slice(0, 3).map((c) => h("li", null, c.subject, h("span", { class: "dim" }, ` · ${c.project}, ${niceDate(c.date)}`)))),
      ),
    );
  }

  if (st.files.length) {
    cards.push(
      card(
        "Most-touched files",
        h("ol", { class: "story-list story-files" }, st.files.slice(0, 5).map((f) => h("li", null, h("span", { class: "mono story-file" }, f.path), h("span", { class: "dim" }, ` · ${f.project}, ${plural(f.commits, "commit")}`)))),
        line(`${st.files[0].path} changed in ${plural(st.files[0].commits, "commit")}, more than any other file.`),
      ),
    );
  }

  if (st.languages.length) {
    const total = st.languages.reduce((n, l) => n + l.files, 0);
    cards.push(
      card(
        "Languages",
        h("ul", { class: "story-langs" }, st.languages.slice(0, 6).map((l) => h("li", null, h("span", { class: "story-lang" }, l.language), bar(l.files / st.languages[0].files), h("span", { class: "story-count" }, `${Math.round((l.files / total) * 100)}%`)))),
        line(`Mostly ${st.languages[0].language}, by files changed.`),
      ),
    );
  }

  if (st.devMs >= 60_000) {
    const top = st.devProjects[0];
    cards.push(card("Dev servers running", h("p", { class: "story-big" }, h("span", { class: "story-num" }, hoursText(st.devMs))), line(`Time dx ran your dev servers${top ? `, most of it for ${top.project} (${hoursText(top.ms)})` : ""}.`)));
  }

  if (st.first) {
    const moment = (label, c) => h("div", { class: "story-moment" }, h("span", { class: "story-label" }, label), h("strong", null, c.subject || "(no message)"), h("span", { class: "dim" }, `${c.project} · ${niceDate(c.date)} at ${c.time}`));
    cards.push(card("First and last", h("div", { class: "story-moments" }, moment("First commit", st.first), st.last && st.commits > 1 ? moment("Latest commit", st.last) : null)));
  }

  if (st.journal.words.length) {
    const max = st.journal.words[0].count;
    cards.push(
      card(
        "Your journal's words",
        h("ul", { class: "story-words" }, st.journal.words.map((w) => h("li", { class: `story-word story-word-${Math.max(1, Math.ceil((w.count / max) * 3))}` }, w.word, h("span", { class: "dim" }, ` ${w.count}`)))),
        line(`From ${plural(st.journal.entries, "journal entry", "journal entries")}.`),
      ),
    );
  }

  if (st.ai.calls || st.notes.ai) {
    cards.push(
      card(
        "With your AI agent",
        big(st.ai.calls, st.ai.calls === 1 ? "call" : "calls"),
        line(`Made through dx${st.ai.projects ? ` in ${plural(st.ai.projects, "project")}` : ""}${st.notes.ai ? `, and ${plural(st.notes.ai, "note")} left for you` : ""}.`),
      ),
    );
  }

  if (y.github && "merged" in y.github && y.github.merged + y.github.reviewed) {
    cards.push(card("Pull requests", big(y.github.merged, "merged"), line(`And ${plural(y.github.reviewed, "review")} of other people's.`)));
  }

  const notes = [];
  if (st.skipped.length) notes.push(`Couldn't read ${st.skipped.join(", ")}.`);
  if (y.github && "error" in y.github) notes.push(`No pull requests: ${y.github.error}.`);
  return h(
    "div",
    { class: "story" },
    cards,
    notes.length ? h("div", { class: "note" }, icon("info"), h("div", null, notes.map((n) => h("p", null, n)))) : null,
    h("p", { class: "dim" }, `Commits by ${st.author}, ${niceDate(st.from, true)} to ${niceDate(st.to, true)}. Copy as markdown or Save keeps the same numbers as text.`),
  );
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
    const visualOn = h("input", { type: "checkbox", id: "cfg-visual", checked: config.visualDiff !== false });
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
          const body = { editor: editor.value, githubUser: github.value, scanDepth: Number(depth.value), activity: activityOn.checked, localhostRecording: localhostOn.checked, visualDiff: visualOn.checked, activityDays: Number(activityDays.value), activityMaxMB: Number(activityMax.value) };
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
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Visual diffs"),
          h("label", { class: "check", for: "cfg-visual" }, visualOn, "After each commit, screenshot the pages you use most and compare them with the commit before"),
          h("span", { class: "field-hint" }, "Only while dx runs the project's dev server, with Chrome, Edge, Chromium or Brave. The last 30 commits are kept per project."),
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

// ------------------------------------------------------------------ the AI lane

/**
 * What your AI agent is doing through dx, live, at the right edge of every page: its calls (from
 * the MCP server, through ~/.dx/runs.jsonl) and the dev servers it started. Shown while an agent
 * is active: a call in the last few minutes, or one of its servers running. Collapsed or open is
 * remembered.
 */
const aiLane = { data: null, open: pref("aiLane", "open") !== "closed", sig: "", shown: false, timer: 0 };
const aiLaneEl = h("aside", { class: "ai-lane", id: "ai-lane", hidden: true, "aria-label": "Your AI agent" });
const aiLaneTab = h("button", { type: "button", class: "ai-lane-tab", hidden: true, "aria-controls": "ai-lane", "aria-expanded": "false", onclick: () => setAiLaneOpen(true) });
document.body.append(aiLaneEl, aiLaneTab);

/** Where a call happened: the project's dev server card, its Activity, the Git page… */
function aiCallLink(c) {
  const q = c.dir ? `?dir=${encodeURIComponent(c.dir)}` : "";
  if (["check_url", "activity_log", "network_log", "replay_visit"].includes(c.tool)) return `#/activity${q}${q ? "&" : "?"}who=ai`;
  if (c.tool.startsWith("git_")) return `#/git${q}`;
  const pages = { visual_diff: "#/git", machine_info: "#/machine", list_ports: "#/ports", kill_port: "#/ports", check_env: "#/env", audit_dependencies: "#/deps", fix_dependencies: "#/deps", find_cleanup: "#/cleanup", work_summary: "#/summary", read_log: "#/journal", add_log_entry: "#/journal", dx_setup_check: "#/health" };
  if (pages[c.tool]) return pages[c.tool];
  return `#/projects${q}`;
}

function setAiLaneOpen(open) {
  aiLane.open = open;
  setPref("aiLane", open ? "open" : "closed");
  drawAiLane();
  if (open) aiLaneEl.querySelector(".ai-lane-close")?.focus();
  else aiLaneTab.focus();
}

async function takeOverServer(button, s, after) {
  const r = await busy(button, "Taking over…", () => api("/api/dev/takeover", { method: "POST", body: { dir: s.dir } }));
  if (!r) return;
  toast(`${s.project} is yours now. It keeps running when the agent is done; stop it from the Projects page.`);
  void refreshAiLane(true);
  if (after) await after();
}

async function interruptAgent(button) {
  const servers = aiLane.data?.servers ?? [];
  if (!servers.length) return;
  const names = servers.map((s) => s.project);
  const yes = await confirmDialog({
    title: "Stop the agent's dev servers?",
    text: [
      `This stops ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}, which your AI agent started.`,
      "dx can't stop the agent itself: it runs in your AI tool. Tell it to stop there too, or it may start them again.",
    ],
    confirm: `Stop ${plural(names.length, "server")}`,
  });
  if (!yes) return;
  const r = await busy(button, "Stopping…", () => api("/api/ai/interrupt", { method: "POST", body: { dirs: servers.map((s) => s.dir) } }));
  if (!r) return;
  toast(r.stopped.length ? `Stopped ${r.stopped.join(", ")}` : "They had already stopped.");
  void refreshAiLane(true);
  void updateRunningCount();
}

function drawAiLane() {
  const d = aiLane.data;
  const show = !!d?.active;
  aiLaneEl.hidden = !show || !aiLane.open;
  aiLaneTab.hidden = !show || aiLane.open;
  document.body.classList.toggle("ai-lane-open", show && aiLane.open);
  if (show && !aiLane.shown && aiLane.open) aiLaneEl.classList.add("ai-lane-enter");
  aiLane.shown = show;
  if (!show) return;
  const recent = d.calls.filter((c) => Date.now() - Date.parse(c.at) < 5 * 60_000).length;
  aiLaneTab.replaceChildren();
  append(aiLaneTab, icon("ai"), h("span", null, "AI agent"), recent ? h("span", { class: "count" }, String(recent)) : null);
  aiLaneTab.title = "Show what your AI agent is doing";
  if (!aiLane.open) return;

  const last = d.lastCallAt ? Date.parse(d.lastCallAt) : 0;
  const working = last && Date.now() - last < 60_000;
  const stopBtn = btn("Interrupt", (ev) => interruptAgent(ev.currentTarget), {
    small: true,
    kind: "danger-ghost",
    iconName: "stop",
    disabled: !d.servers.length,
    title: d.servers.length
      ? "Stop every dev server the agent started. dx can't stop the agent itself: it runs in your AI tool, so tell it to stop there."
      : "The agent has no dev servers running. dx can't stop the agent itself: it runs in your AI tool, so tell it to stop there.",
  });
  stopBtn.classList.add("ai-lane-interrupt");
  const close = btn("", () => setAiLaneOpen(false), { small: true, kind: "ghost", iconName: "right", name: "Collapse the AI lane" });
  close.classList.add("ai-lane-close");
  aiLaneEl.replaceChildren();
  append(
    aiLaneEl,
    h(
      "div",
      { class: "ai-lane-head" },
      h("div", { class: "ai-lane-title" }, h("span", { class: `dot ${working ? "dot-pulse ai-dot-on" : ""}`, "aria-hidden": "true" }), h("strong", null, "AI agent"), h("span", { class: "dim" }, working ? "working" : last ? `last call ${relativeTime(last)}` : "idle")),
      stopBtn,
      close,
    ),
    d.interrupted
      ? h("p", { class: "ai-lane-note" }, icon("stop"), `You stopped the agent's servers${d.interrupted.stopped.length ? ` (${d.interrupted.stopped.join(", ")})` : ""} ${relativeTime(Date.parse(d.interrupted.at))}.`)
      : null,
    d.servers.length
      ? h(
          "div",
          { class: "ai-lane-servers" },
          h("h2", { class: "ai-lane-label" }, "Its dev servers"),
          h(
            "ul",
            { class: "ai-lane-list" },
            d.servers.map((s) =>
              h(
                "li",
                { class: "ai-lane-server" },
                h("a", { href: `#/projects?dir=${encodeURIComponent(s.dir)}`, class: "ai-lane-server-name" }, s.project),
                h("span", { class: `badge ${s.status === "ready" ? "badge-ok" : "badge-warn"}` }, s.status === "ready" ? "Running" : "Starting"),
                s.errorCount ? h("span", { class: "badge badge-danger" }, plural(s.errorCount, "error")) : null,
                btn("Take over", (ev) => takeOverServer(ev.currentTarget, s), { small: true, kind: "ghost", iconName: "user", title: `Make ${s.project} yours: it's labelled as started from the dashboard and keeps running after the agent is done` }),
              ),
            ),
          ),
        )
      : null,
    h("h2", { class: "ai-lane-label" }, "What it did"),
    d.calls.length
      ? h(
          "ol",
          { class: "ai-lane-feed", "aria-live": "polite" },
          d.calls.slice(0, 30).map((c) =>
            h(
              "li",
              null,
              h(
                "a",
                { class: `ai-call ${c.ok ? "" : "ai-call-failed"}`, href: aiCallLink(c), title: c.args ? `${c.tool}: ${c.args}` : c.tool },
                icon(c.ok ? "check" : "warn"),
                h("span", { class: "ai-call-text" }, c.text),
                h("span", { class: "ai-call-meta" }, relativeTime(Date.parse(c.at)), typeof c.ms === "number" && c.ms >= 1000 ? ` · ${(c.ms / 1000).toFixed(1)}s` : ""),
              ),
            ),
          ),
        )
      : h("p", { class: "dim ai-lane-empty" }, "No calls yet. Its servers are above."),
    h("p", { class: "ai-lane-foot dim" }, "From dx's MCP tools. Nothing secret is kept: no .env values, query results or request bodies."),
  );
}

/** Polls like the rest of the page; redraws only when something changed. */
async function refreshAiLane(force = false) {
  clearTimeout(aiLane.timer);
  if (force || document.visibilityState === "visible") {
    try {
      const d = await api("/api/ai");
      const sig = JSON.stringify([d.active, d.calls[0]?.at, d.calls.length, d.servers.map((s) => [s.dir, s.status, s.errorCount]), d.interrupted?.at, Math.floor(Date.now() / 30_000)]);
      if (force || sig !== aiLane.sig) {
        aiLane.sig = sig;
        aiLane.data = d;
        drawAiLane();
      }
    } catch {
      // the dashboard went away; the page says so elsewhere
    }
  }
  aiLane.timer = setTimeout(refreshAiLane, 4000);
}
aiLaneEl.addEventListener("animationend", () => aiLaneEl.classList.remove("ai-lane-enter"));
aiLaneEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setAiLaneOpen(false);
});

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
void refreshAiLane();
