import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertReferenceSentinelReady,
  createReferenceSentinelAuthorizer,
} from '../../apps/worker/src/browser/reference-sentinel.js';
import type { RuntimeContext } from '../../packages/contracts/src/execution.js';
import type { SentinelRequest } from '../../packages/contracts/src/sentinel.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

async function fixture(t: TestContext, action = 'process.stdout.write(JSON.stringify(out));') {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reference-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridgePath = join(directory, 'bridge.cjs');
  await writeFile(
    bridgePath,
    `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const args = JSON.parse(input);
  fs.writeFileSync(__dirname + '/input.json', JSON.stringify(args));
  const out = {
    main: JSON.stringify({p:'reference-proof',t:'reference-auth',c:'main-challenge',id:args.deviceId,flow:args.flow}),
    so: JSON.stringify({so:'reference-observer',c:'independent-observer-challenge',id:args.deviceId,flow:args.flow})
  };
  ${action}
});
`,
    { mode: 0o600 },
  );
  const environment = createEnvironment('PH', 'http://private-user:private-password@127.0.0.1:12345');
  environment.deviceId = 'original-device';
  const context: RuntimeContext = {
    environment,
    accountId: 'original-account',
    session: {
      accessToken: 'private-access-token',
      account: { id: 'original-account' },
    },
  };
  const request: SentinelRequest = {
    accountId: context.accountId,
    environmentId: environment.id,
    deviceId: environment.deviceId,
    flow: 'checkout_session_approval',
    observerFlow: 'chatgpt_checkout',
    pageUrl: 'https://chatgpt.com/checkout/example',
  };
  const authorize = createReferenceSentinelAuthorizer(context, { bridgePath });
  return { context, request, bridgePath, directory, authorize };
}

async function assertProcessesStopped(pids: number[]) {
  const stopped = async (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (process.platform === 'linux') {
      try {
        // kill(0) still succeeds for a killed process awaiting init reaping.
        const state = await readFile(`/proc/${pid}/stat`, 'utf8');
        return ['Z', 'X'].includes(state.slice(state.lastIndexOf(')') + 2, state.lastIndexOf(')') + 3));
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    }
    return false;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await Promise.all(pids.map(stopped))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('a bridge process remained runnable after termination');
}

test('the one-shot reference bridge receives the exact original profile, device, flow, proxy and eligible cookies', async (t) => {
  const f = await fixture(t);
  f.context.environment.headers['accept-language'] = 'fr-CA,fr;q=0.9,en;q=0.5';
  f.context.environment.cookies = [
    {
      name: 'oai-did',
      value: 'original-device',
      domain: '.chatgpt.com',
      secure: true,
    },
    {
      name: '__Secure-next-auth.session-token',
      value: 'private-login',
      domain: 'chatgpt.com',
      secure: true,
      expires: Date.now() / 1000 + 600,
    },
    {
      name: 'specific',
      value: 'included',
      domain: '.chatgpt.com',
      path: '/checkout',
    },
    { name: 'expired', value: 'excluded', domain: 'chatgpt.com', expires: 1 },
    { name: 'wrong-host', value: 'excluded', domain: 'auth.openai.com' },
    { name: 'wrong-subdomain', value: 'excluded', domain: '.evil.chatgpt.com' },
    {
      name: 'wrong-path',
      value: 'excluded',
      domain: 'chatgpt.com',
      path: '/check',
    },
  ];
  const result = await f.authorize(f.request);
  const args = JSON.parse(await readFile(join(f.directory, 'input.json'), 'utf8'));
  assert.equal(args.ua, f.context.environment.userAgent);
  assert.equal(args.deviceId, f.request.deviceId);
  assert.equal(args.flow, f.request.flow);
  assert.equal(args.pageUrl, f.request.pageUrl);
  assert.equal(args.proxy, f.context.environment.proxyUrl);
  assert.equal(args.language, 'fr-CA');
  assert.equal(args.platform, 'Win32');
  assert.equal(args.platformLabel, 'Windows');
  assert.equal(args.sentinelOrigin, 'https://chatgpt.com');
  assert.equal(args.version, '20260810913b');
  assert.equal(
    args.cookieHeader,
    'specific=included; oai-did=original-device; __Secure-next-auth.session-token=private-login',
  );
  assert.equal(result.observerFlow, 'chatgpt_checkout');
  assert.equal(JSON.parse(result.token).flow, 'checkout_session_approval');
  assert.equal(JSON.parse(result.soToken!).flow, 'checkout_session_approval');
  assert.notEqual(JSON.parse(result.token).c, JSON.parse(result.soToken!).c);
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.issuedAt), 60000);
});

