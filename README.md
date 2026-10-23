# Redirects sync Worker

`redirects` (at <https://redirects.wafer-space.workers.dev>) is a
Cloudflare Worker that loads the `redirects.json` files the
[wafer.space site](https://github.com/wafer-space/wafer-space.github.io)
publishes into two account Bulk Redirect lists, so old and alternative URLs
such as `/about.html` get real HTTP redirects from Cloudflare instead of the
meta-refresh pages GitHub Pages serves.

| List | Loaded from |
| --- | --- |
| `wafer_space` | `https://wafer.space/redirects.json` |
| `preview_wafer_space` | `https://preview.wafer.space/redirects.json` |

The Worker doesn't build, check or change the redirects: each file is
already the body of Cloudflare's "replace list items" call. The site's
[`redirect_list.rb`](https://github.com/wafer-space/wafer-space.github.io/blob/main/_plugins/redirect_list.rb)
writes the production file, and the preview deploy combines each preview's
file into the preview one, moved under `/pr-NNN/` with 302s. One account rule
in the `http_request_redirect` phase per list applies it.

## Revisions

The first item of each file records the revision it was built from:

```json
{
  "comment": "v0.0-474-g6fcfcdad8fabe807d87a0737b593a6edef945b9d",
  "redirect": {
    "source_url": "wafer.space/revision",
    "target_url": "https://github.com/wafer-space/wafer-space.github.io/commit/6fcfcdad8fabe807d87a0737b593a6edef945b9d",
    "status_code": 302
  }
}
```

The comment starts with `git describe` (`v0.0-<number>`), and the target ends
with the full commit hash. Because it is one of the list's items, it is
written in the same replace as the redirects, so the list itself always says
which revision it holds; no other state is kept. (It also makes
`https://wafer.space/revision` a link to the commit the live redirects came
from.)

## Endpoints

Every request needs `Authorization: Bearer <SYNC_SECRET>`, and `list` is
`wafer_space` or `preview_wafer_space`.

| Endpoint | Does |
| --- | --- |
| `GET /source?list=<name>` | Fetches the site's `redirects.json` and returns its revision as `source`. |
| `GET /list?list=<name>` | Returns the revision the Cloudflare list holds as `list` (`null` if it has none). |
| `POST /sync?list=<name>` | Both, then replaces the list with the file if the file's revision is newer. `force=1` replaces it regardless. |

A 5-minute cron trigger runs the sync for both lists.

`POST /sync` never writes an older or equal revision, and never retries. Its
answers, each with the `source` and `list` revisions:

| Status | `status` | Meaning |
| --- | --- | --- |
| 200 | `applied` | The file was written; `list` is the revision read back from the list afterwards. |
| 200 | `up_to_date`, `list_is_newer` | Nothing to do. |
| 202 | `pending` | Cloudflare accepted the write but hadn't finished it when the Worker stopped waiting. |
| 409 | `commit_mismatch` | The site and the list have the same number with different commits. |
| 503 | `busy` | Another bulk operation is pending: retry. |
| 502 | `error`, `failed` | The file couldn't be fetched or has no revision item first, Cloudflare's operation failed, or the list had no revision item after writing. |

## Delays, caches and calls out of order

The site's deploy workflows run a client that, for the revision they just
deployed:

1. polls `GET /source` until the site serves that revision or a newer one
   (GitHub Pages can take minutes to publish, and caches can serve an older
   copy for a while);
2. calls `POST /sync`, retrying while it's `busy` or `pending`;
3. checks `GET /list` holds that revision or a newer one, and goes back to
   step 2 if not.

Files are fetched with a cache-busting query string and `cache: "no-store"`;
a stale copy that still gets through has a lower number and is never
written. A late sync for an older revision finds the list newer and does
nothing. Cloudflare runs one bulk operation per account at a time, but an
older write can still land just after a newer one, if the newer one
finishes between the older sync's check and its write; step 3 catches that
when it runs after the older write. Otherwise the list's revision item still
truthfully shows the older revision, and the next cron run restores the
newer one.

## Code

- `src/sync.js`: one sync of one list.
- `src/cloudflare.js`: the Cloudflare Lists API and file fetches.
- `src/index.js`: the Worker's `fetch` and `scheduled` handlers.

```sh
npm ci
npm test                      # node --test
npx wrangler deploy --dry-run # check it bundles
```

Wrangler 4 needs Node.js 22 or later. `.github/workflows/ci.yml` runs the
tests on pull requests and pushes, and deploys the Worker from `main`.

## Setup

Done once; recorded here so it can be redone.

### Cloudflare

1. The workers.dev subdomain `wafer-space` for the account.
2. The two lists, `kind: "redirect"`, and the account ruleset for the
   `http_request_redirect` phase with one rule per list:

   ```json
   {
     "expression": "http.request.full_uri in $wafer_space",
     "action": "redirect",
     "action_parameters": {"from_list": {"name": "wafer_space", "key": "http.request.full_uri"}}
   }
   ```

3. `preview.wafer.space` proxied through Cloudflare (`www.preview` stays
   DNS-only, out of the zone's "WWW to root" redirect), with a cache rule
   that bypasses the cache for `http.host eq "preview.wafer.space"`, since
   GitHub Pages sends `max-age=600` and previews change on every push.
4. Worker secrets, set with `npx wrangler secret put <NAME>`:
   - `CF_API_TOKEN`: an API token with only Account > Account Filter Lists >
     Edit.
   - `CF_ACCOUNT_ID`: the account ID.
   - `SYNC_SECRET`: a random string; the same value as the GitHub secret
     `REDIRECTS_SYNC_SECRET`.

### GitHub

This repository (Settings > Secrets and variables > Actions):

- Secret `CLOUDFLARE_WORKERS_TOKEN`: an API token with Account > Workers
  Scripts > Edit, used to deploy.
- Variable `CLOUDFLARE_ACCOUNT_ID`.

`wafer-space/wafer-space.github.io` has the variable `REDIRECTS_SYNC_URL`
(the Worker's workers.dev URL) and the secret `REDIRECTS_SYNC_SECRET`. Without
them (as on PRs from forks) its workflows skip the sync, and the cron trigger
catches up.

## Checking it

```sh
curl -sI https://wafer.space/about.html          # 301, location: https://wafer.space/about
curl -sI 'https://wafer.space/about.html?x=1'    # 301, location keeps ?x=1
curl -sI https://wafer.space/about               # 200
curl -sI https://wafer.space/revision            # 302 to the commit the list came from
curl -sI https://preview.wafer.space/pr-NNN/about.html  # 302 -> /pr-NNN/about
```

## License

Apache License 2.0; see [LICENSE](LICENSE).
