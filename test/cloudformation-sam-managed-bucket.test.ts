import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { CreateAccessKeyCommand, CreateUserCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createS3BucketPolicyProvider } from "../src/cloudformation/providers/s3-bucket-policy.js";
import { createS3BucketProvider } from "../src/cloudformation/providers/s3-bucket.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createZip } from "../src/core/zip-create.js";
import type { PolicyDocument } from "../src/types.js";
import { StackSim } from "../src/server.js";

// SAM-05: the SAM CLI managed bucket. `sam deploy --guided` and `--resolve-s3`
// create the stack aws-sam-cli-managed-default from the fixed template in
// aws-sam-cli v1.169.0 samcli/lib/bootstrap/bootstrap.py (_get_stack_template),
// then package and deploy through its bucket. These tests drive that wire flow
// through the SDK with the same request shapes, over the local HTTPS S3 endpoint.

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const SAM_CLI_STACK_NAME = "aws-sam-cli-managed-default";
const quickstarts = resolve("test", "fixtures", "sam", "quickstarts");

/** Python's json.dumps with default separators, which the SAM CLI uses for the template body. */
function pythonJsonDumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJsonDumps).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`).join(", ")}}`;
  return JSON.stringify(value);
}

/** The unmodified managed-stack template, as `_get_stack_template()` renders it. */
function samCliManagedTemplate(version = "1.169.0", installationId = "8f3c2a8e-5b2d-4d55-9a8f-0f6a1c2b3d4e"): string {
  const bucketArn = (suffix: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":s3:::", { Ref: "SamCliSourceBucket" }, ...(suffix ? [suffix] : [])]] });
  return pythonJsonDumps({
    AWSTemplateFormatVersion: "2010-09-09",
    Transform: "AWS::Serverless-2016-10-31",
    Description: "Managed Stack for AWS SAM CLI",
    Metadata: { SamCliInfo: { version, installationId } },
    Resources: {
      SamCliSourceBucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          PublicAccessBlockConfiguration: { BlockPublicPolicy: "true", BlockPublicAcls: "true", IgnorePublicAcls: "true", RestrictPublicBuckets: "true" },
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" } }] },
          VersioningConfiguration: { Status: "Enabled" },
          Tags: [{ Key: "ManagedStackSource", Value: "AwsSamCli" }],
        },
      },
      SamCliSourceBucketBucketPolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: {
          Bucket: { Ref: "SamCliSourceBucket" },
          PolicyDocument: {
            Statement: [
              {
                Action: ["s3:GetObject"],
                Effect: "Allow",
                Resource: bucketArn("/*"),
                Principal: { Service: "serverlessrepo.amazonaws.com" },
                Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
              },
              {
                Action: ["s3:*"],
                Effect: "Deny",
                Resource: [bucketArn(""), bucketArn("/*")],
                Principal: "*",
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          },
        },
      },
    },
    Outputs: { SourceBucket: { Value: { Ref: "SamCliSourceBucket" } } },
  });
}

interface Fixture {
  simulator: StackSim;
  ca: string;
  cloudformation: CloudFormationClient;
  /** The SAM CLI's S3 client: AWS_ENDPOINT_URL_S3=https://127.0.0.1:<port> plus AWS_CA_BUNDLE. */
  s3: S3Client;
  /** A client still on the plain-HTTP main endpoint. */
  s3Http: S3Client;
  iam: IAMClient;
  clients: Array<{ destroy(): void }>;
}

async function fetchCa(simulator: StackSim): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/ca.pem`);
  assert.equal(response.status, 200);
  const pem = await response.text();
  assert.match(pem, /^-----BEGIN CERTIFICATE-----/);
  return pem;
}

async function open(simulator: StackSim): Promise<Fixture> {
  const ca = await fetchCa(simulator);
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
  const fixture: Fixture = {
    simulator,
    ca,
    cloudformation: new CloudFormationClient(options),
    // No forcePathStyle: like botocore, the SDK picks path style for an IP endpoint.
    s3: new S3Client({ endpoint: `https://127.0.0.1:${simulator.s3TlsPort}`, region, credentials, maxAttempts: 1, requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ ca }) }) }),
    s3Http: new S3Client({ ...options, forcePathStyle: true }),
    iam: new IAMClient(options),
    clients: [],
  };
  fixture.clients.push(fixture.cloudformation, fixture.s3, fixture.s3Http, fixture.iam);
  return fixture;
}

function close(fixture: Fixture): void {
  fixture.clients.forEach(client => client.destroy());
}

