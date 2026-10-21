import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startWebServer } from "../apps/web/server.js";
import { initWorkspace } from "../packages/storage/src/workspace.js";
import { temporaryDirectory } from "./helpers.js";

async function runningWeb(t) {
  const root = await temporaryDirectory(t);
  await initWorkspace(root, { name: "Browser workspace" });
  const token = "fixed-test-token";
  const web = await startWebServer(root, { port: 0, token });
  t.after(() => new Promise((resolve) => web.server.close(resolve)));
  return { root, token, ...web };
}

function apiHeaders(web, extra = {}) {
  return { "X-ClaimLineage-Token": web.token, Origin: web.origin, ...extra };
}

async function requestWithHost(origin, token, host) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: "/api/state",
      method: "GET",
      headers: { Host: host, "X-ClaimLineage-Token": token },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

test("web shell has security headers and embeds only the session token", async (t) => {
  const web = await runningWeb(t);
  const response = await fetch(`${web.origin}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(html, /fixed-test-token/);
  assert.doesNotMatch(html, /__SESSION_TOKEN__/);
});

test("API rejects absent token, wrong host, and wrong write origin", async (t) => {
  const web = await runningWeb(t);
  assert.equal((await fetch(`${web.origin}/api/state`)).status, 403);
  assert.equal(await requestWithHost(web.origin, web.token, "example.org"), 403);
  assert.equal((await fetch(`${web.origin}/api/verify`, {
    method: "POST",
    headers: { "X-ClaimLineage-Token": web.token, Origin: "http://example.org", "Content-Type": "application/json" },
    body: "{}",
  })).status, 403);
});

test("web API supports local upload, exact claim, state, and verification", async (t) => {
  const web = await runningWeb(t);
  const upload = await fetch(`${web.origin}/api/imports`, {
    method: "POST",
    headers: apiHeaders(web, { "Content-Type": "application/octet-stream", "X-ClaimLineage-Filename": encodeURIComponent("notes.txt") }),
    body: "Web evidence is exact.",
  });
  assert.equal(upload.status, 201);
  const snapshot = (await upload.json()).snapshot;
  const claimResponse = await fetch(`${web.origin}/api/claims`, {
    method: "POST",
    headers: apiHeaders(web, { "Content-Type": "application/json" }),
    body: JSON.stringify({ statement: "Web evidence exists.", snapshotId: snapshot.id, quote: "evidence is exact" }),
  });
  assert.equal(claimResponse.status, 201);
  const stateResponse = await fetch(`${web.origin}/api/state`, { headers: { "X-ClaimLineage-Token": web.token } });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.claims.length, 1);
  assert.equal(JSON.stringify(state).includes("local-sources"), false);
  const verify = await fetch(`${web.origin}/api/verify`, {
    method: "POST",
    headers: apiHeaders(web, { "Content-Type": "application/json" }),
    body: "{}",
  });
  assert.equal((await verify.json()).valid, true);
});

test("web API returns bounded structured errors without internal paths", async (t) => {
  const web = await runningWeb(t);
  const response = await fetch(`${web.origin}/api/claims`, {
    method: "POST",
    headers: apiHeaders(web, { "Content-Type": "application/json" }),
    body: "not json",
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "INVALID_JSON");
  assert.equal(JSON.stringify(body).includes(web.root), false);
});
