#!/bin/sh
set -eu
root=$1
mkdir -p "$root"
if ! mkdir "$root/launcher.lock" 2>/dev/null; then
  owner=$(cat "$root/launcher.lock/pid" 2>/dev/null || printf '0')
  if [ "$owner" != 0 ] && kill -0 "$owner" 2>/dev/null; then exit 1; fi
  rm -rf "$root/launcher.lock"
  mkdir "$root/launcher.lock"
fi
printf '%s\n' "$$" > "$root/launcher.lock/pid"
child=
cleanup() {
  trap - INT TERM EXIT
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  rm -rf "$root/launcher.lock"
  exit 0
}
trap cleanup INT TERM EXIT
while :; do
  rm -rf "$root/manager.lock"
  rm -f "$root/healthy"
  "$root/current/runtime/bin/node" "$root/current/dist/apps/worker/src/entry.js" "$root" &
  child=$!
  if [ -f "$root/upgrade.json" ] && [ ! -f "$root/rollback.json" ]; then
    elapsed=0
    while [ ! -f "$root/healthy" ] && kill -0 "$child" 2>/dev/null && [ "$elapsed" -lt 60 ]; do
      sleep 1
      elapsed=$((elapsed + 1))
    done
    if [ ! -f "$root/healthy" ]; then
      kill -TERM "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      child=
      previous=$(readlink "$root/previous")
      "$previous/runtime/bin/node" "$previous/dist/apps/worker/src/cli.js" rollback "$root"
      continue
    fi
  fi
  wait "$child" 2>/dev/null || true
  child=
  sleep 2
done
