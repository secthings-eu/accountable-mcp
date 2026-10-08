import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { UPLOAD_TIMEOUT_MS } from "../constants.js";
import { api } from "./client.js";

/** UploadTypesEnum values seen in the web app (docs/api/expenses.md §1). */
export type UploadCategory = "expense" | "document" | "invoice" | "repository-document";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".xml": "application/xml",
};

const MAX_BYTES = 10 * 1000 * 1000;

let counter = 0;

export interface UploadedFile {
  key: string;
  name: string;
  contentType: string;
  size: number;
}

/**
 * 1. GET /v2/users/upload-url → presigned S3 POST {url, fields}
 * 2. multipart POST to S3: all fields first, then `file` (no Authorization header)
 * 3. fields.key is the storage path used as file_path / file.path
 */
export async function uploadLocalFile(path: string, category: UploadCategory): Promise<UploadedFile> {
  const contentType = MIME[extname(path).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported file type ${extname(path)}; use pdf, jpg, png or xml.`);
  const info = await stat(path);
  if (info.size > MAX_BYTES) throw new Error(`File is ${(info.size / 1e6).toFixed(1)} MB; Accountable accepts up to 10 MB.`);

  const presigned = await api.get<{ url: { url: string; fields: Record<string, string> } }>("/v2/users/upload-url", {
    query: { category, contentType, n: ++counter },
  });
  const { url, fields } = presigned.url;
  if (!fields.key) throw new Error("Upload URL response had no key field.");

  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const bytes = await readFile(path);
  form.append("file", new Blob([bytes], { type: contentType }), basename(path));

  const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Storage upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  return { key: fields.key, name: basename(path), contentType, size: info.size };
}
