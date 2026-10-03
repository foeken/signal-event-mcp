import { describe, expect, test } from "bun:test";
import type { Outgoing } from "../src/attachments";
import { hasBearerToken } from "../src/auth";
import { SignalEvents } from "../src/events";
import { handleMcp, type Actions, type Logged } from "../src/mcp";
import { incoming } from "../src/signal-cli";
import { publicDns, receiver, subscribeParams } from "./events.test";

const rpc = (body: object, token = "secret") => new Request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const events = new SignalEvents("/tmp/signal-mcp-test/endpoint.json", receiver().fetchImpl, publicDns);
const auth = { authorized: (header: string | null) => hasBearerToken(header, "secret"), resourceMetadataUrl: "https://mcp.example/signal/.well-known/oauth-protected-resource/mcp" };
const tool = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

function server() {
  const sent: Array<{ text: string; attachments: Outgoing[]; replyTo?: string }> = [];
  const reactions: string[] = [];
  const actions: Actions = {
    send: async (text, attachments, replyTo) => { sent.push({ text, attachments, replyTo }); return "1791030000000"; },
    react: async (messageId, emoji, remove) => { reactions.push(`${messageId} ${emoji}${remove ? " removed" : ""}`); },
    attachment: async (id) => id === "img.jpg" ? [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] : (() => { throw new Error(`Unknown attachment ${id}`); })(),
  };
  const log: Logged[] = [{ id: "1791029000000", from: "owner", text: "hey", at: "2026-10-03T10:00:00.000Z", attachments: ["img.jpg (image/jpeg)"] }];
  const call = async (body: object, token?: string) => (await handleMcp(rpc(body, token), { ...auth, owner: "Sam", events, log, actions })).json() as any;
  return { sent, reactions, call, actions };
}

describe("MCP endpoint", () => {
  test("refuses a missing or wrong bearer, and does nothing", async () => {
    const { sent, actions } = server();
    const response = await handleMcp(rpc(tool(1, "send_signal_message", { text: "hi" }), "wrong"), { ...auth, owner: "Sam", events, log: [], actions });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mcp.example/signal/.well-known/oauth-protected-resource/mcp"');
    expect(sent).toEqual([]);
  });

  test("advertises MCP 2026-07-28 with the event and four tools, named for the owner", async () => {
    const { call } = server();
    const discover = await call({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    expect(discover.result).toMatchObject({ resultType: "complete", capabilities: { tools: {}, events: {} } });
    expect(discover.result.supportedVersions).toContain("2026-07-28");
    expect(discover.result.instructions).toStartWith("Sam's Signal.");
    expect(discover.result._meta["io.modelcontextprotocol/serverInfo"].icons[0].src).toStartWith("data:image/png;base64,iVBORw0KGgo");
    const listed = (await call({ jsonrpc: "2.0", id: 2, method: "events/list" })).result.events;
    expect(listed.map((e: any) => e.name)).toEqual(["signal.message.received"]);
    expect(Object.keys(listed[0].payloadSchema.properties)).toEqual(["message_id", "kind", "text", "received_at", "attachments", "reply_to_message_id", "reaction"]);
    expect((await call({ jsonrpc: "2.0", id: 3, method: "tools/list" })).result.tools.map((t: any) => t.name))
      .toEqual(["send_signal_message", "react_to_signal_message", "get_signal_attachment", "list_signal_messages"]);
  });

  test("sends text, attachments and quoted replies", async () => {
    const { sent, call } = server();
    expect((await call(tool(4, "send_signal_message", { text: "  on my way  " }))).result.content[0].text).toBe("Sent to Sam on Signal (message 1791030000000).");
    await call(tool(5, "send_signal_message", { attachments: [{ url: "https://example.com/a.png" }], reply_to_message_id: "1791029000000" }));
    expect(sent).toEqual([{ text: "on my way", attachments: [], replyTo: undefined }, { text: "", attachments: [{ url: "https://example.com/a.png" }], replyTo: "1791029000000" }]);
    expect((await call(tool(6, "send_signal_message", { text: " " }))).result.isError).toBe(true);
  });

  test("reacts, opens the owner's attachments and lists the conversation with ids", async () => {
    const { reactions, call } = server();
    await call(tool(7, "react_to_signal_message", { message_id: "1791029000000", emoji: "✅" }));
    await call(tool(8, "react_to_signal_message", { message_id: "1791029000000", emoji: "✅", remove: true }));
    expect(reactions).toEqual(["1791029000000 ✅", "1791029000000 ✅ removed"]);
    expect((await call(tool(9, "get_signal_attachment", { attachment_id: "img.jpg" }))).result.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
    expect((await call(tool(10, "get_signal_attachment", { attachment_id: "other.jpg" }))).result.isError).toBe(true);
    expect((await call(tool(11, "list_signal_messages", {}))).result.content[0].text).toBe("[2026-10-03T10:00:00.000Z] (1791029000000) Sam: hey [attachments: img.jpg (image/jpeg)]");
  });

  test("reports a bad subscription as a JSON-RPC error", async () => {
    const { call } = server();
    expect((await call({ jsonrpc: "2.0", id: 12, method: "events/subscribe", params: { ...subscribeParams, name: "nope" } })).error.code).toBe(-32602);
  });
});

describe("signal-cli events", () => {
  const event = (envelope: object) => ({ jsonrpc: "2.0", method: "receive", params: { envelope } });
  const owner = "+15550000001";

  test("keeps the owner's messages with attachments and quotes", () => {
    expect(incoming(event({ sourceNumber: owner, dataMessage: { timestamp: 5, message: " hey ", quote: { id: 3, text: "earlier" }, attachments: [{ id: "a1.jpg", contentType: "image/jpeg", filename: "IMG.jpg", size: 1200 }] } }), owner))
      .toEqual({ kind: "message", timestamp: 5, text: "hey", attachments: [{ id: "a1.jpg", contentType: "image/jpeg", filename: "IMG.jpg", size: 1200 }], quote: { timestamp: 3, text: "earlier" } });
  });

  test("keeps the owner's reactions", () => {
    expect(incoming(event({ sourceNumber: owner, dataMessage: { timestamp: 6, reaction: { emoji: "👍", targetSentTimestamp: 5, isRemove: false } } }), owner))
      .toEqual({ kind: "reaction", timestamp: 6, emoji: "👍", targetTimestamp: 5, removed: false });
  });

  test("ignores everyone else and everything else", () => {
    expect(incoming(event({ sourceNumber: "+15550000002", dataMessage: { timestamp: 5, message: "hi" } }), owner)).toBeNull();
    expect(incoming(event({ sourceNumber: owner, typingMessage: { action: "STARTED" } }), owner)).toBeNull();
    expect(incoming(event({ sourceNumber: owner, receiptMessage: { isRead: true } }), owner)).toBeNull();
  });
});
