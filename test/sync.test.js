import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest, runScheduled } from "../src/index.js";
import { parseRevision } from "../src/sync.js";

const ACCOUNT = "acct123";
const ENV = { CF_API_TOKEN: "cf-token", CF_ACCOUNT_ID: ACCOUNT, SYNC_SECRET: "s3cret" };
const noWait = async () => {};
const sha = (c) => c.repeat(40);

const revision = (host, number, commit, extra = "") => ({
  comment: `v0.0-${number}${extra}`,
  redirect: {
    source_url: `${host}/revision`,
    target_url: `https://github.com/wafer-space/wafer-space.github.io/commit/${commit}`,
    status_code: 302,
  },
});
const redirect = (host, path) => ({
  redirect: { source_url: `${host}/${path}`, target_url: `https://${host}/x`, status_code: 301 },
});
const file = (host, number, commit) =>
  JSON.stringify([revision(host, number, commit), redirect(host, "a.html"), redirect(host, "b/")], null, 2);

// Plays both Cloudflare's API and the two sites, and records every request.
class Fake {
  constructor() {
    this.files = {
      "https://wafer.space/redirects.json": file("wafer.space", 10, sha("a")),
      "https://preview.wafer.space/redirects.json": file("preview.wafer.space", 50, sha("b")),
    };
    this.lists = [
      { id: "L1", name: "wafer_space", kind: "redirect" },
      { id: "L2", name: "preview_wafer_space", kind: "redirect" },
    ];
    this.items = { L1: [], L2: [] };
    this.requests = [];
    this.busy = false;
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
      return new Response(body, { status: 200 });
    }
    assert.equal(init.headers.authorization, "Bearer cf-token");
    const path = u.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, "");
    const ok = (result) => Response.json({ success: true, errors: [], result });
    let m;
    if (method === "GET" && path === "/rules/lists") return ok(this.lists);
    if (method === "GET" && (m = /^\/rules\/lists\/(\w+)\/items$/.exec(path))) {
      const search = u.searchParams.get("search");
      return ok(this.items[m[1]].filter((i) => i.redirect.source_url.includes(search)));
    }
    if (method === "PUT" && (m = /^\/rules\/lists\/(\w+)\/items$/.exec(path))) {
      if (this.busy) {
        return Response.json({ success: false, errors: [{ code: 10000, message: "pending operation" }] }, { status: 429 });
      }
      this.putBody = init.body;
      this.items[m[1]] = JSON.parse(init.body);
      return ok({ operation_id: "op1" });
    }
    if (method === "GET" && path === "/rules/lists/bulk_operations/op1") {
      const status = this.operationStatus.shift() ?? "completed";
      return ok({ id: "op1", status, ...(status === "failed" ? { error: "boom" } : {}) });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }
}

const post = (query, headers = { authorization: "Bearer s3cret" }, method = "POST", path = "/sync") =>
  new Request(`https://sync.example${path}${query}`, { method, headers });

async function sync(fake, query) {
  const res = await handleRequest(post(query), ENV, { fetch: fake.fetch, wait: noWait });
  return [res.status, await res.json()];
}

test("parseRevision reads the number and commit", () => {
  assert.deepEqual(parseRevision(revision("wafer.space", 474, sha("c"), "-gcccccccc"), "wafer.space"), {
    number: 474,
    commit: sha("c"),
    comment: "v0.0-474-gcccccccc",
  });
  assert.equal(parseRevision(revision("wafer.space", 474, sha("c"), " pr-126"), "wafer.space").number, 474);
});

test("parseRevision rejects anything else", () => {
  const good = revision("wafer.space", 1, sha("a"));
  for (const item of [
    undefined,
    {},
    redirect("wafer.space", "revision"),
    revision("preview.wafer.space", 1, sha("a")),
    { ...good, comment: "474" },
    { ...good, comment: undefined },
    { ...good, redirect: { ...good.redirect, target_url: "https://github.com/x/commit/abc" } },
  ]) {
    assert.equal(parseRevision(item, "wafer.space"), null, JSON.stringify(item));
  }
});

test("a first sync writes the file exactly as served", async () => {
  const fake = new Fake();
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.status, "applied");
  assert.equal(body.file.number, 10);
  assert.equal(body.previous, null);
  assert.equal(fake.putBody, fake.files["https://wafer.space/redirects.json"]);
  assert.equal(fake.items.L2.length, 0);
});

test("a sync with the same revision writes nothing", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.requests = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [200, "up_to_date"]);
  assert.deepEqual(fake.writes(), []);
});

test("an older file never replaces a newer list", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.files["https://wafer.space/redirects.json"] = file("wafer.space", 9, sha("9"));
  fake.requests = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [200, "list_is_newer"]);
  assert.deepEqual(fake.writes(), []);
});

test("force rewrites the list anyway", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.files["https://wafer.space/redirects.json"] = file("wafer.space", 9, sha("9"));
  const [status, body] = await sync(fake, "?list=wafer_space&force=1");
  assert.deepEqual([status, body.status], [200, "applied"]);
  assert.equal(parseRevision(fake.items.L1[0], "wafer.space").number, 9);
});

test("a newer file replaces the list", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.files["https://wafer.space/redirects.json"] = file("wafer.space", 11, sha("d"));
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [200, "applied"]);
  assert.equal(body.previous.number, 10);
});

