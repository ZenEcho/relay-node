import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { OnDemandSdkRuntime } from '../../apps/worker/src/browser/runtime.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

test('automatic card preparation types only into the official secure frame and invokes only token preparation', async () => {
  const runtime: any = new OnDemandSdkRuntime({
    context: { environment: createEnvironment('PH', '') },
  } as any);
  runtime.open = async () => {};
  runtime.session = 'main';
  runtime.frames = new Set(['card-frame']);
  let focused: any, resolveSdk!: (value: any) => void;
  const scripts: string[] = [],
    typed: any[] = [];
  const fields: any = Object.fromEntries(
    ['number', 'expiry', 'cvc'].map((name) => [
      name,
      {
        value: '',
        focus() {
          focused = this;
        },
      },
    ]),
  );
  const button = {
    type: 'submit',
    textContent: '生成一次性卡片令牌',
    get disabled() {
      return Object.values(fields).some((f: any) => !f.value);
    },
    click() {
      resolveSdk({ ok: true, id: 'ctoken_original', lastFour: '4242' });
    },
  };
  const document: any = {
    get activeElement() {
      return focused;
    },
    querySelector(selector: string) {
      if (selector === '#relay-stripe-preparation form') return { querySelector: () => button };
      const name = selector.match(/input\[name=(\w+)\]/)?.[1];
      return name ? fields[name] : null;
    },
  };
  runtime.cdp = {
    evaluate: async (expression: string, session: string) => {
      scripts.push(expression);
      if (expression.includes('function prepareStripeTokenInPage('))
        return new Promise((resolve) => {
          resolveSdk = resolve;
        });
      return runInNewContext(expression, {
        document,
        location: {
          hostname: session === 'card-frame' ? 'js.stripe.com' : 'chatgpt.com',
        },
      });
    },
    send: async (method: string, body: any, session: string) => {
      if (method === 'Input.insertText') {
        assert.equal(session, 'card-frame');
        typed.push({ method, session });
        focused.value =
          focused === fields.number
            ? body.text.replace(/(.{4})/g, '$1 ').trim()
            : focused === fields.expiry
              ? body.text.slice(0, 2) + ' / ' + body.text.slice(2)
              : body.text;
      }
      return {};
    },
    close() {},
  };
  try {
    const value = await runtime.prepareStripeToken(
      { cardLastFour: '4242', amountMinor: 98214 } as any,
      { number: '4242424242424242', expiry: '12/30', cvc: '123' },
    );
    assert.deepEqual(value, { id: 'ctoken_original', lastFour: '4242' });
    assert.equal(typed.length, 3);
    assert.ok(scripts.every((x) => !x.includes('4242424242424242') && !x.includes('"123"')));
    assert.ok(!scripts.some((x) => /stripe\.confirmPayment\(/.test(x)));
  } finally {
    await runtime.close();
  }
});

test('ambiguous secure card frames stop before any input is sent', async () => {
  const runtime: any = new OnDemandSdkRuntime({ context: {} } as any);
  runtime.frames = new Set(['one', 'two']);
  runtime.cdp = {
    evaluate: async () => true,
    send: async () => ({}),
    close() {},
  };
  await assert.rejects(runtime.cardFrame(), /多个 Stripe/);
  await runtime.close();
});
