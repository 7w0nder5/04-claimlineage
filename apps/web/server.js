import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addClaim, loadWorkspace, verifyWorkspace } from "../../packages/storage/src/workspace.js";
import { captureHttp } from "../../packages/capture/src/http.js";
import { importUpload } from "../../packages/capture/src/file.js";
import { MAX_SNAPSHOT_BYTES, ClaimLineageError, fail } from "../../packages/core/src/index.js";

const WEB_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_JSON_BYTES = 64 * 1024;

const STATIC_FILES = new Map([
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, status, body, contentType = "application/json; charset=utf-8") {
  response.writeHead(status, securityHeaders(contentType));
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, `${JSON.stringify(value)}\n`);
}

async function bodyBytes(request, maximum) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) fail("REQUEST_TOO_LARGE", `Request body exceeds ${maximum} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function jsonBody(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    fail("INVALID_CONTENT_TYPE", "JSON requests require Content-Type: application/json.");
  }
  const bytes = await bodyBytes(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("INVALID_JSON", `Request body is not valid JSON: ${error.message}`);
  }
}

async function publicState(root) {
  const state = await loadWorkspace(root);
  return {
    workspace: state.workspace,
    snapshots: state.snapshots.map((snapshot) => ({ ...snapshot })),
    claims: state.claims.map((claim) => ({ ...claim })),
  };
}

function validApiRequest(request, token, origin) {
  return request.headers["x-claimlineage-token"] === token
    && request.headers.host === new URL(origin).host
    && (request.method === "GET" || request.headers.origin === origin);
}

export async function startWebServer(root, { port = 4177, token = randomBytes(32).toString("hex") } = {}) {
  await loadWorkspace(root);
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, origin || "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/") {
        const template = await readFile(path.join(WEB_ROOT, "index.html"), "utf8");
        send(response, 200, template.replace("__SESSION_TOKEN__", token), "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && STATIC_FILES.has(requestUrl.pathname)) {
        const [file, type] = STATIC_FILES.get(requestUrl.pathname);
        send(response, 200, await readFile(path.join(WEB_ROOT, file)), type);
        return;
      }
      if (!requestUrl.pathname.startsWith("/api/") || !validApiRequest(request, token, origin)) {
        sendJson(response, 403, { error: { code: "FORBIDDEN", message: "The local session token or origin is invalid." } });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        sendJson(response, 200, await publicState(root));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/claims") {
        const input = await jsonBody(request);
        const claim = await addClaim(root, {
          statement: input.statement,
          snapshotId: input.snapshotId,
          quote: input.quote,
        });
        sendJson(response, 201, { claim });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/captures") {
        const input = await jsonBody(request);
        const snapshot = await captureHttp(root, input.url);
        sendJson(response, 201, { snapshot });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/imports") {
        if (request.headers["content-type"] !== "application/octet-stream") fail("INVALID_CONTENT_TYPE", "File uploads require Content-Type: application/octet-stream.");
        const encodedName = String(request.headers["x-claimlineage-filename"] || "");
        if (!encodedName || encodedName.length > 1024) fail("INVALID_FILENAME", "A bounded X-ClaimLineage-Filename header is required.");
        let name;
        try {
          name = decodeURIComponent(encodedName);
        } catch {
          fail("INVALID_FILENAME", "X-ClaimLineage-Filename is not valid percent-encoding.");
        }
        const bytes = await bodyBytes(request, MAX_SNAPSHOT_BYTES);
        const snapshot = await importUpload(root, { bytes, name });
        sendJson(response, 201, { snapshot });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/verify") {
        await jsonBody(request);
        sendJson(response, 200, await verifyWorkspace(root));
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found." } });
    } catch (error) {
      if (error instanceof ClaimLineageError) {
        sendJson(response, 400, { error: { code: error.code, message: error.message } });
      } else {
        sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "The local server encountered an unexpected error." } });
      }
    }
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, token };
}
