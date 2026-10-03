import { readFileSync } from "node:fs";
import type { AgentContent, Outgoing } from "./attachments";
import { EVENT, RpcError, type SignalEvents } from "./events";

// The MCP endpoint (Streamable HTTP, plain JSON responses, stateless): one event and four tools. Descriptions name the
// owner (SIGNAL_OWNER_NAME) so the agent knows whose Signal this is.

export type Logged = { id: string; from: "owner" | "agent"; text: string; at: string; attachments?: string[] };
export type Actions = {
  send: (text: string, attachments: Outgoing[], replyTo?: string) => Promise<string>;
  react: (messageId: string, emoji: string, remove: boolean) => Promise<void>;
  attachment: (id: string) => Promise<AgentContent[]>;
};
const VERSION = "0.2.0";
const ICONS = [{ src: `data:image/png;base64,${readFileSync(new URL("../assets/signal-256.png", import.meta.url)).toString("base64")}`, mimeType: "image/png", sizes: ["256x256"] }];
const SERVER_INFO = { name: "signal", title: "Signal", version: VERSION, icons: ICONS };

export function describe(owner: string) {
  const messageId = { type: "string", description: "A message id from an event or list_signal_messages." };
  return {
    instructions: `${owner}'s Signal. Subscribe to ${EVENT} to get what ${owner} sends you on Signal (messages, voice notes as transcripts, attachments, reactions), and answer with send_signal_message: ${owner} reads Signal, not this chat.`,
    tools: [{
      name: "send_signal_message",
      title: `Send Signal message to ${owner}`,
      description: `Send ${owner} a Signal message, optionally with attachments (images or files, up to 25 MB each, by https URL or base64 data) and as a reply to one of the messages. Use it to answer a ${EVENT} event. Write like a text message; split long answers into a few short messages.`,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message, plain text. May be empty when sending attachments." },
          attachments: {
            type: "array", maxItems: 5,
            items: {
              type: "object",
              properties: {
                url: { type: "string", description: "Public https URL to fetch the file from." },
                data: { type: "string", description: "The file as base64, instead of url." },
                filename: { type: "string" },
                content_type: { type: "string", description: "MIME type, e.g. image/png; taken from the URL's response when omitted." },
              },
              additionalProperties: false,
            },
          },
          reply_to_message_id: { ...messageId, description: "Quote this message in the reply." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, {
      name: "react_to_signal_message",
      title: "React on Signal",
      description: `React with an emoji to a Signal message from ${owner} or from you, or remove your reaction. Good for a quick acknowledgement, or a ✅ when something is done.`,
      inputSchema: {
        type: "object",
        properties: { message_id: messageId, emoji: { type: "string", description: "One emoji." }, remove: { type: "boolean", description: "Remove this reaction instead." } },
        required: ["message_id", "emoji"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, {
      name: "get_signal_attachment",
      title: "Open a Signal attachment",
      description: `Get an attachment ${owner} sent: images as images, voice notes as a transcript, text as text, other files up to 10 MB as data.`,
      inputSchema: { type: "object", properties: { attachment_id: { type: "string", description: "An attachment id from an event or list_signal_messages." } }, required: ["attachment_id"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, {
      name: "list_signal_messages",
      title: `Recent Signal messages with ${owner}`,
      description: `The latest messages between ${owner} and you on Signal, oldest first, with their ids, for context.`,
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many, default 20." } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }],
    event: {
      name: EVENT,
      description: `${owner} sent you something on Signal: a message, a voice note (transcribed) or attachments, or a reaction. Answer with send_signal_message.`,
      delivery: ["webhook"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      payloadSchema: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Signal's timestamp for the message; use it to reply or react." },
          kind: { type: "string", enum: ["message", "reaction"] },
          text: { type: "string", description: `What ${owner} wrote, followed by the transcript of any voice note.` },
          received_at: { type: "string", description: "When it was sent, ISO 8601." },
          attachments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Open it with get_signal_attachment." },
                content_type: { type: "string" },
                filename: { type: "string" },
                size: { type: "integer" },
                transcript: { type: "string", description: "For voice notes." },
              },
              required: ["id", "content_type"],
            },
          },
          reply_to_message_id: { type: "string", description: `The message ${owner} quoted, if any.` },
          reaction: {
            type: "object",
            description: `For kind reaction: ${owner}'s emoji on a message.`,
            properties: { emoji: { type: "string" }, target_message_id: { type: "string" }, target_text: { type: "string" }, removed: { type: "boolean" } },
            required: ["emoji", "target_message_id", "removed"],
          },
        },
        required: ["message_id", "kind", "text", "received_at", "attachments"],
      },
    },
  };
}

const reply = (id: unknown, result: object) => Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
const fail = (id: unknown, code: number, message: string, data?: object, status = 200) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, { status });
const toolText = (id: unknown, text: string, isError = false) => reply(id, { content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export type McpOptions = {
  authorized: (header: string | null) => boolean | Promise<boolean>;
  resourceMetadataUrl: string;
  events: SignalEvents;
  actions: Actions;
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
      case "tools/call":
        return await callTool(id, params?.name, params?.arguments ?? {}, options);
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) return fail(id, error.code, error.message, error.data);
    return fail(id, -32603, errorText(error));
  }
}

async function callTool(id: unknown, name: unknown, args: any, options: McpOptions) {
  switch (name) {
    case "list_signal_messages": {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const recent = options.log.slice(-limit);
      return toolText(id, recent.length
        ? recent.map((m) => `[${m.at}] (${m.id}) ${m.from === "owner" ? options.owner : "You"}: ${m.text}${m.attachments?.length ? ` [attachments: ${m.attachments.join(", ")}]` : ""}`).join("\n")
        : "No Signal messages since the server started.");
    }
    case "send_signal_message": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const attachments: Outgoing[] = Array.isArray(args.attachments) ? args.attachments.slice(0, 5) : [];
      if ((!text && !attachments.length) || text.length > 4_000) return toolText(id, "Send 1 to 4000 characters of text, or at least one attachment.", true);
      try {
        const sent = await options.actions.send(text, attachments, typeof args.reply_to_message_id === "string" ? args.reply_to_message_id : undefined);
        return toolText(id, `Sent to ${options.owner} on Signal (message ${sent}).`);
      } catch (error) {
        return toolText(id, `Not sent: ${errorText(error)}`, true);
      }
    }
    case "react_to_signal_message": {
      if (typeof args.message_id !== "string" || typeof args.emoji !== "string" || !args.emoji.trim()) return toolText(id, "message_id and emoji are required.", true);
      try {
        await options.actions.react(args.message_id, args.emoji.trim(), args.remove === true);
        return toolText(id, args.remove === true ? "Reaction removed." : "Reacted.");
      } catch (error) {
        return toolText(id, `Not reacted: ${errorText(error)}`, true);
      }
    }
    case "get_signal_attachment": {
      if (typeof args.attachment_id !== "string") return toolText(id, "attachment_id is required.", true);
      try {
        return reply(id, { content: await options.actions.attachment(args.attachment_id) });
      } catch (error) {
        return toolText(id, errorText(error), true);
      }
    }
    default:
      return fail(id, -32602, `Unknown tool: ${String(name)}`);
  }
}
