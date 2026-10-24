"""Tests for setup.py against a fake Cloudflare API, gh and wrangler.

Run with: uv run python -m unittest discover -s scripts
"""

import json
import re
import subprocess
import unittest
import unittest.mock
import urllib.error
import urllib.parse
from pathlib import Path

import setup

ACCOUNT = "acc123"
ZONE_ID = "zone456"
GROUPS = [
    {"id": "g-lists", "name": "Account Rule Lists Write", "scopes": ["com.cloudflare.api.account"], "is_selectable": True},
    {"id": "g-workers", "name": "Workers Scripts Write", "scopes": ["com.cloudflare.api.account"], "is_selectable": True},
    {"id": "g-zone", "name": "Zone Read", "scopes": ["com.cloudflare.api.account.zone"], "is_selectable": True},
]


class Fake:
    """The Cloudflare API, the Worker, gh and wrangler, with their state."""

    def __init__(self):
        self.subdomain = None
        self.lists = []
        self.redirect_ruleset = None
        self.cache_ruleset = None
        self.dns = {"id": "rec1", "type": "CNAME", "content": "wafer-space.github.io", "proxied": False, "proxiable": True}
        self.tokens = []
        self.groups = list(GROUPS)
        self.variables = {}
        self.secrets = {}
        self.worker_secrets = {}
        self.deploy_env = None
        self.writes = []
        self.next_id = 0
        self.setup_token_status = "active"

    def new_id(self, prefix):
        self.next_id += 1
        return f"{prefix}{self.next_id}"

    # Cloudflare API and the Worker
    def send(self, method, url, data=None, headers=None):
        parsed = urllib.parse.urlsplit(url)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        body = json.loads(data) if data else None
        if parsed.netloc == "redirects.wafer-space.workers.dev":
            if headers.get("Authorization") != f"Bearer {self.worker_secrets.get('SYNC_SECRET')}":
                return 401, b'{"error":"unauthorized"}'
            return 200, json.dumps({"name": query["list"], "status": "ok", "list": None}).encode()
        assert headers["Authorization"] == "Bearer setup-token"
        path = parsed.path.removeprefix("/client/v4")
        if method != "GET":
            self.writes.append((method, path))
        status, result = self.route(method, path, query, body)
        if status == 404:
            return 404, json.dumps({"success": False, "errors": [{"code": 10000, "message": "not found"}]}).encode()
        extra = {}
        if isinstance(result, tuple):
            result, extra = result
        return status, json.dumps({"success": True, "result": result, **extra}).encode()

    def route(self, method, path, query, body):
        a = f"/accounts/{ACCOUNT}"
        z = f"/zones/{ZONE_ID}"
        match method, path:
            case "GET", p if p == f"{a}/tokens/verify":
                return 200, {"id": "setup", "status": self.setup_token_status}
            case "GET", "/user/tokens/verify":
                return 404, None
            case "GET", "/accounts":
                return 200, [{"id": ACCOUNT, "name": "wafer.space"}]
            case "GET", p if p == f"{a}/workers/subdomain":
                return (404, None) if self.subdomain is None else (200, {"subdomain": self.subdomain})
            case "PUT", p if p == f"{a}/workers/subdomain":
                self.subdomain = body["subdomain"]
                return 200, {"subdomain": self.subdomain}
            case "GET", p if p == f"{a}/rules/lists":
                return 200, self.lists
            case "POST", p if p == f"{a}/rules/lists":
                self.lists.append({**body, "id": self.new_id("list"), "num_items": 0})
                return 200, self.lists[-1]
            case "GET", p if p == f"{a}/rulesets/phases/http_request_redirect/entrypoint":
                return (404, None) if self.redirect_ruleset is None else (200, self.redirect_ruleset)
            case "POST", p if p == f"{a}/rulesets":
                assert self.redirect_ruleset is None
                self.redirect_ruleset = {**body, "id": self.new_id("rs")}
                return 200, self.redirect_ruleset
            case "POST", p if self.redirect_ruleset and p == f"{a}/rulesets/{self.redirect_ruleset['id']}/rules":
                self.redirect_ruleset["rules"].append(body)
                return 200, self.redirect_ruleset
            case "GET", "/zones":
                assert query == {"name": "wafer.space", "account.id": ACCOUNT}
                return 200, [{"id": ZONE_ID, "name": "wafer.space"}]
            case "GET", p if p == f"{z}/dns_records":
                assert query == {"name": "preview.wafer.space"}
                return 200, [self.dns]
            case "PATCH", p if p == f"{z}/dns_records/rec1":
                self.dns.update(body)
                return 200, self.dns
            case "GET", p if p == f"{z}/rulesets/phases/http_request_cache_settings/entrypoint":
                return (404, None) if self.cache_ruleset is None else (200, self.cache_ruleset)
            case "PUT", p if p == f"{z}/rulesets/phases/http_request_cache_settings/entrypoint":
                self.cache_ruleset = {"id": self.new_id("crs"), "rules": body["rules"]}
                return 200, self.cache_ruleset
            case "POST", p if self.cache_ruleset and p == f"{z}/rulesets/{self.cache_ruleset['id']}/rules":
                self.cache_ruleset["rules"].append(body)
                return 200, self.cache_ruleset
            case "GET", p if p == f"{a}/tokens/permission_groups":
                return 200, self.groups
            case "GET", p if p == f"{a}/tokens":
                page, per_page = int(query["page"]), int(query["per_page"])
                pages = max(1, -(-len(self.tokens) // per_page))
                chunk = self.tokens[(page - 1) * per_page:page * per_page]
                return 200, (chunk, {"result_info": {"page": page, "total_pages": pages}})
            case "POST", p if p == f"{a}/tokens":
                token = {"id": self.new_id("tok"), "name": body["name"], "policies": body["policies"]}
                self.tokens.append(token)
                return 200, {**token, "value": f"value-of-{token['id']}"}
            case "DELETE", p if p.startswith(f"{a}/tokens/"):
                self.tokens = [t for t in self.tokens if t["id"] != p.rsplit("/", 1)[1]]
                return 200, {"id": p.rsplit("/", 1)[1]}
        raise AssertionError(f"unexpected {method} {path}")

    # gh, node and wrangler
    def run(self, command, input=None, check=False, capture_output=False, text=False, cwd=None, env=None):
        def done(code=0, out=""):
            if check and code:
                raise subprocess.CalledProcessError(code, command)
            return subprocess.CompletedProcess(command, code, out, "")

        match command:
            case ["node", "--version"]:
                return done(out="v22.1.0\n")
            case ["gh", "variable", "get", name, "-R", repo]:
                value = self.variables.get((repo, name))
                return done(1) if value is None else done(out=value + "\n")
            case ["gh", "variable", "set", name, "-R", repo, "--body", value]:
                self.variables[(repo, name)] = value
                return done()
            case ["gh", "secret", "set", name, "-R", repo]:
                self.secrets[(repo, name)] = input
                return done()
            case ["npx", "wrangler", "deploy", "--secrets-file", path]:
                self.worker_secrets.update(json.loads(Path(path).read_text()))
                self.deploy_env = env
                return done()
        raise AssertionError(f"unexpected command {command}")


def make(fake, account_id=ACCOUNT, **options):
    log = []
    cf = setup.Cloudflare("setup-token", account_id, send=fake.send)
    s = setup.Setup(cf, run=fake.run, send=fake.send, sleep=lambda _: None, log=log.append, **options)
    return s, log


class SetupTest(unittest.TestCase):
    def setUp(self):
        # wrangler() checks the dependencies are installed
        self.node_modules = setup.ROOT / "node_modules" / "wrangler"
        if not self.node_modules.is_dir():
            self.skipTest("run npm ci first")

    def test_dry_run_changes_nothing(self):
        fake = Fake()
        s, log = make(fake)
        s.run_all()
        self.assertEqual(fake.writes, [])
        self.assertEqual(fake.variables, {})
        self.assertEqual(fake.secrets, {})
        self.assertEqual(fake.worker_secrets, {})
        text = "\n".join(log)
        for expected in ["would set the account's workers.dev subdomain to wafer-space",
                         "would create the redirect list wafer_space",
                         "would create the ruleset with a rule for each list",
                         "would proxy preview.wafer.space",
                         "would create the zone's cache rules",
                         "would create the token 'redirects Worker: replace the redirect lists' with Account Rule Lists Write",
                         "would deploy the Worker",
                         "would set the wafer-space/cloudflare-redirects-sync secret CLOUDFLARE_WORKERS_TOKEN",
                         "would set the wafer-space/wafer-space.github.io secret REDIRECTS_SYNC_SECRET",
                         "Nothing was changed"]:
            self.assertIn(expected, text)

    def test_apply_sets_everything_up(self):
        fake = Fake()
        s, log = make(fake, apply=True)
        s.run_all()
        self.assertEqual(fake.subdomain, "wafer-space")
        self.assertEqual([(l["name"], l["kind"]) for l in fake.lists],
                         [("wafer_space", "redirect"), ("preview_wafer_space", "redirect")])
        rules = fake.redirect_ruleset["rules"]
        self.assertEqual(fake.redirect_ruleset["phase"], "http_request_redirect")
        self.assertEqual([r["expression"] for r in rules],
                         ["http.request.full_uri in $wafer_space", "http.request.full_uri in $preview_wafer_space"])
        self.assertEqual(rules[1]["action_parameters"]["from_list"],
                         {"name": "preview_wafer_space", "key": "http.request.full_uri"})
        self.assertTrue(fake.dns["proxied"])
        self.assertEqual(fake.cache_ruleset["rules"][0]["action_parameters"], {"cache": False})
        self.assertEqual(fake.cache_ruleset["rules"][0]["expression"], '(http.host eq "preview.wafer.space")')

        lists_token, deploy_token = fake.tokens
        self.assertEqual(lists_token["policies"][0]["permission_groups"], [{"id": "g-lists"}])
        self.assertEqual(lists_token["policies"][0]["resources"], {f"com.cloudflare.api.account.{ACCOUNT}": "*"})
        self.assertEqual(deploy_token["policies"][0]["permission_groups"], [{"id": "g-workers"}])

        sync_secret = fake.worker_secrets["SYNC_SECRET"]
        self.assertGreaterEqual(len(sync_secret), 40)
        self.assertEqual(fake.worker_secrets, {"CF_API_TOKEN": f"value-of-{lists_token['id']}",
                                               "CF_ACCOUNT_ID": ACCOUNT, "SYNC_SECRET": sync_secret})
        self.assertEqual(fake.deploy_env["CLOUDFLARE_API_TOKEN"], f"value-of-{deploy_token['id']}")
        self.assertEqual(fake.deploy_env["CLOUDFLARE_ACCOUNT_ID"], ACCOUNT)
        self.assertFalse((setup.ROOT / "tmp" / "worker-secrets.json").exists())

        self.assertEqual(fake.variables, {
            ("wafer-space/cloudflare-redirects-sync", "CLOUDFLARE_ACCOUNT_ID"): ACCOUNT,
            ("wafer-space/wafer-space.github.io", "REDIRECTS_SYNC_URL"): "https://redirects.wafer-space.workers.dev",
        })
        self.assertEqual(fake.secrets, {
            ("wafer-space/cloudflare-redirects-sync", "CLOUDFLARE_WORKERS_TOKEN"): f"value-of-{deploy_token['id']}",
            ("wafer-space/wafer-space.github.io", "REDIRECTS_SYNC_SECRET"): sync_secret,
        })
        text = "\n".join(log)
        self.assertIn("ok: GET /list?list=preview_wafer_space", text)
        # No secret is logged
        for value in [sync_secret, f"value-of-{lists_token['id']}", f"value-of-{deploy_token['id']}"]:
            self.assertNotIn(value, text)

    def test_deploy_is_retried(self):
        fake = Fake()
        real_run = fake.run
        failures = []

        def run(command, **kwargs):
            if command[:3] == ["npx", "wrangler", "deploy"] and not failures:
                failures.append(command)
                raise subprocess.CalledProcessError(1, command)
            return real_run(command, **kwargs)

        fake.run = run
        s, log = make(fake, apply=True)
        s.run_all()
        self.assertEqual(len(failures), 1)
        self.assertIn("SYNC_SECRET", fake.worker_secrets)
        self.assertFalse((setup.ROOT / "tmp" / "worker-secrets.json").exists())

    def test_send_names_itself(self):
        # workers.dev refuses urllib's default User-Agent
        sent = []

        class Response:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *exc):
                return False
            def read(self):
                return b"{}"

        def urlopen(request, timeout):
            sent.append(request)
            return Response()

        with unittest.mock.patch("urllib.request.urlopen", urlopen):
            self.assertEqual(setup.send("GET", "https://example.com/", headers={"Authorization": "Bearer x"}),
                             (200, b"{}"))
        self.assertEqual(sent[0].get_header("User-agent"), "wafer-space/cloudflare-redirects-sync/scripts/setup.py")
        self.assertEqual(sent[0].get_header("Authorization"), "Bearer x")

    def test_worker_check_waits_for_the_certificate(self):
        fake = Fake()
        real_send = fake.send
        handshakes = []

        def send(method, url, *a):
            if "workers.dev" in url and len(handshakes) < 3:
                handshakes.append(url)
                raise urllib.error.URLError("ssl/tls alert handshake failure")
            return real_send(method, url, *a)

        fake.send = send
        s, log = make(fake, apply=True)
        s.run_all()
        self.assertEqual(len(handshakes), 3)
        self.assertIn("ok: GET /list?list=preview_wafer_space", "\n".join(log))

    def test_worker_check_failure_says_how_to_recover(self):
        fake = Fake()
        real_send = fake.send

        def send(method, url, *a):
            if "workers.dev" in url:
                raise urllib.error.URLError("ssl/tls alert handshake failure")
            return real_send(method, url, *a)

        fake.send = send
        with self.assertRaisesRegex(SystemExit, "handshake failure\n.*--apply --rotate"):
            make(fake, apply=True)[0].run_all()

    def test_rotate_keeps_old_tokens_if_the_worker_check_fails(self):
        fake = Fake()
        make(fake, apply=True)[0].run_all()
        old_ids = {t["id"] for t in fake.tokens}
        real_send = fake.send
        fake.send = lambda method, url, *a: (
            (500, b"broken") if "workers.dev" in url else real_send(method, url, *a))
        with self.assertRaisesRegex(SystemExit, "HTTP 500"):
            make(fake, apply=True, rotate=True)[0].run_all()
        self.assertLessEqual(old_ids, {t["id"] for t in fake.tokens})

    def test_second_run_changes_nothing(self):
        fake = Fake()
        make(fake, apply=True)[0].run_all()
        fake.writes.clear()
        secrets_before = dict(fake.secrets)
        s, log = make(fake, apply=True)
        s.run_all()
        self.assertEqual(fake.writes, [])
        self.assertEqual(fake.secrets, secrets_before)
        self.assertEqual(len(fake.tokens), 2)
        self.assertIn("exists; leaving it, and the secrets that hold it, alone", "\n".join(log))

    def test_existing_rulesets_get_rules_added(self):
        fake = Fake()
        other = {"expression": "true", "action": "redirect", "action_parameters": {"from_list": {"name": "other"}}}
        fake.redirect_ruleset = {"id": "rs-old", "phase": "http_request_redirect", "rules": [other]}
        fake.cache_ruleset = {"id": "crs-old", "rules": [{"expression": "true", "action": "set_cache_settings"}]}
        make(fake, apply=True)[0].run_all()
        self.assertEqual(fake.redirect_ruleset["rules"][0], other)
        self.assertEqual(len(fake.redirect_ruleset["rules"]), 3)
        self.assertEqual(fake.cache_ruleset["rules"][-1]["action_parameters"], {"cache": False})
        self.assertIn(("POST", f"/accounts/{ACCOUNT}/rulesets/rs-old/rules"), fake.writes)
        self.assertNotIn(("PUT", f"/zones/{ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint"),
                         fake.writes)

    def test_rotate_replaces_tokens_and_deletes_old_ones(self):
        fake = Fake()
        make(fake, apply=True)[0].run_all()
        old_ids = {t["id"] for t in fake.tokens}
        old_secret = fake.worker_secrets["SYNC_SECRET"]
        make(fake, apply=True, rotate=True)[0].run_all()
        self.assertEqual(len(fake.tokens), 2)
        self.assertFalse(old_ids & {t["id"] for t in fake.tokens})
        self.assertNotEqual(fake.worker_secrets["SYNC_SECRET"], old_secret)
        self.assertEqual(fake.secrets[("wafer-space/wafer-space.github.io", "REDIRECTS_SYNC_SECRET")],
                         fake.worker_secrets["SYNC_SECRET"])
        self.assertTrue(re.fullmatch(r"value-of-tok\d+", fake.worker_secrets["CF_API_TOKEN"]))
        self.assertNotIn(fake.worker_secrets["CF_API_TOKEN"].removeprefix("value-of-"), old_ids)

    def test_other_workers_subdomain_stops(self):
        fake = Fake()
        fake.subdomain = "someone-else"
        with self.assertRaisesRegex(SystemExit, "subdomain is someone-else"):
            make(fake, apply=True)[0].run_all()
        self.assertEqual(fake.writes, [])

    def test_missing_permission_group_stops(self):
        fake = Fake()
        fake.groups = [g for g in GROUPS if g["id"] != "g-workers"] + [
            {"id": "g-r", "name": "Workers Scripts Read", "scopes": ["com.cloudflare.api.account"]}]
        with self.assertRaisesRegex(SystemExit, "can't grant any of Workers Scripts Write.*Workers Scripts Read"):
            make(fake)[0].run_all()

    def test_bad_token_without_account_asks_for_one(self):
        fake = Fake()
        s, log = make(fake, account_id=None)
        # Without an account, only /user/tokens/verify can check the token
        with self.assertRaisesRegex(SystemExit, "give --account-id"):
            s.run_all()

    def test_inactive_setup_token_stops(self):
        fake = Fake()
        fake.setup_token_status = "expired"
        with self.assertRaisesRegex(SystemExit, "The setup token is expired"):
            make(fake)[0].run_all()

    def test_refused_step_names_the_permission(self):
        fake = Fake()
        real_send = fake.send
        fake.send = lambda method, url, *a: (
            (403, b'{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}')
            if url.endswith("/rules/lists") else real_send(method, url, *a))
        with self.assertRaisesRegex(SystemExit, "needs Account Rule Lists \\(Edit\\) on the account policy"):
            make(fake)[0].run_all()

    def test_cloudflare_errors_name_the_call(self):
        fake = Fake()
        fake.send = lambda *a: (403, b'{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}')
        cf = setup.Cloudflare("setup-token", ACCOUNT, send=fake.send)
        with self.assertRaisesRegex(setup.CloudflareError, r"GET /accounts/acc123/rules/lists: HTTP 403: 10000"):
            cf.result("GET", f"/accounts/{ACCOUNT}/rules/lists")


if __name__ == "__main__":
    unittest.main()
