// Adapter interface (05-digitizing-engine/adapter-interface.md). All methods run only in workers.
// Implementations live in workers/engines/<name>/. The engine choice is open until Gate 1 (ADR-0005).

export class EngineError extends Error {
  /** @param {string} code job error code from 05-digitizing-engine/validation-and-errors.md */
  constructor(code, message, { retryable = false, objectId } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = retryable;
    this.objectId = objectId;
  }
}

export class DigitizingEngine {
  /** @returns {{ name: string, version: string, formats: string[], stitchTypes: string[] }} */
  describe() {
    throw new Error('Not implemented');
  }

  /** document → engine-neutral stitch data */
  // eslint-disable-next-line no-unused-vars
  async generateStitches(document, { machineProfile, signal }) {
    throw new Error('Not implemented');
  }

  /** stitch data → preview frames / image */
  // eslint-disable-next-line no-unused-vars
  async renderSimulation(stitchData, { width, height, signal }) {
    throw new Error('Not implemented');
  }

  /** stitch data → { buffer, formatCode } */
  // eslint-disable-next-line no-unused-vars
  async exportMachineFile(stitchData, formatCode, machineProfile, { signal }) {
    throw new Error('Not implemented');
  }

  /** stitch data → { status: 'passed'|'warning'|'failed', issues: Issue[] } */
  // eslint-disable-next-line no-unused-vars
  async validate(stitchData, machineProfile, { signal }) {
    throw new Error('Not implemented');
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new EngineError('CANCELLED', 'Cancelled by user');
}
