export type SentinelFlow = 'chatgpt_checkout' | 'checkout_session_approval';
export type SentinelRequest = {
  flow: SentinelFlow;
  observerFlow: 'chatgpt_checkout';
  pageUrl: string;
  deviceId: string;
  environmentId: string;
  accountId?: string;
};
export type SentinelAuthorization = SentinelRequest & {
  token: string;
  soToken?: string;
  soRequired?: boolean;
  issuedAt: string;
  expiresAt: string;
  runtime?: 'reference' | 'official';
  sdkVersion?: string;
};
export type SentinelAuthorizer = (request: SentinelRequest) => Promise<SentinelAuthorization>;
