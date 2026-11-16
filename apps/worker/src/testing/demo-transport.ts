import { setTimeout } from 'node:timers/promises';
import type { Environment } from '../../../../packages/contracts/src/execution.js';
import type { HttpInput, HttpOutput, Transport } from '../transport/native.js';
export class DemoTransport implements Transport {
  private environment!: Environment;
  private willRenew = true;
  constructor(private delay = 180) {}
  async initialize(environment: Environment) {
    this.environment = environment;
  }
  async request(input: HttpInput): Promise<HttpOutput> {
    await setTimeout(this.delay);
    const u = new URL(input.url);
    let data: any = {};
    const suffix = this.environment.id.replaceAll('-', '').slice(0, 16);
    if (u.hostname === 'ipapi.co')
      data = {
        ip: '192.0.2.' + (10 + (parseInt(suffix.slice(0, 2), 16) % 100)),
        country_code: this.environment.country,
      };
    else if (u.pathname === '/api/auth/session')
      data = { accessToken: 'demo-refreshed-session', account: { id: 'demo-account' } };
    else if (u.pathname === '/')
      return {
        status: 200,
        headers: {},
        body: '<html data-build="demo" data-seq="1"></html>',
        data: null,
      };
    else if (u.pathname.includes('/accounts/check/'))
      data = {
        accounts: {
          default: {
            account: { account_id: 'demo-account' },
            entitlement: { has_active_subscription: false, subscription_plan: 'free' },
          },
        },
        user: { email: 'demo@example.com' },
      };
    else if (u.pathname.includes('pricing_config'))
      data = {
        currency_config: {
          symbol_code: ({ US: 'USD', PH: 'PHP', EG: 'EGP', CL: 'CLP' } as any)[
            this.environment.country
          ],
        },
      };
    else if (u.pathname.includes('/sentinel/')) {
      const request = JSON.parse(input.body || '{}');
      const common = { c: 'demo-sentinel', id: this.environment.deviceId, flow: request.flow };
      data = {
        ...request,
        token: JSON.stringify({ p: 'demo-proof', t: 'demo-auth', ...common }),
        soToken: JSON.stringify({
          so: 'demo-observer',
          ...common,
          c: 'demo-observer-challenge',
          flow: request.observerFlow,
        }),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    } else if (u.pathname.endsWith('/checkout'))
      data = { internal_checkout_session_id: 'oaics_demo' + suffix };
    else if (u.pathname.endsWith('/taxes'))
      data = {
        checkout_session: {
          id: 'oaics_demo' + suffix,
          publishable_key: 'pk_test_demo',
          amount_total: 2000,
          currency: String(JSON.parse(input.body || '{}').currency || 'usd').toLowerCase(),
          mode: 'subscription',
          processor_entity: 'openai_llc',
        },
      };
    else if (u.pathname.endsWith('/elements/sessions'))
      data = { id: 'elements_session_demo' + suffix, config_id: 'cfg_demo' + suffix };
    else if (u.pathname.endsWith('/confirmation_tokens')) data = { id: 'ctoken_demo' + suffix };
    else if (u.pathname.endsWith('/checkout/confirm'))
      data = {
        status: 'success',
        client_secret: 'pi_demo' + suffix + '_secret_demo',
        confirm_return_url: 'https://chatgpt.com/',
      };
    else if (u.pathname.includes('/payment_intents/'))
      data = { id: 'pi_demo' + suffix, status: 'succeeded' };
    else if (u.pathname.includes('/checkout/openai_llc/'))
      data = {
        checkout_session: { id: 'oaics_demo' + suffix, status: 'complete', payment_status: 'paid' },
      };
    else if (u.pathname.endsWith('/subscriptions/cancel')) {
      this.willRenew = false;
      data = { success: true };
    } else if (u.pathname.endsWith('/subscriptions')) data = { will_renew: this.willRenew };
    else if (u.pathname.endsWith('/invoices'))
      data = { invoices: [{ hosted_invoice_url: 'https://example.com/demo-invoice/' + suffix }] };
    else data = { success: true };
    return { status: 200, headers: {}, body: JSON.stringify(data), data };
  }
  close() {}
}
