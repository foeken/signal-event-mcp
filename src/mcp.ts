import { readFileSync } from "node:fs";
import { EVENT, RpcError, type SignalEvents } from "./events";

// The MCP endpoint (Streamable HTTP, plain JSON responses, stateless): one event, two tools. Descriptions name the
// owner (SIGNAL_OWNER_NAME) so the agent knows whose Signal this is.

export type Logged = { from: "owner" | "agent"; text: string; at: string };
const VERSION = "0.1.0";
const ICONS = [{ src: `data:image/png;base64,${readFileSync(new URL("../assets/signal-256.png", import.meta.url)).toString("base64")}`, mimeType: "image/png", sizes: ["256x256"] }];
const SERVER_INFO = { name: "signal", title: "Signal", version: VERSION, icons: ICONS };

export function describe(owner: string) {
  return {
    instructions: `${owner}'s Signal. Subscribe to ${EVENT} to get the Signal messages ${owner} sends you, and answer each with send_signal_message: ${owner} reads Signal, not this chat.`,
    tools: [{
      name: "send_signal_message",
      title: `Send Signal message to ${owner}`,
      description: `Send ${owner} a Signal message. Use it to answer a ${EVENT} event. Write like a text message; split long answers into a few short messages.`,
      inputSchema: { type: "object", properties: { text: { type: "string", description: "The message, plain text." } }, required: ["text"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, {
      name: "list_signal_messages",
      title: `Recent Signal messages with ${owner}`,
      description: `The latest messages between ${owner} and you on Signal since this server started, oldest first, for context.`,
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many, default 20." } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }],
    event: {
      name: EVENT,
      description: `${owner} sent you a Signal message. Answer with send_signal_message.`,
      delivery: ["webhook"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      payloadSchema: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Signal's timestamp for the message." },
          text: { type: "string", description: `What ${owner} wrote; empty when only attachments were sent.` },
          received_at: { type: "string", description: "When it was sent, ISO 8601." },
          attachments: { type: "array", items: { type: "string" }, description: "Content types of attachments, which are not passed on." },
        },
        required: ["message_id", "text", "received_at", "attachments"],
        additionalProperties: false,
      },
    },
  };
}

const reply = (id: unknown, result: object) => Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
const fail = (id: unknown, code: number, message: string, data?: object, status = 200) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, { status });
const toolText = (id: unknown, text: string, isError = false) => reply(id, { content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

export type McpOptions = {
  authorized: (header: string | null) => boolean | Promise<boolean>;
  resourceMetadataUrl: string;
  events: SignalEvents;
  send: (text: string) => Promise<unknown>;
  log: Logged[];
  owner: string;
};

export async function handleMcp(request: Request, options: McpOptions) {
  const described = describe(options.owner);
  if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
  if (!await options.authorized(request.headers.get("authorization"))) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${options.resourceMetadataUrl}"` } });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });

  let body: any;
  try { body = await request.json(); } catch { return fail(null, -32700, "Parse error", undefined, 400); }
  const { id, method, params } = body ?? {};
  if (typeof method !== "string") return fail(id, -32600, "Invalid request", undefined, 400);
  if (id === undefined) return new Response(null, { status: 202 }); // a notification

  try {
    switch (method) {
      case "server/discover":
        return reply(id, {
          supportedVersions: ["2026-07-28", "2025-06-18", "2025-03-26"],
          capabilities: { tools: {}, events: {} },
          instructions: described.instructions,
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        });
      case "initialize":
        return reply(id, {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {}, events: {} },
          serverInfo: SERVER_INFO,
          instructions: described.instructions,
        });
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: described.tools });
      case "events/list":
        return reply(id, { events: [described.event] });
      case "events/subscribe":
        return reply(id, await options.events.subscribe(params));
      case "events/unsubscribe":
        return reply(id, await options.events.unsubscribe(params));
      case "tools/call": {
        if (params?.name === "list_signal_messages") {
          const limit = Math.min(Math.max(Number(params.arguments?.limit) || 20, 1), 50);
          const recent = options.log.slice(-limit);
          return toolText(id, recent.length ? recent.map((m) => `[${m.at}] ${m.from === "owner" ? options.owner : "You"}: ${m.text}`).join("\n") : "No Signal messages since the server started.");
        }
        if (params?.name !== "send_signal_message") return fail(id, -32602, `Unknown tool: ${params?.name}`);
        const text = typeof params.arguments?.text === "string" ? params.arguments.text.trim() : "";
        if (!text || text.length > 4_000) return toolText(id, "text must be 1 to 4000 characters", true);
        try {
          await options.send(text);
          return toolText(id, `Sent to ${options.owner} on Signal.`);
        } catch (error) {
          return toolText(id, `Signal refused the message: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) return fail(id, error.code, error.message, error.data);
    return fail(id, -32603, error instanceof Error ? error.message : String(error));
  }
}
