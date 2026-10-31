// claim.html#clm_…: a holder claims the card a company issued them. Reading the
// link is public; claiming takes an email session for the address it was issued
// to, so a forwarded link can't claim it. The agent token is shown once, here.
(() => {
  "use strict";
  const Auth = window.XCardAuth;
  const API = Auth.API;
  const MCP_URL = API.replace("://api.", "://mcp.") + "/mcp";
  const box = document.querySelector("[data-claim]");
  const token = location.hash.slice(1);

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }
  const show = (...nodes) => { box.textContent = ""; box.append(...nodes); };
  const empty = (text) => show(el("div", { class: "empty", text }));
  const usd = (n, cur) => `${Number(n).toLocaleString("en-US")} ${cur}`;

  async function load() {
    try {
      const r = await fetch(`${API}/claims/${encodeURIComponent(token)}`);
      const v = await r.json().catch(() => ({}));
      if (!r.ok) return empty(v?.error?.message || "This claim link isn't valid.");
      offer(v);
    } catch (e) {
      empty("Couldn't load the card: " + e.message);
    }
  }

  function offer(v) {
    const cur = (v.currencies || "USD").split(",")[0];
    const err = el("p", { class: "claim-err", role: "alert" });
    const go = el("button", { class: "btn-primary", type: "button", text: "Sign in and claim", onclick: () => claim(v, go, err) });
    show(el("section", { class: "claim" },
      el("p", { text: `${v.org} issued you` }),
      el("div", { class: "claim-name", text: v.card }),
      el("div", { class: "kv" },
        el("span", { text: "per transaction" }), el("span", { text: usd(v.limit_tx, cur) }),
        v.limit_daily ? el("span", { text: "per day" }) : null, v.limit_daily ? el("span", { text: usd(v.limit_daily, cur) }) : null,
        el("span", { text: "per month" }), el("span", { text: usd(v.limit_monthly, cur) }),
        el("span", { text: "issued to" }), el("span", { text: v.holder }),
        el("span", { text: "link expires" }), el("span", { text: new Date(v.expiresAt).toLocaleDateString() })),
      el("div", { class: "claim-actions" }, go),
      err));
  }

  async function claim(v, go, err, again) {
    err.textContent = "";
    const s = (!again && Auth.session()) || await Auth.open({ title: "Claim your card", sub: "Sign in with the address this card was issued to. We'll send a 6-digit code.", hint: `Issued to ${v.holder}` });
    if (!s) return;
    go.disabled = true; go.textContent = "Claiming…";
    try {
      const r = await fetch(`${API}/claims/${encodeURIComponent(token)}`, { method: "POST", headers: { Authorization: "Bearer " + s.token } });
      const b = await r.json().catch(() => ({}));
      if (r.status === 401) return claim(v, go, err, true);
      if (!r.ok) {
        err.textContent = b?.error?.message || `HTTP ${r.status}`;
        go.disabled = false; go.textContent = "Sign in and claim";
        // Signed in as someone else: the next try asks for the right address.
        if (r.status === 403) { Auth.forget(); go.textContent = "Use another address"; }
        return;
      }
      history.replaceState(null, "", location.pathname);
      claimed(b);
    } catch (e) {
      go.disabled = false; go.textContent = "Sign in and claim";
      err.textContent = e.message;
    }
  }

  // The agent token, shown once: masked until revealed (the page is often on a shared screen).
  function claimed(b) {
    const t = b.agent_token, name = b.card.name;
    const masked = t.slice(0, 8) + "•".repeat(16);
    const shown = el("div", { class: "claim-token", text: masked });
    const copy = (btn, text) => navigator.clipboard.writeText(text).then(() => { btn.textContent = "Copied"; }, () => { shown.textContent = text; reveal.textContent = "Hide"; btn.textContent = "Select the text above"; });
    const reveal = el("button", { class: "btn-xs", type: "button", text: "Reveal", onclick: () => {
      const hide = shown.textContent !== masked;
      shown.textContent = hide ? masked : t;
      reveal.textContent = hide ? "Reveal" : "Hide";
    } });
    const copyToken = el("button", { class: "btn-xs", type: "button", text: "Copy token", onclick: () => copy(copyToken, t) });
    const copyLine = el("button", { class: "btn-xs", type: "button", text: "Copy claude mcp add", onclick: () => copy(copyLine, `claude mcp add --transport http ${name.split(".")[0]} ${MCP_URL} --header "Authorization: Bearer ${t}"`) });
    show(el("section", { class: "claim" },
      el("div", { class: "claim-name", text: name }),
      el("p", { text: "It's yours. Give this token to the agent that runs on its own: it works for this card only, under this policy. It's shown once." }),
      shown,
      el("div", { class: "claim-actions" }, reveal, copyToken, copyLine),
      el("p", {}, "Using an AI app instead? Connect ", el("span", { class: "mono", text: MCP_URL }), " and sign in with this email. ", el("a", { href: "console.html", text: "See it on the console." }))));
  }

  if (/^clm_/.test(token)) load();
  else empty("This claim link isn't valid. Open it from your email.");
})();
