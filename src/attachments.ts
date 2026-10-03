import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { publicAddress } from "./events";

// Files both ways: the owner's attachments as signal-cli stored them, read for the agent (images shrunk, voice notes
// transcribed), and what the agent sends, fetched or decoded into the data URIs signal-cli accepts.

export const MAX_SEND_BYTES = 25 * 1024 * 1024;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const SHRINK_ABOVE = 1024 * 1024;
type Resolve = (host: string) => Promise<Array<{ address: string }>>;
export type Outgoing = { url?: string; data?: string; filename?: string; content_type?: string };
export type AgentContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

// signal-cli names stored attachments by their id; nothing else may be read
export function attachmentPath(dir: string, id: string) {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,10})?$/.test(id)) throw new Error("Invalid attachment id");
  return join(dir, id);
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${basename(command[0]!)} failed: ${(stderr.trim() || stdout.trim() || `exit ${code}`).slice(0, 300)}`);
  return stdout;
}

// SIGNAL_TRANSCRIBE_COMMAND gets the audio file as its last argument and prints the transcript
export async function transcribe(command: string | undefined, path: string) {
  if (!command) return undefined;
  const transcript = (await run([command, path])).trim();
  return transcript || undefined;
}

// Images over 1 MiB are shrunk to 1600 px JPEG with macOS sips; elsewhere they go as they are
async function shrink(path: string, contentType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const bytes = await readFile(path);
  if (bytes.length <= SHRINK_ABOVE || process.platform !== "darwin") return { bytes, mimeType: contentType };
  const dir = await mkdtemp(join(tmpdir(), "signal-mcp-"));
  try {
    await run(["/usr/bin/sips", "-s", "format", "jpeg", "-Z", "1600", path, "--out", join(dir, "image.jpg")]);
    return { bytes: await readFile(join(dir, "image.jpg")), mimeType: "image/jpeg" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readForAgent(path: string, contentType: string, transcript?: string): Promise<AgentContent[]> {
  if (contentType.startsWith("audio/")) {
    return [{ type: "text", text: transcript ? `Transcript of the voice note:\n${transcript}` : "A voice note; no transcript is available on this server." }];
  }
  if (contentType.startsWith("image/")) {
    const { bytes, mimeType } = await shrink(path, contentType);
    return [{ type: "image", data: bytes.toString("base64"), mimeType }];
  }
  const { size } = await stat(path);
  if (size > MAX_READ_BYTES) return [{ type: "text", text: `The file is ${Math.round(size / 1024 / 1024)} MB, more than the 10 MB this tool returns.` }];
  const bytes = await readFile(path);
  if (contentType.startsWith("text/") || contentType === "application/json") return [{ type: "text", text: bytes.toString("utf8") }];
  return [{ type: "resource", resource: { uri: `signal-attachment:${basename(path)}`, mimeType: contentType, blob: bytes.toString("base64") } }];
}

export function dataUri(bytes: Buffer, contentType: string, filename?: string) {
  const name = filename ? `;filename=${filename.replace(/[;,\s]/g, "_")}` : "";
  return `data:${contentType}${name};base64,${bytes.toString("base64")}`;
}

// https only, every hop's addresses public, at most three redirects, at most 25 MiB
export async function fetchPublic(raw: string, fetchImpl: typeof fetch = fetch, resolve: Resolve = (h) => lookup(h, { all: true })) {
  let url = new URL(raw);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Attachment URLs must be https");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await resolve(host);
    if (!addresses.length || !addresses.every((a) => publicAddress(a.address))) throw new Error("Attachment URLs must point to public addresses");
    const response = await fetchImpl(url.toString(), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location")!, url);
      continue;
    }
    if (!response.ok) throw new Error(`Fetching the attachment returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_SEND_BYTES) throw new Error("Attachments are limited to 25 MB");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_SEND_BYTES) throw new Error("Attachments are limited to 25 MB");
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    return { bytes, contentType, filename: decodeURIComponent(url.pathname.split("/").pop() || "") || undefined };
  }
  throw new Error("Too many redirects");
}

export async function outgoing(item: Outgoing, fetchImpl?: typeof fetch, resolve?: Resolve) {
  if (item.data) {
    const bytes = Buffer.from(item.data.replace(/^data:[^,]*,/, ""), "base64");
    if (!bytes.length) throw new Error("Attachment data must be base64");
    if (bytes.length > MAX_SEND_BYTES) throw new Error("Attachments are limited to 25 MB");
    return dataUri(bytes, item.content_type || "application/octet-stream", item.filename);
  }
  if (item.url) {
    const fetched = await fetchPublic(item.url, fetchImpl, resolve);
    return dataUri(fetched.bytes, item.content_type || fetched.contentType, item.filename || fetched.filename);
  }
  throw new Error("Each attachment needs url or data");
}
