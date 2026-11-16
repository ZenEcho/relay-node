import type {
  Assignment,
  Control,
  RuntimeContext,
} from '../../../../packages/contracts/src/execution.js';
import type { AuditEntry } from '../../../../packages/runtime/src/audit.js';
import type { HttpInput, HttpOutput } from '../transport/native.js';
import type { SentinelFlow } from '../../../../packages/contracts/src/sentinel.js';
export type ExecutionServices = {
  assignment: Assignment;
  context: RuntimeContext;
  command: Control['request'];
  log(entry: AuditEntry): Promise<void>;
  checkpoint(stage: string): Promise<void>;
  request(name: string, input: HttpInput): Promise<HttpOutput>;
  chat(
    name: string,
    path: string,
    body?: Record<string, any>,
    extraHeaders?: Record<string, string>,
  ): Promise<any>;
  stripe(name: string, path: string, body?: Record<string, any>): Promise<any>;
  requireSentinel(flow: SentinelFlow): Promise<void>;
  acknowledgeVerification(): Promise<void>;
  handleIntent(): Promise<void>;
  park(status: string, error?: string): Promise<void>;
  success(): Promise<void>;
};
