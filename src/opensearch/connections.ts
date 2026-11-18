import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { StateStore } from '../state.js';
import type { Clock } from '../core/clock.js';
import { AwsError } from '../errors.js';
import { PaginationTokens } from '../core/pagination.js';
import { validateInput } from './protocol.js';
import type { DomainRecord } from './model.js';

export const CONNECTION_ACTIONS = new Set(['CreateOutboundConnection', 'AcceptInboundConnection', 'RejectInboundConnection', 'DeleteInboundConnection', 'DeleteOutboundConnection', 'DescribeInboundConnections', 'DescribeOutboundConnections']);
type DomainReference = { name: string; accountId: string; region: string; generation: string };
export interface SearchConnection { id: string; alias: string; local: DomainReference; remote: DomainReference; status: 'PENDING_ACCEPTANCE' | 'ACTIVE' | 'REJECTED' | 'DELETED'; skipUnavailable: boolean; updatedAt: number }
export interface ConnectionCatalog { records: Record<string, SearchConnection>; cursorKey: string }
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
const terminal = (connection: SearchConnection) => ['DELETED', 'REJECTED'].includes(connection.status);
const info = (domain: DomainReference) => ({ AWSDomainInformation: { DomainName: domain.name, OwnerId: domain.accountId, Region: domain.region } });
const reference = (domain: DomainRecord): DomainReference => ({ name: domain.name, accountId: domain.accountId, region: domain.region, generation: domain.generation });

