import { randomBytes, randomUUID } from "node:crypto";
import type { RegionState, SimState } from "../types.js";
import { createIamState } from "../iam/model.js";
import { emptySesRegionState } from "./v51-to-v52.js";
import { emptyCognitoRegionState } from "./v52-to-v53.js";

export const CURRENT_SCHEMA_VERSION = 88;
export const DEFAULT_ACCOUNT_ID = "000000000000";

export function emptyRegion(): RegionState {
  return { cloudformation: { stacks: {}, stackNames: {}, changeSets: {}, changeSetNames: {}, exports: {}, clientTokens: {} }, parameterStore: { revision: 0, parameters: {}, tombstones: {} }, secretsManager: { revision: 0, secrets: {}, retiredSuffixes: {} }, appsync: { revision: 0, graphqlApis: {} }, stepFunctions: { revision: 0, stateMachines: {}, stateMachineNames: {}, executions: {}, executionNames: {}, activities: {}, activityNames: {} }, xray: { revision: 1 }, ses: emptySesRegionState(), cognito: emptyCognitoRegionState(), sns: { revision: 0, topics: {}, subscriptions: {} }, rdsDbInstances: {}, rdsDbParameterGroups: {}, rdsDbSnapshots: {}, s3Buckets: {}, sqsQueues: {}, sqsQueueDeletionTimes: {}, eventBuses: {}, eventRules: {}, eventTargets: {}, eventScheduleGroups: {}, eventSchedules: {}, eventScheduleOccurrences: {}, tables: {}, dynamodbBackups: {}, dynamodbExports: {}, dynamodbImports: {}, dynamodbStreams: {}, dynamodbResourcePolicies: {}, dynamodbResourcePolicyMutationTimes: {}, dynamodbIntegrationAttempts: {}, functions: {}, lambdaLayers: {}, lambdaCodeSigningConfigs: {}, lambdaCapacityProviders: {}, lambdaDurableExecutions: {}, lambdaAsyncInvocations: {}, lambdaEventSourceMappings: {}, apis: {}, apiGatewayAccount: {}, apiGatewayApiKeys: {}, apiGatewayUsagePlans: {}, apiGatewayResponseCaches: {}, apiGatewayDomainNames: {}, apiGatewayDomainNameAccessAssociations: {}, apiGatewayVpcLinks: {}, apiGatewayClientCertificates: {}, httpApis: {}, webSocketApis: {}, apiGatewayV2DomainNames: {}, logs: {}, logQueryDefinitions: {}, logQueryJobs: {}, logDestinations: {}, logResourcePolicies: {}, logExportTasks: {}, cloudwatch: { alarms: {}, compositeAlarms: {}, logAlarms: {}, alarmMuteRules: {}, anomalyDetectors: {}, metricStreams: {}, insightRules: {}, alarmHistory: [], eventBridgeOutbox: [], snsActionOutbox: [], lambdaActionOutbox: [] } };
}

export function emptyState(accountId = DEFAULT_ACCOUNT_ID, region = "eu-west-1"): SimState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    installation: { id: randomUUID(), paginationSecret: randomBytes(32).toString("base64url"), s3EncryptionKey: randomBytes(32).toString("base64"), sqsEncryptionKey: randomBytes(32).toString("base64"), snsEncryptionKey: randomBytes(32).toString("base64"), eventBridgeArchiveEncryptionKey: randomBytes(32).toString("base64"), sesSigningSecret: randomBytes(32).toString("base64"), s3BucketNames: {}, rds: {}, defaultAdministrators: {} },
    accounts: { [accountId]: { iam: createIamState(Date.now(), accountId), cloudwatchDashboards: {}, cloudfront: { schemaVersion: 1, revision: 0, distributions: {}, distributionCallerReferences: {}, functions: {}, originAccessControls: {}, originAccessControlNames: {}, responseHeadersPolicies: {}, responseHeadersPolicyNames: {}, invalidations: {}, invalidationCallerReferences: {} }, regions: { [region]: emptyRegion() } } },
  };
}

export function migrateV1ToV2(value: any, accountId: string, region: string): SimState {
  const state = emptyState(accountId, region);
  state.accounts[accountId].regions[region] = {
    ...emptyRegion(),
    tables: structuredClone(value.tables ?? {}),
    functions: structuredClone(value.functions ?? {}),
    apis: structuredClone(value.apis ?? {}),
  };
  return state;
}
