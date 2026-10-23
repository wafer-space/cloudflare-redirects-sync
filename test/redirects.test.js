import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ValidationError,
  buildPreviewItems,
  describeList,
  inputDigest,
  parseDescription,
  parseJson,
  parsePreviewIndex,
  parseRedirects,
  rewriteForPreview,
} from "../src/redirects.js";

const entry = (source_url, target_url, extra = {}) => ({
  redirect: { source_url, target_url, status_code: 301, ...extra },
});

const SAMPLE = [
  entry("wafer.space/about.html", "https://wafer.space/about", { preserve_query_string: true }),
  entry("wafer.space/discord", "https://discord.gg/abc"),
  entry("wafer.space/news/index.html", "https://wafer.space/news#latest", { preserve_query_string: true }),
  entry("wafer.space/slides", "https://docs.google.com/x/pub?start=false&loop=false#slide=id.p#2"),
];

test("parseRedirects fills in Cloudflare's defaults", () => {
  const [about, discord] = parseRedirects(SAMPLE);
  assert.deepEqual(about, {
    source_url: "wafer.space/about.html",
    target_url: "https://wafer.space/about",
    status_code: 301,
    include_subdomains: false,
    subpath_matching: false,
    preserve_path_suffix: true,
    preserve_query_string: true,
  });
  assert.equal(discord.preserve_query_string, false);
});

test("parseRedirects leaves odd external targets alone", () => {
  const slides = parseRedirects(SAMPLE)[3];
  assert.equal(slides.target_url, "https://docs.google.com/x/pub?start=false&loop=false#slide=id.p#2");
});

for (const [name, data, message] of [
  ["a non-array", { redirect: {} }, /expected a JSON array/],
  ["a non-object item", [42], /expected an object/],
  ["an item without redirect", [{}], /missing "redirect"/],
  ["an extra item key", [{ ...entry("wafer.space/a", "https://wafer.space/b"), x: 1 }], /unexpected key/],
  ["an unknown redirect key", [entry("wafer.space/a", "https://wafer.space/b", { foo: 1 })], /unexpected redirect key/],
  ["a source with a scheme", [entry("https://wafer.space/a", "https://wafer.space/b")], /source_url/],
  ["a source on another host", [entry("evil.example/a", "https://wafer.space/b")], /source_url/],
  ["a source on a lookalike host", [entry("wafer.space.evil/a", "https://wafer.space/b")], /source_url/],
  ["a source with a query string", [entry("wafer.space/a?x=1", "https://wafer.space/b")], /source_url/],
  ["a source with whitespace", [entry("wafer.space/a b", "https://wafer.space/b")], /source_url/],
  ["a javascript: target", [entry("wafer.space/a", "javascript:alert(1)")], /target_url/],
  ["a relative target", [entry("wafer.space/a", "/b")], /target_url/],
  ["a 200 status", [entry("wafer.space/a", "https://wafer.space/b", { status_code: 200 })], /status_code/],
  ["a string status", [entry("wafer.space/a", "https://wafer.space/b", { status_code: "301" })], /status_code/],
  ["a non-boolean flag", [entry("wafer.space/a", "https://wafer.space/b", { preserve_query_string: "yes" })], /must be true or false/],
  ["a duplicate source", [entry("wafer.space/a", "https://wafer.space/b"), entry("wafer.space/a", "https://wafer.space/c")], /duplicate/],
]) {
  test(`parseRedirects rejects ${name}`, () => {
    assert.throws(() => parseRedirects(data), (err) => err instanceof ValidationError && message.test(err.message));
  });
}

test("rewriteForPreview moves sources and wafer.space targets under the preview", () => {
  const [about, discord, news] = parseRedirects(SAMPLE);
  const a = rewriteForPreview(about, "pr-126");
  assert.equal(a.source_url, "preview.wafer.space/pr-126/about.html");
  assert.equal(a.target_url, "https://preview.wafer.space/pr-126/about");
  assert.equal(a.status_code, 302);
  assert.equal(a.preserve_query_string, true);
  assert.equal(rewriteForPreview(discord, "pr-126").target_url, "https://discord.gg/abc");
  assert.equal(rewriteForPreview(news, "pr-126").target_url, "https://preview.wafer.space/pr-126/news#latest");
});

