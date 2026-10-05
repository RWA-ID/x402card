// x402·card approvals: pending funding requests, fleet and history, over the
// admin API. The token lives in sessionStorage for this tab only.
// ?api=http://127.0.0.1:8787 points the page at a local Worker.
(() => {
  "use strict";

  const API = new URLSearchParams(location.search).get("api") || "https://x402card.dmpay.workers.dev";
  const TOKEN_KEY = "x402card.admin";
  const POLL_MS = 5000;
  const $ = (s, el = document) => el.querySelector(s);
  const R = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let token = read();
  let busy = false;
  let focusId = location.hash.slice(1);
  let timer;
  let lastSig = "";

  function read() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
  function save(t) { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } }

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

  async function api(path, opts = {}) {
    const r = await fetch(API + path, {
      ...opts,
      headers: { Authorization: "Bearer " + token, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) { signOut("That token was rejected."); throw new Error("unauthorized"); }
    if (!r.ok) throw new Error(body?.error?.message || body?.error || `HTTP ${r.status}`);
    return body;
  }

  // ---------- sign in ----------
  function showSignin(msg = "") {
    $("[data-signin]").hidden = false;
    $("[data-meta]").hidden = true;
    document.querySelectorAll("[data-app]").forEach((n) => (n.hidden = true));
    $("[data-signin-err]").textContent = msg;
    $("[data-token]").focus();
  }
  function signOut(msg) {
    token = ""; save(""); clearTimeout(timer); showSignin(msg);
  }
  $("[data-signin-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    token = $("[data-token]").value.trim();
    if (!token) return;
    try {
      await api("/api/approvals");
      save(token);
      $("[data-token]").value = "";
      start();
    } catch (err) {
      if (err.message !== "unauthorized") $("[data-signin-err]").textContent = "Couldn't reach the API: " + err.message;
    }
  });
  $("[data-signout]").addEventListener("click", () => signOut(""));
  $("[data-refresh]").addEventListener("click", () => load());

  // ---------- render ----------
  function renderPending(approvals, cards) {
    const box = $("[data-pending]");
    const pending = approvals.filter((a) => a.status === "pending" && a.expiresAt > Date.now());
    $("[data-pending-count]").textContent = pending.length ? `${pending.length} pending` : "";
    box.textContent = "";
    if (!pending.length) {
      box.append(el("div", { class: "empty", style: "grid-column:1/-1", text: "Nothing waiting. Escalated funding requests from agents show up here." }));
      return;
    }
    for (const a of pending) box.append(requestCard(a, cards.find((c) => c.name === a.name + ".x402card.eth")));
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
    const as = el("input", { value: a.approver || "admin", "aria-label": "Decide as", spellcheck: "false" });
    const approveBtn = el("button", { class: "approve-btn", text: `Approve ${money(a.amount, cur)}` });
    const denyBtn = el("button", { class: "btn-deny", text: "Deny" });

    const decide = async (approve) => {
      busy = true; approveBtn.disabled = denyBtn.disabled = true;
      try {
        const res = await api(`/api/approvals/${a.id}`, { method: "POST", body: JSON.stringify({ approve, by: as.value.trim() || "admin" }) });
        if (approve) {
          approveBtn.textContent = "Approved ✓"; approveBtn.style.background = "var(--success)";
          whyRow.className = "req-why ok"; whyRow.lastChild.textContent = `RELEASED · approved by ${as.value.trim() || "admin"}`;
          const after = Number(res.card?.records?.["card.limit.monthly"]) || next;
          recLine.textContent = `card.limit.monthly = ${after}`;
          if (!R) {
            fill.animate([{ transform: `scaleX(${now / scale})` }, { transform: `scaleX(${after / scale})` }], { duration: 1100, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
            recLine.animate([{ color: "oklch(0.86 0.1 258)" }, { color: "oklch(0.86 0.1 258)", offset: 0.7 }, { color: "#5d626c" }], { duration: 2000 });
            await countUp(allowVal, now, after, cur, 1100);
          } else { allowVal.textContent = money(after, cur); }
        } else {
          denyBtn.textContent = "Denied"; approveBtn.style.opacity = "0.3";
          whyRow.className = "req-why no"; whyRow.lastChild.textContent = `DENIED · by ${as.value.trim() || "admin"}`;
        }
        setTimeout(() => { busy = false; lastSig = ""; load(); }, 1800);
      } catch (err) {
        busy = false; approveBtn.disabled = denyBtn.disabled = false;
        whyRow.className = "req-why no"; whyRow.lastChild.textContent = err.message;
      }
    };
    approveBtn.addEventListener("click", () => decide(true));
    denyBtn.addEventListener("click", () => decide(false));

    return el("article", { class: "req-card", "data-id": a.id },
      el("div", { class: "req-top" },
        el("div", { style: "min-width:0" },
          el("div", { class: "req-name", text: a.name + ".x402card.eth" }),
          el("div", { class: "req-purpose", text: "requests funds" + (purpose ? " · " + purpose : "") })),
        el("div", { class: "req-amt" }, "+" + money(a.amount, cur), el("small", { text: cur }))),
      whyRow,
      el("div", { class: "allow" },
        el("div", { class: "allow-top" }, el("span", { text: "Monthly allowance" }), allowVal),
        el("div", { class: "track" }, fillNext, fill),
        el("div", { class: "allow-foot" }, recLine, el("span", { text: `→ ${next} if approved` }))),
      el("div", { class: "kv" },
        el("span", { text: "card.limit.tx" }), el("span", { text: rec["card.limit.tx"] ?? "—" }),
        el("span", { text: "card.status" }), el("span", { text: rec["card.status"] ?? "—" }),
        el("span", { text: "requested" }), el("span", { text: ago(a.createdAt) }),
        el("span", { text: "binding" }), el("span", { text: `${a.name} · ${a.amount} · ${cur}` })),
      el("div", { class: "req-actions" }, approveBtn, denyBtn, el("label", { class: "as" }, "as ", as)));
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

  function renderFleet(cards) {
    const box = $("[data-fleet]");
    $("[data-fleet-count]").textContent = cards.length ? `${cards.length} card${cards.length === 1 ? "" : "s"}` : "";
    box.textContent = "";
    if (!cards.length) { box.append(el("div", { class: "empty", text: "No cards yet. Issue one with the issue_card MCP tool." })); return; }
    const tbody = el("tbody");
    for (const c of cards) {
      const r = c.records || {};
      const cur = (r["card.currencies"] || "USD").split(",")[0];
      const action = c.status === "frozen"
        ? el("button", { class: "btn-xs", text: "Unfreeze", onclick: async (e) => {
            e.target.disabled = true;
            try { await api(`/api/cards/${encodeURIComponent(c.name)}/unfreeze`, { method: "POST" }); load(); }
            catch (err) { e.target.disabled = false; e.target.textContent = err.message; }
          } })
        : el("span", { text: "" });
      tbody.append(el("tr", {},
        el("td", { class: "name", text: c.name }),
        el("td", {}, pill(c.status)),
        el("td", { text: "••" + (c.last4 || "····") }),
        el("td", { text: money(r["card.limit.tx"], cur) }),
        el("td", { text: money(r["card.limit.monthly"], cur) }),
        el("td", { text: r["card.mcc.allow"] || "any" }),
        el("td", { text: r["card.approver"] || "—" }),
        el("td", { text: String(c.pending_approvals?.length || 0) }),
        el("td", {}, action)));
    }
    const head = el("tr", {}, ...["Name", "Status", "Card", "Per tx", "Monthly", "MCC allow", "Approver", "Pending", ""].map((h) => el("th", { text: h })));
    box.append(el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), tbody)));
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
          el("div", { class: "feed-agent", text: a.name + ".x402card.eth" }),
          el("div", { class: "feed-merch", text: a.reason })),
        el("div", { class: "feed-right" }, el("div", { class: "feed-amt", text: "+" + money(a.amount, a.currency) }), pill(status))));
    }
    box.append(panel);
  }

  // ---------- load loop ----------
  async function load() {
    if (busy || !token) return;
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
      }
      $("[data-updated]").textContent = "updated " + new Date().toTimeString().slice(0, 8);
    } catch (err) {
      if (err.message === "unauthorized") return;
      $("[data-updated]").textContent = "offline · retrying";
    }
    timer = setTimeout(load, POLL_MS);
  }

  function start() {
    $("[data-signin]").hidden = true;
    $("[data-meta]").hidden = false;
    document.querySelectorAll("[data-app]").forEach((n) => (n.hidden = false));
    load();
  }

  window.addEventListener("hashchange", () => { focusId = location.hash.slice(1); lastSig = ""; load(); });
  token ? start() : showSignin();
})();
