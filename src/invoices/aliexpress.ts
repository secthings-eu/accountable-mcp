import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { join } from "node:path";
import { BROWSER_SITES } from "./browser.js";
import { withSite, type CamofoxSite } from "./camofox.js";
import { pngToA4Pdf } from "./render.js";

/**
 * AliExpress receipts, fetched programmatically through AliExpress's own signed mtop client
 * (`window.lib.mtop.request`) inside a headless tab of the MCP-owned Camoufox profile "aliexpress".
 *
 * APIs (observed 2026-10):
 *   mtop.aliexpress.trade.buyer.order.list v1.0   — Ultron paginated order list
 *   mtop.global.finance.taxation.invoice.queryorderreceiptinfo v1.0 {orderId} — receipt data
 * The receipt is AliExpress's "Receipt" page (/p/tax-ui/index.html?orderId=…), captured to PDF.
 * It is a payment receipt (VAT/IOSS included), not a seller VAT invoice.
 */

export interface AliOrder {
  orderId: string;
  date: string; // YYYY-MM-DD (order date as shown by AliExpress)
  total: string;
  store: string;
  status: string;
  paymentOutId: string;
}

export interface AliReceipt extends AliOrder {
  file: string;
  orderTotal?: string;
  includedTax?: string;
  importTax?: string;
  paidOn?: string;
  paymentMethod?: string;
  sellers: string[];
}

// Page-side scripts are self-contained functions (no closure variables): they are serialised with
// .toString() and evaluated inside the tab via camofox.
const pageFn = (fn: (...a: any[]) => unknown, ...args: unknown[]) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;

