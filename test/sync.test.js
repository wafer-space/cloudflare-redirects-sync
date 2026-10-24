import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest, runScheduled } from "../src/index.js";
import { CloudflareApi } from "../src/cloudflare.js";
import { fileRevision, parseRevision } from "../src/sync.js";

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
      assert.ok(u.searchParams.has("redirects"), "cache-busting parameter");
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
      // Lets a test change the list just as the write completes, like another
      // sync's write landing straight after this one
      if (status === "completed") this.afterComplete?.();
      return ok({ id: "op1", status, ...(status === "failed" ? { error: "boom" } : {}) });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }
}

const call = (path, query, { method = path === "/sync" ? "POST" : "GET", headers = { authorization: "Bearer s3cret" } } = {}) =>
  new Request(`https://sync.example${path}${query}`, { method, headers });

async function request(fake, path, query, env = ENV) {
  const res = await handleRequest(call(path, query), env, { fetch: fake.fetch, wait: noWait });
  return [res.status, await res.json()];
}
const sync = (fake, query) => request(fake, "/sync", query);

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

test("fileRevision reads only the first item, pretty or compact", () => {
  const items = [revision("wafer.space", 7, sha("a")), redirect("wafer.space", "a.html")];
  for (const text of [JSON.stringify(items, null, 2), JSON.stringify(items), ` \n${JSON.stringify(items)}\n`]) {
    assert.equal(fileRevision(text, "wafer.space")?.number, 7, text.slice(0, 40));
  }
  // The rest of the file is never parsed
  const head = JSON.stringify([revision("wafer.space", 8, sha("a"))]).slice(0, -1);
  assert.equal(fileRevision(`${head}, {not json at all`, "wafer.space").number, 8);
});

test("fileRevision rejects files that don't start with a revision item", () => {
  const good = revision("wafer.space", 7, sha("a"));
  const reordered = { redirect: good.redirect, comment: good.comment };
  for (const text of [
    "",
    "[]",
    "{}",
    "<html>",
    JSON.stringify([redirect("wafer.space", "a.html"), good]),
    JSON.stringify([reordered, redirect("wafer.space", "a.html")]),
  ]) {
    assert.equal(fileRevision(text, "wafer.space"), null, text.slice(0, 60));
  }
});

test("GET /source returns the site file's revision without calling Cloudflare", async () => {
  const fake = new Fake();
  const [status, body] = await request(fake, "/source", "?list=wafer_space");
  assert.equal(status, 200);
  assert.equal(body.name, "wafer_space");
  assert.deepEqual(body.source, { number: 10, commit: sha("a"), comment: "v0.0-10" });
  assert.ok(!fake.requests.some((r) => r.url.includes("api.cloudflare.com")));
});

test("GET /source reports a file without a revision as a 502", async () => {
  const fake = new Fake();
  fake.files["https://wafer.space/redirects.json"] = "[]";
  const [status, body] = await request(fake, "/source", "?list=wafer_space");
  assert.deepEqual([status, body.status], [502, "error"]);
});

test("GET /list returns the list's revision, or null for an empty list, without fetching the site", async () => {
  const fake = new Fake();
  let [status, body] = await request(fake, "/list", "?list=wafer_space");
  assert.deepEqual([status, body.list], [200, null]);
  await sync(fake, "?list=wafer_space");
  fake.requests = [];
  [status, body] = await request(fake, "/list", "?list=wafer_space");
  assert.deepEqual([status, body.list.number], [200, 10]);
  assert.ok(fake.requests.every((r) => r.url.includes("api.cloudflare.com")));
  assert.deepEqual(fake.writes(), []);
});

test("GET /list for a missing list is a 500", async () => {
  const fake = new Fake();
  fake.lists = [];
  const [status, body] = await request(fake, "/list", "?list=wafer_space");
  assert.equal(status, 500);
  assert.match(body.error, /no redirect list named wafer_space/);
});

test("a first sync writes the file exactly as served", async () => {
  const fake = new Fake();
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.status, "applied");
  assert.equal(body.source.number, 10);
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
  assert.equal(body.list.number, 10);
  assert.deepEqual(fake.writes(), []);
});

test("an older file never replaces a newer list", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.files["https://wafer.space/redirects.json"] = file("wafer.space", 9, sha("9"));
  fake.requests = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [200, "list_is_newer"]);
  assert.deepEqual([body.source.number, body.list.number], [9, 10]);
  assert.deepEqual(fake.writes(), []);
});

