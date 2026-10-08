/**
 * Invoice provider modules. Each entry describes where a supplier's invoices live and how to turn
 * them into a PDF. Add a supplier by adding an entry; `supplier` must match the display name from
 * normalizeSupplier() so coverage reports can join providers with Accountable expenses and bank payments.
 *
 * `verified: true` = the query/attachment pattern was checked against real mail.
 * Your own suppliers go in `~/.config/accountable-mcp/providers.json` (see localConfig.ts); they are merged below.
 */
import { localProviders } from "./localConfig.js";

export type Mailbox = "work" | "personal";

export interface GmailAttachmentSource {
  kind: "gmail-attachment";
  mailboxes: Mailbox[];
  /** Gmail search query (dates are appended automatically). */
  query: string;
  /** Which attachment is the invoice (first match wins). */
  attachment: RegExp;
}

export interface GmailHtmlSource {
  kind: "gmail-html";
  mailboxes: Mailbox[];
  query: string;
  /** Subject must match, to skip marketing mail from the same sender. */
  subject?: RegExp;
}

/** Implemented browser-backed module (MCP-owned Chrome profile, see browser.ts). */
export interface BrowserSource {
  kind: "browser";
  site: "aliexpress";
}

/** Receipt photos found via the macOS Photos library search (recognised text / keywords), see photos.ts. */
export interface PhotosSource {
  kind: "photos";
  /** Search terms, results are unioned (e.g. "VAT", "TVA"). */
  queries: string[];
}

/** Placeholder for suppliers that need a portal/browser module (not implemented yet). */
export interface PortalSource {
  kind: "portal";
  url: string;
  note: string;
}

export interface InvoiceProvider {
  id: string;
  supplier: string;
  verified: boolean;
  source: GmailAttachmentSource | GmailHtmlSource | BrowserSource | PhotosSource | PortalSource;
}

const BUILTIN_PROVIDERS: InvoiceProvider[] = [
  {
    // Paper receipts photographed with the phone; the supplier is only known after OCR.
    id: "photos-receipts",
    supplier: "Receipt photo",
    verified: true,
    source: { kind: "photos", queries: ["VAT", "TVA"] },
  },
  {
    id: "anthropic",
    supplier: "Anthropic",
    verified: true,
    source: { kind: "gmail-attachment", mailboxes: ["work"], query: "from:invoice+statements@mail.anthropic.com", attachment: /^Invoice-.*\.pdf$/i },
  },
  {
    id: "google-workspace",
    supplier: "Google Cloud / Workspace",
    verified: true,
    source: {
      kind: "gmail-attachment",
      mailboxes: ["work"],
      query: 'from:payments-noreply@google.com ("votre facture" OR "your invoice" OR facture OR invoice)',
      attachment: /\.pdf$/i,
    },
  },
  {
    id: "parallels",
    supplier: "Parallels",
    verified: true,
    source: { kind: "gmail-attachment", mailboxes: ["work"], query: "from:no-reply@cleverbridge.com", attachment: /^AKD-.*\.pdf$/i },
  },
  {
    id: "apple-store",
    supplier: "Apple",
    verified: true,
    source: { kind: "gmail-attachment", mailboxes: ["work", "personal"], query: "from:EMEA_Invoicing@email.apple.com", attachment: /\.pdf$/i },
  },
  {
    id: "aws",
    supplier: "AWS",
    verified: true,
    source: { kind: "gmail-attachment", mailboxes: ["work"], query: 'from:invoicing@aws.com subject:"Invoice Available"', attachment: /^EUIN.*\.pdf$/i },
  },
  {
    id: "vercel",
    supplier: "Vercel",
    verified: true,
    source: { kind: "gmail-attachment", mailboxes: ["work"], query: 'subject:"Your receipt from Vercel"', attachment: /^Invoice-.*\.pdf$/i },
  },
  {
    id: "canva",
    supplier: "Canva",
    verified: true,
    source: { kind: "gmail-html", mailboxes: ["work"], query: 'from:no-reply@account.canva.com subject:"Your Canva invoice"', subject: /invoice/i },
  },
  {
    id: "microsoft",
    supplier: "Microsoft",
    verified: true,
    source: { kind: "gmail-attachment", mailboxes: ["work"], query: 'subject:("facture Microsoft" OR "Microsoft invoice")', attachment: /\.pdf$/i },
  },
  {
    id: "openai",
    supplier: "OpenAI",
    verified: false,
    source: {
      kind: "portal",
      url: "https://chatgpt.com/#settings/Account",
      note: "No receipt emails; download invoices from ChatGPT → Settings → Account → Manage (Stripe billing portal).",
    },
  },
  {
    id: "amazon",
    supplier: "Amazon",
    verified: false,
    source: { kind: "portal", url: "https://www.amazon.fr/your-orders/orders", note: "Amazon Business invoices are downloaded per order from the orders page (needs a browser session)." },
  },
  {
    id: "aliexpress",
    supplier: "AliExpress",
    verified: true,
    source: { kind: "browser", site: "aliexpress" },
  },
];

/** Built-in providers plus the user's local ones (same id → local wins). */
export const PROVIDERS: InvoiceProvider[] = (() => {
  const local = localProviders();
  const ids = new Set(local.map((p) => p.id));
  return [...BUILTIN_PROVIDERS.filter((p) => !ids.has(p.id)), ...local];
})();

export function findProvider(idOrSupplier: string): InvoiceProvider | undefined {
  const k = idOrSupplier.toLowerCase();
  return PROVIDERS.find((p) => p.id === k || p.supplier.toLowerCase() === k);
}
