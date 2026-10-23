import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest, runSync } from "../src/index.js";

const ACCOUNT = "acct123";
const ENV = { CF_API_TOKEN: "cf-token", CF_ACCOUNT_ID: ACCOUNT, SYNC_SECRET: "s3cret" };
const noWait = async () => {};

const entry = (path, target) => ({
  redirect: { source_url: `wafer.space/${path}`, target_url: target, status_code: 301, preserve_query_string: true },
});
const PROD = [entry("about.html", "https://wafer.space/about"), entry("about/", "https://wafer.space/about")];

// Plays both Cloudflare's API and the two sites, and records every request.
class Fake {
  constructor({ files = {}, lists } = {}) {
    this.files = {
      "https://wafer.space/redirects.json": PROD,
      "https://preview.wafer.space/previews.json": { previews: [{ path: "pr-5", redirects: true }] },
      "https://preview.wafer.space/pr-5/redirects.json": PROD,
      ...files,
    };
    this.lists = lists ?? [
      { id: "L1", name: "wafer_space", kind: "redirect", description: "", num_items: 0 },
      { id: "L2", name: "preview_wafer_space", kind: "redirect", description: "", num_items: 0 },
    ];
    this.items = {};
    this.requests = [];
    this.busyResponses = 0;
    this.operationStatus = ["running", "completed"];
    this.fetch = this.fetch.bind(this);
  }

  writes() {
    return this.requests.filter((r) => r.method !== "GET");
  }

  async fetch(url, init = {}) {
    const method = init.method ?? "GET";
    const u = new URL(url);
    this.requests.push({ method, url, init });
    if (u.hostname !== "api.cloudflare.com") {
      assert.equal(init.cache, "no-store");
      assert.ok(u.searchParams.has("redirects-sync"), "cache-busting parameter");
      u.search = "";
      const body = this.files[u.toString()];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    }
    assert.equal(init.headers.authorization, "Bearer cf-token");
    const path = u.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, "");
    const ok = (result) => Response.json({ success: true, errors: [], result });
    let m;
    if (method === "GET" && path === "/rules/lists") return ok(this.lists);
    if (method === "PUT" && (m = /^\/rules\/lists\/(\w+)\/items$/.exec(path))) {
      if (this.busyResponses > 0) {
        this.busyResponses--;
        return Response.json({ success: false, errors: [{ code: 10000, message: "pending operation" }] }, { status: 429 });
      }
      this.items[m[1]] = JSON.parse(init.body);
      this.lists.find((l) => l.id === m[1]).num_items = this.items[m[1]].length;
      return ok({ operation_id: "op1" });
    }
    if (method === "GET" && path === "/rules/lists/bulk_operations/op1") {
      const status = this.operationStatus.shift() ?? "completed";
      return ok({ id: "op1", status, ...(status === "failed" ? { error: "boom" } : {}) });
    }
    if (method === "PUT" && (m = /^\/rules\/lists\/(\w+)$/.exec(path))) {
      const list = this.lists.find((l) => l.id === m[1]);
      list.description = JSON.parse(init.body).description;
      return ok(list);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }
}

const sync = (fake, opts) => runSync(ENV, opts, { fetch: fake.fetch, wait: noWait });

test("a first sync writes both lists and records their digests", async () => {
  const fake = new Fake();
  const result = await sync(fake);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.lists.wafer_space, { entries: 2, changed: true });
  assert.deepEqual(result.lists.preview_wafer_space, { entries: 2, changed: true });
  assert.deepEqual(
    fake.items.L1.map((i) => i.redirect.source_url),
    ["wafer.space/about.html", "wafer.space/about/"],
  );
  const preview = fake.items.L2.map((i) => i.redirect);
  assert.deepEqual(preview[0], {
    source_url: "preview.wafer.space/pr-5/about.html",
    target_url: "https://preview.wafer.space/pr-5/about",
    status_code: 302,
    include_subdomains: false,
    subpath_matching: false,
    preserve_path_suffix: true,
    preserve_query_string: true,
  });
  assert.match(fake.lists[0].description, /sha256=[0-9a-f]{64}/);
});

test("a second run with the same files writes nothing", async () => {
  const fake = new Fake();
  await sync(fake);
  fake.requests = [];
  const result = await sync(fake);
  assert.deepEqual(result.lists, {
    wafer_space: { entries: 2, changed: false },
    preview_wafer_space: { entries: 2, changed: false },
  });
  assert.deepEqual(fake.writes(), []);
  assert.equal(result.subrequests, 4);
});

