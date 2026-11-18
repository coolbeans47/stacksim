# Product search

This example uses the ordinary CDK `Domain` construct and official OpenSearch
JavaScript client. Install dependencies from the repository root. Start StackSim
with its normal CDK bootstrap enabled. Follow the repository's
[CDK endpoint configuration](../../docs/cdk-guide.md), then run from this folder:

```text
npx cdk deploy --outputs-file outputs.json
```

Set these environment variables using your shell's normal syntax:

| Variable | Value |
| --- | --- |
| `OPENSEARCH_ENDPOINT` | `https://` followed by `ProductSearch.Endpoint` in `outputs.json` |
| `AWS_CA_BUNDLE` | The local CA path reported by the OpenSearch capabilities API |
| `AWS_REGION` | The deployment Region, normally `eu-west-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Local IAM credentials; default development credentials are `admin` / `password` |

Run `node search.mjs`. It creates a product index if missing, upserts three
stable document IDs, refreshes, and runs a full-text/filter/facet query. Re-run
it without duplicating the sample documents. Inspect the same documents using
the console's **OpenSearch → domain → Local query tool**.

`npx cdk destroy` deletes the domain and its documents. The compatibility
profile has one embedded node, no replicas and no EBS or provider-managed
encryption. The instance descriptor does not allocate AWS hardware. See the
[OpenSearch guide](../../docs/opensearch-console-guide.md) for its boundaries.
