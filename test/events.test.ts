import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { EVENT, SignalEvents, publicAddress, signWebhook, validSecret } from "../src/events";

const FILE = "/tmp/signal-mcp-test/subscriptions.json";
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
afterAll(() => rm("/tmp/signal-mcp-test", { recursive: true, force: true }));

// A fake ChatGPT receiver: checks each signature the way Standard Webhooks does and echoes challenges
export function receiver(options: { echo?: boolean; status?: number } = {}) {
  const posts: Array<{ headers: Headers; body: any }> = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = String(init.body);
    if (headers.get("webhook-signature") !== signWebhook(SECRET, headers.get("webhook-id")!, Number(headers.get("webhook-timestamp")), body)) return new Response("bad signature", { status: 401 });
    const parsed = JSON.parse(body);
    posts.push({ headers, body: parsed });
    if (parsed.type === "verification") return Response.json({ challenge: options.echo === false ? "nope" : parsed.challenge });
    return new Response(null, { status: options.status ?? 202 });
  };
  return { posts, fetchImpl };
}
export const publicDns = async () => [{ address: "104.18.1.1" }];
export const subscribeParams = { name: EVENT, arguments: {}, delivery: { mode: "webhook", url: "https://hooks.chatgpt.com/mcp-events/cb_1", secret: SECRET }, cursor: null };
const message = { message_id: "1791024888216", text: "hey", received_at: "2026-10-03T10:54:48.216Z", attachments: [] };

describe("Standard Webhooks signing", () => {
  test("matches the Standard Webhooks reference vector", () => {
    expect(signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}'))
      .toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  test("accepts only whsec_ secrets of 24 to 64 bytes", () => {
    expect(validSecret(SECRET)).toBe(true);
    expect(validSecret(`whsec_${Buffer.alloc(16).toString("base64")}`)).toBe(false);
    expect(validSecret("sk_123")).toBe(false);
  });

  test("refuses private callback addresses", () => {
    expect(publicAddress("104.18.1.1")).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.58", "100.101.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(publicAddress(address)).toBe(false);
  });
});

describe(EVENT, () => {
  test("verifies the callback, keeps the subscription across restarts and delivers signed events", async () => {
    await rm(FILE, { force: true });
    const hook = receiver();
    const sub = await new SignalEvents(FILE, hook.fetchImpl, publicDns).subscribe(subscribeParams);
    expect(sub.id).toMatch(/^sub_/);
    expect(hook.posts[0]!.body.type).toBe("verification");

    const restarted = new SignalEvents(FILE, hook.fetchImpl, publicDns);
    expect(await restarted.deliver(message)).toBe(1);
    const delivery = hook.posts.at(-1)!;
    expect(delivery.headers.get("webhook-id")).toBe(delivery.body.eventId);
    expect(delivery.headers.get("x-mcp-subscription-id")).toBe(sub.id);
    expect(delivery.body).toMatchObject({ name: EVENT, timestamp: message.received_at, data: message, cursor: null });

    expect((await restarted.subscribe(subscribeParams)).id).toBe(sub.id); // a refresh keeps its identity
    await restarted.unsubscribe({ name: EVENT, arguments: {}, delivery: { mode: "webhook", url: subscribeParams.delivery.url } });
    expect(await restarted.active()).toEqual([]);
  });

  test("refuses a callback that does not echo the challenge, or that resolves privately", async () => {
    await rm(FILE, { force: true });
    await expect(new SignalEvents(FILE, receiver({ echo: false }).fetchImpl, publicDns).subscribe(subscribeParams)).rejects.toMatchObject({ code: -32015 });
    await expect(new SignalEvents(FILE, receiver().fetchImpl, async () => [{ address: "127.0.0.1" }]).subscribe(subscribeParams)).rejects.toMatchObject({ code: -32015 });
  });

  test("drops a subscription the receiver says is gone", async () => {
    await rm(FILE, { force: true });
    await new SignalEvents(FILE, receiver().fetchImpl, publicDns).subscribe(subscribeParams);
    const gone = new SignalEvents(FILE, receiver({ status: 410 }).fetchImpl, publicDns);
    expect(await gone.deliver(message)).toBe(0);
    expect(await gone.active()).toEqual([]);
  });
});
