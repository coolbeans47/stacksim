import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StackSim } from '../src/server.js';

for (const boundary of ['create-intent', 'activation-publish', 'update-intent', 'delete-intent', 'delete-cleanup']) test(`Application recovers after forced termination at ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-app-crash-')), extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js', child = fork(new URL(`./fixtures/opensearch-application-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '', sim: StackSim | undefined; child.stderr?.on('data', data => { errors += data; }); const exited = once(child, 'exit');
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill('SIGKILL'); await exited;
    const region = 'eu-west-1'; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'off' }); await sim.start(); const records = Object.values(sim.opensearch.applications.state(region).records);
    const source = sim.opensearch.domain(region, 'source');
    assert.equal(source.state, 'active', `Restart failed to activate source domain on port ${source.gatewayPort}: ${source.failure}`);
    if (boundary.startsWith('delete')) { assert.equal(records.length, 0); assert.equal(sim.opensearch.applications.state(region).retiredPorts.length, 1); }
    else { assert.equal(records.length, 1); const app = records[0]; assert.equal(app.status, 'ACTIVE', `Restart failed to activate application on port ${app.gatewayPort}: ${app.failure}`); assert.equal(app.id, signal.id); if (boundary === 'update-intent') { assert.deepEqual(app.appConfigs, []); const principal = { principalType: 'anonymous', principalArn: '*', principalId: 'anonymous', accessKeyId: '', accountId: sim.store.accountId } as any; const saved = await sim.opensearch.applications.local(region, sim.store.accountId, app.id, principal, true, 'query', { workspaceId: app.workspaces[0].id, dataSourceArn: app.sources[0].dataSourceArn, method: 'GET', path: '/_stacksim/workspace' }); assert.equal(saved.body.objects[0].title, 'Durable view'); } }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
