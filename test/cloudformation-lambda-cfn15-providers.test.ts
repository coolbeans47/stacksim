import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  DeleteFunctionCodeSigningConfigCommand,
  GetAliasCommand,
  GetCodeSigningConfigCommand,
  GetFunctionCodeSigningConfigCommand,
  GetFunctionUrlConfigCommand,
  GetLayerVersionPolicyCommand,
  GetPolicyCommand,
  GetProvisionedConcurrencyConfigCommand,
  LambdaClient,
  ListProvisionedConcurrencyConfigsCommand,
  ListTagsCommand,
  ListVersionsByFunctionCommand,
  PublishLayerVersionCommand,
  PutFunctionCodeSigningConfigCommand,
} from "@aws-sdk/client-lambda";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import {
  createLambdaCodeSigningConfigProvider,
  createLambdaLayerVersionPermissionProvider,
  createLambdaUrlProvider,
} from "../src/cloudformation/providers/lambda-cfn15.js";
import { createLambdaFunctionProvider } from "../src/cloudformation/providers/lambda-function.js";
import {
  createLambdaAliasProvider,
  createLambdaPermissionProvider,
  createLambdaVersionProvider,
} from "../src/cloudformation/providers/lambda-companions.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createZip } from "../src/core/zip-create.js";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = {
  accessKeyId: credentials.accessKeyId,
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string, callbackContext?: Readonly<Record<string, any>>): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cfn15-lambda/stack-id`,
    logicalId,
    operationId: `${logicalId}-operation`,
    resourceOperationId: `${logicalId}-resource-operation`,
    idempotencyKey: `${logicalId}-idempotency-key`,
    deadlineAt: Date.now() + 60_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity },
  };
}

async function settle(
  logicalId: string,
  invoke: (current: ProviderContext) => Promise<any>,
): Promise<any> {
  let result = await invoke(context(logicalId));
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(5, result.callbackAfterMs)));
    result = await invoke(context(logicalId, result.checkpoint.callbackContext));
  }
  return result;
}

test("CFN-15 Lambda providers use authoritative layer, URL, code-signing, and permission state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn15-lambda-providers-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined;
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials });
    lambda = new LambdaClient({ endpoint, region, credentials });
    const trust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    });
    const roleArn = (await iam.send(new CreateRoleCommand({
      RoleName: "cfn15-lambda-role",
      AssumeRolePolicyDocument: trust,
    }))).Role!.Arn!;

    const layer = await lambda.send(new PublishLayerVersionCommand({
      LayerName: "cfn15-shared",
      Content: { ZipFile: createZip([{ name: "nodejs/value.js", content: "module.exports = 15;" }]) },
      CompatibleRuntimes: ["nodejs22.x"],
    }));
    const layerProvider = createLambdaLayerVersionPermissionProvider(simulator.lambda);
    const layerDesired = layerProvider.canonicalize({
      Action: "lambda:GetLayerVersion",
      LayerVersionArn: layer.LayerVersionArn,
      Principal: accountId,
    }, context("LayerPermission"));
    const layerCreated = await layerProvider.create(layerDesired, context("LayerPermission"));
    assert.equal(layerCreated.status, "SUCCESS");
    assert.equal(layerProvider.ref(layerCreated.model), layerCreated.physicalId);
    assert.equal(layerProvider.getAtt(layerCreated.model, "Id"), layerCreated.physicalId);
    const layerPolicy = JSON.parse((await lambda.send(new GetLayerVersionPolicyCommand({
      LayerName: "cfn15-shared",
      VersionNumber: layer.Version,
    }))).Policy!);
    assert.equal(layerPolicy.Statement.length, 1);
    assert.equal(layerPolicy.Statement[0].Principal.AWS, `arn:aws:iam::${accountId}:root`);
    assert.equal((await layerProvider.read(layerCreated.physicalId, context("LayerPermission"))).status, "SUCCESS");
    assert.ok(layerProvider.validate({
      Action: "lambda:GetLayerVersion",
      LayerVersionArn: layer.LayerVersionArn,
      Principal: "*",
      OrganizationId: "o-1234567890",
    }, context("LayerPermission")).some(item => item.code === "UnsupportedProperty"));

    const signingProvider = createLambdaCodeSigningConfigProvider(simulator.lambda);
    const signerArn = `arn:aws:signer:${region}:${accountId}:/signing-profiles/cfn15_profile/abc123`;
    const signingDesired = signingProvider.canonicalize({
      AllowedPublishers: { SigningProfileVersionArns: [signerArn] },
      CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Warn" },
      Description: "CFN-15 descriptor",
      Tags: [{ Key: "team", Value: "platform" }],
    }, context("SigningConfig"));
    const signingCreated = await signingProvider.create(signingDesired, context("SigningConfig"));
    assert.equal(signingCreated.status, "SUCCESS");
    assert.equal(signingProvider.ref(signingCreated.model), signingCreated.physicalId);
    assert.equal(signingProvider.getAtt(signingCreated.model, "CodeSigningConfigArn"), signingCreated.physicalId);
    assert.match(String(signingProvider.getAtt(signingCreated.model, "CodeSigningConfigId")), /^csc-/);
    assert.equal((await lambda.send(new GetCodeSigningConfigCommand({
      CodeSigningConfigArn: signingCreated.physicalId,
    }))).CodeSigningConfig?.Description, "CFN-15 descriptor");
    const signingTags = (await lambda.send(new ListTagsCommand({ Resource: signingCreated.physicalId }))).Tags!;
    assert.equal(signingTags.team, "platform");
    assert.equal(signingTags["aws:cloudformation:logical-id"], "SigningConfig");

    const signingUpdated = signingProvider.canonicalize({
      AllowedPublishers: { SigningProfileVersionArns: [signerArn] },
      CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Warn" },
      Description: "updated descriptor",
      Tags: [{ Key: "team", Value: "runtime" }],
    }, context("SigningConfig"));
    assert.equal(signingProvider.plan(signingDesired, signingUpdated, context("SigningConfig")).action, "UPDATE");
    const signingUpdateResult = await signingProvider.update(
      signingCreated.physicalId,
      signingDesired,
      signingUpdated,
      context("SigningConfig"),
    );
    assert.equal(signingUpdateResult.status, "SUCCESS");
    assert.equal((await lambda.send(new GetCodeSigningConfigCommand({
      CodeSigningConfigArn: signingCreated.physicalId,
    }))).CodeSigningConfig?.Description, "updated descriptor");
    assert.equal((await lambda.send(new ListTagsCommand({ Resource: signingCreated.physicalId }))).Tags?.team, "runtime");

    const functionProvider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const functionDesired = functionProvider.canonicalize({
      FunctionName: "cfn15-url-handler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: roleArn,
      Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200, body: 'ok' });" },
      CodeSigningConfigArn: signingCreated.physicalId,
    }, context("Function"));
    const functionCreated = await settle("Function", current => functionProvider.create(functionDesired, current));
    assert.equal(functionCreated.status, "SUCCESS");
    assert.equal((await lambda.send(new GetFunctionCodeSigningConfigCommand({
      FunctionName: functionDesired.FunctionName,
    }))).CodeSigningConfigArn, signingCreated.physicalId);
    await lambda.send(new DeleteFunctionCodeSigningConfigCommand({ FunctionName: functionDesired.FunctionName }));
    const mismatchedRecovery = await functionProvider.create(functionDesired, context("Function"));
    assert.equal(mismatchedRecovery.status, "FAILED");
    assert.equal(mismatchedRecovery.status === "FAILED" ? mismatchedRecovery.errorCode : "", "OwnershipConflict");
    await assert.rejects(
      lambda.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: functionDesired.FunctionName })),
      (error: any) => error.name === "CodeSigningConfigNotFoundException",
      "create recovery must not mutate an unexpectedly drifted code-signing association",
    );
    await lambda.send(new PutFunctionCodeSigningConfigCommand({
      FunctionName: functionDesired.FunctionName,
      CodeSigningConfigArn: signingCreated.physicalId,
    }));

    const urlProvider = createLambdaUrlProvider(simulator.lambda);
    const urlDesired = urlProvider.canonicalize({
      AuthType: "NONE",
      TargetFunctionArn: functionCreated.model.attributes.Arn,
      InvokeMode: "BUFFERED",
      Cors: {
        AllowOrigins: ["https://app.example"],
        AllowMethods: ["POST", "GET"],
        AllowHeaders: ["content-type"],
      },
    }, context("FunctionUrl"));
    const urlCreated = await urlProvider.create(urlDesired, context("FunctionUrl"));
    assert.equal(urlCreated.status, "SUCCESS");
    assert.equal(urlProvider.ref(urlCreated.model), urlCreated.physicalId);
    assert.match(String(urlProvider.getAtt(urlCreated.model, "FunctionUrl")), /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await lambda.send(new GetFunctionUrlConfigCommand({
      FunctionName: functionDesired.FunctionName,
    }))).AuthType, "NONE");

    const urlUpdated = urlProvider.canonicalize({
      AuthType: "AWS_IAM",
      TargetFunctionArn: functionCreated.model.attributes.Arn,
      InvokeMode: "RESPONSE_STREAM",
    }, context("FunctionUrl"));
    assert.equal(urlProvider.plan(urlDesired, urlUpdated, context("FunctionUrl")).action, "UPDATE");
    const urlUpdateResult = await urlProvider.update(urlCreated.physicalId, urlDesired, urlUpdated, context("FunctionUrl"));
    assert.equal(urlUpdateResult.status, "SUCCESS");
    const directUrl = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: functionDesired.FunctionName }));
    assert.equal(directUrl.AuthType, "AWS_IAM");
    assert.equal(directUrl.InvokeMode, "RESPONSE_STREAM");
    assert.equal(directUrl.Cors, undefined);

    const permissionProvider = createLambdaPermissionProvider(simulator.lambda);
    const urlPermission = permissionProvider.canonicalize({
      Action: "lambda:InvokeFunctionUrl",
      FunctionName: functionDesired.FunctionName,
      Principal: "*",
      FunctionUrlAuthType: "NONE",
    }, context("UrlPermission"));
    const urlPermissionCreated = await permissionProvider.create(urlPermission, context("UrlPermission"));
    assert.equal(urlPermissionCreated.status, "SUCCESS");
    const invokePermission = permissionProvider.canonicalize({
      Action: "lambda:InvokeFunction",
      FunctionName: functionDesired.FunctionName,
      Principal: "*",
      InvokedViaFunctionUrl: true,
    }, context("InvokePermission"));
    const invokePermissionCreated = await permissionProvider.create(invokePermission, context("InvokePermission"));
    assert.equal(invokePermissionCreated.status, "SUCCESS");
    const functionPolicy = JSON.parse((await lambda.send(new GetPolicyCommand({
      FunctionName: functionDesired.FunctionName,
    }))).Policy!);
    assert.ok(functionPolicy.Statement.some((statement: any) =>
      statement.Condition?.StringEquals?.["lambda:FunctionUrlAuthType"] === "NONE"));
    assert.ok(functionPolicy.Statement.some((statement: any) =>
      statement.Condition?.Bool?.["lambda:InvokedViaFunctionUrl"] === "true"));

    assert.equal((await permissionProvider.delete(
      urlPermissionCreated.physicalId,
      urlPermission,
      context("UrlPermission"),
    )).status, "SUCCESS");
    assert.equal((await permissionProvider.delete(
      invokePermissionCreated.physicalId,
      invokePermission,
      context("InvokePermission"),
    )).status, "SUCCESS");
    assert.equal((await urlProvider.delete(urlCreated.physicalId, urlUpdated, context("FunctionUrl"))).status, "SUCCESS");

    const functionWithoutSigning = functionProvider.canonicalize({
      FunctionName: "cfn15-url-handler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: roleArn,
      Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200, body: 'ok' });" },
    }, context("Function"));
    const detached = await settle("Function", current =>
      functionProvider.update(functionCreated.physicalId, functionDesired, functionWithoutSigning, current));
    assert.equal(detached.status, "SUCCESS");
    await assert.rejects(
      lambda.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: functionDesired.FunctionName })),
      (error: any) => error.name === "CodeSigningConfigNotFoundException",
    );

    assert.equal((await functionProvider.delete(
      functionCreated.physicalId,
      functionWithoutSigning,
      context("Function"),
    )).status, "SUCCESS");
    assert.equal((await signingProvider.delete(
      signingCreated.physicalId,
      signingUpdated,
      context("SigningConfig"),
    )).status, "SUCCESS");
    assert.equal((await layerProvider.delete(
      layerCreated.physicalId,
      layerDesired,
      context("LayerPermission"),
    )).status, "SUCCESS");
  } finally {
    iam?.destroy();
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-15 Lambda Version and Alias provisioned concurrency stabilizes, updates, reads, and deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn15-lambda-provisioned-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined;
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials });
    lambda = new LambdaClient({ endpoint, region, credentials });
    const trust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    });
    const roleArn = (await iam.send(new CreateRoleCommand({
      RoleName: "cfn15-provisioned-role",
      AssumeRolePolicyDocument: trust,
    }))).Role!.Arn!;

    const functionProvider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const functionDesired = functionProvider.canonicalize({
      FunctionName: "cfn15-provisioned-handler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: roleArn,
      Code: { ZipFile: "exports.handler = async () => ({ ok: true });" },
      ReservedConcurrentExecutions: 20,
    }, context("ProvisionedFunction"));
    const functionCreated = await settle("ProvisionedFunction", current => functionProvider.create(functionDesired, current));
    assert.equal(functionCreated.status, "SUCCESS");

    const versionProvider = createLambdaVersionProvider(simulator.lambda);
    const versionDesired = versionProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      Description: "provisioned immutable snapshot",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 },
    }, context("ProvisionedVersion"));
    const versionCreated = await settle("ProvisionedVersion", current => versionProvider.create(versionDesired, current));
    assert.equal(versionCreated.status, "SUCCESS");
    assert.equal(versionProvider.getAtt(versionCreated.model, "Version"), "1");
    const versionProvisioned = await lambda.send(new GetProvisionedConcurrencyConfigCommand({
      FunctionName: functionDesired.FunctionName,
      Qualifier: "1",
    }));
    assert.equal(versionProvisioned.Status, "READY");
    assert.equal(versionProvisioned.RequestedProvisionedConcurrentExecutions, 2);
    const versionRead = await versionProvider.read(versionCreated.physicalId, context("ProvisionedVersion"));
    assert.equal(versionRead.status, "SUCCESS");
    assert.deepEqual(versionRead.model.properties.ProvisionedConcurrencyConfig, { ProvisionedConcurrentExecutions: 2 });
    const changedVersion = versionProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      Description: "provisioned immutable snapshot",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 3 },
    }, context("ProvisionedVersion"));
    const versionPlan = versionProvider.plan(versionDesired, changedVersion, context("ProvisionedVersion"));
    assert.equal(versionPlan.action, "REPLACE");
    assert.deepEqual(versionPlan.replacementProperties, ["ProvisionedConcurrencyConfig"]);

    const aliasProvider = createLambdaAliasProvider(simulator.lambda);
    const aliasDesired = aliasProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      FunctionVersion: "1",
      Name: "live",
      Description: "one warm environment",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 },
    }, context("ProvisionedAlias"));
    const aliasCreated = await settle("ProvisionedAlias", current => aliasProvider.create(aliasDesired, current));
    assert.equal(aliasCreated.status, "SUCCESS");
    assert.equal((await lambda.send(new GetProvisionedConcurrencyConfigCommand({
      FunctionName: functionDesired.FunctionName,
      Qualifier: "live",
    }))).RequestedProvisionedConcurrentExecutions, 1);
    const aliasRead = await aliasProvider.read(aliasCreated.physicalId, context("ProvisionedAlias"));
    assert.equal(aliasRead.status, "SUCCESS");
    assert.deepEqual(aliasRead.model.properties.ProvisionedConcurrencyConfig, { ProvisionedConcurrentExecutions: 1 });

    const aliasScaled = aliasProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      FunctionVersion: "1",
      Name: "live",
      Description: "three warm environments",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 3 },
    }, context("ProvisionedAlias"));
    const aliasPlan = aliasProvider.plan(aliasDesired, aliasScaled, context("ProvisionedAlias"));
    assert.equal(aliasPlan.action, "UPDATE");
    assert.deepEqual(aliasPlan.replacementProperties, []);
    const aliasScaleResult = await settle("ProvisionedAlias", current =>
      aliasProvider.update(aliasCreated.physicalId, aliasDesired, aliasScaled, current));
    assert.equal(aliasScaleResult.status, "SUCCESS");
    const scaled = await lambda.send(new GetProvisionedConcurrencyConfigCommand({
      FunctionName: functionDesired.FunctionName,
      Qualifier: "live",
    }));
    assert.equal(scaled.Status, "READY");
    assert.equal(scaled.RequestedProvisionedConcurrentExecutions, 3);

    const aliasWithoutProvisioned = aliasProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      FunctionVersion: "1",
      Name: "live",
      Description: "on demand",
    }, context("ProvisionedAlias"));
    const aliasRemoveResult = await settle("ProvisionedAlias", current =>
      aliasProvider.update(aliasCreated.physicalId, aliasScaled, aliasWithoutProvisioned, current));
    assert.equal(aliasRemoveResult.status, "SUCCESS");
    await assert.rejects(
      lambda.send(new GetProvisionedConcurrencyConfigCommand({
        FunctionName: functionDesired.FunctionName,
        Qualifier: "live",
      })),
      (error: any) => error.name === "ProvisionedConcurrencyConfigNotFoundException",
    );

    const aliasRestored = aliasProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      FunctionVersion: "1",
      Name: "live",
      Description: "two warm environments",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 },
    }, context("ProvisionedAlias"));
    const aliasRestoreResult = await settle("ProvisionedAlias", current =>
      aliasProvider.update(aliasCreated.physicalId, aliasWithoutProvisioned, aliasRestored, current));
    assert.equal(aliasRestoreResult.status, "SUCCESS");
    assert.equal((await aliasProvider.delete(
      aliasCreated.physicalId,
      aliasRestored,
      context("ProvisionedAlias"),
    )).status, "SUCCESS");
    await assert.rejects(
      lambda.send(new GetAliasCommand({ FunctionName: functionDesired.FunctionName, Name: "live" })),
      (error: any) => error.name === "ResourceNotFoundException",
    );

    assert.equal((await versionProvider.delete(
      versionCreated.physicalId,
      versionDesired,
      context("ProvisionedVersion"),
    )).status, "SUCCESS");
    const remainingConfigs = await lambda.send(new ListProvisionedConcurrencyConfigsCommand({
      FunctionName: functionDesired.FunctionName,
    }));
    assert.deepEqual(remainingConfigs.ProvisionedConcurrencyConfigs, []);
    assert.deepEqual(
      (await lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionDesired.FunctionName }))).Versions?.map(item => item.Version),
      ["$LATEST"],
    );
    assert.equal((await functionProvider.delete(
      functionCreated.physicalId,
      functionDesired,
      context("ProvisionedFunction"),
    )).status, "SUCCESS");

    assert.ok(versionProvider.validate({
      FunctionName: "example",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1, Unsupported: true },
    }, context("InvalidVersion")).some(issue => issue.path === "Properties.ProvisionedConcurrencyConfig.Unsupported" && issue.code === "UnsupportedProperty"));
    assert.ok(aliasProvider.validate({
      FunctionName: "example",
      FunctionVersion: "1",
      Name: "live",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 0 },
    }, context("InvalidAlias")).some(issue => issue.path === "Properties.ProvisionedConcurrencyConfig.ProvisionedConcurrentExecutions"));
  } finally {
    iam?.destroy();
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-15 Lambda provisioned concurrency failures expose partial IDs for rollback-safe cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn15-lambda-provisioned-rollback-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined;
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials });
    lambda = new LambdaClient({ endpoint, region, credentials });
    const trust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    });
    const roleArn = (await iam.send(new CreateRoleCommand({
      RoleName: "cfn15-provisioned-rollback-role",
      AssumeRolePolicyDocument: trust,
    }))).Role!.Arn!;
    const functionProvider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const functionDesired = functionProvider.canonicalize({
      FunctionName: "cfn15-provisioned-rollback-handler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: roleArn,
      Code: { ZipFile: "exports.handler = async () => ({ ok: true });" },
      ReservedConcurrentExecutions: 20,
    }, context("RollbackFunction"));
    const functionCreated = await settle("RollbackFunction", current => functionProvider.create(functionDesired, current));
    assert.equal(functionCreated.status, "SUCCESS");

    const versionProvider = createLambdaVersionProvider(simulator.lambda);
    const baseVersion = versionProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      Description: "alias target",
    }, context("RollbackBaseVersion"));
    const baseVersionCreated = await settle("RollbackBaseVersion", current => versionProvider.create(baseVersion, current));
    assert.equal(baseVersionCreated.status, "SUCCESS");

    const serviceWithProvisionedFailure = () => {
      let injected = false;
      return {
        service: {
          handle: async (req: any, res: any, pathname: string, url: URL, principal: PrincipalContext) => {
            if (!injected && req.method === "PUT" && pathname.endsWith("/provisioned-concurrency")) {
              injected = true;
              throw new AwsError("InvalidParameterValueException", "injected provisioned concurrency rejection", 400);
            }
            return await simulator.lambda.handle(req, res, pathname, url, principal);
          },
        } as any,
        wasInjected: () => injected,
      };
    };

    const aliasFailureService = serviceWithProvisionedFailure();
    const failingAliasProvider = createLambdaAliasProvider(aliasFailureService.service);
    const aliasDesired = failingAliasProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      FunctionVersion: "1",
      Name: "rollback",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 },
    }, context("RollbackAlias"));
    const aliasFailure = await failingAliasProvider.create(aliasDesired, context("RollbackAlias"));
    assert.equal(aliasFailureService.wasInjected(), true);
    assert.equal(aliasFailure.status, "FAILED");
    assert.equal(aliasFailure.errorCode, "InvalidParameterValueException");
    assert.match(aliasFailure.physicalId!, /:function:cfn15-provisioned-rollback-handler:rollback$/);
    const normalAliasProvider = createLambdaAliasProvider(simulator.lambda);
    assert.equal((await normalAliasProvider.delete(
      aliasFailure.physicalId!,
      aliasDesired,
      context("RollbackAlias"),
    )).status, "SUCCESS");
    await assert.rejects(
      lambda.send(new GetAliasCommand({ FunctionName: functionDesired.FunctionName, Name: "rollback" })),
      (error: any) => error.name === "ResourceNotFoundException",
    );

    const versionFailureService = serviceWithProvisionedFailure();
    const failingVersionProvider = createLambdaVersionProvider(versionFailureService.service);
    const failingVersionDesired = failingVersionProvider.canonicalize({
      FunctionName: functionDesired.FunctionName,
      Description: "must be rolled back",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 },
    }, context("RollbackVersion"));
    const versionStarted = await failingVersionProvider.create(failingVersionDesired, context("RollbackVersion"));
    assert.equal(versionStarted.status, "IN_PROGRESS");
    const versionFailure = await failingVersionProvider.create(
      failingVersionDesired,
      context("RollbackVersion", versionStarted.checkpoint.callbackContext),
    );
    assert.equal(versionFailureService.wasInjected(), true);
    assert.equal(versionFailure.status, "FAILED");
    assert.equal(versionFailure.errorCode, "InvalidParameterValueException");
    assert.match(versionFailure.physicalId!, /:function:cfn15-provisioned-rollback-handler:2$/);
    assert.equal((await versionProvider.delete(
      versionFailure.physicalId!,
      failingVersionDesired,
      context("RollbackVersion"),
    )).status, "SUCCESS");
    assert.deepEqual(
      (await lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionDesired.FunctionName }))).Versions?.map(item => item.Version),
      ["$LATEST", "1"],
    );

    assert.equal((await versionProvider.delete(
      baseVersionCreated.physicalId,
      baseVersion,
      context("RollbackBaseVersion"),
    )).status, "SUCCESS");
    assert.equal((await functionProvider.delete(
      functionCreated.physicalId,
      functionDesired,
      context("RollbackFunction"),
    )).status, "SUCCESS");
  } finally {
    iam?.destroy();
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
