import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../constants.js";
import { Gmail, type GmailMessage } from "./gmail.js";
import { htmlToPdf } from "./render.js";
import { fetchAliExpressReceipts, groupCheckouts, writeCheckoutPdf, type AliReceipt } from "./aliexpress.js";
import { exportPhotos, searchPhotos } from "./photos.js";
import type { InvoiceProvider } from "./providers.js";

export const DEFAULT_INVOICE_DIR = process.env.ACCOUNTABLE_INVOICE_DIR ?? join(homedir(), "Documents", "Invoices");
const LEDGER_FILE = join(CONFIG_DIR, "invoice-ledger.json");

export interface FetchedInvoice {
  provider: string;
  supplier: string;
  /** Stable id of the source item, e.g. gmail:<mailbox>:<messageId>. */
  source_ref: string;
  date: string;
  subject: string;
  file: string;
  /** Set once imported into Accountable. */
  expense_id?: string;
  /** Not importable on its own (e.g. a single AliExpress order that belongs to a checkout). */
  hidden?: boolean;
  /** Fields to force after OCR (merged multi-receipt PDFs OCR badly). */
  expected_amount?: number;
  overrides?: { supplier_name?: string; is_invoice?: boolean; notes?: string };
  meta?: Record<string, unknown>;
}

interface Ledger {
  [sourceRef: string]: FetchedInvoice;
}

export async function loadLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(LEDGER_FILE, "utf8")) as Ledger;
  } catch {
    return {};
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(LEDGER_FILE, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

const gmailDate = (iso: string) => iso.slice(0, 10).replace(/-/g, "/");

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  janv: 1, févr: 2, fevr: 2, mars: 3, avr: 4, mai: 5, juin: 6, juil: 7, août: 8, aout: 8, déc: 12,
};

/** For forwarded mail, the original date is in the quoted header ("Date: Wed, 16 Sept 2026 at 09:09"). */
function originalDate(msg: GmailMessage): string {
  if (!/^(fwd?|tr|fw):/i.test(msg.subject.trim())) return msg.date.slice(0, 10);
  const body = msg.text || msg.html.replace(/<[^>]+>/g, " ");
  const m = body.match(/(?:Date|Envoyé|Sent)\s*:\s*(?:\w+\.?,?\s+)?(\d{1,2})\s+([A-Za-zéû]+)\.?\s+(\d{4})/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 5)] ?? MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (month) return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return msg.date.slice(0, 10);
}
const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_").slice(0, 80);

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface FetchResult {
  provider: string;
  status: "ok" | "skipped" | "error";
  message?: string;
  invoices: FetchedInvoice[];
}

/**
 * Fetch one provider's invoices for [from, to] into <outDir>/<provider>/.
 * Already-fetched items (ledger) are returned without re-downloading.
 */
