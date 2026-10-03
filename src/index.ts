import { homedir } from "node:os";
import { join } from "node:path";
import { SignalEvents } from "./events";
import { handleMcp, type Logged } from "./mcp";
import { OAuth } from "./oauth";
import { SignalCli, incoming } from "./signal-cli";

// signal-event-mcp: one person's Signal as an MCP server for their agent. Configuration comes from the environment.
const need = (name: string) => process.env[name]?.trim() || (() => { throw new Error(`${name} is required`); })();
const signal = new SignalCli(process.env.SIGNAL_RPC_URL?.trim() || "http://127.0.0.1:8080", need("SIGNAL_ACCOUNT"));
const owner = need("SIGNAL_OWNER");
const ownerName = process.env.SIGNAL_OWNER_NAME?.trim() || "the owner";
const port = Number(process.env.SIGNAL_MCP_PORT || 23387);
const stateDir = process.env.SIGNAL_MCP_STATE?.trim() || join(homedir(), ".config/signal-mcp");
const events = new SignalEvents(join(stateDir, "subscriptions.json"));
// the public base URL ChatGPT sees (a proxy in front may add a path prefix and strip it before requests arrive here)
const oauth = new OAuth(join(stateDir, "oauth.json"), need("SIGNAL_MCP_PUBLIC_URL"), need("SIGNAL_MCP_TOKEN"));

const log: Logged[] = [];
const remember = (entry: Logged) => { log.push(entry); if (log.length > 50) log.shift(); };

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => await oauth.handle(request) ?? handleMcp(request, {
    authorized: (header) => oauth.authorized(header),
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    events,
    log,
    owner: ownerName,
    send: async (text) => {
      await signal.send(owner, text);
      remember({ from: "agent", text, at: new Date().toISOString() });
      console.log("[signal-mcp] sent a message to the owner");
    },
  }),
});
console.log(`[signal-mcp] listening on 127.0.0.1:${port}/mcp; ${(await events.active()).length} active subscription(s)`);

for await (const event of signal.events()) {
  const message = incoming(event, owner);
  if (!message) continue;
  const receivedAt = new Date(message.timestamp).toISOString();
  remember({ from: "owner", text: message.text || `(${message.attachments.map((a) => a.contentType).join(", ")})`, at: receivedAt });
  const accepted = await events.deliver({
    message_id: String(message.timestamp),
    text: message.text,
    received_at: receivedAt,
    attachments: message.attachments.map((a) => a.contentType),
  });
  console.log(`[signal-mcp] message ${message.timestamp} delivered to ${accepted} subscription(s)`);
}
