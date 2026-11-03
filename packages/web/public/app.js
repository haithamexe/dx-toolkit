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

// ------------------------------------------------------------------ router

const pages = [
  { id: "projects", label: "Projects", icon: "projects", render: projectsPage },
  { id: "new", label: "New project", icon: "new", render: newProjectPage },
  { id: "ports", label: "Ports", icon: "ports", render: portsPage },
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
  const devSection = h("section", { class: "section", "aria-labelledby": "dev-title", hidden: true });
  const listSection = h("section", { class: "section", "aria-label": "All projects" });
  const listHolder = h("div", { class: "card" }, loadingView("Finding your projects…"));
  append(listSection, listHolder);

  append(
    root,
    pageHead(
      "Projects",
      "Open a project, run its dev server here, or open it in the browser.",
      search,
      h("a", { class: "btn", href: "#/new" }, icon("new"), "New project"),
      btn("Refresh", () => load(), { iconName: "refresh", kind: "ghost" }),
    ),
    devSection,
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
        h("div", { class: "project-name" }, p.name, h("span", { class: "badge" }, kind), running ? statusBadge(p.dev.status) : null),
        h(
          "div",
          { class: "project-meta" },
          h("span", null, `Active ${relativeTime(p.lastActive)}`),
          p.devCommand ? h("span", { class: "mono" }, p.devCommand) : h("span", null, "No dev command"),
          h("span", { class: "mono" }, tildify(p.dir)),
        ),
      ),
      h(
        "div",
        { class: "project-actions" },
        running
          ? btn("Stop", (e) => stopDev(e.currentTarget, p.dir), { iconName: "stop", small: true, name: `Stop ${p.name}` })
          : p.devCommand
            ? btn("Run", (e) => startDev(e.currentTarget, p.dir), { kind: "primary", iconName: "play", small: true, title: `Run ${p.devCommand} here`, name: `Run ${p.name}` })
            : null,
        btn("Open in editor", (e) => open(e.currentTarget, p, "editor"), { iconName: "code", small: true, name: `Open ${p.name} in editor` }),
        moreMenu(p),
      ),
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
        item("Open in browser", "external", () => open(null, p, "browser", p.dev?.url ?? p.url), !(p.dev?.url ?? p.url)),
        item("Run in a terminal window", "terminal", () => open(null, p, "terminal"), !p.devCommand),
        item("Show in folder", "folder", () => open(null, p, "folder")),
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
          s.url ? h("a", { href: s.url, target: "_blank", rel: "noreferrer", class: "mono" }, s.url) : h("span", { class: "dim mono" }, s.command),
        ),
        h(
          "div",
          { class: "toolbar" },
          s.url && s.status === "ready" ? btn("Open in browser", (e) => open(e.currentTarget, { dir: s.dir }, "browser", s.url), { iconName: "external", small: true, kind: "primary" }) : null,
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
      showingErrors ? errorsEl : null,
      showing ? logEl : null,
    );
    if (showing) {
      const state = logState.get(key) ?? { after: 0, lines: [] };
      logState.set(key, state);
      state.el = logEl;
      renderLines(state, state.lines, true);
    }
    if (showingErrors) {
      errorPanels.set(key, { el: errorsEl, dir: s.dir });
      void refreshErrors(key);
    }
    return card;
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
    for (const l of lines) el.append(h("span", { class: l.stream === "err" ? "err" : l.stream === "dx" ? "dx" : "" }, l.text + "\n"));
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
  }, 3000);
  load();
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

// ------------------------------------------------------------------ Summary

function summaryPage(root) {
  let days = Number(pref("summaryDays", "7"));
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
    const r = await busy(e.currentTarget, "Saving…", () => api("/api/summary/save", { method: "POST", body: { days, github, allAuthors: everyone } }));
    if (r) toast(`Saved to ${tildify(r.file)}`);
  }, { iconName: "save", disabled: true });

  append(
    root,
    pageHead("Summary", "Your commits, pull requests and journal, ready to send.", copy, save),
    h(
      "div",
      { class: "toolbar" },
      segmented("Period", [[1, "Today"], [7, "7 days"], [30, "30 days"]], days, (v) => ((days = v), setPref("summaryDays", v), load())),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: github, onchange: (e) => ((github = e.target.checked), setPref("summaryGithub", github ? "1" : "0"), load()) }), "GitHub pull requests"),
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((everyone = e.target.checked), load()) }), "Everyone's commits"),
    ),
    holder,
  );

  async function load() {
    copy.disabled = save.disabled = true;
    holder.replaceChildren(loadingView("Reading git history across your projects…"));
    try {
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
    else if (gh && !gh.authenticated) notes.push("Pull requests come from public repos only. Set GITHUB_TOKEN before running dx ui to include private ones.");
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
      h("p", { class: "dim" }, `Checked ${relativeTime(Date.parse(job.finishedAt))}. Fix in a project with npm audit fix (or npm update), then run the audit again.`),
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
            h("div", { class: "toolbar" }, btn("Open in editor", (e) => busy(e.currentTarget, "Opening…", async () => toast((await api("/api/projects/open", { method: "POST", body: { dir: r.dir, action: "editor" } })).message)), { small: true, iconName: "code" })),
          ),
        ),
      ),
    ];
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
  append(root, pageHead("Health & settings", "Checks that dx works on this computer, its settings, and recent activity.", btn("Check again", () => load(), { iconName: "refresh" })), holder);

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
    const save = btn("Save settings", null, { kind: "primary", type: "submit" });

    const settings = h(
      "form",
      {
        class: "card card-pad section",
        onsubmit: async (e) => {
          e.preventDefault();
          const r = await busy(save, "Saving…", () => api("/api/config", { method: "POST", body: { editor: editor.value, githubUser: github.value, scanDepth: Number(depth.value) } }));
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
      : h("div", { class: "card" }, stateView("No activity yet", "Opening projects, killing ports and other actions show up here."));

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
      h("section", { class: "section" }, h("h2", { class: "section-title" }, "Recent activity"), runs),
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
