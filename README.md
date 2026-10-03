# signal-event-mcp

One person's Signal as an MCP server for their AI agent, such as a ChatGPT dot. A thin layer over `signal-cli daemon --http`:

- **Event `signal.message.received`**: each Signal message from the owner is delivered to the agent through [MCP Events](https://developers.openai.com/plugins/build/mcp-events): webhook delivery, [Standard Webhooks](https://www.standardwebhooks.com) signatures, and a signed challenge to verify the callback before anything is sent. Subscriptions survive restarts.
- **Tool `send_signal_message`**: sends the owner a Signal message, and only the owner.
- **Tool `list_signal_messages`**: the latest messages both ways since the server started.
- **OAuth 2.1** for ChatGPT's connector: dynamic client registration (ChatGPT callbacks only), PKCE, and rotating refresh tokens. The owner approves a connection on `/authorize` by entering the setup key (`SIGNAL_MCP_TOKEN`). Only hashes of issued tokens are stored. The setup key also works as a plain bearer token for scripts.

Messages from anyone else are ignored, and attachments are listed by content type, not passed on. It speaks MCP `2026-07-28` (`server/discover`) as well as the older `initialize`, and has no dependencies beyond [Bun](https://bun.sh).

## Run

```sh
bun run check
bun test
SIGNAL_ACCOUNT=+3160… SIGNAL_OWNER=+3161… SIGNAL_OWNER_NAME=Sam \
SIGNAL_MCP_TOKEN=$(openssl rand -hex 32) SIGNAL_MCP_PUBLIC_URL=https://example.com/signal \
bun run start
```

| Variable | |
| --- | --- |
| `SIGNAL_ACCOUNT` | The signal-cli account the agent speaks from |
| `SIGNAL_OWNER` | The owner's number: the only sender passed on and the only recipient |
| `SIGNAL_OWNER_NAME` | How tool and event descriptions name the owner, default "the owner" |
| `SIGNAL_MCP_TOKEN` | Setup key: approves OAuth connections, and works as a bearer token |
| `SIGNAL_MCP_PUBLIC_URL` | The base URL the agent reaches the server on; the MCP endpoint is `<base>/mcp` |
| `SIGNAL_RPC_URL` | signal-cli's HTTP daemon, default `http://127.0.0.1:8080` |
| `SIGNAL_MCP_PORT` | Loopback port, default `23387` |
| `SIGNAL_MCP_STATE` | Where subscriptions and OAuth state are kept, default `~/.config/signal-mcp` |

The server listens on loopback only. Put an HTTPS proxy in front that may strip a path prefix; ideally it lets only the agent platform's addresses reach everything except `/authorize`, which the owner's browser opens. The server also answers OAuth discovery on `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`.

## Connect ChatGPT

Create a custom MCP app with `<SIGNAL_MCP_PUBLIC_URL>/mcp` and OAuth, approve it with the setup key, check that `signal.message.received` is listed next to the tools, and ask your dot to watch it and answer with `send_signal_message`.

The Signal logo in `assets/` comes from [Simple Icons](https://simpleicons.org) and is Signal's trademark.
