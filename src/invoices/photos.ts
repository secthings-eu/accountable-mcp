import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Receipts photographed with the phone, found through the macOS Photos library search (which
 * matches on-device recognised text, keywords, captions…), e.g. "VAT" / "TVA" for receipts.
 * Uses Photos.app's scripting interface (osascript/JXA): `search for` is the same index as the
 * app's search field, `export` writes the originals. macOS asks once to allow controlling Photos.
 */

export interface PhotoHit {
  id: string;
  filename: string;
  /** YYYY-MM-DD, local time of the shot. */
  date: string;
  width: number;
  height: number;
}

async function jxa<T>(script: string, args: string[] = []): Promise<T> {
  const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", script, ...args], { maxBuffer: 16_000_000, timeout: 600_000 });
  return JSON.parse(stdout.trim()) as T;
}

/** Union of the Photos search results for each query, de-duplicated by media item id. */
export async function searchPhotos(queries: string[]): Promise<PhotoHit[]> {
  const script = `
    function run(argv) {
      const Photos = Application('Photos');
      const seen = {}; const out = [];
      for (const q of argv) {
        for (const i of Photos.search({ for: q })) {
          const id = i.id(); if (seen[id]) continue; seen[id] = true;
          const d = i.date();
          const pad = (n) => String(n).padStart(2, '0');
          out.push({ id, filename: i.filename(), date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), width: i.width(), height: i.height() });
        }
      }
      return JSON.stringify(out);
    }`;
  return jxa<PhotoHit[]>(script, queries);
}

/**
 * Export originals of the given items into `dir`, one at a time so each file can be attributed to its
 * item (Photos names exports by original filename). HEIC is converted to JPEG with `sips`.
 * Returns item id → exported file path.
 */
export async function exportPhotos(hits: PhotoHit[], dir: string): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const out = new Map<string, string>();
  const script = `
    function run(argv) {
      const Photos = Application('Photos');
      const item = Photos.mediaItems.byId(argv[0]);
      Photos.export([item], { to: Path(argv[1]), usingOriginals: true });
      return '"ok"';
    }`;
  for (const h of hits) {
    const tmp = join(dir, `.export-${h.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    try {
      await jxa<string>(script, [h.id, tmp]);
      const [name] = await readdir(tmp);
      if (!name) continue;
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      const base = `${h.date}_photo_${name.slice(0, name.lastIndexOf(".")).replace(/[^\w.-]+/g, "_")}`;
      let file: string;
      if (ext === ".heic" || ext === ".heif") {
        file = join(dir, `${base}.jpg`);
        await exec("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", join(tmp, name), "--out", file]);
      } else {
        file = join(dir, `${base}${ext === ".jpeg" ? ".jpg" : ext}`);
        await rename(join(tmp, name), file);
      }
      out.set(h.id, file);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return out;
}
