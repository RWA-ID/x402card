// The issue form: an MCP App (ui:// resource) for issue_card. The tool's
// first result carries the defaults and caps; the person sets the policy here
// and submits, which calls issue_card again through the host (tools/call,
// submit: true). A wallet sign-in gets the next testN.xcard.eth; an email
// sign-in names its card. The approver is an email, wallet or ENS name
// (default: whoever signed in); the server enforces the caps whatever this form sends.
import { UI_MIME } from "./approval.ts";

const FONTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

export function issueResource() {
  return {
    uri: "ui://xcard/issue.html",
    mimeType: UI_MIME,
    text: HTML,
    _meta: { ui: { csp: { resourceDomains: FONTS }, prefersBorder: false } },
  };
}

// Common categories for agent spend; the API takes any 4-digit MCC.
const MCCS: [string, string][] = [
  ["5734", "Software"],
  ["7372", "Computer services"],
  ["4816", "Cloud & hosting"],
  ["5817", "Apps & digital goods"],
  ["7399", "Business services"],
  ["5968", "Subscriptions"],
];

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issue an X Card</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
  :root {
    --bg: #0a0b0d; --chip: #15181e; --text: #eceef1; --text-2: #b9bdc6; --muted: #8b909a; --line: rgba(255,255,255,0.08);
    --accent: oklch(0.74 0.19 258); --accent-hover: oklch(0.8 0.17 258); --accent-soft: oklch(0.74 0.19 258 / 0.14);
    --success: oklch(0.8 0.16 155); --error: oklch(0.7 0.19 25);
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
  .brand { font: 600 13px var(--sans); color: var(--text-2); }
  .brand i { font-style: normal; color: var(--accent); }
  .pill { font: 500 11px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; background: var(--chip); color: var(--text-2); }
  .pill.ok { color: var(--success); } .pill.no { color: var(--error); }
  h2 { font: 600 17px var(--sans); margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
  label.f { display: flex; flex-direction: column; gap: 5px; }
  label.f > span, .lbl { font: 500 11px var(--mono); text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  label.f > span i { font-style: normal; text-transform: none; letter-spacing: 0; color: var(--muted); opacity: 0.8; }
  .money { display: flex; align-items: center; background: var(--chip); border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; }
  .money:focus-within { border-color: var(--accent); }
  .money b { color: var(--muted); font-weight: 400; }
  .text { display: flex; align-items: center; background: var(--chip); border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; }
  .text:focus-within { border-color: var(--accent); }
  .text input { width: 100%; min-width: 0; background: transparent; border: 0; color: var(--text); font: 500 14px var(--mono); padding: 9px 2px; outline: none; }
  .text em { font: 500 13px var(--mono); font-style: normal; color: var(--muted); flex: none; }
  input[type=number] { width: 100%; background: transparent; border: 0; color: var(--text); font: 500 15px var(--sans); padding: 9px 6px; outline: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .chip { font: 500 12.5px var(--sans); padding: 6px 11px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--text-2); cursor: pointer; }
  .chip[aria-pressed=true] { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }
  .row { margin-top: 14px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
  button.go { font: 500 14px var(--sans); border-radius: 999px; padding: 10px 18px; cursor: pointer; border: 0; background: var(--accent); color: #05070a; flex: 1 1 auto; }
  button.go:hover:not(:disabled) { background: var(--accent-hover); }
  button.go:disabled { opacity: 0.6; cursor: default; }
  button.go.done { background: var(--success); opacity: 1; }
  .note { color: var(--muted); font-size: 12.5px; margin: 10px 0 0; }
  .err { color: var(--error); font-size: 12.5px; margin-top: 8px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12.5px; }
  .kv span:nth-child(odd) { color: var(--muted); font: 500 11.5px var(--mono); text-transform: uppercase; letter-spacing: 0.04em; padding-top: 1px; }
  .kv span:nth-child(even) { color: var(--text-2); overflow-wrap: anywhere; }
  .name { font: 500 17px var(--mono); overflow-wrap: anywhere; }
  .agent { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .agent p { color: var(--muted); font-size: 12.5px; margin: 4px 0 8px; }
  .tok { font: 500 12.5px var(--mono); background: var(--chip); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; overflow-wrap: anywhere; user-select: all; }
  .agent .actions { margin-top: 8px; flex-wrap: wrap; }
  button.ghost { font: 500 12.5px var(--sans); border-radius: 999px; padding: 6px 12px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--text-2); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<div class="card" id="root"><div class="note">Loading…</div></div>
<script>
(() => {
  "use strict";
  const MCCS = ${JSON.stringify(MCCS)};
  const root = document.getElementById("root");

  // ---------- host bridge ----------
  let seq = 0;
  const waiting = new Map();
  const send = (m) => window.parent.postMessage(m, "*");
  const request = (method, params, ms = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(method + " timed out")); }, ms);
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
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    } else if (m.id !== undefined && m.method) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
    }
  });
  new ResizeObserver(() => {
    const r = document.documentElement.getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }).observe(document.documentElement);
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "X Card issue", version: "1.0.0" }, appCapabilities: {} }, 15000)
    .catch(() => {})
    .finally(() => notify("ui/notifications/initialized", {}));

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
  const brand = () => el("div", { class: "brand" }, "X ", el("i", { text: "·" }), " Card");
  const usd = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const tell = (text) => {
    request("ui/update-model-context", { content: [{ type: "text", text }] }).catch(() => {});
    request("ui/message", { role: "user", content: [{ type: "text", text }] }).catch(() => {});
  };

  function onResult(res) {
    const sc = res.structuredContent || {};
    if (sc.decision === "form") return form(sc.defaults || {}, sc.caps || {}, sc.me || {});
    if (sc.card) return issued(sc.card, sc.agent_token);
    const msg = (sc.error && sc.error.message) || (res.content && res.content[0] && res.content[0].text) || "Couldn't issue the card.";
    root.textContent = "";
    root.append(el("div", { class: "top" }, brand(), el("span", { class: "pill no", text: "Not issued" })), el("div", { class: "note", text: msg }));
  }

  function money(key, label, value, cap, optional) {
    const input = el("input", { type: "number", min: "0", step: "1", value: value ?? "", "aria-label": label, ...(optional ? { placeholder: "none" } : { required: "" }) });
    if (cap) input.max = String(cap);
    return { key, input, node: el("label", { class: "f" }, el("span", {}, label + " ", cap ? el("i", { text: "max " + usd(cap) }) : null), el("div", { class: "money" }, el("b", { text: "$" }), input)) };
  }

  // me: who signed in, {email} or {address}. An email account names its card; a wallet gets the next testN.
  function form(d, caps, me) {
    const account = !!me.email;
    const nameIn = el("input", { value: d.name || "", placeholder: "maria", spellcheck: "false", autocapitalize: "off", "aria-label": "Name", maxlength: "63" });
    const nameField = account ? el("label", { class: "f", style: "margin-bottom:12px" }, el("span", { text: "Name" }), el("div", { class: "text" }, nameIn, el("em", { text: ".xcard.eth" }))) : null;
    // Who approves: an email (confirms by email) or a wallet / ENS name (signs). Defaults to whoever signed in.
    const approverIn = el("input", { value: d.approver || me.email || me.address || "", placeholder: "manager@company.com or alice.eth", spellcheck: "false", autocapitalize: "off", "aria-label": "Approver" });
    const apHint = el("p", { class: "note", style: "margin-top:6px" });
    const hintAp = () => {
      const v = approverIn.value.trim();
      apHint.textContent = v.includes("@") ? "They get each request by email and confirm it with a code." : v ? "They sign each decision with that wallet: free, nothing goes on-chain." : "";
    };
    approverIn.addEventListener("input", hintAp); hintAp();
    const approverField = el("div", { class: "row" }, el("label", { class: "f" }, el("span", {}, "Approver ", el("i", { text: "email, wallet or ENS name" })), el("div", { class: "text" }, approverIn)), apHint);
    const fields = [
      money("limit_tx", "Per transaction", d.limit_tx, caps.tx),
      money("limit_daily", "Daily", d.limit_daily, caps.daily, true),
      money("limit_monthly", "Monthly", d.limit_monthly, caps.monthly),
    ];
    const chosen = new Set((d.mcc_allow || []).map(String));
    const chips = MCCS.map(([code, label]) => {
      const b = el("button", { type: "button", class: "chip", "aria-pressed": String(chosen.has(code)), title: "MCC " + code, text: label });
      b.addEventListener("click", () => { chosen.has(code) ? chosen.delete(code) : chosen.add(code); b.setAttribute("aria-pressed", String(chosen.has(code))); });
      return b;
    });
    let payee = d.payee || "verified-or-escalate";
    const PAYEES = [["verified-or-escalate", "Verified, or ask me"], ["verified-only", "Verified only"], ["any", "Any merchant"]];
    const payeeChips = PAYEES.map(([v, label]) => {
      const b = el("button", { type: "button", class: "chip", "aria-pressed": String(v === payee), text: label });
      b.addEventListener("click", () => { payee = v; payeeChips.forEach((x, i) => x.setAttribute("aria-pressed", String(PAYEES[i][0] === v))); });
      return b;
    });
    const go = el("button", { class: "go", type: "submit", text: "Issue card" });
    const err = el("div", { class: "err" });
    const f = el("form", { novalidate: "" },
      nameField,
      el("div", { class: "grid" }, ...fields.map((x) => x.node)),
      el("div", { class: "row" }, el("div", { class: "lbl", text: "Where it can pay" }), el("div", { class: "chips" }, ...chips)),
      el("div", { class: "row" }, el("div", { class: "lbl", text: "Payee check" }), el("div", { class: "chips" }, ...payeeChips)),
      approverField,
      el("div", { class: "actions" }, go),
      el("p", { class: "note", text: me.org
        ? "A sandbox virtual Visa for " + me.org + ". Anything over these limits waits for the approver."
        : account
        ? "A sandbox virtual Visa under your name. Anything over these limits waits for the approver."
        : "You'll get the next free test name (testN.xcard.eth) on a sandbox virtual Visa. Anything over these limits waits for the approver." }),
      err);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const approver = approverIn.value.trim();
      if (!/^([^\s@]+@[^\s@]+\.[a-z]{2,}|0x[0-9a-fA-F]{40}|[^\s.,@]+(\.[^\s.,@]+)*\.[a-z]{2,})$/i.test(approver)) { err.textContent = "The approver is an email, a 0x address or an ENS name."; return; }
      const name = nameIn.value.trim().toLowerCase().replace(/\.xcard\.eth$/, "");
      if (account && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) { err.textContent = "Pick a name: lowercase letters, digits and hyphens."; return; }
      const policy = { mcc_allow: [...chosen], payee, approver };
      for (const x of fields) {
        const raw = x.input.value.trim();
        if (!raw) { if (x.key === "limit_daily") continue; err.textContent = "Set every limit except daily."; return; }
        const n = Number(raw);
        if (!(n > 0)) { err.textContent = "Limits must be more than $0."; return; }
        policy[x.key] = n;
      }
      if (policy.limit_daily !== undefined && (policy.limit_tx > policy.limit_daily || policy.limit_daily > policy.limit_monthly)) {
        err.textContent = "Keep per transaction ≤ daily ≤ monthly."; return;
      }
      if (policy.limit_tx > policy.limit_monthly) { err.textContent = "Per transaction can't be more than monthly."; return; }
      go.disabled = true; go.textContent = "Issuing…";
      try {
        const r = await request("tools/call", { name: "issue_card", arguments: { ...(account ? { name } : {}), policy, submit: true } }, 60000);
        const sc = (r && r.structuredContent) || {};
        if (r && r.isError || !sc.card) throw new Error((sc.error && sc.error.message) || (r && r.content && r.content[0] && r.content[0].text) || "not issued");
        issued(sc.card, sc.agent_token);
        tell("I issued " + sc.card.name + " (" + usd(policy.limit_tx) + "/transaction" + (policy.limit_daily ? ", " + usd(policy.limit_daily) + "/day" : "") + ", " + usd(policy.limit_monthly) + "/month).");
      } catch (ex) {
        go.disabled = false; go.textContent = "Issue card";
        err.textContent = ex.message;
      }
    });
    root.textContent = "";
    root.append(el("div", { class: "top" }, brand(), el("span", { class: "pill", text: "New card" })),
      el("h2", { text: "Issue a card" }), el("p", { class: "sub", text: "Set what it may spend and who approves the rest. Tightening applies at once; loosening waits for the approver." }), f);
  }

  // The agent token, shown once: masked until revealed (the chat is often on a shared screen).
  function agentAccess(card, token) {
    const masked = token.slice(0, 8) + "•".repeat(16);
    const shown = el("div", { class: "tok", text: masked });
    // Chat frames may block the clipboard API: try the older route before showing anything.
    const legacyCopy = (text) => {
      const t = el("textarea", { style: "position:fixed;opacity:0" });
      t.value = text;
      document.body.append(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      t.remove();
      return ok;
    };
    const copy = (btn, text) => {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).catch(() => { if (!legacyCopy(text)) throw 0; }).then(() => { btn.textContent = "Copied"; }, () => {
        shown.textContent = text;
        reveal.textContent = "Hide";
        btn.textContent = "Select the text above";
      });
    };
    const reveal = el("button", { type: "button", class: "ghost", text: "Reveal" });
    reveal.addEventListener("click", () => {
      const hide = shown.textContent !== masked;
      shown.textContent = hide ? masked : token;
      reveal.textContent = hide ? "Reveal" : "Hide";
    });
    const copyToken = el("button", { type: "button", class: "ghost", text: "Copy token" });
    copyToken.addEventListener("click", () => copy(copyToken, token));
    const copyLine = el("button", { type: "button", class: "ghost", text: "Copy claude mcp add" });
    copyLine.addEventListener("click", () => copy(copyLine, "claude mcp add --transport http " + card.name.split(".")[0] + ' https://mcp.x-card.dev/mcp --header "Authorization: Bearer ' + token + '"'));
    return el("div", { class: "agent" },
      el("div", { class: "lbl", text: "Agent token" }),
      el("p", { text: "For an agent that runs on its own. It works for this card only, under this policy, and never sees a card number. Shown once, and not shared with this chat." }),
      shown,
      el("div", { class: "actions" }, reveal, copyToken, copyLine));
  }

  function issued(card, token) {
    const r = card.records || {};
    const mccs = (r["card.mcc.allow"] || "").split(",").filter(Boolean).map((c) => (MCCS.find((m) => m[0] === c) || [c, "MCC " + c])[1]);
    root.textContent = "";
    root.append(
      el("div", { class: "top" }, brand(), el("span", { class: "pill ok", text: card.status || "active" })),
      el("div", { class: "name", text: card.name }),
      el("div", { class: "sub", text: "Virtual Visa" + (card.last4 ? " ending " + card.last4 : "") + " · sandbox" }),
      el("div", { class: "kv" },
        el("span", { text: "per tx" }), el("span", { text: usd(r["card.limit.tx"]) }),
        el("span", { text: "daily" }), el("span", { text: r["card.limit.daily"] ? usd(r["card.limit.daily"]) : "none" }),
        el("span", { text: "monthly" }), el("span", { text: usd(r["card.limit.monthly"]) }),
        el("span", { text: "pays" }), el("span", { text: mccs.length ? mccs.join(", ") : "any category" }),
        el("span", { text: "payee" }), el("span", { text: r["card.payee"] || "any" }),
        el("span", { text: "approver" }), el("span", { text: (r["card.approver"] || "").replace(/^(0x.{4}).*(.{4})$/, "$1…$2") })),
      ...(token ? [agentAccess(card, token)] : []));
  }
})();
</script>
</body>
</html>
`;