test('cancelling authorization kills the one-shot reference bridge and its child process group', async (t) => {
  const f = await fixture(
    t,
    `
const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(__dirname+'/pids.json',JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`,
  );
  const cancellation = new AbortController();
  t.after(() => cancellation.abort());
  const authorize = createReferenceSentinelAuthorizer(
    f.context,
    { bridgePath: f.bridgePath },
    cancellation.signal,
  );
  const pending = authorize(f.request);
  let pids: number[] = [];
  for (let i = 0; i < 200; i++) {
    try {
      pids = JSON.parse(await readFile(join(f.directory, 'pids.json'), 'utf8'));
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pids.length, 2);
  cancellation.abort();
  await assert.rejects(pending, { code: 'EXECUTION_ABORTED' });
  for (let i = 0; i < 100; i++) {
    if (
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('a cancelled reference process remained alive');
});

test('a Session-backed identity without login cookies still seeds its original DID and allows absent SO', async (t) => {
  const f = await fixture(t, "out.so = ''; process.stdout.write(JSON.stringify(out));");
  const result = await f.authorize(f.request);
  const args = JSON.parse(await readFile(join(f.directory, 'input.json'), 'utf8'));
  assert.equal(args.cookieHeader, 'oai-did=original-device');
  assert.equal(result.soToken, undefined);
});

test('the platform follows the bound UA and custom SDK version is explicit', async (t) => {
  const f = await fixture(t);
  f.context.environment.userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36';
  f.context.environment.headers['user-agent'] = f.context.environment.userAgent;
  f.context.environment.headers['sec-ch-ua-platform'] = '"macOS"';
  await createReferenceSentinelAuthorizer(f.context, {
    bridgePath: f.bridgePath,
    version: 'custom-version',
  })(f.request);
  const args = JSON.parse(await readFile(join(f.directory, 'input.json'), 'utf8'));
  assert.equal(args.platform, 'MacIntel');
  assert.equal(args.platformLabel, 'macOS');
  assert.equal(args.version, 'custom-version');
});

test('identity, page, cookie and profile mismatches are rejected before launching the bridge', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { environmentId: 'another-environment' },
    { accountId: 'another-account' },
    { deviceId: 'another-device' },
    { pageUrl: 'https://evil.example/' },
  ]) {
    await assert.rejects(f.authorize({ ...f.request, ...change }), /BINDING/);
  }
  f.context.environment.cookies = [{ name: 'oai-did', value: 'different', domain: 'chatgpt.com' }];
  await assert.rejects(f.authorize(f.request), /COOKIE_BINDING/);
  f.context.environment.cookies = [
    {
      name: 'unsafe',
      value: 'private\r\nCookie: injected',
      domain: 'chatgpt.com',
    },
  ];
  await assert.rejects(f.authorize(f.request), /COOKIE_BINDING/);
  f.context.environment.cookies = [];
  f.context.environment.headers['user-agent'] = 'different-user-agent';
  await assert.rejects(f.authorize(f.request), /PROFILE_BINDING/);
  f.context.environment.headers['user-agent'] = f.context.environment.userAgent;
  f.context.environment.networkMode = 'proxy';
  f.context.environment.proxyUrl = '';
  await assert.rejects(f.authorize(f.request), /PROFILE_BINDING/);
  await assert.rejects(access(join(f.directory, 'input.json')));
});

test('a changed context cannot consume a bridge result issued for its previous identity', async (t) => {
  const f = await fixture(t, 'setTimeout(() => process.stdout.write(JSON.stringify(out)), 300);');
  const pending = f.authorize(f.request);
  const rejected = assert.rejects(pending, /IDENTITY_BINDING/);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await access(join(f.directory, 'input.json')).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await access(join(f.directory, 'input.json'));
  f.context.accountId = 'changed-account';
  await rejected;
});

const rejectedOutputs = [
  ['missing proof', "out.main = JSON.stringify({c:'challenge',id:args.deviceId,flow:args.flow});"],
  [
    'exhausted proof',
    "out.main = JSON.stringify({p:'gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4Dfailure~S',c:'challenge',id:args.deviceId,flow:args.flow});",
  ],
  ['wrong main identity', "out.main = JSON.stringify({p:'proof',c:'challenge',id:'wrong',flow:args.flow});"],
  [
    'wrong main flow',
    "out.main = JSON.stringify({p:'proof',c:'challenge',id:args.deviceId,flow:'oauth_create_account'});",
  ],
  ['multiline main', "out.main += '\\r\\nsecret-header';"],
  [
    'wrong observer identity',
    "out.so = JSON.stringify({so:'observer',c:'challenge',id:'wrong',flow:args.flow});",
  ],
  [
    'wrong observer flow',
    "out.so = JSON.stringify({so:'observer',c:'challenge',id:args.deviceId,flow:'chatgpt_checkout'});",
  ],
  ['missing observer challenge', "out.so = JSON.stringify({so:'observer',id:args.deviceId,flow:args.flow});"],
  ['bridge error', "out.error = 'private-runtime-output';"],
];

