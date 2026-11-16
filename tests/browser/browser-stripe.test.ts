import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { prepareStripeTokenInPage } from '../../dist/apps/worker/src/browser/actions.js';

function fixture(wrongCard = false) {
  const calls: string[] = [];
  const nodes: any[] = [];
  const request = {
    checkoutId: 'oaics_original',
    accountId: 'account-fixture',
    environmentId: 'env-fixture',
    deviceId: 'device-fixture',
    publishableKey: 'pk_test_fixture',
    stripeAccount: undefined as string | undefined,
    customerSessionClientSecret: undefined as string | undefined,
    amountMinor: 98214,
    currency: 'PHP',
    cardLastFour: '4242',
    returnUrl: 'https://chatgpt.com/',
    billing: {
      name: 'Fixture',
      email: 'fixture@example.test',
      phone: '',
      line1: '123 Fixture St',
      city: 'Cheyenne',
      state: 'WY',
      postalCode: '82001',
      country: 'US',
    },
  };
  const events: Record<string, (v?: any) => void> = {};
  let options: any, paymentOptions: any, tokenParams: any;
  const page: any = {
    location: { origin: 'https://chatgpt.com' },
    fetch: async (path: string) => {
      assert.equal(path, '/api/auth/session');
      return {
        ok: true,
        json: async () => ({ account: { id: request.accountId }, user: { id: 'user-fixture' } }),
      };
    },
    document: {
      cookie: 'oai-did=device-fixture',
      getElementById: () => null,
      createElement: (tag: string) => {
        const el = {
          tag,
          style: {},
          children: [],
          setAttribute() {},
          append(...children: any[]) {
            this.children.push(...children);
          },
          remove() {},
        } as any;
        nodes.push(el);
        return el;
      },
      body: { append() {} },
    },
    Stripe: () => ({
      elements: (config: any) => {
        options = config;
        calls.push('elements');
        return {
          create: (type: string, config: any) => {
            assert.equal(type, 'payment');
            paymentOptions = config;
            calls.push('create');
            return {
              on: (event: string, handler: any) => {
                events[event] = handler;
              },
              mount() {
                calls.push('mount');
                setTimeout(() => {
                  events.ready();
                  events.change({ complete: true });
                  void nodes.find((n) => n.tag === 'form').onsubmit({ preventDefault() {} });
                }, 0);
              },
              destroy() {
                calls.push('destroy');
              },
            };
          },
          submit: async () => {
            calls.push('submit');
            return {};
          },
        };
      },
      createConfirmationToken: async (params: any) => {
        tokenParams = params;
        // Stripe rejects any suppressed billing field that the caller omits.
        // Enforce that contract here, including optional fields such as phone.
        for (const [field, mode] of Object.entries(paymentOptions.fields.billingDetails)) {
          if (mode === 'never') {
            assert.ok(
              params.params.payment_method_data.billing_details[field] !== undefined,
              'Suppressed billing field was not supplied: ' + field,
            );
          }
        }
        calls.push('token');
        return {
          confirmationToken: {
            id: 'ctoken_fixture123',
            payment_method_preview: { type: 'card', card: { last4: wrongCard ? '9999' : '4242' } },
          },
        };
      },
    }),
  };
  const execute = () =>
    runInNewContext('(' + prepareStripeTokenInPage.toString() + ')(request)', {
      window: page,
      request,
      URL,
      Intl,
      setTimeout,
      clearTimeout,
    });
  return { request, page, calls, execute, options: () => options, tokenParams: () => tokenParams };
}
test('the shipped page action uses official Elements and returns only the selected card token', async () => {
  const f = fixture();
  const result = JSON.parse(JSON.stringify(await f.execute()));
  assert.deepEqual(result, { ok: true, id: 'ctoken_fixture123', lastFour: '4242' });
  assert.deepEqual(f.calls, ['elements', 'create', 'mount', 'submit', 'token', 'destroy']);
  assert.equal(f.options().mode, 'subscription');
  assert.equal(f.options().amount, 98214);
  assert.deepEqual(Array.from(f.options().paymentMethodTypes), ['card']);
  assert.equal(f.tokenParams().params.payment_method_data.billing_details.address.state, 'WY');
  assert.ok(!JSON.stringify(f.request).includes('number'));
});
test('Stripe.js loads directly from Stripe with the original account and customer session', async () => {
  const f = fixture();
  const factory = f.page.Stripe;
  let stripeOptions: any;
  f.page.Stripe = undefined;
  f.request.stripeAccount = 'acct_original';
  f.request.customerSessionClientSecret = 'cuss_original';
  f.request.billing.phone = '  +1 202 555 0148  ';
  f.page.document.head = {
    appendChild(script: any) {
      assert.equal(script.src, 'https://js.stripe.com/v3/');
      f.page.Stripe = (key: string, options: any) => {
        assert.equal(key, f.request.publishableKey);
        stripeOptions = options;
        return factory();
      };
      script.onload();
    },
  };
  assert.equal((await f.execute()).ok, true);
  assert.equal(stripeOptions.stripeAccount, 'acct_original');
  assert.equal(f.options().customerSessionClientSecret, 'cuss_original');
  assert.equal(f.tokenParams().params.payment_method_data.billing_details.phone, '+1 202 555 0148');
});
test('another card token is rejected before it can reach merchant confirmation', async () => {
  const result = await fixture(true).execute();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_MISMATCH');
  assert.equal(result.cardDataSubmitted, true);
  assert.equal(result.id, undefined);
});
test('an unrelated page cannot open or invoke the payment component', async () => {
  const f = fixture();
  f.page.location.origin = 'https://other.example';
  const result = await f.execute();
  assert.equal(result.reason, 'CONFIG_INVALID');
  assert.equal(result.cardDataSubmitted, false);
  assert.deepEqual(f.calls, []);
});
