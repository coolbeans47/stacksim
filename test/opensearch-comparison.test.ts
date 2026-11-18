import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Os from '@aws-sdk/client-opensearch';
import * as Iam from '@aws-sdk/client-iam';
import { StackSim } from '../src/server.js';
import { compareMetadata } from '../src/opensearch/compare.js';
const region = 'eu-west-1', account = '000000000000', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' };
const arn = (name: string) => `arn:aws:es:${region}:${account}:domain/${name}`;
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });

test('Configuration comparison reads live metadata, ignores object-key/revision order, redacts verifiers and requires IAM on both domains', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-compare-')), sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' }); const clients: Array<{ destroy(): void }> = [];
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }, os = new Os.OpenSearchClient(config), iam = new Iam.IAMClient(config); clients.push(os, iam);
    const call = async (name: string, method: string, path: string, body: any) => { const engine = (sim.opensearch as any).engine(sim.opensearch.domain(region, name)); return engine.request(method, path, Buffer.from(JSON.stringify(body)), 'fixture', true, engine.security.access({ name: `arn:aws:iam::${account}:user/admin`, backendRoles: [] })); };
    for (const name of ['compare-source', 'compare-target']) {
      await os.send(new Os.CreateDomainCommand({ DomainName: name, EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${account}:user/admin` } } })); for (let i = 0; i < 300 && sim.opensearch.domain(region, name).state !== 'active'; i++) await delay(10);
      await call(name, 'PUT', '/_index_template/same', { index_patterns: ['logs-*'], template: { settings: { number_of_shards: 1 } } });
      await call(name, 'PUT', '/_ingest/pipeline/changed', { processors: [{ set: { field: 'price', value: name === 'compare-source' ? 5 : 8 } }] });
      await call(name, 'PUT', '/orders', { aliases: { shop: { is_write_index: name === 'compare-source' } } });
      await call(name, 'PUT', '/_plugins/_security/api/internalusers/reader', { password: 'Hidden-password1!' });
      await call(name, 'PUT', '/_plugins/_security/api/roles/reader', { index_permissions: [{ index_patterns: ['orders'], allowed_actions: ['read'] }] });
      await call(name, 'PUT', '/_plugins/_security/api/rolesmapping/reader', { users: ['reader'] });
      await call(name, 'PUT', '/_plugins/_ism/policies/retention', { policy: { description: 'Keep documents', default_state: 'hot', states: [{ name: 'hot', actions: [], transitions: [] }] } });
    }
    await call('compare-source', 'PUT', '/_index_template/source-only', { index_patterns: ['source-*'] }); await call('compare-target', 'PUT', '/_index_template/target-only', { index_patterns: ['target-*'] });
    const input = { SourceDomainArn: arn('compare-source'), TargetDomainArn: arn('compare-target'), Categories: ['aliases', 'templates', 'ingest_pipelines', 'ism_policies', 'security_roles', 'security_role_mappings', 'security_internal_users'] };
    const result = await os.send(new Os.CompareDomainConfigurationCommand(input)), categories = result.Categories!; assert.equal(categories.templates.InSync, 1); assert.deepEqual(categories.templates.Items!.SourceOnly, ['source-only']); assert.deepEqual(categories.templates.Items!.TargetOnly, ['target-only']); assert.equal(categories.ism_policies.InSync, 1); assert.equal(categories.security_roles.InSync, 1); assert.equal(categories.security_role_mappings.InSync, 1);
    assert.deepEqual(categories.ingest_pipelines.Items!.Diverged![0].Fields, [{ Path: 'processors[0].set.value', SourceValue: '5', TargetValue: '8' }]); assert.equal(categories.aliases.Diverged, 1);
    assert.deepEqual(categories.security_internal_users.Items!.Diverged![0].Fields, [{ Path: 'hash', Policy: 'redacted' }]); assert.ok(!JSON.stringify(result).includes('Hidden-password'));
    await iam.send(new Iam.CreateUserCommand({ UserName: 'comparer' })); const key = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: 'comparer' }))).AccessKey!, reader = new Os.OpenSearchClient({ ...config, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } }); clients.push(reader);
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: 'comparer', PolicyName: 'compare', PolicyDocument: policy([{ Effect: 'Allow', Action: 'es:CompareDomainConfiguration', Resource: arn('compare-source') }]) })); await assert.rejects(reader.send(new Os.CompareDomainConfigurationCommand(input)), { name: 'AccessDeniedException' });
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: 'comparer', PolicyName: 'compare', PolicyDocument: policy([{ Effect: 'Allow', Action: 'es:CompareDomainConfiguration', Resource: [arn('compare-source'), arn('compare-target')] }]) })); assert.equal((await reader.send(new Os.CompareDomainConfigurationCommand(input))).Categories!.templates.InSync, 1);
    for (const Categories of [['templates', 'templates'], ['cluster_settings'], ['unknown']]) await assert.rejects(os.send(new Os.CompareDomainConfigurationCommand({ ...input, Categories })), /supported categories/);
    await assert.rejects(os.send(new Os.CompareDomainConfigurationCommand({ ...input, TargetDomainArn: input.TargetDomainArn.replace(account, '111122223333') })), /same-account/);
  } finally { clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('Comparison details are deterministic and bounded while counts remain complete', () => {
  assert.equal(compareMetadata('templates', { a: { first: 1, second: 2 } }, { a: { second: 2, first: 1 } }).InSync, 1);
  const source = { changed: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`field${i}`, i])), oversized: { value: 'a'.repeat(11000) } }, target = { changed: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`field${i}`, -1])), oversized: { value: 'b'.repeat(11000) } };
  const result = compareMetadata('templates', source, target); assert.equal(result.Diverged, 2); assert.equal(result.Items.Diverged[0].Fields.length, 100); assert.equal(result.Items.Diverged[1].Fields.length, 0); assert.equal(result.Truncated, true); assert.ok(!JSON.stringify(result).includes('a'.repeat(11000)));
  const names = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`item-${i}`, {}])); const many = compareMetadata('aliases', names, {}); assert.equal(many.SourceOnly, 1001); assert.equal(many.Items.SourceOnly.length, 1000); assert.equal(many.Truncated, true);
  assert.deepEqual(compareMetadata('templates', { item: { 'x.y': [1] } }, { item: { 'x.y': [2] } }).Items.Diverged[0].Fields, [{ Path: '["x.y"][0]', SourceValue: '1', TargetValue: '2' }]);
});
