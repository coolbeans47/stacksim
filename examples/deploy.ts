import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { APIGatewayClient, CreateDeploymentCommand, CreateResourceCommand, CreateRestApiCommand, GetResourcesCommand, GetRestApisCommand, GetStagesCommand, PutIntegrationCommand, PutMethodCommand } from "@aws-sdk/client-api-gateway";
import { AppSyncClient, CreateApiKeyCommand, CreateDataSourceCommand, CreateGraphqlApiCommand, CreateResolverCommand, GetSchemaCreationStatusCommand, ListApiKeysCommand, ListDataSourcesCommand, ListGraphqlApisCommand, ListResolversCommand, StartSchemaCreationCommand, TagResourceCommand, UpdateApiKeyCommand, UpdateDataSourceCommand, UpdateResolverCommand } from "@aws-sdk/client-appsync";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand, PutRetentionPolicyCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient, ListPoliciesCommand, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateDBInstanceCommand, DescribeDBInstancesCommand, RDSClient, StartDBInstanceCommand, type DBInstance } from "@aws-sdk/client-rds";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const endpoint = process.env.STACKSIM_ENDPOINT ?? "http://127.0.0.1:4566";
const region = process.env.AWS_REGION ?? "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const common = { endpoint, region, credentials };
const dynamodb = new DynamoDBClient(common);
const lambda = new LambdaClient(common);
const apigateway = new APIGatewayClient(common);
const logs = new CloudWatchLogsClient(common);
const iam = new IAMClient(common);
const appsync = new AppSyncClient(common);
const rds = new RDSClient({ ...common, maxAttempts: 1 });

const accountId = "000000000000";
const learningNotesTable = "LearningNotes";
const learningNotesApiName = "learning-notes-api";
const learningNotesDataRoleName = "appsync-learning-notes";
const learningNotesDataSourceName = "LearningNotes";
const learningNotesApiKeyDescription = "Seeded API key for npm run seed";
const rdsIdentifier = "learning-db";
const rdsDatabase = "learning_app";
const rdsUsername = "learning_admin";
const rdsPassword = process.env.STACKSIM_RDS_PASSWORD ?? "LocalLearningSecret123";
const rdsPort = Number(process.env.STACKSIM_RDS_PORT ?? "3307");

const bugUsers = [
  { id: "USR-001", displayName: "Maya Chen", email: "maya.chen@example.test", team: "Platform", role: "Backend Engineer", active: true, createdAt: "2026-01-12 09:00:00" },
  { id: "USR-002", displayName: "Theo Martin", email: "theo.martin@example.test", team: "Experience", role: "Frontend Engineer", active: true, createdAt: "2026-02-03 09:00:00" },
  { id: "USR-003", displayName: "Priya Shah", email: "priya.shah@example.test", team: "Reliability", role: "Site Reliability Engineer", active: true, createdAt: "2026-01-20 09:00:00" },
  { id: "USR-004", displayName: "Lucas Garcia", email: "lucas.garcia@example.test", team: "Mobile", role: "Mobile Engineer", active: true, createdAt: "2026-03-10 09:00:00" },
  { id: "USR-005", displayName: "Amina Yusuf", email: "amina.yusuf@example.test", team: "Quality", role: "QA Engineer", active: true, createdAt: "2026-02-17 09:00:00" },
  { id: "USR-006", displayName: "Noah Williams", email: "noah.williams@example.test", team: "Product", role: "Product Manager", active: true, createdAt: "2026-01-08 09:00:00" },
];

