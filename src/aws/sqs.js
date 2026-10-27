import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../config/env.js';

export function createSqsClient() {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  });
}

export const QUEUE_URLS = Object.freeze({
  'emb-jobs': env.SQS_QUEUE_URL_EMB_JOBS,
});
