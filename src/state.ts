import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION, emptyRegion, emptyState, DEFAULT_ACCOUNT_ID } from "./migrations/v1-to-v2.js";
import { migrateState } from "./migrations/index.js";
import type { AccountState, RegionState, SimState } from "./types.js";
import { normalizeTableItemKeys } from "./dynamodb/values.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizeIamState } from "./iam/model.js";
import { emptySesRegionState } from "./migrations/v51-to-v52.js";
import { emptyCognitoRegionState } from "./migrations/v52-to-v53.js";
import { emptySes04State } from "./migrations/v67-to-v68.js";
import type { IamCredentialStore } from "./iam/credentials.js";
import { emptyCloudFrontAccountState } from "./migrations/v87-to-v88.js";

export class StateStore {
  readonly root: string;
  readonly file: string;
  state: SimState;
  private saving = Promise.resolve();
  private readonly mutationTails = new Map<string, Promise<void>>();
  wasCreated = false;
  loadedSchemaVersion = CURRENT_SCHEMA_VERSION;
  credentialStore?: IamCredentialStore;
  configuredCredentials?: { accessKeyId: string; secretAccessKey: string; rootRecovery: boolean };

  async withMutationLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolveLock => { release = resolveLock; });
    const tail = previous.then(() => current);
    this.mutationTails.set(scope, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.mutationTails.get(scope) === tail) this.mutationTails.delete(scope);
    }
  }

  withAccountMutation<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    return this.withMutationLock(`account:${accountId}`, work);
  }

  withCredentialMutation<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    return this.withMutationLock("credentials", () => this.withAccountMutation(accountId, work));
  }

  constructor(
    root = process.env.STACKSIM_DATA_DIR ?? resolve(".stacksim"),
    readonly accountId = process.env.STACKSIM_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
    readonly defaultRegion = process.env.AWS_REGION ?? "eu-west-1",
  ) {
    this.root = resolve(root);
    this.file = resolve(this.root, "state.json");
    this.state = emptyState(this.accountId, this.defaultRegion);
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      this.loadedSchemaVersion = Number(parsed?.schemaVersion ?? 1);
      const result = migrateState(parsed, this.accountId, this.defaultRegion);
      this.state = result.state;
      let normalized = false;
      if (!this.state.installation.sqsEncryptionKey) { this.state.installation.sqsEncryptionKey = randomBytes(32).toString("base64"); normalized = true; }
      if (!this.state.installation.snsEncryptionKey) { this.state.installation.snsEncryptionKey = randomBytes(32).toString("base64"); normalized = true; }
      if (!this.state.installation.eventBridgeArchiveEncryptionKey) { this.state.installation.eventBridgeArchiveEncryptionKey = randomBytes(32).toString("base64"); normalized = true; }
      if (!this.state.installation.sesSigningSecret) { this.state.installation.sesSigningSecret = randomBytes(32).toString("base64"); normalized = true; }
      if (!this.state.installation.defaultAdministrators) { this.state.installation.defaultAdministrators = {}; normalized = true; }
      this.ensureAccount(this.accountId);
      this.regionState(this.defaultRegion, this.accountId);
      for (const [accountId, account] of Object.entries(this.state.accounts)) { const iam = normalizeIamState(account.iam, Date.now(), accountId); if (JSON.stringify(iam) !== JSON.stringify(account.iam)) { account.iam = iam; normalized = true; } if (!account.cloudwatchDashboards) { account.cloudwatchDashboards = {}; normalized = true; } if (!account.cloudfront) { account.cloudfront = emptyCloudFrontAccountState(); normalized = true; } }
      for (const account of Object.values(this.state.accounts)) for (const region of Object.values(account.regions)) {
        if (!region.cloudformation) { region.cloudformation = { stacks: {}, stackNames: {}, changeSets: {}, changeSetNames: {}, exports: {}, clientTokens: {} }; normalized = true; }
        if (region.cloudformation.deploymentGeneration === undefined) { region.cloudformation.deploymentGeneration = 0; normalized = true; }
        if (!region.cloudformation.resourceOwnership) { region.cloudformation.resourceOwnership = {}; normalized = true; }
        if (!region.cloudformation.hotswapDrift) { region.cloudformation.hotswapDrift = {}; normalized = true; }
        if (!region.cloudformation.hotswapOperations) { region.cloudformation.hotswapOperations = []; normalized = true; }
        if (!region.parameterStore) { region.parameterStore = { revision: 0, parameters: {}, tombstones: {} }; normalized = true; }
        if (!region.secretsManager) { region.secretsManager = { revision: 0, secrets: {}, retiredSuffixes: {} }; normalized = true; }
        for (const parameter of Object.values(region.parameterStore.parameters)) if (!parameter.labels) { parameter.labels = {}; normalized = true; }
        for (const secret of Object.values(region.secretsManager.secrets)) if (secret.policyRevision === undefined) { secret.policyRevision = secret.resourcePolicy?.revision ?? 0; normalized = true; }
        if (!region.appsync) { region.appsync = { revision: 0, graphqlApis: {} }; normalized = true; }
        if (!region.stepFunctions) { region.stepFunctions = { revision: 0, stateMachines: {}, stateMachineNames: {}, executions: {}, executionNames: {}, activities: {}, activityNames: {} }; normalized = true; }
        if (!region.stepFunctions.activities) { region.stepFunctions.activities = {}; normalized = true; }
        if (!region.stepFunctions.activityNames) { region.stepFunctions.activityNames = {}; normalized = true; }
        if (!region.dynamodbIntegrationAttempts) { region.dynamodbIntegrationAttempts = {}; normalized = true; }
        if (!region.ses) { region.ses = emptySesRegionState(); normalized = true; }
        else {
          const defaults = emptySesRegionState();
          if (region.ses.controlRevision === undefined) { region.ses.controlRevision = defaults.controlRevision; normalized = true; }
          if (!region.ses.account) { region.ses.account = defaults.account; normalized = true; }
          else for (const [key, value] of Object.entries(defaults.account)) if ((region.ses.account as any)[key] === undefined) { (region.ses.account as any)[key] = value; normalized = true; }
          if (!region.ses.identities) { region.ses.identities = {}; normalized = true; }
          if (!region.ses.verificationIntents) { region.ses.verificationIntents = {}; normalized = true; }
          if (!region.ses.callbackResults) { region.ses.callbackResults = {}; normalized = true; }
          if (!region.ses.templates) { region.ses.templates = {}; normalized = true; }
          if (!region.ses.configurationSets) { region.ses.configurationSets = {}; normalized = true; }
          const ses04 = emptySes04State();
          for (const [key, value] of Object.entries(ses04)) if (!(region.ses as any)[key]) { (region.ses as any)[key] = value; normalized = true; }
        }
        if (!region.cognito) { region.cognito = emptyCognitoRegionState(); normalized = true; }
        else {
          const defaults = emptyCognitoRegionState();
          if (region.cognito.revision === undefined) { region.cognito.revision = defaults.revision; normalized = true; }
          if (!region.cognito.pools) { region.cognito.pools = {}; normalized = true; }
          if (!region.cognito.poolNameIndex) { region.cognito.poolNameIndex = {}; normalized = true; }
          if (!region.cognito.issuerTombstones) { region.cognito.issuerTombstones = {}; normalized = true; }
          if (!region.cognito.deliveryIntents) { region.cognito.deliveryIntents = {}; normalized = true; }
          if (!region.cognito.admissions) { region.cognito.admissions = {}; normalized = true; }
          if (!Array.isArray(region.cognito.audit)) { region.cognito.audit = []; normalized = true; }
          if (!region.cognito.domainIndex) { region.cognito.domainIndex = {}; normalized = true; }
        }
        if (!region.sns) { region.sns = { revision: 0, topics: {}, subscriptions: {} }; normalized = true; }
        if (!region.rdsDbInstances) { region.rdsDbInstances = {}; normalized = true; }
        if (!region.rdsDbParameterGroups) { region.rdsDbParameterGroups = {}; normalized = true; }
        if (!region.rdsDbSnapshots) { region.rdsDbSnapshots = {}; normalized = true; }
        if (!region.s3Buckets) { region.s3Buckets = {}; normalized = true; }
        if (!region.sqsQueues) { region.sqsQueues = {}; normalized = true; }
        if (!region.sqsQueueDeletionTimes) { region.sqsQueueDeletionTimes = {}; normalized = true; }
        if (!region.eventBuses) { region.eventBuses = {}; normalized = true; }
        if (!region.eventRules) { region.eventRules = {}; normalized = true; }
        if (!region.eventTargets) { region.eventTargets = {}; normalized = true; }
        if (!region.eventScheduleGroups) { region.eventScheduleGroups = {}; normalized = true; }
        if (!region.eventSchedules) { region.eventSchedules = {}; normalized = true; }
        if (!region.eventScheduleOccurrences) { region.eventScheduleOccurrences = {}; normalized = true; }
        if (!region.apiGatewayAccount) { region.apiGatewayAccount = {}; normalized = true; }
        if (!region.apiGatewayApiKeys) { region.apiGatewayApiKeys = {}; normalized = true; }
        if (!region.apiGatewayUsagePlans) { region.apiGatewayUsagePlans = {}; normalized = true; }
        if (!region.apiGatewayResponseCaches) { region.apiGatewayResponseCaches = {}; normalized = true; }
        if (!region.apiGatewayDomainNames) { region.apiGatewayDomainNames = {}; normalized = true; }
        if (!region.apiGatewayDomainNameAccessAssociations) { region.apiGatewayDomainNameAccessAssociations = {}; normalized = true; }
        if (!region.apiGatewayVpcLinks) { region.apiGatewayVpcLinks = {}; normalized = true; }
        if (!region.apiGatewayClientCertificates) { region.apiGatewayClientCertificates = {}; normalized = true; }
        if (!region.httpApis) { region.httpApis = {}; normalized = true; }
        if (!region.webSocketApis) { region.webSocketApis = {}; normalized = true; }
        if (!region.apiGatewayV2DomainNames) { region.apiGatewayV2DomainNames = {}; normalized = true; }
        if (!region.logQueryDefinitions) { region.logQueryDefinitions = {}; normalized = true; }
        if (!region.logDestinations) { region.logDestinations = {}; normalized = true; }
        if (!region.logResourcePolicies) { region.logResourcePolicies = {}; normalized = true; }
        if (!region.logExportTasks) { region.logExportTasks = {}; normalized = true; }
        for (const group of Object.values(region.logs)) {
          if (!group.metricFilters) { group.metricFilters = {}; normalized = true; }
          if (!group.subscriptionFilters) { group.subscriptionFilters = {}; normalized = true; }
          for (const filter of Object.values(group.subscriptionFilters)) { if (!filter.checkpoints) { filter.checkpoints = {}; normalized = true; } if (!filter.deliveryAttempts) { filter.deliveryAttempts = {}; normalized = true; } }
        }
        if (!region.cloudwatch?.alarms || !Array.isArray(region.cloudwatch.alarmHistory)) { region.cloudwatch = { alarms: region.cloudwatch?.alarms ?? {}, compositeAlarms: region.cloudwatch?.compositeAlarms ?? {}, logAlarms: region.cloudwatch?.logAlarms ?? {}, alarmMuteRules: region.cloudwatch?.alarmMuteRules ?? {}, anomalyDetectors: region.cloudwatch?.anomalyDetectors ?? {}, ...(region.cloudwatch?.datasetKmsKeyArn ? { datasetKmsKeyArn: region.cloudwatch.datasetKmsKeyArn } : {}), metricStreams: region.cloudwatch?.metricStreams ?? {}, insightRules: region.cloudwatch?.insightRules ?? {}, alarmHistory: [], eventBridgeOutbox: region.cloudwatch?.eventBridgeOutbox ?? [] }; normalized = true; }
        if (!region.cloudwatch.compositeAlarms) { region.cloudwatch.compositeAlarms = {}; normalized = true; }
        if (!region.cloudwatch.logAlarms) { region.cloudwatch.logAlarms = {}; normalized = true; }
        if (!region.cloudwatch.alarmMuteRules) { region.cloudwatch.alarmMuteRules = {}; normalized = true; }
        if (!region.cloudwatch.anomalyDetectors) { region.cloudwatch.anomalyDetectors = {}; normalized = true; }
        if (!region.cloudwatch.metricStreams) { region.cloudwatch.metricStreams = {}; normalized = true; }
        if (!region.cloudwatch.insightRules) { region.cloudwatch.insightRules = {}; normalized = true; }
        if (!region.cloudwatch.eventBridgeOutbox) { region.cloudwatch.eventBridgeOutbox = []; normalized = true; }
        if (!region.dynamodbBackups) { region.dynamodbBackups = {}; normalized = true; }
        if (!region.dynamodbExports) { region.dynamodbExports = {}; normalized = true; }
        if (!region.dynamodbImports) { region.dynamodbImports = {}; normalized = true; }
        if (!region.dynamodbStreams) { region.dynamodbStreams = {}; normalized = true; }
        if (!region.dynamodbResourcePolicies) { region.dynamodbResourcePolicies = {}; normalized = true; }
        if (!region.dynamodbResourcePolicyMutationTimes) { region.dynamodbResourcePolicyMutationTimes = {}; normalized = true; }
        if (!region.lambdaAsyncInvocations) { region.lambdaAsyncInvocations = {}; normalized = true; }
        if (!region.lambdaEventSourceMappings) { region.lambdaEventSourceMappings = {}; normalized = true; }
        if (!region.lambdaLayers) { region.lambdaLayers = {}; normalized = true; }
        if (!region.lambdaCodeSigningConfigs) { region.lambdaCodeSigningConfigs = {}; normalized = true; }
        if (!region.lambdaCapacityProviders) { region.lambdaCapacityProviders = {}; normalized = true; }
        if (!region.lambdaDurableExecutions) { region.lambdaDurableExecutions = {}; normalized = true; }
        for (const fn of Object.values(region.functions)) { if (!fn.eventInvokeConfigs) { fn.eventInvokeConfigs = {}; normalized = true; } if (!fn.provisionedConcurrencyConfigs) { fn.provisionedConcurrencyConfigs = {}; normalized = true; } if (!fn.functionUrlConfigs) { fn.functionUrlConfigs = {}; normalized = true; } if (!fn.functionScalingConfigs) { fn.functionScalingConfigs = {}; normalized = true; } if (!fn.layers) { fn.layers = []; normalized = true; } for (const version of Object.values(fn.versions ?? {})) if (!version.layers) { version.layers = []; normalized = true; } }
        for (const table of Object.values(region.tables)) {
          if (!table.timeToLive) { table.timeToLive = { status: "DISABLED" }; normalized = true; }
          if (!table.tags) { table.tags = {}; normalized = true; }
          if (!table.tableClass) { table.tableClass = "STANDARD"; normalized = true; }
          if (table.deletionProtectionEnabled === undefined) { table.deletionProtectionEnabled = false; normalized = true; }
          if (!table.sse) { table.sse = { sseType: "AES256", status: "ENABLED" }; normalized = true; }
          if (!table.pointInTimeRecovery) { table.pointInTimeRecovery = { status: "DISABLED", recoveryPeriodInDays: 35, sequence: 0 }; normalized = true; }
          if (!table.contributorInsights) { table.contributorInsights = {}; normalized = true; }
          if (!table.kinesisStreamingDestinations) { table.kinesisStreamingDestinations = {}; normalized = true; }
          normalized = normalizeTableItemKeys(table) || normalized;
        }
        for (const api of Object.values(region.apis)) {
          if (!api.apiKeySource) { api.apiKeySource = "HEADER"; normalized = true; }
          if (!api.binaryMediaTypes) { api.binaryMediaTypes = []; normalized = true; }
          if (!api.gatewayResponses) { api.gatewayResponses = {}; normalized = true; }
          for (const stage of Object.values(api.stages ?? {})) { if (!stage.variables) { stage.variables = {}; normalized = true; } if (!stage.methodSettings) { stage.methodSettings = {}; normalized = true; } if (!stage.tags) { stage.tags = {}; normalized = true; } if (stage.tracingEnabled === undefined) { stage.tracingEnabled = false; normalized = true; } if (stage.cacheClusterEnabled === undefined) { stage.cacheClusterEnabled = false; normalized = true; } }
          for (const deployment of Object.values(api.deployments ?? {})) if (!deployment.snapshot) {
            deployment.snapshot = { rootResourceId: api.rootResourceId, resources: structuredClone(api.resources), authorizers: structuredClone(api.authorizers), policy: structuredClone(api.policy), binaryMediaTypes: structuredClone(api.binaryMediaTypes), minimumCompressionSize: api.minimumCompressionSize, gatewayResponses: structuredClone(api.gatewayResponses), apiKeySource: api.apiKeySource };
            deployment.contentHash = createHash("sha256").update(JSON.stringify(deployment.snapshot)).digest("hex"); normalized = true;
          } else if (!deployment.snapshot.apiKeySource) { deployment.snapshot.apiKeySource = "HEADER"; normalized = true; }
        }
      }
      const registered: Record<string, { accountId: string; region: string }> = {}; const currentRegistry = this.state.installation.s3BucketNames ?? {};
      for (const [name, owner] of Object.entries(currentRegistry)) if (this.state.accounts[owner.accountId]?.regions[owner.region]?.s3Buckets[name]) registered[name] = owner;
      for (const accountId of Object.keys(this.state.accounts).sort()) for (const region of Object.keys(this.state.accounts[accountId].regions).sort()) for (const name of Object.keys(this.state.accounts[accountId].regions[region].s3Buckets).sort()) registered[name] ??= { accountId, region };
      if (JSON.stringify(registered) !== JSON.stringify(currentRegistry)) { this.state.installation.s3BucketNames = registered; normalized = true; }
      if (!this.state.installation.rds) { this.state.installation.rds = {}; normalized = true; }
      if (result.migrated || normalized) await this.save();
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      this.wasCreated = true;
    }
  }

  ensureAccount(accountId = this.accountId): AccountState {
    return this.state.accounts[accountId] ??= { iam: normalizeIamState(undefined, Date.now(), accountId), cloudwatchDashboards: {}, cloudfront: emptyCloudFrontAccountState(), regions: {} };
  }

  regionState(region = this.defaultRegion, accountId = this.accountId): RegionState {
    const account = this.ensureAccount(accountId);
    return account.regions[region] ??= emptyRegion();
  }

  listRegions(accountId = this.accountId): string[] {
    return Object.keys(this.ensureAccount(accountId).regions).sort();
  }

  async save(): Promise<void> {
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try {
            await rename(temporary, this.file);
            break;
          } catch (error: any) {
            if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 4) throw error;
            await new Promise(resolveDelay => setTimeout(resolveDelay, 10 * (attempt + 1)));
          }
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    await this.saving;
  }

  async flush(): Promise<void> { await this.saving; }
}