test('bridge diagnostics distinguish transient transport failures from invalid credentials without private output', async (t) => {
  for (const [mutation, reason, retryable] of [
    ["out.error = 'proto2: ETIMEDOUT private-secret';", 'UPSTREAM_TIMEOUT', true],
    ["out.error = 'proto2: fetch failed private-secret';", 'UPSTREAM_UNAVAILABLE', true],
    ["out.error = 'driver 无 c private-secret';", 'DRIVER_CHALLENGE_MISSING', false],
    [
      "out.main = JSON.stringify({p:'private-secret',id:'wrong',flow:args.flow});",
      'MAIN_IDENTITY_MISMATCH',
      false,
    ],
    ['out.main = JSON.stringify({id:args.deviceId,flow:args.flow});', 'MAIN_PROOF_MISSING', false],
  ] as const) {
    const f = await fixture(t, mutation + 'process.stdout.write(JSON.stringify(out));');
    await assert.rejects(f.authorize(f.request), (error: any) => {
      assert.equal(error.runtimeDiagnostic.reason, reason);
      assert.equal(error.runtimeDiagnostic.retryable, retryable);
      assert.equal(JSON.stringify(error).includes('private-secret'), false);
      assert.equal(error.message.includes('private-secret'), false);
      return true;
    });
  }
});
for (const [name, mutation] of rejectedOutputs) {
  test('reference authorization rejects ' + name, async (t) => {
    const f = await fixture(t, mutation + 'process.stdout.write(JSON.stringify(out));');
    await assert.rejects(f.authorize(f.request), (error: any) => error.code === 'SENTINEL_AUTH_REQUIRED');
  });
}

test('non-JSON, unsuccessful exits and private stderr never appear in a reference error', async (t) => {
  const f = await fixture(
    t,
    "process.stdout.write('private-runtime-output');process.stderr.write(args.proxy + args.cookieHeader + __filename);process.exitCode=1;",
  );
  await assert.rejects(f.authorize(f.request), (error: any) => {
    assert.equal(error.code, 'SENTINEL_AUTH_REQUIRED');
    assert.match(error.message, /BRIDGE_EXIT/);
    assert.ok(!/private|original-device|127\.0\.0\.1|bridge\.cjs/.test(error.message));
    return true;
  });
  await writeFile(
    f.bridgePath,
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('not-json'));",
  );
  await assert.rejects(f.authorize(f.request), /OUTPUT_INVALID/);
});

test('reference output is bounded and the overflowing process is stopped', async (t) => {
  const f = await fixture(t, "process.stdout.write('x'.repeat(600000));setInterval(()=>{},1000);");
  await assert.rejects(f.authorize(f.request), /OUTPUT_LIMIT/);
});

test(
  'a total timeout kills the bridge and its helper process group',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(
      t,
      `
    process.on('SIGTERM', () => {});
    const helper = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'ignore'});
    fs.writeFileSync(__dirname + '/pids.json', JSON.stringify([process.pid, helper.pid]));
    setInterval(()=>{},1000);
  `,
    );
    const authorize = createReferenceSentinelAuthorizer(f.context, {
      bridgePath: f.bridgePath,
      timeoutMs: 2000,
    });
    await assert.rejects(authorize(f.request), /TIMEOUT/);
    const pids = JSON.parse(await readFile(join(f.directory, 'pids.json'), 'utf8'));
    await assertProcessesStopped(pids);
  },
);

test('readiness validates local configuration without running the trusted bridge', async (t) => {
  const f = await fixture(t);
  await assertReferenceSentinelReady({ bridgePath: f.bridgePath });
  await assert.rejects(access(join(f.directory, 'input.json')));
  for (const options of [
    { bridgePath: 'relative-bridge.cjs' },
    { bridgePath: f.bridgePath, timeoutMs: 0 },
    { bridgePath: f.bridgePath, timeoutMs: Number.NaN },
    { bridgePath: f.bridgePath, version: '../private' },
    { bridgePath: f.directory },
    { bridgePath: join(f.directory, 'private-missing.cjs') },
  ]) {
    await assert.rejects(assertReferenceSentinelReady(options), (error: any) => {
      assert.equal(error.code, 'SENTINEL_AUTH_REQUIRED');
      assert.ok(!error.message.includes(f.directory));
      return true;
    });
  }
});
