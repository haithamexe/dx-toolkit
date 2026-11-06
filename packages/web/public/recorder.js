// dx activity recorder. The dx local domains proxy adds this to pages served at name.localhost,
// so the dashboard's Activity page has what happened in the browser: route changes, clicks and
// form submits (never what's typed), console output, uncaught errors, and requests the proxy
// doesn't see (to localhost:<port> and other addresses). Turn it off with "activity": false in
// ~/.dx/config.json. It only ever sends to its own page's origin.
(function () {
  "use strict";
  if (window.__dxRecorder) return;
  window.__dxRecorder = true;

  // The real clock, kept before a fake one (Chaos mode's clock) replaces Date for the page.
  var RealDate = Date;
  var realNow = RealDate.now.bind(RealDate);
  var settings = window.__dxSettings || {};
  try {
    if (settings.clock) fakeClock(settings.clock);
  } catch (e) {
    // a page without classes or Proxy keeps its own clock
  }

  var ENDPOINT = "/__dx/events";
  var MAX_TEXT = 4000;
  var MAX_BODY = 16384;
  var visit = Math.random().toString(36).slice(2, 10) + realNow().toString(36);
  var queue = [];
  var timer = 0;
  var send = window.fetch ? window.fetch.bind(window) : null;
  var lastHref = location.href;
  var lastClick = 0;

  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function push(ev) {
    try {
      ev.at = realNow();
      ev.page = location.href;
      queue.push(ev);
      if (ev.type === "error" && !ev.problem) setTimeout(function () { checkBlank("an error"); }, 1000);
      if (queue.length > 500) queue.splice(0, queue.length - 500);
      // Errors go at once: they're what matters most, and a tab that's closed next would lose them.
      var urgent = ev.type === "error" || ev.level === "error";
      if (urgent) {
        clearTimeout(timer);
        timer = setTimeout(flush, 0);
      } else if (!timer) timer = setTimeout(flush, 250);
    } catch (e) {
      // never get in the page's way
    }
  }

  function flush(leaving) {
    timer = 0;
    if (!queue.length) return;
    var batch = queue.splice(0, 100);
    var body = JSON.stringify({ visit: visit, events: batch });
    try {
      if (leaving && navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
      else if (send) send(ENDPOINT, { method: "POST", body: body, headers: { "Content-Type": "text/plain" }, keepalive: body.length < 60000, credentials: "omit" }).catch(function () {});
    } catch (e) {
      // the page is going away
    }
    if (queue.length) timer = setTimeout(flush, 200);
  }

  addEventListener("pagehide", function () {
    flush(true);
  });
  addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });

  // ------------------------------------------------------------ values as text

  function show(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || String(v);
    if (v === undefined) return "undefined";
    if (typeof v === "function") return "ƒ " + (v.name || "anonymous") + "()";
    if (typeof v === "symbol" || typeof v === "bigint") return String(v);
    if (typeof Element !== "undefined" && v instanceof Element) {
      return "<" + v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + (typeof v.className === "string" && v.className ? "." + v.className.trim().split(/\s+/).join(".") : "") + ">";
    }
    try {
      var seen = [];
      var count = 0;
      return JSON.stringify(v, function (k, x) {
        if (++count > 2000) return undefined;
        if (typeof x === "bigint") return String(x) + "n";
        if (x && typeof x === "object") {
          if (seen.indexOf(x) >= 0) return "[Circular]";
          seen.push(x);
          if (x instanceof Map) return { "[Map]": Array.from(x.entries()) };
          if (x instanceof Set) return { "[Set]": Array.from(x.values()) };
        }
        return x;
      });
    } catch (e) {
      return String(v);
    }
  }

  /** The first frame of a stack that isn't this file: where the page called console.log. */
  function caller(stack) {
    var lines = String(stack || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var m = /((?:https?|file|webpack|blob):[^\s()]+?):(\d+):(\d+)/.exec(lines[i]);
      if (m && m[1].indexOf("dx-recorder.js") < 0) return m[1].replace(location.origin, "") + ":" + m[2] + ":" + m[3];
    }
    return undefined;
  }

  // ------------------------------------------------------------ console

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]));
        // The dev server's own chatter ("[vite] connected.") isn't the app's output; its warnings and errors are kept.
        if ((level === "debug" || level === "info" || level === "log") && /^\[(vite|hmr|webpack-dev-server|webpack|fast refresh|hot module replacement|wds)\]/i.test(parts[0] || "")) {
          return original.apply(this, arguments);
        }
        var stack = new Error().stack;
        // The page's own frames: without the "Error" line and this file's wrapper.
        var own = String(stack || "")
          .split("\n")
          .filter(function (l) {
            return l.trim() !== "Error" && l.indexOf("dx-recorder.js") < 0;
          })
          .join("\n");
        push({ type: "console", level: level, text: clip(parts.join(" "), MAX_TEXT), source: caller(stack), stack: (level === "error" || level === "warn") && own ? clip(own, MAX_TEXT) : undefined });
      } catch (e) {
        // keep logging even if this can't
      }
      return original.apply(this, arguments);
    };
  });

  // ------------------------------------------------------------ errors

  addEventListener(
    "error",
    function (e) {
      try {
        var t = e.target;
        if (t && t !== window && t.tagName) {
          // A script, stylesheet or image that didn't load.
          var src = t.src || t.href || t.currentSrc || "";
          push({ type: "error", text: "Couldn't load <" + t.tagName.toLowerCase() + "> " + clip(src, 500) });
          return;
        }
        push({
          type: "error",
          text: clip(e.message || "Uncaught error", MAX_TEXT),
          source: e.filename ? e.filename.replace(location.origin, "") + ":" + e.lineno + ":" + e.colno : undefined,
          stack: e.error && e.error.stack ? clip(e.error.stack, MAX_TEXT) : undefined,
        });
      } catch (err) {
        // nothing to do
      }
    },
    true,
  );

  addEventListener("unhandledrejection", function (e) {
    try {
      var r = e.reason;
      push({ type: "error", text: clip("Unhandled promise rejection: " + (r instanceof Error ? r.message : show(r)), MAX_TEXT), stack: r && r.stack ? clip(r.stack, MAX_TEXT) : undefined, source: r && r.stack ? caller(r.stack) : undefined });
    } catch (err) {
      // nothing to do
    }
  });

  // ------------------------------------------------------------ routes

  function routeChanged(how) {
    var href = location.href;
    if (href === lastHref) return;
    var from = lastHref;
    lastHref = href;
    push({ type: "route", text: short(from) + " → " + short(href) + (how === "back or forward" ? " (back or forward)" : "") });
  }

  function short(href) {
    try {
      var u = new URL(href);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : href;
    } catch (e) {
      return href;
    }
  }

  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      try {
        routeChanged(name);
      } catch (e) {
        // nothing to do
      }
      return result;
    };
  });
  addEventListener("popstate", function () {
    // A link to a #hash fires this too: right after a click, it's the click, not the back button.
    routeChanged(realNow() - lastClick < 1000 ? "link" : "back or forward");
  });
  addEventListener("hashchange", function () {
    routeChanged("hash");
  });

  // ------------------------------------------------------------ clicks and submits

  var CONTROL = 'a,button,summary,select,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],input[type="submit"],input[type="button"],input[type="checkbox"],input[type="radio"],input[type="reset"]';

  function nameOf(el) {
    var label = el.getAttribute("aria-label") || "";
    if (!label && el.id && el.tagName !== "LABEL") {
      var forLabel = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
      if (forLabel) label = forLabel.textContent || "";
    }
    if (!label && el.tagName === "INPUT" && (el.type === "submit" || el.type === "button" || el.type === "reset")) label = el.value || "";
    if (!label && el.tagName !== "SELECT") label = el.innerText || el.textContent || "";
    if (!label) label = el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("alt") || "";
    return clip(label.replace(/\s+/g, " ").trim(), 80);
  }

  /** How to find the control again, to replay the click: a test id, an id, or its label. */
  function targetOf(el, name) {
    var attrs = ["data-testid", "data-test", "data-cy"];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) return "[" + attrs[i] + '="' + v.replace(/"/g, '\\"') + '"]';
    }
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll("#" + el.id).length === 1) return "#" + el.id;
    if (name && name.length <= 60) return "text=" + name;
    return undefined;
  }

  function kindOf(el) {
    var role = el.getAttribute("role");
    if (role) return role;
    if (el.tagName === "A") return "link";
    if (el.tagName === "INPUT") return el.type;
    return el.tagName.toLowerCase();
  }

  document.addEventListener(
    "click",
    function (e) {
      lastClick = realNow();
      try {
        var el = e.target && e.target.closest ? e.target.closest(CONTROL) : null;
        if (!el) return;
        var name = nameOf(el);
        var text = "Clicked " + kindOf(el) + (name ? " “" + name + "”" : "");
        if (el.tagName === "A" && el.getAttribute("href")) text += " (" + clip(short(el.href), 200) + ")";
        if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) text += el.checked ? ", now on" : ", now off";
        push({ type: "action", text: text, target: targetOf(el, name) });
      } catch (err) {
        // nothing to do
      }
    },
    true,
  );

  document.addEventListener(
    "submit",
    function (e) {
      try {
        var f = e.target;
        var name = f.getAttribute("aria-label") || f.getAttribute("name") || f.id || "";
        var method = (f.getAttribute("method") || "get").toUpperCase();
        push({ type: "action", text: "Submitted form" + (name ? " “" + clip(name, 80) + "”" : "") + " (" + method + " " + clip(short(f.action || location.href), 200) + ")" });
      } catch (err) {
        // nothing to do
      }
    },
    true,
  );

  // ------------------------------------------------------------ requests the proxy doesn't see

  /** Requests to this page's own origin, or another name.localhost on the same port, pass through the proxy and are logged there. */
  function proxied(u) {
    if (u.origin === location.origin) return true;
    return /\.localhost$/i.test(u.hostname) && u.port === location.port && u.protocol === location.protocol;
  }

  function loopback(u) {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) || /\.localhost$/i.test(u.hostname);
  }

  function textType(type) {
    return /json|text\/|xml|graphql|x-www-form-urlencoded|javascript/i.test(type || "") && !/event-stream/i.test(type || "");
  }

  function headerOf(headers, name) {
    try {
      if (!headers) return "";
      if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) || "";
      if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) if (String(headers[i][0]).toLowerCase() === name) return String(headers[i][1]);
        return "";
      }
      for (var k in headers) if (k.toLowerCase() === name) return String(headers[k]);
    } catch (e) {
      // unreadable
    }
    return "";
  }

  if (send) {
    window.fetch = function (input, init) {
      var started = realNow();
      var url;
      var method = "GET";
      try {
        method = String((init && init.method) || (input && typeof input === "object" && input.method) || "GET").toUpperCase();
        url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      } catch (e) {
        url = undefined;
      }
      var p = send.apply(window, arguments);
      if (!url || proxied(url) || !/^https?:$/.test(url.protocol)) return p;
      var bodies = loopback(url);
      var reqType = headerOf(init && init.headers, "content-type") || (init && typeof init.body === "string" && /^\s*[[{]/.test(init.body) ? "application/json" : "");
      var ev = { type: "request", method: method, url: url.href, reqType: reqType, req: bodies && init && typeof init.body === "string" ? clip(init.body, MAX_BODY) : undefined };
      p.then(
        function (res) {
          ev.status = res.status;
          ev.ms = realNow() - started;
          var type = res.headers.get("content-type") || "";
          ev.resType = type;
          if (bodies && textType(type)) {
            res
              .clone()
              .text()
              .then(
                function (t) {
                  ev.res = clip(t, MAX_BODY * 2);
                  push(ev);
                },
                function () {
                  push(ev);
                },
              );
          } else push(ev);
        },
        function (err) {
          ev.ms = realNow() - started;
          ev.error = clip((err && err.message) || String(err), 300);
          push(ev);
        },
      );
      return p;
    };
  }

  if (window.XMLHttpRequest) {
    var open = XMLHttpRequest.prototype.open;
    var sendXhr = XMLHttpRequest.prototype.send;
    var setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__dx = { method: String(method || "GET").toUpperCase(), url: new URL(String(url), location.href), type: "" };
      } catch (e) {
        this.__dx = undefined;
      }
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__dx && String(name).toLowerCase() === "content-type") this.__dx.type = String(value);
      } catch (e) {
        // nothing to do
      }
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var x = this;
      var d = x.__dx;
      if (d && !proxied(d.url) && /^https?:$/.test(d.url.protocol)) {
        var started = realNow();
        var bodies = loopback(d.url);
        x.addEventListener("loadend", function () {
          try {
            var type = x.getResponseHeader("content-type") || "";
            var ev = { type: "request", method: d.method, url: d.url.href, status: x.status || undefined, ms: realNow() - started, reqType: d.type, resType: type };
            if (!x.status) ev.error = "no answer";
            if (bodies && typeof body === "string") ev.req = clip(body, MAX_BODY);
            if (bodies && textType(type) && (x.responseType === "" || x.responseType === "text")) ev.res = clip(x.responseText, MAX_BODY * 2);
            push(ev);
          } catch (e) {
            // nothing to do
          }
        });
      }
      return sendXhr.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------ a page gone blank, a spinner that never stops

  var reportedBlank = false;
  var spinners = typeof WeakMap === "function" ? new WeakMap() : null;
  var reportedStuck = {};

  function visibleBox(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }

  // Nothing left to see: no text, no image, no control. What a front end shows after a crash
  // that unmounted it. Error overlays (Vite, Next.js) count as something to see.
  function checkBlank(why) {
    try {
      if (reportedBlank || !document.body || document.visibilityState === "hidden") return;
      if ((document.body.innerText || "").trim()) return;
      var things = document.body.querySelectorAll("img, svg, canvas, video, iframe, input, button, select, textarea, vite-error-overlay, nextjs-portal");
      for (var i = 0; i < things.length && i < 200; i++) if (visibleBox(things[i])) return;
      reportedBlank = true;
      push({ type: "error", problem: "blank", text: "The page went blank" + (why ? " after " + why : "") + ": nothing visible is left on " + short(location.href) });
    } catch (e) {
      // never get in the page's way
    }
  }

  var SPIN = '[aria-busy="true"], [role="progressbar"], .spinner, .loader, .loading, [class*="spinner"], [class*="Spinner"], [class*="loading"], [class*="Loading"], [class*="skeleton"], [class*="Skeleton"]';

  // A loading indicator still showing 15 s after it appeared: an answer that never came, or an
  // error the page didn't handle.
  function checkSpinners() {
    try {
      if (!spinners || document.visibilityState === "hidden") return;
      var now = realNow();
      var list = document.querySelectorAll(SPIN);
      for (var i = 0; i < list.length && i < 50; i++) {
        var el = list[i];
        if (!visibleBox(el)) {
          spinners.delete(el);
          continue;
        }
        var first = spinners.get(el);
        if (!first) {
          spinners.set(el, now);
          continue;
        }
        if (now - first < 15000) continue;
        var desc = clip(show(el), 80);
        if (reportedStuck[desc]) continue;
        reportedStuck[desc] = true;
        push({ type: "error", problem: "stuck", text: "A loading indicator " + desc + " was still showing after 15 s on " + short(location.href) });
      }
    } catch (e) {
      // never get in the page's way
    }
  }

  addEventListener("load", function () {
    setTimeout(function () {
      checkBlank("loading");
    }, 3000);
  });
  setInterval(checkSpinners, 3000);

  // ------------------------------------------------------------ the fake clock

  // The page sees another time (and time zone) than the computer's: Date, Date.now() and
  // formatting. Timers and performance.now() are left alone, so the page still runs at its pace.
  function fakeClock(c) {
    var start = realNow();
    var at = c.at ? RealDate.parse(c.at) : start;
    var offset = at - start;
    var frozen = !!c.frozen;
    var now = function () {
      return frozen ? at : realNow() + offset;
    };
    if (c.at) {
      var FakeDate = class Date extends RealDate {
        constructor() {
          if (arguments.length === 0) super(now());
          else super(...arguments);
        }
        static now() {
          return Math.floor(now());
        }
      };
      // Date() without new gives the time as text.
      window.Date = new Proxy(FakeDate, {
        apply: function () {
          return new FakeDate().toString();
        },
      });
    }
    if (c.timeZone) fakeZone(c.timeZone);
  }

  function fakeZone(tz) {
    var RealFormat = Intl.DateTimeFormat;
    var fmt = new RealFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", timeZoneName: "shortOffset" });
    var proto = RealDate.prototype;
    var getTime = proto.getTime;
    var orig = { toLocaleString: proto.toLocaleString, toLocaleDateString: proto.toLocaleDateString, toLocaleTimeString: proto.toLocaleTimeString };
    var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function parts(d) {
      var t = getTime.call(d);
      if (isNaN(t)) return null;
      var o = {};
      fmt.formatToParts(new RealDate(t)).forEach(function (p) {
        o[p.type] = p.value;
      });
      var p = { y: +o.year, m: +o.month - 1, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: DAYS.indexOf(o.weekday), t: t };
      // Minutes ahead of UTC, from the wall-clock time in the zone.
      p.off = Math.round((RealDate.UTC(p.y, p.m, p.d, p.h, p.mi, p.s) - (t - (((t % 1000) + 1000) % 1000))) / 60000);
      return p;
    }
    function get(key) {
      return function () {
        var p = parts(this);
        return p ? p[key] : NaN;
      };
    }
    function pad(n) {
      return (n < 10 ? "0" : "") + n;
    }
    function gmt(off) {
      var a = Math.abs(off);
      return "GMT" + (off >= 0 ? "+" : "-") + pad(Math.floor(a / 60)) + pad(a % 60);
    }
    proto.getFullYear = get("y");
    proto.getMonth = get("m");
    proto.getDate = get("d");
    proto.getDay = get("wd");
    proto.getHours = get("h");
    proto.getMinutes = get("mi");
    proto.getSeconds = get("s");
    proto.getTimezoneOffset = function () {
      var p = parts(this);
      return p ? -p.off : NaN;
    };
    proto.toDateString = function () {
      var p = parts(this);
      return p ? DAYS[p.wd] + " " + MONTHS[p.m] + " " + pad(p.d) + " " + p.y : "Invalid Date";
    };
    proto.toTimeString = function () {
      var p = parts(this);
      return p ? pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.s) + " " + gmt(p.off) + " (" + tz + ")" : "Invalid Date";
    };
    proto.toString = function () {
      var p = parts(this);
      return p ? this.toDateString() + " " + this.toTimeString() : "Invalid Date";
    };
    ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].forEach(function (name) {
      proto[name] = function (locales, options) {
        var o = Object.assign({}, options);
        if (!o.timeZone) o.timeZone = tz;
        return orig[name].call(this, locales, o);
      };
    });
    var Format = function (locales, options) {
      var o = Object.assign({}, options);
      if (!o.timeZone) o.timeZone = tz;
      return new RealFormat(locales, o);
    };
    Format.prototype = RealFormat.prototype;
    Format.supportedLocalesOf = RealFormat.supportedLocalesOf;
    Intl.DateTimeFormat = Format;
  }
})();

