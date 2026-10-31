// X Card console (console.html) and the one-request approval page (approve.html).
//
// Console: sign in by email (a demo account: your cards, issuing, your
// approvals) or with the operator's admin token (every card). The email
// session is shared with auth.js (localStorage); the admin token stays in this
// tab only (sessionStorage).
//
// Approval page (#<id>): an email approver confirms signed in with a code;
// a wallet or ENS approver signs EIP-712 typed data with their wallet.
// ?api=http://127.0.0.1:8787 points the page at a local Worker.
(() => {
  "use strict";

  const Auth = window.XCardAuth;
  const API = Auth.API;
  const TOKEN_KEY = "x402card.admin";
  const qs = new URLSearchParams(location.search);
  // Opened by the chat's approval card: decide this one request, then close.
  const POPUP = qs.get("popup");
  // Approvals carry the card key: a bare label for x402card.eth, the full name for xcard.eth.
  const fullName = (key) => (key.includes(".") ? key : key + ".x402card.eth");
  const POLL_MS = 5000;
  const $ = (s, el = document) => el.querySelector(s);
  const R = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CONSOLE = !!$("[data-app]");
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // The approval page without a request is just the console.
  if (!CONSOLE && !UUID.test(location.hash.slice(1))) { location.replace("console.html" + location.search); return; }

  let admin = readAdmin();
  let me = null; // { email } or { admin: true }, from /api/me
  let caps = null;
  let busy = false;
  let focusId = location.hash.slice(1);
  let timer;
  let lastSig = "";

  function readAdmin() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
  function saveAdmin(t) { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } }
  const bearer = () => admin || Auth.session()?.token || "";

  // ---------- helpers ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }
  const money = (n, cur = "USD") => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    const sym = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" }[cur];
    return (sym ?? "") + v.toLocaleString("en-US", { maximumFractionDigits: 2 }) + (sym ? "" : " " + cur);
  };
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const STATUS = {
    pending: ["PENDING_HUMAN", "var(--warning)", "oklch(0.84 0.14 80 / 0.1)"],
    approved: ["APPROVED", "var(--success)", "oklch(0.8 0.16 155 / 0.1)"],
    denied: ["DENIED", "var(--error)", "oklch(0.7 0.19 25 / 0.12)"],
    expired: ["EXPIRED", "var(--muted)", "rgba(255,255,255,0.06)"],
    active: ["ACTIVE", "var(--success)", "oklch(0.8 0.16 155 / 0.1)"],
    frozen: ["FROZEN", "var(--ice)", "oklch(0.9 0.05 230 / 0.1)"],
  };
  const pill = (k) => { const [t, c, bg] = STATUS[k] || [k.toUpperCase(), "var(--muted)", "rgba(255,255,255,0.06)"]; return el("span", { class: "status-pill", style: `color:${c};background:${bg}`, text: t }); };
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  // card.approver as people read it: the name or email, or a bare address shortened.
  const who = (s) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? short(s) : s);
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s || "");

  async function api(path, opts = {}) {
    const r = await fetch(API + path, {
      ...opts,
      headers: { Authorization: "Bearer " + bearer(), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 && CONSOLE) { signOut(admin ? "That token was rejected." : "Your session ended. Sign in again."); throw new Error("unauthorized"); }
    if (!r.ok) throw new Error(body?.error?.message || body?.error || `HTTP ${r.status}`);
    return body;
  }

  // ---------- sign in (console) ----------
  function showSignin(msg = "") {
    $("main").classList.remove("signed-in");
    $("[data-signin]").hidden = false;
    $("[data-meta]").hidden = true;
    document.querySelectorAll("[data-app]").forEach((n) => (n.hidden = true));
    $("[data-signin-err]").textContent = msg;
  }
  function signOut(msg) {
    clearTimeout(timer);
    if (admin) { admin = ""; saveAdmin(""); } else Auth.signOut();
    me = null;
    showSignin(msg);
  }

  async function start() {
    try {
      const r = await api("/api/me");
      me = r; caps = r.caps;
    } catch (err) {
      if (err.message !== "unauthorized") $("[data-signin-err]").textContent = "Couldn't reach the API: " + err.message;
      return;
    }
    $("main").classList.add("signed-in");
    $("[data-signin]").hidden = true;
    $("[data-meta]").hidden = false;
    $("[data-who]").textContent = me.admin ? "operator" : me.email;
    document.querySelectorAll("[data-app]").forEach((n) => (n.hidden = false));
    $("[data-org]").hidden = !me.org;
    if (me.org) $("[data-pending-title]").textContent = "Waiting on approval";
    (configureIssue ??= initIssue())();
    load();
  }

  function initSignin() {
    $("[data-email-signin]").addEventListener("click", async () => {
      const s = await Auth.open({ title: "Sign in to the console", sub: "Enter your email. We'll send a 6-digit code: no password, no wallet." });
      if (s) { admin = ""; saveAdmin(""); start(); }
    });
    $("[data-signin-form]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = $("[data-token]").value.trim();
      if (!t) return;
      admin = t;
      try {
        await api("/api/approvals");
        saveAdmin(t);
        $("[data-token]").value = "";
        start();
      } catch (err) {
        if (err.message !== "unauthorized") $("[data-signin-err]").textContent = "Couldn't reach the API: " + err.message;
      }
    });
    $("[data-signout]").addEventListener("click", () => signOut(""));
    $("[data-refresh]").addEventListener("click", () => { lastSig = ""; load(); });
  }

  // ---------- pending requests ----------
  const canDecide = (a) => me?.admin || a.can_decide;

  // Decide controls for one request; null buttons when this account only watches it.
  function controls(a, labels) {
    if (!canDecide(a)) {
      return { approveBtn: null, denyBtn: null, by: () => "", row: el("p", { class: "one-note", text: `Waiting for ${who(a.approver)}. Only the card's approver can decide it.` }) };
    }
    const approveBtn = el("button", { class: "approve-btn", text: labels.approve });
    const denyBtn = el("button", { class: "btn-deny", text: "Deny" });
    const as = me.admin ? el("input", { value: a.approver || "admin", "aria-label": "Decide as", spellcheck: "false" }) : null;
    const row = el("div", { class: "req-actions" }, approveBtn, denyBtn, as ? el("label", { class: "as" }, "as ", as) : el("span", { class: "as", text: "as " + me.email }));
    return { approveBtn, denyBtn, row, by: () => (as ? as.value.trim() || "admin" : me.email) };
  }

  function wire(a, c, whyRow, onApproved) {
    if (!c.approveBtn) return;
    const decide = async (approve) => {
      busy = true; c.approveBtn.disabled = c.denyBtn.disabled = true;
      const by = c.by();
      try {
        const res = await api(`/api/approvals/${a.id}`, { method: "POST", body: JSON.stringify(me.admin ? { approve, by } : { approve }) });
        if (!approve) {
          c.denyBtn.textContent = "Denied"; c.approveBtn.style.opacity = "0.3";
          whyRow.className = "req-why no"; whyRow.lastChild.textContent = `DENIED · by ${by}`;
        } else await onApproved(res, by);
        setTimeout(() => { busy = false; lastSig = ""; load(); }, 1800);
      } catch (err) {
        busy = false; c.approveBtn.disabled = c.denyBtn.disabled = false;
        whyRow.className = "req-why no"; whyRow.lastChild.textContent = err.message;
      }
    };
    c.approveBtn.addEventListener("click", () => decide(true));
    c.denyBtn.addEventListener("click", () => decide(false));
  }

  function renderPending(approvals, cards) {
    const box = $("[data-pending]");
    const pending = approvals.filter((a) => a.status === "pending" && a.expiresAt > Date.now());
    $("[data-pending-count]").textContent = pending.length ? `${pending.length} pending` : "";
    box.textContent = "";
    if (!pending.length) {
      box.append(el("div", { class: "empty", style: "grid-column:1/-1", text: "Nothing waiting. When an agent asks for more than its card allows, the request lands here and in the approver's inbox." }));
      return;
    }
    for (const a of pending) {
      const card = cards.find((c) => c.name === fullName(a.name));
      box.append(a.kind === "payment" ? paymentCard(a, card) : a.kind === "policy" ? policyCard(a) : requestCard(a, card));
    }
    if (focusId) {
      const f = box.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      if (f) { f.classList.add("focus"); f.scrollIntoView({ block: "center", behavior: R ? "auto" : "smooth" }); }
      focusId = "";
    }
  }

  function requestCard(a, card) {
    const rec = card?.records || {};
    const cur = a.currency;
    const now = Number(rec["card.limit.monthly"]) || 0;
    const next = now + a.amount;
    const scale = Math.max(next * 1.25, 1);
    const [why, purpose] = splitReason(a.reason);

    const fill = el("div", { class: "fill", style: `transform:scaleX(${now / scale})` });
    const fillNext = el("div", { class: "fill-next", style: `transform:scaleX(${next / scale})` });
    const allowVal = el("span", { class: "mono", text: money(now, cur) });
    const recLine = el("span", { text: `card.limit.monthly = ${now}` });
    const whyRow = el("div", { class: "req-why" }, el("span", { class: "dot" }), el("span", { text: "PAUSED · " + why }));
    const c = controls(a, { approve: `Approve ${money(a.amount, cur)}` });
    wire(a, c, whyRow, async (res, by) => {
      c.approveBtn.textContent = "Approved ✓"; c.approveBtn.style.background = "var(--success)";
      whyRow.className = "req-why ok"; whyRow.lastChild.textContent = `RELEASED · approved by ${by}`;
      const after = Number(res.card?.records?.["card.limit.monthly"]) || next;
      recLine.textContent = `card.limit.monthly = ${after}`;
      if (!R) {
        fill.animate([{ transform: `scaleX(${now / scale})` }, { transform: `scaleX(${after / scale})` }], { duration: 1100, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
        recLine.animate([{ color: "oklch(0.86 0.1 258)" }, { color: "oklch(0.86 0.1 258)", offset: 0.7 }, { color: "#5d626c" }], { duration: 2000 });
        await countUp(allowVal, now, after, cur, 1100);
      } else { allowVal.textContent = money(after, cur); }
    });

    return el("article", { class: "req-card", "data-id": a.id },
      el("div", { class: "req-top" },
        el("div", { style: "min-width:0" },
          el("div", { class: "req-name", text: fullName(a.name) }),
          el("div", { class: "req-purpose", text: "requests funds" + (purpose ? " · " + purpose : "") })),
        el("div", { class: "req-amt" }, "+" + money(a.amount, cur), el("small", { text: cur }))),
      whyRow,
      el("div", { class: "allow" },
        el("div", { class: "allow-top" }, el("span", { text: "Monthly allowance" }), allowVal),
        el("div", { class: "track" }, fillNext, fill),
        el("div", { class: "allow-foot" }, recLine, el("span", { text: `→ ${next} if approved` }))),
      el("div", { class: "kv" },
        el("span", { text: "approver" }), el("span", { text: who(a.approver) }),
        el("span", { text: "card.limit.tx" }), el("span", { text: rec["card.limit.tx"] ?? "—" }),
        el("span", { text: "requested" }), el("span", { text: ago(a.createdAt) }),
        el("span", { text: "binding" }), el("span", { text: `${a.name} · ${a.amount} · ${cur}` })),
      c.row);
  }

  // A payment the payee gate held: approving charges the card for exactly this merchant.
  function paymentCard(a, card) {
    const rec = card?.records || {};
    const p = a.payment || {};
    const cur = a.currency;
    const [why] = splitReason(a.reason);
    const whyRow = el("div", { class: "req-why" }, el("span", { class: "dot" }), el("span", { text: "HELD · " + why }));
    const c = controls(a, { approve: `Approve & pay ${money(a.amount, cur)}` });
    wire(a, c, whyRow, async (res, by) => {
      if (res.approval?.charge?.approved === false) {
        c.approveBtn.textContent = "Declined by issuer";
        whyRow.className = "req-why no"; whyRow.lastChild.textContent = `ISSUER DECLINED · ${res.approval.charge.decline_reason || "DECLINED"}`;
      } else {
        c.approveBtn.textContent = "Paid ✓"; c.approveBtn.style.background = "var(--success)";
        whyRow.className = "req-why ok"; whyRow.lastChild.textContent = `PAID · approved by ${by}`;
      }
    });
    return el("article", { class: "req-card", "data-id": a.id },
      el("div", { class: "req-top" },
        el("div", { style: "min-width:0" },
          el("div", { class: "req-name", text: fullName(a.name) }),
          el("div", { class: "req-purpose", text: `wants to pay ${p.merchant || "a merchant"}` + (p.purpose ? " · " + p.purpose : "") })),
        el("div", { class: "req-amt" }, money(a.amount, cur), el("small", { text: cur }))),
      whyRow,
      el("div", { class: "kv" },
        el("span", { text: "approver" }), el("span", { text: who(a.approver) }),
        el("span", { text: "checkout" }), el("span", { text: p.merchantUrl || "not given" }),
        el("span", { text: "payee name" }), el("span", { text: p.payeeName ? `${p.payeeName} · ${p.payeeStatus}` : "not given" }),
        el("span", { text: "MCC" }), el("span", { text: p.mcc || "—" }),
        el("span", { text: "card.payee" }), el("span", { text: rec["card.payee"] || "any" }),
        el("span", { text: "requested" }), el("span", { text: ago(a.createdAt) })),
      c.row);
  }

  // A policy change: each record from → to. Approving applies them all.
  const showVal = (k, v) => (v ? v : k === "card.limit.daily" ? "none" : "any");
  const changeRows = (a) => (a.policy?.changes || []).flatMap((c) => [
    el("span", { text: c.key }), el("span", { text: `${showVal(c.key, c.from)} → ${showVal(c.key, c.to)}${c.loosens ? "" : " (tighter)"}` })]);

  function policyCard(a) {
    const [why, purpose] = splitReason(a.reason);
    const whyRow = el("div", { class: "req-why" }, el("span", { class: "dot" }), el("span", { text: "PAUSED · " + why }));
    const c = controls(a, { approve: "Approve changes" });
    wire(a, c, whyRow, async (_res, by) => {
      c.approveBtn.textContent = "Applied ✓"; c.approveBtn.style.background = "var(--success)";
      whyRow.className = "req-why ok"; whyRow.lastChild.textContent = `APPLIED · approved by ${by}`;
    });
    return el("article", { class: "req-card", "data-id": a.id },
      el("div", { class: "req-top" },
        el("div", { style: "min-width:0" },
          el("div", { class: "req-name", text: fullName(a.name) }),
          el("div", { class: "req-purpose", text: "wants a policy change" + (purpose ? " · " + purpose : "") })),
        el("div", { class: "req-amt" }, "Policy")),
      whyRow,
      el("div", { class: "kv" }, el("span", { text: "approver" }), el("span", { text: who(a.approver) }), ...changeRows(a), el("span", { text: "requested" }), el("span", { text: ago(a.createdAt) })),
      c.row);
  }

  // Reasons look like "300 > card.limit.tx (50) · dataset license".
  function splitReason(r = "") {
    const i = r.indexOf(" · ");
    return i === -1 ? [r, ""] : [r.slice(0, i), r.slice(i + 3)];
  }

  async function countUp(node, from, to, cur, d) {
    const t0 = performance.now();
    await new Promise((res) => {
      const f = (t) => {
        const p = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - p, 3);
        node.textContent = money(Math.round(from + (to - from) * e), cur);
        p < 1 ? requestAnimationFrame(f) : res();
      };
      requestAnimationFrame(f);
    });
  }

  // ---------- the company panel, for an org's operators ----------
  function renderOrg(cards, approvals) {
    if (!me?.org) return;
    const mine = cards.filter((c) => c.org === me.org.slug);
    const names = new Set(mine.map((c) => c.name));
    const allowance = mine.reduce((sum, c) => sum + (Number(c.records?.["card.limit.monthly"]) || 0), 0);
    $("[data-org-name]").textContent = me.org.name;
    $("[data-org-cards]").textContent = `${mine.length} of ${caps.cards}`;
    $("[data-org-allow]").textContent = money(allowance);
    $("[data-org-pending]").textContent = String(approvals.filter((a) => a.status === "pending" && a.expiresAt > Date.now() && names.has(fullName(a.name))).length);
    $("[data-org-frozen]").textContent = String(mine.filter((c) => c.status === "frozen").length);
    $("[data-org-caps]").textContent = `Per card: up to ${money(caps.tx)} per transaction, ${money(caps.daily)} a day, ${money(caps.monthly)} a month.`;
    $("[data-org-ops]").textContent = `Operators: ${me.org.operators.join(", ")}`;
  }

  // ---------- cards: the same card face as the home page ----------
  let highlight = "";
  function renderFleet(cards) {
    const box = $("[data-fleet]");
    $("[data-fleet-count]").textContent = cards.length ? `${cards.length} card${cards.length === 1 ? "" : "s"}` : "";
    box.textContent = "";
    if (!cards.length) {
      box.append(el("div", { class: "empty", text: me?.admin ? "No cards yet. Issue one above, or with the issue_card MCP tool." : "No cards yet. Issue your first one above: pick a name, set its limits, name who approves." }));
      return;
    }
    // An operator sees the company's cards first, then any of their own.
    const groups = me?.org
      ? [[me.org.name, cards.filter((c) => c.org === me.org.slug)], ["Your own cards", cards.filter((c) => c.org !== me.org.slug)]]
      : [["", cards]];
    for (const [title, group] of groups) {
      if (!group.length) continue;
      if (title) box.append(el("h3", { class: "fleet-group", text: title }));
      const grid = el("div", { class: "fleet-grid" });
      for (const c of group) grid.append(fleetItem(c));
      box.append(grid);
    }
    if (highlight) {
      const f = box.querySelector(`[data-card="${CSS.escape(highlight)}"]`);
      if (f) { f.classList.add("fresh"); f.scrollIntoView({ block: "nearest", behavior: R ? "auto" : "smooth" }); }
      highlight = "";
    }
  }

  function fleetItem(c) {
    const r = c.records || {};
    const cur = (r["card.currencies"] || "USD").split(",")[0];
    const frozen = c.status === "frozen";
    const tags = [
      `tx ≤ ${money(r["card.limit.tx"], cur)}`,
      r["card.limit.daily"] ? `day ≤ ${money(r["card.limit.daily"], cur)}` : null,
      `mo ≤ ${money(r["card.limit.monthly"], cur)}`,
    ].filter(Boolean);
    const pending = c.pending_approvals?.length || 0;
    const face = el("div", { class: "card fleet-card" + (frozen ? " is-frozen" : "") },
      el("div", { class: "card-top" },
        el("div", { class: "wordmark" }, el("img", { class: "mark", src: "brand/xcard-mark.svg", alt: "", "aria-hidden": "true", width: "48", height: "48" }), "X Card"),
        el("div", { class: "card-kind", text: "VIRTUAL · " + cur })),
      el("div", { class: "fleet-mid" }, el("div", { class: "chip" }), el("div", { class: "fleet-tags" }, ...tags.map((t) => el("span", { class: "tag-sm", text: t })))),
      el("div", { class: "card-bottom" },
        el("div", { class: "card-num", text: "•••• •••• •••• " + (c.last4 || "····") }),
        el("div", { class: "card-name", text: c.name })),
      frozen ? el("div", { class: "frost", style: "opacity:1" }) : null,
      frozen ? el("div", { class: "stamp", style: "opacity:1" }, el("div", { text: "FROZEN" })) : null);

    const action = frozen
      ? el("button", { class: "btn-xs", text: "Unfreeze", onclick: async (e) => {
          e.target.disabled = true;
          try { await api(`/api/cards/${encodeURIComponent(c.name)}/unfreeze`, { method: "POST" }); lastSig = ""; load(); }
          catch (err) { e.target.disabled = false; e.target.textContent = err.message; }
        } })
      : null;
    return el("article", { class: "fleet-item", "data-card": c.name },
      face,
      el("div", { class: "fleet-meta" },
        el("div", { class: "fleet-row" }, pill(c.status), pending ? el("span", { class: "status-pill", style: "color:var(--warning);background:oklch(0.84 0.14 80 / 0.1)", text: `${pending} PENDING` }) : null, el("span", { style: "flex:1" }), action),
        el("div", { class: "kv" },
          el("span", { text: "approver" }), el("span", { text: who(r["card.approver"] || "—") }),
          el("span", { text: "merchants" }), el("span", { text: r["card.mcc.allow"] ? "MCC " + r["card.mcc.allow"] : "any category" }),
          el("span", { text: "payee" }), el("span", { text: payeeCell(r) }))));
  }

  // "verified-only · modelhub.eth +1"; cards issued before the payee gate read as any.
  function payeeCell(r) {
    const mode = r["card.payee"] || "any";
    const allow = (r["card.payee.allow"] || "").split(",").filter(Boolean);
    return allow.length ? `${mode} · ${allow[0]}${allow.length > 1 ? ` +${allow.length - 1}` : ""}` : mode;
  }

  function renderHistory(approvals) {
    const box = $("[data-history]");
    const done = approvals.filter((a) => a.status !== "pending" || a.expiresAt <= Date.now()).slice(0, 20);
    $("[data-history-count]").textContent = done.length ? `last ${done.length}` : "";
    box.textContent = "";
    if (!done.length) { box.append(el("div", { class: "empty", text: "Decisions appear here." })); return; }
    const panel = el("div", { class: "feed-panel" });
    for (const a of done) {
      const status = a.status === "pending" ? "expired" : a.status;
      panel.append(el("div", { class: "feed-row" },
        el("div", { class: "feed-t", text: new Date(a.createdAt).toTimeString().slice(0, 8) }),
        el("div", { style: "min-width:0" },
          el("div", { class: "feed-agent", text: fullName(a.name) }),
          el("div", { class: "feed-merch", text: a.reason })),
        el("div", { class: "feed-right" }, el("div", { class: "feed-amt", text: a.kind === "policy" ? "policy" : (a.kind === "payment" ? "" : "+") + money(a.amount, a.currency) }), pill(status))));
    }
    box.append(panel);
  }

  // ---------- load loop ----------
  async function load() {
    if (busy || !me) return;
    clearTimeout(timer);
    try {
      const [{ approvals }, { cards }] = await Promise.all([api("/api/approvals"), api("/api/cards")]);
      if (busy) return;
      // Skip re-rendering when nothing changed (keeps inputs and focus intact).
      const sig = JSON.stringify([approvals, cards]);
      if (sig !== lastSig || focusId) {
        lastSig = sig;
        renderOrg(cards, approvals);
        renderPending(approvals, cards);
        renderFleet(cards);
        renderHistory(approvals);
        firstCard(cards);
      }
      $("[data-updated]").textContent = "updated " + new Date().toTimeString().slice(0, 8);
    } catch (err) {
      if (err.message === "unauthorized") return;
      $("[data-updated]").textContent = "offline · retrying";
    }
    timer = setTimeout(load, POLL_MS);
  }

  // A new account with no cards: the issue form leads, titled for it.
  function firstCard(cards) {
    const none = cards.length === 0;
    const blk = $("[data-issue-block]");
    const mine = cards.filter((c) => (me.org ? c.org === me.org.slug : c.issued_by_me)).length;
    const allowed = me.org ? caps?.cards : caps?.perAccount;
    $("[data-issue-left]").textContent = me.admin || !caps ? "" : `${Math.max(0, allowed - mine)} of ${allowed} left`;
    const first = (me.org ? !mine : none) && !me.admin;
    blk.classList.toggle("first", first);
    $("[data-issue-title]").textContent = me.org ? `Issue a card for ${me.org.name}` : first ? "Issue your first card" : "Issue a card";
  }

  // ---------- issue a card ----------
  const NS_KEY = "xcard.ns";
  const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  // Same as the Worker (ens/gateway.ts): demo is only reserved under x402card.eth, its hosted site.
  const RESERVED = new Set(["ai", "www", "app", "api", "gateway", "shop"]);
  const isReserved = (v, ns) => RESERVED.has(v) || (v === "demo" && ns === "x402card.eth");
  const MCP_URL = API.replace("://api.", "://mcp.") + "/mcp";
  // Same shape the Worker checks for card.payee.allow (policy/records.ts).
  const PAYEE_NAME_RE = /^[^\s.,]+(\.[^\s.,]+)*\.eth$/;
  const APPROVER_RE = /^(0x[0-9a-fA-F]{40}|[^\s.,@]+(\.[^\s.,@]+)*\.[a-z]{2,})$/i;
  let configureIssue;

  // Radio-group behaviour shared by the switches on the form.
  function radioGroup(sel, attr, onPick) {
    const radios = [...document.querySelectorAll(sel)];
    const set = (v, focus) => {
      for (const r of radios) {
        const on = r.dataset[attr] === v;
        r.setAttribute("aria-checked", String(on));
        r.tabIndex = on ? 0 : -1;
        if (on && focus) r.focus();
      }
      onPick(v);
    };
    radios.forEach((r, i) => {
      r.addEventListener("click", () => set(r.dataset[attr]));
      r.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        set(radios[(i + d + radios.length) % radios.length].dataset[attr], true);
      });
    });
    return { set, radios };
  }

  // Binds the form once; returns what re-applies on every sign-in (who's signed in decides the options).
  // The left side is a live preview: the card face, how the limits nest, and a summary,
  // all redrawn on every keystroke. Edit → issuing (the API call) → issued (token shown once).
  function initIssue() {
    const form = $("[data-issue-form]"), labelIn = $("[data-issue-label]"), err = $("[data-issue-err]");
    const go = $("[data-issue-submit]"), tokenBox = $("[data-issued]"), again = $("[data-ix-again]");
    const approverIn = $('[data-issue="approver"]'), payeesIn = $('[data-issue="payee_allow"]');
    const curIn = $('[data-issue="currencies"]'), mccIn = $('[data-issue="mcc_allow"]');
    const hint = $("[data-ix-namehint]"), segInd = $("[data-ix-segind]");
    const card = { name: $("[data-ix-name]"), num: $("[data-ix-num]"), tags: $("[data-ix-tags]"), status: $("[data-ix-status]"),
      apline: $("[data-ix-apline]"), mo: $("[data-ix-mo]"), glow: $("[data-ix-glow]"), flash: $("[data-ix-flash]") };
    const isAccount = () => !me.admin;
    const KEYS = ["limit_tx", "limit_daily", "limit_monthly"];
    const num = (k) => $(`[data-ix="${k}"]`), range = (k) => $(`[data-ix-range="${k}"]`);
    const usd = (v) => "$" + Number(v).toLocaleString("en-US");
    const PAYEE_LABEL = { "verified-or-escalate": "verified or ask", "verified-only": "verified only", any: "any" };

    let ns = "xcard.eth", apMode = "email", payee = "verified-or-escalate";
    let phase = "edit"; // edit | issuing | issued
    let taken = null;   // null = not checked yet, true / false from /api/names
    let issued = null;  // { name, last4, token }

    const nsGroup = radioGroup("[data-ns-switch] [data-ns]", "ns", (v) => {
      ns = v;
      segInd.classList.toggle("r", v === "x402card.eth");
      if (!isAccount()) { try { localStorage.setItem(NS_KEY, v); } catch { /* private mode */ } }
      edited(); checkName();
    });
    const AP_PH = { email: "manager@company.com", wallet: "alice.eth or 0x…" };
    const apGroup = radioGroup("[data-approver-switch] [data-ap]", "ap", (v) => {
      const prev = apMode; apMode = v;
      approverIn.placeholder = AP_PH[v];
      approverIn.type = v === "email" ? "email" : "text";
      // Switching modes clears a value that belongs to the other one; email starts as you.
      if (prev !== v) approverIn.value = v === "email" && isAccount() ? me.email : "";
      edited();
    });
    const payGroup = radioGroup("[data-payee-switch] [data-payee]", "payee", (v) => { payee = v; edited(); });

    // Pasting a full name picks its namespace.
    const label = () => {
      let v = labelIn.value.trim().toLowerCase();
      for (const p of ["xcard.eth", "x402card.eth"]) {
        if (!v.endsWith("." + p)) continue;
        v = v.slice(0, -(p.length + 1));
        labelIn.value = v;
        if (!isAccount() && ns !== p) nsGroup.set(p);
      }
      return v;
    };
    const vals = () => Object.fromEntries(KEYS.map((k) => [k, num(k).value.trim()]));
    const nameOk = (v) => LABEL_RE.test(v) && !isReserved(v, ns);
    const approverOk = () => {
      const v = approverIn.value.trim();
      return apMode === "email" ? isEmail(v) : APPROVER_RE.test(v);
    };

    // Taken names show while typing.
    let checkSeq = 0, checkTimer;
    function checkName() {
      const v = label();
      taken = null;
      clearTimeout(checkTimer);
      if (!v || !nameOk(v)) return draw();
      const seq = ++checkSeq;
      checkTimer = setTimeout(async () => {
        try {
          const r = await api(`/api/names/${encodeURIComponent(`${v}.${ns}`)}`);
          if (seq === checkSeq) { taken = !r.available; draw(); }
        } catch { /* the submit reports it */ }
      }, 250);
      draw();
    }

    // Any edit after issuing goes back to editing a new card.
    function edited() {
      if (phase === "issued") { phase = "edit"; issued = null; tokenBox.hidden = true; again.hidden = true; }
      draw();
    }

    function draw() {
      const v = label(), f = vals();
      const full = `${v || "name"}.${ns}`;
      const ok = nameOk(v), numsOk = f.limit_tx !== "" && f.limit_monthly !== "";
      const ready = ok && taken === false && numsOk && approverOk();

      // Name hint.
      hint.className = "ix-hint";
      if (phase === "issued") { hint.textContent = `${issued.name} issued`; hint.classList.add("ok"); }
      else if (!v) hint.textContent = "lowercase letters, digits and hyphens";
      else if (!LABEL_RE.test(v)) { hint.textContent = "only a–z, 0–9 and inner hyphens"; hint.classList.add("no"); }
      else if (isReserved(v, ns)) { hint.textContent = `${full} is reserved`; hint.classList.add("no"); }
      else if (taken) { hint.textContent = `${full} is taken`; hint.classList.add("no"); }
      else if (taken === false) { hint.textContent = `${full} is available`; hint.classList.add("ok"); }
      else hint.textContent = `checking ${full}…`;

      // Card face.
      card.name.textContent = phase === "issued" ? issued.name : full;
      card.name.classList.toggle("empty", !v && phase !== "issued");
      card.num.textContent = "•••• •••• •••• " + (phase === "issued" && issued.last4 ? issued.last4 : "····");
      card.tags.textContent = "";
      const mcc = mccIn.value.trim();
      for (const t of [`tx ≤ ${f.limit_tx === "" ? "—" : usd(f.limit_tx)}`, f.limit_daily === "" ? "no daily cap" : `day ≤ ${usd(f.limit_daily)}`, `mcc: ${mcc || "any"}`]) {
        card.tags.append(el("span", { text: t }));
      }
      card.status.textContent = phase === "issued" ? "ACTIVE" : "DRAFT";
      card.status.classList.toggle("on", phase === "issued");
      card.apline.textContent = `→ ${approverIn.value.trim() || "approver"} · ${PAYEE_LABEL[payee]}`;
      card.mo.textContent = f.limit_monthly === "" ? "—" : usd(f.limit_monthly);
      card.glow.style.opacity = phase === "issued" ? 1 : phase === "issuing" ? 0.6 : ready ? 0.25 : 0;

      // How the limits nest: each as a share of the monthly allowance.
      const mo = Math.max(1, Number(f.limit_monthly) || 0);
      for (const [k, key] of [["monthly", "limit_monthly"], ["daily", "limit_daily"], ["tx", "limit_tx"]]) {
        const raw = f[key];
        $(`[data-ix-mv="${k}"]`).textContent = raw === "" ? (k === "daily" ? "none" : "—") : usd(raw);
        $(`[data-ix-bar="${k}"]`).style.width = `${Math.min(100, ((Number(raw) || 0) / mo) * 100)}%`;
      }
      $('[data-ix-sum="approver"]').textContent = approverIn.value.trim() || "—";
      $('[data-ix-sum="payee"]').textContent = PAYEE_LABEL[payee];
      $('[data-ix-sum="payees"]').textContent = payeesIn.value.trim() || "any verified";

      // The action button.
      go.hidden = phase === "issued";
      go.classList.toggle("busy", phase === "issuing");
      go.disabled = phase !== "edit" || !ready;
      go.textContent = phase === "issuing" ? "Writing to ENS…"
        : ready ? `Issue ${full} →`
        : !ok ? "Add a valid name" : taken ? "Name is taken" : taken === null ? "Checking the name…" : !numsOk ? "Set the limits" : "Add an approver";
    }

    // Sliders and number boxes move together; demo accounts are capped.
    for (const k of KEYS) {
      num(k).addEventListener("input", () => { if (num(k).value !== "") range(k).value = num(k).value; edited(); });
      range(k).addEventListener("input", () => { num(k).value = range(k).value; edited(); });
    }
    labelIn.addEventListener("input", () => { edited(); checkName(); });
    for (const i of [approverIn, payeesIn, curIn, mccIn]) i.addEventListener("input", edited);

    // Tilt and sheen follow the pointer over the preview.
    const zone = $("[data-ix-tiltzone]"), tilt = $("[data-ix-tilt]");
    if (!R) {
      zone.addEventListener("mousemove", (e) => {
        const r = zone.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        tilt.style.transform = `rotateY(${(px - 0.5) * 16}deg) rotateX(${(0.5 - py) * 12}deg)`;
        tilt.style.setProperty("--sx", `${(px - 0.5) * 40}%`);
      });
      zone.addEventListener("mouseleave", () => { tilt.style.transform = ""; tilt.style.setProperty("--sx", "0%"); });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (go.disabled || phase !== "edit") return;
      const v = label(), f = vals();
      const list = (x) => x.split(/[\s,]+/).filter(Boolean);
      const payeeAllow = list(payeesIn.value.toLowerCase());
      const bad = payeeAllow.find((n) => !PAYEE_NAME_RE.test(n));
      if (bad) { err.textContent = `${bad} isn't an ENS name. Allowed payees look like modelhub.eth.`; return; }
      err.textContent = "";
      phase = "issuing"; draw();
      card.flash.classList.remove("go"); void card.flash.offsetWidth; card.flash.classList.add("go");
      const t0 = Date.now();
      try {
        const r = await api("/api/cards", { method: "POST", body: JSON.stringify({ name: `${v}.${ns}`, policy: {
          limit_tx: Number(f.limit_tx), limit_monthly: Number(f.limit_monthly),
          ...(f.limit_daily !== "" ? { limit_daily: Number(f.limit_daily) } : {}),
          currencies: list(curIn.value.toUpperCase()), mcc_allow: list(mccIn.value), approver: approverIn.value.trim(),
          payee, payee_allow: payeeAllow,
        } }) });
        // Let the sweep finish before the card turns active.
        await new Promise((res) => setTimeout(res, Math.max(0, 1100 - (Date.now() - t0))));
        issued = { name: r.card.name, last4: r.card.last4, token: r.agent_token };
        phase = "issued";
        showToken();
        highlight = r.card.name;
        lastSig = ""; load();
      } catch (ex) {
        phase = "edit";
        if (ex.message !== "unauthorized") err.textContent = ex.message;
      } finally {
        card.flash.classList.remove("go");
        draw();
      }
    });

    // The agent token, shown once: masked until revealed (the page is often on a shared screen).
    let revealed = false;
    const masked = (t) => t.slice(0, 4) + "•".repeat(12);
    function showToken() {
      revealed = false;
      $("[data-ix-token]").textContent = masked(issued.token);
      $("[data-ix-reveal]").textContent = "reveal";
      $("[data-ix-copy]").textContent = "copy";
      $("[data-ix-copycmd]").textContent = "copy the claude mcp add line";
      tokenBox.hidden = false; again.hidden = false;
    }
    const copy = async (btn, text, done) => {
      try { await navigator.clipboard.writeText(text); btn.textContent = done; } catch { btn.textContent = "copy failed"; }
    };
    $("[data-ix-reveal]").addEventListener("click", (e) => {
      revealed = !revealed;
      $("[data-ix-token]").textContent = revealed ? issued.token : masked(issued.token);
      e.target.textContent = revealed ? "hide" : "reveal";
    });
    $("[data-ix-copy]").addEventListener("click", (e) => copy(e.target, issued.token, "copied"));
    $("[data-ix-copycmd]").addEventListener("click", (e) =>
      copy(e.target, `claude mcp add --transport http ${issued.name.split(".")[0]} ${MCP_URL} --header "Authorization: Bearer ${issued.token}"`, "copied the claude mcp add line"));
    again.addEventListener("click", () => { labelIn.value = ""; edited(); checkName(); labelIn.focus(); });

    return function configure() {
      const account = isAccount();
      // Demo accounts issue under xcard.eth within the demo caps; the operator picks the namespace.
      $("[data-ns-switch]").hidden = account;
      $("[data-ns-fixed]").hidden = !account;
      const capEl = $("[data-caps]");
      capEl.hidden = !account;
      if (account && caps) capEl.textContent = `${me?.org ? me.org.name : "Demo"} limits: up to ${money(caps.tx)} per transaction, ${money(caps.daily)} a day, ${money(caps.monthly)} a month, USD.`;
      const maxes = account && caps ? { limit_tx: caps.tx, limit_daily: caps.daily, limit_monthly: caps.monthly } : { limit_tx: 1000, limit_daily: 5000, limit_monthly: 20000 };
      const defaults = { limit_tx: 100, limit_daily: 500, limit_monthly: 2000 };
      for (const k of KEYS) {
        range(k).max = String(maxes[k]); num(k).max = String(maxes[k]);
        num(k).value = range(k).value = String(Math.min(defaults[k], maxes[k]));
      }
      curIn.readOnly = account;
      curIn.value = "USD";
      let saved = "xcard.eth";
      if (!account) { try { if (localStorage.getItem(NS_KEY) === "x402card.eth") saved = "x402card.eth"; } catch { /* private mode */ } }
      phase = "edit"; issued = null; tokenBox.hidden = true; again.hidden = true;
      payGroup.set("verified-or-escalate");
      apGroup.set(account ? "email" : "wallet");
      approverIn.value = account ? me.email : "";
      // A first name to start from: the email's name part.
      labelIn.value = "";
      if (account) {
        const guess = me.email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
        if (guess && LABEL_RE.test(guess)) labelIn.value = guess;
      }
      nsGroup.set(saved);
    };
  }

  // ---------- one approval (approve.html, and the console's #<id>) ----------
  // approval_url deep-links here (#<id>). GET /approvals/:id is public by link.
  // An email approver decides signed in with a code to that inbox; a wallet or
  // ENS approver signs EIP-712 typed data (free, nothing goes on-chain).
  const wallets = [];
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider } = e.detail || {};
    if (provider && !wallets.some((w) => w.info.uuid === info.uuid)) wallets.push({ info, provider });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  async function loadOne() {
    const id = location.hash.slice(1);
    const box = $("[data-one]"), body = $("[data-one-body]");
    if (!box) return;
    if (!UUID.test(id)) { box.hidden = true; return; }
    box.hidden = false;
    body.textContent = "";
    body.append(el("div", { class: "empty", text: "Loading the request…" }));
    try {
      const r = await fetch(`${API}/approvals/${id}`);
      const v = await r.json().catch(() => ({}));
      body.textContent = "";
      if (r.status === 404) { body.append(el("div", { class: "empty", text: "This approval link isn't valid. Ask the agent for a new one." })); return; }
      if (!r.ok) throw new Error(v?.error?.message || `HTTP ${r.status}`);
      $("[data-one-how]").textContent = v.email_approver ? "confirmed by email" : "signed with your wallet";
      body.append(oneCard(v));
    } catch (err) {
      body.textContent = "";
      body.append(el("div", { class: "empty", text: "Couldn't load the request: " + err.message }));
    }
  }

  function oneCard(v) {
    const a = v.approval, p = a.payment || {}, cur = a.currency;
    const pay = a.kind === "payment", pol = a.kind === "policy";
    const live = a.status === "pending" && a.expiresAt > Date.now();
    const [why, purpose] = splitReason(a.reason);
    const whyRow = el("div", { class: "req-why" }, el("span", { class: "dot" }),
      el("span", { text: live ? (pay ? "HELD · " : "PAUSED · ") + why : (a.status === "pending" ? "EXPIRED" : a.status.toUpperCase()) }));
    if (!live) whyRow.className = "req-why " + (a.status === "approved" ? "ok" : "no");
    const kv = el("div", { class: "kv" },
      el("span", { text: "approver" }), el("span", { text: who(a.approver) + (v.approver_address && who(a.approver) !== short(v.approver_address) ? ` · ${short(v.approver_address)}` : "") }),
      ...(pay ? [
        el("span", { text: "checkout" }), el("span", { text: p.merchantUrl || "not given" }),
        el("span", { text: "payee name" }), el("span", { text: p.payeeName ? `${p.payeeName} · ${p.payeeStatus}` : "not given" }),
        el("span", { text: "MCC" }), el("span", { text: p.mcc || "—" }),
      ] : []),
      ...(pol ? changeRows(a) : []),
      el("span", { text: "expires" }), el("span", { text: new Date(a.expiresAt).toLocaleString() }));
    const note = el("p", { class: "one-note" });
    const err = el("div", { class: "err" });
    const card = el("article", { class: "req-card focus", "data-id": a.id },
      el("div", { class: "req-top" },
        el("div", { style: "min-width:0" },
          el("div", { class: "req-name", text: v.card }),
          el("div", { class: "req-purpose", text: pay ? `wants to pay ${p.merchant || "a merchant"}` + (p.purpose ? " · " + p.purpose : "") : (pol ? "wants a policy change" : "requests funds") + (purpose ? " · " + purpose : "") })),
        pol ? el("div", { class: "req-amt" }, "Policy") : el("div", { class: "req-amt" }, (pay ? "" : "+") + money(a.amount, cur), el("small", { text: cur }))),
      whyRow, kv);

    if (!live) return card;
    if (!v.signable && !v.email_approver) {
      note.textContent = `This card's approver ("${a.approver}") isn't an email, an ENS name or an address, so only the operator can decide it on the console.`;
      card.append(note);
      return card;
    }

    const approveBtn = el("button", { class: "approve-btn", text: pay ? `Approve & pay ${money(a.amount, cur)}` : pol ? "Approve changes" : `Approve ${money(a.amount, cur)}` });
    const denyBtn = el("button", { class: "btn-deny", text: "Deny" });
    const picker = el("div", { class: "ns-switch one-wallets", role: "radiogroup", "aria-label": "Wallet", hidden: "" });

    const done = (approve, res, how) => {
      const charge = res.approval?.charge;
      if (!approve) {
        denyBtn.textContent = "Denied"; approveBtn.style.opacity = "0.3";
        whyRow.className = "req-why no"; whyRow.lastChild.textContent = `DENIED · ${how}`;
      } else if (charge?.approved === false) {
        approveBtn.textContent = "Declined by issuer";
        whyRow.className = "req-why no"; whyRow.lastChild.textContent = `ISSUER DECLINED · ${charge.decline_reason || "DECLINED"}`;
      } else {
        approveBtn.textContent = pay ? "Paid ✓" : pol ? "Applied ✓" : "Approved ✓"; approveBtn.style.background = "var(--success)";
        const lim = res.card?.records?.["card.limit.monthly"];
        whyRow.className = "req-why ok";
        whyRow.lastChild.textContent = (pay ? "PAID" : pol ? "APPLIED" : `APPROVED · allowance now ${money(lim, cur)}`) + ` · ${how}`;
      }
      picker.hidden = true;
      note.textContent = POPUP ? "Done. Closing…" : "Done. You can close this tab and go back to the chat.";
      // A tab the host opened can't be closed by script; say so if it's still here.
      if (POPUP) setTimeout(() => { window.close(); setTimeout(() => { note.textContent = "Done. You can close this tab and go back to the chat."; }, 400); }, 1200);
      if (CONSOLE && me) { lastSig = ""; load(); }
    };

    // ----- email approver: sign in with a code, then decide -----
    const decideByEmail = async (approve) => {
      approveBtn.disabled = denyBtn.disabled = true; err.textContent = "";
      const btn = approve ? approveBtn : denyBtn, label = btn.textContent;
      try {
        let s = Auth.session();
        if (!s) {
          s = await Auth.open({ title: "Confirm it's you", sub: `Only ${a.approver} can decide this. Enter that email and we'll send a 6-digit code.`, hint: "Signing in keeps you signed in on this browser for 7 days." });
          if (!s) { btn.textContent = label; approveBtn.disabled = denyBtn.disabled = false; return; }
        }
        btn.textContent = "Submitting…";
        const r = await fetch(`${API}/api/approvals/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.token }, body: JSON.stringify({ approve }) });
        const res = await r.json().catch(() => ({}));
        if (r.status === 401) { Auth.forget(); throw new Error("Your session ended. Press the button again to sign in."); }
        if (r.status === 403) {
          throw Object.assign(new Error(res?.error?.message || "You aren't this card's approver."), { other: true });
        }
        if (!r.ok) throw new Error(res?.error?.message || `HTTP ${r.status}`);
        done(approve, res, `confirmed by ${s.email}`);
      } catch (e) {
        btn.textContent = label; approveBtn.disabled = denyBtn.disabled = false;
        err.textContent = e.message;
        if (e.other) err.append(" ", el("button", { class: "auth-link", type: "button", text: "Sign in as someone else", onclick: async () => { await Auth.signOut(); err.textContent = ""; drawEmailNote(); } }));
      }
    };
    const drawEmailNote = () => {
      const s = Auth.session();
      note.textContent = s ? `You're signed in as ${s.email}. Your decision applies at once.` : `You confirm signed in with a code sent to ${a.approver}. No wallet needed.`;
    };

    // ----- wallet approver: EIP-712 signature -----
    let chosen = 0;
    const drawPicker = () => {
      picker.textContent = "";
      picker.hidden = wallets.length < 2;
      wallets.forEach((w, i) => picker.append(el("button", { type: "button", role: "radio", "aria-checked": String(i === chosen), text: w.info.name,
        onclick: () => { chosen = i; drawPicker(); } })));
    };
    const provider = () => wallets[chosen]?.provider || window.ethereum;
    const decideByWallet = async (approve) => {
      const p0 = provider();
      if (!p0) {
        err.textContent = "No wallet in this browser. Open this link in your wallet app's browser (MetaMask, Rabby, Coinbase Wallet) or on a computer with a wallet extension.";
        return;
      }
      approveBtn.disabled = denyBtn.disabled = true; err.textContent = "";
      const btn = approve ? approveBtn : denyBtn, label = btn.textContent;
      try {
        btn.textContent = "Connecting…";
        const accounts = await p0.request({ method: "eth_requestAccounts" });
        const want = (v.approver_address || "").toLowerCase();
        const acct = accounts.find((x) => x.toLowerCase() === want) || accounts[0];
        if (want && acct.toLowerCase() !== want) {
          throw new Error(`Connected ${short(acct)}, but the approver is ${short(v.approver_address)}. Switch to that account in your wallet and try again.`);
        }
        if ((await p0.request({ method: "eth_chainId" })) !== "0x1") {
          try { await p0.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }); }
          catch { throw new Error("Switch your wallet to Ethereum mainnet. Signing is free; nothing is sent on-chain."); }
        }
        btn.textContent = "Sign in your wallet…";
        const signature = await p0.request({ method: "eth_signTypedData_v4", params: [acct, JSON.stringify(v.typed_data[approve ? "approve" : "deny"])] });
        btn.textContent = "Submitting…";
        const r = await fetch(`${API}/approvals/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve, signature }) });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(res?.error?.message || `HTTP ${r.status}`);
        done(approve, res, `signed by ${who(a.approver)}`);
      } catch (e) {
        btn.textContent = label;
        approveBtn.disabled = denyBtn.disabled = false;
        err.textContent = e?.code === 4001 ? "You cancelled in your wallet. Nothing was decided." : e.message;
      }
    };

    const email = v.email_approver;
    const decide = email ? decideByEmail : decideByWallet;
    approveBtn.addEventListener("click", () => decide(true));
    denyBtn.addEventListener("click", () => decide(false));
    if (email) drawEmailNote();
    else {
      drawPicker();
      const signer = who(a.approver) === who(v.approver_address || "") ? who(a.approver) : `${a.approver}${v.approver_address ? ` (${short(v.approver_address)})` : ""}`;
      note.textContent = `Your wallet asks you to sign a message: free, nothing is sent on-chain. Sign with ${signer}.`;
      // Wallets that announce late (extensions) still make the picker.
      window.addEventListener("eip6963:announceProvider", () => setTimeout(drawPicker));
    }
    card.append(el("div", { class: "req-actions" }, approveBtn, denyBtn, picker), note, err);
    // From the chat: the click there was the decision, so go straight on (after
    // wallet extensions announce). The wallet prompt, or the code, confirms it.
    if ((POPUP === "approve" || POPUP === "deny") && !autoStarted) {
      autoStarted = true;
      setTimeout(() => decide(POPUP === "approve"), 400);
    }
    return card;
  }

  let autoStarted = false;
  window.addEventListener("hashchange", () => { focusId = location.hash.slice(1); lastSig = ""; if (CONSOLE) load(); loadOne(); });
  loadOne();
  if (CONSOLE && !POPUP) {
    initSignin();
    bearer() ? start() : showSignin();
  }
})();
