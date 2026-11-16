export const NODE_PROTOCOL_VERSION = 1;
export const NODE_REPOSITORY = 'ZenEcho/relay-node';
export type NodeAction = 'pause' | 'resume' | 'check_update' | 'cancel_update';
export type NodeUpdatePhase =
  | 'queued'
  | 'draining'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'current'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'cancelled';
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
  desiredState: 'running' | 'paused';
  update?: NodeUpdateStatus;
  command?: NodeCommand;
};

export type WorkerMetadata = {
  version: string;
  protocolVersion: number;
  platform: string;
  arch: string;
  transportReady: boolean;
  paymentRuntime: 'on_demand' | 'unavailable';
  inFlightCount: number;
  runtimeState: string;
};