test("rewriteForPreview handles the site root in every form", () => {
  const base = parseRedirects([entry("wafer.space/home", "https://wafer.space")])[0];
  for (const [target, expected] of [
    ["https://wafer.space", "https://preview.wafer.space/pr-7/"],
    ["https://wafer.space/", "https://preview.wafer.space/pr-7/"],
    ["https://wafer.space#top", "https://preview.wafer.space/pr-7/#top"],
    ["https://wafer.space/?a=1", "https://preview.wafer.space/pr-7/?a=1"],
    ["https://wafer.space.example/x", "https://wafer.space.example/x"],
    ["https://www.wafer.space/x", "https://www.wafer.space/x"],
  ]) {
    assert.equal(rewriteForPreview({ ...base, target_url: target }, "pr-7").target_url, expected, target);
  }
});

test("rewriteForPreview rejects anything but a pr-NNN directory", () => {
  const [about] = parseRedirects(SAMPLE);
  for (const dir of ["pr-1-slug", "pr-", "../pr-1", "pr-1/x"]) {
    assert.throws(() => rewriteForPreview(about, dir), ValidationError, dir);
  }
});

test("buildPreviewItems combines previews, sorted by source", () => {
  const items = buildPreviewItems({ "pr-9": SAMPLE.slice(0, 1), "pr-10": SAMPLE.slice(1, 2) });
  assert.deepEqual(
    items.map((i) => i.source_url),
    ["preview.wafer.space/pr-10/discord", "preview.wafer.space/pr-9/about.html"],
  );
});

test("buildPreviewItems fails if any one preview is bad", () => {
  assert.throws(
    () => buildPreviewItems({ "pr-1": SAMPLE, "pr-2": [entry("evil.example/a", "https://wafer.space/")] }),
    /pr-2\/redirects.json\[0\]/,
  );
});

test("parsePreviewIndex keeps only previews with redirects", () => {
  const dirs = parsePreviewIndex({
    previews: [
      { path: "pr-20", redirects: true },
      { path: "pr-3", redirects: false },
      { path: "pr-100", redirects: true },
    ],
  });
  assert.deepEqual(dirs, ["pr-100", "pr-20"]);
});

test("parsePreviewIndex rejects malformed indexes", () => {
  for (const data of [null, [], { previews: {} }, { previews: [{ path: "pr-1-slug", redirects: true }] }, { previews: ["pr-1"] }]) {
    assert.throws(() => parsePreviewIndex(data), ValidationError, JSON.stringify(data));
  }
});

test("parseJson names the file when it isn't JSON", () => {
  assert.deepEqual(parseJson('{"a": 1}', "x.json"), { a: 1 });
  assert.throws(() => parseJson("<html>", "x.json"), (err) => err instanceof ValidationError && /x\.json: not valid JSON/.test(err.message));
});

test("inputDigest depends on every part and where the parts split", async () => {
  const digest = await inputDigest(["pr-1", "abc"]);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await inputDigest(["pr-1", "abc"]), digest);
  assert.notEqual(await inputDigest(["pr-1", "abd"]), digest);
  assert.notEqual(await inputDigest(["pr-1a", "bc"]), digest);
  assert.notEqual(await inputDigest(["pr-1", "abc", "pr-2", ""]), digest);
});

test("the digest and count round-trip through the list description", async () => {
  const digest = await inputDigest(["x"]);
  assert.ok(describeList(digest, 123).length <= 500);
  assert.deepEqual(parseDescription(describeList(digest, 123)), { digest, items: 123 });
  assert.equal(parseDescription(""), null);
  assert.equal(parseDescription(undefined), null);
  assert.equal(parseDescription(`sha256=${digest}`), null);
});
