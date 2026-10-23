// Replace a Bulk Redirect list with the redirects.json a site serves, when
// that file is newer than what the list holds.
//
// The only state is the list itself. The first item of every redirects.json
// is its revision: source <host>/revision, target the commit on GitHub, and
// a comment starting with `git describe` (v0.0-<number>...). It is written in
// the same replace as the redirects, so the list's own copy always says which
// revision the list holds. A file whose number isn't higher than that is
// ignored, so a late, cached or out-of-order copy never replaces a newer one.
//
// Nothing here retries: when the requested revision isn't published yet, or
// another bulk operation is pending, the caller gets an error status and
// retries (the deploy workflows do; the cron trigger simply runs again).

import { fetchText } from "./cloudflare.js";

export const LISTS = {
  wafer_space: { url: "https://wafer.space/redirects.json", host: "wafer.space" },
  preview_wafer_space: { url: "https://preview.wafer.space/redirects.json", host: "preview.wafer.space" },
};

// Waits before each status check of the bulk operation, in milliseconds.
export const POLL_DELAYS = [1000, 2000, 4000, 8000];

const COMMENT_RE = /^v\d+(?:\.\d+)*-(\d+)(?:\b|$)/;
const COMMIT_RE = /\/commit\/([0-9a-f]{40})$/;

// The revision an item records, or null if it isn't a revision item for host.
export function parseRevision(item, host) {
  const r = item?.redirect;
  if (!r || r.source_url !== `${host}/revision`) return null;
  const number = COMMENT_RE.exec(item.comment ?? "");
  const commit = COMMIT_RE.exec(r.target_url ?? "");
  if (!number || !commit) return null;
  return { number: Number(number[1]), commit: commit[1], comment: item.comment };
}

// The file's first item, cut out of its text so the rest (thousands of items
// for the previews) is never parsed: the Free plan allows 10 ms of CPU. It
// ends at the first "}" followed by "}" (its redirect's, then its own); any
// other shape fails to parse and is reported as a file without a revision.
const FIRST_ITEM_RE = /^\s*\[\s*(\{[\s\S]*?\}\s*\})/;

export function fileRevision(text, host) {
  const match = FIRST_ITEM_RE.exec(text);
  try {
    return match ? parseRevision(JSON.parse(match[1]), host) : null;
  } catch {
    return null;
  }
}

// The revision the list's own revision item records, or null.
async function listRevision(api, listId, host) {
  const found = await api.searchItems(listId, `${host}/revision`);
  return found.map((item) => parseRevision(item, host)).find(Boolean) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns [HTTP status, body]; never throws.
export async function syncList(name, options) {
  try {
    return await sync(name, options);
  } catch (err) {
    return [500, { status: "error", error: err.message }];
  }
}

async function sync(name, { api, fetch, requested, force = false, wait = sleep }) {
  const { url, host } = LISTS[name];

  let text;
  try {
    text = await fetchText(url, { fetch });
  } catch (err) {
    return [502, { status: "error", error: err.message }];
  }
  const file = fileRevision(text, host);
  if (!file) return [502, { status: "error", error: `${url} doesn't start with a ${host}/revision item` }];

  if (requested) {
    if (file.number < requested.number) {
      return [409, { status: "not_published", file, requested }];
    }
    if (file.number === requested.number && file.commit !== requested.commit) {
      return [409, { status: "commit_mismatch", file, requested }];
    }
  }

  const list = (await api.listLists()).find((l) => l.name === name && l.kind === "redirect");
  if (!list) return [500, { status: "error", error: `no redirect list named ${name}` }];
  const current = await listRevision(api, list.id, host);

  if (!force && current && file.number <= current.number) {
    return [200, { status: file.number === current.number ? "up_to_date" : "list_is_newer", file, list: current }];
  }

  let operationId;
  try {
    operationId = await api.replaceItems(list.id, text);
  } catch (err) {
    if (err.isBusy) return [503, { status: "busy", error: err.message, file }];
    throw err;
  }
  for (const delay of POLL_DELAYS) {
    await wait(delay);
    const op = await api.getOperation(operationId);
    if (op.status === "failed") {
      return [502, { status: "failed", error: op.error ?? "no error given", operation_id: operationId, file }];
    }
    if (op.status !== "completed") continue;
    // Another sync may have written between this one's check and its write,
    // so return the revision read back from the list for the caller to check
    // against the one it asked for.
    const readback = await listRevision(api, list.id, host);
    if (!readback) {
      return [502, { status: "failed", error: "no revision item in the list after writing", file, previous: current }];
    }
    return [200, { status: "applied", file, list: readback, previous: current }];
  }
  return [202, { status: "pending", operation_id: operationId, file }];
}
