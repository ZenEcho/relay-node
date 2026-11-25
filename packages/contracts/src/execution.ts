export type BillingEmailProvider = 'chatgpt' | 'grok';
export type BillingEmailBinding = {
  provider: BillingEmailProvider;
  email: string;
  source: 'session' | 'request' | 'default' | 'none';
};

export type Billing = {
  name: string;
  email?: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};
export type Cleanup = Record<
  string,
  { status: 'pending' | 'succeeded' | 'failed' | 'skipped'; error?: string }
>;
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
};
export type Environment = {
  id: string;
  profile: string;
  userAgent: string;
  headers: Record<string, string>;
  proxyUrl: string;
  networkMode?: 'direct' | 'proxy';
  country: string;
  deviceId: string;
  stripeIds: { guid: string; muid: string; sid: string };
  cookies: Cookie[];
};
// This is the per-execution checkpoint, never a console database record.
export type RuntimeContext = {
  environment: Environment;
  credential?: string;
  accountId?: string;
  userId?: string;
  checkout?: Record<string, any>;
  intent?: Record<string, any>;
  paymentPage?: Record<string, any>;
  key?: string;
  confirmationToken?: string;
  session?: Record<string, any>;
  phase?: string;
  challenge?: Record<string, any>;
  cleanup?: Cleanup;
  billingExternalUrls?: string[];
  renewalStatus?: string;
  latestSession?: string;
  proxyVerified?: boolean;
  exitIp?: string;
  exitCountry?: string;
  exitFingerprint?: string;
  exitProbe?: {
    observedAt: string;
    source: 'ipapi.co' | 'chatgpt.com';
    simulated: boolean;
  };
  originalSubscription?: Record<string, any>;
  // Device identity minted by m.stripe.com through the order's own exit. It is
  // absent until the node registers it, and then it outranks the placeholder
  // UUIDs baked into the environment at creation time.
  stripeDevice?: { muid: string; guid: string; sid: string };
  billing?: Billing | null;
  billingEmailBinding?: BillingEmailBinding;
  checkoutResume?: {
    sourceRunId: string;
    checkoutId: string;
    kind: 'card_replacement' | 'prepayment_retry';
    intentId?: string;
  };
  [key: string]: any;
};
export type ExecutionSnapshot = {
  id: string;
  workerLease: string;
  paymentSubmitted: boolean;
  challengeId?: string;
  dispatches: Record<string, string>;
  executionExhausted?: boolean;
  order: { cdkPaymentCurrency?: string };
  workflow: {
    plan: string;
    checkoutMode?: 'custom' | 'hosted';
    billingCountry?: string;
    cleanup: { refresh: boolean; cancel: boolean; invoices: boolean };
  };
};
export type ExecutionAssignment = {
  run: ExecutionSnapshot;
  context: RuntimeContext;
  mode: 'execute' | 'reconcile' | 'cleanup';
  billing?: Billing;
  paymentEnabled: boolean;
  demo: boolean;
};
export type Assignment = ExecutionAssignment;
export interface Control {
  signal?: AbortSignal;
  assertActive?(stage?: string): Promise<void>;
  request(action: string, body?: any): Promise<any>;
}
export type Step = {
  id: string;
  ordinal?: number;
  runId: string;
  name: string;
  status: string;
  at: string;
  request?: unknown;
  response?: unknown;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  traceId?: string;
  source?: 'controller' | 'worker';
  category?: 'http' | 'operation' | 'event';
  startedAt?: string;
  completedAt?: string;
  errorDetail?: unknown;
  nodeId?: string;
  orderId?: string;
};
