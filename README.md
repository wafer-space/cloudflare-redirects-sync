# Redirects sync Worker

`wafer-space-redirects-sync` is a Cloudflare Worker that keeps two account
Bulk Redirect lists in step with the `redirects.json` files the site builds
(see `_plugins/index_redirects.rb`), so old and alternative URLs such as
`/about.html`, `/about/` and `/about/index.html` get real HTTP redirects from
Cloudflare instead of the meta-refresh pages GitHub Pages serves.

| List | Hostname | Built from | Status |
| --- | --- | --- | --- |
| `wafer_space` | `wafer.space` | `https://wafer.space/redirects.json`, as is | as given (301) |
| `preview_wafer_space` | `preview.wafer.space` | each preview's `redirects.json`, moved under `/pr-NNN/` | 302 |

Previews use 302 because browsers cache a 301 indefinitely and a preview's
redirects change with every push. For a preview, a source
`wafer.space/<path>` becomes `preview.wafer.space/pr-NNN/<path>`, a target
on `https://wafer.space` moves under `https://preview.wafer.space/pr-NNN/`,
and any other target is left exactly as it is. The previews are the `pr-NNN`
entries of `https://preview.wafer.space/previews.json` (written by
`.github/scripts/generate-preview-index.sh`) whose `redirects` is true.

One account rule in the `http_request_redirect` phase per list applies it.

## When it runs

- Every 5 minutes, on a cron trigger.
- On `POST /sync` with `Authorization: Bearer <SYNC_SECRET>`, which
  `.github/scripts/redirects-sync.py` sends after the production deploy
  (`jekyll.yml`) and after each preview deploy (`pr-preview.yml`). Add
  `?list=wafer_space` or `?list=preview_wafer_space` to sync one list, and
  `?force=1` to rewrite lists that haven't changed. The response is a JSON
  summary, with HTTP 502 if any list failed.

## What a run does

For each list in turn (only one bulk list operation may be pending per
account):

1. Fetch the source files, bypassing caches.
2. Hash them. If the hash and the item count match the ones recorded in the
   list's description, stop: nothing changed. This keeps the frequent runs
   cheap.
3. Otherwise parse and check every entry strictly (hostname, no scheme or
   query string in the source, an http(s) target, a 3xx status, no duplicate
   sources). Any problem, a failed fetch, or an empty production file leaves
   the list exactly as it is.
4. Check the total against the account limit of 10,000 redirects.
5. Replace the list's items (retrying while another bulk operation is
   pending), wait for the operation to finish, then record the new hash.

A preview listed in `previews.json` whose `redirects.json` is missing is
skipped with a note. Each run must fit in the Workers Free plan's 50
subrequests and 10 ms of CPU, so a run handles at most `MAX_PREVIEWS`
previews (`src/sync.js`) and fails clearly beyond that.

## Code

- `src/redirects.js`: parsing, validation, the preview rewrite, the hash.
  Pure functions.
- `src/sync.js`: one run of the sync.
- `src/cloudflare.js`: the Cloudflare Lists API and file fetches.
- `src/index.js`: the Worker's `fetch` and `scheduled` handlers.

```sh
npm ci
npm test                      # node --test
npx wrangler deploy --dry-run # check it bundles
```

Wrangler 4 needs Node.js 22 or later. `.github/workflows/redirects-sync.yml`
runs the tests on pull requests and deploys the Worker when this directory
changes on `main`.

## Setup

Done once; recorded here so it can be redone.

### Cloudflare

1. A workers.dev subdomain for the account.
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

### GitHub (repository settings)

- Secret `CLOUDFLARE_WORKERS_TOKEN`: an API token with Account > Workers
  Scripts > Edit, used to deploy.
- Variable `CLOUDFLARE_ACCOUNT_ID`.
- Variable `REDIRECTS_SYNC_URL`: the Worker's workers.dev URL.
- Secret `REDIRECTS_SYNC_SECRET`.

Without `REDIRECTS_SYNC_URL` and `REDIRECTS_SYNC_SECRET` (as on PRs from
forks) the workflows skip the sync, and the cron trigger catches up.

## Checking it

```sh
curl -sI https://wafer.space/about.html          # 301, location: https://wafer.space/about
curl -sI 'https://wafer.space/about.html?x=1'    # 301, location keeps ?x=1
curl -sI https://wafer.space/about               # 200
curl -sI https://preview.wafer.space/pr-NNN/about.html  # 302 -> /pr-NNN/about
```
