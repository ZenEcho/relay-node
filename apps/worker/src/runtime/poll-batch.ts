const MAX_PENDING_POLLS = 3;

// Bound each burst so pause/update commands and heartbeats remain responsive.
export async function pollBatch<T>(
  poll: () => Promise<T | null>,
  launch: (assignment: T) => void,
  running: () => boolean,
  batchSize = 20,
) {
  let remaining = batchSize;
  let exhausted = false;
  const pollUntilIdle = async () => {
    try {
      while (!exhausted && remaining > 0 && running()) {
        remaining--;
        const assignment = await poll();
        if (assignment === null) {
          exhausted = true;
          return;
        }
        launch(assignment);
      }
    } catch (error) {
      exhausted = true;
      throw error;
    }
  };
  // Outstanding requests may already hold leases even after another poll stops the burst.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(MAX_PENDING_POLLS, batchSize) }, pollUntilIdle),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}
