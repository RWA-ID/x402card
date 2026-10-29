// X Card email sign-in: a modal that asks for an email, mails a 6-digit code
// (from login@x-card.dev) and trades it for a session token. Shared by the
// home page (create a demo account), the console and the approval page.
// The session lives in localStorage, so an approval link opened from the
// inbox finds you signed in.
// ?api=http://127.0.0.1:8787 points it at a local Worker.
(() => {
  "use strict";

  const API = new URLSearchParams(location.search).get("api") || "https://api.x-card.dev";
  const KEY = "xcard.session";
  const RESEND_S = 30;

  const read = () => { try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); return s && s.token && s.email ? s : null; } catch { return null; } };
  const write = (s) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

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

  async function post(path, body, token) {
    const r = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body || {}),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b?.error?.message || b?.error || `HTTP ${r.status}`);
    return b;
  }

  let openDialog = null;

  /**
   * Opens the sign-in modal. Resolves with {token, email} once signed in, or
   * null if the person closes it.
   * o.title, o.sub: the copy; o.hint: shown under the email field.
   */
  function open(o = {}) {
    if (openDialog) openDialog.close();
    return new Promise((resolve) => {
      let email = "", done = false, timer;
      const dlg = el("dialog", { class: "auth", "aria-labelledby": "auth-title" });
      const close = (v) => { if (done) return; done = true; clearInterval(timer); dlg.close(); dlg.remove(); openDialog = null; resolve(v); };

      const title = el("h2", { id: "auth-title", text: o.title || "Create a demo account" });
      const sub = el("p", { class: "auth-sub", text: o.sub || "Enter your email. We'll send a 6-digit code: no password, no wallet." });
      const err = el("div", { class: "err", role: "alert" });

      // Step 1: email.
      const emailIn = el("input", { type: "email", autocomplete: "email", inputmode: "email", spellcheck: "false", autocapitalize: "off", placeholder: "you@company.com", "aria-label": "Email", required: "" });
      const sendBtn = el("button", { class: "btn-primary auth-go", type: "submit", text: "Email me a code" });
      const step1 = el("form", { class: "auth-step", novalidate: "" },
        el("label", { class: "auth-field" }, el("span", { text: "Email" }), emailIn),
        o.hint ? el("p", { class: "auth-hint", text: o.hint }) : null,
        sendBtn);

      // Step 2: the code.
      const codeIn = el("input", { class: "auth-code", autocomplete: "one-time-code", inputmode: "numeric", pattern: "[0-9]*", maxlength: "7", placeholder: "000000", "aria-label": "6-digit code" });
      const verifyBtn = el("button", { class: "btn-primary auth-go", type: "submit", text: "Sign in" });
      const sentTo = el("span", { class: "mono" });
      const resend = el("button", { class: "auth-link", type: "button", text: "Resend code" });
      const change = el("button", { class: "auth-link", type: "button", text: "Use another email" });
      const step2 = el("form", { class: "auth-step", novalidate: "", hidden: "" },
        el("p", { class: "auth-sent" }, "Code sent to ", sentTo, ". Check your inbox (and spam)."),
        el("label", { class: "auth-field" }, el("span", { text: "6-digit code" }), codeIn),
        verifyBtn,
        el("div", { class: "auth-links" }, resend, change));

      const x = el("button", { class: "auth-x", type: "button", "aria-label": "Close", text: "×", onclick: () => close(null) });
      dlg.append(
        el("div", { class: "auth-head" }, el("div", { class: "wordmark" }, el("img", { class: "mark", src: "brand/xcard-mark.svg", alt: "", width: "48", height: "48" }), "X Card"), el("div", { class: "pill-sandbox", text: "SANDBOX" }), x),
        title, sub, step1, step2, err,
        el("p", { class: "auth-fine", text: "Sandbox demo, no real money. We use your email only to sign you in and to send approval requests for cards you approve." }));
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
      dlg.addEventListener("click", (e) => { if (e.target === dlg) close(null); });
      document.body.append(dlg);
      dlg.showModal();
      openDialog = { close: () => close(null) };
      emailIn.focus();

      const countdown = () => {
        let left = RESEND_S;
        resend.disabled = true; resend.textContent = `Resend code in ${left}s`;
        clearInterval(timer);
        timer = setInterval(() => {
          left--;
          if (left > 0) { resend.textContent = `Resend code in ${left}s`; return; }
          clearInterval(timer); resend.disabled = false; resend.textContent = "Resend code";
        }, 1000);
      };
      const send = async () => {
        err.textContent = "";
        const r = await post("/auth/email/start", { email });
        // Local dev only: the Worker has no mailer and hands the code back.
        if (r.dev_code) { codeIn.value = r.dev_code; console.info("[xcard] dev sign-in code", r.dev_code); }
        countdown();
      };

      step1.addEventListener("submit", async (e) => {
        e.preventDefault();
        email = emailIn.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { err.textContent = "Enter a valid email address."; emailIn.focus(); return; }
        sendBtn.disabled = true; sendBtn.textContent = "Sending…";
        try {
          await send();
          sentTo.textContent = email;
          step1.hidden = true; step2.hidden = false;
          title.textContent = "Check your email";
          sub.textContent = "Enter the code from the X Card email. It works once, for 10 minutes.";
          codeIn.focus();
        } catch (ex) { err.textContent = ex.message; }
        finally { sendBtn.disabled = false; sendBtn.textContent = "Email me a code"; }
      });

      const verify = async () => {
        const code = codeIn.value.replace(/\D/g, "");
        if (code.length !== 6) { err.textContent = "The code is 6 digits."; return; }
        verifyBtn.disabled = true; verifyBtn.textContent = "Checking…"; err.textContent = "";
        try {
          const s = await post("/auth/email/verify", { email, code });
          write({ token: s.token, email: s.email });
          verifyBtn.textContent = "Signed in ✓";
          setTimeout(() => close({ token: s.token, email: s.email }), 350);
        } catch (ex) {
          err.textContent = ex.message; verifyBtn.disabled = false; verifyBtn.textContent = "Sign in";
          codeIn.select();
        }
      };
      step2.addEventListener("submit", (e) => { e.preventDefault(); verify(); });
      // Typed or autofilled all six digits: go.
      codeIn.addEventListener("input", () => {
        const d = codeIn.value.replace(/\D/g, "").slice(0, 6);
        codeIn.value = d.length > 3 ? d.slice(0, 3) + " " + d.slice(3) : d;
        if (d.length === 6 && !verifyBtn.disabled) verify();
      });
      resend.addEventListener("click", async () => { try { await send(); } catch (ex) { err.textContent = ex.message; } });
      change.addEventListener("click", () => {
        clearInterval(timer); step2.hidden = true; step1.hidden = false; codeIn.value = ""; err.textContent = "";
        title.textContent = o.title || "Create a demo account"; sub.textContent = o.sub || "Enter your email. We'll send a 6-digit code: no password, no wallet.";
        emailIn.focus();
      });
    });
  }

  async function signOut() {
    const s = read();
    write(null);
    if (s) { try { await post("/auth/signout", {}, s.token); } catch { /* the session expires anyway */ } }
  }

  window.XCardAuth = { API, session: read, open, signOut, forget: () => write(null) };
})();