/** samcli/lib/utils/managed_cloudformation_stack.py `_check_sanity_of_stack`. */
function checkSanityOfStack(stack: Stack): void {
  assert.ok(stack.Tags && stack.Outputs, `Stack ${stack.StackName} is missing Tags and/or Outputs information`);
  assert.equal(stack.Tags.find(tag => tag.Key === "ManagedStackSource")?.Value, "AwsSamCli");
}

/**
 * samcli/lib/bootstrap/bootstrap.py `manage_stack` → `_create_or_get_stack`:
 * DescribeStacks; on any error CreateChangeSet("InitialCreation"), wait,
 * ExecuteChangeSet, wait, DescribeStacks; return the SourceBucket output.
 */
async function manageStack(fixture: Fixture, events: string[] = []): Promise<string> {
  try {
    const stack = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: SAM_CLI_STACK_NAME }))).Stacks![0];
    checkSanityOfStack(stack);
    events.push("found");
    return stack.Outputs!.find(output => output.OutputKey === "SourceBucket")!.OutputValue!;
  } catch (error: any) {
    if (error?.code === "ERR_ASSERTION") throw error;
    assert.equal(error?.message, `Stack with id ${SAM_CLI_STACK_NAME} does not exist`);
  }
  events.push("created");
  const created = await fixture.cloudformation.send(new CreateChangeSetCommand({
    StackName: SAM_CLI_STACK_NAME,
    TemplateBody: samCliManagedTemplate(),
    Tags: [{ Key: "ManagedStackSource", Value: "AwsSamCli" }],
    ChangeSetType: "CREATE",
    ChangeSetName: "InitialCreation",
    Capabilities: ["CAPABILITY_IAM"],
    Parameters: [],
  }));
  const changeSetWait = await waitUntilChangeSetCreateComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { ChangeSetName: "InitialCreation", StackName: SAM_CLI_STACK_NAME });
  assert.equal(changeSetWait.state, "SUCCESS", JSON.stringify(changeSetWait.reason));
  await fixture.cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: "InitialCreation", StackName: SAM_CLI_STACK_NAME }));
  const stackWait = await waitUntilStackCreateComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: created.StackId! });
  assert.equal(stackWait.state, "SUCCESS", JSON.stringify(stackWait.reason));
  const stack = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: SAM_CLI_STACK_NAME }))).Stacks![0];
  checkSanityOfStack(stack);
  return stack.Outputs!.find(output => output.OutputKey === "SourceBucket")!.OutputValue!;
}

const md5 = (data: string | Buffer) => createHash("md5").update(data).digest("hex");

/** samcli/lib/package/s3_uploader.py `upload`: HeadObject, then PutObject with ServerSideEncryption=AES256 unless --kms-key-id. */
async function uploadWithDedup(fixture: Fixture, bucket: string, key: string, body: string | Buffer): Promise<"uploaded" | "exists"> {
  try {
    await fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return "exists";
  } catch (error: any) {
    assert.equal(error?.$metadata?.httpStatusCode, 404, String(error));
  }
  await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ServerSideEncryption: "AES256" }));
  return "uploaded";
}

function zipDirectory(directory: string, files: Record<string, string> = {}): Buffer {
  const entries: Array<{ name: string; content: string | Buffer }> = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else { const relativeName = relative(directory, path).split("\\").join("/"); entries.push({ name: relativeName, content: files[relativeName] ?? readFileSync(path) }); }
    }
  };
  walk(directory);
  return createZip(entries);
}

let changeSetCounter = 0;

/**
 * `sam deploy --resolve-s3` (and the deploy that `sam deploy --guided` runs):
 * manage_stack, package each artifact into the managed bucket as <md5>, upload
 * the packaged template as <md5>.template, CreateChangeSet with the path-style
 * TemplateURL built from the S3 client's endpoint URL, wait, execute.
 */
