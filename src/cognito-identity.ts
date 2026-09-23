import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CognitoService } from "./cognito.js";
import {
  COGNITO_IDENTITY_ACTION_INVENTORY,
  cognitoIdentityTargetOperation,
} from "./cognito-identity/action-inventory.js";
import {
  CREDENTIAL_LIFETIME_SECONDS,
  GET_CREDENTIALS_RATE,
  GET_ID_RATE,
  IDENTITY_ID_PATTERN,
  LIST_TAGS_RATE,
  MAX_IDENTITIES_PER_POOL,
  MAX_IDENTITY_ID_LENGTH,
  MAX_IDENTITY_POOLS,
  MAX_LIST_RESULTS,
  TAG_RATE,
  allocateIdentityId,
  identityPoolArn,
  loginIndexKey,
  partitionForRegion,
  parseUserPoolProviderName,
  type RandomBytes,
} from "./cognito-identity/model.js";
import { guestSessionPolicies } from "./cognito-identity/session-policies.js";
import {
  cognitoIdentityProviders,
  identityPoolName,
  identityPoolRoles,
  identityPoolRoleMappings,
  loginsMap,
  rejectUnsupportedPoolFields,
  requiredBoolean,
  requiredString,
  tagMap,
} from "./cognito-identity/validation.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Clock } from "./core/clock.js";
import { AwsError } from "./errors.js";
import { parseCognitoJson, sendCognitoError, sendCognitoJson } from "./cognito/protocol.js";
import type { StateStore } from "./state.js";
import type { StsService } from "./sts.js";
import type {
  CognitoIdentityPoolState,
  CognitoIdentityProviderBindingState,
  CognitoIdentityRecordState,
} from "./types.js";

const RATE_WINDOW_MS = 1000;

export class CognitoIdentityService {
  private mutation = Promise.resolve();
  constructor(
    private readonly store: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    private readonly sts: StsService,
    private readonly cognito: CognitoService,
    private readonly random: RandomBytes = randomBytes,
  ) {}

  private get state() {
    return this.store.regionState(this.region).cognitoIdentity;
  }

  private get tokens(): PaginationTokens {
    return new PaginationTokens(this.store.state.installation.paginationSecret);
  }