const bugTickets = [
  { id: "BUG-101", title: "Sessions expire while users are actively editing", description: "The refresh timer does not extend the session after autosave activity.", status: "IN_PROGRESS", severity: "HIGH", component: "authentication", environment: "production", reporterId: "USR-005", assigneeId: "USR-001", createdAt: "2026-07-14 08:45:00", updatedAt: "2026-07-28 15:20:00", resolvedAt: null },
  { id: "BUG-102", title: "Dashboard cards overflow on Safari", description: "Long project names push action buttons beyond the card boundary.", status: "OPEN", severity: "MEDIUM", component: "dashboard", environment: "production", reporterId: "USR-006", assigneeId: "USR-002", createdAt: "2026-07-18 11:10:00", updatedAt: "2026-07-27 09:30:00", resolvedAt: null },
  { id: "BUG-103", title: "Webhook retries create duplicate deliveries", description: "A timeout after downstream acceptance causes the same event to be delivered twice.", status: "TRIAGE", severity: "CRITICAL", component: "webhooks", environment: "production", reporterId: "USR-003", assigneeId: "USR-003", createdAt: "2026-07-25 03:18:00", updatedAt: "2026-07-29 07:50:00", resolvedAt: null },
  { id: "BUG-104", title: "Offline sync discards the latest mobile draft", description: "The conflict resolver prefers the older server copy after reconnecting.", status: "IN_PROGRESS", severity: "HIGH", component: "mobile-sync", environment: "staging", reporterId: "USR-005", assigneeId: "USR-004", createdAt: "2026-07-20 14:05:00", updatedAt: "2026-07-28 12:40:00", resolvedAt: null },
  { id: "BUG-105", title: "CSV export corrupts non-ASCII customer names", description: "Exports are missing a UTF-8 byte order marker expected by spreadsheet clients.", status: "READY", severity: "MEDIUM", component: "reporting", environment: "production", reporterId: "USR-006", assigneeId: "USR-001", createdAt: "2026-07-21 10:30:00", updatedAt: "2026-07-26 16:00:00", resolvedAt: null },
  { id: "BUG-106", title: "Notification preferences are ignored for comments", description: "Users who disabled comment email still receive one message per comment.", status: "OPEN", severity: "LOW", component: "notifications", environment: "production", reporterId: "USR-006", assigneeId: "USR-002", createdAt: "2026-07-22 13:25:00", updatedAt: "2026-07-22 13:25:00", resolvedAt: null },
  { id: "BUG-107", title: "Search latency spikes for large workspaces", description: "The p95 response time exceeds four seconds once a workspace has fifty thousand records.", status: "INVESTIGATING", severity: "HIGH", component: "search", environment: "production", reporterId: "USR-003", assigneeId: "USR-003", createdAt: "2026-07-23 06:55:00", updatedAt: "2026-07-29 08:15:00", resolvedAt: null },
  { id: "BUG-108", title: "Password reset redirects to a missing route", description: "The email link uses the retired reset-password route.", status: "RESOLVED", severity: "HIGH", component: "authentication", environment: "production", reporterId: "USR-005", assigneeId: "USR-001", createdAt: "2026-07-10 09:40:00", updatedAt: "2026-07-16 17:10:00", resolvedAt: "2026-07-16 17:10:00" },
  { id: "BUG-109", title: "Chart tooltips cannot be opened by keyboard", description: "Keyboard focus does not expose the same values as pointer hover.", status: "OPEN", severity: "MEDIUM", component: "analytics", environment: "production", reporterId: "USR-005", assigneeId: "USR-002", createdAt: "2026-07-24 15:00:00", updatedAt: "2026-07-28 10:05:00", resolvedAt: null },
  { id: "BUG-110", title: "Checkout regression test fails intermittently", description: "The test races inventory confirmation and payment authorization callbacks.", status: "TRIAGE", severity: "CRITICAL", component: "checkout", environment: "test", reporterId: "USR-005", assigneeId: "USR-005", createdAt: "2026-07-26 04:20:00", updatedAt: "2026-07-29 06:45:00", resolvedAt: null },
  { id: "BUG-111", title: "Orphaned attachments are never reclaimed", description: "Deleting a draft leaves its uploaded attachments in object storage.", status: "BACKLOG", severity: "LOW", component: "attachments", environment: "production", reporterId: "USR-001", assigneeId: null, createdAt: "2026-07-19 12:15:00", updatedAt: "2026-07-19 12:15:00", resolvedAt: null },
  { id: "BUG-112", title: "Due dates shift by one day across time zones", description: "Date-only values are interpreted as UTC before being rendered locally.", status: "RESOLVED", severity: "MEDIUM", component: "scheduling", environment: "production", reporterId: "USR-006", assigneeId: "USR-004", createdAt: "2026-07-08 07:35:00", updatedAt: "2026-07-15 14:25:00", resolvedAt: "2026-07-15 14:25:00" },
];

async function ignore(errorName: string, operation: () => Promise<unknown>): Promise<boolean> {
  try { await operation(); return true; } catch (error: any) { if (error.name !== errorName) throw error; return false; }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForLearningNotesTable(timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const table = (await dynamodb.send(new DescribeTableCommand({ TableName: learningNotesTable }))).Table;
    if (table?.TableStatus === "ACTIVE") return;
    await sleep(50);
  }
  throw new Error(`DynamoDB table ${learningNotesTable} did not become ACTIVE within ${timeoutMs}ms`);
}

