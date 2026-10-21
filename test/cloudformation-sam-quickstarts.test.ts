import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
  type Capability,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// The quick starts are the Node.js 22 `sam init` templates from
// aws/aws-sam-cli-app-templates (Apache-2.0; see test/fixtures/sam/quickstarts/NOTICE),
// rendered with project name sam-app and architecture x86_64.
const quickstarts = resolve("test", "fixtures", "sam", "quickstarts");
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const bucket = "sam-artifacts";

interface Fixture {
  simulator: StackSim;
  endpoint: string;
  cloudformation: CloudFormationClient;
  s3: S3Client;
  iam: IAMClient;
  logs: CloudWatchLogsClient;
}

async function withSimulator(prefix: string, authMode: "off" | "enforce", run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode, ...(authMode === "enforce" ? { cdkBootstrap: true } : {}) });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const fixture: Fixture = {
      simulator,
      endpoint,
      cloudformation: new CloudFormationClient(options),
      s3: new S3Client({ ...options, forcePathStyle: true }),
      iam: new IAMClient(options),
      logs: new CloudWatchLogsClient(options),
    };
    clients.push(fixture.cloudformation, fixture.s3, fixture.iam, fixture.logs);
    await fixture.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await run(fixture);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** What `sam build` puts in a function's artifact: every file under the CodeUri directory. */
function zipDirectory(directory: string, files: Record<string, string> = {}): Buffer {
  const entries: Array<{ name: string; content: string | Buffer }> = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push({ name: relative(directory, path).split("\\").join("/"), content: files[relative(directory, path).split("\\").join("/")] ?? readFileSync(path) });
    }
  };
  walk(directory);
  return createZip(entries);
}

const md5 = (data: string | Buffer) => createHash("md5").update(data).digest("hex");
let changeSetCounter = 0;

/**
 * The SAM CLI `sam deploy --s3-bucket` wire flow: upload each artifact as
 * <md5>, rewrite CodeUri to s3://bucket/key, upload the packaged template as
 * <md5>.template, then CreateChangeSet with a local TemplateURL, wait, and
 * ExecuteChangeSet. Returns "no-changes" for an unchanged redeploy.
 */
async function samDeploy(fixture: Fixture, stackName: string, template: string, artifacts: Record<string, Buffer>, capabilities: Capability[] = ["CAPABILITY_IAM"]): Promise<"deployed" | "no-changes"> {
  let packaged = template;
  for (const [placeholder, artifact] of Object.entries(artifacts)) {
    const key = md5(artifact);
    await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: artifact, ServerSideEncryption: "AES256" }));
    packaged = packaged.replaceAll(placeholder, `s3://${bucket}/${key}`);
  }
  const templateKey = `${md5(packaged)}.template`;
  await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: templateKey, Body: packaged, ServerSideEncryption: "AES256" }));
  let changeSetType: "CREATE" | "UPDATE" = "UPDATE";
  try {
    const status = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === "REVIEW_IN_PROGRESS") changeSetType = "CREATE";
  } catch (error: any) {
    if (error?.message !== `Stack with id ${stackName} does not exist`) throw error;
    changeSetType = "CREATE";
  }
  const created = await fixture.cloudformation.send(new CreateChangeSetCommand({
    StackName: stackName,
    ChangeSetName: `samcli-deploy${Date.now()}${changeSetCounter++}`,
    ChangeSetType: changeSetType,
    TemplateURL: `${fixture.endpoint}/${bucket}/${templateKey}`,
    Capabilities: capabilities,
    Parameters: [],
    Tags: [],
  }));
  const changeSet = await fixture.cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: created.Id }));
  if (changeSet.Status === "FAILED") {
    if (/didn't contain changes|No updates are to be performed/.test(changeSet.StatusReason ?? "")) return "no-changes";
    throw new Error(`Change set failed: ${changeSet.StatusReason}`);
  }
  assert.equal(changeSet.Status, "CREATE_COMPLETE");
  await fixture.cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: created.Id }));
  const waiter = changeSetType === "CREATE" ? waitUntilStackCreateComplete : waitUntilStackUpdateComplete;
  const result = await waiter({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName });
  assert.equal(result.state, "SUCCESS", JSON.stringify(result.reason));
  return "deployed";
}

