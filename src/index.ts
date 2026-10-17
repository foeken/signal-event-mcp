import { homedir } from "node:os";
import { join } from "node:path";
import { attachmentPath, outgoing, readForAgent, transcribe } from "./attachments";
import { hasBearerToken } from "./auth";
import { SignalEvents, type SignalEventData } from "./events";
import { handleMcp, type Logged } from "./mcp";
import { OAuth } from "./oauth";
import { SignalCli, incoming, type IncomingAttachment } from "./signal-cli";

// signal-event-mcp: one person's Signal as an MCP server for their agent. Configuration comes from the environment.
const need = (name: string) => process.env[name]?.trim() || (() => { throw new Error(`${name} is required`); })();
const signal = new SignalCli(process.env.SIGNAL_RPC_URL?.trim() || "http://127.0.0.1:8080", need("SIGNAL_ACCOUNT"));
const owner = need("SIGNAL_OWNER");
const ownerName = process.env.SIGNAL_OWNER_NAME?.trim() || "the owner";
const port = Number(process.env.SIGNAL_MCP_PORT || 23387);
const stateDir = process.env.SIGNAL_MCP_STATE?.trim() || join(homedir(), ".config/signal-mcp");
const attachmentsDir = process.env.SIGNAL_ATTACHMENTS_DIR?.trim() || join(homedir(), ".local/share/signal-cli/attachments");
const transcribeCommand = process.env.SIGNAL_TRANSCRIBE_COMMAND?.trim() || undefined;
const relayToken = process.env.SIGNAL_RELAY_TOKEN?.trim() || undefined;
const events = new SignalEvents(join(stateDir, "subscriptions.json"));
// the public base URL the agent sees (a proxy in front may add a path prefix and strip it before requests arrive here)
const oauth = new OAuth(join(stateDir, "oauth.json"), need("SIGNAL_MCP_PUBLIC_URL"), need("SIGNAL_MCP_TOKEN"));

const log: Logged[] = [];
const remember = (entry: Logged) => { log.push(entry); if (log.length > 100) log.shift(); };
const owned = new Map<string, IncomingAttachment & { transcript?: string }>(); // only the owner's attachments can be opened
const found = (messageId: string) => log.find((m) => m.id === messageId) ?? (() => { throw new Error(`Unknown message ${messageId}; use list_signal_messages for ids`); })();

// "typing…" from when an event is delivered until the agent answers, for at most two minutes
let typing: ReturnType<typeof setInterval> | undefined;
function startTyping() {
  stopTyping(false);
  const until = Date.now() + 120_000;
  const tick = () => { if (Date.now() > until) stopTyping(); else signal.typing(owner).catch(() => {}); };
  tick();
  typing = setInterval(tick, 10_000);
}
function stopTyping(tell = true) {
  if (!typing) return;
  clearInterval(typing);
  typing = undefined;
  if (tell) signal.typing(owner, true).catch(() => {});
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: 40 * 1024 * 1024, // base64 attachments
  fetch: async (request) => new URL(request.url).pathname === "/relay" ? relay(request) : await oauth.handle(request) ?? handleMcp(request, {
    authorized: (header) => oauth.authorized(header),
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    events,
    log,
    owner: ownerName,
    actions: {
      async send(text, attachments, replyTo) {
        const files = await Promise.all(attachments.map((item) => outgoing(item)));
        const quoted = replyTo ? found(replyTo) : undefined;
        stopTyping(false);
        const timestamp = await signal.send(owner, text, {
          attachments: files,
          ...(quoted ? { quote: { timestamp: Number(quoted.id), author: quoted.from === "owner" ? owner : signal.account, text: quoted.text } } : {}),
        });
        remember({ id: String(timestamp), from: "agent", text, at: new Date().toISOString(), ...(files.length ? { attachments: attachments.map((a) => a.filename || a.url || "file") } : {}) });
        console.log(`[signal-mcp] sent a message${files.length ? ` with ${files.length} attachment(s)` : ""} to the owner`);
        return String(timestamp);
      },
      async react(messageId, emoji, remove) {
        const target = found(messageId);
        await signal.react(owner, emoji, target.from === "owner" ? owner : signal.account, Number(target.id), remove);
        console.log("[signal-mcp] reacted to a message");
      },
      async attachment(id) {
        const known = owned.get(id);
        if (!known) throw new Error(`Unknown attachment ${id}`);
        return readForAgent(attachmentPath(attachmentsDir, id), known.contentType, known.transcript);
      },
    },
  }),
});
console.log(`[signal-mcp] listening on 127.0.0.1:${port}/mcp; ${(await events.active()).length} active subscription(s)${transcribeCommand ? "; voice notes are transcribed" : ""}`);

