import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StateStore } from "../src/state.js";
import { TestClock } from "../src/core/clock.js";
import { EncryptedMaterialStore } from "../src/configuration-secrets/encrypted-material-store.js";
import { SearchPackages, type PackageCatalog } from "../src/opensearch/packages.js";
import { compileAnalysis, customTokens, type DictionaryVersion } from "../src/opensearch/analyzers.js";
import type { DomainRecord } from "../src/opensearch/model.js";
import { StackSim } from "../src/server.js";
import { setTimeout as delay } from "node:timers/promises";
import * as OpenSearch from "@aws-sdk/client-opensearch";
import * as S3 from "@aws-sdk/client-s3";
import * as Iam from "@aws-sdk/client-iam";
import * as Legacy from "@aws-sdk/client-elasticsearch-service";

test("legacy package APIs share modern dictionary versions and domain associations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-package-legacy-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let legacy: Legacy.ElasticsearchServiceClient | undefined, modern: OpenSearch.OpenSearchClient | undefined, s3: S3.S3Client | undefined;
  const until = async (read: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await read()) return; await delay(10); } assert.fail("Legacy package operation timed out"); };
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 }; legacy = new Legacy.ElasticsearchServiceClient(sdk); modern = new OpenSearch.OpenSearchClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
    await s3.send(new S3.CreateBucketCommand({ Bucket: "legacy-dictionaries" })); await s3.send(new S3.PutObjectCommand({ Bucket: "legacy-dictionaries", Key: "words", Body: "apple, fruit" }));
    const source = { S3BucketName: "legacy-dictionaries", S3Key: "words" }, pkg = (await legacy.send(new Legacy.CreatePackageCommand({ PackageName: "legacy-words", PackageType: "TXT-DICTIONARY", PackageSource: source }))).PackageDetails!;
    assert.ok(pkg.CreatedAt instanceof Date); assert.equal(Object.hasOwn(pkg, "PackageVendingOptions"), false); const id = pkg.PackageID!;
    await until(async () => (await legacy!.send(new Legacy.DescribePackagesCommand({}))).PackageDetailsList![0].PackageStatus === "AVAILABLE");
    assert.equal((await modern.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList![0].PackageID, id);
    await modern.send(new OpenSearch.CreateDomainCommand({ DomainName: "legacy-packages" })); await until(async () => sim.opensearch.domain(region, "legacy-packages").state === "active");
    await legacy.send(new Legacy.AssociatePackageCommand({ PackageID: id, DomainName: "legacy-packages" })); await until(async () => (await legacy!.send(new Legacy.ListPackagesForDomainCommand({ DomainName: "legacy-packages" }))).DomainPackageDetailsList![0].DomainPackageStatus === "ACTIVE");
    const associations = await legacy.send(new Legacy.ListDomainsForPackageCommand({ PackageID: id })); assert.equal(associations.DomainPackageDetailsList![0].ReferencePath, `analyzers/${id}`);
    await s3.send(new S3.PutObjectCommand({ Bucket: "legacy-dictionaries", Key: "words", Body: "apple, pear" })); await legacy.send(new Legacy.UpdatePackageCommand({ PackageID: id, PackageSource: source, CommitMessage: "Legacy update" })); await until(async () => (await modern!.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList![0].AvailablePackageVersion === "2");
    assert.deepEqual((await legacy.send(new Legacy.GetPackageVersionHistoryCommand({ PackageID: id }))).PackageVersionHistoryList!.map(version => version.PackageVersion), ["2", "1"]);
    assert.equal((await modern.send(new OpenSearch.ListPackagesForDomainCommand({ DomainName: "legacy-packages" }))).DomainPackageDetailsList![0].PackageVersion, "1");
    await legacy.send(new Legacy.DissociatePackageCommand({ PackageID: id, DomainName: "legacy-packages" })); await until(async () => (await modern!.send(new OpenSearch.ListPackagesForDomainCommand({ DomainName: "legacy-packages" }))).DomainPackageDetailsList!.length === 0);
    await legacy.send(new Legacy.DeletePackageCommand({ PackageID: id })); await until(async () => (await modern!.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList!.length === 0);
  } finally { legacy?.destroy(); modern?.destroy(); s3?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

test("package publication rollback preserves the last good dictionary and deletion resumes after partial material removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-package-recovery-")), region = "eu-west-1", clock = new TestClock(100000);
  let store = new StateStore(root), materials = new EncryptedMaterialStore(root, "opensearch"), source = "apple, fruit", active: string | undefined, failed = false;
  const domain = { name: "test-domain", generation: randomUUID(), state: "active", region, accountId: store.accountId } as DomainRecord;
  const catalog = (): PackageCatalog => { const state = store.regionState(region); state.opensearch ??= { domains: {}, retiredPorts: [] }; return state.opensearch.packages ??= { records: {}, cursorKey: randomUUID() }; };
  const ports = { catalog, all: () => Object.values(catalog().records), domain: () => domain, source: async () => Buffer.from(source), install: (_domain: DomainRecord, _id: string, version: string) => { const old = active; active = version; return () => { active = old; }; }, remove: () => { const old = active; active = undefined; return () => { active = old; }; }, validate: () => {}, mutate: async (_domain: DomainRecord, work: () => Promise<void>) => work(), inUse: () => false };
  let packages = new SearchPackages(store, clock, materials, ports);
  const call = (operation: string, input: any) => packages.execute(operation, input, region, store.accountId);
  try {
    await store.load(); await materials.start(new Set());
    const input = { PackageName: "fruit-dictionary", PackageType: "TXT-DICTIONARY", PackageSource: { S3BucketName: "bucket", S3Key: "words" } }, id = (await call("CreatePackage", input)).PackageDetails.PackageID; await packages.drain();
    await call("AssociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); assert.equal(active, "1");
    source = "apple, pear"; await call("UpdatePackage", { PackageID: id, PackageSource: input.PackageSource }); await packages.drain();
    const save = store.save.bind(store); store.save = async () => { if (!failed && catalog().records[id].associations[domain.generation]?.activeVersion === "2") { failed = true; throw new Error("Injected association publication failure"); } await save(); };
    await call("AssociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); assert.equal(active, "1"); assert.equal(catalog().records[id].associations[domain.generation].state, "ASSOCIATION_FAILED"); assert.equal(catalog().records[id].associations[domain.generation].activeVersion, "1"); await store.flush();
    store = new StateStore(root); await store.load(); materials = new EncryptedMaterialStore(root, "opensearch"); packages = new SearchPackages(store, clock, materials, ports); await materials.start(new Set(packages.references())); active = undefined; await packages.restoreDomain(domain); assert.equal(active, "1");
    await call("AssociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); assert.equal(active, "2");
    await call("DissociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); assert.equal(active, undefined);
    const remove = materials.remove.bind(materials); let removed = 0; materials.remove = async id => { if (++removed === 2) throw new Error("Injected material deletion failure"); await remove(id); };
    await call("DeletePackage", { PackageID: id }); await packages.drain(); assert.equal(catalog().records[id].state, "DELETE_FAILED"); assert.equal((await readdir(materials.materialRoot)).length, 1); await store.flush();
    store = new StateStore(root); await store.load(); materials = new EncryptedMaterialStore(root, "opensearch"); packages = new SearchPackages(store, clock, materials, ports); await materials.start(new Set(packages.references())); await call("DeletePackage", { PackageID: id }); await packages.drain(); assert.deepEqual(Object.keys(catalog().records), []); assert.equal((await readdir(materials.materialRoot)).length, 0);
  } finally { await packages.drain(); await store.flush(); await rm(root, { recursive: true, force: true }); }
});

test("package imports enforce independent control and S3 permissions, regional ownership and archived object readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-package-permissions-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let iam: Iam.IAMClient | undefined, s3: S3.S3Client | undefined, denied: OpenSearch.OpenSearchClient | undefined, control: OpenSearch.OpenSearchClient | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 }; iam = new Iam.IAMClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }); control = new OpenSearch.OpenSearchClient(sdk);
    await s3.send(new S3.CreateBucketCommand({ Bucket: "private-package-source" })); await s3.send(new S3.PutObjectCommand({ Bucket: "private-package-source", Key: "words", Body: "apple, pear" }));
    await iam.send(new Iam.CreateUserCommand({ UserName: "package-reader" })); const key = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: "package-reader" }))).AccessKey!; denied = new OpenSearch.OpenSearchClient({ ...sdk, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } });
    const input = { PackageName: "private-words", PackageType: "TXT-DICTIONARY" as const, PackageSource: { S3BucketName: "private-package-source", S3Key: "words" } };
    await assert.rejects(denied.send(new OpenSearch.CreatePackageCommand(input)), /es:CreatePackage/);
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: "package-reader", PolicyName: "Import", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:CreatePackage", Resource: "*" }] }) }));
    await assert.rejects(denied.send(new OpenSearch.CreatePackageCommand(input)), /s3:GetObject/); assert.equal((await control.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList!.length, 0);
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: "package-reader", PolicyName: "Source", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::private-package-source/words" }] }) }));
    assert.equal((await denied.send(new OpenSearch.CreatePackageCommand(input))).PackageDetails!.PackageStatus, "COPYING");
    await assert.rejects(denied.send(new OpenSearch.DescribePackagesCommand({})), /es:DescribePackages/);
    const away = new OpenSearch.OpenSearchClient({ ...sdk, region: "us-east-1" }); try { await assert.rejects(away.send(new OpenSearch.CreatePackageCommand(input)), /same-account, same-Region/); } finally { away.destroy(); }
    await s3.send(new S3.PutObjectCommand({ Bucket: "private-package-source", Key: "archived", Body: "apple, pear", StorageClass: "GLACIER" }));
    await assert.rejects(control.send(new OpenSearch.CreatePackageCommand({ ...input, PackageName: "archive-words", PackageSource: { ...input.PackageSource, S3Key: "archived" } })), /restore|storage class|archiv/i);
    await sim.opensearch.execute("CreateDomain", { DomainName: "restricted-packages" }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "restricted-packages").state !== "active"; i++) await delay(10);
    const id = (await control.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList![0].PackageID!; await assert.rejects(denied.send(new OpenSearch.AssociatePackageCommand({ PackageID: id, DomainName: "restricted-packages" })), /es:AssociatePackage/);
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: "package-reader", PolicyName: "Domain", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:AssociatePackage", Resource: `arn:aws:es:${region}:000000000000:domain/restricted-packages`, Condition: { StringEquals: { "aws:ResourceTag/Team": "search" } } }] }) }));
    await assert.rejects(denied.send(new OpenSearch.AssociatePackageCommand({ PackageID: id, DomainName: "restricted-packages" })), /es:AssociatePackage/);
    await control.send(new OpenSearch.AddTagsCommand({ ARN: sim.opensearch.domain(region, "restricted-packages").arn, TagList: [{ Key: "Team", Value: "search" }] })); assert.equal((await denied.send(new OpenSearch.AssociatePackageCommand({ PackageID: id, DomainName: "restricted-packages" }))).DomainPackageDetails!.DomainPackageStatus, "ASSOCIATING");
  } finally { iam?.destroy(); s3?.destroy(); denied?.destroy(); control?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("dictionary catalog encrypts immutable imports, pins domain versions, recovers, shares and removes associations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-packages-")), region = "eu-west-1", accountId = "000000000000", clock = new TestClock(1000000);
  let store = new StateStore(root, accountId, region), materials = new EncryptedMaterialStore(root, "opensearch"), source = "apple, confidential-fruit\n", used = false;
  const dictionaries = new Map<string, DictionaryVersion>(), domain: DomainRecord = { name: "package-domain", arn: `arn:aws:es:${region}:${accountId}:domain/package-domain`, region, accountId, generation: randomUUID(), state: "active", config: {}, tags: {}, createdAt: 0, updatedAt: 0, revision: 1, gatewayPort: 0 };
  const catalog = (region: string, account: string): PackageCatalog => { const state = store.regionState(region, account); state.opensearch ??= { domains: {}, retiredPorts: [] }; return state.opensearch.packages ??= { records: {}, cursorKey: randomUUID() }; };
  const all = () => Object.values(store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.packages?.records ?? {})));
  const ports = { catalog, all, domain: () => domain, source: async () => Buffer.from(source), install: (_domain: DomainRecord, id: string, version: string, versions: DictionaryVersion[]) => { const old = dictionaries.get(id); dictionaries.set(id, versions.find(value => value.version === version)!); return () => { if (old) dictionaries.set(id, old); else dictionaries.delete(id); }; }, remove: (_domain: DomainRecord, id: string) => { const old = dictionaries.get(id); dictionaries.delete(id); return () => { if (old) dictionaries.set(id, old); }; }, validate: () => {}, mutate: async (_domain: DomainRecord, work: () => Promise<void>) => work(), inUse: () => used };
  let packages = new SearchPackages(store, clock, materials, ports);
  const call = (operation: string, input: any, account = accountId) => packages.execute(operation, input, region, account);
  const tokens = (id: string) => { const analysis = compileAnalysis({ analyzer: { custom: { type: "custom", tokenizer: "standard", filter: ["synonyms"] } }, filter: { synonyms: { type: "synonym", synonyms_path: `analyzers/${id}`, updateable: true } } }, id => dictionaries.get(id)); return customTokens("apple", analysis.custom).map(token => token.token); };
  try {
    await store.load(); await materials.start(new Set());
    const created = await call("CreatePackage", { PackageName: "fruit-words", PackageType: "TXT-DICTIONARY", PackageSource: { S3BucketName: "package-source", S3Key: "words.txt" }, PackageVendingOptions: { VendingEnabled: true } }), id = created.PackageDetails.PackageID;
    assert.equal(created.PackageDetails.PackageStatus, "COPYING"); await packages.drain();
    assert.equal((await call("DescribePackages", {})).PackageDetailsList[0].AvailablePackageVersion, "1");
    await call("AssociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); assert.deepEqual(tokens(id), ["apple", "confidential-fruit"]);
    source = "apple, new-fruit\n"; await call("UpdatePackage", { PackageID: id, PackageSource: { S3BucketName: "package-source", S3Key: "new.txt" }, CommitMessage: "New vocabulary" }); await packages.drain(); assert.deepEqual(tokens(id), ["apple", "confidential-fruit"]);
    const history = await call("GetPackageVersionHistory", { PackageID: id, MaxResults: 1 }); assert.equal(history.PackageVersionHistoryList[0].PackageVersion, "2"); assert.ok(history.NextToken); assert.equal((await call("GetPackageVersionHistory", { PackageID: id, MaxResults: 1, NextToken: history.NextToken })).PackageVersionHistoryList[0].PackageVersion, "1");
    await assert.rejects(call("ListDomainsForPackage", { PackageID: id, NextToken: history.NextToken }), /pagination/);
    await call("AssociatePackages", { DomainName: domain.name, PackageList: [{ PackageID: id }] }); await packages.drain(); assert.deepEqual(tokens(id), ["apple", "new-fruit"]);
    assert.equal((await call("ListPackagesForDomain", { DomainName: domain.name })).DomainPackageDetailsList[0].PackageVersion, "2");
    const other = "111111111111"; store.ensureAccount(other); assert.equal((await call("DescribePackages", {}, other)).PackageDetailsList.length, 0);
    await call("UpdatePackageScope", { PackageID: id, Operation: "ADD", PackageUserList: [other] }); assert.equal((await call("DescribePackages", {}, other)).PackageDetailsList.length, 1); await assert.rejects(call("DeletePackage", { PackageID: id }, other), { code: "ResourceNotFoundException" });
    await call("UpdatePackageScope", { PackageID: id, Operation: "REMOVE", PackageUserList: [other] }); assert.equal((await call("DescribePackages", {}, other)).PackageDetailsList.length, 0);
    await store.flush(); assert.equal((await readFile(join(root, "state.json"), "utf8")).includes("confidential-fruit"), false);
    for (const file of await readdir(materials.materialRoot)) assert.equal((await readFile(join(materials.materialRoot, file))).includes(Buffer.from("confidential-fruit")), false);
    store = new StateStore(root, accountId, region); await store.load(); materials = new EncryptedMaterialStore(root, "opensearch"); packages = new SearchPackages(store, clock, materials, ports); await materials.start(new Set(packages.references())); dictionaries.clear(); await packages.resume(); assert.deepEqual(tokens(id), ["apple", "new-fruit"]);
    used = true; await assert.rejects(call("DissociatePackage", { PackageID: id, DomainName: domain.name }), { code: "ConflictException" }); await assert.rejects(call("DeletePackage", { PackageID: id }), { code: "ConflictException" }); used = false;
    await call("DissociatePackages", { DomainName: domain.name, PackageList: [id] }); await packages.drain(); assert.equal(dictionaries.has(id), false);
    await call("DeletePackage", { PackageID: id }); await packages.drain(); assert.equal((await call("DescribePackages", {})).PackageDetailsList.length, 0); assert.equal((await readdir(materials.materialRoot)).length, 0);
  } finally { await packages.drain(); await store.flush(); await rm(root, { recursive: true, force: true }); }
});

