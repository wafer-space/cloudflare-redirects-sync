# Setting up the redirects Worker

This sets up everything the Worker needs, in Cloudflare and on GitHub, using
[`scripts/setup.py`](scripts/setup.py) and one short-lived "setup token" that
you create by hand and delete afterwards. The script can be run again at any
time: it checks each piece, leaves what is already in place alone, and
without `--apply` only reports what it would change.

## What gets set up

In the Cloudflare account that has the `wafer.space` zone:

| What | Why |
| --- | --- |
| The account's workers.dev subdomain, `wafer-space` | The Worker is served at `https://redirects.wafer-space.workers.dev`. |
| Redirect lists `wafer_space` and `preview_wafer_space` | The Worker replaces their contents with the sites' `redirects.json`. |
| The account's `http_request_redirect` ruleset, with a rule per list (`http.request.full_uri in $wafer_space`, ...) | Applies the lists to requests. Bulk Redirects only apply to proxied hostnames. |
| `preview.wafer.space` proxied through Cloudflare | So the preview list applies. `wafer.space` already is. The script doesn't change `www.preview.wafer.space`. |
| A cache rule bypassing the cache for `http.host eq "preview.wafer.space"` | GitHub Pages sends `max-age=600`, and previews change on every push. |
| The Worker, deployed with its secrets | See below. |

The tokens and secrets, each with only the permission it needs:

| Name | Holds | Kept in | Used by |
| --- | --- | --- | --- |
| Setup token | Created by you; see [step 1](#1-create-the-setup-token) | Nowhere: delete it when done | `scripts/setup.py` |
| `CF_API_TOKEN` | Account token "redirects Worker: replace the redirect lists", with only Account Filter Lists Edit | Worker secret | The Worker, to read and replace the two lists |
| `CF_ACCOUNT_ID` | The account ID | Worker secret | The Worker |
| `SYNC_SECRET` | A random string | Worker secret | The Worker, to check requests' `Authorization: Bearer` |
| `CLOUDFLARE_WORKERS_TOKEN` | Account token "redirects Worker: deploy from GitHub Actions", with only Workers Scripts Edit | Secret on `wafer-space/cloudflare-redirects-sync` | `.github/workflows/ci.yml`, to deploy the Worker from `main` |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID | Variable on `wafer-space/cloudflare-redirects-sync` | `ci.yml` |
| `REDIRECTS_SYNC_SECRET` | The same value as `SYNC_SECRET` | Secret on `wafer-space/wafer-space.github.io` | The site's deploy workflows, to call the Worker |
| `REDIRECTS_SYNC_URL` | `https://redirects.wafer-space.workers.dev` | Variable on `wafer-space/wafer-space.github.io` | The site's deploy workflows |

The two tokens the script creates are account tokens (owned by the account,
not by whoever created them), without an expiry date, and limited to the one
account.

## Before you start

- A Cloudflare account member who is a Super Administrator, or has API Token
  Provisioning: creating account tokens needs one or the other.
- `gh`, logged in as someone who can change secrets and variables on both
  repositories (`gh auth status`).
- `uv`, and Node.js 22 or later (or `npx`, which the script uses to fetch
  Node.js 22 when the installed one is older).
- An up-to-date checkout of this repository's `main`, with `npm ci` run in it:
  the script deploys the Worker from this checkout.

## 1. Create the setup token

In the Cloudflare dashboard, go to **Manage Account > Account API Tokens >
Create Token > Create Custom Token**, and give it:

- **Token name:** `redirects Worker setup` (anything will do).
- **Permissions:**

  | | | |
  | --- | --- | --- |
  | Account | Account API Tokens | Edit |
  | Account | Account Filter Lists | Edit |
  | Account | Bulk URL Redirects | Edit |
  | Account | Workers Scripts | Edit |
  | Zone | Zone | Read |
  | Zone | DNS | Edit |
  | Zone | Cache Rules | Edit |

- **Zone Resources:** Include, Specific zone, `wafer.space`.
- **TTL:** end tomorrow, so it stops working even if it isn't deleted.

Copy the token: Cloudflare shows it only once. It can't grant the tokens it
creates more than the permissions above, and you can't give it more than
your own.

Cloudflare's Bulk Redirects docs name Bulk URL Redirects Edit for creating
the redirect rules. If that step still fails with an authentication error,
add **Account > Account Rulesets > Edit**.

## 2. See what would change

From this repository's root:

```sh
uv run scripts/setup.py --account-id <account ID>
```

It asks for the setup token (or reads `CLOUDFLARE_SETUP_TOKEN`), checks it
works, and reports each piece as `ok` or as what it `would` do. Nothing is
changed. The account ID is on the account's overview page in the dashboard;
it can also come from `CLOUDFLARE_ACCOUNT_ID`, and can be left out when the
token can see only one account.

## 3. Apply it

```sh
uv run scripts/setup.py --account-id <account ID> --apply
```

This makes the changes it reported, creates the two tokens, deploys the
Worker with `wrangler deploy --secrets-file` (using the new deploy token, so
that is checked too), sets the GitHub secrets and variables with `gh`, and
finally asks the Worker what each list holds, which checks the Worker, its
secrets and the lists token. The secrets file it hands wrangler is written
to `tmp/` readable only by you and deleted straight after, and no token or
secret is printed.

## 4. Delete the setup token

Back in **Manage Account > Account API Tokens**, delete the setup token. The
Worker and GitHub Actions only use the two tokens the script created.

## Afterwards

The Worker's cron trigger loads both lists every five minutes, and the site's
deploy workflows sync them straight after each deploy. A list stays empty
until its site serves a `redirects.json` that starts with a revision item;
the Worker reports a 502 for that list until then. To check redirects, see
[Checking it](README.md#checking-it).

## Running it again

- **To check everything is still in place:** run step 2 again with a new
  setup token.
- **To replace the tokens and `SYNC_SECRET`** (say, if one may have leaked):
  run step 3 with `--rotate` as well. It creates new tokens and a new
  `SYNC_SECRET`, deploys the Worker with them, sets the GitHub secrets, and
  only then deletes the old tokens.
- **If a run stopped part way:** run it again. If it stopped after creating
  a token but before storing it (the script can't read a token's value back
  later, so it won't store an existing one), run it with `--rotate`.

An existing token is matched by its name, so don't rename the two tokens in
the dashboard.

## Doing it by hand

Everything the script does can be done in the dashboard instead:

1. **Workers & Pages:** set the account's workers.dev subdomain to
   `wafer-space`.
2. **Manage Account > Configurations > Lists:** create the two lists, of type
   Redirect.
3. **Rules > Redirect Rules > Bulk Redirects** (account level): create a rule
   for each list.
4. **`wafer.space` > DNS:** turn on the proxy for `preview.wafer.space`.
5. **`wafer.space` > Caching > Cache Rules:** a rule for hostname equals
   `preview.wafer.space` that bypasses the cache.
6. **Manage Account > Account API Tokens:** create the two tokens in the table
   above.
7. From this repository, with `CLOUDFLARE_API_TOKEN` set to the deploy token,
   `npx wrangler deploy`, then `npx wrangler secret put` for each of
   `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `SYNC_SECRET` (`openssl rand -base64 32`
   makes a good one).
8. **GitHub:** set the secrets and variables in the table above, under each
   repository's **Settings > Secrets and variables > Actions**.