async function deliver(data: SignalEventData, markRead: boolean) {
  const accepted = await events.deliver(data);
  console.log(`[signal-mcp] ${data.kind} ${data.message_id} delivered to ${accepted} subscription(s)`);
  if (!accepted || !markRead) return accepted;
  signal.markRead(owner, [Number(data.message_id)]).catch(() => {});
  startTyping();
  return accepted;
}

// POST /relay: a helper on this machine (a home voice assistant) passes the agent a message for the owner, as an
// event like a Signal message, labelled as relayed. Off unless SIGNAL_RELAY_TOKEN is set; it needs that token, which
// cannot do anything else, and is refused through the HTTPS proxy (forwarding headers): this machine only.
async function relay(request: Request) {
  const local = !request.headers.has("x-forwarded-for") && !request.headers.has("forwarded");
  if (!relayToken || request.method !== "POST" || !local || !hasBearerToken(request.headers.get("authorization"), relayToken)) {
    return new Response("Not found", { status: 404 });
  }
  const body = await request.json().catch(() => null) as { text?: unknown; from?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const from = typeof body?.from === "string" && body.from.trim() ? body.from.trim().slice(0, 60) : "a helper";
  if (!text || text.length > 4000) return Response.json({ error: "text must be 1 to 4000 characters" }, { status: 400 });
  const now = Date.now();
  const said = `(Relayed by ${from}, not typed on ${ownerName}'s Signal; who said it is not verified) ${text}`;
  remember({ id: String(now), from: "owner", text: said, at: new Date(now).toISOString() });
  const delivered = await deliver({ message_id: String(now), kind: "message", text: said, received_at: new Date(now).toISOString(), attachments: [] }, false);
  return Response.json({ delivered });
}

for await (const event of signal.events()) {
  const message = incoming(event, owner);
  if (!message) continue;
  const receivedAt = new Date(message.timestamp).toISOString();

  if (message.kind === "reaction") {
    const target = log.find((m) => m.id === String(message.targetTimestamp));
    await deliver({
      message_id: String(message.timestamp), kind: "reaction", text: "", received_at: receivedAt, attachments: [],
      reaction: { emoji: message.emoji, target_message_id: String(message.targetTimestamp), ...(target ? { target_text: target.text } : {}), removed: message.removed },
    }, false);
    continue;
  }

  const attachments = await Promise.all(message.attachments.map(async (a) => {
    const transcript = a.contentType.startsWith("audio/")
      ? await transcribe(transcribeCommand, attachmentPath(attachmentsDir, a.id)).catch((error) => { console.error(`[signal-mcp] transcription failed: ${String(error)}`); return undefined; })
      : undefined;
    const known = { ...a, ...(transcript ? { transcript } : {}) };
    owned.set(a.id, known);
    return known;
  }));
  const transcripts = attachments.flatMap((a) => a.transcript ? [`(voice note) ${a.transcript}`] : []);
  const text = [message.text, ...transcripts].filter(Boolean).join("\n\n");
  remember({ id: String(message.timestamp), from: "owner", text, at: receivedAt, ...(attachments.length ? { attachments: attachments.map((a) => `${a.id} (${a.contentType})`) } : {}) });
  await deliver({
    message_id: String(message.timestamp), kind: "message", text, received_at: receivedAt,
    attachments: attachments.map((a) => ({ id: a.id, content_type: a.contentType, ...(a.filename ? { filename: a.filename } : {}), ...(a.size ? { size: a.size } : {}), ...(a.transcript ? { transcript: a.transcript } : {}) })),
    ...(message.quote ? { reply_to_message_id: String(message.quote.timestamp) } : {}),
  }, true);
}