function validateRdsConfiguration(): void {
  if (!Number.isInteger(rdsPort) || rdsPort < 1150 || rdsPort > 65_535) throw new Error("STACKSIM_RDS_PORT must be an integer from 1150 through 65535");
  if (rdsPassword.length < 8 || rdsPassword.length > 41 || /[^\x20-\x7e]/.test(rdsPassword) || /[\/@\"]/.test(rdsPassword)) throw new Error("STACKSIM_RDS_PASSWORD must be 8-41 printable ASCII characters and cannot contain slash, at-sign, or double quote");
}

async function waitForRdsInstance(timeoutMs = 45_000): Promise<DBInstance> {
  const deadline = Date.now() + timeoutMs;
  let startRequested = false;
  while (Date.now() < deadline) {
    const instance = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: rdsIdentifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === "available" && instance.Endpoint?.Address && instance.Endpoint.Port) return instance;
    if (instance?.DBInstanceStatus === "failed") throw new Error(instance.StatusInfos?.[0]?.Message ?? `RDS instance ${rdsIdentifier} failed to start`);
    if (instance?.DBInstanceStatus === "deleting") throw new Error(`RDS instance ${rdsIdentifier} is being deleted; wait for deletion to finish before rerunning npm run seed`);
    if (instance?.DBInstanceStatus === "stopped" && !startRequested) {
      await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: rdsIdentifier }));
      startRequested = true;
    }
    await sleep(200);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000} seconds waiting for RDS instance ${rdsIdentifier} to become available`);
}

async function ensureRdsInstance(): Promise<DBInstance> {
  const instances = (await rds.send(new DescribeDBInstancesCommand({}))).DBInstances ?? [];
  const existing = instances.find(instance => instance.DBInstanceIdentifier === rdsIdentifier);
  if (instances.length && !existing) {
    const owner = instances.map(instance => instance.DBInstanceIdentifier).join(", ");
    throw new Error(`stacksim permits one installation-wide RDS instance, currently ${owner}; npm run seed will preserve it and will not replace it with ${rdsIdentifier}`);
  }
  if (existing) {
    if (existing.Engine !== "mysql" || existing.DBName !== rdsDatabase || existing.MasterUsername !== rdsUsername) {
      throw new Error(`Existing RDS instance ${rdsIdentifier} does not match mysql/${rdsDatabase}/${rdsUsername}; npm run seed will preserve it and will not change its identity`);
    }
    if (existing.Endpoint?.Port !== rdsPort) {
      throw new Error(`Existing RDS instance ${rdsIdentifier} uses port ${existing.Endpoint?.Port}; set STACKSIM_RDS_PORT=${existing.Endpoint?.Port} to preserve and seed it`);
    }
    return waitForRdsInstance();
  }

  try {
    await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: rdsIdentifier,
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      EngineVersion: "8.0",
      AllocatedStorage: 20,
      StorageType: "gp3",
      DBName: rdsDatabase,
      MasterUsername: rdsUsername,
      MasterUserPassword: rdsPassword,
      Port: rdsPort,
      BackupRetentionPeriod: 0,
      PubliclyAccessible: false,
      Tags: [{ Key: "stacksim:seed", Value: "true" }],
    }));
  } catch (error: any) {
    if (error?.name === "InstanceQuotaExceeded" || error?.name === "InstanceQuotaExceededFault") {
      throw new Error(`stacksim permits one installation-wide RDS instance and it is owned in another Region; npm run seed will preserve it and cannot create ${rdsIdentifier} in ${region}`, { cause: error });
    }
    throw error;
  }
  return waitForRdsInstance();
}

async function connectToRds(instance: DBInstance): Promise<Connection> {
  try {
    return await mysql.createConnection({
      host: instance.Endpoint!.Address!,
      port: instance.Endpoint!.Port!,
      user: rdsUsername,
      password: rdsPassword,
      database: rdsDatabase,
      connectTimeout: 5_000,
    });
  } catch (error) {
    throw new Error(`Could not connect to ${rdsIdentifier} at ${instance.Endpoint!.Address}:${instance.Endpoint!.Port} as ${rdsUsername}. If this instance was created with another password, set STACKSIM_RDS_PASSWORD to that original value.`, { cause: error });
  }
}

async function seedRelationalData(): Promise<{ instance: DBInstance; userCount: number; ticketCount: number; assignedTicketCount: number; unresolvedTicketCount: number }> {
  const instance = await ensureRdsInstance();
  const connection = await connectToRds(instance);
  try {
    await connection.execute("CREATE TABLE IF NOT EXISTS bug_users (user_id VARCHAR(32) PRIMARY KEY, display_name VARCHAR(128) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE, team VARCHAR(64) NOT NULL, user_role VARCHAR(64) NOT NULL, active BOOLEAN NOT NULL, created_at DATETIME NOT NULL)");
    await connection.execute("CREATE TABLE IF NOT EXISTS bug_tickets (ticket_id VARCHAR(32) PRIMARY KEY, title VARCHAR(255) NOT NULL, description TEXT NOT NULL, ticket_status VARCHAR(24) NOT NULL, severity VARCHAR(16) NOT NULL, component VARCHAR(64) NOT NULL, environment VARCHAR(32) NOT NULL, reporter_id VARCHAR(32) NOT NULL, assignee_id VARCHAR(32), created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, resolved_at DATETIME, CONSTRAINT fk_bug_reporter FOREIGN KEY (reporter_id) REFERENCES bug_users(user_id), CONSTRAINT fk_bug_assignee FOREIGN KEY (assignee_id) REFERENCES bug_users(user_id))");
    await connection.beginTransaction();
    try {
      for (const user of bugUsers) {
        await connection.query(
          "INSERT INTO bug_users (user_id, display_name, email, team, user_role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), email = VALUES(email), team = VALUES(team), user_role = VALUES(user_role), active = VALUES(active), created_at = VALUES(created_at)",
          [user.id, user.displayName, user.email, user.team, user.role, user.active, user.createdAt],
        );
      }
      for (const ticket of bugTickets) {
        await connection.query(
          "INSERT INTO bug_tickets (ticket_id, title, description, ticket_status, severity, component, environment, reporter_id, assignee_id, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description), ticket_status = VALUES(ticket_status), severity = VALUES(severity), component = VALUES(component), environment = VALUES(environment), reporter_id = VALUES(reporter_id), assignee_id = VALUES(assignee_id), created_at = VALUES(created_at), updated_at = VALUES(updated_at), resolved_at = VALUES(resolved_at)",
          [ticket.id, ticket.title, ticket.description, ticket.status, ticket.severity, ticket.component, ticket.environment, ticket.reporterId, ticket.assigneeId, ticket.createdAt, ticket.updatedAt, ticket.resolvedAt],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
    const [userRows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS row_count FROM bug_users");
    const [ticketRows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS row_count FROM bug_tickets");
    const [assignedRows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS row_count FROM bug_tickets WHERE assignee_id IS NOT NULL");
    const [unresolvedRows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS row_count FROM bug_tickets WHERE resolved_at IS NULL");
    return {
      instance,
      userCount: Number(userRows[0].row_count),
      ticketCount: Number(ticketRows[0].row_count),
      assignedTicketCount: Number(assignedRows[0].row_count),
      unresolvedTicketCount: Number(unresolvedRows[0].row_count),
    };
  } finally {
    await connection.end().catch(() => undefined);
  }
}

async function seedAppSyncApi(): Promise<{ apiId: string; graphqlUrl: string; apiKey: string }> {
  const dataRoleArn = `arn:aws:iam::${accountId}:role/${learningNotesDataRoleName}`;
  const dataRoleTrust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "appsync.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  });
  const createdRole = await ignore("EntityAlreadyExistsException", () => iam.send(new CreateRoleCommand({
    RoleName: learningNotesDataRoleName,
    Description: "Lets the seeded AppSync API read and write LearningNotes",
    AssumeRolePolicyDocument: dataRoleTrust,
    Tags: [{ Key: "stacksim:seed", Value: "true" }],
  })));
  if (!createdRole) {
    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: learningNotesDataRoleName,
      PolicyDocument: dataRoleTrust,
    }));
  }
  await iam.send(new PutRolePolicyCommand({
    RoleName: learningNotesDataRoleName,
    PolicyName: "LearningNotesDataAccess",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Scan"],
        Resource: `arn:aws:dynamodb:${region}:${accountId}:table/${learningNotesTable}`,
      }],
    }),
  }));

  let api = (await appsync.send(new ListGraphqlApisCommand({ maxResults: 25 }))).graphqlApis
    ?.find(candidate => candidate.name === learningNotesApiName);
  if (!api) {
    api = (await appsync.send(new CreateGraphqlApiCommand({
      name: learningNotesApiName,
      authenticationType: "API_KEY",
      tags: { "stacksim:seed": "true", application: "learning-notes" },
    }))).graphqlApi;
  } else {
    await appsync.send(new TagResourceCommand({
      resourceArn: api.arn!,
      tags: { "stacksim:seed": "true", application: "learning-notes" },
    }));
  }
  if (!api?.apiId || !api.uris?.GRAPHQL) throw new Error("The seeded AppSync API was not created");

  const schema = `
    input NoteInput {
      id: ID!
      title: String!
      body: String!
      category: String!
      completed: Boolean!
      priority: Int!
    }

    type Note {
      id: ID!
      title: String!
      body: String!
      category: String!
      completed: Boolean!
      priority: Int!
    }

    type NoteConnection {
      items: [Note!]!
      nextToken: String
      scannedCount: Int!
    }

    type Query {
      getNote(id: ID!): Note
      listNotes(limit: Int, nextToken: String): NoteConnection!
      notesByCategory(category: String!, limit: Int, nextToken: String): NoteConnection!
    }

    type Mutation {
      saveNote(input: NoteInput!): Note!
      deleteNote(id: ID!): Note
    }
  `;
  await appsync.send(new StartSchemaCreationCommand({
    apiId: api.apiId,
    definition: Buffer.from(schema),
  }));
  const schemaStatus = await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }));
  if (schemaStatus.status !== "SUCCESS") {
    throw new Error(`Could not activate the seeded AppSync schema: ${schemaStatus.details ?? schemaStatus.status}`);
  }

  const dataSourceInput = {
    apiId: api.apiId,
    name: learningNotesDataSourceName,
    description: "Seeded LearningNotes DynamoDB table",
    type: "AMAZON_DYNAMODB" as const,
    serviceRoleArn: dataRoleArn,
    dynamodbConfig: {
      tableName: learningNotesTable,
      awsRegion: region,
      useCallerCredentials: false,
      versioned: false,
    },
  };
  const dataSources = (await appsync.send(new ListDataSourcesCommand({ apiId: api.apiId, maxResults: 25 }))).dataSources ?? [];
  if (dataSources.some(source => source.name === learningNotesDataSourceName)) {
    await appsync.send(new UpdateDataSourceCommand(dataSourceInput));
  } else {
    await appsync.send(new CreateDataSourceCommand(dataSourceInput));
  }

  const responseMappingTemplate = "$util.toJson($ctx.result)";
  const resolverSpecs = [
    {
      typeName: "Query",
      fieldName: "getNote",
      requestMappingTemplate: `{
        "version":"2018-05-29",
        "operation":"GetItem",
        "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
        "consistentRead":true
      }`,
    },
    {
      typeName: "Query",
      fieldName: "listNotes",
      requestMappingTemplate: `{
        "version":"2018-05-29",
        "operation":"Scan",
        "limit":$util.defaultIfNull($ctx.args.limit, 10),
        "nextToken":$util.toJson($ctx.args.nextToken)
      }`,
    },
    {
      typeName: "Query",
      fieldName: "notesByCategory",
      requestMappingTemplate: `{
        "version":"2018-05-29",
        "operation":"Scan",
        "filter":{
          "expression":"#category = :category",
          "expressionNames":{"#category":"category"},
          "expressionValues":{":category":$util.dynamodb.toDynamoDBJson($ctx.args.category)}
        },
        "limit":$util.defaultIfNull($ctx.args.limit, 10),
        "nextToken":$util.toJson($ctx.args.nextToken)
      }`,
    },
    {
      typeName: "Mutation",
      fieldName: "saveNote",
      requestMappingTemplate: `{
        "version":"2018-05-29",
        "operation":"PutItem",
        "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.input.id)},
        "attributeValues":$util.dynamodb.toMapValuesJson($ctx.args.input)
      }`,
    },
    {
      typeName: "Mutation",
      fieldName: "deleteNote",
      requestMappingTemplate: `{
        "version":"2018-05-29",
        "operation":"DeleteItem",
        "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)}
      }`,
    },
  ] as const;
  const existingResolvers = new Set<string>();
  for (const typeName of ["Query", "Mutation"]) {
    const resolvers = (await appsync.send(new ListResolversCommand({
      apiId: api.apiId,
      typeName,
      maxResults: 25,
    }))).resolvers ?? [];
    for (const resolver of resolvers) existingResolvers.add(`${typeName}.${resolver.fieldName}`);
  }
  for (const spec of resolverSpecs) {
    const input = {
      apiId: api.apiId,
      typeName: spec.typeName,
      fieldName: spec.fieldName,
      dataSourceName: learningNotesDataSourceName,
      kind: "UNIT" as const,
      requestMappingTemplate: spec.requestMappingTemplate,
      responseMappingTemplate,
    };
    if (existingResolvers.has(`${spec.typeName}.${spec.fieldName}`)) {
      await appsync.send(new UpdateResolverCommand(input));
    } else {
      await appsync.send(new CreateResolverCommand(input));
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expires = nowSeconds + 364 * 24 * 60 * 60;
  const keys = (await appsync.send(new ListApiKeysCommand({ apiId: api.apiId, maxResults: 25 }))).apiKeys ?? [];
  let apiKey = keys.find(key => key.description === learningNotesApiKeyDescription && (key.expires ?? 0) > nowSeconds)?.id;
  if (apiKey) {
    apiKey = (await appsync.send(new UpdateApiKeyCommand({
      apiId: api.apiId,
      id: apiKey,
      description: learningNotesApiKeyDescription,
      expires,
    }))).apiKey?.id;
  } else {
    apiKey = (await appsync.send(new CreateApiKeyCommand({
      apiId: api.apiId,
      description: learningNotesApiKeyDescription,
      expires,
    }))).apiKey?.id;
  }
  if (!apiKey) throw new Error("The seeded AppSync API key was not created");

  return { apiId: api.apiId, graphqlUrl: api.uris.GRAPHQL, apiKey };
}

async function deploy() {
  validateRdsConfiguration();
  try {
    await dynamodb.send(new CreateTableCommand({ TableName: learningNotesTable, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
  } catch (error: any) { if (error.name !== "ResourceInUseException") throw error; }
  await waitForLearningNotesTable();
  const notes = [
    { id: "welcome", title: "Welcome", body: "This item was seeded by examples/deploy.ts", category: "getting-started", completed: false, priority: 1 },
    { id: "typescript-sdk", title: "Use AWS SDK v3", body: "Point DynamoDBClient at http://127.0.0.1:4566 and use default administrator credentials.", category: "development", completed: true, priority: 2 },
    { id: "lambda-integration", title: "Call DynamoDB from Lambda", body: "Lambda functions use the same AWS SDK v3 endpoint to read and write this table.", category: "serverless", completed: false, priority: 3 },
    { id: "api-gateway", title: "Test with Postman", body: "Deploy a REST API stage and send requests through the local API Gateway invoke URL.", category: "api", completed: true, priority: 4 },
    { id: "persistence", title: "Restart safely", body: "Tables and items are stored under .stacksim and reload after restart.", category: "storage", completed: true, priority: 5 },
  ];
  for (const note of notes) await dynamodb.send(new PutItemCommand({ TableName: learningNotesTable, Item: { id: { S: note.id }, title: { S: note.title }, body: { S: note.body }, category: { S: note.category }, completed: { BOOL: note.completed }, priority: { N: String(note.priority) } } }));

  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  await ignore("EntityAlreadyExistsException", () => iam.send(new CreateRoleCommand({ RoleName: "local-lambda", Description: "Execution role for the seeded learning Lambda", AssumeRolePolicyDocument: trust, Tags: [{ Key: "stacksim:seed", Value: "true" }] })));
  let learningPolicyArn = (await iam.send(new ListPoliciesCommand({ Scope: "Local" }))).Policies?.find(policy => policy.PolicyName === "LearningNotesAccess")?.Arn;
  if (!learningPolicyArn) {
    const policy = await iam.send(new CreatePolicyCommand({ PolicyName: "LearningNotesAccess", Description: "Read and write access to the seeded LearningNotes table", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"], Resource: `arn:aws:dynamodb:${region}:${accountId}:table/${learningNotesTable}` }] }), Tags: [{ Key: "stacksim:seed", Value: "true" }] })); learningPolicyArn = policy.Policy?.Arn;
  }
  if (learningPolicyArn) await iam.send(new AttachRolePolicyCommand({ RoleName: "local-lambda", PolicyArn: learningPolicyArn }));
  await iam.send(new AttachRolePolicyCommand({ RoleName: "local-lambda", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));

  const zip = await readFile(resolve("examples/lambda/function.zip"));
  let functionArn: string;
  try { functionArn = (await lambda.send(new CreateFunctionCommand({ FunctionName: "notes-api", Runtime: "nodejs22.x", Role: `arn:aws:iam::${accountId}:role/local-lambda`, Handler: "handler.handler", Timeout: 10, Code: { ZipFile: zip }, Environment: { Variables: { TABLE_NAME: learningNotesTable, STACKSIM_ENDPOINT: endpoint } } }))).FunctionArn!; }
  catch (error: any) { if (error.name !== "ResourceConflictException") throw error; functionArn = (await lambda.send(new GetFunctionCommand({ FunctionName: "notes-api" }))).Configuration!.FunctionArn!; }

  let api = (await apigateway.send(new GetRestApisCommand({}))).items?.find(item => item.name === "learning-api");
  if (!api) api = await apigateway.send(new CreateRestApiCommand({ name: "learning-api", description: "Seeded REST API for learning Lambda proxy integrations" }));
  let resources = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!; const root = resources.find(resource => resource.path === "/")!;
  let notesResource = resources.find(resource => resource.path === "/notes"); if (!notesResource) notesResource = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "notes" }));
  resources = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!; let noteResource = resources.find(resource => resource.path === "/notes/{id}"); if (!noteResource) noteResource = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: notesResource.id!, pathPart: "{id}" }));
  const uri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`;
  for (const [resourceId, methods] of [[notesResource.id!, ["GET", "POST"]], [noteResource.id!, ["GET", "PUT"]]] as const) {
    for (const httpMethod of methods) {
      await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId, httpMethod, authorizationType: "NONE" }));
      await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId, httpMethod, type: "AWS_PROXY", integrationHttpMethod: "POST", uri }));
    }
  }
  const stage = (await apigateway.send(new GetStagesCommand({ restApiId: api.id! }))).item?.find(item => item.stageName === "dev");
  if (!stage) await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", description: "Initial local deployment" }));

  const createdLogGroup = await ignore("ResourceAlreadyExistsException", () => logs.send(new CreateLogGroupCommand({ logGroupName: "/stacksim/learning", tags: { environment: "local", seeded: "true" } })));
  await logs.send(new PutRetentionPolicyCommand({ logGroupName: "/stacksim/learning", retentionInDays: 14 }));
  const createdLogStream = await ignore("ResourceAlreadyExistsException", () => logs.send(new CreateLogStreamCommand({ logGroupName: "/stacksim/learning", logStreamName: "seed" })));
  if (createdLogGroup || createdLogStream) await logs.send(new PutLogEventsCommand({ logGroupName: "/stacksim/learning", logStreamName: "seed", logEvents: [{ timestamp: Date.now(), message: JSON.stringify({ level: "INFO", message: "stacksim sample resources seeded", table: "LearningNotes", function: "notes-api", apiId: api.id }) }] }));
  const graphql = await seedAppSyncApi();
  const relational = await seedRelationalData();
  console.log(`Deployed. Try:
  GET  http://127.0.0.1:4567/${api.id}/dev/notes
  GET  http://127.0.0.1:4567/${api.id}/dev/notes/welcome
  POST http://127.0.0.1:4567/${api.id}/dev/notes  body: {"title":"Hello","body":"From Postman"}

AppSync ${learningNotesApiName}: ${graphql.graphqlUrl}
  API key: ${graphql.apiKey}
  Query:   {"query":"{ listNotes { items { id title category completed priority } } }"}
  Console: ${endpoint}/_stacksim/console/#/appsync/apis/${graphql.apiId}/queries

RDS ${rdsIdentifier}: mysql://${rdsUsername}@${relational.instance.Endpoint!.Address}:${relational.instance.Endpoint!.Port}/${rdsDatabase}
  bug_users:                 ${relational.userCount} rows
  bug_tickets:               ${relational.ticketCount} rows
  assigned bug tickets:      ${relational.assignedTicketCount}
  unresolved bug tickets:    ${relational.unresolvedTicketCount}`);
}

deploy()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { rds.destroy(); dynamodb.destroy(); lambda.destroy(); apigateway.destroy(); logs.destroy(); iam.destroy(); appsync.destroy(); });
