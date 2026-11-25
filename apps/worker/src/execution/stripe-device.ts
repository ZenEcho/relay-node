import type { ExecutionServices } from './services.js';

// m.stripe.com mints the identifiers Stripe.js normally writes into
// __stripe_mid/__stripe_sid. The response is server-generated, so a payment
// method built from it names a device Stripe actually issued instead of a UUID
// nobody has ever seen. The body carries no fingerprint and is accepted anyway;
// the endpoint answers even to an empty object.
const DEVICE_ENDPOINT = 'https://m.stripe.com/6';
// Observed shape: canonical UUID plus an 8-hex suffix (44 characters).
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[0-9a-f]{0,24}$/i;

export async function issueStripeDevice(services: ExecutionServices) {
  const context = services.context;
  if (context.stripeDevice) return context.stripeDevice;
  // Demo runs have no upstream; the placeholder identity stays in place.
  if (services.assignment.demo) return;
  let payload: any;
  try {
    const response = await services.request('取得 Stripe 设备标识', {
      method: 'POST',
      url: DEVICE_ENDPOINT,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://js.stripe.com',
        referer: 'https://js.stripe.com/',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
      body: '{}',
    });
    payload = response.data;
  } catch (error) {
    await services.log({
      name: '登记本单 Stripe 设备',
      status: 'failed',
      category: 'event',
      response: { registered: false },
      error: '未能向 m.stripe.com 登记本单设备，付款将使用环境内置标识',
    });
    return;
  }
  const device = {
    muid: String(payload?.muid ?? ''),
    guid: String(payload?.guid ?? ''),
    sid: String(payload?.sid ?? ''),
  };
  if (![device.muid, device.guid, device.sid].every((id) => DEVICE_ID.test(id))) {
    await services.log({
      name: '登记本单 Stripe 设备',
      status: 'failed',
      category: 'event',
      response: { registered: false },
      error: 'm.stripe.com 未返回有效的设备标识，付款将使用环境内置标识',
    });
    return;
  }
  context.stripeDevice = device;
  await services.log({
    name: '登记本单 Stripe 设备',
    status: 'succeeded',
    category: 'event',
    response: { registered: true },
  });
  return device;
}
