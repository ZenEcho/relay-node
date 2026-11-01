import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, join } from "node:path";
import { rm } from "node:fs/promises";
if (!process.env.GITHUB_ACTIONS)
  throw Error(
    "Service verification only runs on disposable GitHub Actions runners",
  );
const exec = promisify(execFile),
  instance = "ci-" + process.pid;
const stage = resolve("release/stage");
let control = { revision: 0, desiredState: "running" },
  last,
  installed = false;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization !== "Bearer relaynode.ci.node.service-token") {
    res.statusCode = 401;
    res.end('{"message":"unauthorized"}');
    return;
  }
  if (req.url === "/api/worker/heartbeat") {
    last = body;
    res.end(JSON.stringify({ control, blockers: [], protocolVersion: 1 }));
  } else if (req.url === "/api/worker/poll") res.end("null");
  else if (req.url === "/api/worker/control") {
    control = {
      ...control,
      revision: control.revision + 1,
      desiredState: body.action === "pause" ? "paused" : "running",
    };
    res.end(JSON.stringify({ control, blockers: [], protocolVersion: 1 }));
  } else res.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  CONSOLE_URL: `http://127.0.0.1:${server.address().port}`,
  NODE_TOKEN: "relaynode.ci.node.service-token",
};
const cli = join(stage, "dist/apps/worker/src/cli.js"),
  node = join(stage, "runtime/bin/node");
async function invoke(args) {
  return process.platform === "linux"
    ? exec(
        "sudo",
        [
          "--preserve-env=CONSOLE_URL,NODE_TOKEN,RELAY_NODE_INSTANCE",
          node,
          cli,
          ...args,
        ],
        { env },
      )
    : exec(node, [cli, ...args], { env });
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(200);
  }
  throw Error("Managed service readiness timed out");
}
try {
  installed = true;
  const result = await invoke(["install", "--instance", instance]);
  console.log(result.stdout);
  await until(() => last?.transportReady === true);
  await invoke(["--instance", instance, "pause"]);
  await until(() => control.desiredState === "paused");
  await invoke(["--instance", instance, "resume"]);
  await until(() => control.desiredState === "running");
  console.log(
    `Verified real ${process.platform === "linux" ? "systemd" : "launchd"} service, authentication, pause and resume`,
  );
} finally {
  if (installed) {
    if (process.platform === "linux") {
      await exec("sudo", [
        "systemctl",
        "disable",
        "--now",
        `relay-node-${instance}.service`,
      ]).catch(() => {});
      await exec("sudo", [
        "rm",
        "-f",
        `/etc/systemd/system/relay-node-${instance}.service`,
      ]).catch(() => {});
      await exec("sudo", ["systemctl", "daemon-reload"]).catch(() => {});
      await exec("sudo", [
        "rm",
        "-rf",
        `/var/lib/relay-node/${instance}`,
      ]).catch(() => {});
      await exec("sudo", ["userdel", `relay-${instance}`]).catch(() => {});
    } else {
      await exec("launchctl", [
        "bootout",
        `gui/${process.getuid()}/com.relay.node.${instance}`,
      ]).catch(() => {});
      await rm(
        join(
          process.env.HOME,
          "Library/LaunchAgents",
          `com.relay.node.${instance}.plist`,
        ),
        { force: true },
      );
      await rm(
        join(
          process.env.HOME,
          "Library/Application Support/RelayNode",
          instance,
        ),
        { recursive: true, force: true },
      );
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
