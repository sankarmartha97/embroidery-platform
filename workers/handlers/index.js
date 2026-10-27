// Message type → handler. Job handlers (digitize, simulate, validate, export) arrive with the
// jobs API in sprint S3; until then only the smoke-test handler is registered.

export function createHandlers({ engine }) {
  return {
    async 'system.ping'(message, { log }) {
      log.info({ engine: engine.describe() }, 'ping received');
    },
  };
}
