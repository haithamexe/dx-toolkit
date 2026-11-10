// Floppy's page on macOS and Linux: plays the frames, shows the balloon and the line beside it,
// and says what was clicked. It does what floppyWindow.ts does on Windows, message for message.
// Text goes in as text nodes (textContent); nothing it's sent is run.
(() => {
  const bridge = window.floppy;
  const img = document.getElementById("floppy");
  const tip = document.getElementById("tip");
  const tipTitle = document.getElementById("tip-title");
  const tipText = document.getElementById("tip-text");
  const tipDot = document.getElementById("tip-dot");
  const label = document.getElementById("label");
  const labelText = document.getElementById("label-text");
  const labelDot = document.getElementById("label-dot");
  const ICONS = ["info", "error", "ok", "ai", "quiet", "warn"];

  let frames = {};
  let once = {};
  let size = { w: 64, h: 60 };
  let stripWidth = window.innerWidth;
  let left = 0;
  const state = { mood: "idle", base: "idle", i: 0 };
  const tipState = { data: null, sticky: false, until: 0, hover: false };
  let labelData = null;
  let timer;

  const icon = (name) => (ICONS.includes(name) ? name : "info");
  const clamp = (x) => Math.min(Math.max(0, x), stripWidth - size.w);

  // ------------------------------------------------------------ where things are
  /** The parts the pointer can hit, for the window to let clicks through everywhere else. */
  function hitRects() {
    return [img, tip, label].filter((el) => !el.hidden).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
  }
  function reportShape() {
    // In the window's own coordinates (DIPs, as every Electron window API).
    bridge.send({ event: "shape", rects: hitRects() });
  }
  function placeTip() {
    if (tip.hidden) return;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(4, left + size.w / 2 - w / 2), stripWidth - w - 4)}px`;
    tip.style.top = `${window.innerHeight - size.h - tip.offsetHeight + 4}px`;
  }
  function placeLabel() {
    if (label.hidden) return;
    const w = label.offsetWidth;
    let x = left - w - 2;
    if (x < 4) x = left + size.w + 2;
    label.style.left = `${Math.min(Math.max(4, x), stripWidth - w - 4)}px`;
  }
  function placeAll() {
    img.style.left = `${left}px`;
    placeTip();
    placeLabel();
    reportShape();
  }

  // ------------------------------------------------------------ balloon and line
  function showTip(data) {
    if (!data) return;
    tipTitle.textContent = String(data.title ?? "");
    tipText.textContent = String(data.text ?? "");
    tipDot.className = `dot ${icon(data.icon)}`;
    tip.hidden = false;
    placeAll();
  }
  function hideTip() {
    if (tip.hidden) return;
    tip.hidden = true;
    placeAll();
  }
  function showLabel() {
    if (!labelData) return;
    labelText.textContent = String(labelData.text ?? "");
    labelDot.className = `dot ${icon(labelData.icon)}`;
    label.hidden = false;
    placeAll();
  }

  // ------------------------------------------------------------ frames
  function showFrame() {
    const list = frames[state.mood];
    if (!list?.length) return;
    const f = list[state.i % list.length];
    img.src = f.src;
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(40, f.ms));
  }
  function setMood(m) {
    if (!frames[m]) return;
    state.mood = m;
    state.i = 0;
    showFrame();
  }
  function tick() {
    state.i += 1;
    if (state.i >= (frames[state.mood]?.length ?? 1)) {
      state.i = 0;
      if (once[state.mood]) state.mood = state.base;
    }
    showFrame();
    if (tipState.data && !tipState.sticky && !tipState.hover && Date.now() > tipState.until) hideTip();
  }

  // ------------------------------------------------------------ the pointer
  const drag = { down: false, moved: false, sx: 0, sl: 0 };
  const hover = (on) => {
    tipState.hover = on;
    if (on) showTip(tipState.data);
    else if (!tipState.sticky && Date.now() > tipState.until) hideTip();
  };
  // macOS: the window ignores the mouse except over Floppy, its balloon and its line.
  for (const el of [img, tip, label]) {
    el.addEventListener("mouseenter", () => bridge.send({ event: "hit", on: true }));
    el.addEventListener("mouseleave", () => !drag.down && bridge.send({ event: "hit", on: false }));
  }
  img.addEventListener("mouseenter", () => hover(true));
  img.addEventListener("mouseleave", () => hover(false));
  label.addEventListener("mouseenter", () => hover(true));
  label.addEventListener("mouseleave", () => hover(false));
  img.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    Object.assign(drag, { down: true, moved: false, sx: e.screenX, sl: left });
    img.setPointerCapture(e.pointerId);
  });
  img.addEventListener("pointermove", (e) => {
    if (!drag.down) return;
    const dx = e.screenX - drag.sx;
    if (!drag.moved && Math.abs(dx) > 4) {
      drag.moved = true;
      hideTip();
      setMood("held");
    }
    if (drag.moved) {
      left = clamp(drag.sl + dx);
      placeAll();
    }
  });
  img.addEventListener("pointerup", () => {
    if (!drag.down) return;
    drag.down = false;
    if (drag.moved) {
      drag.moved = false;
      setMood(state.base);
      bridge.send({ event: "moved", x: left });
    } else {
      tipState.sticky = false;
      hideTip();
      bridge.send({ event: "click" });
    }
  });
  const openDx = () => {
    tipState.sticky = false;
    hideTip();
    bridge.send({ event: "click" });
  };
  tip.addEventListener("click", openDx);
  label.addEventListener("click", openDx);
  img.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    hideTip();
    bridge.send({ event: "menu" });
  });

  // ------------------------------------------------------------ messages from dx
  function sized(sprite) {
    // Whole device pixels only, so the pixel art stays sharp: twice its size at 1x, four times on Retina.
    const n = Math.max(2, Math.round(2 * devicePixelRatio));
    size = { w: (sprite.width * n) / devicePixelRatio, h: (sprite.height * n) / devicePixelRatio };
    img.style.width = `${size.w}px`;
    img.style.height = `${size.h}px`;
  }
  bridge.on((msg) => {
    if (msg.type === "init") {
      frames = {};
      once = {};
      for (const m of msg.sprite.moods) {
        frames[m.key] = m.frames;
        once[m.key] = !!m.once;
      }
      sized(msg.sprite);
      stripWidth = msg.width;
      left = clamp(Number.isFinite(msg.x) ? msg.x : stripWidth - size.w - 140);
      setMood("idle");
      placeAll();
    } else if (msg.type === "resize") {
      stripWidth = msg.width;
      left = clamp(left);
      placeAll();
    } else if (msg.type === "mood") {
      const then = String(msg.mood);
      state.base = then;
      if (msg.play) {
        if (!drag.moved) setMood(String(msg.play));
      } else if (!drag.moved && !(once[state.mood] && state.mood !== then)) setMood(then);
      if (msg.tip) tipState.data = msg.tip;
      if (msg.status) {
        labelData = msg.status;
        showLabel();
      }
      tipState.sticky = !!msg.sticky;
      if (msg.announce || msg.sticky) {
        tipState.until = Date.now() + 5000;
        if (!drag.down) showTip(tipState.data);
      } else if (!tip.hidden && tipState.hover) showTip(tipState.data);
    }
  });
  window.addEventListener("resize", () => {
    stripWidth = window.innerWidth;
    left = clamp(left);
    placeAll();
  });
})();
