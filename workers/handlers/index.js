// Message type → handler. `job.queued` is enqueued through the outbox with the job row
// (ADR-0002); the runner does the per-type work in ./digitize.js, ./simulate.js, ./validate.js
// and ./export.js.

export function createHandlers({ engine, runner }) {
  return {
    async 'system.ping'(message, { log }) {
      log.info({ engine: engine.describe() }, 'ping received');
    },

    async 'job.queued'(message, context) {
      await runner.run(message.payload.jobId, context);
    },
  };
}
