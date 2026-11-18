import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { OpenSearchClient, CreateDomainCommand, DescribeDomainCommand, DeleteDomainCommand, ListDomainNamesCommand } from "@aws-sdk/client-opensearch";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../src/server.js";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const options = (root: string) => ({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" as const, cdkBootstrap: false });
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); }
  assert.fail("Resource did not reach its expected state");
}
function client(sim: StackSim, creds = credentials) { return new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: creds, maxAttempts: 1 }); }
async function active(sim: StackSim, name: string) { await until(() => sim.opensearch.domain(region, name).state === "active"); return sim.opensearch.domain(region, name); }

test("OS-01 failed activation releases its gateway; failed deletion stays visible and can be retried", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-lifecycle-")); const sim = new StackSim(options(root));
  let releaseFailureReport = () => {};
  try {
    await sim.start();
    const save = sim.store.save.bind(sim.store); let failActivation = true;
    sim.store.save = async () => {
      if (failActivation && sim.opensearch.domains(region).some(domain => domain.state === "active")) { failActivation = false; throw new Error("Injected publish failure"); }
      await save();
    };
    await sim.opensearch.execute("CreateDomain", { DomainName: "publish-failure" }, region);
    await until(() => sim.opensearch.domain(region, "publish-failure").state === "failed");
    const failed = sim.opensearch.domain(region, "publish-failure");
    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(failed.gatewayPort, "127.0.0.1", resolve); });
    await new Promise<void>(resolve => portProbe.close(() => resolve()));
    sim.store.save = save;
    await sim.opensearch.execute("CreateDomain", { DomainName: "delete-failure" }, region);
    const domain = await active(sim, "delete-failure"); const port = domain.gatewayPort;
    let failDelete = true;
    let failureReported!: () => void;
    const reported = new Promise<void>(resolve => { failureReported = resolve; });
    const reporting = new Promise<void>(resolve => { releaseFailureReport = resolve; });
    sim.store.save = async () => {
      if (failDelete && !sim.opensearch.domains(region).some(item => item.name === "delete-failure")) { failDelete = false; throw new Error("Injected cleanup commit failure"); }
      await save();
      if (domain.state === "deleting" && domain.failure) { failureReported(); await reporting; }
    };
    await sim.opensearch.execute("DeleteDomain", { DomainName: domain.name }, region);
    await reported;
    assert.equal(sim.opensearch.domain(region, domain.name).state, "deleting");
    assert.ok(JSON.parse(await readFile(sim.store.file, "utf8")).accounts[sim.store.accountId].regions[region].opensearch.domains[domain.name]);
    sim.store.save = save;
    // Retry while the failed job is still publishing its error. Accepting the
    // retry must schedule cleanup after that job finishes, not discard it.
    await sim.opensearch.execute("DeleteDomain", { DomainName: domain.name }, region);
    releaseFailureReport();
    await until(() => !sim.opensearch.domains(region).some(item => item.name === domain.name));
    await sim.opensearch.execute("CreateDomain", { DomainName: domain.name }, region);
    assert.notEqual((await active(sim, domain.name)).gatewayPort, port);
  } finally { releaseFailureReport(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("OS-01 restart fails missing/corrupt storage and an occupied lease without changing another domain", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-reconcile-")); let sim = new StackSim(options(root)); let blocker: ReturnType<typeof createServer> | undefined;
  try {
    await sim.start();
    for (const name of ["missing-storage", "corrupt-storage", "occupied-endpoint", "healthy-domain"]) { await sim.opensearch.execute("CreateDomain", { DomainName: name }, region); await active(sim, name); }
    const missing = sim.opensearch.domain(region, "missing-storage"), occupied = sim.opensearch.domain(region, "occupied-endpoint"), healthy = sim.opensearch.domain(region, "healthy-domain");
    await sim.stop();
    await rm(join(root, "data", "opensearch", missing.generation), { recursive: true, force: true });
    await writeFile(join(root, "data", "opensearch", sim.opensearch.domain(region, "corrupt-storage").generation, "search.sqlite"), "corrupt database fixture");
    blocker = createServer(); await new Promise<void>((resolve, reject) => { blocker!.once("error", reject); blocker!.listen(occupied.gatewayPort, "127.0.0.1", resolve); });
    sim = new StackSim(options(root)); await sim.start();
    assert.equal(sim.opensearch.domain(region, missing.name).state, "failed");
    assert.equal(sim.opensearch.domain(region, "corrupt-storage").state, "failed");
    assert.equal(sim.opensearch.domain(region, occupied.name).state, "failed");
    assert.equal(sim.opensearch.domain(region, occupied.name).gatewayPort, occupied.gatewayPort);
    assert.equal(sim.opensearch.domain(region, healthy.name).state, "active");
    await sim.stop(); await new Promise<void>(resolve => blocker!.close(() => resolve())); blocker = undefined;
    sim = new StackSim(options(root)); await sim.start();
    assert.equal(sim.opensearch.domain(region, missing.name).state, "failed");
    assert.equal(sim.opensearch.domain(region, "corrupt-storage").state, "failed");
    assert.equal(sim.opensearch.domain(region, occupied.name).state, "active");
    assert.equal(sim.opensearch.domain(region, occupied.name).gatewayPort, occupied.gatewayPort);
    await sim.opensearch.execute("DeleteDomain", { DomainName: missing.name }, region);
    await until(() => !sim.opensearch.domains(region).some(domain => domain.name === missing.name));
  } finally { if (blocker) await new Promise<void>(resolve => blocker!.close(() => resolve())); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("OS-01 official clients isolate identical domain names and indexes across authenticated accounts", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-accounts-")); const sim = new StackSim(options(root)); const clients: OpenSearchClient[] = []; const search: Client[] = [];
  try {
    await sim.start();
    const accountId = "111111111111", foreign = sim.store.ensureAccount(accountId), credentialId = randomUUID();
    const user = structuredClone(sim.store.ensureAccount().iam.users.admin);
    user.arn = `arn:aws:iam::${accountId}:user/admin`; user.userId = `AIDA${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    user.inlinePolicies = { search: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:*", Resource: "*" }] } };
    foreign.iam.users.admin = user;
    const creds = { accessKeyId: "AKIAFOREIGNSEARCHTEST", secretAccessKey: "foreign-test-secret" };
    foreign.iam.accessKeys[creds.accessKeyId] = { ...structuredClone(sim.store.ensureAccount().iam.accessKeys.admin), accessKeyId: creds.accessKeyId, credentialId, userName: "admin" };
    await sim.store.credentialStore!.put({ type: "iam-user", credentialId, accountId, ownerId: user.userId, accessKeyId: creds.accessKeyId }, { secretAccessKey: creds.secretAccessKey });
    await sim.store.save();
    const first = client(sim), second = client(sim, creds); clients.push(first, second);
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    for (const [cp, credentials] of [[first, { accessKeyId: "admin", secretAccessKey: "password" }], [second, creds]] as const) {
      await cp.send(new CreateDomainCommand({ DomainName: "same-domain" }));
      let endpoint: string | undefined;
      await until(async () => { endpoint = (await cp.send(new DescribeDomainCommand({ DomainName: "same-domain" }))).DomainStatus?.Endpoint; return Boolean(endpoint); });
      search.push(new Client({ node: `https://${endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) }));
    }
    await search[0].index({ index: "products", id: "one", body: { title: "first account" }, refresh: true });
    await search[1].index({ index: "products", id: "one", body: { title: "second account" }, refresh: true });
    assert.equal((await search[0].get({ index: "products", id: "one" })).body._source.title, "first account");
    assert.equal((await search[1].get({ index: "products", id: "one" })).body._source.title, "second account");
    assert.equal((await first.send(new ListDomainNamesCommand({}))).DomainNames!.length, 1);
    assert.equal((await second.send(new ListDomainNamesCommand({}))).DomainNames!.length, 1);
    assert.match((await second.send(new DescribeDomainCommand({ DomainName: "same-domain" }))).DomainStatus!.ARN!, new RegExp(accountId));
    await second.send(new DeleteDomainCommand({ DomainName: "same-domain" }));
    assert.equal((await search[0].get({ index: "products", id: "one" })).body.found, true);
  } finally { await Promise.all(search.map(item => item.close())); clients.forEach(item => item.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("OS-01 AWS CLI create, describe, discovery, tags, validation and delete", { timeout: 90000 }, async t => {
  const exec = promisify(execFile); const aws = process.env.STACKSIM_TEST_AWS_CLI ?? "aws";
  try { await exec(aws, ["--version"]); } catch (error: any) { if (error.code === "ENOENT") { t.skip("AWS CLI is not installed; CLI acceptance remains unverified on this host"); return; } throw error; }
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-cli-")); const sim = new StackSim(options(root));
  try {
    await sim.start(); await writeFile(join(root, "empty-config"), "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AWS_")));
    Object.assign(env, { AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: join(root, "empty-config"), AWS_SHARED_CREDENTIALS_FILE: join(root, "empty-config"), AWS_PAGER: "" });
    const cli = async (...args: string[]) => {
      const result = await exec(aws, ["--endpoint-url", `http://127.0.0.1:${sim.port}`, "--region", region, "--output", "json", "--no-cli-pager", "opensearch", ...args], { env, timeout: 20000, maxBuffer: 1024 * 1024 });
      return result.stdout.trim() ? JSON.parse(result.stdout) : {};
    };
    assert.deepEqual((await cli("list-domain-names")).DomainNames, []);
    await assert.rejects(cli("create-domain", "--domain-name", "INVALID"), /ValidationException/);
    assert.equal(sim.opensearch.domains(region).length, 0);
    await cli("create-domain", "--domain-name", "cli-domain"); await active(sim, "cli-domain");
    const domain = (await cli("describe-domain", "--domain-name", "cli-domain")).DomainStatus;
    assert.match(domain.Endpoint, /^127\.0\.0\.1:\d+$/);
    assert.deepEqual((await cli("list-versions")).Versions, ["OpenSearch_2.19"]);
    await cli("add-tags", "--arn", domain.ARN, "--tag-list", "Key=client,Value=aws-cli");
    assert.deepEqual((await cli("list-tags", "--arn", domain.ARN)).TagList, [{ Key: "client", Value: "aws-cli" }]);
    await cli("remove-tags", "--arn", domain.ARN, "--tag-keys", "client");
    assert.deepEqual((await cli("list-tags", "--arn", domain.ARN)).TagList, []);
    await cli("delete-domain", "--domain-name", "cli-domain");
    await until(() => sim.opensearch.domains(region).length === 0);
    assert.deepEqual((await cli("list-domain-names")).DomainNames, []);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});


test("OS-01 temporary role credentials enforce exact domain/path/method permissions and immediate revocation", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-session-")); const sim = new StackSim(options(root));
  let iam: IAMClient | undefined, sts: STSClient | undefined, search: Client | undefined;
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "session-domain" }, region); const domain = await active(sim, "session-domain");
    const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; iam = new IAMClient(config); sts = new STSClient(config);
    const role = (await iam.send(new CreateRoleCommand({ RoleName: "search-session", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: `arn:aws:iam::${sim.store.accountId}:root` } }] }) }))).Role!;
    await iam.send(new PutRolePolicyCommand({ RoleName: "search-session", PolicyName: "read-products", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:ESHttpGet", Resource: `${domain.arn}/products/*` }] }) }));
    const temporary = (await sts.send(new AssumeRoleCommand({ RoleArn: role.Arn!, RoleSessionName: "search-client", DurationSeconds: 900 }))).Credentials!;
    const sessionCredentials = { accessKeyId: temporary.AccessKeyId!, secretAccessKey: temporary.SecretAccessKey!, sessionToken: temporary.SessionToken! };
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const admin = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    try { await admin.index({ index: "products", id: "one", body: { title: "session visible" }, refresh: true }); await admin.index({ index: "private", id: "one", body: { title: "not visible" }, refresh: true }); } finally { await admin.close(); }
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => sessionCredentials }) });
    assert.equal((await search.get({ index: "products", id: "one" })).body.found, true);
    await assert.rejects(search.get({ index: "private", id: "one" }), (error: any) => error.statusCode === 403);
    await assert.rejects(search.index({ index: "products", id: "two", body: { title: "denied" } }), (error: any) => error.statusCode === 403);
    await iam.send(new DeleteRolePolicyCommand({ RoleName: "search-session", PolicyName: "read-products" }));
    await assert.rejects(search.get({ index: "products", id: "one" }), (error: any) => error.statusCode === 403);
  } finally { await search?.close(); iam?.destroy(); sts?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
