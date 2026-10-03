import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { dirname } from "node:path";

// MCP Events, webhook delivery, as ChatGPT implements it (https://developers.openai.com/plugins/build/mcp-events):
// ChatGPT subscribes with a callback URL and a whsec_ secret, the callback is verified with a signed challenge, and
// each Signal message from the owner is POSTed there signed per Standard Webhooks. Subscriptions survive restarts.

export const EVENT = "signal.message.received";
const DAY = 24 * 60 * 60 * 1_000;
const MIN_TTL = 5 * 60 * 1_000;
const RETRIES = [1_000, 3_000, 9_000];

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Resolve = (host: string) => Promise<Array<{ address: string }>>;
type Subscription = { id: string; name: string; url: string; secret: string; expiresAt: number };
export type SignalEventData = { message_id: string; text: string; received_at: string; attachments: string[] };

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: object) { super(message); }
}

// Standard Webhooks: base64 HMAC-SHA256 over "id.timestamp.body" with the decoded whsec_ key
export function signWebhook(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function validSecret(secret: unknown): secret is string {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const bytes = Buffer.from(secret.slice(6), "base64").length;
  return bytes >= 24 && bytes <= 64;
}

const blocked = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(net, bits, "ipv6");
export function publicAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip) === 4 ? "ipv4" : isIP(ip) === 6 ? "ipv6" : null;
  return family !== null && !blocked.check(ip, family);
}

export class SignalEvents {
  private subscriptions = new Map<string, Subscription>();
  private verified = new Map<string, number>(); // callback url -> verified until
  private loaded?: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly resolve: Resolve = (host) => lookup(host, { all: true }),
    private readonly now = () => Date.now(),
  ) {}

  private load() {
    return this.loaded ??= readFile(this.file, "utf8").then((raw) => {
      for (const sub of JSON.parse(raw) as Subscription[]) this.subscriptions.set(sub.id, sub);
    }, () => {}); // none yet
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify([...this.subscriptions.values()])}\n`, { mode: 0o600 });
  }

  async active() {
    await this.load();
    return [...this.subscriptions.values()].filter((sub) => sub.expiresAt > this.now());
  }

  private async checkCallback(raw: unknown) {
    let url: URL;
    try { url = new URL(String(raw)); } catch { throw new RpcError(-32602, "delivery.url must be an https URL"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new RpcError(-32602, "delivery.url must be an https URL");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await this.resolve(host).catch(() => []);
    // ponytail: resolved here and again by fetch; only ChatGPT (OpenAI addresses, bearer token) can reach this server
    if (!addresses.length || !addresses.every((a) => publicAddress(a.address))) throw new RpcError(-32015, "CallbackEndpointError", { reason: "connection_refused" });
    return url.toString();
  }

  private post(sub: Pick<Subscription, "id" | "url" | "secret">, id: string, body: string) {
    const timestamp = Math.floor(this.now() / 1_000);
    return this.fetchImpl(sub.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook(sub.secret, id, timestamp, body),
        "x-mcp-subscription-id": sub.id,
      },
      body,
    });
  }

  private async verify(sub: Subscription) {
    if ((this.verified.get(sub.url) ?? 0) > this.now()) return;
    const challenge = randomBytes(24).toString("base64url");
    let response: Response;
    try {
      response = await this.post(sub, `msg_verification_${randomBytes(8).toString("hex")}`, JSON.stringify({ type: "verification", challenge }));
    } catch (error) {
      throw new RpcError(-32015, "CallbackEndpointError", { reason: /timeout|abort/i.test(String(error)) ? "timeout" : "connection_refused" });
    }
    if (!response.ok) throw new RpcError(-32015, "CallbackEndpointError", { reason: response.status >= 500 ? "http_5xx" : "http_4xx" });
    const echoed = Buffer.from(String((await response.json().catch(() => ({})) as { challenge?: unknown }).challenge ?? ""));
    const expected = Buffer.from(challenge);
    if (echoed.length !== expected.length || !timingSafeEqual(echoed, expected)) throw new RpcError(-32015, "CallbackEndpointError", { reason: "challenge_failed" });
    this.verified.set(sub.url, this.now() + DAY);
  }

  async subscribe(params: any) {
    await this.load();
    if (params?.name !== EVENT) throw new RpcError(-32602, `Unknown event: ${params?.name}`);
    if (params.arguments && Object.keys(params.arguments).length) throw new RpcError(-32602, `${EVENT} takes no arguments`);
    if (params.delivery?.mode !== "webhook") throw new RpcError(-32602, "Only webhook delivery is supported");
    if (!validSecret(params.delivery.secret)) throw new RpcError(-32602, "delivery.secret must be whsec_ with 24 to 64 base64-encoded bytes");
    const url = await this.checkCallback(params.delivery.url);
    const id = `sub_${createHash("sha256").update(`${url}\n${EVENT}\n{}`).digest("hex").slice(0, 24)}`;
    const ttl = typeof params.ttlMs === "number" ? Math.min(Math.max(params.ttlMs, MIN_TTL), DAY) : DAY;
    const sub = { id, name: EVENT, url, secret: params.delivery.secret, expiresAt: this.now() + ttl };
    await this.verify(sub);
    this.subscriptions.set(id, sub);
    await this.save();
    return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
  }

  async unsubscribe(params: any) {
    await this.load();
    for (const sub of this.subscriptions.values()) {
      if (sub.name === params?.name && sub.url === String(params?.delivery?.url ?? "")) this.subscriptions.delete(sub.id);
    }
    await this.save();
    return {};
  }

  // One signed POST per active subscription, retried on failure; how many accepted it
  async deliver(data: SignalEventData) {
    let accepted = 0;
    for (const sub of await this.active()) {
      const eventId = `evt_signal_${data.message_id}`;
      const body = JSON.stringify({ eventId, name: EVENT, timestamp: data.received_at, data, cursor: null });
      for (let attempt = 0; ; attempt++) {
        const status = await this.post(sub, eventId, body).then((r) => r.status, () => 0);
        if (status >= 200 && status < 300) { accepted++; break; }
        if (status === 410) { this.subscriptions.delete(sub.id); await this.save(); break; }
        if (status === 413 || attempt >= RETRIES.length) { console.error(`[signal-mcp] delivery to ${sub.id} failed with ${status || "no response"}`); break; }
        await Bun.sleep(RETRIES[attempt]!);
      }
    }
    return accepted;
  }
}