test("an unchanged run doesn't parse the files again", async () => {
  const fake = new Fake();
  await sync(fake, { names: ["wafer_space"] });
  // Same bytes as before, so a parse would be the only way to notice this.
  const original = JSON.parse;
  const file = JSON.stringify(PROD);
  JSON.parse = (text, ...rest) => {
    if (text === file) assert.fail("parsed an unchanged file");
    return original(text, ...rest);
  };
  try {
    const result = await sync(fake, { names: ["wafer_space"] });
    assert.equal(result.lists.wafer_space.changed, false);
  } finally {
    JSON.parse = original;
  }
});

test("a change to any file rewrites the list", async () => {
  const fake = new Fake();
  await sync(fake);
  fake.files["https://preview.wafer.space/pr-5/redirects.json"] = PROD.slice(0, 1);
  const result = await sync(fake);
  assert.equal(result.lists.wafer_space.changed, false);
  assert.deepEqual(result.lists.preview_wafer_space, { entries: 1, changed: true });
});

test("force rewrites an unchanged list", async () => {
  const fake = new Fake();
  await sync(fake, { names: ["wafer_space"] });
  const result = await sync(fake, { names: ["wafer_space"], force: true });
  assert.equal(result.lists.wafer_space.changed, true);
});

test("a list whose item count was changed by hand is rewritten", async () => {
  const fake = new Fake();
  await sync(fake, { names: ["wafer_space"] });
  fake.lists[0].num_items = 1;
  const result = await sync(fake, { names: ["wafer_space"] });
  assert.equal(result.lists.wafer_space.changed, true);
});

for (const [name, body] of [
  ["missing", undefined],
  ["not JSON", "<html>oops</html>"],
  ["empty", []],
  ["invalid", [entry("x", "javascript:alert(1)")]],
]) {
  test(`a ${name} production redirects.json leaves both lists alone`, async () => {
    const fake = new Fake({ files: { "https://wafer.space/redirects.json": body } });
    if (body === undefined) delete fake.files["https://wafer.space/redirects.json"];
    const result = await sync(fake, { names: ["wafer_space"] });
    assert.equal(result.ok, false);
    assert.ok(result.lists.wafer_space.error);
    assert.deepEqual(fake.writes(), []);
  });
}

test("a bad preview leaves the preview list alone but production still syncs", async () => {
  const fake = new Fake({ files: { "https://preview.wafer.space/pr-5/redirects.json": [entry("a", "ftp://x")] } });
  const result = await sync(fake);
  assert.equal(result.ok, false);
  assert.equal(result.lists.wafer_space.changed, true);
  assert.match(result.lists.preview_wafer_space.error, /pr-5\/redirects.json\[0\]/);
  assert.equal(fake.items.L2, undefined);
});

