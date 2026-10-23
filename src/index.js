// redirects-sync: loads the redirects.json files that wafer.space and
// preview.wafer.space serve into the wafer_space and preview_wafer_space
// Bulk Redirect lists. Runs on a cron trigger, and on requests from the
// deploy workflows:
//
//   GET  /source?list=<name>  the revision the site's redirects.json records
//   GET  /list?list=<name>    the revision the Cloudflare list holds
//   POST /sync?list=<name>    both, then replace the list if the site's
//                             revision is newer ([&force=1]: even if not)
//
// Every request needs `Authorization: Bearer <SYNC_SECRET>`.
//
// Secrets: CF_API_TOKEN (Account Filter Lists Edit), CF_ACCOUNT_ID, and
// SYNC_SECRET.

import { CloudflareApi } from "./cloudflare.js";
import { LISTS, listRevision, sourceRevision, syncList } from "./sync.js";

const json = (body, status, headers) => Response.json(body, { status, headers });

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

const ROUTES = {
  "/source": { method: "GET", run: (name, deps) => sourceRevision(name, deps) },
  "/list": { method: "GET", run: (name, deps) => listRevision(name, { api: deps.api() }) },
  "/sync": { method: "POST", run: (name, deps) => syncList(name, { ...deps, api: deps.api() }) },
};

export async function handleRequest(request, env, { fetch = globalThis.fetch, wait } = {}) {
  const url = new URL(request.url);
  const route = ROUTES[url.pathname];
  if (!route) return json({ error: "not found" }, 404);
  if (request.method !== route.method) {
    return json({ error: `use ${route.method}` }, 405, { allow: route.method });
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!(await secretMatches(token, env.SYNC_SECRET))) return json({ error: "unauthorized" }, 401);

  const name = url.searchParams.get("list");
  if (!Object.hasOwn(LISTS, name ?? "")) {
    return json({ error: `list must be one of ${Object.keys(LISTS).join(", ")}` }, 400);
  }
  let status, body;
  try {
    const deps = { fetch, wait, force: url.searchParams.get("force") === "1", api: () => makeApi(env, fetch) };
    [status, body] = await route.run(name, deps);
  } catch (err) {
    [status, body] = [500, { status: "error", error: err.message }];
  }
  return json({ list: name, ...body }, status);
}

export async function runScheduled(env, { fetch = globalThis.fetch, wait } = {}) {
  const api = makeApi(env, fetch);
  const results = {};
  // One after another: only one bulk operation may be pending per account.
  for (const name of Object.keys(LISTS)) {
    const [status, body] = await syncList(name, { api, fetch, wait });
    results[name] = { http: status, ...body };
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
