# Lambda and CloudWatch Logs producers

This CDK example creates a managed embedded domain, a product Lambda, a Logs
transformer, a source log group/subscription and an SQS queue for failed log
batches. Both handlers discover the endpoint using their execution role and use
the official OpenSearch client with SigV4. The build bundles all dependencies
with esbuild on the host; Docker is not required.

Install the repository dependencies and start StackSim with the normal CDK
bootstrap. Follow the [CDK endpoint setup](../../docs/cdk-guide.md). Set
`AWS_CA_BUNDLE` to the CA certificate path shown by the OpenSearch capabilities
API, using your shell's environment-variable syntax. This **public certificate**
is included in the functions' environment; no CA private key or IAM credentials
are packaged. Then, from this directory:

```text
npx cdk deploy --outputs-file outputs.json
```

Invoke the `ProductFunction` output with any of these JSON events through the
Lambda console or SDK:

```json
{"operation":"put","id":"shoe-red","document":{"title":"Red leather shoes","price":45}}
```

```json
{"operation":"search","text":"leather"}
```

```json
{"operation":"get","id":"shoe-red"}
```

```json
{"operation":"delete","id":"shoe-red"}
```

The product role can describe this domain and access only `/products/*`. Writes
refresh immediately. FGAC, if enabled separately, also needs a role mapping for
the function role; IAM permission alone cannot bypass it.

In **CloudWatch → Log groups**, open `SourceLogGroup`, create a log stream and
append events. Its subscription invokes `LogsFunction`. The transformer decodes
the real base64/gzip Logs envelope and upserts `logs-YYYY.MM.DD` indexes using UTC
event dates. Documents retain message, timestamp, owner, group, stream and event
ID. Message text is not executed or dynamically mapped as JSON. The function
uses index-scoped bulk requests; its role grants `es:ESHttpPut` only on
`/logs-*/*` (the pinned JavaScript client's index-scoped bulk method is PUT).

Use the OpenSearch local query tool to POST `/logs-*/_search` with `{}` after the
normal refresh interval, or explicitly POST `/logs-*/_refresh`. The same index
can be queried with any authorized public OpenSearch client.

Delivery uses the existing Logs subscription checkpoint and Lambda asynchronous
retry queue. Failed HTTP responses **and failed bulk items** throw, so they do
not become successful invocations. Retries upsert stable IDs derived from the
source group, stream and event ID. This is at-least-once delivery; records already
indexed in a partially successful batch can be written again. After Lambda's
retry limit, failed batches go to `FailedLogBatches`. Inspect that SQS queue and
the function's Logs group before replaying a failed batch.

Limits: 10 MiB expanded envelope, 10,000 events, 256 KiB per message, and bulk
chunks of at most 500 records / 5 MiB. CONTROL_MESSAGE envelopes are ignored.
Malformed inputs fail before indexing. Index/storage limits of the embedded
domain still apply. The example uses the supported same-account/Region public
endpoint profile; it does not implement a new Logs destination ARN, VPC routing,
Serverless ingestion or direct CloudWatch integrations APIs.

`npx cdk destroy` removes these resources, including the domain documents and
failed-batch queue. CloudWatch-created Lambda log groups may remain under their
normal retention policy.
