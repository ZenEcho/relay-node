#!/bin/sh
set -eu
umask 077
repository=ZenEcho/relay-node
case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) printf '%s\n' '支持 Linux 与 macOS。' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) printf '%s\n' '支持 amd64 与 arm64。' >&2; exit 1;; esac
command -v curl >/dev/null 2>&1 || { printf '%s\n' '请先安装 curl。' >&2; exit 1; }
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT INT TERM
curl -fsSL --proto '=https' "https://api.github.com/repos/$repository/releases/latest" -o "$temporary/release.json"
version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([0-9][0-9.]*\)".*/\1/p' "$temporary/release.json" | head -n 1)
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { printf '%s\n' '尚无完整的正式版本。' >&2; exit 1; }
asset="relay-node-$version-$platform-$arch.tar.gz"
url="https://github.com/$repository/releases/download/v$version"
printf '正在下载 Relay Node %s（%s/%s）…\n' "$version" "$platform" "$arch"
curl -fsSL --proto '=https' "$url/SHA256SUMS" -o "$temporary/SHA256SUMS"
curl -fSL --proto '=https' "$url/$asset" -o "$temporary/package.tar.gz"
expected=$(awk -v asset="$asset" '$2 == asset {print $1}' "$temporary/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/package.tar.gz" | awk '{print $1}'); else actual=$(shasum -a 256 "$temporary/package.tar.gz" | awk '{print $1}'); fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { printf '%s\n' '安装包校验失败。' >&2; exit 1; }
tar -tzf "$temporary/package.tar.gz" > "$temporary/files"
awk '/^\// || /(^|\/)\.\.(\/|$)/ || /\\/ {bad=1} END {exit bad}' "$temporary/files" || { printf '%s\n' '安装包路径无效。' >&2; exit 1; }
tar -tvzf "$temporary/package.tar.gz" | awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {bad=1} END {exit bad}' || { printf '%s\n' '安装包文件类型无效。' >&2; exit 1; }
mkdir "$temporary/package"
tar -xzf "$temporary/package.tar.gz" -C "$temporary/package" --no-same-owner
"$temporary/package/runtime/bin/node" "$temporary/package/dist/apps/worker/src/entry.js" --self-test "$temporary/package"
"$temporary/package/runtime/bin/node" "$temporary/package/dist/apps/worker/src/cli.js" install "$@"
