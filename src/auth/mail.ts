// Branded X Card email, sent through Resend from x-card.dev: sign-in codes
// and approval requests for approvers named by email.
//
// Email clients are a decade behind browsers: tables for layout, inline
// styles, no web fonts, no gradients without a solid fallback, and a PNG logo
// (SVG doesn't render in Gmail or Outlook).

const SITE = "https://x-card.dev";
const LOGO = `${SITE}/brand/app-icon-180.png`;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Sends one email; throws when Resend refuses it. */
export type Mailer = (m: Mail & { from: string }) => Promise<void>;

export function resendMailer(apiKey: string): Mailer {
  return async (m) => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
}

export const FROM_LOGIN = "X Card <login@x-card.dev>";
export const FROM_APPROVALS = "X Card <approvals@x-card.dev>";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The frame every X Card email shares: logo row, a dark panel, a footer. */
function frame(preheader: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>X Card</title></head>
<body style="margin:0;padding:0;background:#0a0b0d;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0a0b0d;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0b0d" style="background:#0a0b0d;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td style="padding:0 4px 24px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle;"><img src="${LOGO}" width="28" height="28" alt="" style="display:block;border:0;border-radius:7px;"></td>
    <td style="vertical-align:middle;padding-left:10px;font-family:${SANS};font-size:17px;font-weight:600;letter-spacing:-0.02em;color:#eceef1;">X Card</td>
    <td style="vertical-align:middle;padding-left:10px;"><span style="font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#8b909a;border:1px solid #2a2d33;border-radius:999px;padding:2px 7px;">SANDBOX</span></td>
  </tr></table>
</td></tr>
<tr><td bgcolor="#0f1115" style="background:#0f1115;border:1px solid #1d2026;border-radius:20px;padding:32px 28px;">
${inner}
</td></tr>
<tr><td style="padding:22px 4px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:#5d626c;">
  X Card gives every card a name and a policy. Sandbox demo, no real money.<br>
  <a href="${SITE}" style="color:#8b909a;text-decoration:none;">x-card.dev</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

/** A small card face, like the site's: wordmark, chip, name. */
function cardFace(name: string, last4: string | undefined, kind = "VIRTUAL"): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#15181e" style="background:#15181e;background-image:linear-gradient(140deg,#1d212b 0%,#111318 55%,#0b0c10 100%);border:1px solid #2a2d33;border-radius:16px;">
<tr><td style="padding:18px 20px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="font-family:${SANS};font-size:14px;font-weight:600;color:#eceef1;">X Card</td>
    <td align="right" style="font-family:${MONO};font-size:9.5px;letter-spacing:0.12em;color:#8b909a;">${esc(kind)}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:16px 20px 0;"><div style="width:34px;height:25px;border-radius:6px;background:#2c3038;border:1px solid #3b404b;"></div></td></tr>
<tr><td style="padding:16px 20px 18px;">
  <div style="font-family:${MONO};font-size:12px;letter-spacing:0.14em;color:#8b909a;">&bull;&bull;&bull;&bull; ${esc(last4 ?? "••••")}</div>
  <div style="font-family:${MONO};font-size:15px;color:#eceef1;padding-top:6px;word-break:break-all;">${esc(name)}</div>
</td></tr></table>`;
}

function button(href: string, label: string, primary = true): string {
  const bg = primary ? "#5b8cff" : "#0f1115";
  const fg = primary ? "#0a0b0d" : "#eceef1";
  const border = primary ? "#5b8cff" : "#2f333a";
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};border:1px solid ${border};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;padding:13px 22px;">${esc(label)}</a>`;
}

