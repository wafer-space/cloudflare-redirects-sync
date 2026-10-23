// The thin layer that talks to the network: the Cloudflare Lists API and the
// sites' redirects.json files.

const API_BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  constructor(method, path, status, errors) {
    const detail = (errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || "no error details";
    super(`${method} ${path}: HTTP ${status}: ${detail}`);
    this.name = "CloudflareApiError";
    this.status = status;
  }

  // Only one bulk list operation may be pending per account, and a request
  // made while one is in progress is rejected with HTTP 429.
  get isBusy() {
    return this.status === 429;
  }
}

// Fetch a file's text, bypassing every cache on the way: the sites are
// behind Cloudflare, and GitHub Pages sends max-age=600.
export async function fetchText(url, { fetch = globalThis.fetch } = {}) {
  const busted = new URL(url);
  busted.searchParams.set("redirects-sync", Date.now().toString(36));
  const res = await fetch(busted.toString(), {
    cache: "no-store",
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export class CloudflareApi {
  constructor({ token, accountId, fetch = globalThis.fetch }) {
    if (!token) throw new Error("CF_API_TOKEN is not set");
    if (!accountId) throw new Error("CF_ACCOUNT_ID is not set");
    this.token = token;
    this.accountId = accountId;
    this.fetch = fetch;
  }

  // `body` is sent as is when it's a string (a redirects.json file), and as
  // JSON otherwise.
  async request(method, path, body) {
    const res = await this.fetch(`${API_BASE}/accounts/${this.accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new CloudflareApiError(method, path, res.status, [{ code: 0, message: "response is not JSON" }]);
    }
    if (!res.ok || !data.success) throw new CloudflareApiError(method, path, res.status, data.errors);
    return data.result;
  }

  // Every list in the account, with id, name and kind.
  listLists() {
    return this.request("GET", "/rules/lists");
  }

  // A list's items whose source URL contains `search`.
  searchItems(listId, search) {
    const query = new URLSearchParams({ search, per_page: "50" });
    return this.request("GET", `/rules/lists/${listId}/items?${query}`);
  }

  // Replace all of a list's items with the JSON array in `body`.
  // Asynchronous: returns the operation id.
  async replaceItems(listId, body) {
    const result = await this.request("PUT", `/rules/lists/${listId}/items`, body);
    return result.operation_id;
  }

  // An operation's status: pending, running, completed or failed (with error).
  getOperation(operationId) {
    return this.request("GET", `/rules/lists/bulk_operations/${operationId}`);
  }
}
