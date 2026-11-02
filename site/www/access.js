// The home page's request forms: a company's access, a merchant's verified name.
// Sends with fetch only; the buttons aren't submit buttons, so a click before
// this script loads does nothing rather than posting the page to itself.
(() => {
  const API = window.XCardAuth?.API || "https://api.x-card.dev";
  const slugOf = (s) => s.toLowerCase().trim().replace(/\.xcard\.eth$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

  for (const form of document.querySelectorAll("form[data-access]")) {
    const kind = form.dataset.access;
    const f = (n) => form.elements[n];
    const preview = form.querySelector("[data-slug-preview]");
    const status = form.querySelector("[data-status]");
    const button = form.querySelector("[data-send]");
    let edited = false;

    const show = () => { preview.textContent = (f("slug").value.trim() ? slugOf(f("slug").value) : kind === "org" ? "yourcompany" : "yourshop"); };
    f("slug").addEventListener("input", () => { edited = true; show(); });
    f("company").addEventListener("input", () => { if (!edited) { f("slug").value = slugOf(f("company").value); show(); } });
    form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
    button.addEventListener("click", send);

    async function send() {
      if (button.disabled) return;
      if (!form.reportValidity()) return;
      f("slug").value = slugOf(f("slug").value);
      show();
      button.disabled = true;
      status.className = "access-status";
      status.textContent = "Sending…";
      try {
        const body = { kind, slug: f("slug").value, company: f("company").value, email: f("email").value, note: f("note").value, url: f("url").value };
        if (f("cards")) body.cards = f("cards").value;
        if (f("origins")) body.origins = f("origins").value;
        const r = await fetch(`${API}/public/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error?.message || "That didn't go through. Try again, or write to hello@x-card.dev.");
        const done = document.createElement("div");
        done.className = "access-done";
        const h = document.createElement("h3");
        h.textContent = "Request received";
        const p = document.createElement("p");
        p.textContent = `${d.name ?? f("slug").value + ".xcard.eth"} is held for 30 days. A person reads every request, and we'll reply to ${f("email").value}.`;
        done.append(h, p);
        form.replaceChildren(done);
      } catch (e) {
        status.className = "access-status bad";
        status.textContent = e instanceof TypeError ? "Couldn't reach X Card. Try again, or write to hello@x-card.dev." : e.message;
        button.disabled = false;
      }
    }
  }
})();
