// The card view: an MCP App (ui:// resource) for get_card, list_cards, freeze,
// list_transactions and sign_request (a Visa TAP signature), drawn like the agent cards on the home page (dark
// face, mark, chip, masked number, name) with the policy as tags and as the
// ENS text records it is published as. Everything comes from the tool result;
// the view makes no requests of its own.
import { UI_MIME } from "./approval.ts";

const FONTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

export function cardResource() {
  return {
    uri: "ui://xcard/card.html",
    mimeType: UI_MIME,
    text: HTML,
    _meta: { ui: { csp: { resourceDomains: FONTS }, prefersBorder: false } },
  };
}

// Names for the categories the issue form offers; others show as "MCC 1234".
const MCC_NAMES: Record<string, string> = {
  "5734": "software", "7372": "computer services", "4816": "cloud & hosting",
  "5817": "apps & digital goods", "7399": "business services", "5968": "subscriptions",
};

const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><circle cx="14" cy="14" r="6" fill="#ECEEF1"/><circle cx="34" cy="14" r="6" fill="#ECEEF1"/><circle cx="14" cy="34" r="6" fill="#ECEEF1"/><path d="M29 29l10 10M39 29l-10 10" stroke="#4A90FF" stroke-width="4.5" stroke-linecap="round"/></svg>`;

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X Card</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
  :root {
    --bg: #0a0b0d; --surface: #0f1115; --chip: #15181e; --text: #eceef1; --text-2: #b9bdc6; --muted: #8b909a; --dim: #5d626c;
    --line: rgba(255,255,255,0.06); --line-2: rgba(255,255,255,0.1);
    --accent: oklch(0.74 0.19 258); --accent-soft: oklch(0.74 0.19 258 / 0.14); --accent-tag: oklch(0.86 0.1 258);
    --success: oklch(0.8 0.16 155); --error: oklch(0.7 0.19 25); --warning: oklch(0.84 0.14 80); --ice: oklch(0.9 0.05 230);
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: "Geist", system-ui, -apple-system, sans-serif;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; background: transparent; }
  body { font: 14px/1.45 var(--sans); color: var(--text); padding: 2px; }
  .panel { background: var(--bg); border: 1px solid var(--line-2); border-radius: 18px; padding: 18px; max-width: 600px; }
  .row { display: flex; gap: 18px; align-items: stretch; flex-wrap: wrap; }

  /* the card face, as on the home page */
  .card {
    position: relative; width: 100%; max-width: 300px; aspect-ratio: 1.586; flex: 1 1 260px;
    border-radius: 18px; overflow: hidden; padding: 18px 20px;
    background: linear-gradient(140deg, #1d212b 0%, #111318 55%, #0b0c10 100%);
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 30px 60px -24px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.08);
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .card::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: radial-gradient(90% 70% at 100% 0%, oklch(0.74 0.19 258 / 0.24), transparent 60%); pointer-events: none; }
  .card > * { position: relative; }
  .card .sheen { position: absolute; inset: 0; background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.07) 50%, transparent 60%); background-size: 250% 100%; background-position: 120% 0; animation: sheen 2.4s 0.2s cubic-bezier(.2,.8,.2,1) both; pointer-events: none; }
  @keyframes sheen { to { background-position: -40% 0; } }
  @media (prefers-reduced-motion: reduce) { .card .sheen { animation: none; } }
  .card.frozen { filter: saturate(0.4); }
  .card.frozen::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(160deg, oklch(0.9 0.05 230 / 0.18), oklch(0.9 0.05 230 / 0.04)); border: 1px solid oklch(0.9 0.05 230 / 0.35); pointer-events: none; }
  .card-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .wordmark { font-weight: 600; letter-spacing: -0.02em; display: inline-flex; align-items: center; font-size: 15px; }
  .mark { width: 1.2em; height: 1.2em; margin-right: 0.42em; flex: none; }
  .kind { font: 500 9.5px var(--mono); letter-spacing: 0.13em; color: var(--muted); white-space: nowrap; }
  .kind.frozen { color: var(--ice); }
  .chip { width: 38px; height: 28px; border-radius: 6px; background: linear-gradient(135deg, #3b404b, #22252c); border: 1px solid rgba(255,255,255,0.13); }
  .card-bottom { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .num { font: 12.5px var(--mono); letter-spacing: 0.15em; color: var(--muted); }
  .name { font: 500 15px var(--mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stamp { position: absolute !important; right: 18px; top: 44%; font: 600 11px var(--mono); letter-spacing: 0.12em; color: var(--ice); border: 1px solid oklch(0.9 0.05 230 / 0.6); border-radius: 6px; padding: 3px 7px; transform: rotate(-6deg); }

  /* policy beside the card */
  .side { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .status { display: inline-flex; align-items: center; gap: 7px; font: 500 11px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--success); }
  .status .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
  .status.frozen { color: var(--ice); }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { padding: 4px 8px; border-radius: 6px; border: 1px solid oklch(0.74 0.19 258 / 0.5); background: var(--accent-soft); color: var(--accent-tag); white-space: nowrap; font: 10.5px var(--mono); }
  .tag.plain { border-color: var(--line-2); background: var(--chip); color: var(--text-2); }
  .pending { font-size: 12.5px; color: var(--warning); }
  .records { margin-top: 16px; border: 1px solid var(--line-2); border-radius: 12px; overflow: hidden; font: 12px var(--mono); }
  .records-head { display: flex; justify-content: space-between; padding: 8px 12px; background: var(--surface); color: var(--muted); font-size: 10.5px; letter-spacing: 0.08em; border-bottom: 1px solid var(--line); }
  .rec { display: flex; justify-content: space-between; gap: 12px; padding: 7px 12px; border-top: 1px solid var(--line); }
  .rec:first-of-type { border-top: 0; }
  .rec span:first-child { color: var(--muted); }
  .rec span:last-child { color: var(--text); text-align: right; overflow-wrap: anywhere; }

  /* several cards */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .grid .card { max-width: none; padding: 15px 17px; }
  .grid .tags { margin-top: 8px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
  .head h2 { font: 600 16px var(--sans); margin: 0; letter-spacing: -0.01em; }
  .head .count { font: 11px var(--mono); color: var(--muted); }

  /* transactions */
  .tx { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 10px 0; border-top: 1px solid var(--line); }
  .tx:first-of-type { border-top: 0; }
  .tx .m { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tx .a { font: 500 14px var(--sans); text-align: right; }
  .tx .s { font: 11px var(--mono); color: var(--muted); }
  .tx .p { font: 500 10.5px var(--mono); letter-spacing: 0.06em; text-align: right; }
  .ok { color: var(--success); } .no { color: var(--error); }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 0; }

  /* Visa TAP signature */
  .tap-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .tap-kind { font: 600 17px var(--sans); letter-spacing: -0.01em; }
  .tap-sub { color: var(--muted); font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; }
  .badge { font: 500 10.5px var(--mono); letter-spacing: 0.08em; padding: 4px 8px; border-radius: 6px; white-space: nowrap; border: 1px solid oklch(0.74 0.19 258 / 0.5); background: var(--accent-soft); color: var(--accent-tag); }
  .badge.pay { border-color: oklch(0.8 0.16 155 / 0.5); background: oklch(0.8 0.16 155 / 0.1); color: var(--success); }
  .hdr { margin-top: 10px; }
  .hdr .k { font: 500 10.5px var(--mono); letter-spacing: 0.06em; color: var(--muted); margin-bottom: 4px; }
  .hdr pre { margin: 0; padding: 9px 11px; background: var(--surface); border: 1px solid var(--line-2); border-radius: 10px; font: 11px/1.5 var(--mono); color: var(--text-2); white-space: pre-wrap; word-break: break-all; max-height: 92px; overflow: auto; }
  .ttl { font: 500 12px var(--mono); color: var(--text-2); }
  .ttl.gone { color: var(--error); }
  .foot { margin-top: 12px; color: var(--muted); font-size: 12px; }
  .err { color: var(--error); font-size: 13px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(() => {
  "use strict";
  const MCC = ${JSON.stringify(MCC_NAMES)};
  const MARK = ${JSON.stringify(MARK)};
  const root = document.getElementById("root");

  // ---------- host bridge ----------
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
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    } else if (m.id !== undefined && m.method) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
    }
  });
  new ResizeObserver(() => {
    const r = document.documentElement.getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }).observe(document.documentElement);
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "X Card", version: "1.0.0" }, appCapabilities: {} })
    .catch(() => {})
    .finally(() => notify("ui/notifications/initialized", {}));

  // ---------- helpers ----------
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else n.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  };
  const usd = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const short = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a || "") ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
  const mccName = (c) => MCC[c] || "MCC " + c;
  const listOf = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

  // One shape for get_card's records and list_cards' summary rows.
  const norm = (c) => {
    const r = c.records || {};
    return {
      name: c.name, status: c.status || r["card.status"] || "active", last4: c.last4,
      tx: c.limit_tx ?? r["card.limit.tx"], daily: c.limit_daily ?? r["card.limit.daily"], monthly: c.limit_monthly ?? r["card.limit.monthly"],
      currencies: c.currencies ?? r["card.currencies"], mcc: c.mcc_allow ?? r["card.mcc.allow"], payee: c.payee ?? r["card.payee"],
      approver: c.approver ?? r["card.approver"],
      pending: Array.isArray(c.pending_approvals) ? c.pending_approvals.length : c.pending_approvals || 0,
      records: c.records,
    };
  };

  function face(c, big) {
    const frozen = c.status === "frozen";
    const mark = el("span"); mark.innerHTML = MARK;
    return el("div", { class: "card" + (frozen ? " frozen" : "") },
      el("div", { class: "sheen" }),
      el("div", { class: "card-top" },
        el("div", { class: "wordmark" }, mark.firstChild, "X Card"),
        el("div", { class: "kind" + (frozen ? " frozen" : ""), text: frozen ? "FROZEN" : "AGENT · VIRTUAL" })),
      el("div", { class: "chip" }),
      el("div", { class: "card-bottom" },
        el("div", { class: "num", text: big ? "•••• •••• •••• " + (c.last4 || "••••") : "•••• " + (c.last4 || "••••") }),
        el("div", { class: "name", text: c.name })),
      frozen ? el("div", { class: "stamp", text: "FROZEN" }) : null);
  }

  function tags(c) {
    const t = [];
    if (c.tx) t.push(el("span", { class: "tag", text: "tx ≤ " + usd(c.tx) }));
    if (c.daily) t.push(el("span", { class: "tag", text: "day ≤ " + usd(c.daily) }));
    if (c.monthly) t.push(el("span", { class: "tag", text: "month ≤ " + usd(c.monthly) }));
    const m = listOf(c.mcc);
    t.push(el("span", { class: "tag plain", text: m.length ? m.map(mccName).join(" · ") : "any category" }));
    if (c.payee && c.payee !== "any") t.push(el("span", { class: "tag plain", text: c.payee === "verified-only" ? "verified payees only" : "unverified payee → ask" }));
    return el("div", { class: "tags" }, ...t);
  }

  function status(c) {
    const frozen = c.status === "frozen";
    return el("div", { class: "status" + (frozen ? " frozen" : "") }, el("span", { class: "dot" }), frozen ? "Frozen · only a human can unfreeze" : "Active");
  }

  function one(raw) {
    const c = norm(raw);
    const r = c.records || {};
    const keys = ["card.limit.tx", "card.limit.daily", "card.limit.monthly", "card.currencies", "card.mcc.allow", "card.payee", "card.payee.allow", "card.approver", "card.status"];
    const shown = (k, v) => (k === "card.approver" ? short(v) : v ? v : k === "card.limit.daily" ? "none" : k.endsWith("allow") ? "any" : "—");
    root.textContent = "";
    root.append(el("div", { class: "panel" },
      el("div", { class: "row" }, face(c, true),
        el("div", { class: "side" }, status(c), tags(c),
          el("div", { class: "rec", style: "padding:0;border:0" }, el("span", { text: "approver" }), el("span", { text: short(c.approver) })),
          c.pending ? el("div", { class: "pending", text: c.pending + " request" + (c.pending > 1 ? "s" : "") + " waiting for approval" }) : null)),
      el("div", { class: "records" },
        el("div", { class: "records-head" }, el("span", { text: c.name }), el("span", { text: "ENS TEXT" })),
        ...keys.filter((k) => k in r).map((k) => el("div", { class: "rec" }, el("span", { text: k }), el("span", { text: shown(k, r[k]) }))))));
  }

  function many(list) {
    root.textContent = "";
    const cards = list.map(norm);
    root.append(el("div", { class: "panel" },
      el("div", { class: "head" }, el("h2", { text: "Your cards" }), el("span", { class: "count", text: cards.length + " card" + (cards.length === 1 ? "" : "s") })),
      cards.length
        ? el("div", { class: "grid" }, ...cards.map((c) => el("div", {}, face(c, false), tags(c))))
        : el("div", { class: "empty", text: "No cards on this connection yet. Ask to issue one." })));
  }

  function txs(list) {
    root.textContent = "";
    const rows = list.map((t) => {
      const ok = t.settled || (t.status === "APPROVED" && !t.decline_reason);
      return el("div", { class: "tx" },
        el("div", { class: "m", text: t.merchant || "Merchant" }),
        el("div", { class: "a", text: usd(t.amount) + " " + (t.currency || "") }),
        el("div", { class: "s", text: [t.type, t.mcc && mccName(t.mcc), t.at && new Date(t.at).toLocaleString()].filter(Boolean).join(" · ") }),
        el("div", { class: "p " + (ok ? "ok" : "no"), text: t.decline_reason || (t.settled ? "SETTLED" : t.status) }));
    });
    root.append(el("div", { class: "panel" },
      el("div", { class: "head" }, el("h2", { text: "Transactions" }), el("span", { class: "count", text: list.length ? list.length + " recent" : "" })),
      rows.length ? el("div", {}, ...rows) : el("div", { class: "empty", text: "No transactions yet." })));
  }

  let ttlTimer;
  function tap(sc) {
    clearInterval(ttlTimer);
    const pay = sc.tag === "agent-payer-auth";
    let origin = sc.url;
    try { origin = new URL(sc.url).host; } catch {}
    const ttl = el("span", { class: "ttl" });
    const exp = Date.parse(sc.expires_at);
    const tick = () => {
      const s = Math.max(0, Math.round((exp - Date.now()) / 1000));
      ttl.textContent = s ? "valid " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " · one use" : "expired";
      ttl.className = "ttl" + (s ? "" : " gone");
      if (!s) clearInterval(ttlTimer);
    };
    tick(); if (exp) ttlTimer = setInterval(tick, 1000);
    const h = sc.headers || {};
    root.textContent = "";
    root.append(el("div", { class: "panel" },
      el("div", { class: "tap-top" },
        el("div", { style: "min-width:0" },
          el("div", { class: "tap-kind", text: pay ? "Checkout signature" : "Browsing signature" }),
          el("div", { class: "tap-sub", text: "Visa Trusted Agent Protocol · " + origin })),
        el("span", { class: "badge" + (pay ? " pay" : ""), text: sc.tag || "" })),
      el("div", { class: "row", style: "margin-top:14px;gap:10px;align-items:center;justify-content:space-between" },
        el("div", { class: "rec", style: "padding:0;border:0;gap:10px" }, el("span", { text: "key" }), el("span", { text: (sc.keyid || "").slice(0, 16) + "…" })),
        ttl),
      el("div", { class: "hdr" }, el("div", { class: "k", text: "Signature-Input" }), el("pre", { text: h["Signature-Input"] || "" })),
      el("div", { class: "hdr" }, el("div", { class: "k", text: "Signature" }), el("pre", { text: h.Signature || "" })),
      el("div", { class: "foot", text: (pay ? "Proves to the merchant that this agent is paying with an approved X Card. " : "Proves to the merchant that this is a known agent, not a bot. ") + "Ed25519 (RFC 9421); the merchant checks it against " + (sc.keys_url || "the published key") + "." })));
  }

  function onResult(res) {
    const sc = res.structuredContent || {};
    if (res.isError || sc.error) {
      root.textContent = "";
      root.append(el("div", { class: "panel" }, el("div", { class: "err", text: (sc.error && sc.error.message) || "Something went wrong." })));
      return;
    }
    if (Array.isArray(sc.cards)) return many(sc.cards);
    if (sc.card) return one(sc.card);
    if (Array.isArray(sc.transactions)) return txs(sc.transactions);
    if (sc.headers && sc.tag) return tap(sc);
  }
})();
</script>
</body>
</html>
`;
