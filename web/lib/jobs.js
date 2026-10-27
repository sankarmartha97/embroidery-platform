// Job polling (04-api/conventions.md): poll GET /digitizing-jobs/{id} every 1–2 s, backing off
// to 5 s for long jobs.

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Delay before poll number `n` (0-based): 1 s × 5, then 2 s × 10, then 5 s. */
export function pollDelay(n) {
  if (n < 5) return 1000;
  if (n < 15) return 2000;
  return 5000;
}

/**
 * Polls until the job finishes or `signal` aborts. Calls onUpdate with every job state.
 * @returns {Promise<object>} the final job
 */
export async function pollJob(
  jobId,
  { getJob, onUpdate = () => {}, signal, sleep = defaultSleep },
) {
  for (let n = 0; ; n++) {
    const job = await getJob(jobId);
    onUpdate(job);
    if (TERMINAL.has(job.status)) return job;
    await sleep(pollDelay(n), signal);
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
