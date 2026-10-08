import { localAliases } from "../invoices/localConfig.js";
/**
 * Supplier name normalisation and document-origin classification.
 * Shared by accountable_list_suppliers and the invoice provider modules.
 */

/** origin.process values observed live (2026-10): peppol, email-ocr, recurrence, dropzone-ocr, conversation_upload, manual. */
export function isAutomaticOrigin(process: string | undefined): boolean {
  if (!process) return false;
  return process === "peppol" || process.startsWith("email") || process === "experts" || process === "recurrence";
}

const LEGAL_SUFFIXES =
  /\b(s\.?a\.?|n\.?v\.?|nv\/sa|sa\/nv|srl|sprl|sc|sas|sarl|s\.?à\.? r\.?l\.?|bvba|bv|b\.v\.|gmbh|egbr|inc|pbc|ltd|limited|llc|lda|ag|se|plc|eu|emea|belgium|belgique|belgie|belgië|france|fr|online|sucursal en españa)\b\.?/gi;

/** Known brands whose invoices arrive under several legal names. Checked in order; local aliases from
 * `~/.config/accountable-mcp/providers.json` come first. */
const BRAND_ALIASES: Array<[RegExp, string]> = [
  ...localAliases(),
  [/amazon|amzn/i, "Amazon"],
  [/microsoft/i, "Microsoft"],
  [/google\s*(cloud|workspace)/i, "Google Cloud / Workspace"],
  [/anthropic|claude\s*ai/i, "Anthropic"],
  [/openai|chatgpt/i, "OpenAI"],
  [/^aws\b|amazon web services/i, "AWS"],
  [/hetzner/i, "Hetzner"],
  [/vercel/i, "Vercel"],
  [/github/i, "GitHub"],
  [/aliexpress|alipay/i, "AliExpress"],
  [/apple|itunes/i, "Apple"],
  [/parallels|cleverbridge/i, "Parallels"],
  [/canva/i, "Canva"],
];

export interface SupplierKey {
  key: string;
  display: string;
}

export function normalizeSupplier(raw: string | undefined | null): SupplierKey {
  const name = (raw ?? "").split("|")[0].trim() || "(unknown)";
  // AWS must be checked before the generic Amazon alias.
  const ordered = [...BRAND_ALIASES].sort((a, b) => (a[1] === "AWS" ? -1 : b[1] === "AWS" ? 1 : 0));
  for (const [re, brand] of ordered) {
    if (re.test(name)) return { key: brand.toLowerCase(), display: brand };
  }
  const key = name
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9à-ÿ]+/g, " ")
    .trim();
  return { key: key || name.toLowerCase(), display: name };
}