async function samDeployResolveS3(fixture: Fixture, stackName: string, template: string, artifacts: Record<string, Buffer>): Promise<{ bucket: string; result: "deployed" | "no-changes"; templateKey: string; artifactKeys: string[] }> {
  const bucket = await manageStack(fixture);
  let packaged = template;
  const artifactKeys: string[] = [];
  for (const [placeholder, artifact] of Object.entries(artifacts)) {
    const key = md5(artifact);
    artifactKeys.push(key);
    await uploadWithDedup(fixture, bucket, key, artifact);
    packaged = packaged.replaceAll(placeholder, `s3://${bucket}/${key}`);
  }
  const templateKey = `${md5(packaged)}.template`;
  await uploadWithDedup(fixture, bucket, templateKey, packaged);
  let changeSetType: "CREATE" | "UPDATE" = "UPDATE";
  try {
    await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (error: any) {
    if (error?.message !== `Stack with id ${stackName} does not exist`) throw error;
    changeSetType = "CREATE";
  }
  const created = await fixture.cloudformation.send(new CreateChangeSetCommand({
    StackName: stackName,
    ChangeSetName: `samcli-deploy${Date.now()}${changeSetCounter++}`,
    ChangeSetType: changeSetType,
    TemplateURL: `https://127.0.0.1:${fixture.simulator.s3TlsPort}/${bucket}/${templateKey}`,
    Capabilities: ["CAPABILITY_IAM"],
    Parameters: [],
    Tags: [],
    Description: "Created by SAM CLI",
  }));
  const changeSet = await fixture.cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: created.Id }));
  if (changeSet.Status === "FAILED") {
    if (/didn't contain changes|No updates are to be performed/.test(changeSet.StatusReason ?? "")) return { bucket, result: "no-changes", templateKey, artifactKeys };
    throw new Error(`Change set failed: ${changeSet.StatusReason}`);
  }
  assert.equal(changeSet.Status, "CREATE_COMPLETE");
  await fixture.cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: created.Id }));
  const waiter = changeSetType === "CREATE" ? waitUntilStackCreateComplete : waitUntilStackUpdateComplete;
  const result = await waiter({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName });
  assert.equal(result.state, "SUCCESS", JSON.stringify(result.reason));
  return { bucket, result: "deployed", templateKey, artifactKeys };
}

/**
 * samcli/commands/delete/delete_context.py `delete`: read the Original
 * template, delete each artifact it names and <md5(template)>.template
 * (HeadObject then DeleteObject), then DeleteStack. The managed stack is never touched.
 */
async function samDelete(fixture: Fixture, stackName: string): Promise<void> {
  const template = String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }))).TemplateBody);
  const locations = [...template.matchAll(/s3:\/\/([a-z0-9.-]+)\/([A-Za-z0-9._-]+)/g)].map(match => ({ bucket: match[1], key: match[2] }));
  assert.ok(locations.length, "the packaged template names its artifacts");
  const bucket = locations[0].bucket;
  for (const key of [...new Set(locations.map(location => location.key)), `${md5(template)}.template`]) {
    await fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    await fixture.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  await fixture.cloudformation.send(new DeleteStackCommand({ StackName: stackName }));
  assert.equal((await waitUntilStackDeleteComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName })).state, "SUCCESS");
}

function invoke(simulator: StackSim, apiId: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const port = simulator.invokePort;
    const outgoing = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `${apiId}.execute-api.localhost:${port}` } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** The leaf certificate the HTTPS endpoint presents. */
