import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import * as Cfn from "@aws-sdk/client-cloudformation";
import { StackSim } from "../src/server.js";

test("ingestion CloudFormation provisions dependencies, updates, replaces and retains pipeline generations", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-cfn-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let cfn: Cfn.CloudFormationClient | undefined;
  const template = (revision: number) => JSON.stringify({ Resources: {
    Sink: { Type: "AWS::OpenSearchService::Domain", Properties: { DomainName: "cfn-ingestion-sink" } },
    Role: { Type: "AWS::IAM::Role", Properties: { RoleName: "CfnPipelineRole", AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } }, ArnLike: { "aws:SourceArn": { "Fn::Sub": "arn:aws:osis:${AWS::Region}:${AWS::AccountId}:pipeline/cfn-*" } } } }] }, Policies: [{ PolicyName: "sink", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:DescribeDomain", Resource: { "Fn::GetAtt": ["Sink", "Arn"] } }, { Effect: "Allow", Action: "es:ESHttpPut", Resource: { "Fn::Sub": "${Sink.Arn}/logs/*" } }] } }] } },
    LogGroup: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: "/aws/vendedlogs/OpenSearchIngestion/cfn" } },
    LogPolicy: { Type: "AWS::Logs::ResourcePolicy", DependsOn: "LogGroup", Properties: { PolicyName: "cfn-pipeline", PolicyDocument: { "Fn::Sub": JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/vendedlogs/OpenSearchIngestion/cfn:*" }] }) } } },
    Pipeline: { Type: "AWS::OSIS::Pipeline", DependsOn: "LogPolicy", ...(revision > 2 ? { DeletionPolicy: "Retain" } : {}), Properties: { PipelineName: revision > 2 ? "cfn-replacement" : "cfn-ingestion", MinUnits: 1, MaxUnits: revision === 1 ? 1 : 2, LogPublishingOptions: { IsLoggingEnabled: revision === 1, CloudWatchLogDestination: { LogGroup: { Ref: "LogGroup" } } }, BufferOptions: { PersistentBufferEnabled: true }, PipelineRoleArn: { "Fn::GetAtt": ["Role", "Arn"] }, PipelineConfigurationBody: { "Fn::Sub": JSON.stringify({ version: "2", logs: { source: { http: { path: "/logs/ingest" } }, sink: [{ opensearch: { hosts: ["https://${Sink.DomainEndpoint}"], aws: { region: "${AWS::Region}", sts_role_arn: "${Role.Arn}" }, index: "logs" } }] } }) }, Tags: [{ Key: "revision", Value: String(revision) }] } },
  }, Outputs: { PipelineRef: { Value: { Ref: "Pipeline" } }, Arn: { Value: { "Fn::GetAtt": ["Pipeline", "PipelineArn"] } }, Endpoint: { Value: { "Fn::Select": [0, { "Fn::GetAtt": ["Pipeline", "IngestEndpointUrls"] }] } } } });
  try {
    await sim.start(); cfn = new Cfn.CloudFormationClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    const wait = async (status: string) => { for (let i = 0; i < 400; i++) { const stack = (await cfn!.send(new Cfn.DescribeStacksCommand({ StackName: "pipeline-stack" }))).Stacks![0]; if (stack.StackStatus === status) return Object.fromEntries(stack.Outputs!.map(output => [output.OutputKey!, output.OutputValue!])); if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(20); } throw new Error(`Stack did not reach ${status}`); };
    await cfn.send(new Cfn.CreateStackCommand({ StackName: "pipeline-stack", TemplateBody: template(1), Capabilities: ["CAPABILITY_NAMED_IAM"] })); const first = await wait("CREATE_COMPLETE");
    assert.equal(first.PipelineRef, "cfn-ingestion"); assert.match(first.Arn, /:pipeline\/cfn-ingestion$/); assert.match(first.Endpoint, /^127\.0\.0\.1:\d+$/); assert.equal(sim.opensearch.ingestion.pipeline(region, "cfn-ingestion").tags["aws:cloudformation:logical-id"], "Pipeline");
    const logs = new Logs.CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    try { assert.ok((await logs.send(new Logs.FilterLogEventsCommand({ logGroupName: "/aws/vendedlogs/OpenSearchIngestion/cfn" }))).events!.some(event => JSON.parse(event.message!).event === "pipeline_state")); } finally { logs.destroy(); }
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: "pipeline-stack", TemplateBody: template(2), Capabilities: ["CAPABILITY_NAMED_IAM"] })); const second = await wait("UPDATE_COMPLETE");
    assert.equal(sim.opensearch.ingestion.pipeline(region, "cfn-ingestion").logPublishingOptions?.IsLoggingEnabled, false);
    assert.equal(first.Endpoint, second.Endpoint); assert.equal(sim.opensearch.ingestion.pipeline(region, "cfn-ingestion").maxUnits, 2); assert.equal(sim.opensearch.ingestion.pipeline(region, "cfn-ingestion").tags.revision, "2");
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: "pipeline-stack", TemplateBody: template(3), Capabilities: ["CAPABILITY_NAMED_IAM"] })); const third = await wait("UPDATE_COMPLETE"); assert.notEqual(third.Endpoint, first.Endpoint); assert.throws(() => sim.opensearch.ingestion.pipeline(region, "cfn-ingestion"), { code: "ResourceNotFoundException" });
    await cfn.send(new Cfn.DeleteStackCommand({ StackName: "pipeline-stack" }));
    for (let i = 0; i < 400 && sim.opensearch.ingestion.pipeline(region, "cfn-replacement").owner; i++) await delay(20);
    assert.equal(sim.opensearch.ingestion.pipeline(region, "cfn-replacement").owner, undefined);
  } finally { cfn?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("the CDK ingestion example deploys and its signed client finds transformed documents", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-example-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let cfn: Cfn.CloudFormationClient | undefined;
  try {
    await sim.start();
    await promisify(execFile)(process.execPath, ["--import", "tsx", join(process.cwd(), "examples/opensearch-ingestion/app.ts")], { env: { ...process.env, CDK_OUTDIR: join(root, "cdk"), CDK_DEFAULT_REGION: region, CDK_DEFAULT_ACCOUNT: sim.store.accountId }, timeout: 20000 });
    cfn = new Cfn.CloudFormationClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    await cfn.send(new Cfn.CreateStackCommand({ StackName: "SearchIngestion", TemplateBody: await readFile(join(root, "cdk", "SearchIngestion.template.json"), "utf8"), Capabilities: ["CAPABILITY_NAMED_IAM"] }));
    let outputs: Record<string, string> | undefined;
    for (let i = 0; i < 500; i++) {
      const stack = (await cfn.send(new Cfn.DescribeStacksCommand({ StackName: "SearchIngestion" }))).Stacks![0];
      if (stack.StackStatus === "CREATE_COMPLETE") { outputs = Object.fromEntries(stack.Outputs!.map(output => [output.OutputKey!, output.OutputValue!])); break; }
      if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`);
      await delay(20);
    }
    assert.ok(outputs, "The example stack must stabilize");
    const result = await promisify(execFile)(process.execPath, [join(process.cwd(), "examples/opensearch-ingestion/ingest.mjs")], { env: { ...process.env, INGESTION_ENDPOINT: `https://${outputs.IngestionEndpoint}`, OPENSEARCH_ENDPOINT: `https://${outputs.SearchEndpoint}`, AWS_CA_BUNDLE: sim.opensearch.diagnostics(region).caCertificatePath, AWS_REGION: region, AWS_ACCESS_KEY_ID: "admin", AWS_SECRET_ACCESS_KEY: "password", AWS_SESSION_TOKEN: "" }, timeout: 35000 });
    const found = JSON.parse(result.stdout).hits.hits; assert.equal(found.length, 1); assert.equal(found[0]._source.message, "Checkout completed"); assert.equal(found[0]._source.source, "http-pipeline"); assert.equal(found[0]._source.secret, undefined);
    await cfn.send(new Cfn.DeleteStackCommand({ StackName: "SearchIngestion" }));
    for (let i = 0; i < 500 && Object.keys(sim.opensearch.ingestion.state(region).pipelines).length; i++) await delay(20);
    assert.deepEqual(sim.opensearch.ingestion.state(region).pipelines, {});
  } finally { cfn?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
