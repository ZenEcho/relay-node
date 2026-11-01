import type { NodeControl, NodeCommand } from "./node-control.js";
export const plans = [
  { id: "gpt_go", label: "Go", planName: "chatgptgoplan" },
  { id: "gpt_plus", label: "Plus", planName: "chatgptplusplan" },
  { id: "gpt_pro_5x", label: "Pro 5x", planName: "chatgptprolite" },
  { id: "gpt_pro_20x", label: "Pro 20x", planName: "chatgptpro" },
  { id: "gpt_pro_max", label: "Pro 500", planName: "chatgptpromax" },
] as const;
import { cdkCountryCurrencies } from "./cdk-regions.js";
export const demoCountries = [
  { code: "US", label: "美国", currency: "USD" },
  { code: "PH", label: "菲律宾", currency: "PHP" },
  { code: "EG", label: "埃及", currency: "EGP" },
  { code: "CL", label: "智利", currency: "CLP" },
] as const;
const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
export const countries = Object.entries(cdkCountryCurrencies).map(
  ([code, currency]) => ({
    code,
    currency,
    label: regionNames.of(code) || code,
  }),
);
export type Identity = {
  id: string;
  username: string;
  role?: string;
  enabled?: boolean;
  permissions: string[];
  canProcessOrders: boolean;
  canViewOrderCredentials: boolean;
  cdkOwners?: { id: string; username: string }[];
  cdkRedeemTypes?: { redeemType: string; redeemTypeLabel: string }[];
};
export type Tenant = {
  id: string;
  site: string;
  adminId: string;
  username: string;
  identity: Identity;
  tokenCipher: string;
  tokenHash: string;
  credentialVersion: number;
  authState: string;
  lastVerifiedAt: string;
};
export type Settings = {
  id: string;
  intakeEnabled: boolean;
  concurrency: number;
  orbitCard: {
    origin: string;
    apiKey: string;
    secret: string;
    productCode: string;
  };
  telegram: {
    token: string;
    chatId: string;
    enabled: boolean;
    events: string[];
  };
  billing: Record<string, Billing>;
  paymentEnabled: boolean;
  retry?: { maxRetries: number; delaySeconds: number };
};
export type Billing = {
  name: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};
export type Workflow = {
  id: string;
  name: string;
  enabled: boolean;
  plan: string;
  countries: string[];
  ownerIds: string[];
  redeemTypes: string[];
  concurrency: number;
  version: number;
  billingState?: string;
  proxyRuleId?: string | null;
  nodeIds?: string[];
  funding: {
    autoCreate: boolean;
    autoRecharge: boolean;
    amount: string;
    mode?: "fixed" | "remote";
    paymentCount?: number;
    surplus?: string;
    productCode?: string;
    cardId?: number | null;
    cardIds?: number[];
    cardFilter?: CardFilter;
    reference?: FundingReference;
  };
  cleanup: { refresh: boolean; cancel: boolean; invoices: boolean };
};
export type FundingReference = {
  plan: string;
  productCode: string;
  currency: "USD";
  amount: string;
  source: string;
  observedAt?: string;
  importedAt: string;
};
export type ProxyRule = {
  id: string;
  name: string;
  country: string;
  cdkCode: string;
  redeemType: string;
  enabled: boolean;
  urls: string[];
  cursor: number;
  mode?: "account" | "api";
  apiCipher?: string;
  api?: ProxyApiConfig;
  regionMap?: Record<string, string>;
};
export type ProxyApiConfig = {
  url: string;
  format: "auto" | "text" | "json";
  protocol: "http" | "https" | "socks5" | "socks5h";
  username: string;
  password: string;
  jsonPath: string;
};
export type Node = {
  id: string;
  name: string;
  keyHash: string;
  enabled: boolean;
  concurrency: number;
  maxResident: number;
  maxWaiting: number;
  lastSeenAt: string | null;
  version?: string;
  transportReady: boolean;
  allowedPlans?: string[];
  protocolVersion?: number;
  platform?: string;
  arch?: string;
  inFlightCount?: number;
  runtimeState?: string;
  control?: NodeControl;
};
export type CdkOrder = {
  id: string;
  orderNo: string;
  cdkCode?: string;
  cdkRedeemType: string;
  cdkOwnerAdminId?: string;
  cdkOwnerUsername?: string;
  cdkPaymentCountry?: string;
  cdkPaymentCurrency?: string;
  status: string;
  accountName?: string;
  [key: string]: unknown;
};
export type ObservedOrder = {
  id: string;
  order: CdkOrder;
  cdkCodeCipher?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  source: "listener" | "execution";
};
export type CdkOrderStatus = {
  id?: string;
  orderNo?: string;
  status: string;
  cdkCode?: string;
  submittedAt?: string;
};
export type OrderObservation = {
  id: string;
  orderId: string;
  at: string;
  source: "listener" | "execution";
  changedFields: string[];
  order: CdkOrder;
};
export type RunStatus =
  | "claiming"
  | "queued"
  | "running"
  | "paused"
  | "awaiting_captcha"
  | "pending_confirmation"
  | "completed"
  | "failed"
  | "stopped";
