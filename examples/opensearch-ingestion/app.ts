import { App, CfnOutput, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Domain, EngineVersion } from "aws-cdk-lib/aws-opensearchservice";
import { CfnPipeline } from "aws-cdk-lib/aws-osis";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "SearchIngestion", { env: { account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000", region: process.env.CDK_DEFAULT_REGION ?? "eu-west-1" } });
const pipelineName = "sample-search-ingestion";
const search = new Domain(stack, "Search", { version: EngineVersion.OPENSEARCH_2_19, capacity: { dataNodes: 1, dataNodeInstanceType: "r6gd.large.search" }, ebs: { enabled: false }, zoneAwareness: { enabled: false }, encryptionAtRest: { enabled: true }, nodeToNodeEncryption: false, enforceHttps: true, removalPolicy: RemovalPolicy.DESTROY });
const deadLetters = new Bucket(stack, "DeadLetters", { removalPolicy: RemovalPolicy.RETAIN });
const role = new Role(stack, "PipelineRole", { assumedBy: new ServicePrincipal("osis-pipelines.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account }, ArnEquals: { "aws:SourceArn": `arn:${stack.partition}:osis:${stack.region}:${stack.account}:pipeline/${pipelineName}` } } }) });
role.addToPolicy(new PolicyStatement({ actions: ["es:DescribeDomain"], resources: [search.domainArn] }));
role.addToPolicy(new PolicyStatement({ actions: ["es:ESHttpPut"], resources: [`${search.domainArn}/logs/*`] }));
role.addToPolicy(new PolicyStatement({ actions: ["s3:PutObject"], resources: [deadLetters.arnForObjects("failed/*")] }));
const pipeline = new CfnPipeline(stack, "Pipeline", { pipelineName, minUnits: 1, maxUnits: 2, bufferOptions: { persistentBufferEnabled: true }, pipelineRoleArn: role.roleArn, pipelineConfigurationBody: JSON.stringify({ version: "2", logs: {
  source: { http: { path: "/logs/ingest" } },
  processor: [{ convert_type: { key: "status", type: "integer" } }, { add_entries: { entries: [{ key: "source", value: "http-pipeline" }] } }, { delete_entries: { with_keys: ["secret"] } }],
  sink: [{ opensearch: { hosts: [`https://${search.domainEndpoint}`], aws: { region: stack.region, sts_role_arn: role.roleArn }, index: "logs", document_id: "${/id}", max_retries: 5, dlq: { s3: { bucket: deadLetters.bucketName, region: stack.region, key_path_prefix: "failed/" } } } }],
} }) });
pipeline.node.addDependency(role); pipeline.node.addDependency(deadLetters);
new CfnOutput(stack, "PipelineName", { value: pipeline.ref });
new CfnOutput(stack, "PipelineArn", { value: pipeline.attrPipelineArn });
new CfnOutput(stack, "IngestionEndpoint", { value: Fn.select(0, pipeline.attrIngestEndpointUrls) });
new CfnOutput(stack, "SearchEndpoint", { value: search.domainEndpoint });
new CfnOutput(stack, "DeadLetterBucket", { value: deadLetters.bucketName });
app.synth();