/** One durable source-owned record supplies both account/Region-scoped views. */
export class SearchConnections {
  private publishing = false;
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly domains: () => DomainRecord[]) {}
  private state(region: string, account: string): ConnectionCatalog { return this.store.regionState(region, account).opensearch.connections ??= { records: {}, cursorKey: randomBytes(32).toString('hex') }; }
  private catalogs(): ConnectionCatalog[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => region.opensearch?.connections ? [region.opensearch.connections] : [])); }
  private all(): SearchConnection[] { return this.catalogs().flatMap(state => Object.values(state.records)); }
  private visible(connection: SearchConnection): boolean { return !terminal(connection) || connection.updatedAt + 15 * 86400000 > this.clock.now(); }
  private view(connection: SearchConnection, inbound: boolean): any { return { LocalDomainInfo: info(connection.local), RemoteDomainInfo: info(connection.remote), ConnectionId: connection.id, ConnectionMode: 'DIRECT', ConnectionStatus: { StatusCode: connection.status, Message: { PENDING_ACCEPTANCE: 'Waiting for destination owner approval', ACTIVE: 'Embedded cross-cluster search is available', REJECTED: 'Destination owner rejected the connection', DELETED: 'Connection revoked' }[connection.status] }, ...(!inbound ? { ConnectionAlias: connection.alias, ConnectionProperties: { CrossClusterSearch: { SkipUnavailable: connection.skipUnavailable ? 'ENABLED' : 'DISABLED' } } } : {}) }; }
  assertDeletable(domain: DomainRecord): void { if (this.all().some(connection => !terminal(connection) && [connection.local.generation, connection.remote.generation].includes(domain.generation))) invalid('Delete inbound and outbound connections before deleting this domain'); }
  private eligible(domain: DomainRecord): void { if (domain.state !== 'active' || !domain.config.AdvancedSecurityOptions.Enabled || !domain.config.NodeToNodeEncryptionOptions.Enabled) invalid('Cross-cluster search requires active domains with fine-grained security and node-to-node encryption'); }
  resolve(domain: DomainRecord, alias: string): { connection: SearchConnection; remote: DomainRecord | undefined } {
    if (this.publishing) throw new AwsError('InternalException', 'Connection configuration is being committed; retry the search', 503);
    const connection = this.all().find(item => item.local.generation === domain.generation && item.alias === alias && !terminal(item));
    if (!connection || connection.status !== 'ACTIVE') throw new AwsError('ResourceNotFoundException', `No active cross-cluster connection [${alias}]`, 404);
    return { connection, remote: this.domains().find(item => item.generation === connection.remote.generation) };
  }
  async execute(operation: string, input: any, region: string, account: string): Promise<any> {
    validateInput({ family: 'opensearch', operation, input, status: 200 });
    return this.store.withMutationLock('opensearch:connections', async () => {
      const inbound = operation.includes('Inbound'), state = this.state(region, account);
      const owned = this.all().filter(connection => { const owner = inbound ? connection.remote : connection.local; return owner.accountId === account && owner.region === region && this.visible(connection); });
      if (operation.startsWith('Describe')) {
        const size = input.MaxResults ?? 100; if (!Number.isInteger(size) || size < 1 || size > 100) invalid('MaxResults must be between 1 and 100');
        const filters = input.Filters ?? [], side = inbound ? 'local' : 'remote', other = inbound ? 'remote' : 'local';
        const names = ['connection-id', `${side}-domain-info.domain-name`, `${side}-domain-info.owner-id`, `${side}-domain-info.region`, `${other}-domain-info.domain-name`];
        if (filters.length > 5 || new Set(filters.map((filter: any) => filter.Name)).size !== filters.length || filters.some((filter: any) => !names.includes(filter.Name) || !filter.Values?.length || filter.Values.length > 20)) invalid('Unsupported or duplicate connection filter; values use exact matching');
        const rows = owned.filter(connection => filters.every((filter: any) => { const [prefix, field] = filter.Name.split('.'), target = prefix === 'local-domain-info' ? connection.local : connection.remote; const value = prefix === 'connection-id' ? connection.id : field === 'domain-name' ? target.name : field === 'owner-id' ? target.accountId : target.region; return filter.Values.includes(value); })).sort((a, b) => a.id.localeCompare(b.id)).map(connection => this.view(connection, inbound));
        const fingerprint = createHash('sha256').update(JSON.stringify([rows, filters, size])).digest('hex'), tokens = new PaginationTokens(state.cursorKey), scope = `${account}:${region}:${operation}`; let offset = 0;
        if (input.NextToken) { try { if (input.NextToken.split('.').length !== 2) throw new Error(); const token = tokens.decode<any>(scope, input.NextToken); if (token.fingerprint !== fingerprint || token.expires <= this.clock.now() || !Number.isInteger(token.offset) || token.offset < 1 || token.offset >= rows.length) throw new Error(); offset = token.offset; } catch { throw new AwsError('InvalidPaginationTokenException', 'Invalid, expired or stale connection token', 400); } }
        // Persist the destination view's pagination secret before returning a token.
        if (offset + size < rows.length) await this.store.save();
        return { Connections: rows.slice(offset, offset + size), ...(offset + size < rows.length ? { NextToken: tokens.encode(scope, { fingerprint, offset: offset + size, expires: this.clock.now() + 600000 }) } : {}) };
      }
      const catalogs = this.catalogs(), previous = catalogs.map(catalog => structuredClone(catalog)); this.publishing = true;
      try {
        for (const catalog of catalogs) for (const [id, connection] of Object.entries(catalog.records)) if (!this.visible(connection)) delete catalog.records[id];
        let connection: SearchConnection;
        if (operation === 'CreateOutboundConnection') {
          if (input.ConnectionMode !== undefined && input.ConnectionMode !== 'DIRECT' || input.ConnectionProperties?.Endpoint !== undefined) invalid('Only embedded DIRECT connections are supported; VPC endpoints are unavailable');
          if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,99}$/.test(input.ConnectionAlias)) invalid('Connection aliases require 2–100 letters, digits, underscores or hyphens and must start with a letter');
          const select = (value: any, local: boolean) => {
            const data = value?.AWSDomainInformation; if (!data) return invalid('AWSDomainInformation is required');
            const owner = data.OwnerId ?? account, targetRegion = data.Region ?? region;
            if (local && (owner !== account || targetRegion !== region)) invalid('The source domain must belong to the caller account and requested Region');
            const domain = this.domains().find(item => item.name === data.DomainName && item.region === targetRegion && item.accountId === owner);
            if (!domain) return invalid('Connection domain does not exist in this StackSim installation'); this.eligible(domain); return domain;
          };
          const local = select(input.LocalDomainInfo, true), remote = select(input.RemoteDomainInfo, false), all = this.all();
          if (local.generation === remote.generation || local.arn.split(':')[1] !== remote.arn.split(':')[1]) invalid('Connections require distinct domains within the same AWS partition');
          if (local.config.EngineVersion !== remote.config.EngineVersion) invalid('Embedded connections require matching supported engine versions');
          if (all.some(item => item.local.generation === local.generation && !terminal(item) && (item.alias === input.ConnectionAlias || item.remote.generation === remote.generation))) invalid('An alias or connection to this destination already exists');
          if (all.filter(item => !terminal(item) && item.local.generation === local.generation).length >= 20 || all.filter(item => !terminal(item) && item.remote.generation === remote.generation).length >= 20 || all.length >= 1000) throw new AwsError('LimitExceededException', 'Connection limits reached: 20 incoming/outgoing per domain and 1000 retained per installation', 409);
          connection = { id: `cc-${randomUUID()}`, alias: input.ConnectionAlias, local: reference(local), remote: reference(remote), status: 'PENDING_ACCEPTANCE', skipUnavailable: input.ConnectionProperties?.CrossClusterSearch?.SkipUnavailable === 'ENABLED', updatedAt: this.clock.now() };
          state.records[connection.id] = connection;
        } else {
          const current = owned.find(item => item.id === input.ConnectionId); if (!current) throw new AwsError('ResourceNotFoundException', 'Connection does not exist in this account and Region', 409); connection = current;
          if (operation === 'AcceptInboundConnection') {
            if (!['PENDING_ACCEPTANCE', 'ACTIVE'].includes(connection.status)) invalid('Only pending connections can be accepted');
            for (const ref of [connection.local, connection.remote]) { const domain = this.domains().find(item => item.generation === ref.generation); if (!domain) invalid('Connection domain no longer exists'); this.eligible(domain!); }
            connection.status = 'ACTIVE';
          } else if (operation === 'RejectInboundConnection') { if (!['PENDING_ACCEPTANCE', 'REJECTED'].includes(connection.status)) invalid('Only pending connections can be rejected'); connection.status = 'REJECTED'; }
          else if (operation === 'DeleteInboundConnection' || operation === 'DeleteOutboundConnection') connection.status = 'DELETED';
          else invalid('Unsupported connection operation');
          connection.updatedAt = this.clock.now();
        }
        await this.store.save(); const view = this.view(connection, inbound); return operation === 'CreateOutboundConnection' ? view : { Connection: view };
      } catch (error) { catalogs.forEach((catalog, index) => Object.assign(catalog, previous[index])); throw error; }
      finally { this.publishing = false; }
    });
  }
}