test("dictionary imports validate data and roll back failed catalog commits without plaintext or orphan references", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-package-failure-")), store = new StateStore(root), clock = new TestClock(100000), materials = new EncryptedMaterialStore(root, "opensearch"), catalog: PackageCatalog = { records: {}, cursorKey: randomUUID() };
  let source = Buffer.from("word\n"), installFails = false;
  const domain = { name: "test-domain", generation: "test-generation", state: "active", region: "eu-west-1", accountId: store.accountId } as DomainRecord;
  const packages = new SearchPackages(store, clock, materials, { catalog: () => catalog, all: () => Object.values(catalog.records), domain: () => domain, source: async () => Buffer.from(source), install: () => { if (installFails) throw new Error("private path must not leak"); return () => {}; }, remove: () => () => {}, validate: () => {}, mutate: async (_domain, work) => work(), inUse: () => false });
  const call = (operation: string, input: any) => packages.execute(operation, input, "eu-west-1", store.accountId), input = { PackageName: "words", PackageType: "TXT-DICTIONARY", PackageSource: { S3BucketName: "bucket", S3Key: "words.txt" } };
  try {
    await store.load(); await materials.start(new Set());
    for (const invalid of [{ ...input, PackageType: "ZIP-PLUGIN" }, { ...input, PackageEncryptionOptions: { EncryptionEnabled: false } }, { ...input, PackageConfiguration: {} }]) await assert.rejects(call("CreatePackage", invalid), { code: "ValidationException" });
    for (const body of [Buffer.alloc(0), Buffer.from([255]), Buffer.alloc(65537, 97), Buffer.from("word\0"), Buffer.from("word\n".repeat(1001))]) { source = body; await assert.rejects(call("CreatePackage", input), { code: "ValidationException" }); }
    source = Buffer.from("safe-word\n"); const save = store.save.bind(store); let failSave = true; store.save = async () => { if (failSave) { failSave = false; throw new Error("save failed"); } await save(); };
    await assert.rejects(call("CreatePackage", input), /save failed/); assert.equal(Object.keys(catalog.records).length, 0); assert.equal((await readdir(materials.materialRoot)).length, 0); assert.equal((await readdir(materials.intentRoot)).length, 0);
    const id = (await call("CreatePackage", input)).PackageDetails.PackageID; await packages.drain(); installFails = true; await call("AssociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); const failed = (await call("ListPackagesForDomain", { DomainName: domain.name })).DomainPackageDetailsList[0]; assert.equal(failed.DomainPackageStatus, "ASSOCIATION_FAILED"); assert.equal(JSON.stringify(failed).includes("private path"), false);
    installFails = false; await call("AssociatePackage", { PackageID: id, DomainName: domain.name }); await packages.drain(); assert.equal((await call("ListPackagesForDomain", { DomainName: domain.name })).DomainPackageDetailsList[0].DomainPackageStatus, "ACTIVE");
  } finally { await packages.drain(); await store.flush(); await rm(root, { recursive: true, force: true }); }
});

