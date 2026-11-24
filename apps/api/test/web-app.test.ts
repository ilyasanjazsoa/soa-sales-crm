import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers";

/* Production web app serving (WEB_DIST_DIR). */
describe("web app", () => {
  it("serves files, falls back to index.html, never leaves the folder, and keeps /api 404s as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webdist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>CRM</title>");
    writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
    const app = await testApp({ env: { WEB_DIST_DIR: dir } });
    try {
      const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
      expect(asset.headers["content-type"]).toContain("text/javascript");
      expect(asset.headers["cache-control"]).toContain("immutable");
      const route = await app.inject({ method: "GET", url: "/accounts/123?tab=outreach" });
      expect(route.body).toContain("<title>CRM</title>");
      expect(route.headers["content-security-policy"]).toContain("script-src 'self'");
      const escape = await app.inject({ method: "GET", url: "/%2e%2e/%2e%2e/etc/passwd" });
      expect(escape.body).toContain("<title>CRM</title>");
      for (const url of ["/p/x/y", "/u/a/b", "/webhooks/nope", "/webhooks"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.body, url).not.toContain("<title>CRM</title>");
      }
      const api = await app.inject({ method: "GET", url: "/api/nope" });
      expect(api.statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