function peerCertificate(port: number, ca: string): Promise<X509Certificate> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest({ host: "127.0.0.1", port, path: "/_stacksim/health", ca, agent: false }, response => {
      const certificate = (response.socket as import("node:tls").TLSSocket).getPeerX509Certificate();
      response.resume();
      response.on("end", () => certificate ? resolvePromise(certificate) : reject(new Error("no peer certificate")));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function normalizedStatements(document: PolicyDocument): string[] {
  const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement];
  return statements.map(statement => JSON.stringify(Object.fromEntries(Object.entries(statement as unknown as Record<string, unknown>)
    .map(([key, value]): [string, unknown] => [key, Array.isArray(value) ? [...value].sort() : value])
    .sort(([left], [right]) => left.localeCompare(right))))).sort();
}

test("SAM-05: the unmodified SAM CLI managed stack deploys, sam deploy --resolve-s3 packages over HTTPS, plain HTTP is denied, sam delete keeps the managed stack, and restart keeps the bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam05-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let fixture: Fixture | undefined;
  try {
    await simulator.start();
    fixture = await open(simulator);

    // --- The managed stack, created exactly as the SAM CLI creates it.
    const events: string[] = [];
    const bucket = await manageStack(fixture, events);
    assert.deepEqual(events, ["created"]);
    assert.match(bucket, /^aws-sam-cli-managed-default-samclisourcebucket-[a-z0-9]+$/);
    const managed = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: SAM_CLI_STACK_NAME }))).Stacks![0];
    assert.equal(managed.StackStatus, "CREATE_COMPLETE");
    assert.deepEqual(managed.Outputs?.map(output => [output.OutputKey, output.OutputValue]), [["SourceBucket", bucket]]);
    assert.equal(managed.Description, "Managed Stack for AWS SAM CLI");
    const processed = JSON.parse(String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: SAM_CLI_STACK_NAME, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(processed.Transform, undefined, "the SAM transform expands the managed template to itself");
    assert.deepEqual(Object.keys(processed.Resources).sort(), ["SamCliSourceBucket", "SamCliSourceBucketBucketPolicy"]);
    assert.equal(processed.Metadata.SamCliInfo.version, "1.169.0");
    assert.equal(String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: SAM_CLI_STACK_NAME, TemplateStage: "Original" }))).TemplateBody), samCliManagedTemplate());

    // The bucket truthfully reports the template's configuration.
    const encryption = await fixture.s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
    assert.deepEqual(encryption.ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault, { SSEAlgorithm: "aws:kms" }, "GetBucketEncryption echoes the configuration: aws:kms with no key ID");
    assert.equal((await fixture.s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status, "Enabled");
    assert.deepEqual((await fixture.s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))).PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true });
    assert.equal((await fixture.s3.send(new GetBucketTaggingCommand({ Bucket: bucket }))).TagSet?.find(tag => tag.Key === "ManagedStackSource")?.Value, "AwsSamCli");
    const policy = JSON.parse(String((await fixture.s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy)) as PolicyDocument;
    assert.equal(policy.Version, undefined);
    assert.deepEqual(normalizedStatements(policy), normalizedStatements({ Statement: [
      { Action: ["s3:GetObject"], Effect: "Allow", Resource: `arn:aws:s3:::${bucket}/*`, Principal: { Service: "serverlessrepo.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": accountId } } },
      { Action: ["s3:*"], Effect: "Deny", Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`], Principal: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } },
    ] } as PolicyDocument));

    // --- sam deploy --resolve-s3: the Hello World quick start through the managed bucket over HTTPS.
    const directory = join(quickstarts, "hello-world");
    const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n").replace("CodeUri: hello-world/", "CodeUri: __HELLO_WORLD_CODE__");
    const code = zipDirectory(join(directory, "hello-world"));
    const deployed = await samDeployResolveS3(fixture, "sam-app", template, { __HELLO_WORLD_CODE__: code });
    assert.equal(deployed.result, "deployed");
    assert.equal(deployed.bucket, bucket);
    assert.deepEqual(events, ["created"], "manage_stack found nothing to create the second time");
    const apiId = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: "sam-app" }))).Stacks![0].Outputs!.find(output => output.OutputKey === "HelloWorldApi")!.OutputValue!.match(/^https:\/\/([a-z0-9]+)\./)![1];
    const response = await invoke(simulator, apiId, "/Prod/hello/");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { message: "hello world" });

    // The SAM CLI's explicit ServerSideEncryption=AES256 overrides the bucket default, as on AWS.
    const artifactHead = await fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: deployed.artifactKeys[0] }));
    assert.equal(artifactHead.ServerSideEncryption, "AES256");
    assert.ok(artifactHead.VersionId, "the managed bucket is versioned");

    // An unchanged redeploy finds every artifact by HeadObject and reports no changes.
    assert.equal((await samDeployResolveS3(fixture, "sam-app", template, { __HELLO_WORLD_CODE__: code })).result, "no-changes");

    // --- SSE-KMS with the AWS managed key aws/s3.
    const kmsPut = await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "kms/default.txt", Body: "bucket default" }));
    assert.equal(kmsPut.ServerSideEncryption, "aws:kms");
    const managedKeyArn = kmsPut.SSEKMSKeyId!;
    assert.match(managedKeyArn, new RegExp(`^arn:aws:kms:${region}:${accountId}:key/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
    const kmsHead = await fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "kms/default.txt" }));
    assert.equal(kmsHead.ServerSideEncryption, "aws:kms");
    assert.equal(kmsHead.SSEKMSKeyId, managedKeyArn);
    const kmsGet = await fixture.s3.send(new GetObjectCommand({ Bucket: bucket, Key: "kms/default.txt" }));
    assert.equal(kmsGet.SSEKMSKeyId, managedKeyArn);
    assert.equal(await kmsGet.Body!.transformToString(), "bucket default", "decrypt is implicit for an authorized caller in the key's account");
    for (const keyId of ["alias/aws/s3", `arn:aws:kms:${region}:${accountId}:alias/aws/s3`, managedKeyArn, managedKeyArn.split("/").pop()!]) {
      const explicit: PutObjectCommandOutput = await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "kms/explicit.txt", Body: keyId, ServerSideEncryption: "aws:kms", SSEKMSKeyId: keyId }));
      assert.equal(explicit.SSEKMSKeyId, managedKeyArn, `${keyId} names the AWS managed key`);
    }
    await assert.rejects(fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "kms/customer.txt", Body: "x", ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/my-app-key" })),
      (error: any) => error.name === "KMS.NotFoundException" && /customer managed KMS keys are not supported/.test(error.message));
    await assert.rejects(fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "kms/dsse.txt", Body: "x", ServerSideEncryption: "aws:kms:dsse" })),
      (error: any) => error.name === "KMS.NotFoundException" && /DSSE-KMS/.test(error.message));
    await assert.rejects(fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "kms/customer.txt" })), (error: any) => error.$metadata?.httpStatusCode === 404, "a refused write stores nothing");
    const multipart = await fixture.s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: "kms/multipart.bin" }));
    assert.equal(multipart.ServerSideEncryption, "aws:kms");
    assert.equal(multipart.SSEKMSKeyId, managedKeyArn);
    await fixture.s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: "kms/multipart.bin", UploadId: multipart.UploadId }));

    // --- Plain HTTP to the managed bucket is truthfully denied, and the error names the HTTPS endpoint.
    const tlsDenied = (error: any) => error.name === "AccessDeniedException"
      && /aws:SecureTransport/.test(error.message)
      && error.message.includes(`https://127.0.0.1:${simulator.s3TlsPort}`);
    await assert.rejects(fixture.s3Http.send(new PutObjectCommand({ Bucket: bucket, Key: "plain-http.txt", Body: "x", ServerSideEncryption: "AES256" })), tlsDenied);
    await assert.rejects(fixture.s3Http.send(new GetObjectCommand({ Bucket: bucket, Key: deployed.artifactKeys[0] })), tlsDenied);
    await assert.rejects(fixture.s3Http.send(new ListObjectsV2Command({ Bucket: bucket })), tlsDenied);
    await assert.rejects(fixture.s3Http.send(new HeadObjectCommand({ Bucket: bucket, Key: deployed.artifactKeys[0] })), (error: any) => error.$metadata?.httpStatusCode === 403);
    await assert.rejects(fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "plain-http.txt" })), (error: any) => error.$metadata?.httpStatusCode === 404, "the denied write stored nothing");
    // Buckets without the TLS-only statement still serve plain HTTP.
    await fixture.s3Http.send(new CreateBucketCommand({ Bucket: "ordinary-http-bucket" }));
    await fixture.s3Http.send(new PutObjectCommand({ Bucket: "ordinary-http-bucket", Key: "ok.txt", Body: "ok" }));

    // IAM enforcement stays on over HTTPS: a user without S3 permissions is denied.
    await fixture.iam.send(new CreateUserCommand({ UserName: "no-s3" }));
    const key = (await fixture.iam.send(new CreateAccessKeyCommand({ UserName: "no-s3" }))).AccessKey!;
    const unprivileged = new S3Client({ endpoint: `https://127.0.0.1:${simulator.s3TlsPort}`, region, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! }, maxAttempts: 1, requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ ca: fixture.ca }) }) });
    fixture.clients.push(unprivileged);
    await assert.rejects(unprivileged.send(new GetObjectCommand({ Bucket: bucket, Key: "kms/default.txt" })), (error: any) => error.name === "AccessDeniedException" && !/aws:SecureTransport/.test(error.message));

    // --- Virtual-hosted style over HTTPS: <bucket>.s3.localhost under the *.s3.localhost certificate name.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: "127.0.0.1", family: 4 }]);
      else (callback as (error: null, address: string, family: number) => void)(null, "127.0.0.1", 4);
    };
    const virtual = new S3Client({ endpoint: `https://s3.localhost:${simulator.s3TlsPort}`, region, credentials, maxAttempts: 1, requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ ca: fixture.ca, lookup }) }) });
    fixture.clients.push(virtual);
    const hosts: string[] = [];
    virtual.middlewareStack.add(next => async args => { hosts.push(String((args.request as { hostname?: string }).hostname)); return next(args); }, { step: "finalizeRequest", name: "recordHost" });
    assert.equal(await (await virtual.send(new GetObjectCommand({ Bucket: bucket, Key: "kms/default.txt" }))).Body!.transformToString(), "bucket default");
    await virtual.send(new PutObjectCommand({ Bucket: bucket, Key: "kms/virtual.txt", Body: "virtual" }));
    assert.deepEqual([...new Set(hosts)], [`${bucket}.s3.localhost`]);
    assert.equal(await (await fixture.s3.send(new GetObjectCommand({ Bucket: bucket, Key: "kms/virtual.txt" }))).Body!.transformToString(), "virtual");

    // --- sam delete removes the application stack and its artifacts, and leaves the managed stack.
    await samDelete(fixture, "sam-app");
    await assert.rejects(fixture.cloudformation.send(new DescribeStacksCommand({ StackName: "sam-app" })), (error: any) => error.message === "Stack with id sam-app does not exist");
    assert.equal((await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: SAM_CLI_STACK_NAME }))).Stacks![0].StackStatus, "CREATE_COMPLETE");
    for (const deletedKey of [...deployed.artifactKeys, deployed.templateKey]) {
      await assert.rejects(fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: deletedKey })), (error: any) => error.$metadata?.httpStatusCode === 404);
    }

    // --- Restart keeps the managed stack, the bucket, its encryption, its policy, the key, and the certificate.
    const leaf = await peerCertificate(simulator.s3TlsPort, fixture.ca);
    assert.ok(leaf.checkHost("s3.localhost") && leaf.checkHost(`${bucket}.s3.localhost`) && leaf.checkIP("127.0.0.1"));
    assert.ok(leaf.verify(new X509Certificate(fixture.ca).publicKey), "the installation CA issues the HTTPS endpoint's certificate");
    close(fixture);
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    fixture = await open(simulator);
    assert.equal(fixture.ca, (await fetchCa(simulator)));
    assert.equal((await peerCertificate(simulator.s3TlsPort, fixture.ca)).fingerprint256, leaf.fingerprint256, "the S3 certificate is persisted, not reissued");
    const restartEvents: string[] = [];
    assert.equal(await manageStack(fixture, restartEvents), bucket);
    assert.deepEqual(restartEvents, ["found"]);
    assert.deepEqual((await fixture.s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }))).ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault, { SSEAlgorithm: "aws:kms" });
    assert.deepEqual(normalizedStatements(JSON.parse(String((await fixture.s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy))), normalizedStatements(policy));
    assert.equal((await fixture.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "kms/default.txt" }))).SSEKMSKeyId, managedKeyArn, "the AWS managed key ID is stable across restarts");
    await assert.rejects(fixture.s3Http.send(new GetObjectCommand({ Bucket: bucket, Key: "kms/default.txt" })), tlsDenied);
    assert.equal(await (await fixture.s3.send(new GetObjectCommand({ Bucket: bucket, Key: "kms/default.txt" }))).Body!.transformToString(), "bucket default");
    // A second application deploys through the existing managed stack after restart.
    assert.equal((await samDeployResolveS3(fixture, "sam-app-2", template, { __HELLO_WORLD_CODE__: code })).result, "deployed");
  } finally {
    if (fixture) close(fixture);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SAM-05: AWS managed key reads are same-account only, and the providers admit only the aws/s3 key and the managed bucket-policy profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam05-providers-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const owner = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    clients.push(owner);

    // The bucket default with aws:kms applies to plain PutObject.
    const bucket = "sam05-kms-cross-account";
    await owner.send(new CreateBucketCommand({ Bucket: bucket }));
    await owner.send(new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: "alias/aws/s3" } }] } }));
    assert.equal((await owner.send(new GetBucketEncryptionCommand({ Bucket: bucket }))).ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID, "alias/aws/s3", "GetBucketEncryption echoes the configured identifier");
    const put = await owner.send(new PutObjectCommand({ Bucket: bucket, Key: "shared/kms.txt", Body: "kms" }));
    assert.equal(put.ServerSideEncryption, "aws:kms");
    await owner.send(new PutObjectCommand({ Bucket: bucket, Key: "shared/sse-s3.txt", Body: "sse-s3", ServerSideEncryption: "AES256" }));

    // A cross-account principal allowed by both policies reads the SSE-S3 object, but cannot use the AWS managed key.
    const externalAccount = "111122223333"; const roleName = "ExternalReader"; const roleArn = `arn:aws:iam::${externalAccount}:role/${roleName}`;
    const accessKeyId = "ASIASAM05EXTERNAL"; const secretAccessKey = "external-secret"; const sessionToken = "external-session";
    const externalIam = simulator.store.ensureAccount(externalAccount).iam;
    externalIam.roles[roleName] = {
      roleName, roleId: "AROASAM05EXTERNAL", arn: roleArn, path: "/", createDate: Date.now(), maxSessionDuration: 3600,
      assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${externalAccount}:root` }, Action: "sts:AssumeRole" }] },
      tags: {}, attachedPolicyArns: [], inlinePolicies: { s3: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/shared/*` }] } },
    };
    await simulator.store.credentialStore!.put({ credentialId: "sam05-external", type: "sts-session", accountId: externalAccount, ownerId: "AROASAM05EXTERNAL:developer", accessKeyId }, { secretAccessKey, sessionToken });
    externalIam.sessions[accessKeyId] = { accessKeyId, credentialId: "sam05-external", principalArn: `arn:aws:sts::${externalAccount}:assumed-role/${roleName}/developer`, principalId: "AROASAM05EXTERNAL:developer", roleArn, roleName, sessionName: "developer", expiration: Date.now() + 60_000, sessionTags: {} };
    await simulator.store.save();
    await owner.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/shared/*` }] }) }));
    const external = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId, secretAccessKey, sessionToken } });
    clients.push(external);
    assert.equal(await (await external.send(new GetObjectCommand({ Bucket: bucket, Key: "shared/sse-s3.txt" }))).Body!.transformToString(), "sse-s3");
    await assert.rejects(external.send(new GetObjectCommand({ Bucket: bucket, Key: "shared/kms.txt" })), (error: any) => error.name === "AccessDenied" && /AWS managed key aws\/s3 of account 000000000000/.test(error.message));
    assert.equal(await (await owner.send(new GetObjectCommand({ Bucket: bucket, Key: "shared/kms.txt" }))).Body!.transformToString(), "kms");

    // Anonymous website requests and a CloudFront OAC origin cannot use the AWS managed key either, as on AWS.
    const site = "sam05-kms-website";
    const distributionArn = `arn:aws:cloudfront::${accountId}:distribution/E2SAM05EXAMPLE`;
    await owner.send(new CreateBucketCommand({ Bucket: site }));
    await owner.send(new PutPublicAccessBlockCommand({ Bucket: site, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
    await owner.send(new PutBucketWebsiteCommand({ Bucket: site, WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" } } }));
    await owner.send(new PutBucketPolicyCommand({ Bucket: site, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${site}/*` },
      { Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${site}/*`, Condition: { StringEquals: { "AWS:SourceArn": distributionArn } } },
    ] }) }));
    await owner.send(new PutObjectCommand({ Bucket: site, Key: "sse-s3.html", Body: "sse-s3", ServerSideEncryption: "AES256" }));
    await owner.send(new PutObjectCommand({ Bucket: site, Key: "kms.html", Body: "kms", ServerSideEncryption: "aws:kms" }));
    const websiteUrl = (key: string) => `http://127.0.0.1:${simulator.port}/_stacksim/s3-website/${site}/${key}`;
    assert.equal((await fetch(websiteUrl("sse-s3.html"))).status, 200);
    assert.equal((await fetch(websiteUrl("kms.html"))).status, 403);
    const origin = simulator.s3.createCloudFrontOriginPort();
    const originRequest = (key: string) => origin.request({ accountId, bucketRegion: region, bucketName: site, key, distributionArn, method: "GET", headers: {}, maximumBytes: 1024 });
    assert.equal((await originRequest("sse-s3.html")).status, 200);
    await assert.rejects(originRequest("kms.html"), (error: any) => error.code === "AccessDenied");

    // AWS::S3::Bucket admits the aws/s3 forms and string booleans; customer keys and DSSE fail before mutation.
    const context = (logicalId: string): ProviderContext => ({ accountId, region, partition: "aws", stackName: "providers", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/providers/1`, logicalId } as unknown as ProviderContext);
    const bucketProvider = createS3BucketProvider(simulator.s3);
    const managedKeyArn = simulator.s3.awsManagedKeyArn({ ownerAccountId: accountId, region });
    const withKey = (SSEAlgorithm: string, KMSMasterKeyID?: string) => ({
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm, ...(KMSMasterKeyID === undefined ? {} : { KMSMasterKeyID }) } }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: "true", IgnorePublicAcls: "TRUE", BlockPublicPolicy: true, RestrictPublicBuckets: "false" },
    });
    for (const accepted of [undefined, "alias/aws/s3", `arn:aws:kms:${region}:${accountId}:alias/aws/s3`, managedKeyArn, managedKeyArn.split("/").pop()]) {
      assert.deepEqual(bucketProvider.validate(withKey("aws:kms", accepted), context("Bucket")), [], String(accepted));
    }
    const canonical = bucketProvider.canonicalize(withKey("aws:kms"), context("Bucket"));
    assert.deepEqual(canonical.BucketEncryption, { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" } }] });
    assert.deepEqual(canonical.PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: false });
    for (const [rejected, path] of [
      [withKey("aws:kms", "alias/my-app-key"), "KMSMasterKeyID"],
      [withKey("aws:kms", `arn:aws:kms:${region}:${accountId}:key/11111111-2222-4333-8444-555555555555`), "KMSMasterKeyID"],
      [withKey("aws:kms", `arn:aws:kms:us-east-1:${accountId}:alias/aws/s3`), "KMSMasterKeyID"],
      [withKey("aws:kms:dsse"), "SSEAlgorithm"],
      [withKey("AES256", "alias/aws/s3"), "KMSMasterKeyID"],
    ] as const) {
      const issues = bucketProvider.validate(rejected, context("Bucket"));
      assert.ok(issues.some(item => item.path.endsWith(path)), `${JSON.stringify(rejected.BucketEncryption)} must fail at ${path}: ${JSON.stringify(issues)}`);
    }
    assert.ok(bucketProvider.validate({ PublicAccessBlockConfiguration: { BlockPublicAcls: "yes" } }, context("Bucket")).some(item => item.path.endsWith("BlockPublicAcls")));

    // AWS::S3::BucketPolicy admits exactly the managed two-statement profile.
    const policyProvider = createS3BucketPolicyProvider(simulator.s3);
    const managedPolicy = (overrides: { sourceAccount?: string; version?: string; service?: string; principal?: unknown } = {}) => ({
      Bucket: "managed-bucket",
      PolicyDocument: {
        ...(overrides.version ? { Version: overrides.version } : {}),
        Statement: [
          { Action: ["s3:GetObject"], Effect: "Allow", Resource: "arn:aws:s3:::managed-bucket/*", Principal: { Service: overrides.service ?? "serverlessrepo.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": overrides.sourceAccount ?? accountId } } },
          { Action: ["s3:*"], Effect: "Deny", Resource: ["arn:aws:s3:::managed-bucket", "arn:aws:s3:::managed-bucket/*"], Principal: overrides.principal ?? "*", Condition: { Bool: { "aws:SecureTransport": "false" } } },
        ],
      },
    });
    assert.deepEqual(policyProvider.validate(managedPolicy(), context("Policy")), []);
    assert.deepEqual(policyProvider.validate(managedPolicy({ version: "2012-10-17", principal: { AWS: "*" } }), context("Policy")), []);
    assert.ok(policyProvider.validate(managedPolicy({ sourceAccount: "111122223333" }), context("Policy")).some(item => item.path.endsWith(".Condition")));
    assert.ok(policyProvider.validate(managedPolicy({ version: "2008-10-17" }), context("Policy")).some(item => item.path.endsWith(".Version")));
    assert.ok(policyProvider.validate(managedPolicy({ service: "lambda.amazonaws.com" }), context("Policy")).length > 0);
    assert.ok(policyProvider.validate(managedPolicy({ principal: { AWS: "arn:aws:iam::000000000000:root" } }), context("Policy")).length > 0);
    const onlyRepository = managedPolicy(); (onlyRepository.PolicyDocument.Statement as unknown[]).pop();
    assert.ok(policyProvider.validate(onlyRepository, context("Policy")).some(item => item.path.endsWith(".Statement")), "the serverlessrepo grant is admitted only with the TLS-only deny");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the HTTPS S3 port defaults to 4569 only when the caller does not choose the main port", { skip: process.env.STACKSIM_S3_TLS_PORT !== undefined && "STACKSIM_S3_TLS_PORT is set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam05-tls-port-"));
  try {
    // The CLI passes no port, so its HTTPS endpoint stays at the documented 4569.
    assert.equal(new StackSim({ dataDir: root, region }).s3TlsPort, 4569);
    // An embedded simulator that chooses its ports (tests restart on theirs) takes a free
    // HTTPS port, so concurrent simulators never contend for 4569.
    assert.equal(new StackSim({ port: 45_660, invokePort: 0, dataDir: root, region }).s3TlsPort, 0);
    assert.equal(new StackSim({ port: 0, invokePort: 0, dataDir: root, region }).s3TlsPort, 0);
    assert.equal(new StackSim({ port: 45_660, s3TlsPort: 45_690, dataDir: root, region }).s3TlsPort, 45_690);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
