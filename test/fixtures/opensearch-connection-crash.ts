import { setTimeout as delay } from 'node:timers/promises';
import { StackSim } from '../../src/server.js';
const [root, boundary] = process.argv.slice(2), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' }); await sim.start();
for (const name of ['crash-source', 'crash-remote']) {
  await sim.opensearch.execute('CreateDomain', { DomainName: name, EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: 'arn:aws:iam::000000000000:user/admin' } }, AccessPolicies: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 'es:ESCrossClusterGet', Resource: `arn:aws:es:${region}:000000000000:domain/${name}` }] }) }, region);
  while (sim.opensearch.domain(region, name).state !== 'active') await delay(5);
}
await (sim.opensearch as any).engine(sim.opensearch.domain(region, 'crash-remote')).request('PUT', '/orders/_doc/1?refresh=true', Buffer.from('{"price":42}'), 'fixture');
const save = sim.store.save.bind(sim.store); let armed = boundary === 'create-commit', parked = false;
const park = async () => { parked = true; process.send?.({ boundary }); setInterval(() => {}, 1000); await new Promise(() => {}); };
sim.store.save = async () => {
  const connection = Object.values(sim.store.regionState(region).opensearch.connections?.records ?? {})[0];
  if (armed && !parked && boundary === 'accept-before-commit' && connection?.status === 'ACTIVE') await park();
  await save();
  if (armed && !parked && (boundary === 'create-commit' && connection?.status === 'PENDING_ACCEPTANCE' || boundary === 'accept-commit' && connection?.status === 'ACTIVE' || boundary === 'delete-commit' && connection?.status === 'DELETED')) await park();
};
const created = await sim.opensearch.connections.execute('CreateOutboundConnection', { LocalDomainInfo: { AWSDomainInformation: { DomainName: 'crash-source' } }, RemoteDomainInfo: { AWSDomainInformation: { DomainName: 'crash-remote' } }, ConnectionAlias: 'remote' }, region, sim.store.accountId);
armed = boundary.startsWith('accept'); await sim.opensearch.connections.execute('AcceptInboundConnection', { ConnectionId: created.ConnectionId }, region, sim.store.accountId);
armed = true; await sim.opensearch.connections.execute('DeleteOutboundConnection', { ConnectionId: created.ConnectionId }, region, sim.store.accountId);
