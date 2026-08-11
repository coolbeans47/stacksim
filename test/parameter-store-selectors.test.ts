import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function rejectsAs(work: Promise<unknown>, name: string, absent?: string): Promise<void> {
  await assert.rejects(work, (error: any) => {
    assert.equal(error.name, name);
    if (absent) assert.doesNotMatch(String(error.message), new RegExp(absent));
    return true;
  });
}

test("DUG-03 parameter selectors fail closed without current-version or value fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug03-selectors-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new PutParameterCommand({ Name: "/selectors/plain", Type: "String", Value: "plain-v1" }));
    await client.send(new PutParameterCommand({ Name: "/selectors/plain", Type: "String", Value: "plain-v2", Overwrite: true }));
    const secret = `selector-secret-${crypto.randomUUID()}`;
    await client.send(new PutParameterCommand({ Name: "/selectors/secure", Type: "SecureString", Value: secret }));

    assert.equal((await client.send(new GetParameterCommand({ Name: "/selectors/plain" }))).Parameter?.Value, "plain-v2");
    assert.equal((await client.send(new GetParameterCommand({ Name: "/selectors/plain:1" }))).Parameter?.Value, "plain-v1");
    const arn = `arn:aws:ssm:${region}:000000000000:parameter/selectors/plain`;
    assert.equal((await client.send(new GetParameterCommand({ Name: `${arn}:2` }))).Parameter?.Value, "plain-v2");
    assert.equal((await client.send(new GetParameterCommand({ Name: "/selectors/secure:1", WithDecryption: true }))).Parameter?.Value, secret);
    assert.notEqual((await client.send(new GetParameterCommand({ Name: "/selectors/secure:1" }))).Parameter?.Value, secret);

    await rejectsAs(client.send(new GetParameterCommand({ Name: "/selectors/plain:production" })), "ParameterNotFound");
    await rejectsAs(client.send(new GetParameterCommand({ Name: `${arn}:release.1` })), "ParameterNotFound");
    await rejectsAs(client.send(new GetParameterCommand({ Name: "/selectors/missing:production" })), "ParameterNotFound");
    await rejectsAs(client.send(new GetParameterCommand({ Name: "/selectors/plain:99" })), "ParameterVersionNotFound");
    await rejectsAs(client.send(new GetParameterCommand({ Name: "/selectors/missing:99" })), "ParameterNotFound");
    await rejectsAs(client.send(new GetParameterCommand({ Name: "/selectors/secure:production", WithDecryption: true })), "ParameterNotFound", secret);

    for (const Name of ["", "/selectors/plain:", "/selectors/plain:0", "/selectors/plain:01", "/selectors/plain:123label", "/selectors/plain:awsCurrent", "/selectors/plain:ssmCurrent", "/selectors/plain:bad label", "/selectors/plain:one:two", `arn:aws:ssm:${region}:000000000000:parameter/selectors/plain:`]) {
      await rejectsAs(client.send(new GetParameterCommand({ Name })), "ValidationException", secret);
    }
    await rejectsAs(client.send(new GetParameterCommand({ Name: "arn:aws:ssm:eu-west-1:not-an-account:parameter/selectors/plain:1" })), "ValidationException", secret);

    const batchNames = [
      "/selectors/plain",
      "/selectors/plain:1",
      `${arn}:2`,
      "/selectors/secure:1",
      "/selectors/plain:production",
      "/selectors/plain:99",
      "/selectors/missing",
      "/selectors/plain:",
      "",
      "arn:aws:ssm:eu-west-1:not-an-account:parameter/selectors/plain:1",
    ];
    const batch = await client.send(new GetParametersCommand({ Names: batchNames, WithDecryption: true }));
    assert.deepEqual(batch.Parameters?.map(parameter => [parameter.Name, parameter.Version, parameter.Value]).sort((left, right) => String(left).localeCompare(String(right))), [
      ["/selectors/plain", 1, "plain-v1"],
      ["/selectors/plain", 2, "plain-v2"],
      ["/selectors/plain", 2, "plain-v2"],
      ["/selectors/secure", 1, secret],
    ].sort((left, right) => String(left).localeCompare(String(right))));
    assert.deepEqual(batch.InvalidParameters, batchNames.slice(4));

    for (const Names of [undefined, [], Array.from({ length: 11 }, (_, index) => `/selectors/${index}`), ["/selectors/plain", 7]]) {
      await rejectsAs(client.send(new GetParametersCommand({ Names } as any)), "ValidationException", secret);
    }

    await client.send(new PutParameterCommand({ Name: "/selectors/pruned", Type: "String", Value: "v1" }));
    for (let version = 2; version <= 101; version++) await client.send(new PutParameterCommand({ Name: "/selectors/pruned", Type: "String", Value: `v${version}`, Overwrite: true }));
    await rejectsAs(client.send(new GetParameterCommand({ Name: "/selectors/pruned:1" })), "ParameterVersionNotFound");
    assert.equal((await client.send(new GetParameterCommand({ Name: "/selectors/pruned:2" }))).Parameter?.Value, "v2");
    const prunedBatch = await client.send(new GetParametersCommand({ Names: ["/selectors/pruned:1", "/selectors/pruned:2"] }));
    assert.deepEqual(prunedBatch.Parameters?.map(parameter => [parameter.Name, parameter.Version, parameter.Value]), [["/selectors/pruned", 2, "v2"]]);
    assert.deepEqual(prunedBatch.InvalidParameters, ["/selectors/pruned:1"]);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
