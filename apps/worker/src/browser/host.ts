import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// Dedicated watchdog. The parent's pipe closing also cleans up after a killed
// worker; Chrome never attaches to the user's normal profile or debugger port.
let browser: ChildProcess | undefined,
  directory = '',
  closing = false,
  started = false;
let cleanup: Promise<void> | undefined;
const stop = () =>
  (cleanup ||= (async () => {
    closing = true;
    if (browser?.pid) {
      try {
        process.kill(-browser.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100);
      if (browser.exitCode === null)
        try {
          process.kill(-browser.pid, 'SIGKILL');
        } catch {}
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    process.exit(0);
  })());
process.stdin.on('end', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.stdout.on('error', () => void stop());
// A host cannot become a permanent browser even if its caller hangs forever.
setTimeout(() => void stop(), 10 * 60_000).unref();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (started) {
    void stop();
    return;
  }
  started = true;
  void (async () => {
    const config = JSON.parse(line);
    if (typeof config.executablePath !== 'string' || !config.executablePath.startsWith('/'))
      throw new Error();
    if (config.proxyServer && !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.proxyServer))
      throw new Error();
    directory = await mkdtemp(join(tmpdir(), 'relay-sdk-'));
    await chmod(directory, 0o700);
    if (closing) return;
    const args = [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=' + directory,
      '--no-first-run',
      '--no-default-browser-check',
      ...(config.normalBrowserDefaults === true
        ? []
        : ['--disable-sync', '--disable-background-networking']),
      // Only the explicit isolated SDK probe requests extension loading. The
      // production caller supplies neither option; no personal profile is used.
      ...(config.sdkProbeExtension === true ? ['--enable-unsafe-extension-debugging'] : []),
      ...(config.headless ? ['--headless=new'] : []),
      ...(config.proxyServer ? ['--proxy-server=' + config.proxyServer] : ['--no-proxy-server']),
      'about:blank',
    ];
    // No fingerprint/automation shims, certificate bypass or remote SDK copies.
    browser = spawn(config.executablePath, args, {
      stdio: 'ignore',
      detached: true,
    });
    browser.on('error', () => void stop());
    browser.on('exit', () => void stop());
    for (let i = 0; i < 300 && !closing; i++) {
      try {
        const [port, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8'))
          .trim()
          .split('\n');
        if (/^\d+$/.test(port) && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) {
          process.stdout.write(
            JSON.stringify({
              endpoint: `ws://127.0.0.1:${port}${path}`,
              profile: directory,
              pid: browser.pid,
            }) + '\n',
          );
          return;
        }
      } catch {}
      await delay(50);
    }
    throw new Error();
  })().catch(() => {
    process.stdout.write('{"error":"BROWSER_START_FAILED"}\n');
    void stop();
  });
});
