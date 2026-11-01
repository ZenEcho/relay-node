import type { Node, Run, CardOperation } from "./domain.js";

export const NODE_PROTOCOL_VERSION = 1;
export const NODE_REPOSITORY = "ZenEcho/relay-node";
export type NodeAction = "pause" | "resume" | "check_update" | "cancel_update";
export type NodeUpdatePhase =
  | "queued"
  | "draining"
  | "checking"
  | "downloading"
  | "installing"
  | "restarting"
  | "current"
  | "completed"
  | "failed"
  | "rolled_back"
  | "cancelled";
export type NodeUpdateStatus = {
  id: string;
  phase: NodeUpdatePhase;
  requestedAt: string;
  updatedAt: string;
  version?: string;
  previousVersion?: string;
  error?: string;
};
export type NodeCommand = {
  id: string;
  action: NodeAction;
  revision: number;
  at: string;
};
export type NodeControl = {
  drainOrderIds?: string[];
  revision: number;
  desiredState: "running" | "paused";
  update?: NodeUpdateStatus;
  command?: NodeCommand;
};
export const updateActive = (update?: NodeUpdateStatus) =>
  !!update &&
  [
    "queued",
    "draining",
    "checking",
    "downloading",
    "installing",
    "restarting",
  ].includes(update.phase);
export const nodeControl = (node: Node): NodeControl =>
  node.control || { revision: 0, desiredState: "running" };
export function nodeAcceptsNew(node: Node, time = Date.now()) {
  return !!(
    node.enabled &&
    node.transportReady &&
    node.lastSeenAt &&
    time - Date.parse(node.lastSeenAt) < 45000 &&
    nodeControl(node).desiredState === "running" &&
    !updateActive(node.control?.update) &&
    (node.protocolVersion === undefined ||
      node.protocolVersion === NODE_PROTOCOL_VERSION)
  );
}
export function nodeOwnsRun(nodeId: string, run: Run, runs: Run[]) {
  if (run.nodeId || run.lastNodeId)
    return (run.nodeId || run.lastNodeId) === nodeId;
  const seen = new Set<string>();
  let parent = run.retryOf;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const old = runs.find((r) => r.id === parent);
    if (!old) break;
    if (old.nodeId || old.lastNodeId)
      return (old.nodeId || old.lastNodeId) === nodeId;
    parent = old.retryOf;
  }
  return false;
}
export function unfinishedRun(
  run: Run,
  operations: CardOperation[] = [],
  time = Date.now(),
) {
  if (run.supersededBy) return false;
  return (
    !["completed", "failed", "stopped"].includes(run.status) ||
    run.paymentOutcome === "unknown" ||
    !!run.retryAt ||
    ["post_payment", "cleanup_retry"].includes(run.stage) ||
    !!(
      run.resultPending ||
      run.backendCompletionPending ||
      run.backendFailurePending
    ) ||
    (Date.parse(run.workerLeaseExpiresAt || "") > time && !!run.workerLease) ||
    (Date.parse(run.deliveryLeaseExpiresAt || "") > time &&
      !!run.deliveryLease) ||
    operations.some((op) => op.runId === run.id && op.status === "pending")
  );
}
export function nodeBlockers(
  nodeId: string,
  runs: Run[],
  operations: CardOperation[] = [],
  drainOrderIds: string[] = [],
) {
  return runs
    .filter(
      (run) =>
        (nodeOwnsRun(nodeId, run, runs) ||
          drainOrderIds.includes(run.order.id)) &&
        unfinishedRun(run, operations),
    )
    .map((run) => ({
      id: run.id,
      orderNo: run.order.orderNo,
      status: run.status,
      stage: run.stage,
    }));
}