test("the same number with a different commit is a 409 and writes nothing", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.files["https://wafer.space/redirects.json"] = file("wafer.space", 10, sha("e"));
  fake.requests = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [409, "commit_mismatch"]);
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

test("a newer file replaces the list, and the readback is reported", async () => {
  const fake = new Fake();
  await sync(fake, "?list=wafer_space");
  fake.files["https://wafer.space/redirects.json"] = file("wafer.space", 11, sha("d"));
  fake.requests = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [200, "applied"]);
  assert.deepEqual([body.previous.number, body.source.number, body.list.number], [10, 11, 11]);
  assert.equal(body.list.commit, sha("d"));
  const reads = fake.requests.filter((r) => r.url.includes("/items?"));
  assert.equal(reads.length, 2, "one search before the write, one after");
  const siteFetches = fake.requests.filter((r) => !r.url.includes("api.cloudflare.com"));
  assert.equal(siteFetches.length, 1, "the site is fetched only once");
});

test("an older write landing straight after shows in the readback", async () => {
  const fake = new Fake();
  fake.afterComplete = () => {
    fake.items.L1 = JSON.parse(file("wafer.space", 9, sha("9")));
  };
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [200, "applied"]);
  assert.deepEqual([body.source.number, body.list.number], [10, 9]);
});

test("no revision item after the write is a 502", async () => {
  const fake = new Fake();
  fake.afterComplete = () => {
    fake.items.L1 = [];
  };
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.deepEqual([status, body.status], [502, "failed"]);
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

test("a sync to a missing list is a 500", async () => {
  const fake = new Fake();
  fake.lists = [];
  const [status, body] = await sync(fake, "?list=wafer_space");
  assert.equal(status, 500);
  assert.match(body.error, /no redirect list named wafer_space/);
});

test("missing secrets are a 500 without calling Cloudflare", async () => {
  const fake = new Fake();
  for (const path of ["/list", "/sync"]) {
    const [status] = await request(fake, path, "?list=wafer_space", { SYNC_SECRET: "s3cret" });
    assert.equal(status, 500, path);
  }
  assert.ok(!fake.requests.some((r) => r.url.includes("api.cloudflare.com")));
});

for (const [name, req, env, status] of [
  ["another path", call("/", "?list=wafer_space"), ENV, 404],
  ["GET /sync", call("/sync", "?list=wafer_space", { method: "GET" }), ENV, 405],
  ["POST /source", call("/source", "?list=wafer_space", { method: "POST" }), ENV, 405],
  ["POST /list", call("/list", "?list=wafer_space", { method: "POST" }), ENV, 405],
  ["no token", call("/sync", "?list=wafer_space", { headers: {} }), ENV, 401],
  ["no token on GET /source", call("/source", "?list=wafer_space", { headers: {} }), ENV, 401],
  ["no token on GET /list", call("/list", "?list=wafer_space", { headers: {} }), ENV, 401],
  ["a wrong token", call("/sync", "?list=wafer_space", { headers: { authorization: "Bearer nope" } }), ENV, 401],
  ["a token without Bearer", call("/sync", "?list=wafer_space", { headers: { authorization: "s3cret" } }), ENV, 401],
  ["an unset SYNC_SECRET", call("/sync", "?list=wafer_space", { headers: { authorization: "Bearer " } }), { ...ENV, SYNC_SECRET: undefined }, 401],
  ["no list", call("/sync", ""), ENV, 400],
  ["an unknown list", call("/source", "?list=other"), ENV, 400],
  ["a list named like an Object property", call("/list", "?list=toString"), ENV, 400],
]) {
  test(`the handler answers ${name} with ${status} and fetches nothing`, async () => {
    const fake = new Fake();
    const res = await handleRequest(req, env, { fetch: fake.fetch, wait: noWait });
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

test("the API client calls fetch as a plain function, as the Workers runtime requires", async () => {
  // Like the runtime's fetch, which throws "Illegal invocation" for any other `this`
  function strictFetch() {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    throw new Error("fetched");
  }
  const api = new CloudflareApi({ token: "t", accountId: ACCOUNT, fetch: strictFetch });
  await assert.rejects(api.request("GET", "/rules/lists"), /fetched/);
});
