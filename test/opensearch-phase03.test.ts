import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { OpenSearchClient, CreateDomainCommand, DescribeDomainCommand, DescribeDomainConfigCommand, UpdateDomainConfigCommand, DescribeDomainChangeProgressCommand, DescribeDryRunProgressCommand, CancelDomainConfigChangeCommand } from "@aws-sdk/client-opensearch";
import { StackSim } from "../src/server.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
async function ready(client: OpenSearchClient, name: string) {
  for (let i = 0; i < 200; i++) { const domain = (await client.send(new DescribeDomainCommand({ DomainName: name }))).DomainStatus!; if (domain.Endpoint && !domain.Processing) return domain; await delay(10); }
  throw new Error("Domain did not finish processing");
}
async function noSecrets(directory: string, secrets: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await noSecrets(path, secrets);
    else for (const secret of secrets) assert.equal((await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; })).includes(Buffer.from(secret)), false, `${entry.name} exposes protected material`);
  }
}

test("OS-03 official clients enforce basic/IAM edge separation, durable FGAC and protected credentials", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-secure-sdk-"));
  let sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let control: OpenSearchClient | undefined, search: Client | undefined, signed: Client | undefined;
  const password = "Unique-master-password1!", title = "Classified-personal-document-93821";
  try {
    await sim.start(); control = new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "es:ESHttp*", Resource: "arn:aws:es:eu-west-1:000000000000:domain/secure-domain/*" }] });
    await control.send(new CreateDomainCommand({ DomainName: "secure-domain", AccessPolicies: policy, EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: true, MasterUserOptions: { MasterUserName: "master", MasterUserPassword: password } } }));
    const domain = await ready(control, "secure-domain"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    assert.equal(domain.EncryptionAtRestOptions?.Enabled, true); assert.equal(domain.AdvancedSecurityOptions?.Enabled, true);
    search = new Client({ node: `https://${domain.Endpoint}`, ssl: { ca }, auth: { username: "master", password } });
    signed = new Client({ node: `https://${domain.Endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    await search.indices.create({ index: "private" }); await search.index({ index: "private", id: "1", body: { title }, refresh: true });
    assert.equal((await search.get({ index: "private", id: "1" })).body._source.title, title);
    await assert.rejects(signed.get({ index: "private", id: "1" }), (error: any) => error.statusCode === 403);
    await control.send(new UpdateDomainConfigCommand({ DomainName: "secure-domain", AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "es:ESHttp*", Resource: `${domain.ARN}/*` }] }) }));
    await assert.rejects(search.get({ index: "private", id: "1" }), (error: any) => error.statusCode === 403);
    await control.send(new UpdateDomainConfigCommand({ DomainName: "secure-domain", AccessPolicies: policy }));
    await noSecrets(root, [password, title]);
    await search.close(); search = undefined; await signed.close(); signed = undefined; control.destroy();
    await sim.stop(); sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); await sim.start();
    control = new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    search = new Client({ node: `https://${(await ready(control, "secure-domain")).Endpoint}`, ssl: { ca }, auth: { username: "master", password } });
    assert.equal((await search.get({ index: "private", id: "1" })).body._source.title, title);
    const wrong = new Client({ node: `https://${domain.Endpoint}`, ssl: { ca }, auth: { username: "master", password: "Wrong-password1!" } });
    try { await assert.rejects(wrong.get({ index: "private", id: "1" }), (error: any) => error.statusCode === 401); } finally { await wrong.close(); }
    const material = sim.opensearch.domain(region, "secure-domain").securityMaterial!;
    assert.ok(material.id); assert.equal(JSON.stringify((await control.send(new DescribeDomainConfigCommand({ DomainName: "secure-domain" }))).DomainConfig).includes("MasterUser"), false);
  } finally { await search?.close(); await signed?.close(); control?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("OS-03 verbose dry runs, cancellable revisions, concurrent-change rejection and password rotation preserve active data", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-revisions-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let control: OpenSearchClient | undefined, search: Client | undefined, old: Client | undefined;
  const password = "Revision-master-password1!";
  try {
    await sim.start(); control = new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    await control.send(new CreateDomainCommand({ DomainName: "revision-domain", EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "es:ESHttp*", Resource: "arn:aws:es:eu-west-1:000000000000:domain/revision-domain/*" }] }) }));
    const domain = await ready(control, "revision-domain"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://${domain.Endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    await search.index({ index: "existing", id: "1", body: { title: "preserved" }, refresh: true });
    const update = { DomainName: "revision-domain", AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: true, MasterUserOptions: { MasterUserName: "master", MasterUserPassword: password } } };
    const dry = await control.send(new UpdateDomainConfigCommand({ ...update, DryRun: true, DryRunMode: "Verbose" }));
    assert.equal(dry.DryRunProgressStatus!.DryRunId!.length, 36);
    let progress;
    for (let i = 0; i < 100; i++) { progress = await control.send(new DescribeDryRunProgressCommand({ DomainName: update.DomainName, DryRunId: dry.DryRunProgressStatus!.DryRunId, LoadDryRunConfig: true })); if (progress.DryRunProgressStatus?.DryRunStatus === "succeeded") break; await delay(10); }
    assert.equal(progress!.DryRunProgressStatus?.DryRunStatus, "succeeded"); assert.equal(progress!.DryRunConfig?.AdvancedSecurityOptions?.Enabled, true);
    assert.equal(sim.opensearch.domain(region, update.DomainName).config.AdvancedSecurityOptions.Enabled, false);
    const pending = await control.send(new UpdateDomainConfigCommand(update));
    const id = pending.DomainConfig?.ChangeProgressDetails?.ChangeId;
    assert.equal(id?.length, 36);
    assert.equal((await control.send(new DescribeDomainCommand({ DomainName: update.DomainName }))).DomainStatus?.AdvancedSecurityOptions?.Enabled, false);
    await assert.rejects(control.send(new UpdateDomainConfigCommand({ DomainName: update.DomainName, AdvancedOptions: { "rest.action.multi.allow_explicit_index": "false" } })), { name: "ValidationException" });
    const preview = await control.send(new CancelDomainConfigChangeCommand({ DomainName: update.DomainName, DryRun: true })); assert.deepEqual(preview.CancelledChangeIds, [id]);
    await control.send(new CancelDomainConfigChangeCommand({ DomainName: update.DomainName }));
    assert.equal((await control.send(new DescribeDomainChangeProgressCommand({ DomainName: update.DomainName, ChangeId: id }))).ChangeProgressStatus?.ConfigChangeStatus, "Cancelled");
    assert.equal((await search.get({ index: "existing", id: "1" })).body._source.title, "preserved");
    await control.send(new UpdateDomainConfigCommand(update)); await ready(control, update.DomainName);
    await assert.rejects(search.get({ index: "existing", id: "1" }), (error: any) => error.statusCode === 403);
    await search.close(); search = new Client({ node: `https://${domain.Endpoint}`, ssl: { ca }, auth: { username: "master", password } });
    assert.equal((await search.get({ index: "existing", id: "1" })).body._source.title, "preserved");
    await control.send(new UpdateDomainConfigCommand({ ...update, AdvancedSecurityOptions: { ...update.AdvancedSecurityOptions, MasterUserOptions: { MasterUserName: "master", MasterUserPassword: "Rotated-master-password2!" } } })); await ready(control, update.DomainName);
    await assert.rejects(search.get({ index: "existing", id: "1" }), (error: any) => error.statusCode === 401);
    old = search; search = new Client({ node: `https://${domain.Endpoint}`, ssl: { ca }, auth: { username: "master", password: "Rotated-master-password2!" } });
    assert.equal((await search.get({ index: "existing", id: "1" })).body._source.title, "preserved");
    await noSecrets(root, [password, "Rotated-master-password2!", "preserved"]);
  } finally { await search?.close(); await old?.close(); control?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