export async function fetchProvider(
  provider: InvoiceProvider,
  from: string,
  to: string,
  outDir: string,
  ledger: Ledger,
  connectedMailboxes: string[],
): Promise<FetchResult> {
  const src = provider.source;
  if (src.kind === "browser") {
    const dir = join(outDir, provider.id);
    const orderRef = (id: string) => `aliexpress-order:${id}`;
    const known = new Set(Object.keys(ledger).filter((k) => k.startsWith("aliexpress-order:")).map((k) => k.split(":")[1]));
    for (const r of await fetchAliExpressReceipts(from, to, join(dir, "orders"), known)) {
      ledger[orderRef(r.orderId)] = {
        provider: provider.id,
        supplier: provider.supplier,
        source_ref: orderRef(r.orderId),
        date: r.date,
        subject: `AliExpress order ${r.orderId}`,
        file: r.file,
        hidden: true,
        meta: { ...r },
      };
    }
    // One importable entry per checkout (= one bank debit), with all its receipts merged into one PDF.
    const receipts = Object.values(ledger)
      .filter((i) => i.source_ref.startsWith("aliexpress-order:") && i.date >= from && i.date <= to)
      .map((i) => i.meta as unknown as AliReceipt);
    for (const c of groupCheckouts(receipts)) {
      const ref = `aliexpress-checkout:${c.key.replace(/^(pay|oid):/, "")}`;
      if (ledger[ref]?.expense_id) continue;
      const file = join(dir, `${c.date}_aliexpress_checkout_${c.orders.length}orders_${c.total.toFixed(2)}.pdf`);
      await writeCheckoutPdf(c, file);
      const orderList = c.orders.map((o) => `${o.orderId} ${o.store} ${o.orderTotal ?? o.total}`).join("; ");
      ledger[ref] = {
        provider: provider.id,
        supplier: provider.supplier,
        source_ref: ref,
        date: c.date,
        subject: `AliExpress checkout ${c.date} — ${c.orders.length} order(s) — EUR ${c.total.toFixed(2)}`,
        file,
        expected_amount: c.total,
        overrides: {
          supplier_name: "AliExpress",
          is_invoice: false,
          notes: `AliExpress checkout (${c.orders.length} orders, receipts merged): ${orderList}`.slice(0, 1000),
        },
      };
    }
    const invoices = Object.values(ledger).filter((i) => i.provider === provider.id && !i.hidden && i.date >= from && i.date <= to);
    return { provider: provider.id, status: "ok", invoices };
  }
  if (src.kind === "photos") {
    if (process.platform !== "darwin") return { provider: provider.id, status: "skipped", message: "Photos library access needs macOS.", invoices: [] };
    const dir = join(outDir, provider.id);
    const ref = (id: string) => `photos:${id}`;
    const hits = (await searchPhotos(src.queries)).filter((h) => h.date >= from && h.date <= to);
    const todo = hits.filter((h) => !ledger[ref(h.id)]);
    const files = await exportPhotos(todo, dir);
    for (const h of todo) {
      const file = files.get(h.id);
      if (!file) continue;
      ledger[ref(h.id)] = {
        provider: provider.id,
        supplier: provider.supplier,
        source_ref: ref(h.id),
        date: h.date,
        subject: `Receipt photo ${h.filename} (${h.date})`,
        file,
        overrides: { notes: `Receipt photo ${h.filename} from the Photos library (search: ${src.queries.join(" / ")}).` },
        meta: { photo_id: h.id, filename: h.filename, screenshot: /\.png$/i.test(h.filename) },
      };
    }
    // Entries the user dismissed (hidden: screenshots / shelf labels that merely contain the word) stay out.
    const invoices = hits.map((h) => ledger[ref(h.id)]).filter((i) => i && !i.hidden);
    return { provider: provider.id, status: "ok", invoices };
  }
  if (src.kind === "portal") {
    return { provider: provider.id, status: "skipped", message: `Portal module not implemented yet: ${src.note} (${src.url})`, invoices: [] };
  }
  const mailboxes = src.mailboxes.filter((m) => connectedMailboxes.includes(m));
  if (!mailboxes.length) {
    return {
      provider: provider.id,
      status: "skipped",
      message: `Needs mailbox ${src.mailboxes.join(" or ")}; run \`accountable-mcp gmail-login ${src.mailboxes[0]}\`.`,
      invoices: [],
    };
  }
  const dir = join(outDir, provider.id);
  await mkdir(dir, { recursive: true });
  const invoices: FetchedInvoice[] = [];
  const query = `${src.query} after:${gmailDate(from)} before:${gmailDate(nextDay(to))}`;

  for (const mailbox of mailboxes) {
    const gmail = new Gmail(mailbox);
    for (const id of await gmail.search(query)) {
      const ref = `gmail:${mailbox}:${id}`;
      if (ledger[ref]) {
        invoices.push(ledger[ref]);
        continue;
      }
      const msg: GmailMessage = await gmail.message(id);
      const day = originalDate(msg);
      let file: string | null = null;
      if (src.kind === "gmail-attachment") {
        const att = msg.attachments.find((a) => src.attachment.test(a.filename));
        if (!att) continue;
        file = join(dir, `${day}_${safe(att.filename)}`);
        await writeFile(file, await gmail.attachment(id, att.attachmentId));
      } else {
        if (src.subject && !src.subject.test(msg.subject)) continue;
        if (!msg.html && !msg.text) continue;
        file = join(dir, `${day}_${safe(msg.subject)}.pdf`);
        const body = msg.html || `<pre>${msg.text.replace(/</g, "&lt;")}</pre>`;
        await htmlToPdf(body, file, `${msg.from} — ${msg.subject} — ${msg.date}`);
      }
      const inv: FetchedInvoice = { provider: provider.id, supplier: provider.supplier, source_ref: ref, date: day, subject: msg.subject, file };
      ledger[ref] = inv;
      invoices.push(inv);
    }
  }
  return { provider: provider.id, status: "ok", invoices };
}
