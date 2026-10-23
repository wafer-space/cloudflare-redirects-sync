// The thin layer that talks to the network: the Cloudflare Lists API and the
// sites' JSON files. Everything goes through a SubrequestBudget, because the
// Workers Free plan allows 50 subrequests per invocation and running out part
// way through a sync should fail clearly, not at a random fetch.

const API_BASE = "https://api.cloudflare.com/client/v4";

export class SubrequestBudget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
  }

  take(what) {
    if (this.used >= this.limit) {
      throw new Error(`out of subrequests (${this.limit}) before ${what}`);
    }
    this.used += 1;
  }
}

export class NotFoundError extends Error {
  constructor(url) {
    super(`${url}: 404 Not Found`);
    this.name = "NotFoundError";
  }
}

export class CloudflareApiError extends Error {
  constructor(method, path, status, errors) {
    const detail = (errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || "no error details";
    super(`${method} ${path}: HTTP ${status}: ${detail}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors ?? [];
  }

  // Only one bulk list operation may be pending per account, and a request
  // made while one is in progress is rejected with HTTP 429.
  get isBusy() {
    return this.status === 429;
  }
}

// Fetch a file's text, bypassing every cache on the way: wafer.space is behind
// Cloudflare and GitHub Pages sends max-age=600.
export async function fetchText(url, { budget, fetch = globalThis.fetch }) {
  budget.take(`GET ${url}`);
  const busted = new URL(url);
  busted.searchParams.set("redirects-sync", Date.now().toString(36));
  const res = await fetch(busted.toString(), {
    cache: "no-store",
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (res.status === 404) throw new NotFoundError(url);
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export class CloudflareApi {
  constructor({ token, accountId, budget, fetch = globalThis.fetch }) {
    if (!token) throw new Error("CF_API_TOKEN is not set");
    if (!accountId) throw new Error("CF_ACCOUNT_ID is not set");
    this.token = token;
    this.accountId = accountId;
    this.budget = budget;
    this.fetch = fetch;
  }

  async request(method, path, body) {
    const fullPath = `/accounts/${this.accountId}${path}`;
    this.budget.take(`${method} ${path}`);
    const res = await this.fetch(`${API_BASE}${fullPath}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new CloudflareApiError(method, path, res.status, [{ code: 0, message: "response is not JSON" }]);
    }
    if (!res.ok || !data.success) {
      throw new CloudflareApiError(method, path, res.status, data.errors);
    }
    return data.result;
  }

  // Every list in the account, with id, name, kind, description and num_items.
  listLists() {
    return this.request("GET", "/rules/lists");
  }

  // Replace all of a list's items. Asynchronous: returns the operation id.
  async replaceItems(listId, items) {
    const result = await this.request(
      "PUT",
      `/rules/lists/${listId}/items`,
      items.map((redirect) => ({ redirect })),
    );
    return result.operation_id;
  }

  // An operation's status: pending, running, completed or failed (with error).
  getOperation(operationId) {
    return this.request("GET", `/rules/lists/bulk_operations/${operationId}`);
  }

  updateDescription(listId, description) {
    return this.request("PUT", `/rules/lists/${listId}`, { description });
  }
}
