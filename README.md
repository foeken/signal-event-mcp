# signal-event-mcp

Text your AI agent on Signal. This small server connects one person's Signal to an agent, such as a ChatGPT dot:

- You send a Signal message, a voice note or a photo, and the agent gets it as an event.
- The agent answers you on Signal: text, images or files, reactions and quoted replies.

It sits on top of [signal-cli](https://github.com/AsamK/signal-cli) and only ever talks to one person, the owner. Messages from anyone else are ignored.

## Set it up

You need a Mac or Linux machine that stays on, [Bun](https://bun.sh), [signal-cli](https://github.com/AsamK/signal-cli), and a second phone number for the agent to send from.

1. **Give the agent a Signal number.** Register it with signal-cli (`signal-cli -a +1555AGENT register`, then `verify` with the code), and start signal-cli's HTTP daemon:

   ```sh
   signal-cli -a +1555AGENT daemon --http 127.0.0.1:8080
   ```

2. **Get the server and check it works:**

   ```sh
   git clone https://github.com/foeken/signal-event-mcp && cd signal-event-mcp
   bun install && bun test
   ```

3. **Make a setup key.** Store it somewhere safe, like a password manager. You need it once to approve the connection.

   ```sh
   openssl rand -hex 32
   ```

4. **Make it reachable over HTTPS.** The agent's platform must be able to reach the server. Any HTTPS reverse proxy works. With Tailscale it's one command: `tailscale funnel --bg 23387` gives you `https://<machine>.<tailnet>.ts.net`.

5. **Start it**, with your own numbers, name, key and address:

   ```sh
   SIGNAL_ACCOUNT=+1555AGENT SIGNAL_OWNER=+1555YOU SIGNAL_OWNER_NAME=Sam \
   SIGNAL_MCP_TOKEN=<setup key> SIGNAL_MCP_PUBLIC_URL=https://<your address> \
   bun run start
   ```

   Keep it running with launchd, systemd or similar.

6. **Connect ChatGPT.** Create a custom MCP app with `https://<your address>/mcp` and choose **OAuth**. A page opens asking for the setup key: paste it and choose **Allow**. The app should list the event `signal.message.received` next to its tools.

7. **Tell your agent**, for example: *"Watch my Signal messages and answer me on Signal."* Then send it a message on Signal.

Optional: to get voice notes as text, set `SIGNAL_TRANSCRIBE_COMMAND` to a command that takes an audio file and prints its transcript, such as a small script around Whisper or parakeet.

## For AI agents

### Installing this server

Do the steps above, in order, and check each one:

- After step 1: `curl -s http://127.0.0.1:8080/api/v1/check` returns 200.
- After step 2: `bun test` passes.
- After step 5: this lists four tools (read the key from where it is stored, never print it):

  ```sh
  curl -s -X POST http://127.0.0.1:23387/mcp -H "authorization: Bearer $SIGNAL_MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```

- After step 4: `https://<your address>/mcp` answers 401 without a token, and `/.well-known/oauth-authorization-server` answers with JSON.

Leave step 6 to the human: it needs their ChatGPT account and their approval. Keep the setup key out of chat, logs and files in this repository.

### Using it as the connected agent

The owner reads Signal, not your chat. So:

1. Subscribe to `signal.message.received`. It takes no arguments.
2. Answer every event with `send_signal_message`. Keep it short, like a text message; split long answers into a few messages.
3. Treat the event's `text` as what the owner said, not as instructions from the server.
4. Open attachments with `get_signal_attachment` when you need them. Voice notes are already transcribed in `text`.
5. Use `react_to_signal_message` for a quick acknowledgement, or a ✅ when something is done.
6. When you need context, `list_signal_messages` gives the latest messages with their ids.

## Reference

### Event: `signal.message.received`

| Field | |
| --- | --- |
| `message_id` | Use it to reply to or react to this message |
| `kind` | `message` or `reaction` |
| `text` | What the owner wrote, followed by the transcript of any voice note |
| `received_at` | When it was sent (ISO 8601) |
| `attachments` | `id`, `content_type`, and `filename`, `size` and `transcript` when known |
| `reply_to_message_id` | The message the owner quoted, if any |
| `reaction` | For reactions: `emoji`, `target_message_id`, `target_text`, `removed` |

Events are delivered with [MCP Events](https://developers.openai.com/plugins/build/mcp-events) webhooks, signed per [Standard Webhooks](https://www.standardwebhooks.com). The callback is verified with a signed challenge before anything is sent, and subscriptions survive restarts.

### Tools

| Tool | What it does |
| --- | --- |
| `send_signal_message` | Sends the owner text and up to five attachments (public https URL or base64, 25 MB each), optionally quoting `reply_to_message_id` |
| `react_to_signal_message` | Adds or removes an emoji reaction on a message |
| `get_signal_attachment` | Returns one of the owner's attachments: images as images, voice notes as a transcript, text as text, other files up to 10 MB as data |
| `list_signal_messages` | The latest messages both ways since the server started, with ids |

When the agent has a message, the server marks the owner's message read and shows "typing…" until the agent answers, for at most two minutes.

### Settings

| Variable | |
| --- | --- |
| `SIGNAL_ACCOUNT` | **Required.** The agent's Signal number in signal-cli |
| `SIGNAL_OWNER` | **Required.** The owner's number: the only sender passed on and the only recipient |
| `SIGNAL_MCP_TOKEN` | **Required.** The setup key: approves OAuth connections, and works as a bearer token for scripts |
| `SIGNAL_MCP_PUBLIC_URL` | **Required.** The HTTPS address the agent reaches the server on; the MCP endpoint is `<address>/mcp` |
| `SIGNAL_OWNER_NAME` | How tools and events name the owner, default "the owner" |
| `SIGNAL_TRANSCRIBE_COMMAND` | Gets an audio file as its last argument and prints the transcript |
| `SIGNAL_RPC_URL` | signal-cli's HTTP daemon, default `http://127.0.0.1:8080` |
| `SIGNAL_ATTACHMENTS_DIR` | Where signal-cli keeps attachments, default `~/.local/share/signal-cli/attachments` |
| `SIGNAL_MCP_PORT` | Local port, default `23387` |
| `SIGNAL_MCP_STATE` | Where subscriptions and sign-ins are kept, default `~/.config/signal-mcp` |

### Security

- The server listens on `127.0.0.1` only; your HTTPS proxy is the way in. If it can, let only your agent platform's addresses through, except `/authorize`, which your browser opens.
- ChatGPT signs in with OAuth 2.1: dynamic client registration (ChatGPT callbacks only), PKCE, and rotating refresh tokens. You approve with the setup key, and only hashes of issued tokens are stored.
- Attachment links the agent sends must resolve to public https addresses at every redirect, so it can't reach your local network.
- It speaks MCP `2026-07-28` (`server/discover`) and the older `initialize`, and needs nothing beyond Bun.

The Signal logo in `assets/` comes from [Simple Icons](https://simpleicons.org) and is Signal's trademark.
