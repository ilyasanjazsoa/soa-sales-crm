import { describe, expect, it } from "vitest";
import {
  checkTarget,
  createWebFetcher,
  extractText,
  FetchRefused,
  isPublicAddress,
  robotsDisallows,
  type RawResponse,
  type Resolver,
  type Transport,
} from "../src/providers/web";

/* ARCHITECTURE.md §14: research.fetch blocks private and link-local ranges after DNS resolution and follows at
   most 3 redirects, re-checking each hop. No real network is used here. */

const PUBLIC_IP = "93.184.216.34";
const resolver =
  (table: Record<string, string[]>): Resolver =>
  (hostname) =>
    Promise.resolve(table[hostname] ?? []);

const html = (body: string, title = "Page"): RawResponse => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: `<html><head><title>${title}</title></head><body>${body}</body></html>`,
});

describe("address checks", () => {
  it.each([
    "169.254.169.254",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
  ])("treats %s as not public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([PUBLIC_IP, "8.8.8.8", "2606:4700:4700::1111"])("treats %s as public", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("checkTarget", () => {
  const resolve = resolver({
    "harbor.example": [PUBLIC_IP],
    "inside.example": ["10.0.0.5"],
    "mixed.example": [PUBLIC_IP, "127.0.0.1"],
  });

  it("refuses the cloud metadata address", async () => {
    await expect(checkTarget(new URL("http://169.254.169.254/latest/meta-data/"), resolve)).rejects.toBeInstanceOf(
      FetchRefused,
    );
  });

  it("refuses localhost", async () => {
    await expect(checkTarget(new URL("http://localhost/"), resolve)).rejects.toBeInstanceOf(FetchRefused);
    await expect(checkTarget(new URL("http://app.localhost/"), resolve)).rejects.toBeInstanceOf(FetchRefused);
    await expect(checkTarget(new URL("http://[::1]/"), resolve)).rejects.toBeInstanceOf(FetchRefused);
  });

  it("refuses a host that resolves to a private address, even if another address is public", async () => {
    await expect(checkTarget(new URL("https://inside.example/"), resolve)).rejects.toThrow(/private or reserved/);
    await expect(checkTarget(new URL("https://mixed.example/"), resolve)).rejects.toThrow(/private or reserved/);
  });

  it("refuses other schemes, other ports and credentials", async () => {
    await expect(checkTarget(new URL("file:///etc/passwd"), resolve)).rejects.toBeInstanceOf(FetchRefused);
    await expect(checkTarget(new URL("http://harbor.example:6379/"), resolve)).rejects.toBeInstanceOf(FetchRefused);
    await expect(checkTarget(new URL("http://user:pass@harbor.example/"), resolve)).rejects.toBeInstanceOf(
      FetchRefused,
    );
  });

  it("returns the checked public address to connect to", async () => {
    await expect(checkTarget(new URL("https://harbor.example/about"), resolve)).resolves.toBe(PUBLIC_IP);
  });
});

describe("fetchSite", () => {
  const resolve = resolver({
    "harbor.example": [PUBLIC_IP],
    "www.harbor.example": [PUBLIC_IP],
    "evil.example": ["192.168.0.10"],
  });

  it("refuses a redirect to a private address", async () => {
    const transport: Transport = (url) =>
      Promise.resolve(
        url.pathname === "/robots.txt"
          ? { status: 404, headers: {}, body: "" }
          : { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" }, body: "" },
      );
    await expect(createWebFetcher({ resolve, transport }).fetchSite("https://harbor.example/")).rejects.toBeInstanceOf(
      FetchRefused,
    );
  });

  it("refuses a redirect to another site and stops after 3 redirects", async () => {
    const toOther: Transport = (url) =>
      Promise.resolve(
        url.pathname === "/robots.txt"
          ? { status: 404, headers: {}, body: "" }
          : { status: 301, headers: { location: "https://evil.example/" }, body: "" },
      );
    await expect(
      createWebFetcher({ resolve, transport: toOther }).fetchSite("https://harbor.example/"),
    ).rejects.toThrow(/another site/);

    let hops = 0;
    const loop: Transport = (url) => {
      if (url.pathname === "/robots.txt") return Promise.resolve({ status: 404, headers: {}, body: "" });
      hops += 1;
      return Promise.resolve({ status: 302, headers: { location: `/hop${String(hops)}` }, body: "" });
    };
    await expect(createWebFetcher({ resolve, transport: loop }).fetchSite("https://harbor.example/")).rejects.toThrow(
      /Too many redirects/,
    );
    expect(hops).toBe(4); // the first request plus 3 redirects
  });

  it("connects only to the checked address, reads same-site pages (max 8) and obeys robots.txt", async () => {
    const seen: { url: string; address: string }[] = [];
    const links = Array.from({ length: 12 }, (_, index) => `<a href="/page${String(index)}">p</a>`).join("");
    const transport: Transport = (url, address) => {
      seen.push({ url: url.toString(), address });
      if (url.pathname === "/robots.txt")
        return Promise.resolve({ status: 200, headers: {}, body: "User-agent: *\nDisallow: /private" });
      if (url.pathname === "/")
        return Promise.resolve(
          html(`Welcome. <a href="/private/x">x</a> <a href="https://other.example/">o</a> ${links}`, "Home"),
        );
      return Promise.resolve(html(`Content of ${url.pathname}`));
    };
    const pages = await createWebFetcher({ resolve, transport }).fetchSite("https://harbor.example/");
    expect(pages).toHaveLength(8);
    expect(pages[0]).toMatchObject({ url: "https://harbor.example/", title: "Home" });
    expect(seen.every((entry) => entry.address === PUBLIC_IP)).toBe(true);
    expect(seen.some((entry) => entry.url.includes("/private"))).toBe(false);
    expect(seen.some((entry) => entry.url.includes("other.example"))).toBe(false);
  });
});

describe("text extraction and robots", () => {
  it("keeps visible text only", () => {
    const { title, text } = extractText(
      "<title>Yard &amp; Co</title><style>p{}</style><script>alert(1)</script><p>Gate&nbsp;3 is open.</p><!-- hidden --><div>Night &lt;shift&gt;</div>",
    );
    expect(title).toBe("Yard & Co");
    expect(text).toBe("Gate 3 is open.\nNight <shift>");
  });

  it("reads Disallow rules for all agents", () => {
    expect(
      robotsDisallows("User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /admin\nDisallow:\n"),
    ).toEqual(["/admin"]);
  });
});

describe("nodeTransport (real sockets)", () => {
  it("connects to the checked address whatever the hostname says (pinned, Node 22 lookup)", async () => {
    const { createServer } = await import("node:http");
    const { nodeTransport } = await import("../src/providers/web");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("pinned ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      // "pinned.invalid" can't resolve; the request only succeeds because it connects to 127.0.0.1 directly.
      const response = await nodeTransport(new URL(`http://pinned.invalid:${String(port)}/`), "127.0.0.1", {
        timeoutMs: 5000,
        maxBytes: 1024,
      });
      expect(response).toMatchObject({ status: 200, body: "pinned ok" });
    } finally {
      server.close();
    }
  });

  it("enforces a total deadline, not an idle timeout", async () => {
    const { createServer } = await import("node:http");
    const { nodeTransport } = await import("../src/providers/web");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      const drip = setInterval(() => response.write("."), 50);
      response.on("close", () => {
        clearInterval(drip);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const started = Date.now();
    try {
      await nodeTransport(new URL(`http://drip.invalid:${String(port)}/`), "127.0.0.1", {
        timeoutMs: 300,
        maxBytes: 1_000_000,
      }).catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("crawl limits", () => {
  it("stops after 20 requests even when no page is stored", async () => {
    let requests = 0;
    const links = Array.from({ length: 500 }, (_, index) => `<a href="/missing${String(index)}">x</a>`).join("");
    const transport: Transport = (url) => {
      requests += 1;
      if (url.pathname === "/") return Promise.resolve(html(links));
      return Promise.resolve({ status: 404, headers: {}, body: "" });
    };
    const pages = await createWebFetcher({ resolve: resolver({ "harbor.example": [PUBLIC_IP] }), transport }).fetchSite(
      "https://harbor.example/",
    );
    expect(pages).toHaveLength(1);
    expect(requests).toBeLessThanOrEqual(20);
  });

  it("treats a robots.txt redirect to another host as no rules", async () => {
    const transport: Transport = (url) =>
      Promise.resolve(
        url.pathname === "/robots.txt"
          ? { status: 301, headers: { location: "https://cdn.other.example/robots.txt" }, body: "" }
          : html("Home page"),
      );
    const pages = await createWebFetcher({ resolve: resolver({ "harbor.example": [PUBLIC_IP] }), transport }).fetchSite(
      "https://harbor.example/",
    );
    expect(pages).toHaveLength(1);
  });

  it.each(["::ffff:0:7f00:1", "2001::1", "2001:10::1", "100::1", "fec0::1"])("treats %s as not public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});