test("a requested revision that isn't published yet is a 409 and writes nothing", async () => {
  const fake = new Fake();
  const [status, body] = await sync(fake, `?list=wafer_space&number=11&commit=${sha("d")}`);
  assert.deepEqual([status, body.status], [409, "not_published"]);
  assert.deepEqual(body.requested, { number: 11, commit: sha("d") });
  assert.deepEqual(fake.writes(), []);
  assert.ok(!fake.requests.some((r) => r.url.includes("api.cloudflare.com")));
});

test("a requested revision with a different commit is a 409", async () => {
  const fake = new Fake();
  const [status, body] = await sync(fake, `?list=wafer_space&number=10&commit=${sha("e")}`);
  assert.deepEqual([status, body.status], [409, "commit_mismatch"]);
  assert.deepEqual(fake.writes(), []);
});

test("the requested revision is applied", async () => {
  const fake = new Fake();
  const [status, body] = await sync(fake, `?list=wafer_space&number=10&commit=${sha("a")}`);
  assert.deepEqual([status, body.status], [200, "applied"]);
});

test("a file newer than the requested revision is applied", async () => {
  const fake = new Fake();
  const [status, body] = await sync(fake, `?list=wafer_space&number=8&commit=${sha("8")}`);
  assert.deepEqual([status, body.status], [200, "applied"]);
  assert.equal(body.file.number, 10);
});

test("a pending bulk operation is a 503, without retrying", async () => {
  const fake = new Fake();
  fake.busy = true;
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [503, "busy"]);
  assert.equal(fake.writes().length, 1);
});

test("a failed bulk operation is a 502", async () => {
  const fake = new Fake();
  fake.operationStatus = ["failed"];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [502, "failed"]);
  assert.equal(body.error, "boom");
});

test("an operation still running when the Worker stops waiting is a 202", async () => {
  const fake = new Fake();
  fake.operationStatus = Array(10).fill("running");
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [202, "pending"]);
});

for (const [name, body] of [
  ["missing", undefined],
  ["not JSON", "<html>oops</html>"],
  ["not an array", JSON.stringify({ items: [] })],
  ["empty", "[]"],
  ["without a revision first", JSON.stringify([redirect("wafer.space", "a.html")])],
  ["with another host's revision first", file("preview.wafer.space", 10, sha("a"))],
]) {
  test(`a ${name} redirects.json is a 502 and writes nothing`, async () => {
    const fake = new Fake();
    fake.files["https://wafer.space/redirects.json"] = body;
    const [status, res] = await sync(fake, "?list=wafer_space");
    assert.deepEqual([status, res.status], [502, "error"]);
    assert.deepEqual(fake.writes(), []);
  });
}

test("a missing list is a 500", async () => {
  const fake = new Fake();
  fake.lists = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.equal(status, 500);
  assert.match(body.error, /no redirect list named wafer_space/);
});

test("missing secrets are a 500 without calling Cloudflare", async () => {
  const fake = new Fake();
  const res = await handleRequest(post("?list=wafer_space"), { SYNC_SECRET: "s3cret" }, { fetch: fake.fetch, wait: noWait });
  assert.equal(res.status, 500);
  assert.ok(!fake.requests.some((r) => r.url.includes("api.cloudflare.com")));
});

for (const [name, request, env, status] of [
  ["another path", post("?list=wafer_space", undefined, "POST", "/"), ENV, 404],
  ["GET /sync", post("?list=wafer_space", undefined, "GET"), ENV, 405],
  ["no token", post("?list=wafer_space", {}), ENV, 401],
  ["a wrong token", post("?list=wafer_space", { authorization: "Bearer nope" }), ENV, 401],
  ["a token without Bearer", post("?list=wafer_space", { authorization: "s3cret" }), ENV, 401],
  ["an unset SYNC_SECRET", post("?list=wafer_space", { authorization: "Bearer " }), { ...ENV, SYNC_SECRET: undefined }, 401],
  ["no list", post(""), ENV, 400],
  ["an unknown list", post("?list=other"), ENV, 400],
  ["a list named like an Object property", post("?list=toString"), ENV, 400],
  ["a number without a commit", post("?list=wafer_space&number=3"), ENV, 400],
  ["a short commit", post("?list=wafer_space&number=3&commit=abc"), ENV, 400],
  ["a non-numeric number", post(`?list=wafer_space&number=x&commit=${sha("a")}`), ENV, 400],
]) {
  test(`the handler answers ${name} with ${status} and fetches nothing`, async () => {
    const fake = new Fake();
    const res = await handleRequest(request, env, { fetch: fake.fetch, wait: noWait });
    assert.equal(res.status, status);
    assert.deepEqual(fake.requests, []);
  });
}

test("the cron run syncs both lists, one after the other", async () => {
  const fake = new Fake();
  const results = await runScheduled(ENV, { fetch: fake.fetch, wait: noWait });
  assert.deepEqual(
    Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [v.http, v.status]])),
    { wafer_space: [200, "applied"], preview_wafer_space: [200, "applied"] },
  );
  const puts = fake.writes().map((r) => new URL(r.url).pathname.split("/")[7]);
  assert.deepEqual(puts, ["L1", "L2"]);
});

test("a cron run reports a failing list without stopping the other", async () => {
  const fake = new Fake();
  delete fake.files["https://wafer.space/redirects.json"];
  const results = await runScheduled(ENV, { fetch: fake.fetch, wait: noWait });
  assert.equal(results.wafer_space.http, 502);
  assert.equal(results.preview_wafer_space.status, "applied");
});
