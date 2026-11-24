import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/* Fetching a prospect's website (ARCHITECTURE.md §14 research.fetch). The fetched text is untrusted.
   Safety rules:
   - http(s) on the default ports only; at most 8 pages stored and 20 requests made; same site only;
     robots.txt obeyed (also after redirects).
   - Every hostname is resolved and every address checked; private, loopback, link-local, CGNAT, multicast and
     other special ranges are refused. The socket connects to the checked address (no DNS rebinding).
   - At most 3 redirects, each one re-checked; a redirect to another site is refused.
   - 10 s total per request (not an idle timeout) and 1 MB per response; only HTML and plain text are read. */

export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefused";
  }
}

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
}

export interface WebFetcher {
  fetchSite: (startUrl: string) => Promise<FetchedPage[]>;
}

/** Resolves a hostname to all of its addresses. */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

/** Performs one GET against an already checked address. */
export type Transport = (
  url: URL,
  address: string,
  options: { timeoutMs: number; maxBytes: number },
) => Promise<RawResponse>;

const USER_AGENT = "SOA-CRM-Research/1.0";
const MAX_PAGES = 8;
const MAX_REQUESTS = 20;
const MAX_QUEUE = 50;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

// ───────── address checks ─────────
const ipv4ToNumber = (ip: string) => ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
const inV4 = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (ipv4ToNumber(ip) & mask) >>> 0 === (ipv4ToNumber(base) & mask) >>> 0;
};
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Expands an IPv6 address to 8 groups of 16 bits. */
function ipv6Groups(ip: string): number[] {
  let address = ip.toLowerCase().split("%")[0] ?? "";
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4?.[1] !== undefined) {
    const n = ipv4ToNumber(v4[1]);
    address = address.replace(v4[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const middle = tail === undefined ? [] : Array.from({ length: 8 - left.length - right.length }, () => "0");
  return [...left, ...middle, ...right].map((group) => parseInt(group, 16));
}

const v4From = (high: number, low: number) =>
  `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;

export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return !BLOCKED_V4.some(([base, bits]) => inV4(ip, base, bits)) && ip !== "255.255.255.255";
  if (version !== 6) return false;
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((part) => Number.isNaN(part))) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g7 = 0, g8 = 0] = g;
  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0;
  if (zeroPrefix && e === 0 && f === 0xffff) return isPublicAddress(v4From(g7, g8)); // ::ffff:v4 (mapped)
  if (zeroPrefix && e === 0xffff && f === 0) return isPublicAddress(v4From(g7, g8)); // ::ffff:0:v4 (translated)
  if (zeroPrefix) return false; // ::, ::1, ::v4 and other reserved low addresses
  if (a === 0x64 && b === 0xff9b) return isPublicAddress(v4From(g7, g8)); // NAT64 (64:ff9b::/96 and /48)
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // 100::/64 discard
  if (a === 0x2001 && b < 0x0200) return false; // 2001::/23 special purpose (Teredo, ORCHID, benchmarking …)
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return isPublicAddress(v4From(b, c)); // 6to4
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return false; // link local, deprecated site local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  return true;
}

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, order: "verbatim" })).map((entry) => entry.address);

/** The one public address to connect to for this URL, or FetchRefused. */
export async function checkTarget(url: URL, resolve: Resolver): Promise<string> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused("Only http and https are allowed.");
  if (url.port !== "" && url.port !== (url.protocol === "https:" ? "443" : "80")) {
    throw new FetchRefused("Only the standard ports are allowed.");
  }
  if (url.username !== "" || url.password !== "") throw new FetchRefused("Addresses with credentials are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (lower === "" || lower === "localhost" || lower.endsWith(".localhost")) {
    throw new FetchRefused("Local addresses are not allowed.");
  }
  const addresses = isIP(host) === 0 ? await resolve(host).catch(() => []) : [host];
  if (addresses.length === 0) throw new FetchRefused("The address could not be found.");
  if (!addresses.every(isPublicAddress)) throw new FetchRefused("The address points to a private or reserved network.");
  return addresses[0] ?? "";
}

// ───────── transport ─────────
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export const nodeTransport: Transport = (url, address, options) =>
  new Promise((resolve, reject) => {
    const family = isIP(address);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false, // no shared keep-alive sockets: every request connects to its own checked address
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9" },
        // Connect to the address that was checked, never re-resolve. Node 20+ asks with { all: true }.
        lookup: (_hostname: string, lookupOptions: { all?: boolean }, callback: LookupCallback) => {
          if (lookupOptions.all === true) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
        ...(isIP(host) === 0 ? { servername: host } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("close", () => {
          clearTimeout(deadline);
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        response.on("error", reject);
      },
    );
    // A total deadline, not an idle timeout: a server that drips bytes can't hold the request open.
    const deadline = setTimeout(() => request.destroy(new Error("timeout")), options.timeoutMs);
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });

// ───────── text extraction ─────────
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (text: string) =>
  text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

export function extractText(html: string): { title: string | null; text: string; links: string[] } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const links = [...html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)/gi)].map((match) => match[1] ?? "");
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<title[\s\S]*?<\/title>/gi, " ")
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return { title: title === undefined ? null : decodeEntities(title).replace(/\s+/g, " ").trim(), text, links };
}

/** robots.txt Disallow rules for all user agents. */
export function robotsDisallows(robots: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [field = "", ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(field)) applies = value === "*" || /soa-crm/i.test(value);
    else if (applies && /^disallow$/i.test(field) && value !== "") rules.push(value);
  }
  return rules;
}

/** Same site: the same host, treating the bare domain and its www. form as one (the usual redirect). */
const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
const PRIORITY = /about|security|news|press|propert|tenant|leasing|contact|amenit|location/i;

export function createWebFetcher(options: { resolve?: Resolver; transport?: Transport } = {}): WebFetcher {
  const resolve = options.resolve ?? systemResolver;
  const transport = options.transport ?? nodeTransport;

  return {
    async fetchSite(startUrl) {
      const origin = new URL(startUrl);
      await checkTarget(origin, resolve); // refuse up front, before any request
      let requests = 0;

      /** GET with checked redirects; every request counts against the budget. */
      const get = async (start: URL): Promise<{ url: URL; response: RawResponse }> => {
        let url = start;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          if (!sameSite(url, origin)) throw new FetchRefused("Redirects to another site are not followed.");
          if (requests >= MAX_REQUESTS) throw new FetchRefused("Request limit reached.");
          const address = await checkTarget(url, resolve);
          requests += 1;
          const response = await transport(url, address, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
          if (response.status >= 300 && response.status < 400 && response.headers.location !== undefined) {
            url = new URL(response.headers.location, url);
            continue;
          }
          return { url, response };
        }
        throw new FetchRefused("Too many redirects.");
      };

      // robots.txt: any failure (including a redirect to another host) means no rules, not no fetch.
      let disallowed: string[] = [];
      try {
        const robots = await get(new URL("/robots.txt", origin));
        if (robots.response.status === 200) disallowed = robotsDisallows(robots.response.body);
      } catch {
        disallowed = [];
      }
      const allowed = (url: URL) => !disallowed.some((rule) => url.pathname.startsWith(rule));

      const queue: URL[] = [origin];
      const seen = new Set<string>();
      const pages: FetchedPage[] = [];
      while (queue.length > 0 && pages.length < MAX_PAGES && requests < MAX_REQUESTS) {
        const next = queue.shift();
        if (next === undefined) break;
        const key = `${next.hostname}${next.pathname}`;
        if (seen.has(key) || !allowed(next)) continue;
        seen.add(key);
        let fetched: { url: URL; response: RawResponse };
        try {
          fetched = await get(next);
        } catch (error) {
          if (next === origin) throw error; // the home page itself failed or was refused
          continue;
        }
        if (!allowed(fetched.url)) continue; // redirected into a disallowed path
        const type = fetched.response.headers["content-type"] ?? "";
        if (fetched.response.status !== 200 || !/text\/(html|plain)/i.test(type)) continue;
        const { title, text, links } = /html/i.test(type)
          ? extractText(fetched.response.body)
          : { title: null, text: fetched.response.body, links: [] };
        if (text.trim().length > 0) pages.push({ url: fetched.url.toString(), title, text: text.slice(0, 200_000) });
        const candidates = links
          .flatMap((href) => {
            try {
              const url = new URL(href, fetched.url);
              url.hash = "";
              return (url.protocol === "http:" || url.protocol === "https:") && sameSite(url, origin) ? [url] : [];
            } catch {
              return [];
            }
          })
          .sort((x, y) => Number(PRIORITY.test(y.pathname)) - Number(PRIORITY.test(x.pathname)));
        for (const candidate of candidates) if (queue.length < MAX_QUEUE) queue.push(candidate);
      }
      return pages;
    },
  };
}

/** FAKE_PROVIDERS: no request leaves the machine; returns one page saying so. */
export function createFakeWebFetcher(): WebFetcher {
  return {
    fetchSite: (startUrl) =>
      Promise.resolve([
        {
          url: new URL(startUrl).toString(),
          title: "Website (fake fetch)",
          text: "Local development: the website was not requested (FAKE_PROVIDERS=true). Add notes from calls or site visits instead.",
        },
      ]),
  };
}
