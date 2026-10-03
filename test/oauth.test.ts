import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { OAuth } from "../src/oauth";

const FILE = "/tmp/signal-mcp-oauth-test/oauth.json";
const ISSUER = "https://mcp.example/signal";
afterAll(() => rm("/tmp/signal-mcp-oauth-test", { recursive: true, force: true }));
const req = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1${path}`, init);
const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

describe("OAuth for ChatGPT", () => {
  test("registers ChatGPT, lets the owner approve with the setup key, and hands out working tokens", async () => {
    const oauth = new OAuth(FILE, ISSUER, "setup-key");
    const meta = await (await oauth.handle(req("/.well-known/oauth-authorization-server")))!.json() as any;
    expect(meta).toMatchObject({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, code_challenge_methods_supported: ["S256"] });
    expect((await (await oauth.handle(req("/.well-known/oauth-protected-resource/mcp")))!.json() as any).authorization_servers).toEqual([ISSUER]);

    const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    const client = await (await oauth.handle(req("/register", { method: "POST", body: JSON.stringify({ redirect_uris: [redirect], client_name: "ChatGPT" }) })))!.json() as any;
    const verifier = "v".repeat(50);
    const fields = { client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s1" };

    expect((await oauth.handle(req(`/authorize?${new URLSearchParams(fields)}`)))!.status).toBe(200);
    expect((await oauth.handle(req("/authorize", form({ ...fields, setup_key: "wrong" }))))!.status).toBe(401);
    const approved = (await oauth.handle(req("/authorize", form({ ...fields, setup_key: "setup-key" }))))!;
    const back = new URL(approved.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("s1");

    const exchange = { grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: client.client_id, redirect_uri: redirect };
    expect((await oauth.handle(req("/token", form({ ...exchange, code_verifier: "w".repeat(50) }))))!.status).toBe(400); // wrong verifier also burns the code
    const again = (await oauth.handle(req("/authorize", form({ ...fields, setup_key: "setup-key" }))))!;
    const tokens = await (await oauth.handle(req("/token", form({ ...exchange, code: new URL(again.headers.get("location")!).searchParams.get("code")!, code_verifier: verifier }))))!.json() as any;
    expect(await oauth.authorized(`Bearer ${tokens.access_token}`)).toBe(true);
    expect(await oauth.authorized("Bearer sat_made_up")).toBe(false);

    const refreshed = await (await oauth.handle(req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }))))!.json() as any;
    expect(await new OAuth(FILE, ISSUER, "setup-key").authorized(`Bearer ${refreshed.access_token}`)).toBe(true); // survives a restart
    expect((await oauth.handle(req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }))))!.status).toBe(400); // rotated
  });

  test("only registers ChatGPT callbacks", async () => {
    const oauth = new OAuth(FILE, ISSUER, "setup-key");
    const response = (await oauth.handle(req("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) })))!;
    expect(response.status).toBe(400);
  });
});
