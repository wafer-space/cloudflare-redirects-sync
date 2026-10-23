// Pure functions for turning the site's redirects.json files into the items
// of a Cloudflare Bulk Redirect list. Nothing in here talks to the network, so
// all of it is covered by the unit tests in test/.

export const PRODUCTION_HOST = "wafer.space";
export const PREVIEW_HOST = "preview.wafer.space";

// Only preview directories named like this are previews; the preview repo also
// has pr-NNN-<slug>/ redirect folders, an index page, a CNAME and so on.
export const PREVIEW_DIR_RE = /^pr-[0-9]+$/;

// Cloudflare's defaults for the optional fields of a URL redirect. Every item
// is normalised to carry all of them, so a list read back from the API and a
// list built from redirects.json compare and hash the same.
const REDIRECT_DEFAULTS = {
  include_subdomains: false,
  subpath_matching: false,
  preserve_path_suffix: true,
  preserve_query_string: false,
};
const REDIRECT_KEYS = new Set([
  "source_url",
  "target_url",
  "status_code",
  ...Object.keys(REDIRECT_DEFAULTS),
]);
const STATUS_CODES = new Set([301, 302, 307, 308]);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

// Check every item of a parsed redirects.json strictly and return the items
// normalised. Throws ValidationError on the first problem, so a bad deploy
// leaves the Cloudflare list as it was instead of half-replacing it.
export function parseRedirects(data, { host = PRODUCTION_HOST, label = "redirects.json" } = {}) {
  if (!Array.isArray(data)) {
    throw new ValidationError(`${label}: expected a JSON array`);
  }
  const seen = new Set();
  return data.map((item, i) => {
    const where = `${label}[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ValidationError(`${where}: expected an object`);
    }
    const extra = Object.keys(item).filter((k) => k !== "redirect");
    if (extra.length) {
      throw new ValidationError(`${where}: unexpected key(s) ${extra.join(", ")}`);
    }
    const r = item.redirect;
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new ValidationError(`${where}: missing "redirect" object`);
    }
    for (const key of Object.keys(r)) {
      if (!REDIRECT_KEYS.has(key)) {
        throw new ValidationError(`${where}: unexpected redirect key "${key}"`);
      }
    }
    checkSourceUrl(r.source_url, host, where);
    checkTargetUrl(r.target_url, where);
    if (!STATUS_CODES.has(r.status_code)) {
      throw new ValidationError(`${where}: status_code ${JSON.stringify(r.status_code)} is not 301, 302, 307 or 308`);
    }
    for (const key of Object.keys(REDIRECT_DEFAULTS)) {
      if (key in r && typeof r[key] !== "boolean") {
        throw new ValidationError(`${where}: ${key} must be true or false`);
      }
    }
    if (seen.has(r.source_url)) {
      throw new ValidationError(`${where}: duplicate source_url ${r.source_url}`);
    }
    seen.add(r.source_url);
    return normaliseItem(r);
  });
}

function checkSourceUrl(source, host, where) {
  if (typeof source !== "string") {
    throw new ValidationError(`${where}: source_url must be a string`);
  }
  // No scheme (so it matches http and https), the expected hostname, an exact
  // path, and nothing Cloudflare would treat as a query string or fragment.
  if (!source.startsWith(`${host}/`) || /[\s?#]/.test(source)) {
    throw new ValidationError(`${where}: source_url ${JSON.stringify(source)} is not ${host}/<path>`);
  }
}

function checkTargetUrl(target, where) {
  // Targets are only checked loosely: some external ones have their own query
  // string or a second "#", which a strict URL parser would reject or rewrite.
  if (typeof target !== "string" || !/^https?:\/\/[^\s/?#]+[^\s]*$/.test(target)) {
    throw new ValidationError(`${where}: target_url ${JSON.stringify(target)} is not an http(s) URL`);
  }
}

// Return a redirect with every field set, in a fixed key order.
export function normaliseItem(r) {
  return {
    source_url: r.source_url,
    target_url: r.target_url,
    status_code: r.status_code ?? 301,
    include_subdomains: r.include_subdomains ?? REDIRECT_DEFAULTS.include_subdomains,
    subpath_matching: r.subpath_matching ?? REDIRECT_DEFAULTS.subpath_matching,
    preserve_path_suffix: r.preserve_path_suffix ?? REDIRECT_DEFAULTS.preserve_path_suffix,
    preserve_query_string: r.preserve_query_string ?? REDIRECT_DEFAULTS.preserve_query_string,
  };
}

// Move a production redirect under a preview: the source goes from
// wafer.space/<path> to preview.wafer.space/pr-NNN/<path>, a target on
// https://wafer.space follows it, and any other target is left exactly as it
// is. Previews get a temporary status, because browsers cache a 301
// indefinitely and a preview's redirects change with every push.
export function rewriteForPreview(r, dir, statusCode = 302) {
  if (!PREVIEW_DIR_RE.test(dir)) {
    throw new ValidationError(`invalid preview directory ${JSON.stringify(dir)}`);
  }
  const prefix = `${PRODUCTION_HOST}/`;
  if (!r.source_url.startsWith(prefix)) {
    throw new ValidationError(`source_url ${r.source_url} is not on ${PRODUCTION_HOST}`);
  }
  const path = r.source_url.slice(prefix.length);
  return {
    ...r,
    source_url: `${PREVIEW_HOST}/${dir}/${path}`,
    target_url: rewriteTarget(r.target_url, dir),
    status_code: statusCode,
  };
}

function rewriteTarget(target, dir) {
  const m = /^https:\/\/wafer\.space(?=$|[/?#])(\/?)(.*)$/s.exec(target);
  if (!m) return target;
  return `https://${PREVIEW_HOST}/${dir}/${m[2]}`;
}

// Build the preview list's items from each preview's parsed redirects.json.
// `previews` maps a pr-NNN directory to its parsed JSON.
export function buildPreviewItems(previews, statusCode = 302) {
  const items = [];
  for (const [dir, data] of Object.entries(previews)) {
    const parsed = parseRedirects(data, { label: `${dir}/redirects.json` });
    for (const r of parsed) items.push(rewriteForPreview(r, dir, statusCode));
  }
  return sortItems(items);
}

// Read preview.wafer.space/previews.json and return the directories that have
// a redirects.json, in order.
export function parsePreviewIndex(data) {
  if (data === null || typeof data !== "object" || !Array.isArray(data.previews)) {
    throw new ValidationError('previews.json: expected {"previews": [...]}');
  }
  const dirs = [];
  for (const [i, p] of data.previews.entries()) {
    if (p === null || typeof p !== "object" || typeof p.path !== "string" || !PREVIEW_DIR_RE.test(p.path)) {
      throw new ValidationError(`previews.json previews[${i}]: expected {"path": "pr-NNN", ...}`);
    }
    if (p.redirects === true) dirs.push(p.path);
  }
  return [...new Set(dirs)].sort();
}

export function sortItems(items) {
  return [...items].sort((a, b) => (a.source_url < b.source_url ? -1 : a.source_url > b.source_url ? 1 : 0));
}

// Parse a downloaded file, with the file named in the error.
export function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError(`${label}: not valid JSON`);
  }
}

// A digest of the files a list is built from (and their names), stored in the
// list's description. A later run whose files hash the same can stop there,
// without parsing anything or reading the list's items back; that keeps the
// frequent cron runs well inside the Free plan's CPU limit.
export async function inputDigest(parts) {
  const canonical = parts.map((part) => `${part.length}:${part}`).join("\n");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DESCRIPTION_RE = /\bsha256=([0-9a-f]{64}) items=([0-9]+)\b/;

export function describeList(digest, count) {
  return `Synced by the redirects-sync Worker; do not edit by hand. sha256=${digest} items=${count}`;
}

// The digest and item count a description records, or null.
export function parseDescription(description) {
  const m = DESCRIPTION_RE.exec(description ?? "");
  return m ? { digest: m[1], items: Number(m[2]) } : null;
}
