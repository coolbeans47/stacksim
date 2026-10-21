import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateFunctionCommand, InvokeCommand, LambdaClient, waitUntilFunctionActiveV2 } from "@aws-sdk/client-lambda";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("ES module handlers import the runtime's AWS SDK v3, and a missing dependency names itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-esm-sdk-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    const create = async (name: string, source: string) => {
      await lambda!.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "src/handlers/app.handler", Code: { ZipFile: createZip([{ name: "src/handlers/app.mjs", content: source }]) } }));
      await waitUntilFunctionActiveV2({ client: lambda!, minDelay: 1, maxDelay: 1, maxWaitTime: 30 }, { FunctionName: name });
    };
    await create("esm-sdk", "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';\nexport const handler = async () => ({ client: typeof DynamoDBClient, document: typeof DynamoDBDocumentClient.from });\n");
    const ok = await lambda.send(new InvokeCommand({ FunctionName: "esm-sdk", Payload: Buffer.from("{}") }));
    assert.equal(ok.FunctionError, undefined, Buffer.from(ok.Payload ?? []).toString("utf8"));
    assert.deepEqual(JSON.parse(Buffer.from(ok.Payload!).toString("utf8")), { client: "function", document: "function" });

    await create("esm-missing", "import missing from 'not-packaged-dependency';\nexport const handler = async () => missing;\n");
    const failed = await lambda.send(new InvokeCommand({ FunctionName: "esm-missing", Payload: Buffer.from("{}") })).then(
      response => Buffer.from(response.Payload ?? []).toString("utf8"),
      (error: Error) => error.message,
    );
    assert.match(failed, /not-packaged-dependency/);
    assert.doesNotMatch(failed, /app\.cjs/);
  } finally {
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
