import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hasBearerToken, sameSecret } from "./auth";

// OAuth 2.1 for ChatGPT's MCP connector (new connectors offer OAuth or nothing): dynamic client registration, PKCE
// (S256), authorization codes and rotating refresh tokens. The owner approves a connection on /authorize by entering the
// setup key (SIGNAL_MCP_TOKEN). Only hashes of issued tokens are stored.

const ACCESS_TTL = 24 * 60 * 60 * 1_000;
const CODE_TTL = 5 * 60 * 1_000;
const REDIRECT_HOSTS = /^(chatgpt\.com|chat\.openai\.com|[a-z0-9-]+\.openai\.com)$/;

type Client = { redirect_uris: string[]; name: string };
type State = {
  clients: Record<string, Client>;
  codes: Record<string, { client: string; redirect: string; challenge: string; expires: number }>;
  access: Record<string, { client: string; expires: number }>;
  refresh: Record<string, { client: string }>;
};

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const oauthError = (error: string, description: string, status = 400) => Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });

export class OAuth {
  private state?: State;
  constructor(private readonly file: string, private readonly issuer: string, private readonly setupKey: string, private readonly now = () => Date.now()) {}

  get resourceMetadataUrl() { return `${this.issuer}/.well-known/oauth-protected-resource/mcp`; }

  private async load() {
    this.state ??= await readFile(this.file, "utf8").then((raw) => JSON.parse(raw) as State, () => ({ clients: {}, codes: {}, access: {}, refresh: {} }));
    return this.state;
  }

  private async save() {
    const state = await this.load();
    for (const [key, code] of Object.entries(state.codes)) if (code.expires < this.now()) delete state.codes[key];
    for (const [key, token] of Object.entries(state.access)) if (token.expires < this.now()) delete state.access[key];
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  // An MCP request carries either an access token issued here or the setup key itself (scripts, legacy connectors)
  async authorized(header: string | null) {
    if (hasBearerToken(header, this.setupKey)) return true;
    const token = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1];
    if (!token) return false;
    const entry = (await this.load()).access[hash(token)];
    return Boolean(entry && entry.expires > this.now());
  }

  // The OAuth endpoints, or null when the path is not one of them
  async handle(request: Request): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: `${this.issuer}/mcp`, authorization_servers: [this.issuer], bearer_methods_supported: ["header"], scopes_supported: ["signal"], resource_name: "Signal" });
    }
    if (request.method === "GET" && (pathname.startsWith("/.well-known/oauth-authorization-server") || pathname.startsWith("/.well-known/openid-configuration"))) {
      return Response.json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["signal"],
      });
    }
    if (pathname === "/register" && request.method === "POST") return this.register(request);
    if (pathname === "/authorize" && request.method === "GET") return this.authorizePage(new URL(request.url).searchParams);
    if (pathname === "/authorize" && request.method === "POST") return this.approve(request);
    if (pathname === "/token" && request.method === "POST") return this.token(request);
    return null;
  }

  private async register(request: Request) {
    const body = await request.json().catch(() => ({})) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every((uri) => { try { const u = new URL(uri); return u.protocol === "https:" && REDIRECT_HOSTS.test(u.hostname); } catch { return false; } })) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be ChatGPT https callbacks");
    }
    const id = secret("client");
    const state = await this.load();
    state.clients[id] = { redirect_uris: uris, name: String(body.client_name ?? "ChatGPT").slice(0, 100) };
    await this.save();
    return Response.json({ client_id: id, client_id_issued_at: Math.floor(this.now() / 1_000), redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { status: 201 });
  }

  private async check(params: URLSearchParams) {
    const client = (await this.load()).clients[params.get("client_id") ?? ""];
    if (!client || !client.redirect_uris.includes(params.get("redirect_uri") ?? "")) return "Unknown client or redirect address.";
    if (params.get("response_type") !== "code") return "Only response_type=code is supported.";
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return "PKCE with S256 is required.";
    return null;
  }

  private page(params: URLSearchParams, message = "", status = 200) {
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"]
      .map((name) => `<input type="hidden" name="${name}" value="${escape(params.get(name) ?? "")}">`).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Signal</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.5rem;color:#1c1c1e}h1{font-size:1.4rem}input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #c7c7cc;border-radius:.5rem}button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;color:#fff;background:#3a76f0;border:0;border-radius:.5rem}.error{color:#d70015}</style></head>
<body><h1>Connect ChatGPT to your Signal</h1><p>This lets ChatGPT receive your Signal messages and send you Signal messages. Enter the setup key this server was started with.</p>
${message ? `<p class="error">${escape(message)}</p>` : ""}<form method="post" action="authorize">${hidden}<input type="password" name="setup_key" autocomplete="off" autofocus required><button type="submit">Allow</button></form></body></html>`;
    return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
  }

  private async authorizePage(params: URLSearchParams) {
    const problem = await this.check(params);
    return problem ? new Response(problem, { status: 400 }) : this.page(params);
  }

  private async approve(request: Request) {
    const params = new URLSearchParams(await request.text());
    const problem = await this.check(params);
    if (problem) return new Response(problem, { status: 400 });
    if (!sameSecret(params.get("setup_key") ?? "", this.setupKey)) {
      await Bun.sleep(1_000);
      return this.page(params, "That is not the setup key.", 401);
    }
    const code = secret("code");
    (await this.load()).codes[hash(code)] = { client: params.get("client_id")!, redirect: params.get("redirect_uri")!, challenge: params.get("code_challenge")!, expires: this.now() + CODE_TTL };
    await this.save();
    const target = new URL(params.get("redirect_uri")!);
    target.searchParams.set("code", code);
    if (params.get("state")) target.searchParams.set("state", params.get("state")!);
    target.searchParams.set("iss", this.issuer);
    return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
  }

  private async issue(client: string) {
    const state = await this.load();
    const access = secret("sat"), refresh = secret("srt");
    state.access[hash(access)] = { client, expires: this.now() + ACCESS_TTL };
    state.refresh[hash(refresh)] = { client };
    await this.save();
    return Response.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1_000, refresh_token: refresh, scope: "signal" }, { headers: { "cache-control": "no-store" } });
  }

  private async token(request: Request) {
    const params = new URLSearchParams(await request.text());
    const state = await this.load();
    const client = params.get("client_id") ?? "";
    if (params.get("grant_type") === "authorization_code") {
      const key = hash(params.get("code") ?? "");
      const code = state.codes[key];
      delete state.codes[key]; // single use, whatever happens next
      await this.save();
      if (!code || code.expires < this.now() || code.client !== client || code.redirect !== params.get("redirect_uri")) return oauthError("invalid_grant", "Unknown, used or expired code");
      const verifier = params.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed");
      return this.issue(client);
    }
    if (params.get("grant_type") === "refresh_token") {
      const key = hash(params.get("refresh_token") ?? "");
      const refresh = state.refresh[key];
      if (!refresh || (client && refresh.client !== client)) return oauthError("invalid_grant", "Unknown refresh token");
      delete state.refresh[key]; // rotated
      return this.issue(refresh.client);
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }
}
