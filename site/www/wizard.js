// x402·card approvals walkthrough: six steps of one escalated funding request,
// with the floating card showing the state at each step. Illustrative only;
// it calls no API. Mirrors service.requestFunding / decide in src/service.ts.
(() => {
  "use strict";

  const root = document.querySelector("[data-wizard]");
  if (!root) return;
  const $ = (s) => root.querySelector(s);
  const w = (n) => root.querySelector(`[data-w="${n}"]`);
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  let R = mq.matches;
  mq.addEventListener?.("change", (e) => { R = e.matches; });

  const AMBER = "var(--warning)", GREEN = "var(--success)", BLUE = "var(--accent-light)";

  // Card state per step: status pill, request chip, seal, allowance, ENS line.
  const STEPS = [
    {
      title: "The agent asks",
      body: "researcher.x402card.eth needs $300 for a dataset license, more than it may top up on its own. It calls request_funding over MCP with a token that only works for its own name.",
      code: 'request_funding({ amount: 300, currency: "USD",\n  purpose: "dataset license" })',
      status: ["REQUESTED", BLUE], req: "request_funding · dataset license", reqTone: "", monthly: 500,
    },
    {
      title: "The policy says: a human decides",
      body: "The policy engine is plain code, not an LLM. A request above card.limit.tx or the $250 global ceiling, or one that would take the wallet below its reserve, goes to the person in card.approver. The agent gets back pending_human and a link to this page.",
      code: "300 > card.limit.tx (50)\n→ pending_human · approver: alice.eth",
      status: ["PAUSED", AMBER], req: "300 > card.limit.tx (50)", reqTone: "amber", monthly: 500,
    },
    {
      title: "The request is sealed",
      body: "The approval is signed over its exact name, amount and currency. If anyone edits it before the decision (say, $300 to $3,000), approving fails. If nobody decides within 24 hours, it expires.",
      code: "sig = HMAC(secret, id · researcher · 300 · USD)\nexpires = now + 24h",
      status: ["PAUSED", AMBER], req: "300 > card.limit.tx (50)", reqTone: "amber", seal: true, monthly: 500,
    },
    {
      title: "A human approves or denies",
      body: "The approver opens the link and decides. In this sandbox that's the operator's admin token; next, it's a signature from the wallet or Safe named in card.approver, so no shared secret can approve on its own.",
      code: 'POST /api/approvals/:id\n{ approve: true, by: "alice.eth" }',
      status: ["WAITING · alice.eth", AMBER], req: "300 > card.limit.tx (50)", reqTone: "amber", seal: true, monthly: 500, approve: true,
    },
    {
      title: "Applied exactly once",
      body: "The approval is marked decided before it's applied, so a double click can't apply it twice. The card program's monthly limit and the ENS record change together.",
      code: "card program  MONTHLY        500 → 800\nENS          card.limit.monthly 500 → 800",
      status: ["APPROVED", GREEN], req: "approved by alice.eth", reqTone: "green", seal: true, monthly: 800,
    },
    {
      title: "Anyone can check",
      body: "Wallets, merchants and other agents read the new limit straight from ENS with any client. The gateway signs each answer and the resolver contract verifies the signature on-chain.",
      code: 'getEnsText("researcher.x402card.eth",\n  "card.limit.monthly")  → "800"  ✓ signed',
      status: ["ACTIVE", GREEN], monthly: 800, ens: true,
    },
  ];

  const list = $("[data-wiz-list]"), back = $("[data-wiz-back]"), next = $("[data-wiz-next]"), count = $("[data-wiz-count]");
  let i = 0, shownMonthly = 500, countSeq = 0;

  // ---------- step list ----------
  STEPS.forEach((s, n) => {
    const li = document.createElement("li");
    li.className = "wiz-step";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "wiz-head";
    head.innerHTML = `<span class="wiz-n">${String(n + 1).padStart(2, "0")}</span><span class="wiz-title"></span>`;
    head.querySelector(".wiz-title").textContent = s.title;
    head.addEventListener("click", () => go(n));
    const body = document.createElement("div");
    body.className = "wiz-body";
    const p = document.createElement("p");
    p.textContent = s.body;
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = s.code;
    body.append(p, pre);
    li.append(head, body);
    list.append(li);
  });

  // ---------- card ----------
  const fade = (el, on) => {
    el.classList.toggle("on", !!on);
  };

  function money(n) { return "$" + n.toLocaleString("en-US"); }

  function setMonthly(to) {
    const scale = 1000, from = shownMonthly;
    countSeq++; // stop any count-up still running from the previous step
    w("rec").textContent = `card.limit.monthly = ${to}`;
    // While the request waits (steps 2-4), a faint bar previews the allowance if approved.
    w("next").style.transform = `scaleX(${i >= 1 && i <= 3 ? 800 / scale : 0})`;
    if (from === to) { w("fill").style.transform = `scaleX(${to / scale})`; w("allow").textContent = money(to); return; }
    shownMonthly = to;
    if (R) { w("fill").style.transform = `scaleX(${to / scale})`; w("allow").textContent = money(to); return; }
    w("fill").animate([{ transform: `scaleX(${from / scale})` }, { transform: `scaleX(${to / scale})` }], { duration: 1100, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    w("rec").animate([{ color: "oklch(0.86 0.1 258)" }, { color: "oklch(0.86 0.1 258)", offset: 0.7 }, { color: "#5d626c" }], { duration: 2000 });
    const t0 = performance.now(), el = w("allow"), seq = ++countSeq;
    const f = (t) => {
      if (seq !== countSeq) return; // a newer step took over
      const p = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - p, 3);
      el.textContent = money(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }

  function render(prev) {
    const s = STEPS[i];
    [...list.children].forEach((li, n) => {
      li.classList.toggle("active", n === i);
      li.classList.toggle("done", n < i);
      li.querySelector(".wiz-head").setAttribute("aria-current", n === i ? "step" : "false");
    });
    count.textContent = `${i + 1} / ${STEPS.length}`;
    back.disabled = i === 0;
    next.textContent = i === STEPS.length - 1 ? "Start over" : s.approve ? "Approve $300" : "Next";
    next.classList.toggle("pulse", !!s.approve && !R);

    const st = w("status");
    st.textContent = s.status[0];
    st.style.color = s.status[1];
    st.style.borderColor = `color-mix(in oklch, ${s.status[1]} 45%, transparent)`;

    fade(w("req"), s.req);
    if (s.req) w("reqtxt").textContent = s.req;
    w("req").dataset.tone = s.reqTone || "";
    fade(w("seal"), s.seal);
    w("card").dataset.tone = s.status[1] === AMBER ? "amber" : s.status[1] === GREEN && i >= 4 ? "green" : "";
    w("ens").textContent = s.ens ? "✓ read over ENS, signature verified" : "";
    setMonthly(s.monthly);

    if (!R && prev !== undefined && prev !== i) {
      w("glow").animate([{ opacity: 0 }, { opacity: 0.8, offset: 0.3 }, { opacity: 0 }], { duration: 900, easing: "ease-out" });
    }
  }

  function go(n) {
    const prev = i;
    i = Math.max(0, Math.min(STEPS.length - 1, n));
    render(prev);
  }

  back.addEventListener("click", () => go(i - 1));
  next.addEventListener("click", () => {
    if (i === STEPS.length - 1) { shownMonthly = 500; w("fill").getAnimations().forEach((a) => a.cancel()); go(0); }
    else go(i + 1);
  });
  root.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); next.click(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
  });

  // ---------- float + tilt (same feel as the hero card) ----------
  const tilt = root.querySelector("[data-wiz-tilt]"), sheen = root.querySelector("[data-wiz-sheen]");
  if (tilt && !R) {
    let tx = 0, ty = 0, x = 0, y = 0, visible = true;
    const cl = (v) => Math.max(-1, Math.min(1, v));
    window.addEventListener("pointermove", (e) => {
      const r = tilt.getBoundingClientRect();
      tx = cl((e.clientX - (r.left + r.width / 2)) / r.width);
      ty = cl((e.clientY - (r.top + r.height / 2)) / r.height);
    }, { passive: true });
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) requestAnimationFrame(loop); }).observe(tilt);
    const loop = (t) => {
      if (R) { tilt.style.transform = "none"; return; }
      if (!visible) return;
      x += (tx - x) * 0.07; y += (ty - y) * 0.07;
      const bob = Math.sin(t / 1500) * 6;
      tilt.style.transform = `translate3d(0,${bob.toFixed(2)}px,0) rotateX(${(-y * 8).toFixed(2)}deg) rotateY(${(x * 12).toFixed(2)}deg)`;
      if (sheen) sheen.style.transform = `translate3d(${(x * 22).toFixed(2)}%,0,0)`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ?step=4 opens a given step (shareable links to one part of the flow).
  const start = Number(new URLSearchParams(location.search).get("step"));
  if (start >= 1 && start <= STEPS.length) { i = start - 1; shownMonthly = STEPS[i].monthly; }
  render();
})();
