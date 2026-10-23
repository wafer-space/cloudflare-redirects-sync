// wafer-space-redirects-sync: keeps the wafer_space and preview_wafer_space
// Bulk Redirect lists in sync with the redirects.json files the sites serve.
// Runs on a cron trigger, and on POST /sync from the deploy workflows.
//
// Secrets: CF_API_TOKEN (Account Filter Lists Edit), CF_ACCOUNT_ID, and
// SYNC_SECRET (the bearer token POST /sync must send).

import { CloudflareApi, SubrequestBudget, fetchText } from "./cloudflare.js";
import { LIST_NAMES, syncLists } from "./sync.js";

// Workers Free plan: 50 subrequests per invocation.
const SUBREQUEST_LIMIT = 50;

export async function runSync(env, { names, force } = {}, { fetch = globalThis.fetch, wait } = {}) {
  const budget = new SubrequestBudget(SUBREQUEST_LIMIT);
  let api;
  try {
    api = new CloudflareApi({ token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID, budget, fetch });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const result = await syncLists({
    api,
    fetchText: (url) => fetchText(url, { budget, fetch }),
    names,
    force,
    wait,
  });
  return { ...result, subrequests: budget.used };
}

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

const json = (body, status) => Response.json(body, { status });

export async function handleRequest(request, env, deps) {
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

  const list = url.searchParams.get("list");
  if (list !== null && !LIST_NAMES.includes(list)) {
    return json({ error: `list must be one of ${LIST_NAMES.join(", ")}` }, 400);
  }
  const force = url.searchParams.get("force") === "1";
  const result = await runSync(env, { names: list ? [list] : LIST_NAMES, force }, deps);
  return json(result, result.ok ? 200 : 502);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(controller, env) {
    const result = await runSync(env);
    console.log(JSON.stringify(result));
    // Throwing marks the cron run as failed in the Workers dashboard.
    if (!result.ok) throw new Error("redirects sync failed; see the log line above");
  },
};
