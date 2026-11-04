// dx activity recorder. The dx local domains proxy adds this to pages served at name.localhost,
// so the dashboard's Activity page has what happened in the browser: route changes, clicks and
// form submits (never what's typed), console output, uncaught errors, and requests the proxy
// doesn't see (to localhost:<port> and other addresses). Turn it off with "activity": false in
// ~/.dx/config.json. It only ever sends to its own page's origin.
(function () {
  "use strict";
  if (window.__dxRecorder) return;
  window.__dxRecorder = true;

  var ENDPOINT = "/__dx/events";
  var MAX_TEXT = 4000;
  var MAX_BODY = 16384;
  var visit = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
      ev.at = Date.now();
      ev.page = location.href;
      queue.push(ev);
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
    routeChanged(Date.now() - lastClick < 1000 ? "link" : "back or forward");
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
      lastClick = Date.now();
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
      var started = Date.now();
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
          ev.ms = Date.now() - started;
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
          ev.ms = Date.now() - started;
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
        var started = Date.now();
        var bodies = loopback(d.url);
        x.addEventListener("loadend", function () {
          try {
            var type = x.getResponseHeader("content-type") || "";
            var ev = { type: "request", method: d.method, url: d.url.href, status: x.status || undefined, ms: Date.now() - started, reqType: d.type, resType: type };
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
})();
