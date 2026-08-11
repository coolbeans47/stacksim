import { App, CfnOutput, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApiKey,
  CfnDataSource,
  CfnGraphQLApi,
  CfnGraphQLSchema,
  CfnResolver,
} from "aws-cdk-lib/aws-appsync";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import {
  AnyPrincipal,
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { join } from "node:path";

const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.STACKSIM_ACCOUNT_ID ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1";
const app = new App();
const stack = new Stack(app, "AppSyncBugTrackerStack", {
  env: { account, region },
  description: "Local AppSync API-key bug triage board for StackSim",
});

const users = new Table(stack, "BugUsers", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY,
});
const tickets = new Table(stack, "BugTickets", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY,
});
tickets.addGlobalSecondaryIndex({
  indexName: "by-status",
  partitionKey: { name: "status", type: AttributeType.STRING },
  sortKey: { name: "updatedAt", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});
tickets.addGlobalSecondaryIndex({
  indexName: "by-assignee",
  partitionKey: { name: "assigneeId", type: AttributeType.STRING },
  sortKey: { name: "updatedAt", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});

for (const resource of [users, tickets]) {
  Tags.of(resource).add("application", "appsync-bug-tracker");
  Tags.of(resource).add("purpose", "local-showcase");
}

const dataRole = new Role(stack, "AppSyncDataRole", {
  assumedBy: new ServicePrincipal("appsync.amazonaws.com"),
  description: "Least-privilege AppSync access to the local bug tracker tables",
});
dataRole.addToPolicy(new PolicyStatement({
  actions: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query",
    "dynamodb:Scan",
  ],
  resources: [
    users.tableArn,
    tickets.tableArn,
    `${tickets.tableArn}/index/by-status`,
    `${tickets.tableArn}/index/by-assignee`,
  ],
}));

const api = new CfnGraphQLApi(stack, "BugTrackerApi", {
  name: "team-bug-triage-board",
  authenticationType: "API_KEY",
  xrayEnabled: false,
  tags: [
    { key: "application", value: "appsync-bug-tracker" },
    { key: "environment", value: "local" },
  ],
});

const schemaDefinition = /* GraphQL */ `
  enum BugStatus { BACKLOG TRIAGE IN_PROGRESS READY RESOLVED }
  enum Severity { CRITICAL HIGH MEDIUM LOW }

  type Bug {
    id: ID!
    title: String!
    description: String!
    status: BugStatus!
    severity: Severity!
    component: String!
    environment: String!
    reporterId: ID!
    assigneeId: ID
    createdAt: AWSDateTime!
    updatedAt: AWSDateTime!
    resolvedAt: AWSDateTime
  }

  type User {
    id: ID!
    name: String!
    team: String!
    avatarColor: String!
  }

  type BugConnection {
    items: [Bug!]!
    nextToken: String
    scannedCount: Int!
  }

  type UserConnection {
    items: [User!]!
    nextToken: String
    scannedCount: Int!
  }

  input BugInput {
    id: ID!
    title: String!
    description: String!
    status: BugStatus!
    severity: Severity!
    component: String!
    environment: String!
    reporterId: ID!
    assigneeId: ID
    createdAt: AWSDateTime!
    updatedAt: AWSDateTime!
    resolvedAt: AWSDateTime
  }

  input UserInput {
    id: ID!
    name: String!
    team: String!
    avatarColor: String!
  }

  type Query {
    getBug(id: ID!): Bug
    listBugs(limit: Int, nextToken: String): BugConnection!
    bugsByStatus(status: BugStatus!, limit: Int, nextToken: String): BugConnection!
    bugsByAssignee(assigneeId: ID!, limit: Int, nextToken: String): BugConnection!
    getUser(id: ID!): User
    listUsers(limit: Int, nextToken: String): UserConnection!
  }

  type Mutation {
    saveBug(input: BugInput!): Bug!
    deleteBug(id: ID!): Bug
    saveUser(input: UserInput!): User!
  }
`;

const schema = new CfnGraphQLSchema(stack, "BugTrackerSchema", {
  apiId: api.attrApiId,
  definition: schemaDefinition,
});

const expires = Math.floor((Date.now() + 364 * 24 * 60 * 60 * 1000) / 1000);
const apiKey = new CfnApiKey(stack, "LocalDevelopmentApiKey", {
  apiId: api.attrApiId,
  description: "Intentionally exposed only to the generated local demo frontend",
  expires,
});

const usersSource = new CfnDataSource(stack, "UsersDataSource", {
  apiId: api.attrApiId,
  name: "BugUsers",
  type: "AMAZON_DYNAMODB",
  serviceRoleArn: dataRole.roleArn,
  dynamoDbConfig: {
    tableName: users.tableName,
    awsRegion: region,
    useCallerCredentials: false,
    versioned: false,
  },
});
const ticketsSource = new CfnDataSource(stack, "TicketsDataSource", {
  apiId: api.attrApiId,
  name: "BugTickets",
  type: "AMAZON_DYNAMODB",
  serviceRoleArn: dataRole.roleArn,
  dynamoDbConfig: {
    tableName: tickets.tableName,
    awsRegion: region,
    useCallerCredentials: false,
    versioned: false,
  },
});

const responseTemplate = "$util.toJson($ctx.result)";
const resolver = (
  id: string,
  typeName: "Query" | "Mutation",
  fieldName: string,
  source: CfnDataSource,
  requestMappingTemplate: string,
) => {
  const result = new CfnResolver(stack, id, {
    apiId: api.attrApiId,
    typeName,
    fieldName,
    dataSourceName: source.name,
    kind: "UNIT",
    requestMappingTemplate,
    responseMappingTemplate: responseTemplate,
  });
  result.addDependency(schema);
  result.addDependency(source);
  return result;
};

resolver("GetBugResolver", "Query", "getBug", ticketsSource, `{
  "version":"2018-05-29",
  "operation":"GetItem",
  "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
  "consistentRead":true
}`);
resolver("ListBugsResolver", "Query", "listBugs", ticketsSource, `{
  "version":"2018-05-29",
  "operation":"Scan",
  "limit":$util.defaultIfNull($ctx.args.limit, 50),
  "nextToken":$util.toJson($ctx.args.nextToken)
}`);
resolver("BugsByStatusResolver", "Query", "bugsByStatus", ticketsSource, `{
  "version":"2018-05-29",
  "operation":"Query",
  "index":"by-status",
  "query":{
    "expression":"#status = :status",
    "expressionNames":{"#status":"status"},
    "expressionValues":{":status":$util.dynamodb.toDynamoDBJson($ctx.args.status)}
  },
  "scanIndexForward":false,
  "limit":$util.defaultIfNull($ctx.args.limit, 50),
  "nextToken":$util.toJson($ctx.args.nextToken)
}`);
resolver("BugsByAssigneeResolver", "Query", "bugsByAssignee", ticketsSource, `{
  "version":"2018-05-29",
  "operation":"Query",
  "index":"by-assignee",
  "query":{
    "expression":"#assignee = :assignee",
    "expressionNames":{"#assignee":"assigneeId"},
    "expressionValues":{":assignee":$util.dynamodb.toDynamoDBJson($ctx.args.assigneeId)}
  },
  "scanIndexForward":false,
  "limit":$util.defaultIfNull($ctx.args.limit, 50),
  "nextToken":$util.toJson($ctx.args.nextToken)
}`);
resolver("GetUserResolver", "Query", "getUser", usersSource, `{
  "version":"2018-05-29",
  "operation":"GetItem",
  "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
  "consistentRead":true
}`);
resolver("ListUsersResolver", "Query", "listUsers", usersSource, `{
  "version":"2018-05-29",
  "operation":"Scan",
  "limit":$util.defaultIfNull($ctx.args.limit, 50),
  "nextToken":$util.toJson($ctx.args.nextToken)
}`);
resolver("SaveBugResolver", "Mutation", "saveBug", ticketsSource, `{
  "version":"2018-05-29",
  "operation":"PutItem",
  "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.input.id)},
  "attributeValues":$util.dynamodb.toMapValuesJson($ctx.args.input)
}`);
resolver("DeleteBugResolver", "Mutation", "deleteBug", ticketsSource, `{
  "version":"2018-05-29",
  "operation":"DeleteItem",
  "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)}
}`);
resolver("SaveUserResolver", "Mutation", "saveUser", usersSource, `{
  "version":"2018-05-29",
  "operation":"PutItem",
  "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.input.id)},
  "attributeValues":$util.dynamodb.toMapValuesJson($ctx.args.input)
}`);

const website = new s3.Bucket(stack, "Website", {
  websiteIndexDocument: "index.html",
  websiteErrorDocument: "index.html",
  blockPublicAccess: new s3.BlockPublicAccess({
    blockPublicAcls: true,
    ignorePublicAcls: true,
    blockPublicPolicy: false,
    restrictPublicBuckets: false,
  }),
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: false,
});
const websiteResource = website.node.defaultChild as s3.CfnBucket;
websiteResource.addDeletionOverride("Properties.PublicAccessBlockConfiguration.BlockPublicPolicy");
websiteResource.addDeletionOverride("Properties.PublicAccessBlockConfiguration.RestrictPublicBuckets");
website.addToResourcePolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  principals: [new AnyPrincipal()],
  actions: ["s3:GetObject"],
  resources: [`${website.bucketArn}/*`],
}));
new s3deploy.BucketDeployment(stack, "WebsiteDeployment", {
  sources: [s3deploy.Source.asset(join(import.meta.dirname, "frontend", "dist"))],
  destinationBucket: website,
  prune: true,
  retainOnDelete: false,
});
Tags.of(website).add("application", "appsync-bug-tracker");

new CfnOutput(stack, "GraphQLEndpoint", { value: api.attrGraphQlUrl });
new CfnOutput(stack, "ApiId", { value: api.attrApiId });
new CfnOutput(stack, "ApiKey", { value: apiKey.attrApiKey });
new CfnOutput(stack, "WebsiteUrl", { value: website.bucketWebsiteUrl });
new CfnOutput(stack, "WebsiteBucketName", { value: website.bucketName });
new CfnOutput(stack, "UsersTableName", { value: users.tableName });
new CfnOutput(stack, "TicketsTableName", { value: tickets.tableName });
new CfnOutput(stack, "DataRoleArn", { value: dataRole.roleArn });

app.synth();
