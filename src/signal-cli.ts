// The part of signal-cli's HTTP daemon (signal-cli daemon --http) this server uses: its JSON-RPC endpoint for sending,
// and its event stream for what arrives. https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc

type Json = Record<string, any>;
export type Incoming = { timestamp: number; text: string; attachments: Array<{ contentType: string }> };

// A message the owner sent to this account; anything else (other senders, receipts, typing, reactions) is null
export function incoming(event: Json, from: string): Incoming | null {
  const envelope = event.params?.envelope ?? event.envelope;
  const message = envelope?.dataMessage;
  if (!message || message.remoteDelete || message.reaction) return null;
  if ((envelope.sourceNumber ?? envelope.source) !== from) return null;
  const timestamp = Number(message.timestamp ?? envelope.timestamp);
  const text = typeof message.message === "string" ? message.message.trim() : "";
  const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map((a: Json) => ({ contentType: String(a.contentType ?? "application/octet-stream") }));
  if (!Number.isFinite(timestamp) || (!text && !attachments.length)) return null;
  return { timestamp, text, attachments };
}

export class SignalCli {
  private nextId = 1;
  constructor(private readonly url: string, private readonly account: string) {}

  async rpc(method: string, params: Json = {}) {
    const response = await fetch(`${this.url}/api/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: { account: this.account, ...params } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`signal-cli ${method} returned HTTP ${response.status}`);
    const body = await response.json() as Json;
    if (body.error) throw new Error(`signal-cli ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }

  send(recipient: string, message: string) {
    return this.rpc("send", { recipient: [recipient], message });
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
