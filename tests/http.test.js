import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  fetchHttpSnapshot,
  isPublicAddress,
  requestPinned,
  resolvePublicAddress,
  validateCaptureUrl,
} from "../packages/capture/src/http.js";

test("capture URL accepts only credential-free HTTP and HTTPS", () => {
  assert.equal(validateCaptureUrl("https://example.org/a#fragment").href, "https://example.org/a");
  assert.throws(() => validateCaptureUrl("file:///secret"), (error) => error.code === "UNSUPPORTED_URL_SCHEME");
  assert.throws(() => validateCaptureUrl("https://user:pass@example.org"), (error) => error.code === "URL_CREDENTIALS");
  assert.throws(() => validateCaptureUrl("not a url"), (error) => error.code === "INVALID_URL");
});

test("public address policy rejects loopback, private, documentation, and mapped ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "192.88.99.2", "192.168.1.1", "198.51.100.4", "::1", "fc00::1", "fe80::1", "fec0::1", "2002::1", "3fff::1", "5f00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicAddress("invalid"), false);
});

test("DNS policy rejects a hostname when any returned address is blocked", async () => {
  const resolver = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(
    () => resolvePublicAddress(new URL("https://example.org"), resolver),
    (error) => error.code === "PRIVATE_ADDRESS",
  );
});

test("HTTP capture re-resolves every redirect and returns normalized metadata", async () => {
  const lookups = [];
  const resolver = async (hostname) => {
    lookups.push(hostname);
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const requester = async (url) => url.hostname === "one.example"
    ? { status: 302, location: "https://two.example/final", headers: {}, bytes: Buffer.alloc(0) }
    : { status: 200, headers: { "content-type": "Text/Plain; charset=utf-8" }, bytes: Buffer.from("result") };
  const result = await fetchHttpSnapshot("https://one.example/start", { resolver, requester });
  assert.deepEqual(lookups, ["one.example", "two.example"]);
  assert.equal(result.mediaType, "text/plain");
  assert.equal(result.source.requestedUrl, "https://one.example/start");
  assert.equal(result.source.finalUrl, "https://two.example/final");
  assert.equal(result.bytes.toString(), "result");
});

test("HTTP capture rejects HTTPS downgrade and redirect overflow", async () => {
  const resolver = async () => [{ address: "8.8.8.8", family: 4 }];
  await assert.rejects(
    () => fetchHttpSnapshot("https://secure.example", {
      resolver,
      requester: async () => ({ status: 302, location: "http://plain.example", headers: {}, bytes: Buffer.alloc(0) }),
    }),
    (error) => error.code === "INSECURE_REDIRECT",
  );
  await assert.rejects(
    () => fetchHttpSnapshot("http://loop.example/0", {
      resolver,
      requester: async (url) => ({ status: 302, location: `${Number(url.pathname.slice(1)) + 1}`, headers: {}, bytes: Buffer.alloc(0) }),
    }),
    (error) => error.code === "TOO_MANY_REDIRECTS",
  );
});

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("pinned request reads a bounded identity response", async (t) => {
  const port = await localServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "4" });
    response.end("safe");
  });
  const result = await requestPinned(new URL(`http://localhost:${port}/source`), { address: "127.0.0.1", family: 4 });
  assert.equal(result.status, 200);
  assert.equal(result.bytes.toString(), "safe");
});

test("pinned request rejects declared, streamed, and compressed overflow", async (t) => {
  const declaredPort = await localServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": "20" });
    response.end("x".repeat(20));
  });
  await assert.rejects(
    () => requestPinned(new URL(`http://localhost:${declaredPort}`), { address: "127.0.0.1", family: 4 }, { maximumBytes: 10 }),
    /exceeds 10 bytes/,
  );

  const streamedPort = await localServer(t, (_request, response) => {
    response.writeHead(200);
    response.end("x".repeat(20));
  });
  await assert.rejects(
    () => requestPinned(new URL(`http://localhost:${streamedPort}`), { address: "127.0.0.1", family: 4 }, { maximumBytes: 10 }),
    /exceeds 10 bytes/,
  );

  const compressedPort = await localServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Encoding": "gzip" });
    response.end("not compressed");
  });
  await assert.rejects(
    () => requestPinned(new URL(`http://localhost:${compressedPort}`), { address: "127.0.0.1", family: 4 }),
    /content-encoding gzip is not accepted/,
  );
});

test("capture wraps transport failures with stable error code", async () => {
  await assert.rejects(
    () => fetchHttpSnapshot("https://example.org", {
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      requester: async () => { throw new Error("socket closed"); },
    }),
    (error) => error.code === "CAPTURE_FAILED" && /socket closed/.test(error.message),
  );
});