async function outputs(fixture: Fixture, stackName: string): Promise<Record<string, string>> {
  const stack = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  return Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
}

async function physicalId(fixture: Fixture, stackName: string, logicalId: string): Promise<string> {
  return (await fixture.cloudformation.send(new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: logicalId }))).StackResourceDetail!.PhysicalResourceId!;
}

/** Call the host-based local execute-api endpoint `{apiId}.execute-api.localhost:{invokePort}`. */
function invoke(fixture: Fixture, apiId: string, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const port = fixture.simulator.invokePort;
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host: `${apiId}.execute-api.localhost:${port}`, ...(body ? { "content-type": "application/json" } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("sam init hello-world (nodejs22.x) deploys through the sam deploy flow, serves, updates, and deletes", async () => {
  await withSimulator("stacksim-sam02-hello-", "off", async fixture => {
    const directory = join(quickstarts, "hello-world");
    const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n").replace("CodeUri: hello-world/", "CodeUri: __HELLO_WORLD_CODE__");
    const stackName = "hello";

    // Without CAPABILITY_IAM the generated role is refused, as on AWS.
    await assert.rejects(samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: zipDirectory(join(directory, "hello-world")) }, []), /Requires capabilities : \[CAPABILITY_IAM\]/);

    assert.equal(await samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: zipDirectory(join(directory, "hello-world")) }), "deployed");
    const apiId = await physicalId(fixture, stackName, "ServerlessRestApi");
    const values = await outputs(fixture, stackName);
    assert.equal(values.HelloWorldApi, `https://${apiId}.execute-api.${region}.amazonaws.com/Prod/hello/`);
    assert.equal(values.HelloWorldFunction, `arn:aws:lambda:${region}:000000000000:function:${await physicalId(fixture, stackName, "HelloWorldFunction")}`);
    assert.match(values.HelloWorldFunctionIamRole, /^arn:aws:iam::000000000000:role\/hello-HelloWorldFunctionRole-/);

    const response = await invoke(fixture, apiId, "GET", "/Prod/hello/");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { message: "hello world" });
    assert.equal((await invoke(fixture, apiId, "GET", "/Stage/hello/")).status, 200, "the Deployment's StageName creates the extra Stage stage, as on AWS");

    const processed = JSON.parse(String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Processed" }))).TemplateBody));
    assert.deepEqual(Object.keys(processed.Resources).map(id => id.replace(/[0-9a-f]{10}$/, "HASH")).sort(), [
      "HelloWorldFunction", "HelloWorldFunctionHelloWorldPermissionProd", "HelloWorldFunctionRole", "ServerlessRestApi", "ServerlessRestApiDeploymentHASH", "ServerlessRestApiProdStage",
    ]);
    assert.equal(processed.Resources.HelloWorldFunction.Properties.Timeout, 3, "Globals merge into the function");

    // An unchanged redeploy reports no changes.
    assert.equal(await samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: zipDirectory(join(directory, "hello-world")) }), "no-changes");

    // A code change updates only the function.
    const changedCode = zipDirectory(join(directory, "hello-world"), { "app.mjs": readFileSync(join(directory, "hello-world", "app.mjs"), "utf8").replace("hello world", "hello again") });
    assert.equal(await samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: changedCode }), "deployed");
    assert.deepEqual(JSON.parse((await invoke(fixture, apiId, "GET", "/Prod/hello/")).body), { message: "hello again" });
    assert.equal(await physicalId(fixture, stackName, "ServerlessRestApi"), apiId);

    const roleName = values.HelloWorldFunctionIamRole.split("/").pop()!;
    await fixture.cloudformation.send(new DeleteStackCommand({ StackName: stackName }));
    assert.equal((await waitUntilStackDeleteComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName })).state, "SUCCESS");
    await assert.rejects(fixture.iam.send(new GetRoleCommand({ RoleName: roleName })), (error: any) => error.name === "NoSuchEntityException");
  });
});

