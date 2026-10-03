import { describe, expect, test } from "bun:test";
import { attachmentPath, dataUri, fetchPublic, outgoing, readForAgent } from "../src/attachments";

const publicDns = async () => [{ address: "104.18.1.1" }];

describe("attachments", () => {
  test("only reads attachment files by plain id", () => {
    expect(attachmentPath("/a", "vFmg6gP-Cs6XiLg_lV9-.aac")).toBe("/a/vFmg6gP-Cs6XiLg_lV9-.aac");
    for (const id of ["../etc/passwd", "a/b.jpg", "", ".."]) expect(() => attachmentPath("/a", id)).toThrow();
  });

  test("gives voice notes as their transcript", async () => {
    expect(await readForAgent("/nonexistent.aac", "audio/aac", "hello there")).toEqual([{ type: "text", text: "Transcript of the voice note:\nhello there" }]);
  });

  test("builds the data URIs signal-cli sends", async () => {
    expect(dataUri(Buffer.from("hi"), "text/plain", "my notes.txt")).toBe("data:text/plain;filename=my_notes.txt;base64,aGk=");
    expect(await outgoing({ data: "aGk=", content_type: "text/plain", filename: "a.txt" })).toBe("data:text/plain;filename=a.txt;base64,aGk=");
    await expect(outgoing({})).rejects.toThrow();
  });

  test("fetches public https files and follows redirects only to public addresses", async () => {
    const hops: string[] = [];
    const fetchImpl = (async (url: string) => {
      hops.push(url);
      if (url.endsWith("/start")) return new Response(null, { status: 302, headers: { location: "/image.png" } });
      return new Response(Buffer.from([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const fetched = await fetchPublic("https://cdn.example/start", fetchImpl, publicDns);
    expect(fetched).toMatchObject({ contentType: "image/png", filename: "image.png" });
    expect([...fetched.bytes]).toEqual([1, 2, 3]);
    expect(hops).toEqual(["https://cdn.example/start", "https://cdn.example/image.png"]);

    await expect(fetchPublic("http://cdn.example/a.png", fetchImpl, publicDns)).rejects.toThrow("https");
    await expect(fetchPublic("https://localhost/a.png", fetchImpl, async () => [{ address: "127.0.0.1" }])).rejects.toThrow("public");
    const toPrivate = (async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/x" } })) as unknown as typeof fetch;
    await expect(fetchPublic("https://cdn.example/start", toPrivate, publicDns)).rejects.toThrow("public");
  });
});
