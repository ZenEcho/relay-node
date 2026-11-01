import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
const go =
  process.env.GO_BINARY ||
  (existsSync(".data/tools/go/bin/go")
    ? new URL("../.data/tools/go/bin/go", import.meta.url).pathname
    : "go");
for (const args of [
  ["mod", "tidy"],
  ["build", "-trimpath", "-o", "relay-transport", "."],
]) {
  const r = spawnSync(go, args, {
    cwd: new URL("../native/transport", import.meta.url),
    stdio: "inherit",
  });
  if (r.error) {
    console.error("请安装 Go 1.26+ 或设置 GO_BINARY。");
    process.exit(1);
  }
  if (r.status) process.exit(r.status);
}
