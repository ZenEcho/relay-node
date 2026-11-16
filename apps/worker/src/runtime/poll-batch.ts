// Bound each burst so pause/update commands and heartbeats remain responsive.
export async function pollBatch<T>(
  poll: () => Promise<T | null>,
  launch: (assignment: T) => void,
  running: () => boolean,
  batchSize = 20,
) {
  for (let i = 0; i < batchSize && running(); i++) {
    const assignment = await poll();
    if (!assignment) return;
    launch(assignment);
  }
}
