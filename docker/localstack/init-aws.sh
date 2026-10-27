#!/bin/bash
# Creates local queues and buckets. Runs when LocalStack is ready.
set -euo pipefail
awslocal sqs create-queue --queue-name emb-jobs-dlq
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/emb-jobs-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
awslocal sqs create-queue --queue-name emb-jobs \
  --attributes "{\"VisibilityTimeout\":\"120\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
awslocal s3 mb s3://emb-artifacts-local
echo "LocalStack resources ready"