export function codeEmail(to: string, code: string): Mail {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const inner = `
<div style="font-family:${MONO};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8b909a;">Your sign-in code</div>
<div style="font-family:${SANS};font-size:26px;line-height:1.2;font-weight:500;letter-spacing:-0.02em;color:#eceef1;padding-top:12px;">Sign in to X Card</div>
<div style="font-family:${SANS};font-size:15px;line-height:1.6;color:#8b909a;padding-top:10px;">Enter this code on the page where you asked for it. It works once, for 10 minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
<tr><td align="center" bgcolor="#0a0b0d" style="background:#0a0b0d;border:1px solid #2a3350;border-radius:16px;padding:22px 12px;">
  <div style="font-family:${MONO};font-size:36px;font-weight:600;letter-spacing:0.3em;color:#eceef1;padding-left:0.3em;">${esc(spaced)}</div>
</td></tr></table>
<div style="font-family:${SANS};font-size:13px;line-height:1.6;color:#5d626c;padding-top:22px;">Didn't ask for this? Ignore it: nobody can sign in without the code, and no account changes.</div>`;
  return {
    to,
    subject: `${spaced} is your X Card code`,
    html: frame(`Your X Card sign-in code: ${spaced}`, inner),
    text: `Your X Card sign-in code: ${spaced}\n\nIt works once, for 10 minutes. Didn't ask for it? Ignore this email.\n\n${SITE}`,
  };
}

export interface ApprovalMailInput {
  to: string;
  card: string;
  last4?: string;
  kind: "funding" | "payment" | "policy";
  amount: number;
  currency: string;
  /** "300 > card.limit.tx (50)", the rule it hit. */
  why: string;
  purpose?: string;
  merchant?: string;
  changes?: string;
  url: string;
  expiresAt: number;
}

export function approvalEmail(i: ApprovalMailInput): Mail {
  const amount = money(i.amount, i.currency);
  const headline = i.kind === "payment" ? `${i.card} wants to pay ${i.merchant ?? "a merchant"} ${amount}`
    : i.kind === "policy" ? `${i.card} wants a policy change`
    : `${i.card} asks for ${amount} more`;
  const rows: [string, string][] = [
    ...(i.kind === "policy" ? [["changes", i.changes ?? ""] as [string, string]] : [["amount", `${i.kind === "funding" ? "+" : ""}${amount}`] as [string, string]]),
    ...(i.merchant ? [["merchant", i.merchant] as [string, string]] : []),
    ...(i.purpose ? [["for", i.purpose] as [string, string]] : []),
    ["why it paused", i.why],
    ["expires", new Date(i.expiresAt).toUTCString().replace(":00 GMT", " UTC")],
  ];
  const table = rows.map(([k, v]) => `<tr>
    <td style="font-family:${MONO};font-size:12px;color:#5d626c;padding:7px 0;vertical-align:top;white-space:nowrap;">${esc(k)}</td>
    <td align="right" style="font-family:${MONO};font-size:12px;color:#b9bdc6;padding:7px 0 7px 14px;word-break:break-word;">${esc(v)}</td></tr>`).join("");
  const inner = `
<div style="font-family:${MONO};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#e5b84f;">Needs your approval</div>
<div style="font-family:${SANS};font-size:23px;line-height:1.25;font-weight:500;letter-spacing:-0.02em;color:#eceef1;padding-top:12px;word-break:break-word;">${esc(headline)}</div>
<div style="font-family:${SANS};font-size:15px;line-height:1.6;color:#8b909a;padding-top:10px;">You're this card's approver. Nothing happens until you decide.</div>
<div style="padding-top:22px;">${cardFace(i.card, i.last4)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-top:1px solid #1d2026;">${table}</table>
<div style="padding-top:24px;">${button(i.url, "Review and decide")}</div>
<div style="font-family:${SANS};font-size:13px;line-height:1.6;color:#5d626c;padding-top:18px;">The link opens the request on x-card.dev. You sign in with a code sent to this address, so a forwarded email can't decide it.</div>`;
  return {
    to: i.to,
    subject: i.kind === "policy" ? `Approve a policy change for ${i.card}?` : `Approve ${amount} for ${i.card}?`,
    html: frame(headline, inner),
    text: `${headline}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nReview and decide: ${i.url}\n\nYou sign in with a code sent to this address, so a forwarded email can't decide it.`,
  };
}

function money(n: number, cur: string): string {
  const sym = ({ USD: "$", EUR: "€", GBP: "£", JPY: "¥" } as Record<string, string>)[cur];
  const v = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return sym ? sym + v : `${v} ${cur}`;
}
