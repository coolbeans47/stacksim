import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
for (const boundary of ['create-commit', 'accept-before-commit', 'accept-commit', 'delete-commit']) test(`Cross-cluster routing recovers after forced termination at ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-cc-crash-')), extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js', child = fork(new URL(`./fixtures/opensearch-connection-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '', sim: StackSim | undefined, client: Client | undefined; child.stderr?.on('data', data => { errors += data; }); const exited = once(child, 'exit');
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill('SIGKILL'); await exited;
    const region = 'eu-west-1'; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' }); await sim.start();
    const connections = (await sim.opensearch.connections.execute('DescribeOutboundConnections', {}, region, sim.store.accountId)).Connections; assert.equal(connections.length, 1); assert.equal(connections[0].ConnectionStatus.StatusCode, boundary === 'delete-commit' ? 'DELETED' : boundary === 'accept-commit' ? 'ACTIVE' : 'PENDING_ACCEPTANCE');
    client = new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(region, 'crash-source').gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => ({ accessKeyId: 'admin', secretAccessKey: 'password' }) }) });
    if (boundary === 'accept-commit') assert.equal((await client.search({ index: 'remote:orders' })).body.hits.hits[0]._source.price, 42);
    else await assert.rejects(client.search({ index: 'remote:orders' }), (error: any) => error.statusCode === 404);
    assert.equal((await (sim.opensearch as any).engine(sim.opensearch.domain(region, 'crash-remote')).request('GET', '/orders/_doc/1', Buffer.alloc(0), 'fixture')).body._source.price, 42);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