test("sam init web CRUD quick start serves GET and POST, and its DynamoDBCrudPolicy is enforced", async () => {
  await withSimulator("stacksim-sam02-web-", "enforce", async fixture => {
    const directory = join(quickstarts, "web");
    // `sam build` packages the project directory for functions without CodeUri.
    const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n").replaceAll("      Handler: src/handlers/", "      CodeUri: __WEB_CODE__\n      Handler: src/handlers/");
    const code = zipDirectory(directory);
    const stackName = "web";
    assert.equal(await samDeploy(fixture, stackName, template, { __WEB_CODE__: code }), "deployed");
    const apiId = await physicalId(fixture, stackName, "ServerlessRestApi");
    assert.equal((await outputs(fixture, stackName)).WebEndpoint, `https://${apiId}.execute-api.${region}.amazonaws.com/Prod/`);

    const put = await invoke(fixture, apiId, "POST", "/Prod/", JSON.stringify({ id: "1", name: "first item" }));
    assert.equal(put.status, 200, put.body);
    assert.deepEqual(JSON.parse(put.body), { id: "1", name: "first item" });
    assert.deepEqual(JSON.parse((await invoke(fixture, apiId, "GET", "/Prod/")).body), [{ id: "1", name: "first item" }]);
    assert.deepEqual(JSON.parse((await invoke(fixture, apiId, "GET", "/Prod/1")).body), { id: "1", name: "first item" });

    // Removing the policy template removes the permission: the handler's Scan is denied.
    const withoutPolicy = template.replace(/(getAllItemsFunction:[\s\S]*?)      Policies:\n        # Give Create\/Read\/Update\/Delete Permissions to the SampleTable\n        - DynamoDBCrudPolicy:\n            TableName: !Ref SampleTable\n/, "$1");
    assert.notEqual(withoutPolicy, template);
    assert.equal(await samDeploy(fixture, stackName, withoutPolicy, { __WEB_CODE__: code }), "deployed");
    const denied = await invoke(fixture, apiId, "GET", "/Prod/");
    assert.equal(denied.status, 200, "the quick-start handler catches the error and returns no items");
    assert.equal(denied.body, "");
    const functionName = await physicalId(fixture, stackName, "getAllItemsFunction");
    const events = await fixture.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}`, filterPattern: "AccessDenied" }));
    assert.ok(events.events?.length, "the denied Scan is logged as AccessDenied");
  });
});

test("an HttpApi event deploys an implicit HTTP API that serves through $default", async () => {
  await withSimulator("stacksim-sam02-httpapi-", "off", async fixture => {
    const template = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  EchoFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: __ECHO_CODE__
      Handler: index.handler
      Runtime: nodejs22.x
      Events:
        Everything:
          Type: HttpApi
Outputs:
  HttpApiUrl:
    Value: !Sub "https://\${ServerlessHttpApi}.execute-api.\${AWS::Region}.\${AWS::URLSuffix}/"
`;
    const code = createZip([{ name: "index.mjs", content: "export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ route: event.routeKey, path: event.rawPath, version: event.version }) });\n" }]);
    assert.equal(await samDeploy(fixture, "echo", template, { __ECHO_CODE__: code }), "deployed");
    const apiId = await physicalId(fixture, "echo", "ServerlessHttpApi");
    assert.equal((await outputs(fixture, "echo")).HttpApiUrl, `https://${apiId}.execute-api.${region}.amazonaws.com/`);
    const response = await invoke(fixture, apiId, "GET", "/any/path");
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { route: "$default", path: "/any/path", version: "2.0" });
  });
});
