// x402·card demo site. Ported from the design reference's Component class
// (site/design/x402 Card.dc.html); timings and easings match it. Adds live
// lookups against the gateway Worker where real data exists.
(() => {
  "use strict";

  const API = "https://x402card.dmpay.workers.dev";
  const ROOT = "x402card.eth";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  let R = mq.matches;
  mq.addEventListener?.("change", (e) => { R = e.matches; });

  // ---------- Hero tilt ----------
  function initTilt() {
    const w = $("[data-tilt]"), sheen = $("[data-sheen]");
    if (!w || R) return;
    let tx = 0, ty = 0, x = 0, y = 0;
    const cl = (v) => Math.max(-1, Math.min(1, v));
    window.addEventListener("pointermove", (e) => {
      const r = w.getBoundingClientRect();
      tx = cl((e.clientX - (r.left + r.width / 2)) / r.width);
      ty = cl((e.clientY - (r.top + r.height / 2)) / r.height);
    }, { passive: true });
    window.addEventListener("deviceorientation", (e) => {
      if (e.gamma == null) return;
      tx = cl(e.gamma / 30); ty = cl((e.beta - 45) / 30);
    });
    // iOS 13+: ask once on first tap.
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      window.addEventListener("touchend", () => DOE.requestPermission().catch(() => {}), { once: true });
    }
    const loop = (t) => {
      if (R) { w.style.transform = "none"; return; }
      x += (tx - x) * 0.07; y += (ty - y) * 0.07;
      const bob = Math.sin(t / 1500) * 6;
      w.style.transform = `translate3d(0,${bob.toFixed(2)}px,0) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 14).toFixed(2)}deg)`;
      if (sheen) sheen.style.transform = `translate3d(${(x * 22).toFixed(2)}%,0,0)`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- Hero resolve ----------
  let heroStop = false;
  function initHero() {
    const q = $("[data-hero-q]"), card = $("[data-hero-card]"), name = $("[data-hero-name]"), num = $("[data-hero-num]"),
      st = $("[data-hero-st]"), res = $("[data-hero-res]"), glow = $("[data-hero-glow]");
    const target = "researcher." + ROOT;
    let resolved = false, lookupSeq = 0, lookupTimer;
    const last4 = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 9973; return String(1000 + (h % 9000)); };
    const set = (p) => {
      card.style.transition = "opacity .25s ease, filter .25s ease, transform .25s ease";
      card.style.opacity = (0.12 + 0.45 * p).toFixed(3);
      card.style.filter = `blur(${(12 * (1 - p)).toFixed(1)}px)`;
      card.style.transform = `translateY(${(18 * (1 - p)).toFixed(1)}px) scale(${(0.94 + 0.03 * p).toFixed(3)})`;
    };

    // Names under x402card.eth that have a real card: show their live records.
    const live = (v) => {
      clearTimeout(lookupTimer);
      st.textContent = "RESOLVED"; st.classList.remove("live");
      if (!v.toLowerCase().endsWith("." + ROOT)) return;
      const seq = ++lookupSeq;
      lookupTimer = setTimeout(async () => {
        try {
          const r = await fetch(`${API}/public/cards/${encodeURIComponent(v.toLowerCase())}`);
          if (seq !== lookupSeq || !r.ok) return;
          const d = await r.json();
          if (!d.exists) return;
          const rec = d.records || {};
          const status = rec["card.status"] || "active";
          st.textContent = "LIVE · ENS"; st.classList.add("live");
          res.textContent = `${v} → ${status} · tx ≤ ${money(rec["card.limit.tx"])} · mo ≤ ${money(rec["card.limit.monthly"])}`;
        } catch { /* offline: keep the illustrative card */ }
      }, 350);
    };

    const update = (v) => {
      name.textContent = v;
      const ok = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(v) && v.length > 4;
      if (ok) {
        const l4 = v === target ? "4021" : last4(v);
        num.textContent = "•••• •••• •••• " + l4;
        res.textContent = `${v} → card ••${l4} · active`;
        if (!resolved) {
          resolved = true;
          card.style.transition = R ? "none" : "opacity .7s cubic-bezier(.2,.9,.2,1), filter .7s cubic-bezier(.2,.9,.2,1), transform .8s cubic-bezier(.2,1.2,.3,1)";
          card.style.opacity = "1"; card.style.filter = "blur(0px)"; card.style.transform = "none";
          if (!R) glow.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 1100, easing: "ease-out" });
        }
        st.style.opacity = "1"; res.style.opacity = "1";
        live(v);
      } else {
        resolved = false; lookupSeq++;
        set(Math.min(1, v.length / target.length) * 0.9);
        st.style.opacity = "0"; res.style.opacity = v ? "1" : "0";
        res.textContent = v ? "resolving…" : "";
      }
    };
    q.addEventListener("input", () => { heroStop = true; update(q.value.trim()); });
    q.addEventListener("focus", () => { heroStop = true; });
    if (R) { q.value = target; update(target); return; }
    let i = 0;
    const step = () => {
      if (heroStop) return;
      i++; q.value = target.slice(0, i); update(q.value);
      if (i < target.length) setTimeout(step, 55 + Math.random() * 45);
    };
    setTimeout(step, 700);
  }

  function money(v) {
    const n = Number(v);
    return Number.isFinite(n) ? "$" + n.toLocaleString("en-US") : "?";
  }

  // ---------- Beats ----------
  const runs = {};
  let approveResolver = null;

  function initBeats() {
    const bars = $("[data-bars]");
    for (let i = 0; i < 28; i++) {
      const h = 10 + ((i * 37) % 17) + (i % 3) * 4;
      const b = document.createElement("div");
      b.className = "bar"; b.dataset.bar = ""; b.dataset.h = h; b.style.height = h + "px";
      bars.appendChild(b);
    }
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting && !e.target.dataset.played) { e.target.dataset.played = "1"; play(e.target.dataset.stage); }
    }), { threshold: 0.45 });
    $$("[data-stage]").forEach((s) => io.observe(s));
    $$("[data-replay]").forEach((b) => b.addEventListener("click", () => play(b.dataset.replay)));
    $('[data-stage="4"] [data-a="approve"]').addEventListener("click", () => { const f = approveResolver; approveResolver = null; f && f(); });
  }

  function play(id) {
    const stage = $(`[data-stage="${id}"]`);
    const token = (runs[id] || 0) + 1; runs[id] = token;
    const c = ctx(stage, () => runs[id] !== token);
    c.reset();
    BEATS[id](c).catch((e) => { if (e !== "cancel") console.error(e); });
  }

  function ctx(stage, cancelled) {
    const check = () => { if (cancelled()) throw "cancel"; };
    const a = (n) => stage.querySelector(`[data-a="${n}"]`);
    const wait = async (ms) => { await new Promise((r) => setTimeout(r, R ? Math.min(ms, 20) : ms)); check(); };
    const to = async (el, kf, o = {}) => {
      if (R && o.it === Infinity) return;
      const an = el.animate(kf, { duration: R ? 1 : (o.d || 500), delay: R ? 0 : (o.delay || 0), easing: o.e || "cubic-bezier(.2,.8,.2,1)", fill: "forwards", iterations: o.it || 1 });
      if (o.nowait || o.it === Infinity) return an;
      await an.finished.catch(() => {}); check(); return an;
    };
    const text = (el, t) => { if (el.dataset.t === undefined) el.dataset.t = el.textContent; el.textContent = t; };
    return {
      a, stage, wait, to, text, check,
      reset() {
        stage.querySelectorAll("[data-clone]").forEach((n) => n.remove());
        stage.querySelectorAll("*").forEach((el) => {
          el.getAnimations().forEach((an) => an.cancel());
          if (el.dataset.t !== undefined) el.textContent = el.dataset.t;
        });
      },
      async type(el, s, ms = 55) {
        if (R) { text(el, s); return; }
        text(el, "");
        for (let i = 1; i <= s.length; i++) { el.textContent = s.slice(0, i); await wait(ms + Math.random() * 30); }
      },
      async scramble(el, last) {
        const d = () => String(Math.floor(Math.random() * 10));
        if (!R) for (let f = 0; f < 12; f++) {
          text(el, Array.from({ length: 4 }, () => d() + d() + d() + d()).join(" "));
          await wait(45);
        }
        text(el, "•••• •••• •••• " + last);
      },
      async count(el, from, to2, d) {
        if (R) { text(el, "$" + to2); return; }
        const t0 = performance.now();
        await new Promise((res) => {
          const f = (t) => {
            const p = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - p, 3);
            text(el, "$" + Math.round(from + (to2 - from) * e));
            p < 1 && !cancelled() ? requestAnimationFrame(f) : res();
          };
          requestAnimationFrame(f);
        });
        check();
      },
      async fly(from, target, o = {}) {
        const sr = stage.getBoundingClientRect(), ra = from.getBoundingClientRect(), rb = target.getBoundingClientRect();
        const cl = target.cloneNode(true);
        cl.removeAttribute("data-a"); cl.setAttribute("data-clone", "");
        Object.assign(cl.style, {
          position: "absolute", margin: "0", zIndex: "20", pointerEvents: "none", opacity: "1",
          left: (ra.left + ra.width / 2 - rb.width / 2 - sr.left) + "px", top: (ra.top + ra.height / 2 - rb.height / 2 - sr.top) + "px", width: rb.width + "px",
        });
        stage.appendChild(cl);
        const dx = rb.left - (ra.left + ra.width / 2 - rb.width / 2), dy = rb.top - (ra.top + ra.height / 2 - rb.height / 2);
        await to(cl, [
          { transform: "translate(0,0) scale(0.9)", boxShadow: "0 0 0 0 oklch(0.74 0.19 258 / 0)" },
          { transform: `translate(${dx * 0.5}px,${dy * 0.5}px) scale(1.06)`, boxShadow: "0 0 24px 2px oklch(0.74 0.19 258 / 0.6)", offset: 0.5 },
          { transform: `translate(${dx}px,${dy}px) scale(1)`, boxShadow: "0 0 12px 0 oklch(0.74 0.19 258 / 0.4)" },
        ], { d: o.d || 650, e: "cubic-bezier(.45,0,.2,1)" });
        return cl;
      },
      dy(p, q) { const r1 = p.getBoundingClientRect(), r2 = q.getBoundingClientRect(); return (r2.top + r2.height / 2) - (r1.top + r1.height / 2); },
    };
  }

  const BEATS = {
    async 1(c) {
      const { a } = c;
      await c.wait(350);
      c.to(a("ph"), [{ opacity: 1 }, { opacity: 0 }], { d: 150 });
      c.to(a("caret"), [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.51 }, { opacity: 0 }], { d: 1000, it: Infinity, e: "linear" });
      await c.type(a("in"), "scout.x402card.eth", 55);
      await c.wait(250);
      c.to(a("btn"), [{ transform: "scale(1)" }, { transform: "scale(0.93)" }, { transform: "scale(1)" }], { d: 260 });
      await c.to(a("btn"), [{ boxShadow: "0 0 0 0 oklch(0.74 0.19 258 / 0.6)" }, { boxShadow: "0 0 0 14px oklch(0.74 0.19 258 / 0)" }], { d: 450 });
      await c.to(a("card"), [{ opacity: 0, transform: "translateY(28px) scale(0.96)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { d: 700 });
      await c.scramble(a("num"), "5880");
      await c.type(a("name"), "scout.x402card.eth", 26);
      await c.to(a("cap"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { d: 500 });
    },

    async 2(c) {
      const { a } = c;
      await c.wait(400);
      const hl = "oklch(0.74 0.19 258 / 0.12)";
      for (let i = 1; i <= 3; i++) {
        const row = a("r" + i), tag = a("t" + i);
        await c.to(row, [{ background: "rgba(0,0,0,0)" }, { background: hl }], { d: 280 });
        const clone = await c.fly(a("v" + i), tag, { d: 700 });
        await c.to(tag, [{ opacity: 0, boxShadow: "0 0 12px 0 oklch(0.74 0.19 258 / 0.4)" }, { opacity: 1, boxShadow: "0 0 0 0 oklch(0.74 0.19 258 / 0)" }], { d: 60 });
        clone.remove();
        c.to(row, [{ background: hl }, { background: "rgba(255,255,255,0.02)" }], { d: 500 });
        await c.wait(180);
      }
      const base = "0 30px 60px -24px rgba(0,0,0,0.8)";
      c.to(a("card"), [{ boxShadow: base + ", 0 0 0 0 oklch(0.74 0.19 258 / 0)" }, { boxShadow: base + ", 0 0 0 1px oklch(0.74 0.19 258 / 0.6)", offset: 0.4 }, { boxShadow: base + ", 0 0 0 0 oklch(0.74 0.19 258 / 0)" }], { d: 900 });
    },

    async 3(c) {
      const { a } = c, card = a("card"), m1 = a("m1"), m2 = a("m2");
      const base = "0 30px 60px -24px rgba(0,0,0,0.8)";
      await c.wait(300);
      await c.to(m1, [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "translateY(0)" }], { d: 450 });
      await c.wait(450);
      const d = c.dy(m1, card);
      await c.to(m1, [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: `translateY(${d}px) scale(0.4)` }], { d: 560, e: "cubic-bezier(.55,0,.8,.2)" });
      c.to(card, [{ transform: "scale(1)", boxShadow: base + ", 0 0 0 0 oklch(0.8 0.16 155 / 0)" }, { transform: "scale(1.025)", boxShadow: base + ", 0 0 0 2px oklch(0.8 0.16 155 / 0.7), 0 0 40px oklch(0.8 0.16 155 / 0.3)", offset: 0.3 }, { transform: "scale(1)", boxShadow: base + ", 0 0 0 0 oklch(0.8 0.16 155 / 0)" }], { d: 800 });
      c.text(a("spent"), "$42 / $500");
      c.to(a("spent"), [{ color: "oklch(0.8 0.16 155)" }, { color: "#eceef1" }], { d: 1200 });
      await c.to(a("ok"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { d: 400 });
      await c.wait(1500);
      c.to(a("ok"), [{ opacity: 1 }, { opacity: 0 }], { d: 300 });
      await c.to(m2, [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "translateY(0)" }], { d: 450 });
      await c.wait(450);
      await c.to(m2, [{ transform: "translateY(0)" }, { transform: `translateY(${d * 0.5}px)` }], { d: 380, e: "cubic-bezier(.55,0,.8,.2)" });
      c.to(m2, [{ borderColor: "rgba(255,255,255,0.12)", background: "#15181e" }, { borderColor: "oklch(0.7 0.19 25)", background: "oklch(0.7 0.19 25 / 0.12)" }], { d: 200 });
      c.to(card, [{ transform: "translateY(0)" }, { transform: "translateY(4px)", offset: 0.3 }, { transform: "translateY(0)" }], { d: 300 });
      c.to(a("err"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { d: 400, delay: 350 });
      await c.to(m2, [{ transform: `translateY(${d * 0.5}px)` }, { transform: "translateY(-12px)", offset: 0.4 }, { transform: "translate(-9px,0)", offset: 0.55 }, { transform: "translate(8px,0)", offset: 0.68 }, { transform: "translate(-5px,0)", offset: 0.8 }, { transform: "translate(3px,0)", offset: 0.9 }, { transform: "translate(0,0)" }], { d: 800, e: "ease-out" });
    },

    async 4(c) {
      const { a } = c;
      const amb = "oklch(0.84 0.14 80)", grn = "oklch(0.8 0.16 155)";
      approveResolver = null;
      await c.wait(300);
      await c.to(a("req"), [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }], { d: 450 });
      await c.to(a("l1"), [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { d: 300 });
      await c.to(a("pol"), [{ opacity: 0 }, { opacity: 1 }], { d: 300 });
      c.text(a("polst"), "evaluating…");
      c.to(a("dot"), [{ background: "#5d626c" }, { background: "#eceef1" }], { d: 300 });
      await c.wait(800);
      c.text(a("polst"), "PAUSED · $300 > card.limit.tx");
      c.to(a("polst"), [{ color: amb }, { color: amb }], { d: 10 });
      c.to(a("pol"), [{ borderColor: "rgba(255,255,255,0.1)" }, { borderColor: "oklch(0.84 0.14 80 / 0.6)" }], { d: 300 });
      c.to(a("dot"), [{ background: amb, boxShadow: "0 0 0 0 oklch(0.84 0.14 80 / 0.6)" }, { background: amb, boxShadow: "0 0 0 7px oklch(0.84 0.14 80 / 0)" }], { d: 1200, it: Infinity, e: "ease-out" });
      c.to(a("dot"), [{ background: amb }, { background: amb }], { d: 10 });
      await c.to(a("l2"), [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { d: 300 });
      await c.to(a("act"), [{ opacity: 0.25 }, { opacity: 1 }], { d: 300 });
      c.to(a("ring"), [{ opacity: 0.9, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.18)" }], { d: 1400, it: Infinity, e: "ease-out" });
      await new Promise((res) => { approveResolver = res; });
      c.check();
      a("ring").getAnimations().forEach((an) => an.cancel());
      c.to(a("approve"), [{ transform: "scale(1)" }, { transform: "scale(0.94)" }, { transform: "scale(1)" }], { d: 240 });
      c.text(a("approve"), "Approved ✓");
      c.to(a("approve"), [{ background: "oklch(0.74 0.19 258)" }, { background: grn }], { d: 300 });
      c.text(a("polst"), "RELEASED · approved by alice.eth");
      c.to(a("polst"), [{ color: grn }, { color: grn }], { d: 10 });
      c.to(a("pol"), [{ borderColor: "oklch(0.84 0.14 80 / 0.6)" }, { borderColor: "oklch(0.8 0.16 155 / 0.5)" }], { d: 300 });
      a("dot").getAnimations().forEach((an) => an.cancel());
      c.to(a("dot"), [{ background: grn }, { background: grn }], { d: 10 });
      await c.wait(250);
      c.text(a("rec"), "card.limit.monthly = 800");
      c.to(a("rec"), [{ color: "oklch(0.86 0.1 258)" }, { color: "oklch(0.86 0.1 258)", offset: 0.7 }, { color: "#5d626c" }], { d: 2000 });
      c.to(a("fill"), [{ transform: "scaleX(0.5)" }, { transform: "scaleX(0.8)" }], { d: 1100, e: "cubic-bezier(.4,0,.2,1)" });
      await c.count(a("allow"), 500, 800, 1100);
    },

    async 5(c) {
      const { a } = c, red = "oklch(0.7 0.19 25)", ice = "oklch(0.9 0.05 230)";
      await c.wait(300);
      const spike = [...c.stage.querySelectorAll("[data-bar]")].slice(-8);
      spike.forEach((b, i) => {
        const s = Math.min(92, 46 + i * 7) / +b.dataset.h;
        c.to(b, [{ transform: "scaleY(1)", background: "rgba(255,255,255,0.16)" }, { transform: `scaleY(${s})`, background: red }], { d: 380, delay: i * 85, e: "cubic-bezier(.3,1.3,.5,1)" });
      });
      await c.wait(spike.length * 85 + 380);
      await c.to(a("alert"), [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { d: 350 });
      await c.wait(400);
      c.to(a("card"), [{ boxShadow: "0 30px 60px -24px rgba(0,0,0,0.8)" }, { boxShadow: "0 30px 60px -24px rgba(0,0,0,0.8), 0 0 50px oklch(0.9 0.05 230 / 0.25)" }], { d: 1100 });
      await c.to(a("frost"), [{ opacity: 0 }, { opacity: 1 }], { d: 1100, e: "cubic-bezier(.3,.6,.3,1)" });
      const s = a("status");
      await c.to(s, [{ transform: "rotateX(0deg)" }, { transform: "rotateX(90deg)" }], { d: 170, e: "ease-in" });
      c.text(s, "frozen");
      await c.to(s, [{ transform: "rotateX(-90deg)", color: ice }, { transform: "rotateX(0deg)", color: ice }], { d: 220, e: "ease-out" });
      await c.to(a("stamp"), [{ opacity: 0, transform: "scale(1.15)" }, { opacity: 1, transform: "scale(1)" }], { d: 380 });
      await c.to(a("after"), [{ opacity: 0 }, { opacity: 1 }], { d: 400 });
    },
  };

  // ---------- Activity feed ----------
  const KINDS = {
    ok: { st: "APPROVED", c: "oklch(0.8 0.16 155)", bg: "oklch(0.8 0.16 155 / 0.1)" },
    mcc: { st: "MCC_NOT_ALLOWED", c: "oklch(0.7 0.19 25)", bg: "oklch(0.7 0.19 25 / 0.12)" },
    hold: { st: "PENDING_HUMAN", c: "oklch(0.84 0.14 80)", bg: "oklch(0.84 0.14 80 / 0.1)" },
    fund: { st: "FUNDED", c: "oklch(0.86 0.1 258)", bg: "oklch(0.74 0.19 258 / 0.14)" },
    frz: { st: "FROZEN", c: "oklch(0.9 0.05 230)", bg: "oklch(0.9 0.05 230 / 0.1)" },
    issued: { st: "ISSUED", c: "oklch(0.86 0.1 258)", bg: "oklch(0.74 0.19 258 / 0.14)" },
    denied: { st: "DENIED", c: "oklch(0.7 0.19 25)", bg: "oklch(0.7 0.19 25 / 0.12)" },
    active: { st: "UNFROZEN", c: "oklch(0.8 0.16 155)", bg: "oklch(0.8 0.16 155 / 0.1)" },
  };
  const SAMPLE = [
    ["researcher", "ModelHub API · inference", "$4.12", "ok"],
    ["scout", "Vectorbase · storage", "$11.00", "ok"],
    ["travel-bot", "SkyFare · airline", "$389.00", "hold"],
    ["ops-copilot", "Computa · GPU hours", "$27.40", "ok"],
    ["pricing-bot", "SpinPalace · gambling", "$18.00", "mcc"],
    ["researcher", "alice.eth · top-up", "+$300.00", "fund"],
    ["scout", "DataLoom · datasets", "$46.00", "ok"],
    ["ledger-bot", "velocity anomaly", "—", "frz"],
    ["ops-copilot", "MailRelay · email API", "$2.80", "ok"],
    ["travel-bot", "GeoTile · maps API", "$6.50", "ok"],
    ["pricing-bot", "LuxeGoods · retail", "$129.00", "mcc"],
  ];
  const EVENT_KIND = { issued: "issued", funded: "fund", escalated: "hold", approved: "fund", denied: "denied", frozen: "frz", unfrozen: "active" };
  const hhmmss = (d) => d.toTimeString().slice(0, 8);

  function rowEl(r) {
    const el = document.createElement("div");
    el.className = "feed-row";
    const k = KINDS[r.kind];
    const t = document.createElement("div"); t.className = "feed-t"; t.textContent = r.t;
    const mid = document.createElement("div"); mid.style.minWidth = "0";
    const ag = document.createElement("div"); ag.className = "feed-agent"; ag.textContent = r.agent;
    const me = document.createElement("div"); me.className = "feed-merch"; me.textContent = r.merch;
    mid.append(ag, me);
    const right = document.createElement("div"); right.className = "feed-right";
    const amt = document.createElement("div"); amt.className = "feed-amt"; amt.textContent = r.amt;
    const pill = document.createElement("div"); pill.className = "status-pill"; pill.textContent = k.st;
    pill.style.color = k.c; pill.style.background = k.bg;
    right.append(amt, pill);
    el.append(t, mid, right);
    return el;
  }

  function initFeed() {
    const box = $("[data-feed]"), dot = $("[data-live-dot]"), label = $("[data-live-label]"), note = $("[data-feed-note]");
    const sample = (e, t) => ({ t, agent: e[0] + "." + ROOT, merch: e[1], amt: e[2], kind: e[3] });
    let n = 0, sampleTimer = null, liveMode = false, dotAnim = null;

    // Seed six sample rows, a few seconds to minutes in the past.
    const now = Date.now(); let o = 0;
    for (let i = 0; i < 6; i++) { o += 6 + ((i * 13) % 19); box.append(rowEl(sample(SAMPLE[i], hhmmss(new Date(now - o * 1000))))); n++; }

    const add = (el, animate) => {
      box.prepend(el);
      while (box.children.length > 6) box.lastElementChild.remove();
      if (animate && !R) el.animate([{ opacity: 0, transform: "translateY(-8px)", background: "oklch(0.74 0.19 258 / 0.08)" }, { opacity: 1, transform: "none", background: "rgba(0,0,0,0)" }], { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" });
    };
    const startSample = () => {
      sampleTimer = setInterval(() => add(rowEl(sample(SAMPLE[n++ % SAMPLE.length], hhmmss(new Date()))), true), 2600);
    };
    startSample();

    // Switch to real events once the Worker has any.
    let seen = new Set();
    const poll = async () => {
      try {
        const r = await fetch(`${API}/public/feed`);
        if (!r.ok) return;
        const { events = [] } = await r.json();
        if (!events.length) return;
        if (!liveMode) {
          liveMode = true; clearInterval(sampleTimer); box.textContent = "";
          dot.classList.remove("sample"); label.textContent = "Live · sandbox stream";
          note.textContent = "Real policy events from the x402card sandbox: issues, top-ups, escalations, approvals and freezes.";
          if (!R) dotAnim = dot.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 1600, iterations: Infinity });
        }
        const fresh = events.filter((e) => !seen.has(e.at + e.name + e.kind)).reverse();
        for (const e of fresh) {
          seen.add(e.at + e.name + e.kind);
          const amt = e.amount != null ? (e.kind === "funded" || e.kind === "approved" ? "+" : "") + "$" + Number(e.amount).toFixed(2) : "—";
          add(rowEl({ t: hhmmss(new Date(e.at)), agent: e.name, merch: e.detail, amt, kind: EVENT_KIND[e.kind] || "ok" }), seen.size > fresh.length);
        }
      } catch { /* offline: sample stream keeps running */ }
    };
    poll();
    setInterval(poll, 10000);
    void dotAnim;
  }

  // ---------- CTAs ----------
  function initCtas() {
    $$("[data-cta]").forEach((b) => b.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: R ? "auto" : "smooth" });
      const q = $("[data-hero-q]");
      heroStop = true;
      setTimeout(() => { q.value = ""; q.dispatchEvent(new Event("input")); q.focus(); }, R ? 0 : 450);
    }));
  }

  initTilt(); initHero(); initBeats(); initFeed(); initCtas();
})();
