export const APPSYNC_ACTION_INVENTORY_SOURCE = {
  sdkPackage: "@aws-sdk/client-appsync",
  sdkVersion: "3.1097.0",
  protocol: "REST-JSON",
  signingName: "appsync",
  url: "https://docs.aws.amazon.com/appsync/latest/APIReference/API_Operations.html",
} as const;

export const APPSYNC_APS_P0_001_ACTIONS = [
  "CreateApiKey",
  "CreateGraphqlApi",
  "GetGraphqlApi",
  "GetIntrospectionSchema",
  "GetSchemaCreationStatus",
  "ListApiKeys",
  "ListGraphqlApis",
  "StartSchemaCreation",
] as const;

export const APPSYNC_APS_P0_002_ACTIONS = [
  "DeleteGraphqlApi", "ListTagsForResource", "TagResource", "UntagResource",
  "UpdateGraphqlApi",
] as const;

export const APPSYNC_APS_P0_004_ACTIONS = [
  "DeleteApiKey", "UpdateApiKey",
] as const;

export const APPSYNC_APS_P0_006_ACTIONS = [
  "CreateDataSource", "CreateResolver", "DeleteDataSource", "DeleteResolver",
  "GetDataSource", "GetResolver", "ListDataSources", "ListResolvers",
  "UpdateDataSource", "UpdateResolver",
] as const;

export const APPSYNC_APS_P0_007_ACTIONS = ["EvaluateMappingTemplate"] as const;

const APS_04 = [
  "CreateFunction", "CreateType", "DeleteFunction", "DeleteType", "EvaluateCode",
  "GetFunction", "GetGraphqlApiEnvironmentVariables", "GetType", "ListFunctions",
  "ListResolversByFunction", "ListTypes", "PutGraphqlApiEnvironmentVariables",
  "UpdateFunction", "UpdateType",
] as const;

export const APPSYNC_AMX_05_ACTIONS = [
  "CreateFunction", "DeleteFunction", "GetFunction", "ListFunctions",
  "ListResolversByFunction", "UpdateFunction",
] as const;

/** Permission-only AppSync GraphQL data-plane action; it is not an SDK command. */
export const APPSYNC_AMX_06_PERMISSION_ACTION = Object.freeze({
  action: "GraphQL",
  iamAction: "appsync:GraphQL",
  phase: "APS-06",
  implemented: true,
  resource: "arn:aws:appsync:${Region}:${Account}:apis/${GraphQLAPIId}/types/${TypeName}/fields/${FieldName}",
});

/** AMX-08 is a data-plane protocol surface and adds no AppSync SDK command. */
export const APPSYNC_AMX_08_REALTIME_SURFACE = Object.freeze({
  phase: "AMX-08 (APS-07 API_KEY/AWS_IAM generated subset)",
  endpoint: "REALTIME",
  subprotocol: "graphql-ws",
  clientMessages: Object.freeze(["connection_init", "start", "stop"]),
  serverMessages: Object.freeze(["connection_ack", "connection_error", "start_ack", "data", "ka", "complete", "error"]),
  authorizationModes: Object.freeze(["API_KEY", "AWS_IAM"]),
  subscriptionFields: Object.freeze(["onCreateTodo", "onUpdateTodo", "onDeleteTodo"]),
  filterOperators: Object.freeze([
    "eq", "ne", "le", "lt", "ge", "gt", "contains", "notContains", "between", "beginsWith", "in", "notIn", "and", "or",
  ]),
  signals: Object.freeze([
    "connection-admit", "connection-close", "registration-admit", "registration-reject", "registration-stop",
    "mutation-complete", "authorization-admit", "filter-admit", "filter-reject",
    "queue-drop", "socket-delivery", "socket-delivery-failure",
  ]),
  persistence: "process-local-no-replay",
  addsSdkAction: false,
  future: Object.freeze(["Cognito", "Lambda", "OIDC", "enhanced filters", "invalidation", "AppSync Events"]),
});

const APS_09 = [
  "AssociateApi", "AssociateMergedGraphqlApi", "AssociateSourceGraphqlApi",
  "CreateApi", "CreateApiCache", "CreateChannelNamespace", "CreateDomainName",
  "DeleteApi", "DeleteApiCache", "DeleteChannelNamespace", "DeleteDomainName",
  "DisassociateApi", "DisassociateMergedGraphqlApi",
  "DisassociateSourceGraphqlApi", "FlushApiCache", "GetApi",
  "GetApiAssociation", "GetApiCache", "GetChannelNamespace",
  "GetDataSourceIntrospection", "GetDomainName", "GetSourceApiAssociation",
  "ListApis", "ListChannelNamespaces", "ListDomainNames",
  "ListSourceApiAssociations", "ListTypesByAssociation",
  "StartDataSourceIntrospection", "StartSchemaMerge", "UpdateApi",
  "UpdateApiCache", "UpdateChannelNamespace", "UpdateDomainName",
  "UpdateSourceApiAssociation",
] as const;

export type AppSyncInventoryPhase =
  | "APS-P0-001"
  | "APS-P0-002"
  | "APS-P0-004"
  | "APS-P0-006"
  | "APS-P0-007"
  | "APS-04"
  | "APS-09";

export interface AppSyncActionInventoryEntry {
  action: string;
  iamAction: string;
  phase: AppSyncInventoryPhase;
  implemented: boolean;
}

function entries(
  phase: AppSyncInventoryPhase,
  actions: readonly string[],
): AppSyncActionInventoryEntry[] {
  return actions.map(action => ({
    action,
    iamAction: `appsync:${action}`,
    phase,
    implemented: phase.startsWith("APS-P0-") || APPSYNC_AMX_05_ACTIONS.includes(action as any),
  }));
}

export const APPSYNC_ACTION_INVENTORY: readonly AppSyncActionInventoryEntry[] = [
  ...entries("APS-P0-001", APPSYNC_APS_P0_001_ACTIONS),
  ...entries("APS-P0-002", APPSYNC_APS_P0_002_ACTIONS),
  ...entries("APS-P0-004", APPSYNC_APS_P0_004_ACTIONS),
  ...entries("APS-P0-006", APPSYNC_APS_P0_006_ACTIONS),
  ...entries("APS-P0-007", APPSYNC_APS_P0_007_ACTIONS),
  ...entries("APS-04", APS_04),
  ...entries("APS-09", APS_09),
].sort((left, right) => left.action.localeCompare(right.action));
