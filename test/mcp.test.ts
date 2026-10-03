import { describe, expect, test } from "bun:test";
import { hasBearerToken } from "../src/auth";
import { SignalEvents } from "../src/events";
import { handleMcp, type Logged } from "../src/mcp";
import { incoming } from "../src/signal-cli";
import { publicDns, receiver, subscribeParams } from "./events.test";

const rpc = (body: object, token = "secret") => new Request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const events = new SignalEvents("/tmp/signal-mcp-test/endpoint.json", receiver().fetchImpl, publicDns);
const auth = { authorized: (header: string | null) => hasBearerToken(header, "secret"), resourceMetadataUrl: "https://mcp.example/signal/.well-known/oauth-protected-resource/mcp" };
function server() {
  const sent: string[] = [];
  const log: Logged[] = [{ from: "owner", text: "hey", at: "2026-10-03T10:00:00.000Z" }];
  const call = async (body: object, token?: string) => (await handleMcp(rpc(body, token), { ...auth, owner: "Sam", events, log, send: async (t) => { sent.push(t); } })).json() as any;
  return { sent, call };
}

describe("MCP endpoint", () => {
  test("refuses a missing or wrong bearer, and sends nothing", async () => {
    const { sent } = server();
    const response = await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_signal_message", arguments: { text: "hi" } } }, "wrong"), { ...auth, owner: "Sam", events, log: [], send: async (t) => { sent.push(t); } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mcp.example/signal/.well-known/oauth-protected-resource/mcp"');
    expect(sent).toEqual([]);
  });

  test("advertises MCP 2026-07-28 with the event and both tools", async () => {
    const { call } = server();
    const discover = await call({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    expect(discover.result).toMatchObject({ resultType: "complete", capabilities: { tools: {}, events: {} } });
    expect(discover.result.supportedVersions).toContain("2026-07-28");
    expect(discover.result._meta["io.modelcontextprotocol/serverInfo"].icons[0]).toMatchObject({ mimeType: "image/png", sizes: ["256x256"] });
    expect(discover.result._meta["io.modelcontextprotocol/serverInfo"].icons[0].src).toStartWith("data:image/png;base64,iVBORw0KGgo");
    expect((await call({ jsonrpc: "2.0", id: 2, method: "events/list" })).result.events.map((e: any) => e.name)).toEqual(["signal.message.received"]);
    expect((await call({ jsonrpc: "2.0", id: 3, method: "tools/list" })).result.tools.map((t: any) => t.name)).toEqual(["send_signal_message", "list_signal_messages"]);
  });

  test("sends tool text to the owner and lists the conversation", async () => {
    const { sent, call } = server();
    await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_signal_message", arguments: { text: "  on my way  " } } });
    expect(sent).toEqual(["on my way"]);
    const listed = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_signal_messages", arguments: {} } });
    expect(listed.result.content[0].text).toBe("[2026-10-03T10:00:00.000Z] Sam: hey");
  });

  test("reports a bad subscription as a JSON-RPC error", async () => {
    const { call } = server();
    expect((await call({ jsonrpc: "2.0", id: 6, method: "events/subscribe", params: { ...subscribeParams, name: "nope" } })).error.code).toBe(-32602);
  });
});

describe("signal-cli events", () => {
  const event = (envelope: object) => ({ jsonrpc: "2.0", method: "receive", params: { envelope } });
  test("keeps only the owner's messages", () => {
    expect(incoming(event({ sourceNumber: "+15550000001", dataMessage: { timestamp: 5, message: " hey ", attachments: [{ contentType: "image/jpeg" }] } }), "+15550000001"))
      .toEqual({ timestamp: 5, text: "hey", attachments: [{ contentType: "image/jpeg" }] });
    expect(incoming(event({ sourceNumber: "+15550000002", dataMessage: { timestamp: 5, message: "hi" } }), "+15550000001")).toBeNull();
    expect(incoming(event({ sourceNumber: "+15550000001", typingMessage: { action: "STARTED" } }), "+15550000001")).toBeNull();
    expect(incoming(event({ sourceNumber: "+15550000001", dataMessage: { timestamp: 5, reaction: { emoji: "👍" } } }), "+15550000001")).toBeNull();
  });
});
