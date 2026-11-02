// A hint for the person reviewing an access request: does the email look like
// it belongs to the name asked for? Never approves anything by itself. The
// email is only typed into a form here; it's proven when its owner signs in.

export interface DomainCheck {
  result: "match" | "mismatch" | "free_email";
  detail: string;
}

const FREE_EMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "aol.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "fastmail.com", "tutanota.com", "hey.com",
]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** "mail.acme.co.uk" -> "acme.co.uk", "google.evil.com" -> "evil.com". Close enough for a hint. */
export function siteOf(host: string): string {
  const l = host.toLowerCase().split(".");
  const n = l.length >= 3 && l[l.length - 1].length === 2 && SECOND_LEVEL.has(l[l.length - 2]) ? 3 : 2;
  return l.slice(-n).join(".");
}

const squash = (s: string) => s.toLowerCase().replace(/-/g, "");

export function domainCheck(r: { kind: "org" | "merchant"; slug: string; email: string; origins?: string[] }): DomainCheck {
  const domain = r.email.split("@")[1]?.toLowerCase() ?? "";
  if (FREE_EMAIL.has(domain)) return { result: "free_email", detail: `${domain} is a free email provider, so it says nothing about ${r.slug}.` };
  const site = siteOf(domain);
  const nameOk = squash(site.split(".")[0]) === squash(r.slug);
  const foreign = (r.origins ?? []).map((o) => new URL(o).hostname).filter((h) => siteOf(h) !== site);
  if (nameOk && !foreign.length) return { result: "match", detail: `${domain} matches ${r.slug}${r.origins ? " and every origin" : ""}.` };
  const why = [!nameOk && `${domain} doesn't match the name ${r.slug}`, foreign.length && `not on ${site}: ${foreign.join(", ")}`].filter(Boolean);
  return { result: "mismatch", detail: `${why.join("; ")}.` };
}
