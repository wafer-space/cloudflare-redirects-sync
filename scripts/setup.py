#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Set up Cloudflare and GitHub for the redirects Worker.

Give it a short-lived Cloudflare API token (the "setup token" in SETUP.md)
in CLOUDFLARE_SETUP_TOKEN, or type it when asked. It checks each of these
and, with --apply, creates or changes what's missing:

1. the account's workers.dev subdomain, wafer-space;
2. the redirect lists wafer_space and preview_wafer_space;
3. the account's http_request_redirect ruleset, with a rule for each list;
4. preview.wafer.space proxied through Cloudflare;
5. a cache rule that bypasses the cache for preview.wafer.space;
6. two account API tokens: one the Worker uses to replace the lists, and one
   GitHub Actions uses to deploy the Worker;
7. the Worker, deployed from this checkout with its secrets (CF_API_TOKEN,
   CF_ACCOUNT_ID and a new SYNC_SECRET);
8. the GitHub secrets and variables both repositories need (with gh).

Without --apply it only reports what it would do. Things already in place
are left alone, and so is an existing token: its value can't be read back,
so the secrets that hold it are only set when the token is created. Pass
--rotate to create new tokens and a new SYNC_SECRET, set them everywhere,
and then delete the old tokens. Token values are never printed.
"""

import argparse
import getpass
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
ROOT = Path(__file__).resolve().parent.parent

SUBDOMAIN = "wafer-space"
WORKER = "redirects"
WORKER_URL = f"https://{WORKER}.{SUBDOMAIN}.workers.dev"
ZONE = "wafer.space"
PREVIEW_HOST = "preview.wafer.space"
LISTS = {
    "wafer_space": "Redirects for wafer.space, loaded by the redirects Worker",
    "preview_wafer_space": "Redirects for preview.wafer.space, loaded by the redirects Worker",
}
CACHE_EXPRESSION = f'(http.host eq "{PREVIEW_HOST}")'
WORKER_REPO = "wafer-space/cloudflare-redirects-sync"
SITE_REPO = "wafer-space/wafer-space.github.io"
ACCOUNT_SCOPE = "com.cloudflare.api.account"

# The tokens this creates, and the names their one permission goes by (the
# API calls them "... Write", the dashboard "... Edit")
TOKENS = {
    "lists": {
        "name": "redirects Worker: replace the redirect lists",
        "groups": ("Account Filter Lists Write", "Account Rule Lists Write", "Account Filter Lists Edit"),
    },
    "deploy": {
        "name": "redirects Worker: deploy from GitHub Actions",
        "groups": ("Workers Scripts Write", "Workers Scripts Edit"),
    },
}


class CloudflareError(Exception):
    def __init__(self, method, path, status, body):
        errors = body.get("errors") if isinstance(body, dict) else None
        detail = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in errors or []) or json.dumps(body)[:300]
        super().__init__(f"{method} {path}: HTTP {status}: {detail}")
        self.status = status


def send(method, url, data=None, headers=None):
    """(status, body bytes) for one HTTP request."""
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


class Cloudflare:
    def __init__(self, token, account_id=None, send=send):
        self.token, self.account_id, self.send = token, account_id, send

    def call(self, method, path, body=None, query=None, missing_ok=False):
        """The response's JSON, or None for a 404 when missing_ok."""
        url = f"{API}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        headers = {"Authorization": f"Bearer {self.token}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        status, raw = self.send(method, url, data, headers)
        try:
            parsed = json.loads(raw or b"{}")
        except ValueError:
            parsed = {"body": raw.decode("utf-8", "replace")}
        if missing_ok and status == 404:
            return None
        if status >= 300 or not isinstance(parsed, dict) or parsed.get("success") is False:
            raise CloudflareError(method, path, status, parsed)
        return parsed

    def result(self, method, path, body=None, query=None, missing_ok=False):
        parsed = self.call(method, path, body, query, missing_ok)
        return None if parsed is None else parsed.get("result")

    def every(self, path):
        """Every item of a paginated list."""
        items, page = [], 1
        while True:
            parsed = self.call("GET", path, query={"page": page, "per_page": 50})
            items += parsed.get("result") or []
            if page >= (parsed.get("result_info") or {}).get("total_pages", 1):
                return items
            page += 1


def redirect_rule(name):
    return {
        "description": f"Bulk Redirects from the {name} list (loaded by the redirects Worker)",
        "expression": f"http.request.full_uri in ${name}",
        "action": "redirect",
        "action_parameters": {"from_list": {"name": name, "key": "http.request.full_uri"}},
        "enabled": True,
    }


CACHE_RULE = {
    "description": f"Don't cache {PREVIEW_HOST}: previews change on every push",
    "expression": CACHE_EXPRESSION,
    "action": "set_cache_settings",
    "action_parameters": {"cache": False},
    "enabled": True,
}


