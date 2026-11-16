import type { NodeUpdateStatus } from '../../contracts/src/node-control.js';
export const updateActive = (update?: NodeUpdateStatus) =>
  !!update &&
  ['queued', 'draining', 'checking', 'downloading', 'installing', 'restarting'].includes(
    update.phase,
  );
