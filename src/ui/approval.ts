// The approval card: an MCP App (ui:// resource, SEP-1865) the chat renders
// for pay, request_funding and get_approval. When a result waits on
// card.approver, it shows the request and an Approve button that signs the
// same EIP-712 typed data as approve.html, with the wallet in this frame when
// the host lets an extension reach it, else on approval_url in a new tab
// (the card then follows the decision by polling). Signing is free; nothing
// goes on-chain. Everything the view knows comes from the public
// GET /approvals/:id on this origin.

export const UI_MIME = "text/html;profile=mcp-app";

const FONTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

export function approvalResource(origin: string) {
  return {
    uri: "ui://xcard/approval.html",
    mimeType: UI_MIME,
    text: approvalHtml(origin),
    _meta: { ui: { csp: { connectDomains: [origin], resourceDomains: FONTS }, prefersBorder: false } },
  };
}

export function approvalHtml(origin: string): string {
  return HTML.replace("__API__", JSON.stringify(origin));
}

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X Card approval</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
  :root {
    --bg: #0a0b0d; --surface: #0f1115; --chip: #15181e; --text: #eceef1; --text-2: #b9bdc6; --muted: #8b909a;
    --line: rgba(255,255,255,0.08); --accent: oklch(0.74 0.19 258); --accent-hover: oklch(0.8 0.17 258);
    --accent-soft: oklch(0.74 0.19 258 / 0.14); --success: oklch(0.8 0.16 155); --error: oklch(0.7 0.19 25);
    --warning: oklch(0.84 0.14 80);
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: "Geist", system-ui, -apple-system, sans-serif;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; background: transparent; }
  body { font: 14px/1.45 var(--sans); color: var(--text); padding: 2px; }
  .card { background: var(--bg); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; max-width: 560px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .brand { font: 600 13px var(--sans); letter-spacing: 0.02em; color: var(--text-2); }
  .brand i { font-style: normal; color: var(--accent); }
  .pill { font: 500 11px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; background: var(--chip); color: var(--warning); white-space: nowrap; }
  .pill.ok { color: var(--success); } .pill.no { color: var(--error); }
  .main { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .name { font: 500 15px var(--mono); overflow-wrap: anywhere; }
  .what { color: var(--muted); font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; }
  .amt { font: 600 28px var(--sans); letter-spacing: -0.02em; white-space: nowrap; }
  .amt small { font: 500 12px var(--mono); color: var(--muted); margin-left: 4px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12.5px; }
  .kv span:nth-child(odd) { color: var(--muted); font-family: var(--mono); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; padding-top: 1px; }
  .kv span:nth-child(even) { color: var(--text-2); overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button { font: 500 14px var(--sans); border-radius: 999px; padding: 10px 18px; cursor: pointer; border: 1px solid transparent; }
  button:disabled { cursor: default; opacity: 0.6; }
  .approve { background: var(--accent); color: #05070a; flex: 1 1 auto; }
  .approve:hover:not(:disabled) { background: var(--accent-hover); }
  .approve.done { background: var(--success); opacity: 1; }
  .deny { background: transparent; color: var(--text-2); border-color: var(--line); }
  .deny:hover:not(:disabled) { color: var(--text); border-color: rgba(255,255,255,0.18); }
  .note { color: var(--muted); font-size: 12.5px; margin: 10px 0 0; }
  .err { color: var(--error); font-size: 12.5px; margin-top: 8px; }
  .line { display: flex; align-items: center; gap: 10px; }
  .muted { color: var(--muted); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<div class="card" id="root"><div class="muted">Loading…</div></div>
<script>
(() => {
  "use strict";
  const API = __API__;
  const root = document.getElementById("root");

  // ---------- host bridge (JSON-RPC over postMessage) ----------
  let seq = 0;
  const waiting = new Map();
  const send = (m) => window.parent.postMessage(m, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(method + " timed out")); }, 15000);
  });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message || "host error")) : w.resolve(m.result);
    } else if (m.method === "ui/notifications/tool-result") {
      onResult(m.params || {});
    } else if (m.method === "ui/resource-teardown" && m.id !== undefined) {
      stopPoll();
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    } else if (m.id !== undefined && m.method) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
    }
  });

  new ResizeObserver(() => {
    const r = document.documentElement.getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }).observe(document.documentElement);

  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "X Card approval", version: "1.0.0" }, appCapabilities: {} })
    .catch(() => {})
    .finally(() => notify("ui/notifications/initialized", {}));

  // ---------- wallets in this frame (only if the host lets an extension in) ----------
  const wallets = [];
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider } = e.detail || {};
    if (provider && !wallets.some((w) => w.info.uuid === info.uuid)) wallets.push({ info, provider });
  });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch {}
  const wallet = () => wallets.find((w) => /rabby/i.test(w.info.name))?.provider || wallets[0]?.provider || window.ethereum;

  // ---------- helpers ----------
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") n.textContent = v; else if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  };
  const money = (n, cur) => {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(Number(n)); }
    catch { return n + " " + cur; }
  };
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const who = (s) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? short(s) : s);
  const brand = () => el("div", { class: "brand" }, "X ", el("i", { text: "·" }), " Card");
  const tell = (text) => {
    request("ui/update-model-context", { content: [{ type: "text", text }] }).catch(() => {});
    request("ui/message", { role: "user", content: [{ type: "text", text }] }).catch(() => {});
  };

  // ---------- results ----------
  function onResult(res) {
    const sc = res.structuredContent || {};
    const id = sc.approval_id || (sc.approval && sc.approval.id);
    if (id) return loadApproval(id);
    if (res.isError || sc.error) return summary("no", "Blocked", (sc.error && sc.error.message) || "The request was refused.");
    if (sc.decision === "approved") return summary("ok", "Approved", sc.reason || "Within the card's policy.");
    if (sc.decision === "applied") return summary("ok", "Policy updated", sc.changes || "");
    if (sc.decision === "unchanged") return summary("", "No change", sc.reason || "");
    if (sc.decision) return summary(sc.decision === "declined" || sc.decision === "blocked" ? "no" : "", sc.decision.replace(/_/g, " "), sc.reason || "");
    root.textContent = ""; root.hidden = true;
  }

  function summary(tone, label, text) {
    root.hidden = false; root.textContent = "";
    root.append(el("div", { class: "top" }, brand(), el("span", { class: "pill " + tone, text: label })), el("div", { class: "what", text }));
  }

  async function loadApproval(id) {
    root.hidden = false;
    try {
      const r = await fetch(API + "/approvals/" + encodeURIComponent(id));
      const v = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((v.error && v.error.message) || "HTTP " + r.status);
      render(v);
    } catch (e) {
      summary("no", "Unavailable", "Couldn't load the request: " + e.message);
    }
  }

  let poll;
  const stopPoll = () => { clearInterval(poll); poll = undefined; };

  function render(v) {
    const a = v.approval, p = a.payment || {}, cur = a.currency, pay = a.kind === "payment", pol = a.kind === "policy";
    const show = (k, x) => (x ? x : k === "card.limit.daily" ? "none" : "any");
    const changes = (a.policy && a.policy.changes) || [];
    const live = a.status === "pending" && a.expiresAt > Date.now();
    const purpose = (a.reason || "").split(" · ").slice(1).join(" · ");
    const state = live ? (pay ? "Held" : "Needs approval") : a.status === "pending" ? "Expired" : a.status;
    const pill = el("span", { class: "pill " + (a.status === "approved" ? "ok" : a.status === "denied" || !live ? "no" : ""), text: state });
    const rows = [
      ["approver", who(a.approver) + (v.approver_address && who(a.approver) !== short(v.approver_address) ? " · " + short(v.approver_address) : "")],
      ...(pay ? [["checkout", p.merchantUrl || "not given"], ["payee", p.payeeName ? p.payeeName + " · " + p.payeeStatus : "not given"]] : []),
      ...changes.map((c) => [c.key.slice(5), show(c.key, c.from) + " → " + show(c.key, c.to)]),
      ["why", (a.reason || "").split(" · ")[0]],
    ];
    const approveBtn = el("button", { class: "approve", type: "button", text: pay ? "Approve & pay " + money(a.amount, cur) : pol ? "Approve changes" : "Approve " + money(a.amount, cur) });
    const denyBtn = el("button", { class: "deny", type: "button", text: "Deny" });
    const note = el("p", { class: "note" });
    const err = el("div", { class: "err" });

    root.textContent = "";
    root.append(
      el("div", { class: "top" }, brand(), pill),
      el("div", { class: "main" },
        el("div", { style: "min-width:0" },
          el("div", { class: "name", text: v.card }),
          el("div", { class: "what", text: pay ? "wants to pay " + (p.merchant || "a merchant") + (p.purpose ? " · " + p.purpose : "") : (pol ? "wants a policy change" : "requests funds") + (purpose ? " · " + purpose : "") })),
        pol ? el("div", { class: "amt", text: "Policy" }) : el("div", { class: "amt" }, (pay ? "" : "+") + money(a.amount, cur), el("small", { text: cur }))),
      el("div", { class: "kv" }, ...rows.flatMap(([k, val]) => [el("span", { text: k }), el("span", { text: val })])));

    const finish = (decided) => {
      stopPoll();
      const ok = decided.status === "approved";
      pill.className = "pill " + (ok ? "ok" : "no"); pill.textContent = decided.status;
      approveBtn.disabled = denyBtn.disabled = true;
      if (ok) { approveBtn.textContent = pay ? "Paid ✓" : pol ? "Applied ✓" : "Approved ✓"; approveBtn.classList.add("done"); denyBtn.hidden = true; }
      else { denyBtn.textContent = "Denied"; approveBtn.hidden = true; }
      note.textContent = v.email_approver ? "Confirmed by " + who(a.approver) + " by email." : "Signed by " + who(a.approver) + ". Nothing was sent on-chain.";
      const what = pay ? "the " + money(a.amount, cur) + " payment to " + (p.merchant || "the merchant")
        : pol ? "the policy change (" + changes.map((c) => c.key + " " + show(c.key, c.from) + " → " + show(c.key, c.to)).join("; ") + ")"
        : "the " + money(a.amount, cur) + " funding request";
      tell("I " + (ok ? "approved " : "denied ") + what + " for " + v.card + (v.email_approver ? " by email" : " with my wallet") + " (approval " + a.id + ").");
    };

    if (!live) {
      if (a.status !== "pending") { note.textContent = "Decided by " + (a.decidedBy || who(a.approver)) + "."; root.append(note); }
      return;
    }
    if (!v.email_approver && (!v.signable || !v.typed_data)) {
      note.textContent = "This card's approver can't sign with a wallet, so the operator decides it.";
      root.append(note);
      return;
    }

    // In-frame signing when a wallet is here; otherwise the approval page in a new tab.
    // An email approver confirms on the approval page (a code to their inbox), never in the frame.
    const inFrame = () => !v.email_approver && !!wallet();
    const decideHere = async (approve) => {
      const w = wallet();
      const btn = approve ? approveBtn : denyBtn, label = btn.textContent;
      approveBtn.disabled = denyBtn.disabled = true; err.textContent = "";
      try {
        btn.textContent = "Connecting…";
        const accounts = await w.request({ method: "eth_requestAccounts" });
        const want = (v.approver_address || "").toLowerCase();
        const acct = accounts.find((x) => x.toLowerCase() === want) || accounts[0];
        if (want && acct.toLowerCase() !== want) throw new Error("Connected " + short(acct) + ", but the approver is " + short(v.approver_address) + ". Switch accounts in your wallet.");
        if ((await w.request({ method: "eth_chainId" })) !== "0x1") {
          try { await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }); }
          catch { throw new Error("Switch your wallet to Ethereum mainnet. Signing is free; nothing is sent on-chain."); }
        }
        btn.textContent = "Sign in your wallet…";
        const signature = await w.request({ method: "eth_signTypedData_v4", params: [acct, JSON.stringify(v.typed_data[approve ? "approve" : "deny"])] });
        btn.textContent = "Submitting…";
        const r = await fetch(API + "/approvals/" + encodeURIComponent(a.id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve, signature }) });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((res.error && res.error.message) || "HTTP " + r.status);
        const charge = res.approval && res.approval.charge;
        if (approve && charge && charge.approved === false) {
          stopPoll(); pill.className = "pill no"; pill.textContent = "issuer declined";
          approveBtn.textContent = "Declined by issuer"; denyBtn.hidden = true;
          note.textContent = charge.decline_reason || "The card network declined the charge.";
          return;
        }
        finish({ status: approve ? "approved" : "denied" });
      } catch (e) {
        btn.textContent = label; approveBtn.disabled = denyBtn.disabled = false;
        err.textContent = e && e.code === 4001 ? "You cancelled in your wallet. Nothing was decided." : (e && e.message) || String(e);
      }
    };
    // No wallet in this frame (extensions don't inject into the chat's sandbox):
    // a small popup on the approval page, which asks the wallet right away and
    // closes itself; a tab if the host blocks popups.
    const decideInTab = async (approve) => {
      const u = new URL(v.approval_url || API + "/approve.html#" + a.id);
      if (u.pathname.endsWith(".html")) u.pathname = u.pathname.slice(0, -5);
      u.searchParams.set("popup", approve ? "approve" : "deny");
      const w = 460, h = 640;
      const left = Math.max(0, Math.round((screen.availWidth - w) / 2)), top = Math.max(0, Math.round((screen.availHeight - h) / 3));
      let win = null;
      try { win = window.open(u.href, "xcard-approve", "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top); } catch {}
      if (!win) { try { await request("ui/open-link", { url: u.href }); } catch { window.open(u.href, "_blank"); } }
      approveBtn.textContent = v.email_approver ? "Waiting for your confirmation…" : "Waiting for your signature…"; approveBtn.disabled = denyBtn.disabled = true;
      note.textContent = v.email_approver
        ? "Confirm in the " + (win ? "window" : "tab") + " that opened, with the code we email you. This card updates when you're done."
        : win ? "Sign in your wallet. This card updates when you're done." : "Sign in the tab that opened. This card updates when you're done.";
      startPoll();
    };
    const startPoll = () => {
      if (poll) return;
      const until = Date.now() + 15 * 60 * 1000;
      poll = setInterval(async () => {
        if (Date.now() > until) return stopPoll();
        try {
          const r = await fetch(API + "/approvals/" + encodeURIComponent(a.id));
          const nv = await r.json();
          if (nv.approval && nv.approval.status !== "pending") finish(nv.approval);
        } catch {}
      }, 3000);
    };

    approveBtn.addEventListener("click", () => (inFrame() ? decideHere(true) : decideInTab(true)));
    denyBtn.addEventListener("click", () => (inFrame() ? decideHere(false) : decideInTab(false)));
    // Extensions announce late; settle the note once they've had a moment.
    setTimeout(() => {
      note.textContent = v.email_approver
        ? "You confirm in a small window, signed in with a code sent to " + who(a.approver) + "."
        : inFrame()
        ? "Your wallet asks you to sign: free, nothing is sent on-chain. Sign with " + who(a.approver) + "."
        : "Your wallet opens in a small window to sign: free, nothing is sent on-chain. Sign with " + who(a.approver) + ".";
    }, 400);
    root.append(el("div", { class: "actions" }, approveBtn, denyBtn), note, err);
    // Decided elsewhere (the approvals page, another chat)? Follow it.
    startPoll();
  }
})();
</script>
</body>
</html>
`;