  private get partition(): string {
    return partitionForRegion(this.region);
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  private arn(poolId: string): string {
    return identityPoolArn(this.partition, this.region, this.store.accountId, poolId);
  }

  resourceArn(poolId: string): string {
    return this.arn(poolId);
  }

  private pool(id: string): CognitoIdentityPoolState {
    const pool = this.state.pools[id];
    if (!pool) throw new AwsError("ResourceNotFoundException", `Identity pool '${id}' not found.`);
    return pool;
  }

  private poolFromArn(arn: string): CognitoIdentityPoolState {
    const prefix = `arn:${this.partition}:cognito-identity:${this.region}:${this.store.accountId}:identitypool/`;
    if (!arn.startsWith(prefix)) throw new AwsError("InvalidParameterException", "ResourceArn is invalid.");
    return this.pool(arn.slice(prefix.length));
  }

  private assertIdentityId(value: unknown, poolRegion = this.region): string {
    const id = requiredString(value, "IdentityId", 1, MAX_IDENTITY_ID_LENGTH);
    if (!IDENTITY_ID_PATTERN.test(id) || !id.startsWith(`${poolRegion}:`)) {
      throw new AwsError("InvalidParameterException", "IdentityId is invalid.");
    }
    return id;
  }

  private admit(kind: string, rate: number): void {
    const now = this.clock.now();
    const key = kind;
    const existing = this.state.rateBuckets[key];
    const timestamps = (existing?.timestamps ?? []).filter(timestamp => timestamp > now - RATE_WINDOW_MS && timestamp <= now);
    if (timestamps.length >= rate) {
      this.state.rateBuckets[key] = { timestamps };
      throw new AwsError("TooManyRequestsException", "Rate exceeded.");
    }
    timestamps.push(now);
    this.state.rateBuckets[key] = { timestamps };
  }

  private providerView(providers: CognitoIdentityProviderBindingState[]): Array<Record<string, unknown>> {
    return providers.map(provider => ({
      ProviderName: provider.providerName,
      ClientId: provider.clientId,
      ServerSideTokenCheck: provider.serverSideTokenCheck,
    }));
  }

  private poolView(pool: CognitoIdentityPoolState): Record<string, unknown> {
    return {
      IdentityPoolId: pool.id,
      IdentityPoolName: pool.name,
      AllowUnauthenticatedIdentities: pool.allowUnauthenticatedIdentities,
      AllowClassicFlow: false,
      CognitoIdentityProviders: this.providerView(pool.cognitoIdentityProviders),
      IdentityPoolTags: { ...pool.tags },
    };
  }

  private assertProvidersExist(providers: CognitoIdentityProviderBindingState[]): void {
    const userPools = this.store.regionState(this.region).cognito.pools;
    for (const provider of providers) {
      const parsed = parseUserPoolProviderName(provider.providerName, this.region);
      if (!parsed) {
        throw new AwsError("InvalidParameterException", "CognitoIdentityProviders contains an invalid provider.");
      }
      const pool = userPools[parsed.userPoolId];
      if (!pool || !pool.clients[provider.clientId]) {
        throw new AwsError("InvalidParameterException", "CognitoIdentityProviders must reference an existing same-account User Pool app client.");
      }
    }
  }

  private sameAccountRole(arn: string, field: string): void {
    const match = arn.match(/^arn:[^:]+:iam::(\d{12}):role\/.+/);
    if (!match || match[1] !== this.store.accountId) {
      throw new AwsError("InvalidParameterException", `${field} must be a same-account IAM role ARN.`);
    }
    const role = Object.values(this.store.ensureAccount().iam.roles).find(item => item.arn === arn);
    if (!role) throw new AwsError("InvalidParameterException", `${field} must identify an existing IAM role.`);
  }

  async handle(req: IncomingMessage, res: ServerResponse, _requestId: string): Promise<void> {
    const target = String(req.headers["x-amz-target"] ?? "");
    const operation = cognitoIdentityTargetOperation(target);
    try {
      if (req.method !== "POST" || req.url?.split("?", 1)[0] !== "/") {
        throw new AwsError("UnknownOperationException", "Unknown operation.");
      }
      if (!operation) {
        throw new AwsError("UnknownOperationException", "Unknown operation.");
      }
      const input = await parseCognitoJson(req);
      const output = await this.dispatch(operation, input);
      sendCognitoJson(res, output);
    } catch (error) {
      sendCognitoError(res, error);
    }
  }

  async executeCloudFormationControl(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await this.dispatch(operation, input)) ?? {};
  }

  private dispatch(operation: string, input: Record<string, any>): Promise<Record<string, unknown> | void> {
    const entry = COGNITO_IDENTITY_ACTION_INVENTORY.get(operation);
    if (!entry) throw new AwsError("UnknownOperationException", "Unknown operation.");
    if (entry.phase !== "implemented-in-P0") {
      throw new AwsError("InvalidParameterException", `${operation} is not supported.`);
    }
    switch (operation) {
      case "CreateIdentityPool": return this.CreateIdentityPool(input);
      case "DescribeIdentityPool": return Promise.resolve(this.DescribeIdentityPool(input));
      case "ListIdentityPools": return Promise.resolve(this.ListIdentityPools(input));
      case "UpdateIdentityPool": return this.UpdateIdentityPool(input);
      case "DeleteIdentityPool": return this.DeleteIdentityPool(input);
      case "GetIdentityPoolRoles": return Promise.resolve(this.GetIdentityPoolRoles(input));
      case "SetIdentityPoolRoles": return this.SetIdentityPoolRoles(input);
      case "TagResource": return this.TagResource(input);
      case "UntagResource": return this.UntagResource(input);
      case "ListTagsForResource": return Promise.resolve(this.ListTagsForResource(input));
      case "GetId": return this.GetId(input);
      case "GetCredentialsForIdentity": return this.GetCredentialsForIdentity(input);
      default:
        throw new AwsError("InvalidParameterException", `${operation} is not supported.`);
    }
  }

