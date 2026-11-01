import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  symlink,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  downloadRelease,
  latestRelease,
  newerVersion,
  saveJson,
  jsonFile,
  switchCurrent,
} from "../apps/worker/src/release.js";
import {
  nodeAcceptsNew,
  nodeBlockers,
} from "../packages/core/src/node-control.js";

test("only newer stable semantic versions are eligible", () => {
  assert.equal(newerVersion("v0.2.0", "0.1.9"), true);
  assert.equal(newerVersion("v0.1.0", "0.1.0"), false);
  assert.equal(newerVersion("v0.0.9", "0.1.0"), false);
  assert.throws(() => newerVersion("v0.2.0-beta", "0.1.0"));
});
test("release API failures and prereleases cannot become update candidates", async () => {
  await assert.rejects(
    latestRelease((async () => new Response("", { status: 403 })) as any),
    /403/,
  );
  await assert.rejects(
    latestRelease((async () =>
      Response.json({ tag_name: "v1.0.0", prerelease: true })) as any),
    /正式版本/,
  );
});
test("download verifies digest, origin, archive links and platform before installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      version: "0.2.0",
      protocolVersion: 1,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: "24.22.1",
    }),
  );
  const makeArchive = () =>
    execFileSync("tar", ["-czf", "-", "-C", source, "."]);
  const bytes = makeArchive(),
    name = `relay-node-0.2.0-${process.platform}-${process.arch}.tar.gz`;
  const asset = {
    name,
    digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    browser_download_url: `https://github.com/ZenEcho/relay-node/releases/download/v0.2.0/${name}`,
  };
  const release = { tag_name: "v0.2.0", assets: [asset] };
  const fetcher = (async () => new Response(bytes)) as typeof fetch;
  assert.equal(
    (
      await downloadRelease(
        release,
        join(root, "ok"),
        process.platform,
        process.arch,
        fetcher,
      )
    ).version,
    "0.2.0",
  );
  await assert.rejects(
    downloadRelease(
      {
        ...release,
        assets: [{ ...asset, digest: "sha256:" + "0".repeat(64) }],
      },
      join(root, "bad"),
      process.platform,
      process.arch,
      fetcher,
    ),
    /校验失败/,
  );
  await assert.rejects(
    downloadRelease(
      {
        ...release,
        assets: [
          { ...asset, browser_download_url: "https://evil.invalid/archive" },
        ],
      },
      join(root, "origin"),
      process.platform,
      process.arch,
      fetcher,
    ),
    /节点仓库/,
  );
  await symlink("/tmp", join(source, "escape"));
  const linked = makeArchive();
  const linkedFetch = (async () => new Response(linked)) as typeof fetch;
  await assert.rejects(
    downloadRelease(
      {
        ...release,
        assets: [
          {
            ...asset,
            digest:
              "sha256:" + createHash("sha256").update(linked).digest("hex"),
          },
        ],
      },
      join(root, "link"),
      process.platform,
      process.arch,
      linkedFetch,
    ),
    /链接或特殊文件/,
  );
});
test("persistent state and atomic release pointers are isolated per instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-instances-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["one", "two"]) {
    await mkdir(join(root, name));
    await saveJson(join(root, name, "config.json"), { token: name });
    await switchCurrent(join(root, name), "/release/0.1.0");
  }
  await switchCurrent(join(root, "one"), "/release/0.2.0");
  assert.equal(await readlink(join(root, "two/current")), "/release/0.1.0");
  assert.equal(
    (await jsonFile<any>(join(root, "one/config.json"))).token,
    "one",
  );
});
test("pausing or updating never makes an otherwise live node available for new orders", () => {
  const node = {
    id: "n",
    enabled: true,
    transportReady: true,
    lastSeenAt: new Date().toISOString(),
    control: { revision: 1, desiredState: "paused" },
  } as any;
  assert.equal(nodeAcceptsNew(node), false);
  node.control.desiredState = "running";
  assert.equal(nodeAcceptsNew(node), true);
  node.control.update = { phase: "draining" };
  assert.equal(nodeAcceptsNew(node), false);
  for (const status of [
    "running",
    "awaiting_captcha",
    "pending_confirmation",
    "paused",
  ])
    assert.equal(
      nodeBlockers("n", [
        { id: "r", nodeId: "n", status, order: { orderNo: "A" } } as any,
      ]).length,
      1,
    );
});
