import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { withSite } from "./camofox.js";

/**
 * Render an email's HTML body to PDF (receipts that only exist as email bodies, e.g. Apple or
 * Google Payments): the page is served from a loopback http server, opened in a throwaway
 * Camoufox profile ("render"), screenshotted full-page and paginated onto A4 pages.
 * Remote images may be blocked; layout is what matters.
 */
export async function htmlToPdf(html: string, outPath: string, header?: string): Promise<void> {
  const banner = header
    ? `<div style="font:11px sans-serif;color:#555;border-bottom:1px solid #ccc;margin-bottom:12px;padding-bottom:6px">${header}</div>`
    : "";
  const doc = `<!doctype html><meta charset="utf-8"><body style="margin:24px;background:#fff">${banner}${html}</body>`;
  const srv = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(doc);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  try {
    const png = await withSite("render", async (c) => {
      const tab = await c.openTab(`http://127.0.0.1:${port}/page.html`);
      await c.wait(tab, 15_000);
      return c.screenshot(tab, true);
    });
    await writeFile(outPath, await pngToA4Pdf(png));
  } finally {
    srv.close();
  }
}

/** Fit a (tall) PNG to A4 width and cut it into as many A4 pages as needed. */
export async function pngToA4Pdf(png: Buffer): Promise<Uint8Array> {
  const [W, H] = [595, 842];
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(png);
  const scaledH = (img.height / img.width) * W;
  const pages = Math.max(1, Math.ceil(scaledH / H));
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([W, H]);
    // Draw the whole image shifted up by i pages; anything outside the page box is clipped.
    page.drawImage(img, { x: 0, y: H - scaledH + i * H, width: W, height: scaledH });
  }
  return pdf.save();
}
