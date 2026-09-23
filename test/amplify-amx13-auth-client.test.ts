import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCognitoCloudFormationProviders } from "../src/cloudformation/providers/cognito.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function context(logicalId: string): ProviderContext {
  return { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/amx13/direct-client`,
    logicalId, operationId: "amx13-client", resourceOperationId: `amx13-client-${logicalId}`, idempotencyKey: `amx13-client-${logicalId}`,
    deadlineAt: Date.now() + 60_000, principal: { identity: { ...credentials, principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId } } };
}

test("AMX-13 unmodified Amplify Auth signs up, confirms through SES, uses SRP, refreshes and signs out against direct generated resources", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx13-auth-client-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, region, dataDir: join(root, "state"), authMode: "enforce" });
  try {
    await simulator.start();
    const frozen = JSON.parse(await readFile(resolve("test/fixtures/amplify-gen2-auth-email/evidence/templates/auth.json"), "utf8"));
    const resources = Object.values(frozen.Resources) as any[];
    const providers = createCognitoCloudFormationProviders(simulator.cognito);
    const pool = providers.find(provider => provider.typeName === "AWS::Cognito::UserPool")!;
    const client = providers.find(provider => provider.typeName === "AWS::Cognito::UserPoolClient")!;
    const created = await pool.create(pool.canonicalize(resources.find(item => item.Type === pool.typeName).Properties, context("Pool")), context("Pool"));
    assert.equal(created.status, "SUCCESS");
    if (created.status !== "SUCCESS") return;
    const poolId = String(pool.ref(created.model));
    const clientCreated = await client.create(client.canonicalize({ ...resources.find(item => item.Type === client.typeName).Properties, UserPoolId: poolId }, context("Client")), context("Client"));
    assert.equal(clientCreated.status, "SUCCESS");
    if (clientCreated.status !== "SUCCESS") return;
    const output = join(root, "amplify_outputs.json");
    await writeFile(output, JSON.stringify({ version: "1.4", auth: { aws_region: region, user_pool_id: poolId,
      user_pool_client_id: String(client.ref(clientCreated.model)), username_attributes: ["email"], user_verification_types: ["email"] } }));
    const actions: string[] = [];
    const server = (simulator as any).control;
    assert.ok(server, "Observe the actual regional SDK requests");
    server.prependListener("request", (request: any) => {
      const target = request.headers["x-amz-target"];
      if (typeof target === "string") actions.push(target.split(".").at(-1)!);
    });
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^AWS_/i.test(key) || /^(?:http|https|all)_proxy$/i.test(key)) delete environment[key];
    environment.NODE_OPTIONS = `--require=${JSON.stringify(resolve("test/fixtures/cdk/network-tripwire.cjs"))}`;
    environment.STACKSIM_NETWORK_ALLOW_PORT = String(simulator.port);
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const evidence = await new Promise<any>((done, fail) => {
      // A child keeps Amplify's global Auth storage/config isolated from other tests.
      const child = spawn(process.execPath, [resolve("scripts/exercise-amplify-auth.mjs"), output, endpoint, "auth", "direct"],
        { cwd: resolve("."), env: environment, shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let result: any;
      const timer = setTimeout(() => { child.kill(); fail(new Error("Direct Amplify Auth client timed out")); }, 30_000);
      child.on("message", async (message: any) => {
        if (message.type === "evidence") result = message.evidence;
        if (message.type === "confirmation") {
          try {
            const read = async (path: string) => {
              const response = await signedFetch(`${endpoint}${path}`, { service: "ses", region, credentials, headers: { "x-stacksim-region": region } });
              assert.equal(response.status, 200);
              return response.json() as Promise<any>;
            };
            const inbox = await read(`/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(message.username)}&status=all&pageSize=100`);
            const mail = await read(`/_stacksim/api/ses/inbox/${encodeURIComponent(inbox.messages[0].messageId)}`);
            const code = /\b(\d{6})\b/.exec(mail.message.textBody)?.[1];
            assert.ok(code);
            child.send({ code });
          } catch { if (child.connected) child.send({ error: true }); }
        }
      });
      child.once("error", error => { clearTimeout(timer); fail(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 && result ? done(result) : fail(new Error(`Direct Amplify Auth client failed (${code})`)); });
    });
    for (const name of ["confirmSignUp", "srpSignIn", "refresh", "localSignOut"]) assert.equal(evidence[name], true, name);
    for (const name of ["SignUp", "ConfirmSignUp", "InitiateAuth", "RespondToAuthChallenge", "RevokeToken"]) assert.ok(actions.includes(name), `${name} used the real SDK route`);
    assert.ok(actions.includes("GetTokensFromRefreshToken") || actions.filter(action => action === "InitiateAuth").length >= 2,
      "The generated rotation configuration selects the real refresh operation");
    assert.deepEqual(simulator.store.regionState(region).cognitoIdentity.pools, {}, "Direct User Pool Auth needs no Identity Pool");
    assert.deepEqual(simulator.store.ensureAccount().iam.sessions, {}, "User Pool Auth does not issue AWS credentials");
  } finally { await simulator.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
