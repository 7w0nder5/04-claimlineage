import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addSnapshot } from "../../storage/src/workspace.js";
import { MAX_SNAPSHOT_BYTES, fail } from "../../core/src/index.js";

const MAX_URL_CHARACTERS = 2048;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;

const blockedIpv4Addresses = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");

const blockedIpv6Addresses = new net.BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");

const allocatedIpv6Addresses = new net.BlockList();
allocatedIpv6Addresses.addSubnet("2000::", 3, "ipv6");

function unbracket(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
  if (family === 6) return allocatedIpv6Addresses.check(address, "ipv6") && !blockedIpv6Addresses.check(address, "ipv6");
  return false;
}

export function validateCaptureUrl(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_CHARACTERS) {
    fail("INVALID_URL", `URL length must be from 1 through ${MAX_URL_CHARACTERS} characters.`);
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("INVALID_URL", "Source URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("UNSUPPORTED_URL_SCHEME", "Only http: and https: URLs are accepted.");
  if (url.username || url.password) fail("URL_CREDENTIALS", "Credentials in source URLs are not accepted.");
  if (!url.hostname) fail("INVALID_URL", "Source URL must include a hostname.");
  url.hash = "";
  return url;
}

export async function resolvePublicAddress(url, resolver = dns.lookup) {
  const hostname = unbracket(url.hostname);
  const directFamily = net.isIP(hostname);
  const results = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (!Array.isArray(results) || results.length === 0) fail("DNS_EMPTY", `No address was found for ${url.hostname}.`);
  for (const result of results) {
    if (!result || !isPublicAddress(result.address)) fail("PRIVATE_ADDRESS", `${url.hostname} resolves to a blocked address.`);
  }
  return results[0];
}

function contentType(headers) {
  const raw = String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) ? raw : "application/octet-stream";
}

export function requestPinned(url, address, {
  timeoutMs = REQUEST_TIMEOUT_MS,
  maximumBytes = MAX_SNAPSHOT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      maxHeaderSize: MAX_HEADER_BYTES,
      servername: net.isIP(unbracket(url.hostname)) ? undefined : url.hostname,
      lookup(_hostname, _options, callback) {
        if (_options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: {
        Accept: "text/html, application/json, text/plain;q=0.9, */*;q=0.1",
        "Accept-Encoding": "identity",
        "User-Agent": "ClaimLineage/0.1 (+https://github.com/7w0nder5/04-claimlineage)",
      },
    }, (response) => {
      const status = response.statusCode || 0;
      const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
      if (encoding !== "identity") {
        response.resume();
        finish(reject, new Error(`response content-encoding ${encoding} is not accepted`));
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maximumBytes) {
        response.resume();
        finish(reject, new Error(`response exceeds ${maximumBytes} bytes`));
        return;
      }
      if (status >= 300 && status <= 399) {
        const location = response.headers.location;
        response.resume();
        finish(resolve, { status, location, headers: response.headers, bytes: Buffer.alloc(0) });
        return;
      }
      if (status < 200 || status > 299) {
        response.resume();
        finish(reject, new Error(`source returned HTTP ${status}`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maximumBytes) {
          const error = new Error(`response exceeds ${maximumBytes} bytes`);
          finish(reject, error);
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("aborted", () => finish(reject, new Error("source response was aborted")));
      response.on("error", (error) => finish(reject, error));
      response.on("end", () => {
        if (!response.complete) {
          finish(reject, new Error("source response ended before completion"));
          return;
        }
        finish(resolve, { status, headers: response.headers, bytes: Buffer.concat(chunks, length) });
      });
    });
    request.on("error", (error) => finish(reject, error));
    timer = setTimeout(() => request.destroy(new Error(`source request exceeded ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    request.end();
  });
}

export async function fetchHttpSnapshot(input, {
  resolver = dns.lookup,
  requester = requestPinned,
} = {}) {
  const requested = validateCaptureUrl(input);
  let current = requested;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const address = await resolvePublicAddress(current, resolver);
    let response;
    try {
      response = await requester(current, address);
    } catch (error) {
      fail("CAPTURE_FAILED", `Could not capture ${current.href}: ${error.message}`);
    }
    if (response.status >= 300 && response.status <= 399) {
      if (!response.location) fail("INVALID_REDIRECT", `HTTP ${response.status} response did not include a Location header.`);
      if (redirects === MAX_REDIRECTS) fail("TOO_MANY_REDIRECTS", `Source exceeded ${MAX_REDIRECTS} redirects.`);
      const next = validateCaptureUrl(new URL(response.location, current).href);
      if (current.protocol === "https:" && next.protocol !== "https:") fail("INSECURE_REDIRECT", "An HTTPS source cannot redirect to HTTP.");
      current = next;
      continue;
    }
    return {
      bytes: response.bytes,
      mediaType: contentType(response.headers),
      source: {
        type: "http",
        label: current.hostname,
        requestedUrl: requested.href,
        finalUrl: current.href,
        status: response.status,
      },
    };
  }
  fail("TOO_MANY_REDIRECTS", `Source exceeded ${MAX_REDIRECTS} redirects.`);
}

export async function captureHttp(root, input, options = {}) {
  const capture = await fetchHttpSnapshot(input, options);
  return addSnapshot(root, { ...capture, ...options.snapshotOptions });
}
