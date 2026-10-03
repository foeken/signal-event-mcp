// The part of signal-cli's HTTP daemon (signal-cli daemon --http) this server uses: its JSON-RPC endpoint for sending,
// reacting, typing and receipts, and its event stream for what arrives.
// https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc

type Json = Record<string, any>;
export type IncomingAttachment = { id: string; contentType: string; filename?: string; size?: number };
export type Incoming =
  | { kind: "message"; timestamp: number; text: string; attachments: IncomingAttachment[]; quote?: { timestamp: number; text?: string } }
  | { kind: "reaction"; timestamp: number; emoji: string; targetTimestamp: number; removed: boolean };

// What the owner sent to this account: a message or a reaction. Anything else (other senders, receipts, typing) is null.
export function incoming(event: Json, owner: string): Incoming | null {
  const envelope = event.params?.envelope ?? event.envelope;
  const message = envelope?.dataMessage;
  if (!message || message.remoteDelete) return null;
  if ((envelope.sourceNumber ?? envelope.source) !== owner) return null;
  const timestamp = Number(message.timestamp ?? envelope.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  if (message.reaction) {
    const r = message.reaction;
    const targetTimestamp = Number(r.targetSentTimestamp ?? r.targetTimestamp);
    if (typeof r.emoji !== "string" || !Number.isFinite(targetTimestamp)) return null;
    return { kind: "reaction", timestamp, emoji: r.emoji, targetTimestamp, removed: Boolean(r.isRemove) };
  }
  const text = typeof message.message === "string" ? message.message.trim() : "";
  const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
    .filter((a: Json) => typeof a.id === "string")
    .map((a: Json) => ({
      id: a.id,
      contentType: String(a.contentType ?? "application/octet-stream"),
      ...(typeof a.filename === "string" ? { filename: a.filename } : {}),
      ...(Number.isFinite(Number(a.size)) ? { size: Number(a.size) } : {}),
    }));
  if (!text && !attachments.length) return null;
  const quoted = Number(message.quote?.id ?? message.quote?.timestamp);
  return {
    kind: "message", timestamp, text, attachments,
    ...(Number.isFinite(quoted) ? { quote: { timestamp: quoted, ...(typeof message.quote?.text === "string" ? { text: message.quote.text } : {}) } } : {}),
  };
}

export class SignalCli {
  private nextId = 1;
  constructor(private readonly url: string, readonly account: string) {}

  async rpc(method: string, params: Json = {}) {
    const response = await fetch(`${this.url}/api/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: { account: this.account, ...params } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`signal-cli ${method} returned HTTP ${response.status}`);
    const body = await response.json() as Json;
    if (body.error) throw new Error(`signal-cli ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }

  // Attachments are file paths or data URIs (data:<type>;filename=<name>;base64,<data>); returns the sent timestamp
  async send(recipient: string, message: string, options: { attachments?: string[]; quote?: { timestamp: number; author: string; text: string } } = {}) {
    const result = await this.rpc("send", {
      recipient: [recipient],
      message,
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options.quote ? { quoteTimestamp: options.quote.timestamp, quoteAuthor: options.quote.author, quoteMessage: options.quote.text } : {}),
    });
    return Number(result?.timestamp);
  }

  react(recipient: string, emoji: string, targetAuthor: string, targetTimestamp: number, remove = false) {
    return this.rpc("sendReaction", { recipient: [recipient], emoji, targetAuthor, targetTimestamp, ...(remove ? { remove: true } : {}) });
  }

  typing(recipient: string, stop = false) {
    return this.rpc("sendTyping", { recipient: [recipient], ...(stop ? { stop: true } : {}) });
  }

  markRead(recipient: string, timestamps: number[]) {
    return this.rpc("sendReceipt", { recipient, targetTimestamp: timestamps, type: "read" });
  }

  // Server-sent events, reconnecting with backoff for as long as the process runs
  async *events(): AsyncGenerator<Json> {
    for (let delay = 500; ; delay = Math.min(delay * 2, 10_000)) {
      try {
        const response = await fetch(`${this.url}/api/v1/events`, { headers: { accept: "text/event-stream" } });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        console.log("[signal-cli] event stream connected");
        delay = 250;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (data) yield JSON.parse(data);
          }
        }
        throw new Error("stream ended");
      } catch (error) {
        console.error(`[signal-cli] event stream: ${String(error)}; reconnecting`);
        await Bun.sleep(delay);
      }
    }
  }
}