// ------------------------------------------------------------------ custom tools that change the page
// The project's page tools (dx's Tools page): panels, sections and table columns showing data dx
// works out (asked for at /__dx/tools/<id>/<n> on this page's own origin), and highlighted or hidden
// elements. Text only, never HTML; dx's own elements carry data-dx-tool, so each is added once.
(function () {
  var tools = window.__dxPageTools;
  if (!Array.isArray(tools) || !tools.length) return;
  var TONES = { danger: "#d61f1f", warn: "#d97706", ok: "#16a34a" };
  var cache = {};
  var waiting = {};

  function pathMatches(pattern, p) {
    var pat = pattern.split("?")[0].split("/").filter(Boolean);
    var segs = p.split("?")[0].split("#")[0].split("/").filter(Boolean);
    for (var i = 0; i < pat.length; i++) {
      if (pat[i] === "**") return true;
      if (i >= segs.length) return false;
      if (pat[i] === "*" || pat[i].charAt(0) === ":" || /^\{.+\}$/.test(pat[i])) continue;
      if (pat[i].toLowerCase() !== segs[i].toLowerCase()) return false;
    }
    return pat.length === segs.length;
  }
  function get(v, p) {
    if (!p || p === ".") return v;
    var cur = v;
    var segs = p.split(".");
    for (var i = 0; i < segs.length; i++) {
      if (cur === null || cur === undefined || segs[i] === "__proto__" || segs[i] === "constructor" || segs[i] === "prototype") return undefined;
      cur = Object.prototype.hasOwnProperty.call(cur, segs[i]) ? cur[segs[i]] : undefined;
    }
    return cur;
  }
  function fmt(v, f) {
    if (v === undefined || v === null || v === "") return "—";
    var n = typeof v === "number" ? v : Number(v);
    var ok = typeof v !== "boolean" && isFinite(n);
    if (f === "number" && ok) return n.toLocaleString();
    if (f === "money" && ok) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (f === "percent" && ok) return (Math.abs(n) <= 1 ? n * 100 : n).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";
    if (f === "ms" && ok) return Math.round(n) + " ms";
    if (f === "date" || f === "ago") {
      var d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) for (var k in style) e.style[k] = style[k];
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var CELL = { padding: "4px 8px", borderBottom: "1px solid rgba(0,0,0,.12)", textAlign: "left", font: "12px/1.4 system-ui, sans-serif" };
  var mark = function (key) {
    return '[data-dx-tool="' + key + '"]';
  };
  // The app's own elements a tool restyled, with the style each had, so leaving the tool's pages
  // (a route change in the app) puts them back.
  var changed = [];
  function restyle(node, key, prop, value) {
    for (var i = 0; i < changed.length; i++) if (changed[i].node === node && changed[i].key === key) return;
    changed.push({ node: node, key: key, prop: prop, before: node.style[prop] });
    node.style[prop] = value;
  }
  function putBack(key) {
    for (var i = changed.length - 1; i >= 0; i--) {
      var c = changed[i];
      if (c.key !== key && c.node.isConnected) continue;
      if (c.node.isConnected) c.node.style[c.prop] = c.before;
      changed.splice(i, 1);
    }
  }

  // A view's data, drawn plainly: a number, bars, a table, or the JSON.
  function render(body, r) {
    body.textContent = "";
    if (!r || (r.meta && r.meta.error)) return void body.appendChild(el("div", { color: "#b45309", font: "12px system-ui, sans-serif" }, (r && r.meta && r.meta.error) || "No data from dx."));
    var d = r.display || {};
    var data = r.data;
    var rows = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
    if (d.as === "number") return void body.appendChild(el("div", { font: "600 22px system-ui, sans-serif" }, fmt(Array.isArray(data) ? data.length : data, d.format || "number")));
    if (d.as === "bars") {
      var max = 1;
      rows.forEach(function (x) {
        max = Math.max(max, Math.abs(Number(get(x, d.value)) || 0));
      });
      rows.slice(0, 50).forEach(function (x) {
        var line = el("div", { display: "flex", alignItems: "center", gap: "6px", font: "12px system-ui, sans-serif", margin: "2px 0" });
        line.appendChild(el("span", { width: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, String(get(x, d.label))));
        var track = el("span", { flex: "1", height: "8px", background: "rgba(0,0,0,.08)", borderRadius: "4px", overflow: "hidden" });
        track.appendChild(el("span", { display: "block", height: "100%", width: (Math.abs(Number(get(x, d.value)) || 0) / max) * 100 + "%", background: "#0b7a78" }));
        line.appendChild(track);
        line.appendChild(el("span", null, fmt(get(x, d.value), d.format || "number")));
        body.appendChild(line);
      });
      return;
    }
    if (d.as === "table" || d.as === "cards") {
      if (!rows.length) return void body.appendChild(el("div", { font: "12px system-ui, sans-serif" }, "Nothing to show."));
      var first = rows[0];
      var cols = d.columns || d.fields || (first && typeof first === "object" ? Object.keys(first).slice(0, 8).map(function (f) { return { field: f }; }) : [{ field: "", label: "Value" }]);
      var table = el("table", { borderCollapse: "collapse", width: "100%" });
      var head = el("tr");
      cols.forEach(function (c) {
        head.appendChild(el("th", Object.assign({ fontWeight: "600" }, CELL), c.label || c.field));
      });
      table.appendChild(head);
      rows.slice(0, 200).forEach(function (x, i) {
        var tr = el("tr");
        var tone = r.tones && r.tones[i];
        if (tone) tr.style.background = TONES[tone] + "22";
        cols.forEach(function (c) {
          tr.appendChild(el("td", CELL, fmt(get(x, c.field), c.format)));
        });
        table.appendChild(tr);
      });
      return void body.appendChild(table);
    }
    body.appendChild(el("pre", { margin: "0", font: "11px/1.4 ui-monospace, monospace", whiteSpace: "pre-wrap", maxHeight: "260px", overflow: "auto" }, JSON.stringify(data, null, 2)));
  }

  // The data for one change, asked of dx at most every 15 seconds.
  function load(id, n, cb) {
    var k = id + "/" + n;
    var c = cache[k];
    if (c && Date.now() - c.at < 15000) return cb(c.data);
    (waiting[k] = waiting[k] || []).push(cb);
    if (waiting[k].length > 1) return;
    fetch("/__dx/tools/" + id + "/" + n, { credentials: "same-origin" })
      .then(function (res) {
        return res.json();
      })
      .catch(function () {
        return { meta: { error: "dx didn't answer." } };
      })
      .then(function (j) {
        cache[k] = { at: Date.now(), data: j };
        var list = waiting[k] || [];
        delete waiting[k];
        list.forEach(function (f) {
          f(j);
        });
      });
  }

  function box(key, title, tool) {
    var wrap = el("div", { border: "1px solid rgba(0,0,0,.18)", borderRadius: "8px", background: "#fff", color: "#111", margin: "8px 0", font: "12px system-ui, sans-serif", boxShadow: "0 2px 8px rgba(0,0,0,.08)" });
    wrap.setAttribute("data-dx-tool", key);
    var bar = el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", padding: "4px 8px", background: "#e6f4f3", borderRadius: "8px 8px 0 0", font: "600 12px system-ui, sans-serif" });
    bar.appendChild(el("span", null, title));
    bar.appendChild(el("span", { fontWeight: "400", opacity: ".7" }, "dx · " + tool));
    var body = el("div", { padding: "6px 8px", maxHeight: "320px", overflow: "auto" }, "Loading…");
    wrap.appendChild(bar);
    wrap.appendChild(body);
    return { wrap: wrap, body: body };
  }

  function panelHost() {
    var host = document.querySelector(mark("panels"));
    if (!host) {
      host = el("div", { position: "fixed", right: "12px", bottom: "12px", width: "360px", maxWidth: "calc(100vw - 24px)", maxHeight: "70vh", overflow: "auto", zIndex: "2147483000" });
      host.setAttribute("data-dx-tool", "panels");
      document.body.appendChild(host);
    }
    return host;
  }

  function addColumn(t, c, n, key) {
    var table;
    try {
      table = document.querySelector(c.table);
    } catch (e) {
      table = null;
    }
    if (!table) return;
    var trs = table.querySelectorAll("tr");
    if (!trs.length) return;
    var headRow = table.tHead && table.tHead.rows[0] ? table.tHead.rows[0] : trs[0];
    if (!headRow.querySelector(mark(key))) {
      var th = el("th", null, c.header);
      th.setAttribute("data-dx-tool", key);
      headRow.appendChild(th);
    }
    var todo = [];
    for (var i = 0; i < trs.length; i++) if (trs[i] !== headRow && !trs[i].querySelector(mark(key))) todo.push(trs[i]);
    if (!todo.length) return;
    load(t.id, n, function (r) {
      var items = r && Array.isArray(r.data) ? r.data : [];
      todo.forEach(function (tr) {
        if (tr.querySelector(mark(key))) return;
        var cell = tr.cells[c.key.cell];
        var keyText = cell ? cell.textContent.trim() : "";
        var item = null;
        for (var j = 0; j < items.length; j++) {
          if (String(get(items[j], c.key.field)) === keyText) {
            item = items[j];
            break;
          }
        }
        var td = el("td", null, item ? fmt(get(item, c.value), c.format) : "—");
        td.setAttribute("data-dx-tool", key);
        tr.appendChild(td);
      });
    });
  }

  function apply() {
    if (!document.body) return;
    var p = location.pathname;
    tools.forEach(function (t) {
      var on = pathMatches(t.path, p);
      t.changes.forEach(function (c, n) {
        var key = t.id + "-" + n;
        var mine = document.querySelector(mark(key));
        if (c.panel || c.section) {
          if (!on) return void (mine && mine.remove());
          if (mine) return;
          var b = box(key, (c.panel || c.section).title, t.name);
          if (c.panel) panelHost().appendChild(b.wrap);
          else {
            var at;
            try {
              at = document.querySelector(c.section.at);
            } catch (e) {
              at = null;
            }
            if (!at || !at.parentNode) return;
            if (c.section.place === "before") at.parentNode.insertBefore(b.wrap, at);
            else if (c.section.place === "inside") at.appendChild(b.wrap);
            else at.parentNode.insertBefore(b.wrap, at.nextSibling);
          }
          load(t.id, n, function (r) {
            render(b.body, r);
          });
        } else if (c.column) {
          if (on) addColumn(t, c.column, n, key);
          else document.querySelectorAll(mark(key)).forEach(function (x) {
            x.remove();
          });
        } else if ((c.highlight || c.hide) && !on) putBack(key);
        else if (c.highlight || c.hide) {
          var found;
          try {
            found = document.querySelectorAll((c.highlight || c.hide).selector);
          } catch (e) {
            found = [];
          }
          for (var x = 0; x < found.length; x++) {
            var node = found[x];
            if (node.closest && node.closest("[data-dx-tool]")) continue;
            if (c.hide) restyle(node, key, "display", "none");
            else if (!c.highlight.text || node.textContent.toLowerCase().indexOf(c.highlight.text.toLowerCase()) >= 0) restyle(node, key, "outline", "2px solid " + (TONES[c.highlight.tone] || TONES.warn));
          }
        }
      });
    });
  }

  // Again when the page changes (a route, new rows), but not for dx's own elements.
  var timer = 0;
  function soon() {
    clearTimeout(timer);
    timer = setTimeout(apply, 300);
  }
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var target = list[i].target;
      if (!(target.closest && target.closest("[data-dx-tool]"))) return soon();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", soon);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  else apply();
})();
