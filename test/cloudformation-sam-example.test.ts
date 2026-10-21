import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand, ExecuteChangeSetCommand, GetTemplateCommand, waitUntilStackCreateComplete, waitUntilStackUpdateComplete } from "@aws-sdk/client-cloudformation";
import { GetAliasCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// examples/sam-notes-api must keep deploying as its README describes:
// `aws cloudformation package` uploads src/ and rewrites CodeUri, then
// `aws cloudformation deploy` runs a change set with CAPABILITY_IAM.

const example = resolve("examples", "sam-notes-api");
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function packageSource(files: Record<string, string> = {}): Buffer {
  const directory = join(example, "src");
  return createZip(readdirSync(directory).filter(name => statSync(join(directory, name)).isFile()).sort().map(name => ({ name: relative(directory, join(directory, name)), content: files[name] ?? readFileSync(join(directory, name)) })));
}

function call(port: number, host: string, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host, ...(body ? { "content-type": "application/json" } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("examples/sam-notes-api deploys as its README describes, serves notes under IAM enforcement, and publishes a new version on a code change", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam-example-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const s3 = new S3Client({ ...options, forcePathStyle: true }); const lambda = new LambdaClient(options);
    clients.push(cloudformation, s3, lambda);
    await s3.send(new CreateBucketCommand({ Bucket: "sam-artifacts" }));
    const template = readFileSync(join(example, "template.yaml"), "utf8").replaceAll("\r\n", "\n");
    assert.match(template, /^ {6}CodeUri: src\/$/m);

    const deploy = async (key: string, code: Buffer, changeSetType: "CREATE" | "UPDATE") => {
      await s3.send(new PutObjectCommand({ Bucket: "sam-artifacts", Key: key, Body: code }));
      const created = await cloudformation.send(new CreateChangeSetCommand({ StackName: "notes", ChangeSetName: `deploy-${key}`, ChangeSetType: changeSetType, TemplateBody: template.replace("CodeUri: src/", `CodeUri: s3://sam-artifacts/${key}`), Capabilities: ["CAPABILITY_IAM"] }));
      assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: created.Id }))).Status, "CREATE_COMPLETE");
      await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: created.Id }));
      const waiter = changeSetType === "CREATE" ? waitUntilStackCreateComplete : waitUntilStackUpdateComplete;
      assert.equal((await waiter({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: "notes" })).state, "SUCCESS");
    };
    await deploy("v1", packageSource(), "CREATE");

    const outputs = Object.fromEntries(((await cloudformation.send(new DescribeStacksCommand({ StackName: "notes" }))).Stacks![0].Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
    const local = new URL(outputs.LocalNotesUrl);
    assert.match(local.host, /^[a-z0-9]{10}\.execute-api\.localhost:4567$/);
    assert.equal(outputs.NotesUrl, `https://${local.hostname.split(".")[0]}.execute-api.${region}.amazonaws.com/notes`);
    assert.match(outputs.LiveAlias, /^arn:aws:lambda:eu-west-1:000000000000:function:.+:live$/);

    const host = local.hostname + `:${simulator.invokePort}`;
    assert.equal((await call(simulator.invokePort, host, "POST", "/notes", "not json")).status, 400);
    const created = await call(simulator.invokePort, host, "POST", "/notes", readFileSync(join(example, "note.json"), "utf8"));
    assert.equal(created.status, 201, created.body);
    assert.equal(JSON.parse(created.body).text, "buy milk");
    const listed = await call(simulator.invokePort, host, "GET", "/notes");
    assert.equal(listed.status, 200, listed.body);
    assert.deepEqual(JSON.parse(listed.body), [JSON.parse(created.body)]);

    const processed = JSON.parse(String((await cloudformation.send(new GetTemplateCommand({ StackName: "notes", TemplateStage: "Processed" }))).TemplateBody));
    assert.deepEqual(Object.keys(processed.Resources).map(id => id.replace(/[0-9a-f]{10}$/, "<hash>")).sort(), [
      "NotesFunction", "NotesFunctionAliaslive", "NotesFunctionCreateNotePermission", "NotesFunctionListNotesPermission", "NotesFunctionRole", "NotesFunctionVersion<hash>",
      "NotesTable", "ServerlessHttpApi", "ServerlessHttpApiApiGatewayDefaultStage",
    ]);

    // A code change publishes version 2 and moves the alias the routes invoke.
    const functionName = outputs.LiveAlias.split(":")[6];
    assert.equal((await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: "live" }))).FunctionVersion, "1");
    const changed = readFileSync(join(example, "src", "app.mjs"), "utf8").replace("createdAt.localeCompare(right.createdAt))", "createdAt.localeCompare(right.createdAt)).map(note => ({ ...note, version: 2 }))");
    await deploy("v2", packageSource({ "app.mjs": changed }), "UPDATE");
    assert.equal((await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: "live" }))).FunctionVersion, "2");
    assert.equal(JSON.parse((await call(simulator.invokePort, host, "GET", "/notes")).body)[0].version, 2);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