  async CreateIdentityPool(input: Record<string, any>): Promise<Record<string, unknown>> {
    rejectUnsupportedPoolFields(input);
    const name = identityPoolName(input.IdentityPoolName);
    const allowUnauthenticated = requiredBoolean(input.AllowUnauthenticatedIdentities, "AllowUnauthenticatedIdentities");
    const providers = cognitoIdentityProviders(input.CognitoIdentityProviders, this.region);
    const tags = tagMap(input.IdentityPoolTags, "IdentityPoolTags");
    this.assertProvidersExist(providers);
    return this.exclusive(async () => {
      if (Object.keys(this.state.pools).length >= MAX_IDENTITY_POOLS) {
        throw new AwsError("LimitExceededException", "The identity-pool limit has been exceeded.");
      }
      let id: string;
      do { id = allocateIdentityId(this.region, this.random); } while (this.state.pools[id]);
      const now = this.clock.now();
      const pool: CognitoIdentityPoolState = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        allowUnauthenticatedIdentities: allowUnauthenticated,
        allowClassicFlow: false,
        cognitoIdentityProviders: providers,
        tags,
        identities: {},
        loginIndex: {},
      };
      this.state.pools[id] = pool;
      this.state.revision += 1;
      await this.store.save();
      return this.poolView(pool);
    });
  }

  DescribeIdentityPool(input: Record<string, any>): Record<string, unknown> {
    const id = requiredString(input.IdentityPoolId, "IdentityPoolId", 1, MAX_IDENTITY_ID_LENGTH);
    return this.poolView(this.pool(id));
  }

  ListIdentityPools(input: Record<string, any>): Record<string, unknown> {
    const maxResults = input.MaxResults === undefined ? MAX_LIST_RESULTS : Number(input.MaxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_LIST_RESULTS) {
      throw new AwsError("InvalidParameterException", "MaxResults must be between 1 and 60.");
    }
    const pools = Object.values(this.state.pools).sort((left, right) => left.id.localeCompare(right.id));
    let start = 0;
    if (input.NextToken !== undefined) {
      try {
        start = this.tokens.decode<number>("ListIdentityPools", String(input.NextToken));
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
      if (!Number.isInteger(start) || start < 0 || start > pools.length) {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const page = pools.slice(start, start + maxResults);
    const next = start + page.length;
    return {
      IdentityPools: page.map(pool => ({ IdentityPoolId: pool.id, IdentityPoolName: pool.name })),
      ...(next < pools.length ? { NextToken: this.tokens.encode("ListIdentityPools", next) } : {}),
    };
  }

  async UpdateIdentityPool(input: Record<string, any>): Promise<Record<string, unknown>> {
    rejectUnsupportedPoolFields(input);
    const id = requiredString(input.IdentityPoolId, "IdentityPoolId", 1, MAX_IDENTITY_ID_LENGTH);
    const name = identityPoolName(input.IdentityPoolName);
    const allowUnauthenticated = requiredBoolean(input.AllowUnauthenticatedIdentities, "AllowUnauthenticatedIdentities");
    const providers = cognitoIdentityProviders(input.CognitoIdentityProviders, this.region);
    const tags = input.IdentityPoolTags === undefined ? undefined : tagMap(input.IdentityPoolTags, "IdentityPoolTags");
    this.assertProvidersExist(providers);
    return this.exclusive(async () => {
      const pool = this.pool(id);
      pool.name = name;
      pool.allowUnauthenticatedIdentities = allowUnauthenticated;
      pool.cognitoIdentityProviders = providers;
      if (tags) pool.tags = tags;
      pool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return this.poolView(pool);
    });
  }

  async DeleteIdentityPool(input: Record<string, any>): Promise<Record<string, unknown>> {
    const id = requiredString(input.IdentityPoolId, "IdentityPoolId", 1, MAX_IDENTITY_ID_LENGTH);
    return this.exclusive(async () => {
      this.pool(id);
      delete this.state.pools[id];
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  GetIdentityPoolRoles(input: Record<string, any>): Record<string, unknown> {
    const id = requiredString(input.IdentityPoolId, "IdentityPoolId", 1, MAX_IDENTITY_ID_LENGTH);
    const pool = this.pool(id);
    return {
      IdentityPoolId: pool.id,
      Roles: { ...(pool.roles ?? {}) },
      ...(pool.roleMappings ? { RoleMappings: structuredClone(pool.roleMappings) } : {}),
    };
  }

  async SetIdentityPoolRoles(input: Record<string, any>): Promise<Record<string, unknown>> {
    const id = requiredString(input.IdentityPoolId, "IdentityPoolId", 1, MAX_IDENTITY_ID_LENGTH);
    const roles = identityPoolRoles(input.Roles);
    const roleMappings = identityPoolRoleMappings(input.RoleMappings);
    if (roles.authenticated) this.sameAccountRole(roles.authenticated, "Roles.authenticated");
    if (roles.unauthenticated) this.sameAccountRole(roles.unauthenticated, "Roles.unauthenticated");
    return this.exclusive(async () => {
      const pool = this.pool(id);
      if (Object.keys(roles).length && pool.allowUnauthenticatedIdentities && !roles.unauthenticated) {
        throw new AwsError("InvalidParameterException", "Roles.unauthenticated is required when unauthenticated identities are enabled.");
      }
      if (Object.keys(roleMappings).some(provider => !pool.cognitoIdentityProviders.some(binding => `${binding.providerName}:${binding.clientId}` === provider))
        || Object.keys(roleMappings).length && !roles.authenticated) {
        throw new AwsError("InvalidParameterException", "Token role mappings require an attached User Pool client and authenticated role.");
      }
      pool.roles = Object.keys(roles).length ? roles : undefined;
      pool.roleMappings = Object.keys(roleMappings).length ? roleMappings : undefined;
      pool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async TagResource(input: Record<string, any>): Promise<Record<string, unknown>> {
    this.admit("TagResource", TAG_RATE);
    const arn = requiredString(input.ResourceArn, "ResourceArn", 20, 2048);
    const tags = tagMap(input.Tags);
    return this.exclusive(async () => {
      const pool = this.poolFromArn(arn);
      const next = { ...pool.tags, ...tags };
      if (Object.keys(next).length > 50) {
        throw new AwsError("InvalidParameterException", "Tags exceeds the maximum number of tags.");
      }
      pool.tags = next;
      pool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async UntagResource(input: Record<string, any>): Promise<Record<string, unknown>> {
    this.admit("UntagResource", TAG_RATE);
    const arn = requiredString(input.ResourceArn, "ResourceArn", 20, 2048);
    if (!Array.isArray(input.TagKeys) || input.TagKeys.some((key: unknown) => typeof key !== "string")) {
      throw new AwsError("InvalidParameterException", "TagKeys is invalid.");
    }
    const keys = input.TagKeys as string[];
    return this.exclusive(async () => {
      const pool = this.poolFromArn(arn);
      for (const key of keys) delete pool.tags[key];
      pool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  ListTagsForResource(input: Record<string, any>): Record<string, unknown> {
    this.admit("ListTagsForResource", LIST_TAGS_RATE);
    const arn = requiredString(input.ResourceArn, "ResourceArn", 20, 2048);
    return { Tags: { ...this.poolFromArn(arn).tags } };
  }

  private verifyLogins(
    pool: CognitoIdentityPoolState,
    logins: Record<string, string>,
  ): { providerName: string; subject: string; serverSideTokenCheck: boolean } | undefined {
    const keys = Object.keys(logins);
    if (!keys.length) return undefined;
    if (keys.length !== 1) {
      throw new AwsError("InvalidParameterException", "Exactly one User Pool login is supported.");
    }
    const providerName = keys[0];
    const binding = pool.cognitoIdentityProviders.find(provider => provider.providerName === providerName);
    if (!binding) {
      throw new AwsError("NotAuthorizedException", "Invalid login token.");
    }
    const parsed = parseUserPoolProviderName(providerName, this.region);
    if (!parsed) throw new AwsError("NotAuthorizedException", "Invalid login token.");
    const verified = this.cognito.verifyIdentityPoolIdToken({
      userPoolId: parsed.userPoolId,
      clientId: binding.clientId,
      token: logins[providerName],
      serverSideTokenCheck: binding.serverSideTokenCheck,
    });
    const mapping = pool.roleMappings?.[`${binding.providerName}:${binding.clientId}`];
    if (mapping && verified.hasRoleClaims) {
      // The generated no-group graph uses AuthenticatedRole when the ID token
      // contains no role claims. Group/preferred-role selection is not admitted.
      throw new AwsError("NotAuthorizedException", "Token role claims are not supported by this identity pool role mapping.");
    }
    return { providerName, subject: verified.sub, serverSideTokenCheck: binding.serverSideTokenCheck };
  }

  async GetId(input: Record<string, any>): Promise<Record<string, unknown>> {
    this.admit("GetId", GET_ID_RATE);
    const poolId = requiredString(input.IdentityPoolId, "IdentityPoolId", 1, MAX_IDENTITY_ID_LENGTH);
    if (input.AccountId !== undefined && String(input.AccountId) !== this.store.accountId) {
      throw new AwsError("NotAuthorizedException", "Invalid AccountId.");
    }
    const logins = loginsMap(input.Logins);
    return this.exclusive(async () => {
      const pool = this.pool(poolId);
      const verified = this.verifyLogins(pool, logins);
      if (!verified && !pool.allowUnauthenticatedIdentities) {
        throw new AwsError("NotAuthorizedException", "Unauthenticated access is not allowed for this identity pool.");
      }
      if (verified) {
        const existingId = pool.loginIndex[loginIndexKey(verified.providerName, verified.subject)];
        if (existingId && pool.identities[existingId]) {
          return { IdentityId: existingId };
        }
      }
      if (Object.keys(pool.identities).length >= MAX_IDENTITIES_PER_POOL) {
        throw new AwsError("LimitExceededException", "The identity limit has been exceeded.");
      }
      let identityId: string;
      do { identityId = allocateIdentityId(this.region, this.random); } while (pool.identities[identityId]);
      const now = this.clock.now();
      const record: CognitoIdentityRecordState = {
        identityId,
        identityPoolId: pool.id,
        createdAt: now,
        updatedAt: now,
        logins: verified ? { [verified.providerName]: verified.subject } : {},
        authClass: verified ? "authenticated" : "unauthenticated",
      };
      pool.identities[identityId] = record;
      if (verified) pool.loginIndex[loginIndexKey(verified.providerName, verified.subject)] = identityId;
      pool.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { IdentityId: identityId };
    });
  }

  async GetCredentialsForIdentity(input: Record<string, any>): Promise<Record<string, unknown>> {
    this.admit("GetCredentialsForIdentity", GET_CREDENTIALS_RATE);
    if (input.CustomRoleArn !== undefined) {
      throw new AwsError("InvalidParameterException", "CustomRoleArn is not supported.");
    }
    const requestedIdentityId = this.assertIdentityId(input.IdentityId);
    const logins = loginsMap(input.Logins);
    return this.exclusive(async () => {
      let identityId = requestedIdentityId;
      const pool = Object.values(this.state.pools).find(candidate => candidate.identities[identityId]);
      if (!pool) throw new AwsError("ResourceNotFoundException", "IdentityId is invalid.");
      let identity = pool.identities[identityId];
      const verified = this.verifyLogins(pool, logins);
      if (!verified) {
        if (!pool.allowUnauthenticatedIdentities || identity.authClass !== "unauthenticated") {
          throw new AwsError("NotAuthorizedException", "Unauthenticated access is not allowed for this identity pool.");
        }
        const roleArn = pool.roles?.unauthenticated;
        if (!roleArn) {
          throw new AwsError("InvalidIdentityPoolConfigurationException", "Invalid identity pool configuration.");
        }
        const credentials = await this.sts.issueCognitoIdentityCredentials({
          roleArn,
          sessionName: identityId.replace(/:/g, "_").slice(0, 64),
          durationSeconds: CREDENTIAL_LIFETIME_SECONDS,
          trustContext: {
            "cognito-identity.amazonaws.com:aud": pool.id,
            "cognito-identity.amazonaws.com:sub": identityId,
            "cognito-identity.amazonaws.com:amr": ["unauthenticated"],
          },
          sessionPolicies: guestSessionPolicies(),
          cognitoIdentity: {
            identityPoolId: pool.id,
            identityId,
            authClass: "unauthenticated",
            provider: "unauthenticated",
            roleArn,
          },
        });
        return { IdentityId: identityId, Credentials: credentials };
      }
      const indexKey = loginIndexKey(verified.providerName, verified.subject);
      const existingOwner = pool.loginIndex[indexKey];
      let mergedGuest: CognitoIdentityRecordState | undefined;
      if (existingOwner && existingOwner !== identityId) {
        const canonical = pool.identities[existingOwner];
        if (identity.authClass !== "unauthenticated" || Object.keys(identity.logins).length !== 0
          || canonical?.authClass !== "authenticated" || canonical.logins[verified.providerName] !== verified.subject) {
          throw new AwsError("ResourceConflictException", "The login is already linked to a different identity.");
        }
        // An unlinked guest may resolve to an existing verified login. Preserve
        // that login's parent identity and retire the guest only with issuance.
        mergedGuest = identity;
        identityId = existingOwner;
        identity = canonical;
      }
      if (identity.authClass === "authenticated"
        && identity.logins[verified.providerName] !== verified.subject) {
        throw new AwsError("NotAuthorizedException", "Invalid login token.");
      }
      const roleArn = pool.roles?.authenticated;
      if (!roleArn) {
        throw new AwsError("InvalidIdentityPoolConfigurationException", "Invalid identity pool configuration.");
      }
      const previousIdentity = structuredClone(identity);
      const previousUpdatedAt = pool.updatedAt;
      const previousRevision = this.state.revision;
      const credentials = await this.sts.issueCognitoIdentityCredentials({
        roleArn,
        sessionName: identityId.replace(/:/g, "_").slice(0, 64),
        durationSeconds: CREDENTIAL_LIFETIME_SECONDS,
        trustContext: {
          "cognito-identity.amazonaws.com:aud": pool.id,
          "cognito-identity.amazonaws.com:sub": identityId,
          "cognito-identity.amazonaws.com:amr": ["authenticated", verified.providerName],
        },
        cognitoIdentity: {
          identityPoolId: pool.id,
          identityId,
          authClass: "authenticated",
          provider: verified.providerName,
          roleArn,
        },
        stateTransition: {
          commit: () => {
            if (mergedGuest) {
              delete pool.identities[requestedIdentityId];
            } else {
              identity.authClass = "authenticated";
              identity.logins[verified.providerName] = verified.subject;
              identity.updatedAt = this.clock.now();
              pool.loginIndex[indexKey] = identityId;
            }
            pool.updatedAt = this.clock.now();
            this.state.revision += 1;
          },
          rollback: () => {
            Object.assign(identity, previousIdentity);
            if (mergedGuest) pool.identities[requestedIdentityId] = mergedGuest;
            if (existingOwner === undefined) delete pool.loginIndex[indexKey];
            else pool.loginIndex[indexKey] = existingOwner;
            pool.updatedAt = previousUpdatedAt;
            this.state.revision = previousRevision;
          },
        },
      });
      return { IdentityId: identityId, Credentials: credentials };
    });
  }

  summary(): { poolCount: number; identityCount: number } {
    const pools = Object.values(this.state.pools);
    return {
      poolCount: pools.length,
      identityCount: pools.reduce((total, pool) => total + Object.keys(pool.identities).length, 0),
    };
  }

  localIdentityPools(): { identityPools: Array<Record<string, unknown>> } {
    return {
      identityPools: Object.values(this.state.pools)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
        .map(pool => ({
          id: pool.id,
          arn: this.arn(pool.id),
          name: pool.name,
          allowUnauthenticatedIdentities: pool.allowUnauthenticatedIdentities,
          providerCount: pool.cognitoIdentityProviders.length,
          identityCount: Object.keys(pool.identities).length,
          createdAt: pool.createdAt,
          tags: { ...pool.tags },
        })),
    };
  }

  localIdentityPool(id: string): Record<string, unknown> {
    const pool = this.pool(id);
    return {
      ...this.poolView(pool),
      Arn: this.arn(pool.id),
      Roles: { ...(pool.roles ?? {}) },
      IdentityCount: Object.keys(pool.identities).length,
      CreatedAt: pool.createdAt,
      UpdatedAt: pool.updatedAt,
    };
  }
}
