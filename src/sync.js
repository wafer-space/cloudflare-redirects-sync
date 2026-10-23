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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns [HTTP status, body].
export async function syncList(name, { api, fetch, requested, force = false, wait = sleep }) {
  const { url, host } = LISTS[name];

  let text;
  let file;
  try {
    text = await fetchText(url, { fetch });
    const items = JSON.parse(text);
    file = Array.isArray(items) ? parseRevision(items[0], host) : null;
  } catch (err) {
    return [502, { status: "error", error: err.message }];
  }
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
  const found = await api.searchItems(list.id, `${host}/revision`);
  const current = found.map((item) => parseRevision(item, host)).find(Boolean) ?? null;

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
    if (op.status === "completed") return verify(name, list, file, current, { api });
    if (op.status === "failed") {
      return [502, { status: "failed", error: op.error ?? "no error given", operation_id: operationId, file }];
    }
  }
  return [202, { status: "pending", operation_id: operationId, file }];
}

// After a write, read the list's revision back from Cloudflare and return it
// as `list`. Another sync may have written between this one's check and its
// write, so the caller checks that the list holds at least the revision it
// asked for, and retries if not.
async function verify(name, list, file, previous, { api }) {
  const { host } = LISTS[name];
  const found = await api.searchItems(list.id, `${host}/revision`);
  const readback = found.map((item) => parseRevision(item, host)).find(Boolean) ?? null;
  if (!readback) {
    return [502, { status: "failed", error: "no revision item in the list after writing", file, previous }];
  }
  return [200, { status: "applied", file, list: readback, previous }];
}
