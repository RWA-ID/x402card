// Issue a company's cards from a CSV. A preview checks every row and issues
// nothing; a person confirms it; then a job issues the valid rows a few at a
// time, advanced by whoever is watching and by the cron, so a big file never
// has to fit in one Worker request. What gets issued is what was previewed:
// the rows are stored, and starting takes only the batch's id.
import { DEMO_CARDS, describeError, ServiceError, type CardService, normalizeLabel, fullName } from "./service.ts";
import type { TextRecords } from "./policy/records.ts";
import { isEmail } from "./policy/records.ts";
import type { Batch, BatchRow, Org, Store } from "./store.ts";

export const MAX_ROWS = 200;
/** Rows per request or cron run: each one calls Airwallex twice and sends an email. */
const PER_TICK = 5;
const REQUIRED = ["name", "holder_email", "limit_tx", "limit_monthly"];
const OPTIONAL = ["approver", "limit_daily", "mcc_allow", "payee"];

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && !field) quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

function rowRecords(get: (k: string) => string, operator: string): TextRecords {
  return {
    "card.limit.tx": get("limit_tx"),
    "card.limit.daily": get("limit_daily"),
    "card.limit.monthly": get("limit_monthly"),
    "card.currencies": "USD",
    "card.mcc.allow": get("mcc_allow").split(/[\s;|]+/).filter(Boolean).join(","),
    "card.approver": get("approver").toLowerCase() || operator,
    "card.payee": get("payee") || "verified-or-escalate",
    "card.payee.allow": "",
  };
}

/** Checks every row. Stores the result; issues nothing. */
export async function previewBatch(svc: CardService, store: Store, org: Org, email: string, csv: string): Promise<Batch> {
  const table = parseCsv(csv);
  if (table.length < 2) throw new ServiceError("bad_csv", "the CSV needs a header row and at least one card");
  if (table.length - 1 > MAX_ROWS) throw new ServiceError("bad_csv", `a batch is at most ${MAX_ROWS} cards; this has ${table.length - 1}`);
  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((k) => !header.includes(k));
  if (missing.length) throw new ServiceError("bad_csv", `missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  // A misspelt column would silently drop a limit.
  const unknown = header.filter((h) => !REQUIRED.includes(h) && !OPTIONAL.includes(h));
  if (unknown.length) throw new ServiceError("bad_csv", `unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Allowed: ${[...REQUIRED, ...OPTIONAL].join(", ")}`);

  const seen = new Set<string>();
  const rows: BatchRow[] = [];
  for (const [i, cells] of table.slice(1).entries()) {
    const get = (k: string) => (cells[header.indexOf(k)] ?? "").trim();
    const records = rowRecords(get, email.toLowerCase());
    const holder = get("holder_email").toLowerCase();
    const row: BatchRow = { line: i + 2, name: get("name"), holder, records, status: "pending" };
    try {
      if (!isEmail(holder)) throw new ServiceError("bad_holder", "holder_email isn't an email address");
      const label = await svc.checkOrgCard(email, org, get("name"), records);
      if (seen.has(label)) throw new ServiceError("duplicate", "this name is already in the file");
      seen.add(label);
      row.name = fullName(label);
    } catch (e) {
      row.status = "invalid";
      row.error = describeError(e).message;
    }
    rows.push(row);
  }
  const batch: Batch = { id: crypto.randomUUID(), org: org.slug, by: email.toLowerCase(), status: "preview", rows, createdAt: Date.now() };
  await store.putBatch(batch);
  return batch;
}

/** The batch, if this company's. */
export async function batchFor(store: Store, id: string, org: Org): Promise<Batch> {
  const batch = /^[0-9a-f-]{36}$/.test(id) ? await store.getBatch(id) : null;
  if (!batch || batch.org !== org.slug) throw new ServiceError("not_found", "no such batch");
  return batch;
}

export async function startBatch(store: Store, batch: Batch, org: Org): Promise<Batch> {
  if (batch.status !== "preview") return batch;
  const valid = batch.rows.filter((r) => r.status === "pending").length;
  if (!valid) throw new ServiceError("nothing_to_issue", "no row in this file can be issued");
  const left = org.caps.cards - (await store.orgIndex(org.slug)).length;
  if (valid > left) throw new ServiceError("limit_reached", `${org.name} has room for ${left} more card${left === 1 ? "" : "s"}; this file has ${valid}`);
  const started = { ...batch, status: "running" as const, startedAt: Date.now() };
  await store.putBatch(started);
  await store.markBatchRunning(started.id);
  return started;
}

/** Issues the next few rows. One runner at a time; a row already issued by a racing runner counts as issued. */
export async function advanceBatch(svc: CardService, store: Store, batch: Batch): Promise<Batch> {
  if (batch.status !== "running" || !(await store.lockBatch(batch.id))) return batch;
  try {
    // The stored copy: another runner may have moved on since this was read.
    const b = (await store.getBatch(batch.id)) ?? batch;
    const org = await store.getOrg(b.org);
    for (const row of b.rows.filter((r) => r.status === "pending").slice(0, PER_TICK)) {
      try {
        // Whoever started it must still operate the company.
        if (!org?.operators.includes(b.by)) throw new ServiceError("forbidden", `${b.by} no longer operates this company`);
        const key = normalizeLabel(row.name);
        const was = await store.getCard(key);
        if (was?.org === b.org && was.holder === row.holder && was.createdAt >= (b.startedAt ?? 0)) {
          row.status = "issued";
        } else {
          const card = await svc.issueOrgCard(b.by, org, row.name, row.records, row.holder);
          row.status = "issued";
          row.claim_sent = card.claim_sent;
          row.last4 = card.last4;
        }
      } catch (e) {
        row.status = "failed";
        row.error = describeError(e).message;
      }
      await store.putBatch(b);
    }
    if (!b.rows.some((r) => r.status === "pending")) {
      b.status = "done";
      b.finishedAt = Date.now();
      await store.putBatch(b);
      await store.clearBatchRunning(b.id);
    }
    return b;
  } finally {
    await store.unlockBatch(batch.id);
  }
}

/** The cron: batches whose page was closed keep going. */
export async function advanceRunning(svc: CardService, store: Store): Promise<void> {
  for (const id of await store.runningBatches()) {
    const b = await store.getBatch(id);
    if (b) await advanceBatch(svc, store, b);
    else await store.clearBatchRunning(id);
  }
}

/** What a person or the model sees of a batch. */
export function batchView(b: Batch) {
  const count = (s: BatchRow["status"]) => b.rows.filter((r) => r.status === s).length;
  return {
    batch_id: b.id,
    status: b.status,
    parent: `${b.org}.${DEMO_CARDS.parent}`,
    totals: { rows: b.rows.length, invalid: count("invalid"), pending: count("pending"), issued: count("issued"), failed: count("failed"), emails_unsent: b.rows.filter((r) => r.status === "issued" && r.claim_sent === false).length },
    rows: b.rows.map((r) => ({
      line: r.line,
      name: r.name,
      holder: r.holder,
      approver: r.records["card.approver"],
      limit_tx: r.records["card.limit.tx"],
      limit_daily: r.records["card.limit.daily"],
      limit_monthly: r.records["card.limit.monthly"],
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      ...(r.claim_sent !== undefined ? { claim_sent: r.claim_sent } : {}),
      ...(r.last4 ? { last4: r.last4 } : {}),
    })),
  };
}
