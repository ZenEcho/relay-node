import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const version = "go1.27.3",
  os = process.platform === "win32" ? "windows" : process.platform,
  arch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!arch || os === "windows")
  throw new Error(
    "自动安装支持 macOS/Linux amd64/arm64；Windows 请手动安装 Go。",
  );
const releases = await fetch("https://go.dev/dl/?mode=json&include=all").then(
  (r) => r.json(),
);
const file = releases
  .find((r) => r.version === version)
  ?.files.find((f) => f.os === os && f.arch === arch && f.kind === "archive");
if (!file) throw new Error("官方 Go 下载目录中找不到指定构建");
await mkdir(".data/tools", { recursive: true });
const response = await fetch("https://go.dev/dl/" + file.filename);
if (!response.ok) throw new Error("Go 下载失败");
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
  throw new Error("Go 校验失败");
await writeFile(".data/tools/go.tar.gz", bytes);
const result = spawnSync(
  "tar",
  ["-xzf", ".data/tools/go.tar.gz", "-C", ".data/tools"],
  { stdio: "inherit" },
);
if (result.status) process.exit(result.status);
console.log("Go 已安装在项目 .data/tools/go；运行 pnpm run native:build。");
