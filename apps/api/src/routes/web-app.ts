import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/* Production only (WEB_DIST_DIR): the api also serves the built web app (§3). The load balancer keeps these paths to
   the office and VPN ranges like /api. Hashed assets are cached for a year; everything else falls back to
   index.html so client-side routes work. Nothing here reads data. */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function registerWebApp(app: FastifyInstance, dir: string): void {
  const root = normalize(dir);
  const publicRoute = { config: { access: "public" as const } };

  const fileFor = async (urlPath: string): Promise<string | undefined> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
    } catch {
      return undefined;
    }
    const candidate = normalize(join(root, decoded));
    if (candidate !== root && !candidate.startsWith(root + sep)) return undefined; // no ../ out of the folder
    try {
      return (await stat(candidate)).isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  };

  app.get("/*", publicRoute, async (request, reply) => {
    const path = request.url.split("?")[0] ?? "/";
    if (path.startsWith("/api/")) return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    const file = (await fileFor(path)) ?? join(root, "index.html");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const immutable = file.startsWith(join(root, "assets") + sep);
    return reply
      .header("content-type", type)
      .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
      .send(await readFile(file));
  });
}
