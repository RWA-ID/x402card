// The CSV preview: an MCP App for issue_cards. The tool's first result carries
// every row and whether it can be issued; the person confirms here, which calls
// issue_cards through the host (submit: true). Then this polls, and each poll
// issues a few more rows.
import { UI_MIME } from "./approval.ts";

const FONTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

export function batchResource() {
  return { uri: "ui://xcard/batch.html", mimeType: UI_MIME, text: HTML, _meta: { ui: { csp: { resourceDomains: FONTS }, prefersBorder: false } } };
}

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issue X Cards from a CSV</title>
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
  .card { max-width: 720px; }
  .sum { display: flex; flex-wrap: wrap; gap: 6px 16px; font: 500 12.5px var(--mono); color: var(--text-2); margin: 0 0 12px; }
  .sum b { font-weight: 500; color: var(--text); }
  .scroll { max-height: 340px; overflow: auto; border: 1px solid var(--line); border-radius: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { position: sticky; top: 0; background: var(--chip); text-align: left; font: 500 11px var(--mono); text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 8px 10px; white-space: nowrap; }
  td { padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; color: var(--text-2); overflow-wrap: anywhere; }
  td.nm { font-family: var(--mono); color: var(--text); }
  tr.bad td { color: var(--error); }
  .st-issued { color: var(--success); } .st-failed { color: var(--error); }
  button.go:disabled { opacity: 0.5; cursor: default; }
  .note { color: var(--muted); font-size: 12.5px; margin: 10px 0 0; }
</style>
</head>
<body>
<div class="card" id="root"><div class="note">Loading…</div></div>
<script>
(() => {
  "use strict";
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

  let told = false;
  function onResult(res) {
    const sc = res.structuredContent || {};
    if (sc.batch_id) return draw(sc);
    root.textContent = "";
    root.append(el("div", { class: "top" }, brand(), el("span", { class: "pill no", text: "Not read" })), el("div", { class: "note", text: (sc.error && sc.error.message) || (res.content && res.content[0] && res.content[0].text) || "Couldn't read that CSV." }));
  }

  const call = async (args) => {
    const r = await request("tools/call", { name: "issue_cards", arguments: args }, 60000);
    const sc = (r && r.structuredContent) || {};
    if (r && r.isError || !sc.batch_id) throw new Error((sc.error && sc.error.message) || "that didn't work");
    return sc;
  };

  function draw(b, problem) {
    const t = b.totals, preview = b.status === "preview", running = b.status === "running";
    const go = el("button", { class: "go", type: "button", text: "Issue " + t.pending + " card" + (t.pending === 1 ? "" : "s") + " and email the claim links" });
    if (!t.pending) go.disabled = true;
    go.addEventListener("click", async () => {
      go.disabled = true; go.textContent = "Starting…";
      try { const n = await call({ batch_id: b.batch_id, submit: true }); draw(n); }
      catch (ex) { draw(b, ex.message); }
    });
    const sum = el("p", { class: "sum" },
      ...(preview
        ? [el("span", {}, el("b", { text: String(t.pending) }), " ready"), el("span", {}, el("b", { text: String(t.invalid) }), " with errors, skipped")]
        : [el("span", {}, el("b", { text: t.issued + " of " + (t.rows - t.invalid) }), " issued"), t.failed ? el("span", {}, el("b", { text: String(t.failed) }), " failed") : null, t.emails_unsent ? el("span", {}, el("b", { text: String(t.emails_unsent) }), " emails not sent") : null]));
    const rows = b.rows.map((r) => el("tr", { class: r.status === "invalid" || r.status === "failed" ? "bad" : "" },
      el("td", { class: "nm", text: r.name }),
      el("td", { text: r.holder }),
      el("td", { text: r.error || ("$" + r.limit_tx + " / " + (r.limit_daily ? "$" + r.limit_daily : "–") + " / $" + r.limit_monthly) }),
      el("td", { class: "st-" + r.status, text: r.status === "pending" ? (preview ? "ready" : "…") : r.status })));
    root.textContent = "";
    root.append(
      el("div", { class: "top" }, brand(), el("span", { class: "pill" + (b.status === "done" ? " ok" : ""), text: preview ? "Preview" : running ? "Issuing" : "Done" })),
      el("h2", { text: preview ? "Nothing is issued yet" : running ? "Issuing cards" : "Cards issued" }),
      el("p", { class: "sub", text: "Under " + b.parent + ". Each holder gets a one-time link by email, and only they get the agent token." }),
      sum,
      el("div", { class: "scroll" }, el("table", {}, el("thead", {}, el("tr", {}, ...["Name", "Holder", "Tx / day / month", "Status"].map((h) => el("th", { text: h })))), el("tbody", {}, ...rows))),
      ...(preview ? [el("div", { class: "actions" }, go)] : []),
      ...(problem ? [el("div", { class: "err", text: problem })] : []));
    if (running) setTimeout(() => call({ batch_id: b.batch_id }).then(draw, () => setTimeout(() => draw(b), 4000)), 1500);
    if (b.status === "done" && !told) {
      told = true;
      tell("I issued " + t.issued + " cards under " + b.parent + " from the CSV" + (t.failed ? "; " + t.failed + " failed" : "") + (t.invalid ? "; " + t.invalid + " rows had errors and were skipped" : "") + ".");
    }
  }
})();
</script>
</body>
</html>
`;
