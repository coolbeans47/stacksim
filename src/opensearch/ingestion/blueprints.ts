export const HTTP_BLUEPRINT = {
  BlueprintName: "stacksim-http-to-opensearch",
  DisplayName: "HTTP events to embedded OpenSearch",
  DisplayDescription: "Signed JSON-array ingestion, field enrichment and authorized delivery. Replace the sink endpoint and role before creating the pipeline.",
  Service: "OpenSearch", UseCase: "Log analytics",
};
export const HTTP_BLUEPRINT_CONFIG = {
  version: "2",
  logs: {
    source: { http: { path: "/logs/ingest" } },
    processor: [{ add_entries: { entries: [{ key: "ingestion_source", value: "http" }] } }],
    sink: [{ opensearch: { hosts: ["https://replace-with-collection-or-domain-endpoint"], aws: { region: "eu-west-1", sts_role_arn: "arn:aws:iam::000000000000:role/ReplaceWithPipelineRole" }, index: "logs" } }],
  },
};
// JSON is a YAML-compatible document; this variant presents conventional YAML.
export const HTTP_BLUEPRINT_YAML = `version: "2"
logs:
  source:
    http:
      path: /logs/ingest
  processor:
    - add_entries:
        entries:
          - key: ingestion_source
            value: http
  sink:
    - opensearch:
        hosts: ["https://replace-with-collection-or-domain-endpoint"]
        aws:
          region: eu-west-1
          sts_role_arn: arn:aws:iam::000000000000:role/ReplaceWithPipelineRole
        index: logs
`;

export const S3_BLUEPRINT = { BlueprintName: 'stacksim-s3-scan-to-opensearch', DisplayName: 'S3 scan to embedded OpenSearch', DisplayDescription: 'One-time NDJSON scan with encrypted checkpoints and end-to-end acknowledgments. Replace the bucket, endpoint, Region and pipeline role.', Service: 'OpenSearch', UseCase: 'Data migration' };
export const S3_BLUEPRINT_CONFIG = {
  version: '2', scan: {
    source: { s3: { aws: { region: 'eu-west-1', sts_role_arn: 'arn:aws:iam::000000000000:role/ReplaceWithPipelineRole' }, acknowledgments: true, codec: { ndjson: {} }, compression: 'none', scan: { buckets: [{ bucket: { name: 'replace-with-source-bucket', filter: { include_prefix: ['events/'] } } }] } } },
    sink: [{ opensearch: { hosts: ['https://replace-with-collection-or-domain-endpoint'], aws: { region: 'eu-west-1', sts_role_arn: 'arn:aws:iam::000000000000:role/ReplaceWithPipelineRole' }, index: 'imported', document_id: '${/id}' } }],
  },
};
export const S3_BLUEPRINT_YAML = `version: "2"
scan:
  source:
    s3:
      aws:
        region: eu-west-1
        sts_role_arn: arn:aws:iam::000000000000:role/ReplaceWithPipelineRole
      acknowledgments: true
      codec:
        ndjson: {}
      compression: none
      scan:
        buckets:
          - bucket:
              name: replace-with-source-bucket
              filter:
                include_prefix: ["events/"]
  sink:
    - opensearch:
        hosts: ["https://replace-with-collection-or-domain-endpoint"]
        aws:
          region: eu-west-1
          sts_role_arn: arn:aws:iam::000000000000:role/ReplaceWithPipelineRole
        index: imported
        document_id: "\${/id}"
`;

export const DYNAMO_BLUEPRINT = { BlueprintName: 'stacksim-dynamodb-stream-to-opensearch', DisplayName: 'DynamoDB changes to embedded OpenSearch', DisplayDescription: 'Stream-only change capture with durable checkpoints, deletes and external versions. Requires NEW_IMAGE or NEW_AND_OLD_IMAGES; use the snapshot blueprint to include existing items.', Service: 'OpenSearch', UseCase: 'Change data capture' };
export const DYNAMO_BLUEPRINT_CONFIG = {
  version: '2', changes: {
    source: { dynamodb: { aws: { region: 'eu-west-1', sts_role_arn: 'arn:aws:iam::000000000000:role/ReplaceWithPipelineRole' }, acknowledgments: true, tables: [{ table_arn: 'arn:aws:dynamodb:eu-west-1:000000000000:table/replace-with-table', stream: { start_position: 'LATEST' } }] } },
    sink: [{ opensearch: { hosts: ['https://replace-with-domain-endpoint'], aws: { region: 'eu-west-1', sts_role_arn: 'arn:aws:iam::000000000000:role/ReplaceWithPipelineRole' }, index: 'products', document_id: '${getMetadata("primary_key")}', action: '${getMetadata("opensearch_action")}', document_version: '${getMetadata("document_version")}', document_version_type: 'external' } }],
  },
};
export const DYNAMO_BLUEPRINT_YAML = `version: "2"
changes:
  source:
    dynamodb:
      aws:
        region: eu-west-1
        sts_role_arn: arn:aws:iam::000000000000:role/ReplaceWithPipelineRole
      acknowledgments: true
      tables:
        - table_arn: arn:aws:dynamodb:eu-west-1:000000000000:table/replace-with-table
          stream:
            start_position: LATEST
  sink:
    - opensearch:
        hosts: ["https://replace-with-domain-endpoint"]
        aws:
          region: eu-west-1
          sts_role_arn: arn:aws:iam::000000000000:role/ReplaceWithPipelineRole
        index: products
        document_id: '\${getMetadata("primary_key")}'
        action: '\${getMetadata("opensearch_action")}'
        document_version: '\${getMetadata("document_version")}'
        document_version_type: external
`;

export const DYNAMO_EXPORT_BLUEPRINT = { BlueprintName: 'stacksim-dynamodb-export-to-opensearch', DisplayName: 'DynamoDB snapshot and changes to embedded OpenSearch', DisplayDescription: 'Export an initial PITR snapshot to S3, then continue CDC from a durable pre-export position. Requires a source bucket, DynamoDB export bucket policy and pipeline role permissions.', Service: 'OpenSearch', UseCase: 'Initial load and change data capture' };
export const DYNAMO_EXPORT_BLUEPRINT_CONFIG = structuredClone(DYNAMO_BLUEPRINT_CONFIG);
Object.assign(DYNAMO_EXPORT_BLUEPRINT_CONFIG.changes.source.dynamodb.tables[0], { export: { s3_bucket: 'replace-with-export-bucket', s3_prefix: 'export/' } });
export const DYNAMO_EXPORT_BLUEPRINT_YAML = DYNAMO_BLUEPRINT_YAML.replace('          stream:', '          export:\n            s3_bucket: replace-with-export-bucket\n            s3_prefix: export/\n          stream:');
