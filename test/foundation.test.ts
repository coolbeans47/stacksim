import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTableCommand, DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { PaginationTokens } from "../src/core/pagination.js";
import { Scheduler } from "../src/core/scheduler.js";
import { ServiceRegistry } from "../src/core/service-registry.js";
import { SegmentedStore } from "../src/persistence/segmented-store.js";
import { awsQueryErrorXml, awsQueryXml, parseAwsQuery } from "../src/protocols/query-xml.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";
import { defaultApiModels } from "../src/apigateway-schema.js";

test("v1 state migrates atomically into account and region namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-"));
  try {
    const v1 = {
      tables: { Example: { name: "Example", items: { "S:key": { id: { S: "key" } } } } },
      functions: { handler: { functionName: "handler", environment: { TABLE: "Example" } } },
      apis: { abc123: { id: "abc123", name: "example" } },
    };
    await writeFile(join(root, "state.json"), JSON.stringify(v1));
    const store = new StateStore(root, "111122223333", "ap-southeast-2");
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    const migratedTable = store.regionState("ap-southeast-2").tables.Example;
    assert.deepEqual(migratedTable.items, v1.tables.Example.items);
    assert.deepEqual(migratedTable.localSecondaryIndexes, []);
    assert.deepEqual(migratedTable.globalSecondaryIndexes, []);
    assert.deepEqual(migratedTable.provisionedThroughput, { ReadCapacityUnits: 0, WriteCapacityUnits: 0 });
    assert.deepEqual(migratedTable.timeToLive, { status: "DISABLED" });
    assert.deepEqual({ tags: migratedTable.tags, tableClass: migratedTable.tableClass, deletionProtectionEnabled: migratedTable.deletionProtectionEnabled, sse: migratedTable.sse }, { tags: {}, tableClass: "STANDARD", deletionProtectionEnabled: false, sse: { sseType: "AES256", status: "ENABLED" } });
    assert.deepEqual(store.regionState("ap-southeast-2").functions, { handler: {
      ...v1.functions.handler,
      eventInvokeConfigs: {},
      provisionedConcurrencyConfigs: {},
      functionUrlConfigs: {},
      functionScalingConfigs: {},
      layers: [],
      packageType: "Zip",
      architectures: ["x86_64"],
      ephemeralStorageSize: 512,
      loggingConfig: { logFormat: "Text", logGroup: "/aws/lambda/handler" },
      tracingMode: "PassThrough",
      fileSystemConfigs: [],
      vpcConfig: { subnetIds: [], securityGroupIds: [], ipv6AllowedForDualStack: false },
      runtimeManagementConfig: { updateRuntimeOn: "Auto" },
      recursiveLoop: "Terminate",
    } });
    assert.deepEqual(store.regionState("ap-southeast-2").lambdaLayers, {});
    assert.deepEqual(store.regionState("ap-southeast-2").lambdaCapacityProviders, {});
    assert.deepEqual(store.regionState("ap-southeast-2").lambdaDurableExecutions, {});
    assert.deepEqual(store.regionState("ap-southeast-2").lambdaAsyncInvocations, {});
    assert.deepEqual(store.regionState("ap-southeast-2").lambdaEventSourceMappings, {});
    assert.deepEqual(store.regionState("ap-southeast-2").s3Buckets, {});
    assert.equal(Buffer.from(store.state.installation.s3EncryptionKey, "base64").length, 32);
    assert.deepEqual(store.state.installation.s3BucketNames, {});
    assert.deepEqual(store.regionState("ap-southeast-2").sqsQueues, {});
    assert.deepEqual(store.regionState("ap-southeast-2").sqsQueueDeletionTimes, {});
    assert.equal(Buffer.from(store.state.installation.sqsEncryptionKey, "base64").length, 32);
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayAccount, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayApiKeys, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayUsagePlans, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayResponseCaches, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayDomainNames, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayDomainNameAccessAssociations, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayVpcLinks, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayClientCertificates, {});
    assert.deepEqual(store.regionState("ap-southeast-2").httpApis, {});
    assert.deepEqual(store.regionState("ap-southeast-2").webSocketApis, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apiGatewayV2DomainNames, {});
    assert.deepEqual(store.regionState("ap-southeast-2").logQueryDefinitions, {});
    assert.deepEqual(store.regionState("ap-southeast-2").logDestinations, {});
    assert.deepEqual(store.regionState("ap-southeast-2").logResourcePolicies, {});
    assert.deepEqual(store.regionState("ap-southeast-2").logExportTasks, {});
    assert.deepEqual(store.ensureAccount().cloudwatchDashboards, {});
    assert.deepEqual(store.regionState("ap-southeast-2").apis, { abc123: { ...v1.apis.abc123, binaryMediaTypes: [], gatewayResponses: {}, models: defaultApiModels(), requestValidators: {}, documentationParts: {}, documentationVersions: {}, apiKeySource: "HEADER" } });
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(persisted.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed migration does not alter the state file", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-fail-"));
  try {
    const original = '{"schemaVersion":999,"important":"leave me alone"}';
    await writeFile(join(root, "state.json"), original);
    await assert.rejects(new StateStore(root).load(), /newer than supported/);
    assert.equal(await readFile(join(root, "state.json"), "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("independent state stores use collision-free atomic save files", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-state-save-"));
  try {
    const first = new StateStore(root);
    const second = new StateStore(root);
    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.all([first.save(), second.save()]);
    }
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(persisted.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal((await readdir(root)).some(name => name.startsWith("state.json.tmp-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v30 migrates to v31 with an empty persistent WebSocket API catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v30-"));
  try {
    const legacy = new StateStore(root).state;
    legacy.schemaVersion = 30;
    delete (legacy.accounts["000000000000"].regions["eu-west-1"] as any).webSocketApis;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").webSocketApis, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v31 migrates through v43 with API Gateway administration catalogs, documentation state, dashboards, log delivery state, and anomaly detectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v31-"));
  try {
    const legacy = new StateStore(root).state;
    legacy.schemaVersion = 31;
    const region = legacy.accounts["000000000000"].regions["eu-west-1"] as any;
    delete region.apiGatewayVpcLinks;
    delete region.apiGatewayClientCertificates;
    region.apis.api = { id: "api", name: "legacy", createdDate: 1, rootResourceId: "root", resources: { root: { id: "root", path: "/", methods: {}, integrations: {} } }, deployments: {}, stages: {} };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root); await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").apiGatewayVpcLinks, {});
    assert.deepEqual(store.regionState("eu-west-1").apiGatewayClientCertificates, {});
    assert.deepEqual(store.regionState("eu-west-1").apis.api.documentationParts, {});
    assert.deepEqual(store.regionState("eu-west-1").apis.api.documentationVersions, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v32 migrates to v33 with an empty persistent Logs Insights saved-query catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v32-"));
  try {
    const legacy = new StateStore(root).state; legacy.schemaVersion = 32; const region = legacy.accounts["000000000000"].regions["eu-west-1"] as any; delete region.logQueryDefinitions;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.regionState("eu-west-1").logQueryDefinitions, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v33 migrates to v34 with an empty account-global CloudWatch dashboard catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v33-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 33; delete legacy.accounts["000000000000"].cloudwatchDashboards;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.ensureAccount().cloudwatchDashboards, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v34 migrates to v35 with empty CloudWatch Logs filter, destination, policy, and export state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v34-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 34; const region = legacy.accounts["000000000000"].regions["eu-west-1"]; region.logs["/legacy"] = { logGroupName: "/legacy", arn: "arn:aws:logs:eu-west-1:000000000000:log-group:/legacy", creationTime: 1, storedBytes: 0, tags: {}, streams: {} }; delete region.logDestinations; delete region.logResourcePolicies; delete region.logExportTasks;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load(); const migrated = store.regionState("eu-west-1");
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(migrated.logs["/legacy"].metricFilters, {}); assert.deepEqual(migrated.logs["/legacy"].subscriptionFilters, {}); assert.deepEqual(migrated.logDestinations, {}); assert.deepEqual(migrated.logResourcePolicies, {}); assert.deepEqual(migrated.logExportTasks, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v35 migrates to v36 with an empty composite-alarm catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v35-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 35;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.compositeAlarms;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.compositeAlarms, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v36 migrates to v37 with an empty anomaly-detector catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v36-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 36;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.anomalyDetectors;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.anomalyDetectors, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v37 migrates through v43 with empty log-alarm and alarm-mute-rule catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v37-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 37;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.logAlarms;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.alarmMuteRules;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.logAlarms, {});
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.alarmMuteRules, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v38 migrates through v43 while preserving the default dataset KMS descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v38-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 38;
    legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.datasetKmsKeyArn = "arn:aws:kms:eu-west-1:000000000000:key/local-descriptor";
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(store.regionState("eu-west-1").cloudwatch.datasetKmsKeyArn, "arn:aws:kms:eu-west-1:000000000000:key/local-descriptor");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v39 migrates through v43 with an empty metric-stream catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v39-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 39;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.metricStreams;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.metricStreams, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v40 migrates to v43 with an empty Contributor Insights rule catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v40-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 40;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].cloudwatch.insightRules;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.insightRules, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v41 migrates to v43 with S3 bucket state, installation registry, and encryption key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v41-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 41; delete legacy.installation.s3EncryptionKey; delete legacy.installation.s3BucketNames; delete legacy.accounts["000000000000"].regions["eu-west-1"].s3Buckets; await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root); await store.load(); assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.regionState("eu-west-1").s3Buckets, {}); assert.equal(Buffer.from(store.state.installation.s3EncryptionKey, "base64").length, 32); assert.deepEqual(store.state.installation.s3BucketNames, {}); assert.deepEqual(store.regionState("eu-west-1").rdsDbInstances, {}); assert.deepEqual(store.state.installation.rds, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v42 migrates to v43 with regional RDS descriptors and an installation lease catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v42-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 42; delete legacy.installation.rds; delete legacy.accounts["000000000000"].regions["eu-west-1"].rdsDbInstances; await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root); await store.load(); assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.state.installation.rds, {}); assert.deepEqual(store.regionState("eu-west-1").rdsDbInstances, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v43 migrates to v44 with regional SQS descriptors, deletion tombstones, and an installation encryption key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v43-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 43;
    delete legacy.installation.sqsEncryptionKey;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].sqsQueues;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].sqsQueueDeletionTimes;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(Buffer.from(store.state.installation.sqsEncryptionKey, "base64").length, 32);
    assert.deepEqual(store.regionState("eu-west-1").sqsQueues, {});
    assert.deepEqual(store.regionState("eu-west-1").sqsQueueDeletionTimes, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v44 migrates to v45 with RDS-02 parameter groups and applied defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v44-"));
  try {
    const legacy = new StateStore(root).state as any; const regional = legacy.accounts["000000000000"].regions["eu-west-1"];
    legacy.schemaVersion = 44; delete regional.rdsDbParameterGroups;
    regional.rdsDbInstances.legacy = { dbInstanceIdentifier: "legacy", dbiResourceId: "db-00000000000000000000000000", dbInstanceArn: "arn:aws:rds:eu-west-1:000000000000:db:legacy", dbInstanceClass: "db.t3.micro", dbInstanceStatus: "stopped", engine: "mysql", engineVersion: "8.0", allocatedStorage: 20, storageType: "gp3", masterUsername: "developer", port: 3306, backupRetentionPeriod: 0, publiclyAccessible: false, multiAZ: false, deletionProtection: false, availabilityZone: "eu-west-1a", instanceCreateTime: 0, tags: {} };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load(); const migrated = store.regionState("eu-west-1").rdsDbInstances.legacy;
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.regionState("eu-west-1").rdsDbParameterGroups, {}); assert.equal(migrated.dbParameterGroupName, "default.mysql8.0"); assert.equal(migrated.parameterApplyStatus, "in-sync"); assert.equal(migrated.appliedParameters.max_connections, "100"); assert.equal(migrated.appliedParameters.collation_server, "utf8mb4_unicode_ci");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v45 migrates to v46 with empty regional EventBridge catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v45-"));
  try {
    const legacy = new StateStore(root).state as any;
    const regional = legacy.accounts["000000000000"].regions["eu-west-1"];
    legacy.schemaVersion = 45;
    delete regional.eventBuses;
    delete regional.eventRules;
    delete regional.eventTargets;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").eventBuses, {});
    assert.deepEqual(store.regionState("eu-west-1").eventRules, {});
    assert.deepEqual(store.regionState("eu-west-1").eventTargets, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v48 migrates existing EventBridge targets to Lambda target descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v48-"));
  try {
    const legacy = new StateStore(root).state as any;
    const regional = legacy.accounts["000000000000"].regions["eu-west-1"];
    legacy.schemaVersion = 48;
    regional.eventTargets["default\0legacy"] = {
      target: { id: "target", arn: "arn:aws:lambda:eu-west-1:000000000000:function:legacy" },
    };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(store.regionState("eu-west-1").eventTargets["default\0legacy"].target.targetType, "lambda");
    assert.deepEqual(store.regionState("eu-west-1").cloudwatch.eventBridgeOutbox, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v49 migrates to v50 with empty regional CloudFormation catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v49-"));
  try {
    const legacy = new StateStore(root).state as any;
    const regional = legacy.accounts["000000000000"].regions["eu-west-1"];
    legacy.schemaVersion = 49;
    delete regional.cloudformation;
    const existingEventBusNames = Object.keys(regional.eventBuses).sort();
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").cloudformation, {
      stacks: {}, stackNames: {}, changeSets: {}, changeSetNames: {}, exports: {}, clientTokens: {}, notificationOutbox: [],
      deploymentGeneration: 0, resourceOwnership: {}, hotswapDrift: {}, hotswapOperations: [],
    });
    assert.deepEqual(Object.keys(store.regionState("eu-west-1").eventBuses).sort(), existingEventBusNames, "the CloudFormation migration must preserve existing service state");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v15 migrates through v43 with API Gateway models, OpenAPI metadata, stage settings, Lambda catalogs, dashboards, log delivery state, anomaly detectors, and the refreshed DynamoDB Streams execution policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v15-"));
  try {
    const legacy = new StateStore(root).state; legacy.schemaVersion = 15; const account = legacy.accounts["000000000000"]; const region = account.regions["eu-west-1"] as any; delete region.lambdaEventSourceMappings; delete region.lambdaCapacityProviders; delete region.lambdaDurableExecutions;
    const policy = account.iam.policies["arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole"]; (policy.versions[policy.defaultVersionId].document.Statement as any[])[0].Action = ["dynamodb:GetItem"];
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.regionState("eu-west-1").lambdaEventSourceMappings, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaLayers, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaCodeSigningConfigs, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaCapacityProviders, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaDurableExecutions, {}); assert.deepEqual((store.ensureAccount().iam.policies[policy.arn].versions.v1.document.Statement as any[])[0].Action.slice(0, 4), ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v16 migrates through v43 with API Gateway models, OpenAPI metadata, stage settings, durable Lambda configuration, dashboards, log delivery state, and anomaly detectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v16-"));
  try {
    const legacy = new StateStore(root).state; legacy.schemaVersion = 16; const region = legacy.accounts["000000000000"].regions["eu-west-1"] as any; delete region.lambdaCapacityProviders; delete region.lambdaDurableExecutions;
    region.functions.worker = { functionName: "worker", functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:worker", runtime: "nodejs22.x", role: "arn:aws:iam::000000000000:role/test", handler: "index.handler", timeout: 3, memorySize: 128, description: "", environment: {}, codeSha256: "", codeSize: 0, codeDir: "", version: 0, lastModified: "2026-07-16T00:00:00.000Z" };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load();
    const worker = store.regionState("eu-west-1").functions.worker; assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.equal(worker.packageType, "Zip"); assert.deepEqual(worker.provisionedConcurrencyConfigs, {}); assert.deepEqual(worker.functionUrlConfigs, {}); assert.deepEqual(worker.functionScalingConfigs, {}); assert.deepEqual(worker.layers, []); assert.deepEqual(worker.architectures, ["x86_64"]); assert.equal(worker.ephemeralStorageSize, 512); assert.deepEqual(worker.loggingConfig, { logFormat: "Text", logGroup: "/aws/lambda/worker" }); assert.equal(worker.tracingMode, "PassThrough"); assert.deepEqual(worker.fileSystemConfigs, []); assert.deepEqual(worker.vpcConfig, { subnetIds: [], securityGroupIds: [], ipv6AllowedForDualStack: false }); assert.deepEqual(worker.runtimeManagementConfig, { updateRuntimeOn: "Auto" }); assert.equal(worker.recursiveLoop, "Terminate"); assert.deepEqual(store.regionState("eu-west-1").lambdaLayers, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaCodeSigningConfigs, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaCapacityProviders, {}); assert.deepEqual(store.regionState("eu-west-1").lambdaDurableExecutions, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v25 migrates through v43 with API Gateway stage settings, API keys, usage plans, response caches, custom domains, dashboards, log delivery state, and anomaly detectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v25-"));
  try {
    const legacy = new StateStore(root).state; legacy.schemaVersion = 25; const region = legacy.accounts["000000000000"].regions["eu-west-1"] as any; delete region.apiGatewayAccount; delete region.apiGatewayApiKeys; delete region.apiGatewayUsagePlans; delete region.apiGatewayResponseCaches; delete region.apiGatewayDomainNames; delete region.apiGatewayDomainNameAccessAssociations; delete region.apiGatewayVpcLinks; delete region.apiGatewayClientCertificates; delete region.httpApis; delete region.webSocketApis; delete region.apiGatewayV2DomainNames; region.apis.api = { id: "api", name: "legacy-stage", createdDate: 1, rootResourceId: "root", resources: { root: { id: "root", path: "/", methods: {}, integrations: {} } }, deployments: { deployment: { id: "deployment", createdDate: 1 } }, stages: { dev: { stageName: "dev", deploymentId: "deployment" } }, authorizers: {}, models: defaultApiModels(), requestValidators: {}, binaryMediaTypes: [], gatewayResponses: {} };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load(); const migratedRegion = store.regionState("eu-west-1"); const stage = migratedRegion.apis.api.stages.dev; assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(migratedRegion.apiGatewayAccount, {}); assert.deepEqual(migratedRegion.apiGatewayApiKeys, {}); assert.deepEqual(migratedRegion.apiGatewayUsagePlans, {}); assert.deepEqual(migratedRegion.apiGatewayResponseCaches, {}); assert.deepEqual(migratedRegion.apiGatewayDomainNames, {}); assert.deepEqual(migratedRegion.apiGatewayDomainNameAccessAssociations, {}); assert.deepEqual(migratedRegion.apiGatewayVpcLinks, {}); assert.deepEqual(migratedRegion.apiGatewayClientCertificates, {}); assert.deepEqual(migratedRegion.httpApis, {}); assert.deepEqual(migratedRegion.webSocketApis, {}); assert.deepEqual(migratedRegion.apiGatewayV2DomainNames, {}); assert.equal(migratedRegion.apis.api.apiKeySource, "HEADER"); assert.deepEqual(migratedRegion.apis.api.documentationParts, {}); assert.deepEqual(migratedRegion.apis.api.documentationVersions, {}); assert.equal(migratedRegion.apis.api.deployments.deployment.snapshot?.apiKeySource, "HEADER"); assert.deepEqual(stage.variables, {}); assert.deepEqual(stage.methodSettings, {}); assert.deepEqual(stage.tags, {}); assert.equal(stage.tracingEnabled, false); assert.equal(stage.cacheClusterEnabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v76 adds the SFN-03 Activity catalog without changing state machines", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v76-sfn03-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 76; const stepFunctions = legacy.accounts["000000000000"].regions["eu-west-1"].stepFunctions; delete stepFunctions.activities; delete stepFunctions.activityNames; stepFunctions.stateMachines.existing = { name: "existing" };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load(); assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.regionState("eu-west-1").stepFunctions.activities, {}); assert.deepEqual(store.regionState("eu-west-1").stepFunctions.activityNames, {}); assert.equal((store.regionState("eu-west-1").stepFunctions.stateMachines as any).existing.name, "existing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v77 adds the private EventBridge archive encryption key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v77-evb04-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 77; delete legacy.installation.eventBridgeArchiveEncryptionKey;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load(); assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.equal(Buffer.from(store.state.installation.eventBridgeArchiveEncryptionKey, "base64").length, 32);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v79 adds the RDS-03 regional manual snapshot catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v79-rds03-"));
  try {
    const legacy = new StateStore(root).state as any;
    legacy.schemaVersion = 79;
    delete legacy.accounts["000000000000"].regions["eu-west-1"].rdsDbSnapshots;
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState("eu-west-1").rdsDbSnapshots, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v85 adds the SFN-03 owning-DynamoDB attempt catalog without rewriting service data", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-migration-v84-sfn03-attempts-"));
  try {
    const legacy = new StateStore(root).state as any; legacy.schemaVersion = 84; const region = legacy.accounts["000000000000"].regions["eu-west-1"]; delete region.dynamodbIntegrationAttempts; region.tables.Existing = { name: "Existing" };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy)); const store = new StateStore(root); await store.load(); assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(store.regionState("eu-west-1").dynamodbIntegrationAttempts, {}); assert.equal((store.regionState("eu-west-1").tables as any).Existing.name, "Existing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pagination tokens are opaque, operation-bound, and tamper evident", () => {
  const tokens = new PaginationTokens("local-secret");
  const token = tokens.encode("ListThings", { after: "b", limit: 10 });
  assert.deepEqual(tokens.decode("ListThings", token), { after: "b", limit: 10 });
  assert.throws(() => tokens.decode("OtherOperation", token), /Invalid pagination token/);
  assert.throws(() => tokens.decode("ListThings", `${token.slice(0, -1)}x`), /Invalid pagination token/);
  const [payload, signature] = token.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(signature.at(-1)!); const alias = alphabet[finalIndex + 1];
  assert.equal(finalIndex % 4, 0); assert.ok(alias);
  assert.throws(() => tokens.decode("ListThings", `${payload}.${signature.slice(0, -1)}${alias}`), /Invalid pagination token/);
});

test("scheduler uses an injectable clock and cancels every pending job on shutdown", () => {
  const clock = new TestClock(1_000);
  const scheduler = new Scheduler(clock);
  const calls: number[] = [];
  scheduler.schedule(() => { calls.push(clock.now()); }, 50);
  scheduler.schedule(() => { calls.push(clock.now()); }, 100);
  clock.advance(50);
  assert.deepEqual(calls, [1_050]);
  scheduler.stop();
  clock.advance(1_000);
  assert.deepEqual(calls, [1_050]);
  assert.equal(scheduler.size, 0);
  assert.throws(() => scheduler.schedule(() => undefined, 1), /stopped/);
});

test("segmented JSONL storage appends, rolls over, restarts, and compacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-segments-"));
  try {
    const store = new SegmentedStore<{ id: number; text: string }>(root, "logs/test", 20);
    await store.append({ id: 1, text: "first" });
    await store.append({ id: 2, text: "second" });
    assert.deepEqual(await new SegmentedStore(root, "logs/test").readAll(), [{ id: 1, text: "first" }, { id: 2, text: "second" }]);
    await store.compact([{ id: 2, text: "second" }]);
    assert.deepEqual(await store.readAll(), [{ id: 2, text: "second" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AWS Query protocol parses lists, maps, booleans, dates and emits XML envelopes", () => {
  const input = parseAwsQuery("Action=Example&Tags.member.1.Key=team&Tags.member.1.Value=dev&Options.entry.1.key=enabled&Options.entry.1.value=true&At=2026-07-14T12%3A00%3A00Z");
  assert.deepEqual(input.Tags, [{ Key: "team", Value: "dev" }]);
  assert.deepEqual(input.Options, [{ key: "enabled", value: true }]);
  assert.ok(input.At instanceof Date);
  const output = awsQueryXml("ListRolesResponse", { ListRolesResult: { Roles: [{ RoleName: "a&b" }] }, ResponseMetadata: { RequestId: "req-1" } }, "https://iam.amazonaws.com/doc/2010-05-08/");
  assert.match(output, /<Roles><member><RoleName>a&amp;b<\/RoleName><\/member><\/Roles>/);
  assert.match(awsQueryErrorXml("NoSuchEntity", "missing <role>", "req-2"), /<Message>missing &lt;role&gt;<\/Message>/);
});

test("service registry rejects duplicates and dispatches with request context", async () => {
  const registry = new ServiceRegistry();
  registry.register("sample", "Echo", (request, context) => ({ request, region: context.region }));
  assert.throws(() => registry.register("sample", "Echo", () => undefined), /already registered/);
  const result = await registry.dispatch("sample", "Echo", { hello: "world" }, { requestId: "r", service: "sample", operation: "Echo", region: "eu-west-1", accountId: "000000000000", requestTime: new Date(0) });
  assert.deepEqual(result, { request: { hello: "world" }, region: "eu-west-1" });
});

test("same-named resources are isolated by SDK signing region", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-regions-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"});
  await simulator.start();
  const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
  const west = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
  const east = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "us-east-1", credentials });
  try {
    const definition = { TableName: "SharedName", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" as const }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" as const }], BillingMode: "PAY_PER_REQUEST" as const };
    await west.send(new CreateTableCommand(definition));
    await east.send(new CreateTableCommand(definition));
    assert.deepEqual((await west.send(new ListTablesCommand({}))).TableNames, ["SharedName"]);
    assert.deepEqual((await east.send(new ListTablesCommand({}))).TableNames, ["SharedName"]);
    assert.notEqual(simulator.store.regionState("eu-west-1").tables.SharedName.arn, simulator.store.regionState("us-east-1").tables.SharedName.arn);
  } finally {
    west.destroy(); east.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true });
  }
});
