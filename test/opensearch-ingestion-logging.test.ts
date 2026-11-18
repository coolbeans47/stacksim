import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import * as Osis from "@aws-sdk/client-osis";
import * as Iam from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> { for (let i = 0; i < 200; i++) { const value = await read(); if (check(value)) return value; await delay(10); } throw new Error("Pipeline/log state did not converge"); }
test("pipeline logs validate caller and service permissions, omit event contents, recover delivery and survive restart", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-logging-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, clock = new TestClock(Date.now());
  const options = { dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce" as const, cdkBootstrap: false, clock }; let sim = new StackSim(options);
  let osis: Osis.OSISClient | undefined, logs: Logs.CloudWatchLogsClient | undefined, iam: Iam.IAMClient | undefined, limited: Osis.OSISClient | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; osis = new Osis.OSISClient(sdk); logs = new Logs.CloudWatchLogsClient(sdk); iam = new Iam.IAMClient(sdk); return sdk; };
  try {
    await sim.start(); const sdk = connect(); const service = sim.opensearch.ingestion;
    await sim.opensearch.execute("CreateDomain", { DomainName: "logging-sink" }, region);
    const domain = await until(async () => sim.opensearch.domain(region, "logging-sink"), value => value.state === "active");
    const role = (await iam!.send(new Iam.CreateRoleCommand({ RoleName: "LoggingPipeline", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!;
    // Keep sink writes denied to produce real delivery errors.
    const configuration = JSON.stringify({ version: "2", logs: { source: { http: { path: "/ingest" } }, sink: [{ opensearch: { hosts: [`https://127.0.0.1:${domain.gatewayPort}`], aws: { region, sts_role_arn: role.Arn }, index: "records", max_retries: 0 } }] } });
    const group = "/aws/vendedlogs/OpenSearchIngestion/test", arn = `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}`;
    const input = { PipelineName: "logged-pipeline", MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: configuration, LogPublishingOptions: { IsLoggingEnabled: true, CloudWatchLogDestination: { LogGroup: group } } };
    await assert.rejects(osis!.send(new Osis.CreatePipelineCommand(input)), { name: "ValidationException" });
    await logs!.send(new Logs.CreateLogGroupCommand({ logGroupName: group }));
    await assert.rejects(osis!.send(new Osis.CreatePipelineCommand(input)), { name: "ValidationException" }); assert.equal(Object.keys(service.state(region).pipelines).length, 0);
    const policy = (effect = "Allow", account = sim.store.accountId) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: effect, Principal: { Service: "delivery.logs.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${arn}:*`, Condition: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": `arn:aws:logs:${region}:${sim.store.accountId}:*` } } }] });
    await logs!.send(new Logs.PutResourcePolicyCommand({ policyName: "pipeline", policyDocument: policy("Allow", "999999999999") }));
    await assert.rejects(osis!.send(new Osis.CreatePipelineCommand(input)), { name: "ValidationException" });
    await logs!.send(new Logs.PutResourcePolicyCommand({ policyName: "pipeline", policyDocument: policy() }));
    await iam!.send(new Iam.CreateUserCommand({ UserName: "pipeline-manager" }));
    await iam!.send(new Iam.PutUserPolicyCommand({ UserName: "pipeline-manager", PolicyName: "manage", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["osis:*", "iam:PassRole"], Resource: "*" }] }) }));
    const key = (await iam!.send(new Iam.CreateAccessKeyCommand({ UserName: "pipeline-manager" }))).AccessKey!;
    limited = new Osis.OSISClient({ ...sdk, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } });
    await assert.rejects(limited.send(new Osis.CreatePipelineCommand(input)), /logs:CreateLogDelivery/);
    await osis!.send(new Osis.CreatePipelineCommand(input));
    await until(async () => (await osis!.send(new Osis.GetPipelineCommand({ PipelineName: input.PipelineName }))).Pipeline!, value => value.Status === "ACTIVE");
    const pipeline = service.pipeline(region, input.PipelineName), user = sim.store.ensureAccount().iam.users.admin;
    const principal = { accountId: sim.store.accountId, principalArn: user.arn, principalId: user.userId, userId: user.userId, userName: "admin", accessKeyId: "admin", principalType: "user" as const };
    const events = async () => (await logs!.send(new Logs.FilterLogEventsCommand({ logGroupName: group }))).events!.map(event => JSON.parse(event.message!));
    const stats = () => (sim.opensearch.ingestion as any).buffers.get(pipeline.generation).stats();
    await until(events, value => value.some(event => event.event === "pipeline_state"));
    await service.ingest(region, pipeline.name, pipeline.accountId, principal, true, [{ secret: "sensitive-event-52f8" }]); clock.advance(1001);
    const failures = await until(events, value => value.some(event => event.event === "delivery_failed"));
    assert.ok(!JSON.stringify(failures).includes("sensitive-event")); assert.equal(failures.at(-1).level, "ERROR"); assert.equal(failures.at(-1).permanent, true); assert.equal(stats().failed, 1);
    await logs!.send(new Logs.PutResourcePolicyCommand({ policyName: "deny-pipeline", policyDocument: policy("Deny") }));
    await service.ingest(region, pipeline.name, pipeline.accountId, principal, true, [{ secret: "still-buffered" }]); clock.advance(1001);
    await until(async () => pipeline.logDeliveryFailure, value => !!value); assert.equal(stats().failed, 2);
    const before = structuredClone(pipeline.logPublishingOptions);
    await assert.rejects(osis!.send(new Osis.UpdatePipelineCommand({ PipelineName: pipeline.name, LogPublishingOptions: input.LogPublishingOptions })), { name: "ValidationException" }); assert.deepEqual(pipeline.logPublishingOptions, before);
    await logs!.send(new Logs.DeleteResourcePolicyCommand({ policyName: "deny-pipeline" }));
    await service.ingest(region, pipeline.name, pipeline.accountId, principal, true, [{}]); clock.advance(1001);
    await until(async () => pipeline.logDeliveryFailure, value => !value); assert.equal(stats().failed, 3);
    await assert.rejects(limited.send(new Osis.UpdatePipelineCommand({ PipelineName: pipeline.name, LogPublishingOptions: { IsLoggingEnabled: false } })), /logs:DeleteLogDelivery/);
    await sim.stop(); osis!.destroy(); logs!.destroy(); iam!.destroy(); limited.destroy(); limited = undefined;
    sim = new StackSim(options); await sim.start(); connect();
    assert.deepEqual((await osis!.send(new Osis.GetPipelineCommand({ PipelineName: pipeline.name }))).Pipeline!.LogPublishingOptions, input.LogPublishingOptions);
    await osis!.send(new Osis.UpdatePipelineCommand({ PipelineName: pipeline.name, LogPublishingOptions: { IsLoggingEnabled: false } }));
    await until(async () => sim.opensearch.ingestion.pipeline(region, pipeline.name), value => value.status === "ACTIVE");
    const count = (await events()).length;
    await sim.opensearch.ingestion.ingest(region, pipeline.name, pipeline.accountId, principal, true, [{}]); clock.advance(1001);
    await until(async () => stats(), value => value.failed === 4); assert.equal((await events()).length, count);
  } finally { osis?.destroy(); logs?.destroy(); iam?.destroy(); limited?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
