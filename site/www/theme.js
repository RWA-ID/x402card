// Dark by default; ivory is opt-in and remembered. Loaded in <head>, before the
// styles, so a page never flashes the wrong theme.
(() => {
  const KEY = "xcard.theme";
  const root = document.documentElement;
  const BG = { dark: "#0a0b0d", light: "#fbf8ef" };
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const apply = (t) => {
    if (t === "light") root.dataset.theme = "light"; else delete root.dataset.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BG[t]);
  };
  const now = () => (root.dataset.theme === "light" ? "light" : "dark");
  apply(saved() === "light" ? "light" : "dark");

  const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';

  document.addEventListener("DOMContentLoaded", () => {
    const links = document.querySelector(".nav .nav-links");
    if (!links) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "theme-toggle";
    const paint = () => {
      const next = now() === "light" ? "dark" : "ivory";
      b.innerHTML = now() === "light" ? MOON : SUN;
      b.setAttribute("aria-label", `Switch to the ${next} theme`);
      b.title = `Switch to the ${next} theme`;
    };
    b.addEventListener("click", () => {
      const t = now() === "light" ? "dark" : "light";
      apply(t);
      try { localStorage.setItem(KEY, t); } catch { /* private mode: this page only */ }
      paint();
    });
    paint();
    links.prepend(b);
  });
  // Another tab changed it.
  addEventListener("storage", (e) => { if (e.key === KEY) location.reload(); });
})();