export type Cleanup = Record<
  string,
  { status: "pending" | "succeeded" | "failed" | "skipped"; error?: string }
>;
export type Environment = {
  id: string;
  profile: string;
  userAgent: string;
  headers: Record<string, string>;
  proxyUrl: string;
  networkMode?: "direct" | "proxy";
  country: string;
  deviceId: string;
  stripeIds: { guid: string; muid: string; sid: string };
  cookies: Cookie[];
};
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  expires?: number;
};
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
  originalSubscription?: Record<string, any>;
  [key: string]: any;
};
export type Run = {
  id: string;
  order: CdkOrder;
  workflow: Workflow;
  status: RunStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  nodeId: string | null;
  lastNodeId?: string;
  workerLease?: string;
  logLeases?: Record<string, string>;
  workerLeaseExpiresAt?: string;
  claimToken?: string;
  claimWorkerId?: string;
  claimExpiresAt?: string;
  heartbeatAt?: string;
  manualForce?: { requestId: string; requestedBy: string; requestedAt: string };
  supersededBy?: string;
  deliveryLease?: string;
  deliveryLeaseExpiresAt?: string;
  backendDeliveryError?: string;
  contextCipher?: string;
  orbitCardCipher?: string;
  paymentSubmitted: boolean;
  paymentOutcome: "unsubmitted" | "unknown" | "succeeded" | "failed";
  dispatches: Record<string, string>;
  cardId?: number;
  cardLastFour?: string;
  proxyRuleId?: string;
  proxyDisplay?: string;
  exitIp?: string;
  exitCountry?: string;
  error?: string;
  nextCheckAt?: string;
  challengeId?: string;
  cleanup: Cleanup;
  backendCompletionPending?: boolean;
  backendFailurePending?: boolean;
  resultPending?: boolean;
  resultRequestId?: string;
  stopping?: boolean;
  assignedCardId?: number;
  environmentId?: string;
  transportProfile?: string;
  deviceId?: string;
  cleanupAttempts?: number;
  resultDigest?: string;
  backendCompleted?: boolean;
  deliveryRetryAt?: string;
  fundingQuote?: FundingQuote;
  attempt?: number;
  retryLimit?: number;
  retryOf?: string;
  retryRootId?: string;
  retryAt?: string;
  retryCount?: number;
  executionExhausted?: boolean;
  backendFailed?: boolean;
};
export type FundingQuote = {
  mode: "fixed" | "remote";
  plan: string;
  productCode: string;
  currency: "USD";
  unitAmount: string;
  paymentCount: number;
  surplus: string;
  requiredAmount: string;
  openingAmount: string;
  calculatedAmount: string;
  minInitialAmount: string;
  source?: string;
  observedAt?: string;
};
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
  source?: "controller" | "worker";
  category?: "http" | "operation" | "event";
  startedAt?: string;
  completedAt?: string;
  errorDetail?: unknown;
  nodeId?: string;
  orderId?: string;
};
export type CardOperation = {
  id: string;
  kind: "createCard" | "rechargeCard" | "deleteCard";
  status: string;
  requestBody: string;
  key: string;
  createdAt: string;
  updatedAt: string;
  cardId?: number;
  runId?: string;
  result?: Record<string, any>;
  error?: string;
  nextCheckAt?: string;
  inFlightUntil?: string;
  providerCipher?: string;
  allocationReady?: boolean;
};
export type CardLease = {
  id: string;
  reservationId?: string;
  cardId: number;
  runId: string;
  status: string;
  purpose?: "payment" | "replacement";
  amount?: string;
  debitRecorded?: boolean;
  debitOutcome?: "unknown" | "succeeded" | "failed";
  settling?: boolean;
  scope?: string;
};
export type CardFilter = {
  bin?: string;
  minBalance?: string;
  maxBalance?: string;
  hasNote?: boolean;
  note?: string;
};
export type CardMetadata = {
  id: string;
  note: string;
  updatedAt: string;
};
export type CardView = {
  cardId: number;
  lastFour: string;
  bin: string;
  productCode: string;
  currency: string;
  availableBalance: string;
  status: string;
  note: string;
  heldBy?: string;
  pendingOperation?: boolean;
  reservedAmount?: string;
  allocatableBalance?: string;
  pendingDebitAmount?: string;
  pendingPayments?: { runId: string; orderNo: string; amount: string }[];
  bindings?: {
    runId: string;
    orderNo: string;
    amount: string;
    settling: boolean;
  }[];
};
export type CardInventory = {
  id: string;
  loadedProducts: string[];
  providerCipher: string;
};
export type CardSnapshot = {
  id: string;
  scope: string;
  card: CardView;
  localBalance: string;
  revision: number;
  updatedAt: string;
  inRecentList?: boolean;
  refreshPending?: boolean;
  nextRefreshAt?: string;
};
export type Notification = {
  id: string;
  runId: string;
  event: string;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  message: string;
};
export type Entities = {
  nodeCommand: NodeCommand & { nodeId: string; requestId: string };
  cdkConnection: { id: string; origin: string };
  settings: Settings;
  workflow: Workflow;
  proxy: ProxyRule;
  node: Node;
  run: Run;
  observedOrder: ObservedOrder;
  orderObservation: OrderObservation;
  step: Step;
  auditCursor: { id: string; value: number };
  operation: CardOperation;
  cardLease: CardLease;
  cardMetadata: CardMetadata;
  cardSnapshot: CardSnapshot;
  cardInventory: CardInventory;
  billingPool: {
    id: string;
    ready: Omit<Billing, "name" | "email">[];
    recent: string[];
    fillingUntil?: string;
    fillToken?: string;
    retryAt?: string;
    error?: string;
  };
  billingAssignment: {
    id: string;
    cipher: string;
    state: string;
    source: "generated" | "fallback";
  };
  notification: Notification;
};
export type Kind = keyof Entities;
export const defaults = (): Settings => ({
  id: "main",
  intakeEnabled: false,
  concurrency: 4,
  paymentEnabled: false,
  retry: { maxRetries: 2, delaySeconds: 10 },
  orbitCard: {
    origin: "https://orbitcard.cc",
    apiKey: "",
    secret: "",
    productCode: "",
  },
  telegram: {
    token: "",
    chatId: "",
    enabled: false,
    events: [
      "completed",
      "failed",
      "awaiting_captcha",
      "pending_confirmation",
      "cleanup_failed",
      "node_offline",
      "auth_required",
    ],
  },
  billing: {},
});
export const terminal = (run: Run) =>
  ["completed", "failed", "stopped"].includes(run.status);
export const active = (run: Run) =>
  ["claiming", "queued", "running"].includes(run.status);
export const now = () => new Date().toISOString();