/** Runs in the page: paginates the order list exactly like the UI's "View orders" button. */
const listOrdersScript = async (fromDate: string) => {
    const w = window as unknown as { lib: { mtop: { request: (o: unknown) => Promise<any> } } };
    const base = { api: "mtop.aliexpress.trade.buyer.order.list", v: "1.0", dataType: "originaljsonp", needLogin: true, timeout: 15000 };
    const toIso = (s: string) => {
      const d = new Date(`${s} 12:00:00`);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const orders = new Map<string, any>();
    const collect = (resp: any) => {
      for (const [k, c] of Object.entries<any>(resp.data.data)) {
        if (!k.startsWith("pc_om_list_order_")) continue;
        const f = c.fields;
        orders.set(f.orderId, {
          orderId: f.orderId,
          date: toIso(f.orderDateText),
          total: f.totalPriceText,
          store: f.storeName,
          status: f.statusText,
          paymentOutId: f.paymentOutId,
        });
      }
    };
    let resp = await w.lib.mtop.request({
      ...base,
      type: "GET",
      data: { statusTab: null, renderType: "init", clientPlatform: "pc", shipToCountry: "BE", _lang: "en_US" },
    });
    collect(resp);
    for (let i = 0; i < 50; i++) {
      const d = resp.data;
      const bodyKey = Object.keys(d.data).find((k) => k.startsWith("pc_om_list_body_"))!;
      const body = d.data[bodyKey];
      const oldest = [...orders.values()].map((o) => o.date).sort()[0];
      if (!body.fields.hasMore || (oldest && oldest < fromDate)) break;
      const headerKey = Object.keys(d.data).find((k) => k.startsWith("pc_om_list_header_action_"));
      const params = {
        data: JSON.stringify({
          [bodyKey]: { ...body, fields: { ...body.fields, pageIndex: body.fields.pageIndex + 1 } },
          ...(headerKey ? { [headerKey]: d.data[headerKey] } : {}),
        }),
        linkage: JSON.stringify(d.linkage),
        hierarchy: JSON.stringify({ structure: d.hierarchy.structure }),
        endpoint: JSON.stringify(d.endpoint),
        operator: bodyKey,
      };
      const next = await w.lib.mtop.request({
        ...base,
        type: "POST",
        method: "POST",
        post: "1",
        isSec: 1,
        ecode: "1",
        AntiFlood: false,
        data: { params: JSON.stringify(params), shipToCountry: "BE", _lang: "en_US" },
      });
      collect(next);
      // The pagination response only carries changed components: keep the previous page state for the rest,
      // but take the new body (with its new pageIndex/hasMore) and new linkage.
      const nd = next.data;
      const newBodyKey = Object.keys(nd.data ?? {}).find((k) => k.startsWith("pc_om_list_body_"));
      resp = {
        data: {
          ...d,
          data: { ...d.data, ...(newBodyKey ? { [bodyKey]: nd.data[newBodyKey] } : {}) },
          linkage: nd.linkage ?? d.linkage,
          hierarchy: nd.hierarchy?.structure ? { ...d.hierarchy, structure: { ...d.hierarchy.structure, ...nd.hierarchy.structure } } : d.hierarchy,
          endpoint: nd.endpoint ?? d.endpoint,
        },
      };
      if (!newBodyKey) break;
    }
    return [...orders.values()];
};

async function listOrdersInPage(c: CamofoxSite, tab: string, from: string): Promise<AliOrder[]> {
  return c.evaluateLarge<AliOrder[]>(tab, pageFn(listOrdersScript, from), 240_000);
}

const receiptInfoScript = async (id: string) => {
    const w = window as unknown as { lib: { mtop: { request: (o: unknown) => Promise<any> } } };
    const r = await w.lib.mtop.request({
      api: "mtop.global.finance.taxation.invoice.queryorderreceiptinfo",
      v: "1.0",
      type: "GET",
      dataType: "json",
      needLogin: true,
      data: { orderId: id, _lang: "en_US" },
    });
    return r.data?.data ?? {};
};

async function receiptInfo(c: CamofoxSite, tab: string, orderId: string): Promise<Record<string, any>> {
  return c.evaluate<Record<string, any>>(tab, pageFn(receiptInfoScript, orderId), 30_000);
}

async function probeCheckoutGaps(c: CamofoxSite, tab: string, orders: AliOrder[]): Promise<AliOrder[]> {
  const found: AliOrder[] = [];
  const known = new Set(orders.map((o) => o.orderId));
  const groups = new Map<string, AliOrder[]>();
  for (const o of orders) {
    if (!o.paymentOutId || o.paymentOutId.length < 10) continue;
    const k = o.paymentOutId.slice(0, -6);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  for (const [prefix, list] of groups) {
    const seq = (o: AliOrder) => Number(o.paymentOutId.slice(-6, -4));
    list.sort((a, b) => seq(a) - seq(b));
    for (let i = 0; i + 1 < list.length; i++) {
      if (seq(list[i + 1]) - seq(list[i]) <= 1) continue;
      const core = (o: AliOrder) => BigInt(o.orderId.slice(0, -4));
      const suffix = list[i].orderId.slice(-4);
      const lo = core(list[i]) < core(list[i + 1]) ? core(list[i]) : core(list[i + 1]);
      const hi = core(list[i]) < core(list[i + 1]) ? core(list[i + 1]) : core(list[i]);
      for (let n = lo + 1n; n < hi && n - lo <= 20n; n++) {
        const id = `${n}${suffix}`;
        if (known.has(id)) continue;
        const info = await receiptInfo(c, tab, id);
        if (!info.orderTotal || !info.paymentInfo?.paymentDate) continue;
        const d = new Date(`${info.paymentInfo.paymentDate} 12:00:00`);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (iso !== list[i].date) continue;
        known.add(id);
        found.push({
          orderId: id,
          date: iso,
          total: info.orderTotal,
          store: info.subOrders?.[0]?.sellerName ?? "",
          status: "Completed",
          paymentOutId: `${prefix}${String(seq(list[i]) + 1).padStart(2, "0")}0069`,
        });
      }
    }
  }
  return found;
}

/** Fetch AliExpress receipts for orders dated in [from, to] into outDir (PDF per order). */
export async function fetchAliExpressReceipts(from: string, to: string, outDir: string, skip: Set<string>): Promise<AliReceipt[]> {
  await mkdir(outDir, { recursive: true });
  return withSite("aliexpress", async (c) => {
    const tab = await c.openTab(BROWSER_SITES.aliexpress.checkUrl);
    await c.wait(tab, 30_000);
    const hasMtop = () => c.evaluate<boolean>(tab, "Boolean(window.lib && window.lib.mtop && window.lib.mtop.request)").catch(() => false);
    for (let i = 0; i < 30 && !(await hasMtop()); i++) await new Promise((r) => setTimeout(r, 1000));
    if (!BROWSER_SITES.aliexpress.loggedIn(await c.url(tab)) || !(await hasMtop())) {
      throw new Error("AliExpress session expired or blocked. Run `accountable-mcp browser-login aliexpress`.");
    }
    const orders = (await listOrdersInPage(c, tab, from)).filter((o) => o.date >= from && o.date <= to && o.status !== "Cancelled");
    // The list API is not stably sorted, so pagination can skip orders. Orders of one checkout have
    // consecutive paymentOutId sequence numbers (…<seq:2><0069>); for each gap, probe the order ids between
    // the neighbouring orders with the receipt API and keep those paid the same day.
    for (const missing of await probeCheckoutGaps(c, tab, orders)) orders.push(missing);
    const out: AliReceipt[] = [];
    for (const o of orders) {
      const file = join(outDir, `${o.date}_aliexpress_${o.orderId}.pdf`);
      if (skip.has(o.orderId)) continue;
      const info = await receiptInfo(c, tab, o.orderId);
      const rp = await c.openTab(`https://www.aliexpress.com/p/tax-ui/index.html?orderId=${o.orderId}`);
      await c.wait(rp, 20_000);
      await new Promise((r) => setTimeout(r, 1500));
      await writeFile(file, await pngToA4Pdf(await c.screenshot(rp, true)));
      await c.closeTab(rp);
      out.push({
        ...o,
        file,
        orderTotal: info.orderTotal,
        includedTax: info.includedTaxDisplay,
        importTax: info.totalReceivableTaxAmount,
        paidOn: info.paymentInfo?.paidTime ?? info.paymentInfo?.payTime,
        paymentMethod: info.paymentInfo?.paymentMethod ?? info.paymentInfo?.payMethod,
        sellers: (info.subOrders ?? []).map((s: { sellerName?: string }) => s.sellerName).filter(Boolean),
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Checkouts: several orders paid in one go = one bank debit = one expense.
// ---------------------------------------------------------------------------

export interface AliCheckout {
  key: string;
  date: string;
  total: number;
  orders: AliReceipt[];
  file: string;
}

/** "€ 1.234,56" / "€49.03" → 1234.56 */
export function euro(s: string | undefined): number {
  if (!s) return 0;
  const t = s.replace(/[^\d,.-]/g, "");
  const normalized = /,\d{2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  return Number(normalized) || 0;
}

/**
 * paymentOutId = <checkout id> + <2-digit order seq> + "0069": orders of one checkout share all but the
 * last 6 digits. Orders the list API returns without a paymentOutId fall back to date + order-id prefix.
 */
export function checkoutKey(o: AliOrder): string {
  return o.paymentOutId && o.paymentOutId.length > 8 ? `pay:${o.paymentOutId.slice(0, -6)}` : `oid:${o.orderId.slice(0, 10)}:${o.date}`;
}

export function groupCheckouts(receipts: AliReceipt[]): Array<Omit<AliCheckout, "file">> {
  const byPay = new Map<string, AliReceipt[]>();
  for (const r of receipts) byPay.set(checkoutKey(r), [...(byPay.get(checkoutKey(r)) ?? []), r]);
  // Attach orphan (no paymentOutId) orders to a paid checkout of the same day and order-id prefix.
  for (const [k, list] of [...byPay]) {
    if (!k.startsWith("oid:")) continue;
    const host = [...byPay.entries()].find(
      ([hk, hl]) => hk.startsWith("pay:") && hl[0].date === list[0].date && hl[0].orderId.slice(0, 10) === list[0].orderId.slice(0, 10),
    );
    if (host) {
      host[1].push(...list);
      byPay.delete(k);
    }
  }
  return [...byPay.entries()].map(([key, orders]) => ({
    key,
    date: orders.map((o) => o.date).sort()[0],
    total: Math.round(orders.reduce((s, o) => s + euro(o.orderTotal ?? o.total), 0) * 100) / 100,
    orders: orders.sort((a, b) => a.orderId.localeCompare(b.orderId)),
  }));
}

/** One PDF per checkout: a summary page listing the orders, then every order receipt. */
export async function writeCheckoutPdf(c: Omit<AliCheckout, "file">, outPath: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  let y = 790;
  const line = (text: string, f = font, size = 11) => {
    page.drawText(text, { x: 50, y, size, font: f });
    y -= size + 8;
  };
  line("AliExpress — checkout summary", bold, 16);
  line(`Payment date: ${c.date}    Checkout: ${c.key.replace(/^(pay|oid):/, "")}`);
  line(`Orders: ${c.orders.length}    Total paid: EUR ${c.total.toFixed(2)}`, bold);
  y -= 6;
  for (const o of c.orders) {
    line(`Order ${o.orderId}  —  ${(o.store ?? "").slice(0, 40)}  —  ${o.orderTotal ?? o.total}${o.includedTax ? `  (VAT incl. ${o.includedTax})` : ""}`, font, 10);
  }
  y -= 6;
  line("Receipts issued by AliExpress for third-party sellers (payment receipts, VAT/IOSS included where shown).", font, 9);
  for (const o of c.orders) {
    const src = await PDFDocument.load(await readFile(o.file));
    for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
  }
  await writeFile(outPath, await doc.save());
}
