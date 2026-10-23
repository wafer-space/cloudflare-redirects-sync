// Bring each Bulk Redirect list in line with the redirects.json files the
// sites currently serve. Every run rebuilds a list from scratch, so whichever
// run (cron or a deploy's ping) writes last leaves it correct.

import { NotFoundError } from "./cloudflare.js";
import {
  ValidationError,
  buildPreviewItems,
  describeList,
  inputDigest,
  parseDescription,
  parseJson,
  parsePreviewIndex,
  parseRedirects,
  sortItems,
} from "./redirects.js";

export const PRODUCTION_URL = "https://wafer.space/redirects.json";
export const PREVIEW_ROOT = "https://preview.wafer.space";

// Lists in the order they're synced; production first, so it gets the
// subrequest budget before the previews do.
export const LIST_NAMES = ["wafer_space", "preview_wafer_space"];

// The Free plan allows 10,000 URL redirects across all lists. Stop well short
// of that rather than let Cloudflare reject or truncate a write.
export const MAX_TOTAL_REDIRECTS = 9000;

// Each preview costs one subrequest and some CPU time (the Free plan allows
// 10 ms per run), and a run must leave enough of the 50 subrequests for the
// API calls; see the budget in index.js.
export const MAX_PREVIEWS = 15;

// Waits between status checks of a bulk operation, and between retries when
// another operation is still pending, in milliseconds.
export const POLL_DELAYS = [1000, 2000, 4000, 8000, 15000];
export const BUSY_RETRY_DELAYS = [5000, 10000, 20000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each source has two steps: fetch the files a list is built from (cheap, and
// enough to tell whether anything changed), then parse, check and turn them
// into the list's items (only when something did).
const SOURCES = {
  wafer_space: {
    async fetch({ fetchText }) {
      return { files: { [PRODUCTION_URL]: await fetchText(PRODUCTION_URL) }, notes: [] };
    },
    build(files) {
      const data = parseJson(files[PRODUCTION_URL], PRODUCTION_URL);
      const items = sortItems(parseRedirects(data, { label: PRODUCTION_URL }));
      // An empty production list is far more likely a broken build than intent.
      if (items.length === 0) throw new ValidationError(`${PRODUCTION_URL} has no redirects`);
      return items;
    },
  },

  preview_wafer_space: {
    async fetch({ fetchText }) {
      const indexUrl = `${PREVIEW_ROOT}/previews.json`;
      const dirs = parsePreviewIndex(parseJson(await fetchText(indexUrl), indexUrl));
      if (dirs.length > MAX_PREVIEWS) {
        throw new Error(`${dirs.length} previews have redirects, more than the ${MAX_PREVIEWS} one run can handle`);
      }
      const notes = [];
      const files = {};
      const fetched = await Promise.all(
        dirs.map(async (dir) => {
          try {
            return [dir, await fetchText(`${PREVIEW_ROOT}/${dir}/redirects.json`)];
          } catch (err) {
            // previews.json and the preview are deployed together, so this is a
            // preview removed between the two reads; leave it out until next run.
            if (err instanceof NotFoundError) {
              notes.push(`${dir}: no redirects.json, skipped`);
              return [dir, null];
            }
            throw err;
          }
        }),
      );
      for (const [dir, text] of fetched) if (text !== null) files[dir] = text;
      return { files, notes };
    },
    build(files) {
      const previews = {};
      for (const [dir, text] of Object.entries(files)) {
        previews[dir] = parseJson(text, `${dir}/redirects.json`);
      }
      return buildPreviewItems(previews);
    },
  },
};

async function replaceWhenFree(api, listId, items, wait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.replaceItems(listId, items);
    } catch (err) {
      if (!err.isBusy || attempt >= BUSY_RETRY_DELAYS.length) throw err;
      await wait(BUSY_RETRY_DELAYS[attempt]);
    }
  }
}

async function waitForOperation(api, operationId, wait) {
  for (const delay of POLL_DELAYS) {
    await wait(delay);
    const op = await api.getOperation(operationId);
    if (op.status === "completed") return;
    if (op.status === "failed") throw new Error(`bulk operation ${operationId} failed: ${op.error ?? "no error given"}`);
  }
  throw new Error(`bulk operation ${operationId} still not complete; the next run will retry`);
}

async function syncList(name, list, others, { api, fetchText, force, wait }) {
  const source = SOURCES[name];
  const { files, notes } = await source.fetch({ fetchText });
  const digest = await inputDigest(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flat(),
  );
  const noted = notes.length ? { notes } : {};
  const recorded = parseDescription(list.description);
  if (!force && recorded?.digest === digest && recorded.items === list.num_items) {
    return { entries: list.num_items, changed: false, ...noted };
  }
  const items = source.build(files);
  const total = items.length + others;
  if (total > MAX_TOTAL_REDIRECTS) {
    throw new Error(`${total} redirects across all lists would pass the limit of ${MAX_TOTAL_REDIRECTS}`);
  }
  const operationId = await replaceWhenFree(api, list.id, items, wait);
  await waitForOperation(api, operationId, wait);
  // Record the digest only once the items are in, so a failed run is retried.
  await api.updateDescription(list.id, describeList(digest, items.length));
  return { entries: items.length, changed: true, ...noted };
}

// Sync the named lists one after another (only one bulk operation may be
// pending per account). A list whose sources fail to fetch or validate is
// left exactly as it is.
export async function syncLists({ api, fetchText, names = LIST_NAMES, force = false, wait = sleep }) {
  const results = {};
  let lists;
  try {
    lists = await api.listLists();
  } catch (err) {
    for (const name of names) results[name] = { error: err.message };
    return { ok: false, lists: results };
  }
  const byName = new Map(lists.map((l) => [l.name, l]));
  for (const name of names) {
    const list = byName.get(name);
    try {
      if (!list || list.kind !== "redirect") throw new Error(`no redirect list named ${name}`);
      const others = lists
        .filter((l) => l.kind === "redirect" && l.name !== name)
        .reduce((sum, l) => sum + (l.num_items ?? 0), 0);
      results[name] = await syncList(name, list, others, { api, fetchText, force, wait });
    } catch (err) {
      results[name] = { error: err.message };
    }
  }
  return { ok: Object.values(results).every((r) => !r.error), lists: results };
}
