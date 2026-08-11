import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, DeleteFunctionCommand, GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { createLambdaFunctionProvider, type LambdaFunctionModel } from "../src/cloudformation/providers/lambda-function.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const accountId = "000000000000";
const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(callbackContext?: Readonly<Record<string, any>>): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/provider-test/stack-id`,
    logicalId: "Handler",
    operationId: "operation-1",
    resourceOperationId: "resource-operation-1",
    idempotencyKey: "stable-idempotency-key",
    deadlineAt: Date.now() + 60_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity },
  };
}

async function settle(
  invoke: (current: ProviderContext) => Promise<any>,
): Promise<any> {
  let result = await invoke(context());
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(30, result.callbackAfterMs)));
    result = await invoke(context(result.checkpoint.callbackContext));
  }
  return result;
}

test("Lambda function provider consumes inline and versioned S3 ZIP code through the real Lambda service", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-provider-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined; let lambdaClient: LambdaClient | undefined; let s3: S3Client | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials }); lambdaClient = new LambdaClient({ endpoint, region, credentials }); s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
    const role = (await iam.send(new CreateRoleCommand({ RoleName: "provider-lambda-role", AssumeRolePolicyDocument: trust }))).Role!.Arn!;
    const provider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const longContext = {
      ...context(),
      stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/${"amplify-sandbox-".repeat(5)}/stack-id`,
      logicalId: "TableManagerCustomProviderframeworkonEvent1DFC2ECC",
    };
    const generated = provider.canonicalize({ Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: "exports.handler = async () => undefined;" } }, longContext);
    assert.equal(generated.FunctionName.length, 64);
    assert.match(generated.FunctionName, /^amplify-sandbox-ampl-TableManagerCustomProviderframew-[a-f0-9]{10}$/);
    assert.equal(provider.canonicalize({ Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: "exports.handler = async () => undefined;" } }, longContext).FunctionName, generated.FunctionName);

    const inline = provider.canonicalize({
      FunctionName: "provider-inline-handler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: role,
      Code: { ZipFile: "exports.handler = async () => ({ version: 'one' });" },
      Environment: { Variables: { VERSION: "one" } },
      Tags: [{ Key: "team", Value: "platform" }],
    }, context());
    const created = await settle(current => provider.create(inline, current));
    assert.equal(created.status, "SUCCESS"); assert.equal(provider.ref(created.model), "provider-inline-handler"); assert.equal(provider.getAtt(created.model, "Arn"), `arn:aws:lambda:${region}:${accountId}:function:provider-inline-handler`);
    const direct = await lambdaClient.send(new GetFunctionCommand({ FunctionName: "provider-inline-handler" }));
    assert.equal(direct.Configuration?.Environment?.Variables?.VERSION, "one"); assert.equal(direct.Tags?.team, "platform"); assert.equal(direct.Tags?.["aws:cloudformation:logical-id"], "Handler");

    const updated = provider.canonicalize({ ...inline, Code: { ZipFile: "exports.handler = async () => ({ version: 'two' });" }, Environment: { Variables: { VERSION: "two" } } }, context());
    assert.equal(provider.plan(inline, updated, context()).action, "UPDATE");
    const updateResult = await settle(current => provider.update(inline.FunctionName, inline, updated, current));
    assert.equal(updateResult.status, "SUCCESS"); assert.equal((await lambdaClient.send(new GetFunctionCommand({ FunctionName: inline.FunctionName }))).Configuration?.Environment?.Variables?.VERSION, "two");

    await s3.send(new CreateBucketCommand({ Bucket: "provider-assets" }));
    const zip = createZip([{ name: "index.js", content: "exports.handler = async () => ({ asset: true });" }]);
    const put = await s3.send(new PutObjectCommand({ Bucket: "provider-assets", Key: "asset.zip", Body: zip }));
    const asset = provider.canonicalize({ FunctionName: "provider-asset-handler", Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { S3Bucket: "provider-assets", S3Key: "asset.zip", S3ObjectVersion: put.VersionId } }, { ...context(), logicalId: "AssetHandler" });
    const assetContext = (callbackContext?: Readonly<Record<string, any>>): ProviderContext => ({ ...context(callbackContext), logicalId: "AssetHandler", resourceOperationId: "asset-operation" });
    let assetResult = await provider.create(asset, assetContext());
    for (let attempt = 0; assetResult.status === "IN_PROGRESS" && attempt < 20; attempt++) { await new Promise(resolve => setTimeout(resolve, 30)); assetResult = await provider.create(asset, assetContext(assetResult.checkpoint.callbackContext)); }
    assert.equal(assetResult.status, "SUCCESS"); assert.equal((await lambdaClient.send(new GetFunctionCommand({ FunctionName: asset.FunctionName }))).Configuration?.CodeSize, zip.length);

    await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: inline.FunctionName }));
    await lambdaClient.send(new CreateFunctionCommand({ FunctionName: inline.FunctionName, Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => 'foreign';" }]) }, Tags: { owner: "foreign" } }));
    const foreignRead = await provider.read(inline.FunctionName, context()); assert.equal(foreignRead.status, "FAILED"); assert.equal((foreignRead as any).errorCode, "OwnershipConflict");
    const foreignDelete = await provider.delete(inline.FunctionName, updated, context()); assert.equal(foreignDelete.status, "FAILED"); assert.equal((foreignDelete as any).errorCode, "OwnershipConflict");
    assert.equal((await lambdaClient.send(new GetFunctionCommand({ FunctionName: inline.FunctionName }))).Tags?.owner, "foreign");
    await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: inline.FunctionName }));
    assert.equal((await provider.delete(inline.FunctionName, updated, context())).status, "NOT_FOUND");
  } finally {
    iam?.destroy(); lambdaClient?.destroy(); s3?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("Lambda function provider checkpoints each composite mutation and safely replays stale callback context", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-checkpoints-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined; let lambdaClient: LambdaClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials }); lambdaClient = new LambdaClient({ endpoint, region, credentials });
    const role = (await iam.send(new CreateRoleCommand({ RoleName: "provider-checkpoint-role", AssumeRolePolicyDocument: trust }))).Role!.Arn!;

    const mutations: string[] = [];
    const originalHandle = simulator.lambda.handle.bind(simulator.lambda);
    (simulator.lambda as any).handle = async (req: any, res: any, pathname: string, url: URL, principal: PrincipalContext) => {
      if (req.method !== "GET") {
        if (pathname === "/2015-03-31/functions" && req.method === "POST") mutations.push("create");
        else if (pathname.endsWith("/code") && req.method === "PUT") mutations.push("code");
        else if (pathname.endsWith("/configuration") && req.method === "PUT") mutations.push("configuration");
        else if (pathname.endsWith("/concurrency")) mutations.push("concurrency");
        else if (pathname.startsWith("/2017-03-31/tags/") && req.method === "DELETE") mutations.push("tag-removal");
        else if (pathname.startsWith("/2017-03-31/tags/") && req.method === "POST") mutations.push("tag-update");
      }
      return await originalHandle(req, res, pathname, url, principal);
    };
    const provider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const initial = provider.canonicalize({
      FunctionName: "provider-checkpoint-handler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: role,
      Code: { ZipFile: "exports.handler = async () => ({ version: 'one' });" },
      Environment: { Variables: { VERSION: "one" } },
      ReservedConcurrentExecutions: 1,
      Tags: [{ Key: "change", Value: "old" }, { Key: "remove", Value: "old" }],
    }, context());

    const invokeStep = async (callbackContext: Readonly<Record<string, any>> | undefined, operation: (current: ProviderContext) => Promise<any>) => {
      const before = mutations.length;
      const result = await operation(context(callbackContext));
      const calls = mutations.slice(before);
      assert.ok(calls.length <= 1, `provider performed multiple mutations in one callback: ${calls.join(", ")}`);
      if (calls.length) {
        assert.equal(result.status, "IN_PROGRESS", `mutation ${calls[0]} did not return IN_PROGRESS`);
        assert.ok(result.callbackAfterMs > 0, `mutation ${calls[0]} did not establish a nonzero callback boundary`);
        assert.equal(typeof result.checkpoint?.callbackContext?.phase, "string");
        assert.deepEqual(JSON.parse(JSON.stringify(result.checkpoint.callbackContext)), result.checkpoint.callbackContext);
      }
      return { result, calls };
    };

    const created = await invokeStep(undefined, current => provider.create(initial, current));
    assert.deepEqual(created.calls, ["create"]);
    assert.equal(created.result.checkpoint.callbackContext.phase, "after-create");
    const afterCreate = JSON.parse(JSON.stringify(created.result.checkpoint.callbackContext));
    await new Promise(resolve => setTimeout(resolve, 30));

    const concurrency = await invokeStep(afterCreate, current => provider.create(initial, current));
    assert.deepEqual(concurrency.calls, ["concurrency"]);
    assert.equal(concurrency.result.checkpoint.callbackContext.phase, "after-concurrency");

    // Replay the older after-create callback as if the concurrency checkpoint
    // had not been persisted. Authoritative state must suppress a second PUT.
    const replayedCreate = await invokeStep(afterCreate, current => provider.create(initial, current));
    assert.deepEqual(replayedCreate.calls, []);
    assert.equal(replayedCreate.result.status, "SUCCESS");

    const desired = provider.canonicalize({
      ...initial,
      Code: { ZipFile: "exports.handler = async () => ({ version: 'two' });" },
      Environment: { Variables: { VERSION: "two" } },
      ReservedConcurrentExecutions: 2,
      Tags: [{ Key: "add", Value: "new" }, { Key: "change", Value: "new" }],
    }, context());
    const firstUpdate = await invokeStep(undefined, current => provider.update(initial.FunctionName, initial, desired, current));
    assert.deepEqual(firstUpdate.calls, ["code"]);
    assert.equal(firstUpdate.result.checkpoint.callbackContext.phase, "after-code");
    const staleAfterCode = JSON.parse(JSON.stringify(firstUpdate.result.checkpoint.callbackContext));

    const expectedMutations = ["configuration", "concurrency", "tag-removal", "tag-update"];
    for (const expected of expectedMutations) {
      let observed = false;
      for (let attempt = 0; attempt < 10 && !observed; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 30));
        // Deliberately reuse the same stale checkpoint for every callback.
        const step = await invokeStep(staleAfterCode, current => provider.update(initial.FunctionName, initial, desired, current));
        if (!step.calls.length) {
          assert.equal(step.result.status, "IN_PROGRESS", `update completed before ${expected}`);
          continue;
        }
        assert.deepEqual(step.calls, [expected]);
        observed = true;
      }
      assert.equal(observed, true, `did not observe ${expected} mutation`);
    }

    let terminal: any;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      const step = await invokeStep(staleAfterCode, current => provider.update(initial.FunctionName, initial, desired, current));
      assert.deepEqual(step.calls, []);
      terminal = step.result;
      if (terminal.status === "SUCCESS") break;
    }
    assert.equal(terminal.status, "SUCCESS");

    // Replaying that same stale callback after terminal convergence is a pure
    // read: none of the already-completed mutations may be issued again.
    const replayedUpdate = await invokeStep(staleAfterCode, current => provider.update(initial.FunctionName, initial, desired, current));
    assert.deepEqual(replayedUpdate.calls, []);
    assert.equal(replayedUpdate.result.status, "SUCCESS");
    assert.deepEqual(mutations, ["create", "concurrency", "code", "configuration", "concurrency", "tag-removal", "tag-update"]);

    const direct = await lambdaClient.send(new GetFunctionCommand({ FunctionName: initial.FunctionName }));
    assert.equal(direct.Configuration?.Environment?.Variables?.VERSION, "two");
    assert.equal(direct.Concurrency?.ReservedConcurrentExecutions, 2);
    assert.equal(direct.Tags?.remove, undefined);
    assert.equal(direct.Tags?.change, "new");
    assert.equal(direct.Tags?.add, "new");
  } finally {
    iam?.destroy(); lambdaClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("Lambda function provider rejects unavailable dependency properties before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-boundary-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  try {
    await simulator.start(); const provider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const issues = provider.validate({ Runtime: "nodejs22.x", Handler: "index.handler", Role: `arn:aws:iam::${accountId}:role/test`, Code: { ImageUri: "example.invalid/image:latest" }, VpcConfig: { SubnetIds: ["subnet-1"], SecurityGroupIds: ["sg-1"] } }, context());
    assert.ok(issues.some(issue => issue.path === "Properties.VpcConfig" && issue.code === "UnsupportedProperty"));
    assert.ok(issues.some(issue => issue.path === "Properties.Code.ImageUri"));
    const nested = {
      Runtime: "nodejs22.x", Handler: "index.handler", Role: `arn:aws:iam::${accountId}:role/test`, Code: { ZipFile: "exports.handler = async () => undefined;" },
      Environment: { Variables: { MODE: "test" }, Error: { ErrorCode: "must-not-be-accepted" } },
      EphemeralStorage: { Size: 512, Unit: "MB" },
      TracingConfig: { Mode: "PassThrough", SamplingRate: 1 },
      DeadLetterConfig: { TargetArn: "", Type: "SQS" },
      LoggingConfig: { LogFormat: "JSON", ApplicationLogLevel: "INFO", Extra: true },
      Tags: [{ Key: "team", Value: "platform", PropagateAtLaunch: true }],
    };
    const nestedIssues = provider.validate(nested, context());
    for (const path of [
      "Properties.Environment.Error", "Properties.EphemeralStorage.Unit", "Properties.TracingConfig.SamplingRate",
      "Properties.DeadLetterConfig.Type", "Properties.LoggingConfig.Extra", "Properties.Tags[0].PropagateAtLaunch",
    ]) assert.ok(nestedIssues.some(issue => issue.path === path && issue.code === "UnsupportedProperty"), `missing nested validation issue for ${path}`);
    assert.throws(() => provider.canonicalize(nested, context()), /Properties\.Environment\.Error/);
    assert.equal(simulator.store.regionState(region).functions["provider-test-Handler"], undefined);
  } finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
