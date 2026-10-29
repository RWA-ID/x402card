// Email sign-in for demo accounts and email approvers: a 6-digit code sent
// from x-card.dev, then a session token (xs_…) the site keeps and sends as a
// Bearer token. No passwords, no wallet.
//
// The code is stored only as a hash, works once, for 10 minutes, with 5
// tries. Sending is rate limited per email and per IP, so the endpoint can't
// be used to flood someone's inbox or guess codes.
import { isEmail } from "../policy/records.ts";
import { sha256Hex } from "../mcp.ts";
import type { Store } from "../store.ts";
import { FROM_LOGIN, codeEmail, type Mailer } from "./mail.ts";

const MAX_TRIES = 5;
const PER_EMAIL_HOUR = 5;
const PER_IP_HOUR = 20;

export class AuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface EmailAuthOptions {
  store: Store;
  /** Absent = dev mode: the code is returned to the caller instead of mailed. */
  mailer?: Mailer;
  /** Keys the code hashes, so a KV dump alone can't be brute-forced offline. */
  secret: string;
}

export const normalizeEmail = (e: unknown): string => {
  const v = typeof e === "string" ? e.trim().toLowerCase() : "";
  if (!isEmail(v)) throw new AuthError("bad_email", "enter a valid email address");
  return v;
};

export class EmailAuth {
  private o: EmailAuthOptions;
  constructor(o: EmailAuthOptions) { this.o = o; }

  private key = (email: string) => sha256Hex(`otp|${email}`);
  private codeHash = (email: string, code: string) => sha256Hex(`${this.o.secret}|${email}|${code}`);

  /** Mails a fresh code (replacing any earlier one). dev_code only when there's no mailer. */
  async start(emailIn: unknown, ip: string): Promise<{ sent: true; dev_code?: string }> {
    const email = normalizeEmail(emailIn);
    const key = await this.key(email);
    if ((await this.o.store.hit(`otpip:${ip}`)) > PER_IP_HOUR || (await this.o.store.hit(`otprl:${key}`)) > PER_EMAIL_HOUR) {
      throw new AuthError("rate_limited", "too many codes requested; wait a while and try again", 429);
    }
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    const code = String(n).padStart(6, "0");
    await this.o.store.putOtp(key, { hash: await this.codeHash(email, code), tries: 0 });
    if (!this.o.mailer) return { sent: true, dev_code: code };
    try {
      await this.o.mailer({ from: FROM_LOGIN, ...codeEmail(email, code) });
    } catch (e) {
      console.error("sign-in mail", e instanceof Error ? e.message : e);
      throw new AuthError("mail_failed", "couldn't send the code; try again in a minute", 502);
    }
    return { sent: true };
  }

  /** Checks the code; on a match, opens a 7-day session. */
  async verify(emailIn: unknown, codeIn: unknown): Promise<{ token: string; email: string }> {
    const email = await this.check(emailIn, codeIn);
    const token = "xs_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    await this.o.store.putSession(await sha256Hex(token), email);
    return { token, email };
  }

  /** Checks (and uses up) the code without opening a site session: the connector's sign-in. Returns the email. */
  async check(emailIn: unknown, codeIn: unknown): Promise<string> {
    const email = normalizeEmail(emailIn);
    const code = typeof codeIn === "string" ? codeIn.replace(/\D/g, "") : "";
    if (code.length !== 6) throw new AuthError("bad_code", "the code is 6 digits");
    const key = await this.key(email);
    const otp = await this.o.store.getOtp(key);
    if (!otp) throw new AuthError("code_expired", "that code expired or was already used; ask for a new one");
    if (otp.hash !== (await this.codeHash(email, code))) {
      const tries = otp.tries + 1;
      if (tries >= MAX_TRIES) {
        await this.o.store.deleteOtp(key);
        throw new AuthError("code_expired", "too many wrong codes; ask for a new one");
      }
      await this.o.store.putOtp(key, { ...otp, tries });
      throw new AuthError("wrong_code", `that code isn't right (${MAX_TRIES - tries} ${MAX_TRIES - tries === 1 ? "try" : "tries"} left)`);
    }
    await this.o.store.deleteOtp(key);
    return email;
  }

  /** The email behind a session token, or null. */
  async session(token: string): Promise<string | null> {
    if (!token.startsWith("xs_")) return null;
    return (await this.o.store.getSession(await sha256Hex(token)))?.email ?? null;
  }

  async signOut(token: string): Promise<void> {
    if (token.startsWith("xs_")) await this.o.store.deleteSession(await sha256Hex(token));
  }
}
