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
  if (!CONSOLE && !UUID.test(location.hash.slice(1))) { location.replace("console" + location.search); return; }

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
    const grid = el("div", { class: "fleet-grid" });
    for (const c of cards) grid.append(fleetItem(c));
    box.append(grid);
    if (highlight) {
      const f = grid.querySelector(`[data-card="${CSS.escape(highlight)}"]`);
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
        renderPending(approvals, cards);
        renderFleet(cards);
        renderHistory(approvals);
        firstCard(cards.length === 0);
      }
      $("[data-updated]").textContent = "updated " + new Date().toTimeString().slice(0, 8);
    } catch (err) {
      if (err.message === "unauthorized") return;
      $("[data-updated]").textContent = "offline · retrying";
    }
    timer = setTimeout(load, POLL_MS);
  }

  // A new account with no cards: the issue form leads, titled for it.
  function firstCard(none) {
    const blk = $("[data-issue-block]");
    blk.classList.toggle("first", none && !me.admin);
    $("[data-issue-title]").textContent = none && !me.admin ? "Issue your first card" : "Issue a card";
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
  function initIssue() {
    const form = $("[data-issue-form]"), labelIn = $("[data-issue-label]"), preview = $("[data-issue-preview]");
    const submit = $("[data-issue-submit]"), err = $("[data-issue-err]"), out = $("[data-issued]");
    const approverIn = $('[data-issue="approver"]');
    const isAccount = () => !me.admin;

    let ns = "xcard.eth";
    const nsGroup = radioGroup("[data-ns-switch] [data-ns]", "ns", (v) => {
      ns = v;
      if (!isAccount()) { try { localStorage.setItem(NS_KEY, v); } catch { /* private mode */ } }
      refresh();
    });

    // Approver: an email (they confirm by email) or a wallet / ENS name (they sign).
    let apMode = "email";
    const apHint = $("[data-approver-hint]");
    const AP = {
      email: { ph: "manager@company.com", hint: "They get each request by email and confirm it signed in with a code. No wallet needed." },
      wallet: { ph: "alice.eth or 0x…", hint: "They sign each decision with that wallet: free, nothing goes on-chain." },
    };
    const apGroup = radioGroup("[data-approver-switch] [data-ap]", "ap", (v) => {
      const prev = apMode; apMode = v;
      approverIn.placeholder = AP[v].ph; apHint.textContent = AP[v].hint;
      approverIn.type = v === "email" ? "email" : "text";
      // Switching modes clears a value that belongs to the other one; email starts as you.
      if (prev !== v) approverIn.value = v === "email" && isAccount() ? me.email : "";
    });

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
    const problem = (v) =>
      !v ? "" : !LABEL_RE.test(v) ? "Use lowercase letters, digits and hyphens (not at the start or end)."
        : isReserved(v, ns) ? `${v}.${ns} is reserved.` : "";
    // Taken names show while typing.
    let checkSeq = 0, checkTimer;
    const avail = $("[data-issue-avail]");
    function refresh() {
      const v = label();
      const p = problem(v);
      preview.textContent = v ? (p ? "" : `→ ${v}.${ns}`) : `→ <name>.${ns}`;
      err.textContent = p;
      submit.disabled = !v || !!p;
      avail.textContent = ""; avail.className = "issue-avail";
      clearTimeout(checkTimer);
      if (!v || p) return;
      const seq = ++checkSeq;
      checkTimer = setTimeout(async () => {
        try {
          const r = await api(`/api/names/${encodeURIComponent(`${v}.${ns}`)}`);
          if (seq !== checkSeq) return;
          avail.textContent = r.available ? "available" : "taken";
          avail.className = "issue-avail " + (r.available ? "ok" : "no");
          if (!r.available) { err.textContent = r.reason; submit.disabled = true; }
        } catch { /* the submit reports it */ }
      }, 300);
    }
    labelIn.addEventListener("input", refresh);

    // Payee check: new cards default to verified-or-escalate.
    const PAYEE_HINT = {
      "verified-or-escalate": "A merchant whose ENS name lists the checkout pays straight through. Any other merchant waits for the approver; a lookalike is blocked.",
      "verified-only": "Only merchants whose ENS name lists the checkout. Everything else is blocked, with no approval path.",
      any: "No payee gate: the card pays any merchant its limits allow, and allowed payees are ignored. Fine for testing, not for real money.",
    };
    let payee = "verified-or-escalate";
    const payeeHint = $("[data-payee-hint]");
    radioGroup("[data-payee-switch] [data-payee]", "payee", (v) => { payee = v; payeeHint.textContent = PAYEE_HINT[v]; }).set(payee);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = label();
      if (!v || problem(v)) return refresh();
      const f = (k) => $(`[data-issue="${k}"]`).value.trim();
      const list = (s) => s.split(/[\s,]+/).filter(Boolean);
      const approver = f("approver");
      if (!approver) { err.textContent = apMode === "email" ? "Enter the approver's email." : "Enter the approver's ENS name or wallet address."; return; }
      if (apMode === "email" ? !isEmail(approver) : !APPROVER_RE.test(approver)) {
        err.textContent = apMode === "email" ? `${approver} isn't an email address.` : `${approver} isn't an ENS name or a 0x address.`; return;
      }
      const payeeAllow = list(f("payee_allow").toLowerCase());
      const badPayee = payeeAllow.find((n) => !PAYEE_NAME_RE.test(n));
      if (badPayee) { err.textContent = `${badPayee} isn't an ENS name. Allowed payees look like modelhub.eth.`; return; }
      const name = `${v}.${ns}`;
      submit.disabled = true; submit.textContent = "Issuing…"; err.textContent = "";
      try {
        const r = await api("/api/cards", { method: "POST", body: JSON.stringify({ name, policy: {
          limit_tx: Number(f("limit_tx")), limit_monthly: Number(f("limit_monthly")),
          ...(f("limit_daily") ? { limit_daily: Number(f("limit_daily")) } : {}),
          currencies: list(f("currencies").toUpperCase()), mcc_allow: list(f("mcc_allow")), approver,
          payee, payee_allow: payeeAllow,
        } }) });
        showIssued(r.card.name, r.agent_token);
        labelIn.value = "";
        highlight = r.card.name;
        lastSig = ""; load();
      } catch (ex) {
        if (ex.message !== "unauthorized") err.textContent = ex.message;
      } finally {
        submit.textContent = "Issue card"; refresh();
      }
    });

    function showIssued(name, tok) {
      const cmd = `claude mcp add --transport http ${name.split(".")[0]} ${MCP_URL} \\\n  --header "Authorization: Bearer ${tok}"`;
      // Masked until asked: the page is often on a shared screen or a recording.
      const masked = (t) => t.replaceAll(tok, tok.slice(0, 4) + "•".repeat(12));
      const copy = (text) => el("button", { type: "button", class: "btn-xs", text: "Copy", onclick: async (e) => {
        try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; } catch { e.target.textContent = "Reveal to copy"; }
      } });
      const secret = (tag, cls, text) => {
        const n = el(tag, { class: cls, text: masked(text) });
        let shown = false;
        const reveal = el("button", { type: "button", class: "btn-xs", text: "Reveal", onclick: () => {
          shown = !shown; n.textContent = shown ? text : masked(text); reveal.textContent = shown ? "Hide" : "Reveal";
        } });
        return [n, reveal];
      };
      out.textContent = "";
      out.append(
        el("div", { class: "issued-head" }, pill("active"), el("span", { class: "mono issued-name", text: name }),
          el("button", { type: "button", class: "issued-x", "aria-label": "Dismiss", text: "×", onclick: () => { out.hidden = true; out.textContent = ""; } })),
        el("p", { text: "Your card is live, and its policy resolves from the name right now. Give it to an agent (Claude Code, Cursor, any MCP client) with this token. It only works for this card and is shown once: store it now." }),
        el("div", { class: "issued-line" }, ...secret("code", "mono", tok), copy(tok)),
        el("p", { text: "Or add it to Claude Code in one line:" }),
        el("div", { class: "issued-line" }, ...secret("pre", "code", cmd), copy(cmd.replace("\\\n  ", ""))));
      out.hidden = false;
      out.scrollIntoView({ block: "nearest", behavior: R ? "auto" : "smooth" });
    }

    return function configure() {
      const account = isAccount();
      // Demo accounts issue under xcard.eth; the operator picks either namespace.
      $("[data-ns-switch]").hidden = account;
      $("[data-ns-fixed]").hidden = !account;
      $("[data-caps]").hidden = !account;
      if (account && caps) $("[data-caps]").textContent = `Demo limits: up to ${money(caps.tx)} per transaction, ${money(caps.daily)} a day, ${money(caps.monthly)} a month, USD, ${caps.perAccount} cards per account.`;
      const curIn = $('[data-issue="currencies"]');
      curIn.readOnly = account;
      if (account) curIn.value = "USD";
      let saved = "xcard.eth";
      if (!account) { try { if (localStorage.getItem(NS_KEY) === "x402card.eth") saved = "x402card.eth"; } catch { /* private mode */ } }
      nsGroup.set(saved);
      apGroup.set(account ? "email" : "wallet");
      approverIn.value = account ? me.email : "";
      // A first name to start from: the email's name part.
      labelIn.value = "";
      if (account) {
        const guess = me.email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
        if (guess && LABEL_RE.test(guess)) labelIn.value = guess;
      }
      out.hidden = true; out.textContent = "";
      refresh();
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
