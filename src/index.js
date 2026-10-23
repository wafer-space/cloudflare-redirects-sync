// redirects-sync: loads the redirects.json files that wafer.space and
// preview.wafer.space serve into the wafer_space and preview_wafer_space
// Bulk Redirect lists. Runs on a cron trigger, and on POST /sync from the
// deploy workflows.
//
// Secrets: CF_API_TOKEN (Account Filter Lists Edit), CF_ACCOUNT_ID, and
// SYNC_SECRET (the bearer token POST /sync must send).

import { CloudflareApi } from "./cloudflare.js";
import { LISTS, syncList } from "./sync.js";

const json = (body, status) => Response.json(body, { status });

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Compare digests of the two strings, so neither the comparison's time nor
// its early exit depends on where they first differ, or on their lengths.
async function secretMatches(given, expected) {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function makeApi(env, fetch) {
  return new CloudflareApi({ token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID, fetch });
}

// POST /sync?list=<name>[&number=<n>&commit=<sha>][&force=1]
//
// With number and commit (the revision just deployed), 409 means the site
// isn't serving that revision yet: retry. 503 means another bulk operation is
// pending: retry. 200 covers applied, already up to date, and superseded by a
// newer revision; 202 means Cloudflare accepted the write but hadn't finished
// it when the Worker stopped waiting.
export async function handleRequest(request, env, { fetch = globalThis.fetch, wait } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/sync") return json({ error: "not found" }, 404);
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "use POST" }), {
      status: 405,
      headers: { allow: "POST", "content-type": "application/json" },
    });
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!(await secretMatches(token, env.SYNC_SECRET))) return json({ error: "unauthorized" }, 401);

  const params = url.searchParams;
  const name = params.get("list");
  if (!Object.hasOwn(LISTS, name ?? "")) {
    return json({ error: `list must be one of ${Object.keys(LISTS).join(", ")}` }, 400);
  }
  let requested = null;
  if (params.has("number") || params.has("commit")) {
    const number = params.get("number") ?? "";
    const commit = params.get("commit") ?? "";
    if (!/^\d+$/.test(number) || !/^[0-9a-f]{40}$/.test(commit)) {
      return json({ error: "number must be digits and commit a full 40-character hash, given together" }, 400);
    }
    requested = { number: Number(number), commit };
  }

  try {
    const api = makeApi(env, fetch);
    const [status, body] = await syncList(name, { api, fetch, requested, force: params.get("force") === "1", wait });
    return json({ list: name, ...body }, status);
  } catch (err) {
    return json({ list: name, status: "error", error: err.message }, 500);
  }
}

export async function runScheduled(env, { fetch = globalThis.fetch, wait } = {}) {
  const results = {};
  // One after another: only one bulk operation may be pending per account.
  for (const name of Object.keys(LISTS)) {
    try {
      const [status, body] = await syncList(name, { api: makeApi(env, fetch), fetch, wait });
      results[name] = { http: status, ...body };
    } catch (err) {
      results[name] = { http: 500, status: "error", error: err.message };
    }
  }
  return results;
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(controller, env) {
    const results = await runScheduled(env);
    console.log(JSON.stringify(results));
    // Throwing marks the run as failed in the Workers dashboard. A busy or
    // not-yet-finished write isn't a failure: the next run picks it up.
    if (Object.values(results).some((r) => r.http >= 500 && r.status !== "busy")) {
      throw new Error("redirects sync failed; see the log line above");
    }
  },
};
