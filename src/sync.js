// The three operations behind the Worker's endpoints, for one list:
//
// - sourceRevision: fetch the redirects.json the site serves and return the
//   revision it records;
// - listRevision: return the revision the Cloudflare list holds;
// - syncList: do both, and replace the list with the file when the file's
//   revision is newer.
//
// The only state is the list itself. The first item of every redirects.json
// is its revision: source <host>/revision, target the commit on GitHub, and
// a comment starting with `git describe` (v0.0-<number>...). It is written in
// the same replace as the redirects, so the list's own copy always says which
// revision the list holds. A file whose number isn't higher than that is
// never written, so a late, cached or out-of-order copy can't replace a newer
// one.
//
// Nothing here retries: when another bulk operation is pending the caller
// gets an error status and retries (the deploy workflows do; the cron
// trigger simply runs again).

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

// Each operation returns [HTTP status, body] and never throws.
async function guarded(run) {
  try {
    return await run();
  } catch (err) {
    return [500, { status: "error", error: err.message }];
  }
}

// The site's file and its revision, or { error: [status, body] }.
async function fetchSource(name, { fetch }) {
  const { url, host } = LISTS[name];
  let text;
  try {
    text = await fetchText(url, { fetch });
  } catch (err) {
    return { error: [502, { status: "error", error: err.message }] };
  }
  const revision = fileRevision(text, host);
  if (!revision) return { error: [502, { status: "error", error: `${url} doesn't start with a ${host}/revision item` }] };
  return { text, revision };
}

// The list's id and the revision its revision item records (or null).
async function fetchList(name, { api }) {
  const { host } = LISTS[name];
  const list = (await api.listLists()).find((l) => l.name === name && l.kind === "redirect");
  if (!list) throw new Error(`no redirect list named ${name}`);
  const found = await api.searchItems(list.id, `${host}/revision`);
  return { id: list.id, revision: found.map((item) => parseRevision(item, host)).find(Boolean) ?? null };
}

// GET /source
export function sourceRevision(name, { fetch }) {
  return guarded(async () => {
    const source = await fetchSource(name, { fetch });
    return source.error ?? [200, { status: "ok", source: source.revision }];
  });
}

// GET /list
export function listRevision(name, { api }) {
  return guarded(async () => [200, { status: "ok", list: (await fetchList(name, { api })).revision }]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POST /sync
export function syncList(name, { api, fetch, force = false, wait = sleep }) {
  return guarded(async () => {
    const source = await fetchSource(name, { fetch });
    if (source.error) return source.error;
    const { id, revision: current } = await fetchList(name, { api });
    const result = { source: source.revision, list: current };

    if (!force && current) {
      if (source.revision.number === current.number && source.revision.commit !== current.commit) {
        return [409, { status: "commit_mismatch", ...result }];
      }
      if (source.revision.number <= current.number) {
        return [200, { status: source.revision.number === current.number ? "up_to_date" : "list_is_newer", ...result }];
      }
    }

    let operationId;
    try {
      operationId = await api.replaceItems(id, source.text);
    } catch (err) {
      if (err.isBusy) return [503, { status: "busy", error: err.message, ...result }];
      throw err;
    }
    for (const delay of POLL_DELAYS) {
      await wait(delay);
      const op = await api.getOperation(operationId);
      if (op.status === "failed") {
        return [502, { status: "failed", error: op.error ?? "no error given", operation_id: operationId, ...result }];
      }
      if (op.status !== "completed") continue;
      // Another sync may have written between this one's check and its
      // write, so report what the list holds now, read back from Cloudflare.
      const { revision: readback } = await fetchList(name, { api });
      if (!readback) {
        return [502, { status: "failed", error: "no revision item in the list after writing", ...result }];
      }
      return [200, { status: "applied", source: source.revision, list: readback, previous: current }];
    }
    return [202, { status: "pending", operation_id: operationId, ...result }];
  });
}