test("a preview listed without its redirects.json is skipped with a note", async () => {
  const fake = new Fake({
    files: {
      "https://preview.wafer.space/previews.json": {
        previews: [
          { path: "pr-5", redirects: true },
          { path: "pr-6", redirects: true },
          { path: "pr-7", redirects: false },
        ],
      },
    },
  });
  const result = await sync(fake, { names: ["preview_wafer_space"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lists.preview_wafer_space.notes, ["pr-6: no redirects.json, skipped"]);
  assert.equal(fake.items.L2.length, 2);
  assert.ok(!fake.requests.some((r) => r.url.includes("/pr-7/")));
});

test("no previews empties the preview list", async () => {
  const fake = new Fake({ files: { "https://preview.wafer.space/previews.json": { previews: [] } } });
  fake.lists[1].num_items = 5;
  const result = await sync(fake, { names: ["preview_wafer_space"] });
  assert.deepEqual(result.lists.preview_wafer_space, { entries: 0, changed: true });
  assert.deepEqual(fake.items.L2, []);
});

test("too many previews fails before fetching them", async () => {
  const previews = Array.from({ length: 16 }, (_, i) => ({ path: `pr-${i + 1}`, redirects: true }));
  const fake = new Fake({ files: { "https://preview.wafer.space/previews.json": { previews } } });
  const result = await sync(fake, { names: ["preview_wafer_space"] });
  assert.match(result.lists.preview_wafer_space.error, /more than the 15/);
  assert.ok(!fake.requests.some((r) => r.url.includes("/pr-1/")));
});

test("going over the redirect quota fails without writing", async () => {
  const fake = new Fake();
  fake.lists[1].num_items = 8999;
  const result = await sync(fake, { names: ["wafer_space"] });
  assert.match(result.lists.wafer_space.error, /limit of 9000/);
  assert.deepEqual(fake.writes(), []);
});

test("a write rejected while another operation is pending is retried", async () => {
  const fake = new Fake();
  fake.busyResponses = 2;
  const result = await sync(fake, { names: ["wafer_space"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fake.writes().filter((r) => r.url.endsWith("/items")).length, 3);
});

test("a write that stays rejected gives up with the API's error", async () => {
  const fake = new Fake();
  fake.busyResponses = 10;
  const result = await sync(fake, { names: ["wafer_space"] });
  assert.match(result.lists.wafer_space.error, /HTTP 429: 10000: pending operation/);
  assert.equal(fake.lists[0].description, "");
});

test("a failed bulk operation is reported and the digest is not recorded", async () => {
  const fake = new Fake();
  fake.operationStatus = ["failed"];
  const result = await sync(fake, { names: ["wafer_space"] });
  assert.match(result.lists.wafer_space.error, /failed: boom/);
  assert.equal(fake.lists[0].description, "");
});

test("an operation that never completes is reported", async () => {
  const fake = new Fake();
  fake.operationStatus = Array(10).fill("pending");
  const result = await sync(fake, { names: ["wafer_space"] });
  assert.match(result.lists.wafer_space.error, /still not complete/);
  assert.equal(fake.lists[0].description, "");
});

test("a missing list is reported", async () => {
  const fake = new Fake({ lists: [] });
  const result = await sync(fake);
  assert.match(result.lists.wafer_space.error, /no redirect list named wafer_space/);
  assert.deepEqual(fake.writes(), []);
});

test("a run with many previews stays inside the subrequest budget", async () => {
  const previews = Array.from({ length: 15 }, (_, i) => ({ path: `pr-${i + 1}`, redirects: true }));
  const files = { "https://preview.wafer.space/previews.json": { previews } };
  for (const p of previews) files[`https://preview.wafer.space/${p.path}/redirects.json`] = PROD;
  const fake = new Fake({ files });
  fake.operationStatus = ["running", "running", "running", "running", "completed", "running", "running", "running", "running", "completed"];
  fake.busyResponses = 3;
  const result = await sync(fake);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.subrequests <= 50, `${result.subrequests} subrequests`);
});

test("missing secrets are reported without calling anything", async () => {
  const fake = new Fake();
  const result = await runSync({}, {}, { fetch: fake.fetch, wait: noWait });
  assert.equal(result.ok, false);
  assert.deepEqual(fake.requests, []);
});

const post = (path, headers = { authorization: "Bearer s3cret" }, method = "POST") =>
  new Request(`https://sync.example${path}`, { method, headers });

for (const [name, request, env, status] of [
  ["another path", post("/"), ENV, 404],
  ["GET /sync", post("/sync", undefined, "GET"), ENV, 405],
  ["no token", post("/sync", {}), ENV, 401],
  ["a wrong token", post("/sync", { authorization: "Bearer nope" }), ENV, 401],
  ["a token without Bearer", post("/sync", { authorization: "s3cret" }), ENV, 401],
  ["an unset SYNC_SECRET", post("/sync", { authorization: "Bearer " }), { ...ENV, SYNC_SECRET: undefined }, 401],
  ["an unknown list", post("/sync?list=other"), ENV, 400],
]) {
  test(`the handler answers ${name} with ${status} and calls nothing`, async () => {
    const fake = new Fake();
    const res = await handleRequest(request, env, { fetch: fake.fetch, wait: noWait });
    assert.equal(res.status, status);
    assert.deepEqual(fake.requests, []);
  });
}

test("POST /sync?list= syncs just that list and returns the summary", async () => {
  const fake = new Fake();
  const res = await handleRequest(post("/sync?list=preview_wafer_space"), ENV, { fetch: fake.fetch, wait: noWait });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.lists), ["preview_wafer_space"]);
  assert.equal(fake.items.L1, undefined);
});

test("POST /sync returns 502 when a list fails", async () => {
  const fake = new Fake();
  delete fake.files["https://wafer.space/redirects.json"];
  const res = await handleRequest(post("/sync"), ENV, { fetch: fake.fetch, wait: noWait });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.lists.wafer_space.error, /404/);
  assert.equal(body.lists.preview_wafer_space.changed, true);
});
