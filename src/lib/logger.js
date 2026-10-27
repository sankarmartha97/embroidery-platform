import pino from 'pino';
import { env } from '../config/env.js';

// Never log tokens, signed URLs, document bodies or secrets.
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'embroidery-platform' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.password',
      '*.signedUrl',
      '*.document',
    ],
    censor: '[redacted]',
  },
});