class Setup:
    def __init__(self, cf, apply=False, rotate=False, run=subprocess.run, send=send, sleep=time.sleep, log=print):
        self.cf, self.apply, self.rotate = cf, apply, rotate
        self.run, self.send, self.sleep, self.log = run, send, sleep, log

    def change(self, description, action, dry_run_result=None):
        """Make a change and return action's result, or with no --apply say
        it would be made and return dry_run_result."""
        if not self.apply:
            self.log(f"  would {description}")
            return dry_run_result
        self.log(f"  {description}")
        return action()

    def ok(self, message):
        self.log(f"  ok: {message}")

    @property
    def account(self):
        return f"/accounts/{self.cf.account_id}"

    def check_token(self):
        self.log("Setup token")
        # Account tokens verify under their account, user tokens under /user
        paths = ([f"{self.account}/tokens/verify"] if self.cf.account_id else []) + ["/user/tokens/verify"]
        for path in paths:
            try:
                status = (self.cf.result("GET", path) or {}).get("status")
            except CloudflareError as err:
                error = err
                continue
            if status != "active":
                raise SystemExit(f"The setup token is {status}, not active")
            self.ok("active")
            return
        hint = "" if self.cf.account_id else " (for an account token, give --account-id)"
        raise SystemExit(f"The setup token doesn't work{hint}: {error}")

    def find_account(self):
        self.log("Account")
        if not self.cf.account_id:
            accounts = self.cf.result("GET", "/accounts") or []
            if len(accounts) != 1:
                names = ", ".join(f"{a.get('name')} ({a.get('id')})" for a in accounts) or "none"
                raise SystemExit(f"Give --account-id: the token can see {len(accounts)} accounts: {names}")
            self.cf.account_id = accounts[0]["id"]
        self.ok(f"using account {self.cf.account_id}")

    def workers_subdomain(self):
        self.log("workers.dev subdomain")
        current = (self.cf.result("GET", f"{self.account}/workers/subdomain", missing_ok=True) or {}).get("subdomain")
        if current == SUBDOMAIN:
            self.ok(f"{SUBDOMAIN}.workers.dev")
        elif current:
            raise SystemExit(f"The account's workers.dev subdomain is {current}, not {SUBDOMAIN}; "
                             f"the Worker would be at {WORKER}.{current}.workers.dev. Change it in the dashboard "
                             "first, or change SUBDOMAIN here and in SETUP.md.")
        else:
            self.change(f"set the account's workers.dev subdomain to {SUBDOMAIN}",
                        lambda: self.cf.call("PUT", f"{self.account}/workers/subdomain", {"subdomain": SUBDOMAIN}))

    def lists(self):
        self.log("Redirect lists")
        existing = {item["name"]: item for item in self.cf.result("GET", f"{self.account}/rules/lists") or []}
        for name, description in LISTS.items():
            found = existing.get(name)
            if found and found.get("kind") != "redirect":
                raise SystemExit(f"The list {name} exists but is a {found.get('kind')} list, not a redirect list")
            if found:
                self.ok(f"{name} ({found.get('num_items', 0)} items)")
            else:
                self.change(f"create the redirect list {name}", lambda n=name, d=description: self.cf.call(
                    "POST", f"{self.account}/rules/lists", {"name": n, "kind": "redirect", "description": d}))

    def redirect_rules(self):
        self.log("Bulk Redirect rules (account http_request_redirect ruleset)")
        path = f"{self.account}/rulesets/phases/http_request_redirect/entrypoint"
        ruleset = self.cf.result("GET", path, missing_ok=True)
        if ruleset is None:
            self.change("create the ruleset with a rule for each list", lambda: self.cf.call(
                "POST", f"{self.account}/rulesets",
                {"name": "Bulk Redirects", "kind": "root", "phase": "http_request_redirect",
                 "rules": [redirect_rule(name) for name in LISTS]}))
            return
        rules = {}
        for rule in ruleset.get("rules") or []:
            rules[((rule.get("action_parameters") or {}).get("from_list") or {}).get("name")] = rule
        for name in LISTS:
            if name not in rules:
                # Adding one rule leaves the ruleset's other rules as they are
                self.change(f"add a rule for {name} to ruleset {ruleset['id']}", lambda n=name: self.cf.call(
                    "POST", f"{self.account}/rulesets/{ruleset['id']}/rules", redirect_rule(n)))
            elif rules[name].get("enabled") is False:
                self.log(f"  warning: the rule for {name} is disabled; enable it in the dashboard")
            else:
                self.ok(f"rule for {name}")

    def find_zone(self):
        zones = self.cf.result("GET", "/zones", query={"name": ZONE, "account.id": self.cf.account_id}) or []
        if len(zones) != 1:
            raise SystemExit(f"Expected one zone named {ZONE} in the account, found {len(zones)}")
        return zones[0]["id"]

    def preview_proxied(self, zone):
        self.log(f"{PREVIEW_HOST} DNS")
        records = self.cf.result("GET", f"/zones/{zone}/dns_records", query={"name": PREVIEW_HOST}) or []
        if len(records) != 1:
            raise SystemExit(f"Expected one DNS record for {PREVIEW_HOST}, found {len(records)}")
        record = records[0]
        if record.get("proxied"):
            self.ok(f"{record.get('type')} {record.get('content')}, proxied")
        elif record.get("proxiable") is False:
            raise SystemExit(f"The {record.get('type')} record for {PREVIEW_HOST} can't be proxied")
        else:
            self.change(f"proxy {PREVIEW_HOST} ({record.get('type')} {record.get('content')}) through Cloudflare",
                        lambda: self.cf.call("PATCH", f"/zones/{zone}/dns_records/{record['id']}", {"proxied": True}))

    def preview_cache_rule(self, zone):
        self.log(f"Cache rule for {PREVIEW_HOST}")
        path = f"/zones/{zone}/rulesets/phases/http_request_cache_settings/entrypoint"
        ruleset = self.cf.result("GET", path, missing_ok=True)
        if ruleset is None:
            self.change("create the zone's cache rules with one that bypasses the cache",
                        lambda: self.cf.call("PUT", path, {"rules": [CACHE_RULE]}))
        elif any(rule.get("expression") == CACHE_EXPRESSION for rule in ruleset.get("rules") or []):
            self.ok("bypasses the cache")
        else:
            # Appended, so it comes after (and wins over) any rule that caches
            self.change(f"add a rule that bypasses the cache to ruleset {ruleset['id']}", lambda: self.cf.call(
                "POST", f"/zones/{zone}/rulesets/{ruleset['id']}/rules", CACHE_RULE))

    def tokens(self):
        """{kind: new token value (None if not created)} and {kind: old tokens to delete}."""
        self.log("API tokens")
        groups = self.cf.result("GET", f"{self.account}/tokens/permission_groups") or []
        existing = {}
        for token in self.cf.every(f"{self.account}/tokens"):
            existing.setdefault(token.get("name"), []).append(token)
        created, old = {}, {}
        for kind, spec in TOKENS.items():
            group = self.permission_group(groups, spec["groups"])
            found = existing.get(spec["name"], [])
            created[kind], old[kind] = None, []
            if found and not self.rotate:
                self.ok(f"{spec['name']!r} exists; leaving it, and the secrets that hold it, alone")
                continue
            old[kind] = found
            body = {"name": spec["name"], "policies": [{
                "effect": "allow",
                "resources": {f"{ACCOUNT_SCOPE}.{self.cf.account_id}": "*"},
                "permission_groups": [{"id": group["id"]}],
            }]}
            created[kind] = self.change(f"create the token {spec['name']!r} with {group['name']}", lambda b=body: (
                self.cf.result("POST", f"{self.account}/tokens", b)["value"]), dry_run_result="(new token)")
        return created, old

    @staticmethod
    def permission_group(groups, names):
        for name in names:
            for group in groups:
                if (group.get("name") == name and group.get("is_selectable", True)
                        and ACCOUNT_SCOPE in group.get("scopes", [ACCOUNT_SCOPE])):
                    return group
        words = names[0].split()[:2]
        similar = sorted(g.get("name", "") for g in groups if all(w in g.get("name", "") for w in words))
        raise SystemExit(f"The setup token can't grant any of {', '.join(names)} "
                         f"(permission groups like it: {', '.join(similar) or 'none'})")

    def wrangler(self):
        if not (ROOT / "node_modules" / "wrangler").is_dir():
            raise SystemExit(f"Run npm ci in {ROOT} first")
        version = self.run(["node", "--version"], capture_output=True, text=True, check=True).stdout
        # Wrangler 4 needs Node.js 22 or later
        if int(version.strip().lstrip("v").split(".")[0]) >= 22:
            return ["npx", "wrangler"]
        return ["npx", "-y", "node@22", "node_modules/wrangler/bin/wrangler.js"]

    def deploy_worker(self, lists_token, sync_secret, deploy_token):
        self.log("Worker")
        if lists_token is None:
            self.ok("CF_API_TOKEN was set when its token was created; not deploying (pass --rotate to replace it)")
            return

        def deploy():
            command = self.wrangler() + ["deploy", "--secrets-file"]
            secrets_file = ROOT / "tmp" / "worker-secrets.json"
            secrets_file.parent.mkdir(exist_ok=True)
            fd = os.open(secrets_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"CF_API_TOKEN": lists_token, "CF_ACCOUNT_ID": self.cf.account_id,
                           "SYNC_SECRET": sync_secret}, f)
            try:
                # The new deploy token, so this also checks it can deploy
                env = {**os.environ, "CLOUDFLARE_API_TOKEN": deploy_token or self.cf.token,
                       "CLOUDFLARE_ACCOUNT_ID": self.cf.account_id}
                # A token can take a few seconds to start working
                for attempt in range(3):
                    try:
                        self.run(command + [str(secrets_file)], cwd=ROOT, env=env, check=True)
                        return
                    except subprocess.CalledProcessError:
                        if attempt == 2:
                            raise
                        self.log("  wrangler deploy failed; trying again in 10s")
                        self.sleep(10)
            finally:
                secrets_file.unlink(missing_ok=True)

        self.change(f"deploy the Worker from {ROOT} with CF_API_TOKEN, CF_ACCOUNT_ID and SYNC_SECRET", deploy)

    def github_variable(self, repo, name, value):
        current = self.run(["gh", "variable", "get", name, "-R", repo], capture_output=True, text=True)
        if current.returncode == 0 and current.stdout.strip() == value:
            self.ok(f"{repo} variable {name}")
            return
        self.change(f"set the {repo} variable {name} to {value}", lambda: self.run(
            ["gh", "variable", "set", name, "-R", repo, "--body", value], check=True))

    def github_secret(self, repo, name, value, why):
        if value is None:
            self.ok(f"{repo} secret {name}: {why}")
            return
        # On stdin, so the value isn't in any process's arguments
        self.change(f"set the {repo} secret {name}", lambda: self.run(
            ["gh", "secret", "set", name, "-R", repo], input=value, text=True, check=True))

    def github(self, deploy_token, sync_secret):
        self.log("GitHub")
        self.github_variable(WORKER_REPO, "CLOUDFLARE_ACCOUNT_ID", self.cf.account_id)
        self.github_secret(WORKER_REPO, "CLOUDFLARE_WORKERS_TOKEN", deploy_token, "left as it is with its token")
        self.github_variable(SITE_REPO, "REDIRECTS_SYNC_URL", WORKER_URL)
        self.github_secret(SITE_REPO, "REDIRECTS_SYNC_SECRET", sync_secret, "left as it is with the Worker's secrets")

    def delete_old_tokens(self, old):
        for tokens in old.values():
            for token in tokens:
                self.change(f"delete the old token {token.get('name')!r} ({token['id']})", lambda t=token: (
                    self.cf.call("DELETE", f"{self.account}/tokens/{t['id']}")))

    def check_worker(self, sync_secret):
        """Ask the new Worker what each list holds; workers.dev can take a minute to start serving it."""
        self.log("Checking the Worker")
        for name in LISTS:
            url = f"{WORKER_URL}/list?{urllib.parse.urlencode({'list': name})}"
            for attempt in range(12):
                status, raw = self.send("GET", url, None, {"Authorization": f"Bearer {sync_secret}"})
                if status == 200 or attempt == 11:
                    break
                self.sleep(10)
            body = raw.decode("utf-8", "replace")
            if status != 200:
                raise SystemExit(f"GET {url}: HTTP {status}: {body[:300]}")
            self.ok(f"GET /list?list={name}: {body[:200]}")

    def run_all(self):
        self.check_token()
        self.find_account()
        self.workers_subdomain()
        self.lists()
        self.redirect_rules()
        zone = self.find_zone()
        self.preview_proxied(zone)
        self.preview_cache_rule(zone)
        created, old = self.tokens()
        # SYNC_SECRET goes in the Worker with the lists token, so it is
        # replaced whenever that is
        sync_secret = secrets.token_urlsafe(32) if created["lists"] else None
        self.deploy_worker(created["lists"], sync_secret, created["deploy"])
        self.github(created["deploy"], sync_secret)
        if self.apply and sync_secret:
            self.check_worker(sync_secret)
        # Only once the new tokens are known to work
        self.delete_old_tokens(old)
        if not self.apply:
            self.log("Nothing was changed: run again with --apply to make the changes above")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--account-id", default=os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
                        help="the Cloudflare account (default $CLOUDFLARE_ACCOUNT_ID, or the token's only account)")
    parser.add_argument("--apply", action="store_true", help="make the changes (default: only report them)")
    parser.add_argument("--rotate", action="store_true",
                        help="replace the tokens and SYNC_SECRET everywhere, then delete the old tokens")
    args = parser.parse_args()

    token = os.environ.get("CLOUDFLARE_SETUP_TOKEN") or getpass.getpass("Cloudflare setup token: ")
    if not token:
        parser.error("no token given")
    try:
        Setup(Cloudflare(token.strip(), args.account_id), apply=args.apply, rotate=args.rotate).run_all()
    except (CloudflareError, subprocess.CalledProcessError) as err:
        sys.stdout.flush()
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