test("official package clients import authorized S3 dictionaries and change actual domain search across updates, maintenance and restart", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-package-sdk-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, options = { dataDir: root, port: 0, invokePort: 0, region, authMode: "enforce" as const, cdkBootstrap: false };
  let stage = "start"; let sim = new StackSim(options), control: OpenSearch.OpenSearchClient | undefined, s3: S3.S3Client | undefined, search: Client | undefined;
  const until = async <T>(read: () => Promise<T>, check: (value: T) => boolean) => { for (let i = 0; i < 300; i++) { const value = await read(); if (check(value)) return value; await delay(10); } throw new Error("Package operation timed out"); };
  try {
    await sim.start(); const sdk = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }); control = new OpenSearch.OpenSearchClient(sdk()); s3 = new S3.S3Client({ ...sdk(), forcePathStyle: true });
    const bucket = "dictionary-source"; await s3.send(new S3.CreateBucketCommand({ Bucket: bucket })); await s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: "words.txt", Body: "apple, confidentialfruit\n" }));
    await s3.send(new S3.PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }) }));
    const input = { PackageName: "fruit-words", PackageType: "TXT-DICTIONARY" as const, PackageSource: { S3BucketName: bucket, S3Key: "words.txt" } }; await assert.rejects(control.send(new OpenSearch.CreatePackageCommand(input)), { name: "AccessDeniedException" }); await s3.send(new S3.DeleteBucketPolicyCommand({ Bucket: bucket }));
    const created = await control.send(new OpenSearch.CreatePackageCommand(input)), id = created.PackageDetails!.PackageID!; assert.ok(created.PackageDetails!.CreatedAt instanceof Date);
    const describe = () => control!.send(new OpenSearch.DescribePackagesCommand({ Filters: [{ Name: "PackageID", Value: [id] }] })); await until(describe, value => value.PackageDetailsList?.[0].PackageStatus === "AVAILABLE");
    await control.send(new OpenSearch.CreateDomainCommand({ DomainName: "package-domain" })); await until(async () => sim.opensearch.domain(region, "package-domain"), domain => domain.state === "active");
    await control.send(new OpenSearch.AssociatePackageCommand({ PackageID: id, DomainName: "package-domain" })); const associations = () => control!.send(new OpenSearch.ListPackagesForDomainCommand({ DomainName: "package-domain" })); await until(associations, value => value.DomainPackageDetailsList?.[0].DomainPackageStatus === "ACTIVE");
    const connection = { node: `https://127.0.0.1:${sim.opensearch.domain(region, "package-domain").gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) }; search = new Client(connection);
    stage = "initial association"; await search.indices.create({ index: "products", body: { settings: { analysis: { analyzer: { words: { type: "custom", tokenizer: "standard", filter: ["lowercase", "dictionary"] } }, filter: { dictionary: { type: "synonym", synonyms_path: `analyzers/${id}`, updateable: true } } } }, mappings: { properties: { title: { type: "text", search_analyzer: "words" } } } } });
    await search.index({ index: "products", id: "one", body: { title: "APPLE" }, refresh: true });
    const count = async (word: string) => (await search!.search({ index: "products", body: { query: { match: { title: word } } } })).body.hits.hits.length;
    assert.equal(await count("confidentialfruit"), 1);
    await s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: "words.txt", Body: "apple, pear\n" })); await control.send(new OpenSearch.UpdatePackageCommand({ PackageID: id, PackageSource: input.PackageSource, CommitMessage: "Replace synonym" })); await until(describe, value => value.PackageDetailsList?.[0].AvailablePackageVersion === "2"); assert.equal(await count("confidentialfruit"), 1);
    stage = "update association"; await control.send(new OpenSearch.AssociatePackagesCommand({ DomainName: "package-domain", PackageList: [{ PackageID: id }] })); await until(associations, value => value.DomainPackageDetailsList?.[0].DomainPackageStatus === "ACTIVE" && value.DomainPackageDetailsList[0].PackageVersion === "2"); assert.equal(await count("confidentialfruit"), 0); assert.equal(await count("pear"), 1);
    const history = await control.send(new OpenSearch.GetPackageVersionHistoryCommand({ PackageID: id })); assert.deepEqual(history.PackageVersionHistoryList!.map(version => version.PackageVersion), ["2", "1"]); assert.ok(history.PackageVersionHistoryList![0].CreatedAt instanceof Date);
    stage = "maintenance"; const maintenance = await control.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: "package-domain", Action: "RESTART_SEARCH_PROCESS" })); await until(() => control!.send(new OpenSearch.GetDomainMaintenanceStatusCommand({ DomainName: "package-domain", MaintenanceId: maintenance.MaintenanceId })), value => value.Status === "COMPLETED"); assert.equal(await count("pear"), 1);
    stage = "encryption migration"; await control.send(new OpenSearch.UpdateDomainConfigCommand({ DomainName: "package-domain", EncryptionAtRestOptions: { Enabled: true } })); await until(() => control!.send(new OpenSearch.DescribeDomainCommand({ DomainName: "package-domain" })), value => value.DomainStatus?.EncryptionAtRestOptions?.Enabled === true && value.DomainStatus.Processing === false); assert.equal(await count("pear"), 1);
    stage = "restart"; await search.close(); search = undefined; control.destroy(); s3.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); control = new OpenSearch.OpenSearchClient(sdk()); search = new Client(connection); assert.equal(await count("pear"), 1);
    stage = "cleanup"; await assert.rejects(control.send(new OpenSearch.DissociatePackageCommand({ PackageID: id, DomainName: "package-domain" })), { name: "ConflictException" }); await assert.rejects(control.send(new OpenSearch.DeletePackageCommand({ PackageID: id })), { name: "ConflictException" });
    await search.indices.delete({ index: "products" }); await control.send(new OpenSearch.DissociatePackageCommand({ PackageID: id, DomainName: "package-domain" })); await until(associations, value => value.DomainPackageDetailsList?.length === 0); await control.send(new OpenSearch.DeletePackageCommand({ PackageID: id })); await until(describe, value => value.PackageDetailsList?.length === 0);
  } catch (error: any) { throw new Error(`${stage}: ${error.message}: ${JSON.stringify(error.meta?.body ?? {})}`, { cause: error }); }
  finally { await search?.close(); control?.destroy(); s3?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
