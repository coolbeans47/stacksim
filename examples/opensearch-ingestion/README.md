# HTTP ingestion into search

This example deploys an encrypted search domain, a pipeline role with scoped
trust/permissions, a retained S3 failure bucket, and an embedded OSIS pipeline.
It uses normal CDK resources and signed public data endpoints. No Docker or
Data Prepper process is needed.

Install repository dependencies and start StackSim with CDK bootstrap enabled.
Follow the [CDK endpoint setup](../../docs/cdk-guide.md), then run here:

```text
npx cdk deploy --outputs-file outputs.json
```

Set these variables with your shell's usual environment-variable syntax:

| Variable | Value |
| --- | --- |
| `INGESTION_ENDPOINT` | `https://` plus `SearchIngestion.IngestionEndpoint` |
| `OPENSEARCH_ENDPOINT` | `https://` plus `SearchIngestion.SearchEndpoint` |
| `AWS_CA_BUNDLE` | CA path shown in the pipeline console's Source endpoint card |
| `AWS_REGION` | Deployment Region (default `eu-west-1`) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Local producer/search credentials; development defaults are `admin` / `password` |

Run `node ingest.mjs`. The source call signs with `osis`; it requires
`osis:Ingest` on the pipeline ARN. The script waits for delivery, verifies numeric
conversion, enrichment and field removal, then queries the managed search sink
with `es`. Re-running upserts the two stable document IDs.

Use **OpenSearch → Ingestion pipelines → sample-search-ingestion** to inspect
buffer counts and change history. Removing the pipeline role's search grant
stops delivery; records remain buffered for bounded retries, then go to
`failed/` in the S3 bucket. Failed S3 authorization keeps records buffered.

`npx cdk destroy` deletes the pipeline, role and domain. The failure bucket is
retained so its records remain available; delete it separately when finished.
Delivery is at least once. See the [ingestion profile](../../docs/opensearch/os08-acceptance.md)
for capacity, supported YAML and failure boundaries.
