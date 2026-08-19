import assert from "node:assert/strict";
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetAuthorizersCommand,
  GetApiKeyCommand,
  GetBasePathMappingsCommand,
  GetClientCertificatesCommand,
  GetDocumentationPartsCommand,
  GetDocumentationVersionsCommand,
  GetDomainNameCommand,
  GetGatewayResponseCommand,
  GetIntegrationCommand,
  GetMethodCommand,
  GetModelsCommand,
  GetRequestValidatorsCommand,
  GetRestApiCommand,
  GetRestApisCommand,
  GetResourcesCommand,
  GetStageCommand,
  GetTagsCommand,
  GetUsagePlanCommand,
  GetUsagePlanKeysCommand,
  GetVpcLinksCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  GetApiCommand as GetV2ApiCommand,
  GetAuthorizersCommand as GetV2AuthorizersCommand,
  GetIntegrationsCommand as GetV2IntegrationsCommand,
  GetModelsCommand as GetV2ModelsCommand,
  GetRouteResponsesCommand as GetV2RouteResponsesCommand,
  GetRoutesCommand as GetV2RoutesCommand,
  GetStagesCommand as GetV2StagesCommand,
} from "@aws-sdk/client-apigatewayv2";
import { CreateTableCommand, DescribeContinuousBackupsCommand, DescribeContributorInsightsCommand, DescribeKinesisStreamingDestinationCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, GetItemCommand, GetResourcePolicyCommand, ListBackupsCommand, ListExportsCommand, ListGlobalTablesCommand, ListTagsOfResourceCommand, PutItemCommand, QueryCommand, UpdateContinuousBackupsCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBStreamsClient, ListStreamsCommand } from "@aws-sdk/client-dynamodb-streams";
import { CloudWatchClient, DeleteAlarmsCommand, DeleteAnomalyDetectorCommand, DeleteDashboardsCommand, DescribeAlarmContributorsCommand, DescribeAlarmsCommand, DescribeAnomalyDetectorsCommand, DescribeInsightRulesCommand, GetAlarmMuteRuleCommand, GetDashboardCommand, GetDatasetCommand, GetMetricStatisticsCommand, GetMetricStreamCommand, ListMetricStreamsCommand, PutDashboardCommand, PutMetricAlarmCommand, PutMetricDataCommand, SetAlarmStateCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, DeleteLogGroupCommand, DescribeExportTasksCommand, DescribeMetricFiltersCommand, DescribeQueryDefinitionsCommand, DescribeSubscriptionFiltersCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  AddLayerVersionPermissionCommand,
  AddPermissionCommand,
  CreateAliasCommand,
  CreateCodeSigningConfigCommand,
  CreateFunctionCommand,
  GetCapacityProviderCommand,
  GetDurableExecutionCommand,
  GetDurableExecutionHistoryCommand,
  GetFunctionCodeSigningConfigCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  GetFunctionEventInvokeConfigCommand,
  GetFunctionRecursionConfigCommand,
  GetFunctionScalingConfigCommand,
  GetFunctionUrlConfigCommand,
  GetRuntimeManagementConfigCommand,
  ListProvisionedConcurrencyConfigsCommand,
  ListFunctionUrlConfigsCommand,
  InvokeCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  PublishVersionCommand,
  PublishLayerVersionCommand,
  PutFunctionScalingConfigCommand,
} from "@aws-sdk/client-lambda";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fillArnCombobox } from "./arn-combobox.js";
import { StackSim } from "../../src/server.js";
import { waitForTableActive } from "../support/dynamodb.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let previousOciRoot: string | undefined;
const browserVpcTargetArn = "arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/net/browser-private/0123456789abcdef";

async function writeBrowserImage(root: string, imageUri: string): Promise<string> {
  const blobs = join(root, "blobs", "sha256"); await mkdir(blobs, { recursive: true }); const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: {} })); const configDigest = hash(config); await writeFile(join(blobs, configDigest.slice(7)), config);
  const mediaType = "application/vnd.oci.image.manifest.v1+json"; const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length }, layers: [] })); const manifestDigest = hash(manifest); await writeFile(join(blobs, manifestDigest.slice(7)), manifest);
  await writeFile(join(root, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" })); await writeFile(join(root, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType, digest: manifestDigest, size: manifest.length, annotations: { "org.opencontainers.image.ref.name": imageUri } }] })); return manifestDigest;
}

function sdkOptions(target: StackSim) {
  return {
    endpoint: `http://127.0.0.1:${target.port}`,
    region: "eu-west-1",
    credentials: { accessKeyId: "admin", secretAccessKey: "password" },
  };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", message => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const expectedMissingLambdaPolicy = /(?:\/2015-03-31\/functions\/[^/]+\/policy|\/2018-10-31\/layers\/[^/]+\/versions\/\d+\/policy|\/2020-06-30\/functions\/[^/]+\/code-signing-config)$/.test(message.location().url)
      && /Failed to load resource:.*404/.test(message.text());
    if (!expectedMissingLambdaPolicy) errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown error"})`));
  page.on("response", response => {
    const expectedMissingLambdaPolicy = response.status() === 404
      && response.request().method() === "GET"
      && /(?:\/2015-03-31\/functions\/[^/]+\/policy|\/2018-10-31\/layers\/[^/]+\/versions\/\d+\/policy|\/2020-06-30\/functions\/[^/]+\/code-signing-config)$/.test(response.url());
    if (response.status() >= 400 && !expectedMissingLambdaPolicy) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return errors;
}

async function createRole(target: StackSim, roleName = "phase-browser-role") {
  const response = await fetch(`http://127.0.0.1:${target.port}/_stacksim/api/iam/roles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      RoleName: roleName,
      Description: "Target phase browser fixture",
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
      },
    }),
  });
  if (!response.ok) throw new Error(`Unable to create browser role (${response.status})`);
  const attach = await fetch(`http://127.0.0.1:${target.port}/_stacksim/api/iam/roles/${encodeURIComponent(roleName)}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }),
  });
  if (!attach.ok) throw new Error(`Unable to attach browser role policy (${attach.status})`);
}

async function createFunction(target: StackSim, name: string, handler: string) {
  const lambda = new LambdaClient(sdkOptions(target));
  try {
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    return await lambda.send(new CreateFunctionCommand({
      FunctionName: name,
      Runtime: "nodejs22.x",
      Role: "arn:aws:iam::000000000000:role/phase-browser-role",
      Handler: handler,
      Code: { ZipFile: zip },
      Description: "Target phase browser fixture",
    }));
  } finally {
    lambda.destroy();
  }
}

async function confirmDeletion(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Confirm deletion" })).toBeVisible();
  await dialog.locator('input[name="confirmation"]').fill(name);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
}

test.describe("target phase console workflows", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-phase-browser-"));
    previousOciRoot = process.env.STACKSIM_LAMBDA_OCI_ROOT; process.env.STACKSIM_LAMBDA_OCI_ROOT = join(dataDir, "oci");
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", dynamoTtlSchedule: { sweepEveryMs: 20, transitionMs: 10, updateCooldownMs: 20 }, dynamoPolicyUpdateCooldownMs: 50, allowLocalFiles: true, apiGatewayVpcLinkOrigins: { [browserVpcTargetArn]: "http://127.0.0.1:9/browser-private" }, apiGatewayAllowClientCertificates: true, authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    await createRole(simulator);
  });

  test.afterEach(async () => {
    await simulator.stop();
    if (previousOciRoot === undefined) delete process.env.STACKSIM_LAMBDA_OCI_ROOT; else process.env.STACKSIM_LAMBDA_OCI_ROOT = previousOciRoot;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("DDB-03 commits, validates, and destructively deletes through the transaction builder", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({
        TableName: "BrowserTransactions",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      }));
      await waitForTableActive(dynamodb, "BrowserTransactions");
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/transactions`);
      const request = page.getByLabel("Transaction request (DynamoDB JSON)");
      const result = page.locator("#transaction-result");

      await request.fill("{");
      await page.getByRole("button", { name: "Run transaction" }).click();
      await expect(result).toContainText('"committed": false');
      await expect(page.locator("#toast-region").getByRole("alert")).toBeVisible();

      await request.fill(JSON.stringify({
        ClientRequestToken: "browser-transaction-put",
        ReturnConsumedCapacity: "TOTAL",
        TransactItems: [{ Put: { TableName: "BrowserTransactions", Item: { id: { S: "browser-item" }, value: { S: "committed" } } } }],
      }, null, 2));
      await page.getByRole("button", { name: "Refresh preview" }).click();
      await expect(result).toContainText("browser-item");
      await page.getByRole("button", { name: "Run transaction" }).click();
      await expect(result).toContainText('"committed": true');
      await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Transaction committed" })).toBeVisible();
      expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserTransactions", Key: { id: { S: "browser-item" } } }))).Item?.value?.S).toBe("committed");

      await request.fill(JSON.stringify({
        ClientRequestToken: "browser-transaction-delete",
        TransactItems: [{ Delete: { TableName: "BrowserTransactions", Key: { id: { S: "browser-item" } }, ConditionExpression: "attribute_exists(id)" } }],
      }, null, 2));
      await page.getByRole("button", { name: "Run transaction" }).click();
      await expect(result).toContainText('"committed": true');
      expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserTransactions", Key: { id: { S: "browser-item" } } }))).Item).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      dynamodb.destroy();
    }
  });

  test("DDB-02 creates, explores, and deletes secondary indexes through responsive table workflows", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserIndexes", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] }));
      await waitForTableActive(dynamodb, "BrowserIndexes");
      await dynamodb.send(new PutItemCommand({ TableName: "BrowserIndexes", Item: { id: { S: "one" }, category: { S: "books" }, title: { S: "Indexed item" } } }));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserIndexes/indexes`);
      await expect(page.getByRole("heading", { name: "Secondary indexes" })).toBeVisible();
      await expect(page.getByRole("cell", { name: "ByCategory" })).toBeVisible();
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserIndexes/items`);
      await page.getByLabel("Table or index").selectOption("ByCategory");
      await page.getByLabel("Operation").selectOption("query");
      await page.getByLabel("Partition key value").fill("books");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByRole("cell", { name: "Indexed item" })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByLabel("Table or index")).toBeVisible();
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserIndexes/capacity`);
      await expect(page.getByText("PAY_PER_REQUEST")).toBeVisible();
      expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-04 turns TTL on, expires an item, stages an attribute edit, and confirms turning TTL off", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserTtl", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
      await waitForTableActive(dynamodb, "BrowserTtl");
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserTtl/settings`); const ttlCard = page.locator(".ttl-card");
      await expect(ttlCard.getByRole("heading", { name: "Time to Live (TTL)" })).toBeVisible(); await expect(ttlCard.getByText("Off", { exact: true })).toBeVisible(); await expect(ttlCard.getByText("Unix epoch time in seconds")).toBeVisible();
      await ttlCard.getByRole("button", { name: "Turn on" }).click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Turn on Time to Live (TTL)" })).toBeVisible(); await dialog.getByLabel("TTL attribute name").fill("expiresAt"); await dialog.getByRole("button", { name: "Turn on", exact: true }).click();
      await page.waitForTimeout(50); await page.reload(); await expect(ttlCard.getByText("On", { exact: true })).toBeVisible(); await expect(ttlCard.getByText("expiresAt", { exact: true })).toBeVisible();
      const expiresAt = Math.floor(Date.now() / 1000) - 1; await dynamodb.send(new PutItemCommand({ TableName: "BrowserTtl", Item: { id: { S: "browser-expired" }, expiresAt: { N: String(expiresAt) } } }));
      await expect.poll(async () => (await dynamodb.send(new GetItemCommand({ TableName: "BrowserTtl", Key: { id: { S: "browser-expired" } } }))).Item).toBeUndefined();

      await ttlCard.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("Changing the TTL attribute takes two steps")).toBeVisible(); await dialog.getByLabel("New TTL attribute name").fill("removeAfter"); await dialog.getByRole("button", { name: "Turn off and continue" }).click();
      await page.waitForTimeout(50); await page.reload(); await expect(ttlCard.getByText("Off", { exact: true })).toBeVisible(); await ttlCard.getByRole("button", { name: "Turn on" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("TTL attribute name")).toHaveValue("removeAfter"); await dialog.getByRole("button", { name: "Turn on", exact: true }).click();
      await page.waitForTimeout(50); await page.reload(); await expect(ttlCard.getByText("On", { exact: true })).toBeVisible(); await expect(ttlCard.getByText("removeAfter", { exact: true })).toBeVisible();

      await ttlCard.getByRole("button", { name: "Turn off" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Turn off Time to Live (TTL)" })).toBeVisible(); await expect(dialog.getByRole("button", { name: "Turn off", exact: true })).toBeEnabled(); await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "Turn off", exact: true }).click(); await page.waitForTimeout(50); await page.reload(); await expect(ttlCard.getByText("Off", { exact: true })).toBeVisible();
      expect((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "BrowserTtl" }))).TimeToLiveDescription).toEqual({ TimeToLiveStatus: "DISABLED" });
      expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-05 runs parameterized CRUD, pages results, switches formats, and records PartiQL history", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserPartiql", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
      await waitForTableActive(dynamodb, "BrowserPartiql");
      await Promise.all(Array.from({ length: 12 }, (_, index) => dynamodb.send(new PutItemCommand({ TableName: "BrowserPartiql", Item: { id: { S: `item-${String(index).padStart(2, "0")}` }, title: { S: `Item ${String(index).padStart(2, "0")}` } } }))));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/partiql`);
      const statement = page.getByLabel("PartiQL statement"); const parameters = page.getByLabel("Parameters (DynamoDB JSON)"); const result = page.locator("#partiql-result");

      await statement.fill('SELECT id, title FROM "BrowserPartiql" WHERE id=?'); await parameters.fill('[{"S":"item-02"}]'); await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(result.getByRole("cell", { name: "item-02" })).toBeVisible(); await expect(result.getByRole("cell", { name: "Item 02" })).toBeVisible();
      await page.getByLabel("Results view").selectOption("plain"); await expect(result.getByText("Plain JSON")).toBeVisible(); await expect(result.getByRole("cell", { name: '"Item 02"' })).toBeVisible();

      await statement.fill('SELECT id, title FROM "BrowserPartiql"'); await parameters.fill("[]"); await page.getByLabel("Page size").selectOption("10"); await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(result.locator("tbody tr")).toHaveCount(10); await expect(result.getByRole("button", { name: "Next" })).toBeEnabled(); await result.getByRole("button", { name: "Next" }).click();
      await expect(result.getByText("Page 2")).toBeVisible(); await expect(result.locator("tbody tr")).toHaveCount(2); await expect(result.getByRole("button", { name: "Previous" })).toBeEnabled();

      const parameterId = "x' OR id='item-00";
      await statement.fill('INSERT INTO "BrowserPartiql" VALUE {\'id\':?,\'title\':?}'); await parameters.fill(JSON.stringify([{ S: parameterId }, { S: "Inserted safely" }])); await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(result.getByRole("heading", { name: /Statement completed/ })).toBeVisible(); expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserPartiql", Key: { id: { S: parameterId } } }))).Item?.title?.S).toBe("Inserted safely");

      await statement.fill('UPDATE "BrowserPartiql" SET title=? WHERE id=? RETURNING ALL NEW *'); await parameters.fill(JSON.stringify([{ S: "Updated safely" }, { S: parameterId }])); await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(result.getByRole("cell", { name: '"Updated safely"' })).toBeVisible();
      await statement.fill('DELETE FROM "BrowserPartiql" WHERE id=? RETURNING ALL OLD *'); await parameters.fill(JSON.stringify([{ S: parameterId }])); await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(result.getByRole("cell", { name: '"Updated safely"' })).toBeVisible(); expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserPartiql", Key: { id: { S: parameterId } } }))).Item).toBeUndefined();

      await parameters.fill("{"); await page.getByRole("button", { name: "Run", exact: true }).click(); await expect(result.getByRole("heading", { name: "Error details" })).toBeVisible(); await expect(result).toContainText(/JSON.*position|Expected property name/);
      const history = page.locator(".partiql-history"); await expect(history.locator(".partiql-history-list button")).toHaveCount(6); await expect(history.getByText("INSERT", { exact: true })).toBeVisible(); await expect(history.getByText("DELETE", { exact: true }).first()).toBeVisible();
      expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-06 manages capacity, auto scaling, table settings, encryption, deletion protection, and tags", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      const created = await dynamodb.send(new CreateTableCommand({ TableName: "BrowserSettings", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], DeletionProtectionEnabled: true, TableClass: "STANDARD_INFREQUENT_ACCESS", OnDemandThroughput: { MaxReadRequestUnits: 20, MaxWriteRequestUnits: 10 }, WarmThroughput: { ReadUnitsPerSecond: 30, WriteUnitsPerSecond: 15 }, Tags: [{ Key: "environment", Value: "browser" }, { Key: "team", Value: "learning" }] }));
      await waitForTableActive(dynamodb, "BrowserSettings");
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserSettings/capacity`); const capacity = page.locator(".capacity-card");
      await expect(capacity.getByRole("heading", { name: "Read/write capacity" })).toBeVisible(); await expect(capacity.getByText("On-demand", { exact: true })).toBeVisible(); await expect(capacity.getByText("20", { exact: true })).toBeVisible(); await expect(capacity.getByText("STACKSIM_DDB_ENFORCE_CAPACITY=true")).toBeVisible();
      await capacity.getByRole("button", { name: "Edit capacity" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Capacity mode").selectOption("PROVISIONED"); await dialog.getByLabel("Read capacity / maximum").fill("4"); await dialog.getByLabel("Write capacity / maximum").fill("5"); await dialog.getByRole("button", { name: "Save changes" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(capacity.getByText("Provisioned", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Configure auto scaling" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Minimum capacity units").fill("2"); await dialog.getByLabel("Maximum capacity units").fill("12"); await dialog.getByLabel("Target utilization (%)").fill("65"); await dialog.getByRole("button", { name: "Save auto scaling" }).click(); await page.waitForTimeout(25); await page.reload(); await expect(page.getByText("2–12", { exact: true })).toHaveCount(2);

      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserSettings/settings`); const classCard = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Table class", exact: true }) }); const protectionCard = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Deletion protection", exact: true }) }); const encryptionCard = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Encryption at rest", exact: true }) });
      await expect(classCard.getByText("DynamoDB Standard-Infrequent Access", { exact: true })).toBeVisible(); await expect(protectionCard.getByText("On", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled(); await expect(encryptionCard.getByText("service-owned key (local AES256 descriptor)", { exact: true })).toBeVisible();
      await classCard.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Table class").selectOption("STANDARD"); await dialog.getByRole("button", { name: "Save changes" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(page.getByText("DynamoDB Standard", { exact: true })).toBeVisible();
      await protectionCard.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("checkbox", { name: "Enable deletion protection" }).uncheck(); await dialog.getByRole("button", { name: "Save changes" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
      await encryptionCard.getByRole("button", { name: "Manage encryption" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Encryption key type").selectOption("KMS"); await dialog.getByLabel(/KMS key ID/).fill("alias/browser-key"); await dialog.getByRole("button", { name: "Save encryption" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(page.getByText("Dependency blocked", { exact: true })).toBeVisible(); await expect(page.getByText("alias/browser-key", { exact: true })).toBeVisible();

      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserSettings/tags`); await expect(page.getByRole("cell", { name: "environment" })).toBeVisible(); await page.getByRole("button", { name: "Manage tags" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Tags (JSON object)").fill("{"); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.locator("#toast-region").getByRole("alert")).toBeVisible(); await expect(dialog).toBeVisible(); await dialog.getByLabel("Tags (JSON object)").fill('{"team":"database","owner":"browser"}'); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.getByRole("cell", { name: "owner" })).toBeVisible(); await expect(page.getByRole("cell", { name: "environment" })).not.toBeVisible();
      const described = (await dynamodb.send(new DescribeTableCommand({ TableName: "BrowserSettings" }))).Table!; expect(described.BillingModeSummary?.BillingMode).toBe("PROVISIONED"); expect(described.DeletionProtectionEnabled).toBe(false); expect(described.TableClassSummary?.TableClass).toBe("STANDARD"); expect(described.SSEDescription?.Status).toBe("UPDATING"); expect((await dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: created.TableDescription!.TableArn! }))).Tags).toEqual([{ Key: "owner", Value: "browser" }, { Key: "team", Value: "database" }]); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-07 creates, inspects, restores, and deletes backups and restores the latest PITR state", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserBackups", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "BrowserBackups"); await dynamodb.send(new PutItemCommand({ TableName: "BrowserBackups", Item: { id: { S: "record" }, version: { N: "1" } } }));
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserBackups/backups`); const pitrCard = page.locator(".pitr-card"); await expect(pitrCard.getByText("Off", { exact: true })).toBeVisible(); await expect(page.getByText("No on-demand backups", { exact: true })).toBeVisible();
      await pitrCard.getByRole("button", { name: "Turn on" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Recovery period").selectOption("7"); await dialog.getByRole("button", { name: "Turn on" }).click(); await expect(pitrCard.getByText("On", { exact: true })).toBeVisible(); await expect(pitrCard.getByText("7 days", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Create backup" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Backup name").fill("browser-backup"); await dialog.getByRole("button", { name: "Create backup" }).click(); await page.waitForTimeout(75); await page.reload(); const backupRow = page.getByRole("row").filter({ hasText: "browser-backup" }); await expect(backupRow.getByText("AVAILABLE", { exact: true })).toBeVisible();
      await backupRow.getByRole("button", { name: "browser-backup" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Backup details" })).toBeVisible(); await expect(dialog.getByText(/0 global secondary indexes/)).toBeVisible(); await expect(dialog.getByText("Tags, TTL, streams, auto scaling, alarms, and IAM policies must be configured again on the restored table.")).toBeVisible(); await dialog.locator("#modal-submit").click();

      await dynamodb.send(new PutItemCommand({ TableName: "BrowserBackups", Item: { id: { S: "record" }, version: { N: "2" } } })); await backupRow.getByRole("button", { name: "Restore" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("New table name").fill("BrowserBackupRestore"); await dialog.getByRole("button", { name: "Restore table" }).click(); await expect(page.getByRole("heading", { name: "BrowserBackupRestore" })).toBeVisible(); await waitForTableActive(dynamodb, "BrowserBackupRestore"); expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserBackupRestore", Key: { id: { S: "record" } } }))).Item?.version?.N).toBe("1");

      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserBackups/backups`); await pitrCard.getByRole("button", { name: "Restore" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("New table name").fill("BrowserPitrRestore"); await dialog.getByRole("button", { name: "Restore table" }).click(); await expect(page.getByRole("heading", { name: "BrowserPitrRestore" })).toBeVisible(); await waitForTableActive(dynamodb, "BrowserPitrRestore"); expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserPitrRestore", Key: { id: { S: "record" } } }))).Item?.version?.N).toBe("2");

      await page.goto(`${consoleUrl}#/dynamodb/backups`); const globalRow = page.getByRole("row").filter({ hasText: "browser-backup" }); await expect(globalRow.getByRole("link", { name: "BrowserBackups" })).toBeVisible(); await globalRow.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-backup"); await expect(page.getByText("No on-demand backups", { exact: true })).toBeVisible(); expect((await dynamodb.send(new ListBackupsCommand({ TableName: "BrowserBackups" }))).BackupSummaries).toEqual([]); expect((await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: "BrowserBackups" }))).ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus).toBe("ENABLED"); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("LAM-05 creates and manages a DynamoDB stream trigger from both service consoles", async ({ page }) => {
    await createFunction(simulator, "phase-stream-consumer", "handler.echoHandler"); await new Promise(resolve => setTimeout(resolve, 10));
    const dynamodb = new DynamoDBClient(sdkOptions(simulator)); const streams = new DynamoDBStreamsClient(sdkOptions(simulator)); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserStreams", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "BrowserStreams"); const errors = browserErrors(page); await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserStreams/streams`); const streamCard = page.locator(".stream-card"); const triggerCard = page.locator(".trigger-card");
      await expect(page.locator("#main .tabs").getByRole("link", { name: "Exports and streams" })).toHaveClass(/active/); await expect(streamCard.getByText("Off", { exact: true })).toBeVisible(); await expect(triggerCard.getByRole("button", { name: "Create trigger" })).toBeDisabled(); await expect(triggerCard.getByText("Turn on the DynamoDB stream before creating a Lambda trigger.")).toBeVisible();
      await streamCard.getByRole("button", { name: "Turn on" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Stream view type").selectOption("NEW_AND_OLD_IMAGES"); await dialog.getByRole("button", { name: "Turn on" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(streamCard.getByText("On", { exact: true })).toBeVisible(); await expect(streamCard.getByText("New and old images", { exact: true })).toBeVisible(); await expect(streamCard.locator(".mono").filter({ hasText: "/stream/" })).toBeVisible(); await expect(triggerCard.getByRole("button", { name: "Create trigger" })).toBeEnabled(); expect((await streams.send(new ListStreamsCommand({ TableName: "BrowserStreams" }))).Streams).toHaveLength(1);

      await triggerCard.getByRole("button", { name: "Create trigger" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("Execution-role permissions", { exact: true })).toBeVisible(); await fillArnCombobox(dialog.getByLabel("Function target"), "arn:aws:lambda:eu-west-1:000000000000:function:phase-stream-consumer"); await dialog.getByLabel("Starting position").selectOption("TRIM_HORIZON"); await dialog.getByLabel("Batch size").fill("2"); await dialog.getByLabel("Maximum retry attempts").fill("1"); await dialog.getByLabel("Bisect batch on function error").check(); await dialog.getByLabel("Report partial batch item failures").check(); await dialog.getByLabel(/Filter pattern/).fill('{"dynamodb":{"Keys":{"id":{"S":["browser"]}}}}'); await dialog.getByRole("button", { name: "Create trigger" }).click(); await expect(triggerCard.getByRole("cell", { name: "phase-stream-consumer" })).toBeVisible(); let mappings = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "phase-stream-consumer" })); expect(mappings.EventSourceMappings).toHaveLength(1); expect(mappings.EventSourceMappings?.[0].BatchSize).toBe(2); expect(mappings.EventSourceMappings?.[0].BisectBatchOnFunctionError).toBe(true);

      await triggerCard.getByRole("link", { name: "View mapping" }).click(); await expect(page).toHaveURL(/#\/lambda\/functions\/phase-stream-consumer/); const functionTriggers = page.locator(".trigger-card"); await expect(functionTriggers.getByRole("heading", { name: /Triggers/ })).toBeVisible(); await expect(functionTriggers.getByText("At-least-once stream delivery", { exact: true })).toBeVisible(); await functionTriggers.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Parallelization factor").fill("2"); await dialog.getByRole("button", { name: "Save" }).click(); mappings = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "phase-stream-consumer" })); expect(mappings.EventSourceMappings?.[0].ParallelizationFactor).toBe(2);
      await functionTriggers.getByRole("button", { name: "Disable" }).click(); await expect(functionTriggers.getByText("Disabled", { exact: true })).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await expect(functionTriggers.getByRole("button", { name: "Enable" })).toBeVisible(); await functionTriggers.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, mappings.EventSourceMappings![0].UUID!); await expect(functionTriggers.getByRole("heading", { name: "No triggers" })).toBeVisible(); expect((await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "phase-stream-consumer" }))).EventSourceMappings).toHaveLength(0);

      await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserStreams/streams`); await streamCard.getByRole("button", { name: "Manage stream" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Stream view type").selectOption("OLD_IMAGE"); await dialog.getByRole("button", { name: "Save changes" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(streamCard.getByText("Old image", { exact: true })).toBeVisible(); expect((await streams.send(new ListStreamsCommand({ TableName: "BrowserStreams" }))).Streams).toHaveLength(2);
      await streamCard.getByRole("button", { name: "Turn off" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("checkbox", { name: /acknowledge/ }).check(); await dialog.getByRole("button", { name: "Turn off" }).click(); await page.waitForTimeout(75); await page.reload(); await expect(streamCard.getByText("Off", { exact: true })).toBeVisible(); expect((await dynamodb.send(new DescribeTableCommand({ TableName: "BrowserStreams" }))).Table?.LatestStreamArn).toBeUndefined(); expect((await streams.send(new ListStreamsCommand({ TableName: "BrowserStreams" }))).Streams).toHaveLength(2); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); streams.destroy(); lambda.destroy(); }
  });

  test("DDB-09 validates, revisions, warns about, saves, and deletes a table resource policy", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserPermissions", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "BrowserPermissions"); const tableArn = "arn:aws:dynamodb:eu-west-1:000000000000:table/BrowserPermissions"; const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserPermissions/permissions`); const editorCard = page.locator(".policy-editor-card"); let editor = page.getByLabel("Policy document"); await expect(page.getByRole("link", { name: "Permissions" })).toHaveClass(/active/); await expect(editorCard.getByText("Not attached", { exact: true })).toBeVisible(); await expect(page.getByText("No resource-based policy attached", { exact: true })).toBeVisible(); await expect(page.getByText("Both identity and resource policies must allow access.", { exact: true })).toBeVisible();
      await editor.fill("{"); await editorCard.getByRole("button", { name: "Validate" }).click(); await expect(editorCard.getByText("Validation failed", { exact: true })).toBeVisible();
      const firstPolicy = { Version: "2012-10-17", Statement: [{ Sid: "AccountRead", Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: [tableArn, `${tableArn}/index/*`] }] }; await editor.fill(JSON.stringify(firstPolicy, null, 2)); await editorCard.getByRole("button", { name: "Validate" }).click(); await expect(editorCard.getByText("Policy structure is valid", { exact: true })).toBeVisible(); await editorCard.getByRole("button", { name: "Create policy" }).click(); await expect(editorCard.getByText("Attached", { exact: true })).toBeVisible(); const first = await dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: tableArn })); await expect(page.locator("[data-policy-revision-value]")).toHaveText(first.RevisionId!);
      await page.waitForTimeout(75); editor = page.getByLabel("Policy document"); const broadPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "dynamodb:GetItem", Resource: tableArn }] }; await editor.fill(JSON.stringify(broadPolicy, null, 2)); await editorCard.getByRole("button", { name: "Validate" }).click(); await expect(editorCard.getByText("Valid JSON with a broad principal", { exact: true })).toBeVisible(); await editorCard.getByRole("button", { name: "Save changes" }).click(); await expect(page.getByText("Broad principal detected", { exact: true })).toBeVisible(); const second = await dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: tableArn })); expect(second.RevisionId).not.toBe(first.RevisionId);
      await page.waitForTimeout(75); await editorCard.getByRole("button", { name: "Delete policy" }).click(); await confirmDeletion(page, "BrowserPermissions"); await expect(editorCard.getByText("Not attached", { exact: true })).toBeVisible(); await expect(dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: tableArn }))).rejects.toMatchObject({ name: "PolicyNotFoundException" }); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-10 creates, backfills, lists, replicates through, and removes a global table replica", async ({ page }) => {
    const west = new DynamoDBClient(sdkOptions(simulator)); const east = new DynamoDBClient({ ...sdkOptions(simulator), region: "us-east-1" });
    try {
      await west.send(new CreateTableCommand({ TableName: "BrowserGlobal", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(west, "BrowserGlobal"); await west.send(new PutItemCommand({ TableName: "BrowserGlobal", Item: { id: { S: "backfill" }, value: { S: "before" } } })); const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserGlobal/global`); const card = page.locator(".global-table-card"); await expect(card.getByText("No replica Regions", { exact: true })).toBeVisible(); await expect(card.getByText("MRSC witnesses, multi-account global tables", { exact: false })).toBeVisible(); await card.getByRole("button", { name: "Create replica" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Replica Region").fill("us-east-1"); await dialog.getByRole("button", { name: "Create replica" }).click(); await page.waitForTimeout(100); await page.reload();
      await expect(card.getByText("Multi-Region eventual (MREC)", { exact: true })).toBeVisible(); await expect(card.getByText("2019.11.21", { exact: true })).toBeVisible(); await expect(card.getByRole("cell", { name: /eu-west-1/ })).toBeVisible(); await expect(card.getByRole("cell", { name: "us-east-1", exact: true })).toBeVisible(); await expect(card.getByText("0600", { exact: true })).toBeVisible(); expect((await east.send(new GetItemCommand({ TableName: "BrowserGlobal", Key: { id: { S: "backfill" } } }))).Item?.value?.S).toBe("before");
      await west.send(new PutItemCommand({ TableName: "BrowserGlobal", Item: { id: { S: "replicated" }, value: { S: "west" } } })); expect((await east.send(new GetItemCommand({ TableName: "BrowserGlobal", Key: { id: { S: "replicated" } } }))).Item?.value?.S).toBe("west"); await page.goto(`${consoleUrl}#/dynamodb/global-tables`); await expect(page.getByRole("heading", { name: "Global tables", exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: "BrowserGlobal" })).toBeVisible(); expect((await west.send(new ListGlobalTablesCommand({ RegionName: "us-east-1" }))).GlobalTables).toHaveLength(1);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserGlobal/global`); await page.getByRole("button", { name: "Remove", exact: true }).click(); await confirmDeletion(page, "us-east-1"); await page.waitForTimeout(100); await page.reload(); await expect(card.getByText("No replica Regions", { exact: true })).toBeVisible(); await expect(east.send(new DescribeTableCommand({ TableName: "BrowserGlobal" }))).rejects.toMatchObject({ name: "ResourceNotFoundException" }); expect(errors).toEqual([]);
    } finally { west.destroy(); east.destroy(); }
  });

  test("DUG-12 exports and imports DynamoDB JSON through the transfer console", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator)); const bucket = pathToFileURL(join(dataDir, "browser-transfer-bucket")).href;
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserTransfer", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "BrowserTransfer"); await dynamodb.send(new PutItemCommand({ TableName: "BrowserTransfer", Item: { id: { S: "roundtrip" }, value: { S: "browser" } } })); await dynamodb.send(new UpdateContinuousBackupsCommand({ TableName: "BrowserTransfer", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })); const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserTransfer/streams`); const exportCard = page.locator(".export-card"); await expect(exportCard.getByText("No exports", { exact: true })).toBeVisible(); await exportCard.getByRole("button", { name: "Export snapshot" }).click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("S3-compatible transfer", { exact: true })).toBeVisible(); await dialog.getByLabel("S3 bucket or file URL").fill(bucket); await dialog.getByLabel("Export prefix").fill("browser-roundtrip"); await dialog.getByRole("button", { name: "Export", exact: true }).click(); await expect(exportCard.getByText("COMPLETED", { exact: true })).toBeVisible(); await expect(exportCard.getByText("BrowserTransfer", { exact: true })).toBeVisible();
      const exports = await dynamodb.send(new ListExportsCommand({ TableArn: "arn:aws:dynamodb:eu-west-1:000000000000:table/BrowserTransfer" })); const exportId = exports.ExportSummaries![0].ExportArn!.split("/export/")[1]; await page.goto(`${consoleUrl}#/dynamodb/imports`); await expect(page.getByText("S3 is the primary transfer path", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Import table" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("S3 bucket or file URL").fill(bucket); await dialog.getByLabel("Key prefix or file").fill(`browser-roundtrip/AWSDynamoDB/${exportId}`); await dialog.getByLabel("Table name").fill("BrowserImported"); await dialog.getByLabel("Partition key").fill("id"); await dialog.getByRole("button", { name: "Import table" }).click(); const row = page.getByRole("row").filter({ hasText: "BrowserImported" }); await expect(row.getByText("COMPLETED", { exact: true })).toBeVisible(); expect((await dynamodb.send(new GetItemCommand({ TableName: "BrowserImported", Key: { id: { S: "roundtrip" } } }))).Item?.value?.S).toBe("browser");
      await page.goto(`${consoleUrl}#/dynamodb/exports`); await expect(page.getByRole("heading", { name: "Exports and streams", exact: true })).toBeVisible(); await expect(page.getByText("S3 is the primary transfer path", { exact: true })).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("cell", { name: "BrowserTransfer" })).toBeVisible(); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-10 configures contributor insights and explores local hot-key metrics", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator));
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserContributors", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] })); await waitForTableActive(dynamodb, "BrowserContributors"); const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserContributors/contributors`); await expect(page.locator("#main .tabs").getByRole("link", { name: "Contributor insights" })).toHaveClass(/active/); const tableRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: /BrowserContributors.*Table/ }) }); const indexRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: /ByCategory.*Global secondary index/ }) }); await expect(tableRow.getByText("DISABLED", { exact: true })).toBeVisible(); await expect(indexRow.getByText("DISABLED", { exact: true })).toBeVisible(); await expect(page.getByText("No key activity in the last hour", { exact: true })).toBeVisible();
      await tableRow.getByRole("button", { name: "Turn on" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Contributor insights mode").selectOption("ACCESSED_AND_THROTTLED_KEYS"); await dialog.getByRole("button", { name: "Save configuration" }).click(); await expect(tableRow.getByText("ENABLED", { exact: true })).toBeVisible(); await indexRow.getByRole("button", { name: "Turn on" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Save configuration" }).click(); await expect(indexRow.getByText("ENABLED", { exact: true })).toBeVisible();
      await dynamodb.send(new PutItemCommand({ TableName: "BrowserContributors", Item: { id: { S: "hot-key" }, category: { S: "featured" }, value: { N: "1" } } })); await dynamodb.send(new GetItemCommand({ TableName: "BrowserContributors", Key: { id: { S: "hot-key" } } })); await dynamodb.send(new QueryCommand({ TableName: "BrowserContributors", IndexName: "ByCategory", KeyConditionExpression: "category = :category", ExpressionAttributeValues: { ":category": { S: "featured" } } })); await page.reload(); const activity = page.locator(".contributor-activity-card"); await expect(activity.getByText(/hot-key/)).toBeVisible(); await expect(activity.getByText(/featured/)).toBeVisible();
      await tableRow.getByRole("button", { name: "Change mode" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Contributor insights mode").selectOption("THROTTLED_KEYS"); await dialog.getByRole("button", { name: "Save configuration" }).click(); await expect(tableRow.getByText("Throttled keys only", { exact: true })).toBeVisible(); expect((await dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "BrowserContributors" }))).ContributorInsightsMode).toBe("THROTTLED_KEYS");
      await page.goto(`${consoleUrl}#/dynamodb/contributor-insights`); await expect(page.getByRole("heading", { name: "Contributor insights", exact: true })).toBeVisible(); await expect(page.getByText("Shared CloudWatch telemetry", { exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: "BrowserContributors" }).first()).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("cell", { name: /ByCategory.*Global secondary index/ })).toBeVisible(); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("DDB-10 manages a configuration-only Kinesis streaming destination", async ({ page }) => {
    const dynamodb = new DynamoDBClient(sdkOptions(simulator)); const streamArn = "arn:aws:kinesis:eu-west-1:000000000000:stream/browser-events";
    try {
      await dynamodb.send(new CreateTableCommand({ TableName: "BrowserKinesis", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "BrowserKinesis"); const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserKinesis/streams`); const card = page.locator(".kinesis-destination-card"); await expect(card.getByText("Not connected", { exact: true })).toBeVisible(); await expect(card.getByText("No Kinesis service is running locally, so table writes do not deliver records.", { exact: false })).toBeVisible();
      await card.getByRole("button", { name: "Connect Kinesis data stream" }).click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("Configuration only", { exact: true })).toBeVisible(); await dialog.getByLabel("Kinesis data stream ARN").fill(streamArn); await dialog.getByLabel("Approximate creation time precision").selectOption("MILLISECOND"); await dialog.getByRole("button", { name: "Connect stream" }).click(); await expect(card.getByText("ACTIVE", { exact: true })).toBeVisible(); await expect(card.getByText("Millisecond", { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Change precision" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Approximate creation time precision").selectOption("MICROSECOND"); await dialog.getByRole("button", { name: "Save changes" }).click(); await expect(card.getByText("Microsecond", { exact: true })).toBeVisible(); let described = await dynamodb.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "BrowserKinesis" })); expect(described.KinesisDataStreamDestinations?.[0].ApproximateCreationDateTimePrecision).toBe("MICROSECOND");
      await page.setViewportSize({ width: 390, height: 844 }); await expect(card.getByText(streamArn, { exact: true })).toBeVisible(); await card.getByRole("button", { name: "Turn off" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("checkbox", { name: /acknowledge/ }).check(); await dialog.getByRole("button", { name: "Turn off" }).click(); await expect(card.getByText("DISABLED", { exact: true })).toBeVisible(); described = await dynamodb.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "BrowserKinesis" })); expect(described.KinesisDataStreamDestinations?.[0].DestinationStatus).toBe("DISABLED"); expect(errors).toEqual([]);
    } finally { dynamodb.destroy(); }
  });

  test("LAM-02 and LAM-03 manage permissions, tags, immutable versions, aliases, validation, and deletion", async ({ page }) => {
    await createFunction(simulator, "phase-browser-function", "handler.echoHandler");
    const errors = browserErrors(page);

    await page.goto(`${consoleUrl}#/lambda/functions/phase-browser-function/configuration`);
    await expect(page.getByText("No resource-based policy statements.")).toBeVisible();
    await expect(page.getByText("No tags.")).toBeVisible();

    await page.getByRole("button", { name: "Manage tags" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tags (JSON object)").fill("{");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast-region").getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser"}');
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("cell", { name: "environment", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "browser", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add permission" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Statement ID").fill("browser-api");
    await dialog.getByLabel("Source ARN").fill("arn:aws:execute-api:eu-west-1:000000000000:*/*/*/*");
    await dialog.getByRole("button", { name: "Add permission" }).click();
    await expect(page.getByRole("cell", { name: "browser-api" })).toBeVisible();

    await page.getByRole("button", { name: "Manage tags" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tags (JSON object)").fill("{}");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("No tags.")).toBeVisible();

    await page.goto(`${consoleUrl}#/lambda/functions/phase-browser-function/versions`);
    await page.getByRole("button", { name: "Publish new version" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Version description").fill("browser version");
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("cell", { name: "browser version" })).toBeVisible();

    await page.goto(`${consoleUrl}#/lambda/functions/phase-browser-function/aliases`);
    await expect(page.getByText("No aliases.")).toBeVisible();
    await page.getByRole("button", { name: "Create alias" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Alias name").fill("live");
    await dialog.getByLabel("Additional version weights (JSON)").fill("{");
    await dialog.getByRole("button", { name: "Create alias" }).click();
    await expect(page.locator("#toast-region").getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Additional version weights (JSON)").fill("{}");
    await dialog.getByRole("button", { name: "Create alias" }).click();
    await expect(page.getByRole("cell", { name: "live", exact: true })).toBeVisible();

    await page.getByRole("table").getByRole("button", { name: "Delete", exact: true }).click();
    await confirmDeletion(page, "live");
    await expect(page.getByText("No aliases.")).toBeVisible();
    await page.goto(`${consoleUrl}#/lambda/functions/phase-browser-function/versions`);
    await page.getByRole("table").getByRole("button", { name: "Delete", exact: true }).click();
    await confirmDeletion(page, "1");
    await expect(page.getByRole("cell", { name: "browser version" })).not.toBeVisible();
    expect(errors).toEqual([]);
  });

  test("LAM-04 configures durable asynchronous delivery and monitors queued retries", async ({ page }) => {
    await createFunction(simulator, "phase-async-source", "handler.throwingHandler");
    const destination = await createFunction(simulator, "phase-async-destination", "handler.echoHandler");
    await new Promise(resolve => setTimeout(resolve, 10));
    const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/lambda/functions/phase-async-source/configuration`);
      const card = page.locator(".async-invocation-card");
      await expect(card.getByRole("heading", { name: "Asynchronous invocation" })).toBeVisible();
      await expect(card.getByText("Durable, at-least-once delivery", { exact: true })).toBeVisible();
      await expect(card.getByText(/Lambda, same-Region SQS, and EventBridge destinations are active/)).toBeVisible();
      await expect(card.getByText(/SNS and S3 destinations remain dependency-blocked/)).toBeVisible();
      await card.getByRole("button", { name: "Edit" }).click();
      let dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Dependency-aware targets", { exact: true })).toBeVisible();
      await dialog.getByLabel("Maximum retry attempts").selectOption("1");
      await dialog.getByLabel("Maximum event age (seconds)").fill("600");
      await fillArnCombobox(dialog.getByLabel("Success destination"), destination.FunctionArn!);
      await fillArnCombobox(dialog.getByLabel("Failure destination"), destination.FunctionArn!);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(card.getByText(destination.FunctionArn!, { exact: true }).first()).toBeVisible();
      const configured = await lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "phase-async-source" }));
      expect(configured.MaximumRetryAttempts).toBe(1);
      expect(configured.MaximumEventAgeInSeconds).toBe(600);
      expect(configured.DestinationConfig?.OnFailure?.Destination).toBe(destination.FunctionArn);

      const accepted = await lambda.send(new InvokeCommand({ FunctionName: "phase-async-source", InvocationType: "Event", Payload: Buffer.from("{}") }));
      expect(accepted.StatusCode).toBe(202);
      await expect.poll(async () => {
        const queue = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/lambda/async?functionName=phase-async-source`)).json();
        return { retrying: queue.retrying, status: queue.events?.[0]?.status };
      }).toEqual({ retrying: 1, status: "QUEUED" });
      await page.goto(`${consoleUrl}#/lambda/functions/phase-async-source/monitor`);
      const queueCard = page.locator(".async-queue-card");
      await expect(queueCard.getByRole("heading", { name: "Asynchronous invocation queue" })).toBeVisible();
      await expect(queueCard.getByText("Waiting after retry", { exact: true })).toBeVisible();
      await expect(queueCard.getByRole("cell", { name: "QUEUED" })).toBeVisible();
      await expect(page.getByText("Async retried", { exact: true })).toBeVisible();
      await expect(page.getByText("Async failed / dropped", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(queueCard.getByRole("button", { name: "Refresh" })).toBeVisible();

      await page.goto(`${consoleUrl}#/lambda/functions/phase-async-source/configuration`);
      await page.locator(".async-invocation-card").getByRole("button", { name: "Reset" }).click();
      await expect(page.locator(".async-invocation-card").getByText("No destination", { exact: true }).first()).toBeVisible();
      await expect(lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "phase-async-source" }))).rejects.toMatchObject({ name: "ResourceNotFoundException" });
      expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("LAM-06 configures reserved and qualified provisioned concurrency and exposes Monitor metrics", async ({ page }) => {
    await createFunction(simulator, "phase-concurrency-function", "handler.concurrencyHandler"); await new Promise(resolve => setTimeout(resolve, 10)); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); const version = await lambda.send(new PublishVersionCommand({ FunctionName: "phase-concurrency-function" })); await lambda.send(new CreateAliasCommand({ FunctionName: "phase-concurrency-function", Name: "live", FunctionVersion: version.Version! }));
      await page.goto(`${consoleUrl}#/lambda/functions/phase-concurrency-function/configuration`); const card = page.locator(".concurrency-card"); await expect(card.getByRole("heading", { name: "Concurrency" })).toBeVisible(); await expect(card.getByText("Unreserved", { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Edit", exact: true }).click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("Exclusive function capacity", { exact: true })).toBeVisible(); await dialog.getByLabel("Reserved concurrency").fill("2"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(card.getByText("2", { exact: true }).first()).toBeVisible(); expect((await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: "phase-concurrency-function" }))).ReservedConcurrentExecutions).toBe(2);

      await page.goto(`${consoleUrl}#/lambda/functions/phase-concurrency-function/aliases`); const aliasRow = page.locator(".provisioned-aliases-card tbody tr").filter({ hasText: "live" }); await aliasRow.getByRole("button", { name: "Configure provisioned concurrency" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("Preinitialized qualified environments", { exact: true })).toBeVisible(); await expect(dialog.getByLabel("Qualifier")).toHaveValue("live"); await dialog.getByLabel("Provisioned concurrency").fill("1"); await dialog.getByRole("button", { name: "Configure", exact: true }).click(); await expect(aliasRow.getByText("READY", { exact: true })).toBeVisible();

      await page.goto(`${consoleUrl}#/lambda/functions/phase-concurrency-function/versions`); const versionRow = page.locator(".provisioned-versions-card tbody tr").filter({ has: page.locator("td strong", { hasText: /^1$/ }) }); await versionRow.getByRole("button", { name: "Configure provisioned concurrency" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Provisioned concurrency").fill("1"); await dialog.getByRole("button", { name: "Configure", exact: true }).click(); await expect(versionRow.getByText("READY", { exact: true })).toBeVisible(); expect((await lambda.send(new ListProvisionedConcurrencyConfigsCommand({ FunctionName: "phase-concurrency-function" }))).ProvisionedConcurrencyConfigs).toHaveLength(2);

      const invoked = await lambda.send(new InvokeCommand({ FunctionName: "phase-concurrency-function", Qualifier: "live", Payload: Buffer.from("{}") })); expect(JSON.parse(Buffer.from(invoked.Payload!).toString("utf8")).initializationType).toBe("provisioned-concurrency"); await page.goto(`${consoleUrl}#/lambda/functions/phase-concurrency-function/monitor`); await expect(page.getByText("Concurrent executions", { exact: true })).toBeVisible(); await expect(page.getByText("Throttles", { exact: true })).toBeVisible(); await expect(page.getByText("Provisioned concurrency invocations", { exact: true })).toBeVisible(); await expect(page.getByText("Provisioned concurrency spillover", { exact: true })).toBeVisible();

      await page.goto(`${consoleUrl}#/lambda/functions/phase-concurrency-function/configuration`); await expect(page.locator(".concurrency-card").getByText("READY", { exact: true })).toHaveCount(2); await page.locator(".concurrency-card").getByRole("button", { name: "Use unreserved account concurrency" }).click(); await expect(page.locator(".concurrency-card").getByText("Unreserved", { exact: true })).toBeVisible(); expect((await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: "phase-concurrency-function" }))).ReservedConcurrentExecutions).toBeUndefined(); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("LAM-07 creates, versions, permits, attaches, and reorders Lambda layers", async ({ page }) => {
    await createFunction(simulator, "phase-layer-function", "handler.echoHandler"); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); const first = await lambda.send(new PublishLayerVersionCommand({ LayerName: "phase-shared", Content: { ZipFile: zip }, Description: "first browser layer", CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"] })); const second = await lambda.send(new PublishLayerVersionCommand({ LayerName: "phase-shared", Content: { ZipFile: zip }, Description: "second browser layer", CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"] })); await lambda.send(new AddLayerVersionPermissionCommand({ LayerName: "phase-shared", VersionNumber: 2, StatementId: "seed-account", Action: "lambda:GetLayerVersion", Principal: "111122223333" })); const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/lambda/layers`); await expect(page.getByRole("heading", { name: "Layers", exact: true }).first()).toBeVisible(); await expect(page.getByRole("link", { name: "phase-shared" })).toBeVisible(); await page.getByRole("link", { name: "phase-shared" }).click(); await expect(page.locator(".layer-versions-card tbody tr")).toHaveCount(2); await expect(page.getByText("Versions (2)", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "2", exact: true }).click(); const permissions = page.locator(".layer-permissions-card"); await expect(permissions.getByText("seed-account", { exact: true })).toBeVisible(); await permissions.getByRole("button", { name: "Add permission" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Statement ID").fill("browser-org"); await dialog.getByLabel("Principal").fill("*"); await dialog.getByLabel("Organization ID (optional)").fill("o-abc123def456"); await dialog.getByRole("button", { name: "Add permission" }).click(); await expect(permissions.getByText("browser-org", { exact: true })).toBeVisible();

      await page.goto(`${consoleUrl}#/lambda/functions/phase-layer-function/configuration`); const card = page.locator(".layers-card"); await expect(card.getByRole("heading", { name: "Layers (0/5)" })).toBeVisible(); await card.getByRole("button", { name: "Add a layer" }).click(); dialog = page.getByRole("dialog"); await fillArnCombobox(dialog.getByLabel("Compatible layer version"), first.LayerVersionArn!); await dialog.getByRole("button", { name: "Add", exact: true }).click(); await expect(card.getByText(first.LayerVersionArn!, { exact: true })).toBeVisible(); await card.getByRole("button", { name: "Add a layer" }).click(); dialog = page.getByRole("dialog"); await fillArnCombobox(dialog.getByLabel("Compatible layer version"), second.LayerVersionArn!); await dialog.getByRole("button", { name: "Add", exact: true }).click(); await expect(card.getByRole("heading", { name: "Layers (2/5)" })).toBeVisible(); expect((await lambda.send(new GetFunctionCommand({ FunctionName: "phase-layer-function" }))).Configuration?.Layers?.map(layer => layer.Arn)).toEqual([first.LayerVersionArn, second.LayerVersionArn]);
      const secondRow = card.locator("tbody tr").filter({ hasText: second.LayerVersionArn! }); await secondRow.getByRole("button", { name: "Move up" }).click(); await expect(card.locator("tbody tr").first()).toContainText(second.LayerVersionArn!); expect((await lambda.send(new GetFunctionCommand({ FunctionName: "phase-layer-function" }))).Configuration?.Layers?.map(layer => layer.Arn)).toEqual([second.LayerVersionArn, first.LayerVersionArn]); await card.locator("tbody tr").filter({ hasText: first.LayerVersionArn! }).getByRole("button", { name: "Remove" }).click(); await expect(card.getByRole("heading", { name: "Layers (1/5)" })).toBeVisible();

      await page.goto(`${consoleUrl}#/lambda/layers/create`); await page.getByLabel("Layer name").fill("browser-created-layer"); await page.getByLabel("Description").fill("Created through the local console"); await page.getByLabel("Layer ZIP file").setInputFiles(join(process.cwd(), "examples/lambda/function.zip")); await page.getByRole("button", { name: "Publish", exact: true }).click(); await expect(page.getByRole("heading", { name: "browser-created-layer:1" })).toBeVisible(); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("LAM-08 creates, edits, invokes, and deletes qualified Lambda function URLs", async ({ page }) => {
    await createFunction(simulator, "phase-url-function", "handler.echoHandler"); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); const version = await lambda.send(new PublishVersionCommand({ FunctionName: "phase-url-function" })); await lambda.send(new CreateAliasCommand({ FunctionName: "phase-url-function", Name: "live", FunctionVersion: version.Version! }));
      await page.goto(`${consoleUrl}#/lambda/functions/phase-url-function/configuration`); const card = page.locator(".function-url-card"); await expect(card.getByRole("heading", { name: "Function URL (0)" })).toBeVisible(); await expect(card.getByRole("heading", { name: "No function URL" })).toBeVisible();

      await card.getByRole("button", { name: "Create function URL" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Create function URL" })).toBeVisible(); await expect(dialog.getByLabel("Qualifier")).toHaveValue("$LATEST"); await dialog.getByLabel("Auth type").selectOption("NONE"); await dialog.getByLabel("Invoke mode").selectOption("RESPONSE_STREAM"); await dialog.getByLabel("Configure cross-origin resource sharing (CORS)").check(); await dialog.getByLabel("Allow origins").fill("https://app.example"); await dialog.getByLabel("Allow methods").fill("GET, POST"); await dialog.getByLabel("Allow headers").fill("content-type, x-requested-with"); await dialog.getByLabel("Expose headers").fill("x-stream-id"); await dialog.getByLabel("Max age (seconds)").fill("300"); await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(card.getByRole("heading", { name: "Function URL (1)" })).toBeVisible(); await expect(card.getByText("Public URL enabled", { exact: true })).toBeVisible(); const latest = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: "phase-url-function" })); expect(latest.AuthType).toBe("NONE"); expect(latest.InvokeMode).toBe("RESPONSE_STREAM"); expect(latest.Cors?.AllowOrigins).toEqual(["https://app.example"]); const publicResponse = await fetch(latest.FunctionUrl!, { headers: { origin: "https://app.example" } }); expect(publicResponse.status).toBe(200); expect(publicResponse.headers.get("access-control-allow-origin")).toBe("https://app.example"); expect(JSON.parse(await publicResponse.text()).version).toBe("2.0");

      const latestRow = card.locator("tbody tr").filter({ hasText: "$LATEST" }); await latestRow.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("Stable URL", { exact: true })).toBeVisible(); await expect(dialog.getByText(latest.FunctionUrl!, { exact: true })).toBeVisible(); await dialog.getByLabel("Auth type").selectOption("AWS_IAM"); await dialog.getByLabel("Invoke mode").selectOption("BUFFERED"); await dialog.getByLabel("Configure cross-origin resource sharing (CORS)").uncheck(); await dialog.getByRole("button", { name: "Save", exact: true }).click(); const edited = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: "phase-url-function" })); expect(edited.FunctionUrl).toBe(latest.FunctionUrl); expect(edited.AuthType).toBe("AWS_IAM"); expect(edited.InvokeMode).toBe("BUFFERED"); expect(edited.Cors).toBeUndefined(); await expect(card.getByText("Public URL enabled", { exact: true })).not.toBeVisible();

      await card.getByRole("button", { name: "Create function URL" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Qualifier").selectOption("live"); await dialog.getByRole("button", { name: "Create", exact: true }).click(); await expect(card.getByRole("heading", { name: "Function URL (2)" })).toBeVisible(); const configs = await lambda.send(new ListFunctionUrlConfigsCommand({ FunctionName: "phase-url-function" })); expect(configs.FunctionUrlConfigs?.map(config => config.FunctionArn?.split(":").at(-1))).toEqual(["phase-url-function", "live"]);

      await card.locator("tbody tr").filter({ hasText: "live" }).getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "live"); await expect(card.getByRole("heading", { name: "Function URL (1)" })).toBeVisible(); await card.locator("tbody tr").filter({ hasText: "$LATEST" }).getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "$LATEST"); await expect(card.getByRole("heading", { name: "Function URL (0)" })).toBeVisible(); expect((await lambda.send(new ListFunctionUrlConfigsCommand({ FunctionName: "phase-url-function" }))).FunctionUrlConfigs).toEqual([]); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("LAM-09 manages complete Lambda configuration while disclosing dependency-blocked behavior", async ({ page }) => {
    await createFunction(simulator, "phase-configured-function", "handler.echoHandler"); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); const signing = await lambda.send(new CreateCodeSigningConfigCommand({ AllowedPublishers: { SigningProfileVersionArns: ["arn:aws:signer:eu-west-1:000000000000:/signing-profiles/browser_profile/abc123"] }, Description: "Browser signing reference" })); const signingArn = signing.CodeSigningConfig!.CodeSigningConfigArn!; await simulator.sqs.CreateQueue({ QueueName: "browser-dead-letter" });
      await page.goto(`${consoleUrl}#/lambda/functions/phase-configured-function/configuration`);
      const defaultLogGroup = "/aws/lambda/phase-configured-function"; const defaultLogHref = `#/cloudwatch/log-groups/${encodeURIComponent(defaultLogGroup)}`;
      await expect(page.getByRole("link", { name: "View logs", exact: true })).toHaveAttribute("href", defaultLogHref);
      await expect(page.locator(".monitoring-tools-card").getByRole("link", { name: defaultLogGroup, exact: true })).toHaveAttribute("href", defaultLogHref);
      await page.setViewportSize({ width: 390, height: 844 }); const actionTops = await page.locator(".lambda-function-detail > .page-header .actions > .button").evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top))); expect(new Set(actionTops).size).toBe(1); await page.setViewportSize({ width: 1280, height: 720 });
      for (const heading of ["General configuration", "Runtime settings", "Monitoring and operations tools", "VPC", "File systems (0)", "Code signing", "Recursive loop detection", "Environment encryption", "Function URL (0)", "Layers (0/5)", "Concurrency", "Asynchronous invocation", "Permissions", "Tags (0)", "Environment variables"]) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText("Stored only — no network attachment", { exact: true })).toBeVisible(); await expect(page.getByText("Stored only — no EFS mount", { exact: true })).toBeVisible(); await expect(page.getByText("Tracing dependency unavailable", { exact: true })).toBeVisible(); await expect(page.getByText("Signer dependency unavailable", { exact: true })).toBeVisible(); await expect(page.getByText("Stored only — no KMS encryption", { exact: true })).toBeVisible();

      await page.locator(".runtime-settings-card").getByRole("button", { name: "Edit" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Architecture").selectOption("arm64"); await dialog.getByLabel("Ephemeral storage (MB)").fill("1024"); await dialog.getByLabel("Runtime update mode").selectOption("Manual"); const runtimeArn = "arn:aws:lambda:eu-west-1::runtime:nodejs22-browser"; await dialog.getByLabel("Runtime version ARN").fill(runtimeArn); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.locator(".runtime-settings-card").getByText("1024 MB", { exact: true })).toBeVisible();
      let configured = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "phase-configured-function" })); expect(configured.Architectures).toEqual(["arm64"]); expect(configured.EphemeralStorage?.Size).toBe(1024); expect((await lambda.send(new GetRuntimeManagementConfigCommand({ FunctionName: "phase-configured-function", Qualifier: "$LATEST" }))).RuntimeVersionArn).toBe(runtimeArn);

      await page.locator(".monitoring-tools-card").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Log format").selectOption("JSON"); await dialog.getByLabel("Tracing mode").selectOption("Active"); await dialog.getByLabel("Log group").fill("/stacksim/lambda/browser-configured"); await dialog.getByLabel("Application log level").selectOption("ERROR"); await dialog.getByLabel("System log level").selectOption("WARN"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); const customLogGroup = "/stacksim/lambda/browser-configured"; const customLogHref = `#/cloudwatch/log-groups/${encodeURIComponent(customLogGroup)}`; await expect(page.locator(".monitoring-tools-card").getByRole("link", { name: customLogGroup, exact: true })).toHaveAttribute("href", customLogHref); await expect(page.getByRole("link", { name: "View logs", exact: true })).toHaveAttribute("href", customLogHref); configured = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "phase-configured-function" })); expect(configured.LoggingConfig).toMatchObject({ LogFormat: "JSON", ApplicationLogLevel: "ERROR", SystemLogLevel: "WARN", LogGroup: customLogGroup }); expect(configured.TracingConfig?.Mode).toBe("Active");

      await page.locator(".vpc-card").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Subnet IDs").fill("subnet-0123abcd"); await dialog.getByLabel("Security group IDs").fill("sg-0123abcd"); await dialog.getByLabel("Allow IPv6 for dual-stack subnets").check(); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.locator(".vpc-card").getByText("subnet-0123abcd", { exact: true })).toBeVisible();
      await page.locator(".file-systems-card").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); const efsArn = "arn:aws:elasticfilesystem:eu-west-1:000000000000:access-point/fsap-0123456789abcdef0"; await dialog.getByLabel("EFS access point ARN").fill(efsArn); await dialog.getByLabel("Local mount path").fill("/mnt/browser"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("heading", { name: "File systems (1)", exact: true })).toBeVisible();

      await page.locator(".environment-variables-card").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Environment variables (JSON object)").fill('{"BROWSER_MODE":"configured"}'); const kmsArn = "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab"; await dialog.getByLabel("KMS key ARN").fill(kmsArn); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("cell", { name: "BROWSER_MODE", exact: true })).toBeVisible();
      await page.locator(".recursive-loop-card").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Recursive loop policy").selectOption("Allow"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); expect((await lambda.send(new GetFunctionRecursionConfigCommand({ FunctionName: "phase-configured-function" }))).RecursiveLoop).toBe("Allow");
      await page.locator(".code-signing-card").getByRole("button", { name: "Manage association" }).click(); dialog = page.getByRole("dialog"); await fillArnCombobox(dialog.getByLabel("Code signing configuration"), signingArn); await dialog.getByRole("button", { name: "Save", exact: true }).click(); expect((await lambda.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: "phase-configured-function" }))).CodeSigningConfigArn).toBe(signingArn);
      await page.locator(".async-invocation-card").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); const deadLetterArn = "arn:aws:sqs:eu-west-1:000000000000:browser-dead-letter"; await dialog.getByLabel("Success destination").press("ArrowDown"); await expect(dialog.getByRole("option", { name: /browser-dead-letter/ })).toBeVisible(); await dialog.getByLabel("Success destination").press("Escape"); await dialog.getByLabel("Dead-letter target ARN").fill(deadLetterArn); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.locator(".async-invocation-card").getByText(deadLetterArn, { exact: true })).toBeVisible(); configured = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "phase-configured-function" })); expect(configured.DeadLetterConfig?.TargetArn).toBe(deadLetterArn); expect(configured.VpcConfig).toMatchObject({ SubnetIds: ["subnet-0123abcd"], SecurityGroupIds: ["sg-0123abcd"], Ipv6AllowedForDualStack: true }); expect(configured.FileSystemConfigs?.[0]).toMatchObject({ Arn: efsArn, LocalMountPath: "/mnt/browser" }); expect(configured.Environment?.Variables).toEqual({ BROWSER_MODE: "configured" }); expect(configured.KMSKeyArn).toBe(kmsArn);
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".recursive-loop-card").getByText("Allow", { exact: true })).toBeVisible(); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("explains non-obvious Lambda panels and their StackSim support", async ({ page }) => {
    await createFunction(simulator, "phase-panel-help-function", "handler.echoHandler");

    await page.goto(`${consoleUrl}#/lambda/functions/phase-panel-help-function`);
    const triggerCard = page.locator(".trigger-card");
    const triggerHelp = triggerCard.getByRole("button", { name: "About Triggers" });
    await expect(triggerHelp).toBeVisible();
    await triggerHelp.hover();
    await expect(triggerCard.getByRole("tooltip")).toContainText("runs your code automatically");
    await expect(triggerCard.getByRole("tooltip")).toContainText("Add trigger flow supports enabled DynamoDB streams and SQS queues");

    await page.goto(`${consoleUrl}#/lambda/functions/phase-panel-help-function/test`);
    const testEventCard = page.locator(".lambda-test-event-card");
    const testEventHelp = testEventCard.getByRole("button", { name: "About Test event" });
    await expect(testEventHelp).toBeVisible();
    await testEventHelp.hover();
    const testEventTooltip = testEventCard.getByRole("tooltip");
    await expect(testEventTooltip).toContainText("Synchronous waits for the function result");
    await expect(testEventTooltip).toContainText("Asynchronous durably queues the event");
    await expect(testEventTooltip).toContainText("API Gateway proxy request fills a representative proxy event");
    await expect(testEventTooltip).toContainText("Event JSON is the exact payload passed to the handler");

    await page.goto(`${consoleUrl}#/lambda/functions/phase-panel-help-function/aliases`);
    const aliasesCard = page.locator(".provisioned-aliases-card");
    await aliasesCard.getByRole("button", { name: "About Aliases" }).hover();
    await expect(aliasesCard.getByRole("tooltip")).toContainText("stable name");
    await expect(aliasesCard.getByRole("tooltip")).toContainText("weighted routing");

    await page.goto(`${consoleUrl}#/lambda/functions/phase-panel-help-function/versions`);
    const versionsCard = page.locator(".provisioned-versions-card");
    await versionsCard.getByRole("button", { name: "About Versions" }).hover();
    await expect(versionsCard.getByRole("tooltip")).toContainText("immutable, numbered snapshot");
    await expect(versionsCard.getByRole("tooltip")).toContainText("StackSim support · Supported locally");

    await page.goto(`${consoleUrl}#/lambda/functions/phase-panel-help-function/configuration`);
    await expect(page.locator(".panel-help-button")).toHaveCount(13);
    const capacityCard = page.locator(".function-capacity-provider-card");
    expect(await capacityCard.evaluate(element => getComputedStyle(element).overflow)).toBe("visible");
    await capacityCard.getByRole("button", { name: "About Capacity provider" }).hover();
    await expect(capacityCard.getByRole("tooltip")).toContainText("StackSim does not create EC2 instances");

    const monitoringCard = page.locator(".monitoring-tools-card");
    await monitoringCard.getByRole("button", { name: "About Monitoring and operations tools" }).focus();
    await expect(monitoringCard.getByRole("tooltip")).toContainText("StackSim support · Partial");
    await expect(monitoringCard.getByRole("tooltip")).toContainText("does not emit trace segments");

    await page.setViewportSize({ width: 390, height: 844 });
    await capacityCard.getByRole("button", { name: "About Capacity provider" }).hover();
    const tooltipBox = await capacityCard.getByRole("tooltip").boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
  });

  test("LAM-10 creates and configures a digest-pinned local container image function", async ({ page }) => {
    const imageUri = "000000000000.dkr.ecr.eu-west-1.amazonaws.com/browser/image:current"; const imageDigest = await writeBrowserImage(join(dataDir, "oci"), imageUri); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/lambda/functions`); await page.getByRole("button", { name: "Create function" }).first().click(); let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Package type").selectOption("Image"); await expect(dialog.getByText("Local image source enabled", { exact: true })).toBeVisible(); await dialog.getByLabel("Function name").fill("phase-image-function"); await dialog.getByLabel("Container image URI").fill(imageUri); await dialog.getByLabel("Entry point").fill("/lambda-entrypoint.sh"); await dialog.getByLabel("Command").fill("browser.handler"); await dialog.getByLabel("Working directory").fill("/var/task"); await dialog.getByLabel("Execution role choice").selectOption("existing"); await fillArnCombobox(dialog.getByLabel("Existing role"), "arn:aws:iam::000000000000:role/phase-browser-role"); await dialog.getByRole("button", { name: "Create function", exact: true }).click();
      await expect(page).toHaveURL(/#\/lambda\/functions\/phase-image-function$/); const card = page.locator(".image-code-card"); await expect(card.getByRole("heading", { name: "Container image" })).toBeVisible(); await expect(card.getByText(imageUri, { exact: true })).toBeVisible(); await expect(card.getByText(`000000000000.dkr.ecr.eu-west-1.amazonaws.com/browser/image@${imageDigest}`, { exact: true })).toBeVisible(); await expect(card.getByText("oci", { exact: true })).toBeVisible(); await expect(page.getByText("Explicit local dependency boundary", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Configuration", exact: true }).click(); const configCard = page.locator(".image-config-card"); await expect(configCard.getByRole("heading", { name: "Container image configuration" })).toBeVisible(); await expect(page.locator(".layers-card")).toHaveCount(0); await expect(page.locator(".code-signing-card")).toHaveCount(0); await configCard.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Command").fill("updated.handler"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(configCard.getByText("updated.handler", { exact: true })).toBeVisible();
      const configured = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "phase-image-function" })); expect(configured.PackageType).toBe("Image"); expect(configured.Runtime).toBeUndefined(); expect(configured.Handler).toBeUndefined(); expect(configured.ImageConfigResponse?.ImageConfig?.Command).toEqual(["updated.handler"]); expect((await lambda.send(new GetFunctionCommand({ FunctionName: "phase-image-function" }))).Code?.ResolvedImageUri).toBe(`000000000000.dkr.ecr.eu-west-1.amazonaws.com/browser/image@${imageDigest}`);
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByText("Local executor required", { exact: true })).toBeVisible(); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("LAM-10 manages a capacity provider and an attached managed function", async ({ page }) => {
    const lambda = new LambdaClient(sdkOptions(simulator)); const providerName = "phase-browser-managed"; const functionName = "phase-managed-function";
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/lambda/capacity-providers`); await expect(page.getByRole("heading", { name: "No capacity providers" })).toBeVisible(); await page.getByRole("button", { name: "Create capacity provider" }).first().click(); let dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Control plane only", { exact: true })).toBeVisible(); await dialog.getByLabel("Capacity provider name").fill(providerName); await expect(dialog.getByLabel("Capacity provider operator role")).toHaveValue("arn:aws:iam::000000000000:role/test"); await dialog.getByLabel("Provider tags (JSON object)").fill('{"team":"browser"}'); await dialog.getByLabel("Propagated tags (JSON object)").fill('{"workload":"managed"}'); await dialog.getByRole("button", { name: "Create capacity provider", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#\\/lambda\\/capacity-providers\\/${providerName}$`)); await expect(page.getByRole("heading", { name: providerName })).toBeVisible(); await expect(page.getByText("Control plane only — no managed infrastructure", { exact: true })).toBeVisible(); await expect.poll(async () => (await lambda.send(new GetCapacityProviderCommand({ CapacityProviderName: providerName }))).CapacityProvider?.State).toBe("Active"); await page.reload(); await expect(page.locator(".capacity-provider-overview-card").getByText("Active", { exact: true })).toBeVisible(); await expect(page.locator(".capacity-provider-network-card")).toContainText('"team":"browser"');

      await page.goto(`${consoleUrl}#/lambda/capacity-providers`); await page.getByPlaceholder("Find capacity providers").fill("browser-managed"); await expect(page.getByRole("link", { name: providerName })).toBeVisible(); await page.goto(`${consoleUrl}#/lambda/functions`); await page.getByRole("button", { name: "Create function" }).first().click(); dialog = page.getByRole("dialog");
      await dialog.getByLabel("Function name").fill(functionName); await dialog.getByLabel("Handler").fill("handler.echoHandler"); await dialog.getByLabel("Upload .zip").check(); await dialog.getByLabel("Deployment package").setInputFiles(join(process.cwd(), "examples/lambda/function.zip")); await dialog.getByLabel("Execution role choice").selectOption("existing"); await fillArnCombobox(dialog.getByLabel("Existing role"), "arn:aws:iam::000000000000:role/phase-browser-role"); await dialog.getByLabel("Capacity provider").selectOption({ label: providerName }); await expect(dialog.getByText("Managed-instance control plane only", { exact: true })).toBeVisible(); await dialog.getByLabel("Memory GiB per vCPU").fill("6"); await dialog.getByLabel("Maximum concurrency per environment").fill("120"); await dialog.getByRole("button", { name: "Create function", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#\\/lambda\\/functions\\/${functionName}$`)); const configured = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName })); expect(configured.CapacityProviderConfig?.LambdaManagedInstancesCapacityProviderConfig).toMatchObject({ ExecutionEnvironmentMemoryGiBPerVCpu: 6, PerExecutionEnvironmentMaxConcurrency: 120 }); await lambda.send(new PutFunctionScalingConfigCommand({ FunctionName: functionName, Qualifier: "$LATEST.PUBLISHED", FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 5 } }));

      await page.getByRole("link", { name: "Configuration", exact: true }).click(); const capacityCard = page.locator(".function-capacity-provider-card"); await expect(capacityCard.getByRole("heading", { name: "Capacity provider" })).toBeVisible(); await expect(capacityCard.getByRole("link", { name: providerName })).toBeVisible(); await expect(capacityCard.getByText("Publish before invocation", { exact: true })).toBeVisible(); await expect(capacityCard.getByText("1", { exact: true })).toBeVisible(); await capacityCard.getByRole("button", { name: "Configure scaling" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Minimum execution environments").fill("2"); await dialog.getByLabel("Maximum execution environments").fill("7"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(capacityCard.getByText("7", { exact: true })).toBeVisible(); const scaling = await lambda.send(new GetFunctionScalingConfigCommand({ FunctionName: functionName, Qualifier: "$LATEST.PUBLISHED" })); expect(scaling.RequestedFunctionScalingConfig).toEqual({ MinExecutionEnvironments: 2, MaxExecutionEnvironments: 7 }); expect(scaling.AppliedFunctionScalingConfig).toEqual(scaling.RequestedFunctionScalingConfig);

      await capacityCard.getByRole("link", { name: providerName }).click(); const attached = page.locator(".capacity-provider-functions-card"); await expect(attached.getByText(new RegExp(`${functionName}:\\$LATEST\\.PUBLISHED$`))).toBeVisible(); await expect(attached.getByText(new RegExp(`${functionName}:\\$LATEST$`))).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("heading", { name: "Attached function versions" })).toBeVisible(); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("LAM-10 creates, inspects, filters, and stops a durable execution", async ({ page }) => {
    const lambda = new LambdaClient(sdkOptions(simulator)); const functionName = "phase-durable-function";
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/lambda/functions`); await page.getByRole("button", { name: "Create function" }).first().click(); let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Function name").fill(functionName); await dialog.getByLabel("Handler").fill("handler.durableCallbackHandler"); await dialog.getByLabel("Upload .zip").check(); await dialog.getByLabel("Deployment package").setInputFiles(join(process.cwd(), "examples/lambda/function.zip")); await dialog.getByLabel("Execution role choice").selectOption("basic"); await dialog.getByLabel("Enable durable execution").check(); await expect(dialog.getByText("Local durable replay", { exact: true })).toBeVisible(); await dialog.getByLabel("Execution timeout seconds").fill("7200"); await dialog.getByLabel("Retention period days").fill("9"); await dialog.getByRole("button", { name: "Create function", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#\/lambda\/functions\/${functionName}$`)); await expect(page.getByText("Durable execution", { exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: "Durable executions", exact: true })).toBeVisible(); await expect.poll(async () => (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }))).State).toBe("Active"); const configured = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName })); expect(configured.DurableConfig).toEqual({ ExecutionTimeout: 7200, RetentionPeriodInDays: 9 });

      await page.getByRole("link", { name: "Test", exact: true }).click(); await page.locator("#lambda-invocation-type").selectOption("Event"); await page.getByLabel("Durable qualifier").fill("$LATEST"); await page.getByLabel("Durable execution name").fill("console-running"); await page.locator("#lambda-event").fill('{"timeoutSeconds":300,"heartbeatSeconds":30}'); await page.locator("#save-test").click(); await page.locator("#run-test").click(); const result = page.locator("#lambda-result"); await expect(result.getByText("Queued", { exact: true })).toBeVisible(); await expect(result.getByText(/durable-execution\/console-running\//)).toBeVisible();

      await page.getByRole("link", { name: "Durable executions", exact: true }).click(); const catalog = page.locator(".durable-executions-card"); await expect(catalog.getByRole("heading", { name: "Durable executions (1)" })).toBeVisible(); await catalog.getByLabel("Durable execution status").selectOption("RUNNING"); await catalog.getByRole("button", { name: "Apply filters" }).click(); const row = catalog.locator("tbody tr").filter({ hasText: "console-running" }); await expect(row.getByText("RUNNING", { exact: true })).toBeVisible(); const executionLink = row.getByRole("link", { name: "console-running" }); const executionArn = decodeURIComponent((await executionLink.getAttribute("href"))!.split("/").at(-1)!); await expect.poll(async () => (await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: executionArn }))).Events?.some(event => event.EventType === "CallbackStarted"), { message: "durable callback should start before opening its static history view", timeout: 15_000 }).toBe(true); await executionLink.click();
      await expect(page.getByRole("heading", { name: "console-running" })).toBeVisible(); await expect(page.locator(".durable-execution-overview").getByText("RUNNING", { exact: true })).toBeVisible(); await expect(page.locator(".durable-history-card").getByText("ExecutionStarted", { exact: true })).toBeVisible(); await expect(page.locator(".durable-history-card").getByText("CallbackStarted", { exact: true })).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("button", { name: "Stop execution" })).toBeVisible(); await page.getByRole("button", { name: "Stop execution" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("This execution cannot resume", { exact: true })).toBeVisible(); await dialog.getByRole("button", { name: "Stop execution", exact: true }).click(); await expect(page.locator(".durable-execution-overview").getByText("STOPPED", { exact: true })).toBeVisible(); expect((await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: executionArn }))).Status).toBe("STOPPED");

      await page.goto(`${consoleUrl}#/lambda/functions/${functionName}/configuration`); const durableCard = page.locator(".durable-configuration-card"); await expect(durableCard.getByText("9 days", { exact: true })).toBeVisible(); await durableCard.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("Durable KMS key ARN")).toBeDisabled(); await dialog.getByLabel("Retention period days").fill("10"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(durableCard.getByText("10 days", { exact: true })).toBeVisible(); expect((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }))).DurableConfig?.RetentionPeriodInDays).toBe(10); expect(errors).toEqual([]);
    } finally { lambda.destroy(); }
  });

  test("CW-04 explores an empty metric catalog, filters and graphs metrics, and exposes source queries", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const dynamodb = new DynamoDBClient(sdkOptions(simulator)); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/cloudwatch/metrics`); await expect(page.getByRole("heading", { name: "No metrics" })).toBeVisible();
      await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Browser/App", MetricData: [
        { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/browser" }], Unit: "Milliseconds", Value: 12 },
        { MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/browser" }], Unit: "Count", Value: 1 },
      ] }));
      await page.reload(); await expect(page.getByRole("heading", { name: "Metric explorer" })).toBeVisible(); await page.getByLabel("Namespace").selectOption("Browser/App"); await page.getByLabel("Search metrics").fill("latency"); await expect(page.getByRole("cell", { name: "Latency", exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: "Requests", exact: true })).not.toBeVisible();
      await page.getByLabel(/Graph Latency/).check(); await expect(page.locator(".metric-legend").getByText("Latency · Route=/browser", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Source" }).click(); await expect(page.locator("#metric-source")).toContainText("MetricDataQueries"); await page.getByRole("button", { name: "Graph", exact: true }).click(); await page.getByLabel("Y axis", { exact: true }).selectOption("Right"); await expect(page.locator("#metric-graph")).toHaveAttribute("data-axis", "Right"); await page.getByRole("button", { name: "Add to dashboard" }).click(); let dashboardDialog = page.getByRole("dialog"); await dashboardDialog.getByLabel("New dashboard name").fill("browser_metric_selection"); await dashboardDialog.getByRole("button", { name: "Add to dashboard", exact: true }).click(); await expect(page.locator("#toast-region")).toContainText("Metrics added to browser_metric_selection"); await cloudwatch.send(new DeleteDashboardsCommand({ DashboardNames: ["browser_metric_selection"] }));

      await createFunction(simulator, "phase-metric-function", "handler.echoHandler"); await lambda.send(new InvokeCommand({ FunctionName: "phase-metric-function", Payload: Buffer.from("{}") })); await page.goto(`${consoleUrl}#/lambda/functions/phase-metric-function/monitor`); await expect(page.getByRole("heading", { name: "Function metrics" })).toBeVisible(); await expect(page.getByText("Invocations", { exact: true })).toBeVisible(); expect(errors).toEqual([]);
      await dynamodb.send(new CreateTableCommand({ TableName: "PhaseMetricTable", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "PhaseMetricTable"); await dynamodb.send(new PutItemCommand({ TableName: "PhaseMetricTable", Item: { id: { S: "browser" } } })); await page.goto(`${consoleUrl}#/dynamodb/tables/PhaseMetricTable/monitor`); await expect(page.getByRole("heading", { name: "Table metrics" })).toBeVisible(); await expect(page.getByLabel("PhaseMetricTable DynamoDB").getByText("Consumed write capacity", { exact: true })).toBeVisible(); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); dynamodb.destroy(); lambda.destroy(); }
  });

  test("CW-02 deep-links service logs and resolves Lambda and API Gateway related resources", async ({ page }) => {
    const lambda = new LambdaClient(sdkOptions(simulator)); const gateway = new APIGatewayClient(sdkOptions(simulator)); const logsClient = new CloudWatchLogsClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); await createFunction(simulator, "phase-cw02-function", "handler.echoHandler"); await lambda.send(new InvokeCommand({ FunctionName: "phase-cw02-function", Payload: Buffer.from("{}") }));
      await page.goto(`${consoleUrl}#/lambda/functions/phase-cw02-function/monitor`); const latestLink = page.getByRole("link", { name: "View latest stream in CloudWatch Logs" }); await expect(latestLink).toBeVisible(); const latestHref = await latestLink.getAttribute("href"); expect(latestHref).toContain(`/streams/`); await latestLink.click(); await expect(page.getByRole("heading", { name: "Log events" })).toBeVisible(); await expect(page.getByText("START RequestId:", { exact: false })).toBeVisible();
      await page.goto(`${consoleUrl}#/cloudwatch/log-groups/${encodeURIComponent("/aws/lambda/phase-cw02-function")}`); const lambdaRelated = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Related resources (1)" }) }); await expect(lambdaRelated.getByRole("link", { name: "phase-cw02-function" })).toBeVisible();

      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-cw02-api" })); const resource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(item => item.path === "/")!; await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", authorizationType: "NONE" })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": '{"statusCode":200}' } })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); await gateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "replace", path: "/*/*/logging/loglevel", value: "INFO" }] })); const executionGroup = `API-Gateway-Execution-Logs_${api.id}/dev`; await logsClient.send(new CreateLogGroupCommand({ logGroupName: executionGroup }));
      await page.goto(`${consoleUrl}#/cloudwatch/log-groups/${encodeURIComponent(executionGroup)}`); const apiRelated = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Related resources (1)" }) }); await expect(apiRelated.getByRole("link", { name: "phase-cw02-api · dev" })).toBeVisible(); await apiRelated.getByRole("link", { name: "phase-cw02-api · dev" }).click(); await expect(page.getByRole("heading", { name: "Stages" })).toBeVisible(); await page.getByRole("button", { name: "Logs / tracing" }).click(); const executionLink = page.getByRole("link", { name: "View execution logs" }); await expect(executionLink).toBeVisible(); expect(await executionLink.getAttribute("href")).toContain(encodeURIComponent(executionGroup)); await page.setViewportSize({ width: 390, height: 844 }); await expect(executionLink).toBeVisible(); expect(errors).toEqual([]);
    } finally { lambda.destroy(); gateway.destroy(); logsClient.destroy(); }
  });

  test("CW-03 runs Logs Insights queries, visualizes aggregates, opens records, and manages saved queries", async ({ page }) => {
    const logsClient = new CloudWatchLogsClient(sdkOptions(simulator)); const group = "/browser/insights";
    try {
      const errors = browserErrors(page); const now = Date.now(); await logsClient.send(new CreateLogGroupCommand({ logGroupName: group })); await logsClient.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); await logsClient.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "application", logEvents: [
        { timestamp: now, message: "status=error duration=40 service=orders" },
        { timestamp: now + 1, message: "status=ok duration=10 service=orders" },
        { timestamp: now + 2, message: "status=error duration=20 service=billing" },
      ] }));
      await page.goto(`${consoleUrl}#/cloudwatch/logs-insights`); await expect(page.getByRole("heading", { name: "Logs Insights" })).toBeVisible(); await expect(page.getByLabel("Log groups")).toContainText(group); await page.getByLabel("Sample query").selectOption("aggregate"); await page.getByRole("button", { name: "Run query" }).click(); await expect(page.locator("#insights-status").getByText("Complete", { exact: true })).toBeVisible({ timeout: 5000 }); await expect(page.getByText("Visualization · requests", { exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: "orders", exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: "billing", exact: true })).toBeVisible();

      await page.getByLabel("Chart type").selectOption("pie"); await expect(page.getByRole("img", { name: "pie visualization of requests" }).locator("path")).toHaveCount(2); await page.getByLabel("Chart type").selectOption("bar"); await expect(page.getByRole("img", { name: "bar visualization of requests" }).locator(".insights-bar-row")).toHaveCount(2); const csv = page.waitForEvent("download"); await page.getByRole("button", { name: "Export CSV" }).click(); const csvStream = await (await csv).createReadStream(); let csvText = ""; for await (const chunk of csvStream) csvText += chunk.toString(); expect(csvText).toContain('"service","requests","average","maximum"'); expect(csvText).toContain('"orders"'); await page.locator("#insights-editor").fill("parse @message 'status=* duration=* service=*' as status, duration, service | stats sum(duration) as requests by bin(1ms)"); await page.getByRole("button", { name: "Run query" }).click(); await expect(page.locator("#insights-status").getByText("Complete", { exact: true })).toBeVisible({ timeout: 5000 }); await expect(page.getByLabel("Chart type").locator('option[value="line"]')).toBeEnabled(); await page.getByLabel("Chart type").selectOption("line"); await expect(page.getByRole("img", { name: "line visualization of requests" }).locator("polyline")).toBeVisible(); await page.getByLabel("Chart type").selectOption("area"); await expect(page.getByRole("img", { name: "area visualization of requests" }).locator("polygon")).toBeVisible(); await page.getByLabel("Chart type").selectOption("stacked-area"); await expect(page.getByRole("img", { name: "stacked area visualization of requests" }).locator("polygon")).toBeVisible();

      await page.getByLabel("Sample query").selectOption("recent"); await page.getByRole("button", { name: "Run query" }).click(); await expect(page.locator("#insights-status").getByText("Complete", { exact: true })).toBeVisible({ timeout: 5000 }); await page.getByRole("button", { name: "View record" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Log record" })).toBeVisible(); await expect(dialog.getByText("@logStream", { exact: true })).toBeVisible(); await dialog.locator("#modal-submit").click();

      await page.getByRole("button", { name: "Save query" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("Browser/Recent events"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("cell", { name: "Browser/Recent events", exact: true })).toBeVisible(); expect((await logsClient.send(new DescribeQueryDefinitionsCommand({ queryDefinitionNamePrefix: "Browser/" }))).queryDefinitions?.length).toBe(1);
      await page.locator("#insights-editor").fill("filter service = {{service}} | fields @message"); await page.getByRole("button", { name: "Save with parameters" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("Browser/Parameterized"); await dialog.getByLabel("Parameters (JSON array)").fill('[{"name":"service","defaultValue":"orders","description":"Service name"}]'); await dialog.getByRole("button", { name: "Save", exact: true }).click(); const parameterRow = page.locator("#insights-saved tbody tr").filter({ hasText: "Browser/Parameterized" }); await expect(parameterRow).toBeVisible(); await parameterRow.getByRole("button", { name: "Add to favorites" }).click(); await expect(parameterRow.getByRole("button", { name: "Remove from favorites" })).toBeVisible(); await parameterRow.getByRole("button", { name: "Load" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("service").fill("orders' | limit 1"); await dialog.getByRole("button", { name: "Load query" }).click(); await expect(page.locator("#insights-editor")).toHaveValue('filter service = "orders\' | limit 1" | fields @message');
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("button", { name: "Run query" })).toBeVisible(); await expect(page.getByRole("heading", { name: "Saved queries" })).toBeVisible(); expect(errors).toEqual([]);
    } finally { logsClient.destroy(); }
  });

  test("CW-05 creates, filters, tests, edits, and deletes a metric alarm with history and action warnings", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/cloudwatch/alarms`); await expect(page.getByRole("heading", { name: "No alarms" })).toBeVisible();
      await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Browser/Alarms", MetricData: [{ MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/browser" }], Value: 18 }] })); await page.getByRole("button", { name: "Create alarm" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Select metric" })).toBeVisible(); await dialog.getByLabel(/Latency.*Browser\/Alarms/).check(); await dialog.getByRole("button", { name: "Next" }).click(); await expect(dialog.getByRole("heading", { name: "Specify metric and conditions" })).toBeVisible(); await dialog.getByLabel("Threshold value").fill("10"); await dialog.getByLabel("Datapoints to alarm").fill("1"); await dialog.getByLabel("Evaluation periods").fill("1"); await dialog.getByRole("button", { name: "Next" }).click(); await expect(dialog.getByRole("heading", { name: "Configure actions and name" })).toBeVisible(); await expect(dialog.getByRole("img", { name: "Alarm metric preview" })).toBeVisible(); await dialog.getByLabel("Action ARN (optional)").fill("arn:aws:sns:eu-west-1:000000000000:browser-alerts"); await expect(dialog.getByText("Action dependency warning")).toBeVisible(); await dialog.getByLabel("Alarm name").fill("browser-high-latency"); await dialog.getByLabel("Description").fill("Browser-created static threshold alarm"); await dialog.getByRole("button", { name: "Create alarm" }).click();
      await expect(page.getByRole("heading", { name: "browser-high-latency" })).toBeVisible(); await expect(page.getByText("INSUFFICIENT_DATA", { exact: true }).first()).toBeVisible(); await page.getByRole("button", { name: "Set state" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("State").selectOption("ALARM"); await dialog.getByLabel("Reason").fill("Browser transition test"); await dialog.getByRole("button", { name: "Set state" }).click(); await expect(page.getByText("ALARM", { exact: true }).first()).toBeVisible(); await expect(page.getByRole("cell", { name: /Alarm updated from/ })).toBeVisible();
      await page.getByRole("button", { name: "Disable actions" }).click(); await expect(page.getByRole("button", { name: "Enable actions" })).toBeVisible(); await page.getByRole("button", { name: "Edit", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Threshold").fill("15"); await dialog.getByRole("button", { name: "Save changes" }).click(); await expect(page.getByText("15", { exact: true }).first()).toBeVisible(); expect((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["browser-high-latency"] }))).MetricAlarms?.[0].Threshold).toBe(15);
      await page.getByRole("button", { name: "Manage" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Tags (JSON object)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.getByRole("cell", { name: "team" })).toBeVisible(); await page.goto(`${consoleUrl}#/cloudwatch/alarms`); await page.getByPlaceholder("Find alarms by name or metric").fill("high-latency"); await expect(page.getByRole("link", { name: "browser-high-latency" })).toBeVisible(); await page.getByLabel("Filter alarm state").selectOption("OK"); await expect(page.getByRole("link", { name: "browser-high-latency" })).not.toBeVisible(); await page.getByLabel("Filter alarm state").selectOption("ALARM"); await page.getByRole("link", { name: "browser-high-latency" }).click(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-high-latency"); await expect(page.getByRole("heading", { name: "No alarms" })).toBeVisible(); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); }
  });

  test("CW-06 renders cross-source dashboards, guards unsaved edits, saves layout changes, and deletes from the catalog", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const logsClient = new CloudWatchLogsClient(sdkOptions(simulator)); const dashboardName = "browser_observability"; const group = "/browser/dashboard"; const now = Date.now();
    try {
      const errors = browserErrors(page); await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Browser/Dashboard", MetricData: [
        { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/browser" }], Timestamp: new Date(now - 60_000), Value: 12 },
        { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/browser" }], Timestamp: new Date(now), Value: 18 },
      ] }));
      await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "browser-dashboard-alarm", Namespace: "Browser/Dashboard", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/browser" }], Period: 60, Statistic: "Average", EvaluationPeriods: 1, Threshold: 15, ComparisonOperator: "GreaterThanThreshold" }));
      await logsClient.send(new CreateLogGroupCommand({ logGroupName: group })); await logsClient.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); await logsClient.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "application", logEvents: [{ timestamp: now, message: "dashboard event status=error service=orders" }] }));
      const body = { start: "-PT3H", periodOverride: "inherit", variables: [{ type: "property", property: "Route", inputType: "select", id: "route", label: "Route", defaultValue: "/browser", values: [{ value: "/browser", label: "Browser" }, { value: "/other", label: "Other" }] }], widgets: [
        { type: "text", x: 0, y: 0, width: 24, height: 2, properties: { markdown: "# Browser operations\nCross-source local telemetry" } },
        { type: "metric", x: 0, y: 2, width: 12, height: 6, properties: { title: "Latency trend", region: "eu-west-1", view: "timeSeries", period: 60, stat: "Average", metrics: [["Browser/Dashboard", "Latency", "Route", "/browser", { id: "latency_raw", visible: false }], [{ expression: "latency_raw * 1", id: "latency", label: "Browser latency" }]], localHint: "preserved" } },
        { type: "metric", x: 12, y: 2, width: 12, height: 6, properties: { title: "Latest latency", region: "eu-west-1", view: "singleValue", period: 60, metrics: [["Browser/Dashboard", "Latency", "Route", "/browser", { label: "Latest" }]] } },
        { type: "log", x: 0, y: 8, width: 12, height: 6, properties: { title: "Recent dashboard logs", region: "eu-west-1", query: `SOURCE '${group}' | fields @timestamp, @message | sort @timestamp desc | limit 20` } },
        { type: "alarm", x: 12, y: 8, width: 12, height: 6, properties: { title: "Dashboard alarms", alarms: ["arn:aws:cloudwatch:eu-west-1:000000000000:alarm:browser-dashboard-alarm"] } },
      ] };
      await cloudwatch.send(new PutDashboardCommand({ DashboardName: dashboardName, DashboardBody: JSON.stringify(body) })); await page.goto(`${consoleUrl}#/cloudwatch/dashboards`); await expect(page.getByRole("link", { name: dashboardName })).toBeVisible(); await page.getByRole("link", { name: dashboardName }).click();
      await expect(page.getByRole("heading", { name: "Browser operations" })).toBeVisible(); await expect(page.locator(".metric-legend").getByText("Browser latency", { exact: true })).toBeVisible(); await expect(page.locator(".dashboard-numbers").getByText("Latest", { exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: /dashboard event status=error/ })).toBeVisible({ timeout: 5000 }); await expect(page.getByText("browser-dashboard-alarm", { exact: true })).toBeVisible(); await expect(page.getByText(/Property localHint is preserved/)).toBeVisible();
      await page.getByLabel("Route").selectOption("/other"); await expect(page.getByText("No metric data in this time range").first()).toBeVisible(); await page.getByLabel("Route").selectOption("/browser"); await expect(page.locator(".metric-legend").getByText("Browser latency", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Edit", exact: true }).click(); await page.getByRole("button", { name: "Move widget right" }).nth(1).click(); await page.getByRole("button", { name: "Make widget narrower" }).first().click(); await page.getByRole("button", { name: "Add widget" }).first().click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Widget type").selectOption("text"); await dialog.getByLabel("Markdown").fill("## Runbook\nInvestigate local failures."); await dialog.getByRole("button", { name: "Add widget", exact: true }).click(); await expect(page.getByRole("heading", { name: "Runbook" })).toBeVisible();
      await page.getByLabel("Breadcrumbs").getByRole("link", { name: "Dashboards", exact: true }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await page.getByRole("button", { name: "Save dashboard" }).click(); await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible(); const saved = JSON.parse((await cloudwatch.send(new GetDashboardCommand({ DashboardName: dashboardName }))).DashboardBody!); expect(saved.widgets).toHaveLength(6); expect(saved.widgets[0].width).toBe(23); expect(saved.widgets[1].x).toBe(1);
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("heading", { name: "Recent dashboard logs" })).toBeVisible(); await page.goto(`${consoleUrl}#/cloudwatch/dashboards`); await page.getByLabel(`Select ${dashboardName}`).check(); await page.getByRole("button", { name: "Delete", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByRole("link", { name: dashboardName })).toHaveCount(0);
      await page.getByRole("button", { name: "Create dashboard" }).first().click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Dashboard name").fill("browser_empty_dashboard"); await dialog.getByRole("button", { name: "Create dashboard" }).click(); await expect(page.getByRole("heading", { name: "browser_empty_dashboard" })).toBeVisible(); expect(JSON.parse((await cloudwatch.send(new GetDashboardCommand({ DashboardName: "browser_empty_dashboard" }))).DashboardBody!).widgets).toEqual([]); await cloudwatch.send(new DeleteDashboardsCommand({ DashboardNames: ["browser_empty_dashboard"] })); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); logsClient.destroy(); }
  });

  test("CW-07 manages metric filters, Lambda subscriptions, phase-boundary placeholders, and local exports from a log group", async ({ page }) => {
    const logsClient = new CloudWatchLogsClient(sdkOptions(simulator)); const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const lambda = new LambdaClient(sdkOptions(simulator)); const groupName = "/browser/cw07-delivery"; const groupArn = `arn:aws:logs:eu-west-1:000000000000:log-group:${groupName}`;
    try {
      const errors = browserErrors(page); await logsClient.send(new CreateLogGroupCommand({ logGroupName: groupName })); await logsClient.send(new CreateLogStreamCommand({ logGroupName: groupName, logStreamName: "application" })); await logsClient.send(new PutLogEventsCommand({ logGroupName: groupName, logStreamName: "application", logEvents: [{ timestamp: Date.now(), message: '{"level":"info","route":"/ready","value":1}' }] })); const fn = await createFunction(simulator, "browser-cw07-subscriber", "handler.asyncDestinationHandler"); await lambda.send(new AddPermissionCommand({ FunctionName: "browser-cw07-subscriber", StatementId: "cw07-browser-logs", Action: "lambda:InvokeFunction", Principal: "logs.eu-west-1.amazonaws.com", SourceArn: `${groupArn}:*`, SourceAccount: "000000000000" }));
      await page.goto(`${consoleUrl}#/cloudwatch/log-groups/${encodeURIComponent(groupName)}/metric-filters`); await expect(page.getByRole("heading", { name: /Metric filters/ })).toBeVisible(); await page.getByRole("button", { name: "Create metric filter" }).first().click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Filter name").fill("browser-errors"); await dialog.getByLabel("Filter pattern").fill('{ $.level = "error" }'); await dialog.getByLabel("Sample log event (optional)").fill('{"level":"error","route":"/orders","value":4}'); await dialog.getByLabel("Metric namespace").fill("Browser/Logs"); await dialog.getByLabel("Metric name", { exact: true }).fill("ErrorValue"); await dialog.getByLabel("Metric value").fill("$.value"); await dialog.getByLabel("Dimensions (JSON object)").fill('{"Route":"$.route"}'); await dialog.getByRole("button", { name: "Create metric filter" }).click(); await expect(page.getByRole("button", { name: "browser-errors" })).toBeVisible(); assert.equal((await logsClient.send(new DescribeMetricFiltersCommand({ logGroupName: groupName }))).metricFilters?.[0].metricTransformations?.[0].metricNamespace, "Browser/Logs");
      await logsClient.send(new PutLogEventsCommand({ logGroupName: groupName, logStreamName: "application", logEvents: [{ timestamp: Date.now(), message: '{"level":"error","route":"/orders","value":4}' }] })); const metric = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Browser/Logs", MetricName: "ErrorValue", Dimensions: [{ Name: "Route", Value: "/orders" }], StartTime: new Date(Date.now() - 60_000), EndTime: new Date(Date.now() + 60_000), Period: 60, Statistics: ["Sum"] })); assert.equal(metric.Datapoints?.[0].Sum, 4);
      await page.getByRole("link", { name: "Subscription filters" }).click(); await page.getByRole("button", { name: "Create subscription filter" }).first().click(); dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("Destination type")).toContainText("Kinesis stream — unavailable locally"); await dialog.getByLabel("Filter name").fill("browser-lambda-errors"); await dialog.getByLabel("Filter pattern").fill('{ $.level = "error" }'); await fillArnCombobox(dialog.getByLabel("Lambda function"), fn.FunctionArn!); await dialog.getByRole("button", { name: "Start streaming" }).click(); await expect(page.getByRole("button", { name: "browser-lambda-errors" })).toBeVisible(); assert.equal((await logsClient.send(new DescribeSubscriptionFiltersCommand({ logGroupName: groupName }))).subscriptionFilters?.[0].destinationArn, fn.FunctionArn);
      await page.getByRole("link", { name: "Data protection" }).click(); await expect(page.getByRole("heading", { name: "No data protection policy" })).toBeVisible(); await page.getByRole("link", { name: "Transform" }).click(); await expect(page.getByRole("heading", { name: "No transformer" })).toBeVisible();
      await page.getByRole("link", { name: "Export data" }).click(); await page.getByRole("button", { name: "Export data" }).first().click(); dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("Destination type")).toContainText("S3 — unavailable locally"); await dialog.getByLabel("Destination URL").fill(pathToFileURL(join(dataDir, "cw07-export")).href); await dialog.getByLabel("Destination prefix").fill("browser"); await dialog.getByLabel("Task name (optional)").fill("browser-export"); await dialog.getByRole("button", { name: "Start export" }).click(); await expect(page.getByText("browser-export", { exact: true })).toBeVisible(); await expect.poll(async () => (await logsClient.send(new DescribeExportTasksCommand({}))).exportTasks?.find(task => task.taskName === "browser-export")?.status?.code).toBe("COMPLETED");
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("link", { name: "Metric filters" })).toBeVisible(); await page.getByRole("link", { name: "Metric filters" }).click(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-errors"); await expect(page.getByRole("button", { name: "browser-errors" })).toHaveCount(0); await page.getByRole("link", { name: "Subscription filters" }).click(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-lambda-errors"); await expect(page.getByRole("button", { name: "browser-lambda-errors" })).toHaveCount(0); expect(errors).toEqual([]);
    } finally { logsClient.destroy(); cloudwatch.destroy(); lambda.destroy(); }
  });

  test("CW-08A creates, evaluates, edits, filters, and deletes composite alarms with suppression context", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "browser-dashboard-alarm", Namespace: "Browser/Composite", MetricName: "ServiceHealth", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold" })); await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "browser-maintenance", Namespace: "Browser/Composite", MetricName: "Maintenance", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold" })); await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "browser-dashboard-alarm", StateValue: "ALARM", StateReason: "Browser composite child alarm" })); await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "browser-maintenance", StateValue: "OK", StateReason: "Maintenance is inactive" }));
      await page.goto(`${consoleUrl}#/cloudwatch/alarms`); await expect(page.getByRole("columnheader", { name: "Type" })).toBeVisible(); await page.getByRole("button", { name: "Create composite alarm" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Combine alarm states" })).toBeVisible(); const child = dialog.getByLabel(/browser-dashboard-alarm.*Metric alarm/); if (!(await child.isChecked())) await child.check(); await dialog.getByLabel("Alarm rule").fill('ALARM("browser-dashboard-alarm")'); await dialog.getByLabel("Suppressor alarm (optional)").selectOption("browser-maintenance"); await dialog.getByLabel("Wait period (seconds)").fill("60"); await dialog.getByLabel("Extension period (seconds)").fill("30"); await dialog.getByLabel("Action ARN (optional)").fill("arn:aws:sns:eu-west-1:000000000000:composite-alerts"); await expect(dialog.getByText("Action dependency warning")).toBeVisible(); await dialog.getByLabel("Alarm name").fill("browser-service-unhealthy"); await dialog.getByLabel("Description").fill("Browser-created service-level composite"); await dialog.getByLabel("Tags (JSON object)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Create composite alarm" }).click();
      await expect(page.getByRole("heading", { name: "browser-service-unhealthy" })).toBeVisible(); await expect(page.getByRole("heading", { name: "Alarm rule" })).toBeVisible(); await expect(page.getByText("Wait period", { exact: true }).first()).toBeVisible(); await expect(page.getByRole("heading", { name: /Child alarms \(1\)/ })).toBeVisible(); await expect(page.getByRole("link", { name: "browser-dashboard-alarm" })).toBeVisible(); await expect(page.getByRole("cell", { name: "team" })).toBeVisible(); let described = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["browser-service-unhealthy"] })); expect(described.CompositeAlarms?.[0]).toEqual(expect.objectContaining({ StateValue: "ALARM", ActionsSuppressor: "browser-maintenance", ActionsSuppressorWaitPeriod: 60, ActionsSuppressorExtensionPeriod: 30 }));
      await page.getByRole("button", { name: "Edit", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Alarm rule").fill('ALARM("browser-dashboard-alarm") AND NOT ALARM("browser-maintenance")'); await dialog.getByRole("button", { name: "Save changes" }).click(); await expect(page.getByText(/AND NOT ALARM/)).toBeVisible(); await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "browser-maintenance", StateValue: "ALARM", StateReason: "Maintenance window active" })); await page.getByRole("button", { name: "Refresh" }).click(); await expect(page.getByText("OK", { exact: true }).first()).toBeVisible();
      await page.goto(`${consoleUrl}#/cloudwatch/alarms`); const row = page.locator("tbody tr").filter({ has: page.getByRole("link", { name: "browser-service-unhealthy" }) }); await expect(row).toContainText("Composite"); await page.getByPlaceholder("Find alarms by name or metric").fill("service-unhealthy"); await expect(page.getByRole("link", { name: "browser-service-unhealthy" })).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("link", { name: "browser-service-unhealthy" }).click(); await expect(page.getByRole("heading", { name: "Parent composite alarms" })).toBeVisible(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-service-unhealthy"); await expect(page.getByRole("link", { name: "browser-service-unhealthy" })).toHaveCount(0); described = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["browser-service-unhealthy"] })); expect(described.CompositeAlarms).toEqual([]); await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["browser-maintenance", "browser-dashboard-alarm"] })); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); }
  });

  test("CW-08B configures an anomaly detector and creates an expected-band alarm", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const metric = { Namespace: "Browser/Anomaly", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/orders" }] };
    try {
      const errors = browserErrors(page); const now = Date.now(); await cloudwatch.send(new PutMetricDataCommand({ Namespace: metric.Namespace, MetricData: Array.from({ length: 12 }, (_, index) => ({ MetricName: metric.MetricName, Dimensions: metric.Dimensions, Timestamp: new Date(now - (12 - index) * 60_000), Value: index === 11 ? 80 : 10 })) }));
      await page.goto(`${consoleUrl}#/cloudwatch/anomaly-detection`); await expect(page.getByRole("heading", { name: "No anomaly detectors" })).toBeVisible(); await page.getByRole("button", { name: "Create detector" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("Deterministic local model", { exact: true })).toBeVisible(); await dialog.getByLabel("Existing metric").selectOption({ label: "Browser/Anomaly · Latency · Route=/orders" }); await dialog.getByLabel("Statistic").selectOption("Average"); await dialog.getByLabel("Metric time zone").fill("Europe/London"); await dialog.getByLabel("Expect periodic spikes").check(); await dialog.getByLabel("Excluded time ranges (JSON)").fill("[]"); await dialog.getByRole("button", { name: "Create detector" }).click();
      await expect(page.getByRole("heading", { name: /Browser\/Anomaly · Latency · Average/ })).toBeVisible(); await expect(page.getByText("Model disclosure", { exact: true })).toBeVisible(); await expect(page.getByText("Europe/London", { exact: true })).toBeVisible(); let detectors = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ Namespace: metric.Namespace, MetricName: metric.MetricName })); const detector = detectors.AnomalyDetectors?.[0]; expect(detector).toEqual(expect.objectContaining({ StateValue: "PENDING_TRAINING" })); expect(detector?.MetricCharacteristics?.PeriodicSpikes).toBe(true);
      await page.getByRole("button", { name: "Edit configuration" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Metric time zone").fill("UTC"); await dialog.getByRole("button", { name: "Save configuration" }).click(); await expect(page.getByText("UTC", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Create alarm" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("1 Select metric", { exact: true })).toBeVisible(); await dialog.getByRole("button", { name: "Next" }).click(); await dialog.getByLabel("Band width").fill("1.5"); await dialog.getByLabel("Alarm when value is").selectOption("GreaterThanUpperThreshold"); await dialog.getByRole("button", { name: "Next" }).click(); await expect(dialog.getByRole("heading", { name: "Metric and expected band" })).toBeVisible(); await dialog.getByLabel("Alarm name").fill("browser-unexpected-latency"); await dialog.getByLabel("Description").fill("Browser-created anomaly alarm"); await dialog.getByRole("button", { name: "Create anomaly alarm" }).click();
      await expect(page.getByRole("heading", { name: "browser-unexpected-latency" })).toBeVisible(); await expect(page.getByText("Expected band", { exact: true })).toBeVisible(); await expect(page.getByText("anomaly threshold", { exact: true })).toBeVisible(); const alarm = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["browser-unexpected-latency"] }))).MetricAlarms?.[0]; expect(alarm).toEqual(expect.objectContaining({ ThresholdMetricId: "expected", ComparisonOperator: "GreaterThanUpperThreshold" })); expect(alarm?.Threshold).toBeUndefined();
      await page.goto(`${consoleUrl}#/cloudwatch/alarms`); const row = page.locator("tbody tr").filter({ has: page.getByRole("link", { name: "browser-unexpected-latency" }) }); await expect(row).toContainText("outside expected band"); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("link", { name: "browser-unexpected-latency" }).click(); await expect(page.getByRole("heading", { name: "Alarm details" })).toBeVisible(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-unexpected-latency"); await cloudwatch.send(new DeleteAnomalyDetectorCommand({ AnomalyDetectorId: detector!.AnomalyDetectorId! })); detectors = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ Namespace: metric.Namespace, MetricName: metric.MetricName })); expect(detectors.AnomalyDetectors).toEqual([]); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); }
  });

  test("CW-08C creates a log alarm, shows contributors, and manages an active mute rule", async ({ page }) => {
    test.setTimeout(60_000);
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const logsClient = new CloudWatchLogsClient(sdkOptions(simulator)); const group = "/browser/log-alarms"; const boundary = Math.floor(Date.now() / 60_000) * 60_000;
    try {
      const errors = browserErrors(page); await logsClient.send(new CreateLogGroupCommand({ logGroupName: group })); await logsClient.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); await logsClient.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "application", logEvents: [{ timestamp: boundary - 30_000, message: '{"level":"ERROR","host":"browser-api","requestId":"cw08c"}' }] }));
      await page.goto(`${consoleUrl}#/cloudwatch/alarms`); await page.getByRole("button", { name: "Create log alarm" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("1 Scheduled query", { exact: true })).toBeVisible(); await dialog.getByLabel("Log groups").selectOption(group); await dialog.getByLabel("Logs Insights QL").fill("filter level = 'ERROR' | fields @timestamp, @message, host"); await dialog.getByRole("button", { name: "Next" }).click(); await dialog.getByLabel("Aggregation expression").fill("count(*) as errors by host | sort errors desc"); await dialog.getByLabel("Threshold").fill("0"); await dialog.getByLabel("Missing query results").selectOption("ignore"); await dialog.getByRole("button", { name: "Next" }).click(); await dialog.getByLabel("Action log lines").fill("1"); await dialog.getByLabel("Log-line retrieval role ARN").fill("arn:aws:iam::000000000000:role/browser-log-lines"); await dialog.getByLabel("Alarm action ARN (optional)").fill("arn:aws:sns:eu-west-1:000000000000:browser-log-alerts"); await dialog.getByLabel("Alarm name").fill("browser-errors-by-host"); await dialog.getByLabel("Description").fill("Browser-created contributor log alarm"); await dialog.getByLabel("Alarm tags (JSON object)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Create log alarm" }).click();
      await expect(page.getByRole("heading", { name: "browser-errors-by-host" })).toBeVisible(); await expect(page.getByRole("heading", { name: "Scheduled log query" })).toBeVisible(); await page.getByRole("button", { name: "Mute actions" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Rule name").fill("browser-log-maintenance"); const at = new Date().toISOString().slice(0, 16); await dialog.getByLabel("Schedule expression").fill(`at(${at})`); await dialog.getByLabel("Duration").fill("PT1H"); await expect(dialog.getByLabel("Target alarm names (one per line)")).toHaveValue("browser-errors-by-host"); await dialog.getByLabel("Tags (JSON object)").fill('{"change":"cw08c"}'); await dialog.getByRole("button", { name: "Create mute rule" }).click();
      await expect(page.getByRole("heading", { name: "browser-log-maintenance" })).toBeVisible(); await expect(page.getByText("ACTIVE", { exact: true }).first()).toBeVisible(); await expect(page.getByRole("link", { name: "browser-errors-by-host" })).toBeVisible(); const mute = await cloudwatch.send(new GetAlarmMuteRuleCommand({ AlarmMuteRuleName: "browser-log-maintenance" })); expect(mute).toEqual(expect.objectContaining({ Status: "ACTIVE", MuteType: "ONE_TIME" }));
      await page.getByRole("link", { name: "browser-errors-by-host" }).click(); await simulator.metrics.evaluateAlarmsNow(boundary); await page.getByRole("button", { name: "Refresh" }).first().click(); await expect(page.getByRole("heading", { name: /Contributors in ALARM \(1\)/ })).toBeVisible(); await expect(page.getByText("host=browser-api", { exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: "AlarmContributorAction" })).toBeVisible(); const contributors = await cloudwatch.send(new DescribeAlarmContributorsCommand({ AlarmName: "browser-errors-by-host" })); expect(contributors.AlarmContributors?.[0].ContributorAttributes?.host).toBe("browser-api");
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("heading", { name: "Mute rules" })).toBeVisible(); await page.getByRole("link", { name: "browser-log-maintenance" }).click(); await page.getByRole("button", { name: "Edit", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Duration").fill("PT2H"); await dialog.getByRole("button", { name: "Save changes" }).click(); await expect(page.getByText("PT2H", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-log-maintenance"); await expect(page.getByRole("heading", { name: "Alarm mute rules", exact: true })).toBeVisible();
      await page.goto(`${consoleUrl}#/cloudwatch/alarms/browser-errors-by-host`); await expect(page.getByRole("heading", { name: "browser-errors-by-host" })).toBeVisible(); await page.getByRole("button", { name: "Delete" }).click(); await confirmDeletion(page, "browser-errors-by-host"); expect((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["browser-errors-by-host"], AlarmTypes: ["LogAlarm"] }))).LogAlarms).toEqual([]); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); logsClient.destroy(); }
  });

  test("CW-08D builds and runs grouped Metrics Insights queries and manages the default dataset descriptor", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const now = Date.now(); const dimensions = (host: string) => [{ Name: "Service", Value: "orders" }, { Name: "Host", Value: host }];
    try {
      const errors = browserErrors(page); await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Browser/Insights", MetricData: [
        { MetricName: "Requests", Dimensions: dimensions("api-a"), Timestamp: new Date(now - 120_000), Value: 5 }, { MetricName: "Requests", Dimensions: dimensions("api-a"), Timestamp: new Date(now - 60_000), Value: 7 },
        { MetricName: "Requests", Dimensions: dimensions("api-b"), Timestamp: new Date(now - 120_000), Value: 3 }, { MetricName: "Requests", Dimensions: dimensions("api-b"), Timestamp: new Date(now - 60_000), Value: 9 },
        { MetricName: "Requests", Dimensions: dimensions("api-c"), Timestamp: new Date(now - 120_000), Value: 1 }, { MetricName: "Requests", Dimensions: dimensions("api-c"), Timestamp: new Date(now - 60_000), Value: 2 },
      ] }));
      await page.goto(`${consoleUrl}#/cloudwatch/metrics-insights`); await expect(page.getByRole("heading", { name: "Metrics Insights" })).toBeVisible(); await expect(page.getByText(/Default dataset · service-owned key descriptor/)).toBeVisible(); await page.getByLabel("Namespace").fill("Browser/Insights"); await page.getByLabel("Metric name").fill("Requests"); await page.getByLabel("Aggregate").selectOption("SUM"); await page.getByLabel("Group by").fill("Host"); await page.getByLabel("Filter label (optional)").fill("Service"); await page.getByLabel("Filter value").fill("orders"); await page.getByLabel("Limit").fill("2"); await page.getByRole("button", { name: "Update SQL" }).click(); await expect(page.getByLabel("Metrics Insights SQL")).toHaveValue(/GROUP BY Host ORDER BY MAX\(\) DESC LIMIT 2/); await page.getByRole("button", { name: "Run query" }).click(); await expect(page.locator("#mi-status")).toHaveText("Complete · 2 series"); await page.getByRole("button", { name: "Table" }).click(); await expect(page.getByRole("cell", { name: "Metrics Insights (Host=api-b)" })).toBeVisible(); await expect(page.getByRole("cell", { name: "Metrics Insights (Host=api-a)" })).toBeVisible(); await page.getByRole("button", { name: "Source" }).click(); await expect(page.locator("#mi-source")).toContainText('"Expression": "SELECT SUM(Requests)');
      await page.getByRole("button", { name: "Dataset settings" }).click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("KMS dependency unavailable", { exact: true })).toBeVisible(); const kmsArn = "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab"; await dialog.getByLabel("Customer managed KMS key ARN").fill(kmsArn); await dialog.getByRole("button", { name: "Save settings" }).click(); await expect(page.getByText(/customer key descriptor configured/)).toBeVisible(); expect((await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" }))).KmsKeyArn).toBe(kmsArn);
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("heading", { name: "Query editor" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.getByRole("button", { name: "Dataset settings" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Customer managed KMS key ARN").fill(""); await dialog.getByRole("button", { name: "Save settings" }).click(); await expect(page.getByText(/service-owned key descriptor/)).toBeVisible(); expect((await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" }))).KmsKeyArn).toBeUndefined(); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); }
  });

  test("CW-08E creates, delivers, stops, edits, restarts, tags, filters, and deletes a metric stream", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const outputDirectory = join(dataDir, "cw08e-stream-output"); const streamName = "browser-orders-stream";
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/cloudwatch/metric-streams`); await expect(page.getByRole("heading", { name: "Metric streams", exact: true }).first()).toBeVisible(); await expect(page.getByRole("heading", { name: "No metric streams" })).toBeVisible();
      await page.getByRole("button", { name: "Create metric stream" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Create metric stream" })).toBeVisible(); await expect(dialog.getByText("Choose an explicit delivery boundary", { exact: true })).toBeVisible(); await dialog.getByLabel("Metric stream name").fill(streamName); await dialog.getByLabel("Destination").fill(pathToFileURL(outputDirectory).href); await dialog.getByLabel("Filter mode").selectOption("include"); await dialog.getByLabel("Namespace and metric filters (JSON)").fill('[{"Namespace":"Browser/Streams","MetricNames":["Requests"]}]'); await dialog.getByLabel("Additional statistics configurations (JSON)").fill('[{"IncludeMetrics":[{"Namespace":"Browser/Streams","MetricName":"Requests"}],"AdditionalStatistics":["p90"]}]'); await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser","team":"orders"}'); await dialog.getByRole("button", { name: "Create metric stream" }).click();
      await expect(page.getByRole("heading", { name: streamName, exact: true })).toBeVisible(); await expect(page.getByText("Opted-in local JSON delivery", { exact: true })).toBeVisible(); await expect(page.getByText("running", { exact: true })).toBeVisible(); let stream = await cloudwatch.send(new GetMetricStreamCommand({ Name: streamName })); expect(stream).toEqual(expect.objectContaining({ State: "running", OutputFormat: "json", IncludeFilters: [{ Namespace: "Browser/Streams", MetricNames: ["Requests"] }] }));
      await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Browser/Streams", MetricData: [{ MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "orders" }], Value: 12 }] })); const outputFile = join(outputDirectory, `${streamName}.jsonl`); await expect.poll(async () => readFile(outputFile, "utf8").catch(() => "")).toContain('"metric_name":"Requests"'); const beforeStop = (await readFile(outputFile, "utf8")).trim().split("\n"); expect(JSON.parse(beforeStop.at(-1)!)).toEqual(expect.objectContaining({ namespace: "Browser/Streams", metric_name: "Requests", value: expect.objectContaining({ max: 12, min: 12, p90: 12, sum: 12 }) }));
      await page.getByRole("button", { name: "Stop", exact: true }).click(); await expect(page.getByText("stopped", { exact: true })).toBeVisible(); expect((await cloudwatch.send(new GetMetricStreamCommand({ Name: streamName }))).State).toBe("stopped"); await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Browser/Streams", MetricData: [{ MetricName: "Requests", Value: 99 }] })); expect((await readFile(outputFile, "utf8")).trim().split("\n")).toHaveLength(beforeStop.length);
      await page.getByRole("button", { name: "Edit", exact: true }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("Metric stream name")).toHaveAttribute("readonly"); await dialog.getByLabel("Namespace and metric filters (JSON)").fill('[{"Namespace":"Browser/Streams","MetricNames":["Requests","Latency"]}]'); await dialog.getByRole("button", { name: "Save changes" }).click(); await expect(page.getByText("stopped", { exact: true })).toBeVisible(); stream = await cloudwatch.send(new GetMetricStreamCommand({ Name: streamName })); expect(stream.State).toBe("stopped"); expect(stream.IncludeFilters?.[0]?.MetricNames).toEqual(["Latency", "Requests"]);
      await page.getByRole("button", { name: "Start", exact: true }).click(); await expect(page.getByText("running", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Manage tags" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser","owner":"observability"}'); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.getByRole("cell", { name: "owner", exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: "observability", exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.getByRole("link", { name: "All metric streams" }).click(); await page.getByLabel("Filter metric stream state").selectOption("running"); await page.getByPlaceholder("Find metric streams").fill("orders"); await expect(page.getByRole("link", { name: streamName })).toBeVisible(); expect((await cloudwatch.send(new ListMetricStreamsCommand({}))).Entries?.map(entry => entry.Name)).toContain(streamName);
      await page.getByRole("link", { name: streamName }).click(); await page.getByRole("button", { name: "Delete", exact: true }).click(); await confirmDeletion(page, streamName); await expect(page.getByRole("heading", { name: "No metric streams" })).toBeVisible(); expect((await cloudwatch.send(new ListMetricStreamsCommand({}))).Entries).toEqual([]); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); }
  });

  test("CW-08F creates, reports, filters, tags, toggles, and deletes custom and managed insight rules", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator)); const logsClient = new CloudWatchLogsClient(sdkOptions(simulator)); const dynamodb = new DynamoDBClient(sdkOptions(simulator)); const group = "/browser/contributor-insights"; const customName = "browser-error-contributors"; const tableName = "BrowserManagedContributors";
    try {
      const errors = browserErrors(page); await logsClient.send(new CreateLogGroupCommand({ logGroupName: group })); await logsClient.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); await page.goto(`${consoleUrl}#/cloudwatch/contributor-insights`); await expect(page.getByRole("heading", { name: "Contributor Insights", exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "No Contributor Insights rules" })).toBeVisible();
      await page.getByRole("button", { name: "Create rule" }).first().click(); let dialog = page.getByRole("dialog"); await expect(dialog.getByText("Original segmented events", { exact: true })).toBeVisible(); await dialog.getByLabel("Rule name").fill(customName); await dialog.getByLabel("Rule definition").fill(JSON.stringify({ Schema: { Name: "CloudWatchLogRule", Version: 1 }, LogGroupNames: [group], LogFormat: "JSON", Contribution: { Keys: ["$.service"], ValueOf: "$.duration", Filters: [{ Match: "$.status", GreaterThan: 399 }] }, AggregateOn: "Sum" }, null, 2)); await dialog.getByLabel("Apply on transformed logs when a transformer exists").check(); await dialog.getByLabel("Tags (JSON object)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Create rule" }).click();
      await expect(page.getByRole("heading", { name: customName, exact: true })).toBeVisible(); await expect(page.getByText("Log transformation boundary", { exact: true })).toBeVisible(); await expect(page.getByText("ENABLED", { exact: true }).first()).toBeVisible(); const now = Date.now(); await logsClient.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "application", logEvents: [{ timestamp: now, message: '{"service":"api","status":500,"duration":7}' }, { timestamp: now + 1, message: '{"service":"worker","status":503,"duration":2}' }, { timestamp: now + 2, message: '{"service":"api","status":502,"duration":5}' }, { timestamp: now + 3, message: '{"service":"ignored","status":200,"duration":99}' }] })); await page.getByRole("button", { name: "Run report" }).click(); await expect(page.locator("#insight-report-summary")).toContainText("14"); await expect(page.locator("#insight-contributors")).toContainText("$.service: api"); await expect(page.locator("#insight-contributors")).toContainText("12"); await page.getByRole("button", { name: "Source", exact: true }).click(); await expect(page.locator("#insight-report-source")).toContainText('"AggregationStatistic": "SUM"');
      await page.getByRole("button", { name: "Manage", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Tags (JSON object)").fill('{"owner":"observability"}'); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.getByRole("cell", { name: "owner", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Disable", exact: true }).click(); await expect(page.getByText("DISABLED", { exact: true }).first()).toBeVisible(); await page.getByRole("button", { name: "Enable", exact: true }).click(); await expect(page.getByText("ENABLED", { exact: true }).first()).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("heading", { name: "Rule report" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.getByRole("link", { name: "All rules" }).click(); await page.getByLabel("Filter rule state").selectOption("ENABLED"); await page.getByLabel("Filter rule type").selectOption("custom"); await page.getByPlaceholder("Find rules or sources").fill("error"); await expect(page.getByRole("link", { name: customName })).toBeVisible();

      await dynamodb.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] })); await waitForTableActive(dynamodb, tableName); const resourceArn = `arn:aws:dynamodb:eu-west-1:000000000000:table/${tableName}`; await page.getByRole("button", { name: "Manage built-in rules" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("DynamoDB managed templates", { exact: true })).toBeVisible(); await dialog.getByLabel("Resource ARN").fill(resourceArn); await dialog.getByRole("button", { name: "Discover templates" }).click(); await expect(dialog.getByText("4 templates available", { exact: true })).toBeVisible(); const managedChoice = dialog.locator(".managed-template").filter({ hasText: "DynamoDBContributorInsights-PKC" }); await managedChoice.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "Enable selected rules" }).click(); await expect(page.getByText("Managed", { exact: true }).first()).toBeVisible(); const managedRule = (await cloudwatch.send(new DescribeInsightRulesCommand({}))).InsightRules?.find(rule => rule.ManagedRule); expect(managedRule?.Name).toContain("DynamoDBContributorInsights-PKC");
      const key = { pk: { S: "hot" }, sk: { N: "1" } }; await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: key })); await dynamodb.send(new GetItemCommand({ TableName: tableName, Key: key })); await page.getByRole("link", { name: managedRule!.Name! }).click(); await expect(page.getByText("Managed DynamoDB rule", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Run report" }).click(); await expect(page.locator("#insight-report-summary")).toContainText("2"); await expect(page.locator("#insight-contributors")).toContainText("pk: hot"); await page.getByRole("button", { name: "Delete", exact: true }).click(); await confirmDeletion(page, managedRule!.Name!); await expect(page.getByRole("heading", { name: "Contributor Insights", exact: true })).toBeVisible();
      await page.getByRole("link", { name: customName }).click(); await page.getByRole("button", { name: "Delete", exact: true }).click(); await confirmDeletion(page, customName); await expect(page.getByRole("heading", { name: "No Contributor Insights rules" })).toBeVisible(); expect((await cloudwatch.send(new DescribeInsightRulesCommand({}))).InsightRules).toEqual([]); expect(errors).toEqual([]);
    } finally { cloudwatch.destroy(); logsClient.destroy(); dynamodb.destroy(); }
  });

  test("explains CloudWatch editors and their StackSim support", async ({ page }) => {
    const cloudwatch = new CloudWatchClient(sdkOptions(simulator));
    const logsClient = new CloudWatchLogsClient(sdkOptions(simulator));
    const alarmName = "browser-cloudwatch-help-alarm";
    const groupName = "/browser/cloudwatch-help";
    const expectHelp = async (title: string, supportText: string) => {
      const button = page.getByRole("button", { name: `About ${title}` }).first();
      await expect(button).toBeVisible();
      await button.hover();
      const tooltip = button.locator("..").getByRole("tooltip");
      await expect(tooltip).toContainText(supportText);
      await expect(tooltip).toContainText("StackSim support");
      return tooltip;
    };

    try {
      const errors = browserErrors(page);
      await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: alarmName, Namespace: "Browser/Help", MetricName: "Requests", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold" }));
      await logsClient.send(new CreateLogGroupCommand({ logGroupName: groupName }));

      await page.goto(`${consoleUrl}#/cloudwatch/alarms`);
      await expectHelp("Alarms", "scheduled-log alarm evaluation");
      await page.goto(`${consoleUrl}#/cloudwatch/alarms/${alarmName}`);
      await expectHelp("Alarm details", "evaluated locally");
      await expectHelp("Tags", "Organizations tag policies");

      await page.goto(`${consoleUrl}#/cloudwatch/alarm-mute-rules`);
      await expectHelp("Mute rules", "continue evaluating");
      await page.goto(`${consoleUrl}#/cloudwatch/dashboards`);
      await expectHelp("Custom dashboards", "24-column layouts");
      await page.goto(`${consoleUrl}#/cloudwatch/metrics`);
      await expectHelp("Metric explorer", "durable local metric data");
      await expectHelp("Selected metrics graph", "GetMetricData queries");
      await page.goto(`${consoleUrl}#/cloudwatch/metrics-insights`);
      await expectHelp("Query editor", "most recent three hours");
      await page.goto(`${consoleUrl}#/cloudwatch/metric-streams`);
      await expectHelp("Metric streams", "file:// directory");
      await page.goto(`${consoleUrl}#/cloudwatch/contributor-insights`);
      await expectHelp("Insight rules", "managed DynamoDB templates");
      await page.goto(`${consoleUrl}#/cloudwatch/logs-insights`);
      await expectHelp("Query editor", "PPL and SQL definitions");
      await expectHelp("Saved queries", "selected log groups");
      await page.goto(`${consoleUrl}#/cloudwatch/log-groups`);
      await expectHelp("Log groups", "retention");

      const groupRoute = `${consoleUrl}#/cloudwatch/log-groups/${encodeURIComponent(groupName)}`;
      await page.goto(groupRoute);
      await expectHelp("Log group details", "retention updates and expiry");
      await expectHelp("Log streams", "ordered sequence of events");
      await page.goto(`${groupRoute}/metric-filters`);
      await expectHelp("Metric filters", "up to three extracted dimensions");
      await page.goto(`${groupRoute}/subscription-filters`);
      await expectHelp("Subscription filters", "same-Region Lambda destinations");
      await page.goto(`${groupRoute}/resource-policy`);
      await expectHelp("Resource policy", "cross-account delivery");
      await page.goto(`${groupRoute}/exports`);
      await expectHelp("Export tasks", "local files are explicitly enabled");

      await page.goto(`${consoleUrl}#/cloudwatch/anomaly-detection`);
      const anomalyTooltip = await expectHelp("Anomaly detectors", "median/MAD model");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "About Anomaly detectors" }).hover();
      const tooltipBox = await anomalyTooltip.boundingBox();
      expect(tooltipBox).not.toBeNull();
      expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally {
      await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: [alarmName] })).catch(() => {});
      await logsClient.send(new DeleteLogGroupCommand({ logGroupName: groupName })).catch(() => {});
      cloudwatch.destroy();
      logsClient.destroy();
    }
  });

  test("explains API Gateway editors and their StackSim support", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    const gatewayV2 = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const restApi = await gateway.send(new CreateRestApiCommand({ name: "panel-help-rest-api" }));
      await gateway.send(new CreateDeploymentCommand({ restApiId: restApi.id!, stageName: "dev", description: "Panel help stage" }));
      const httpApi = await gatewayV2.send(new CreateApiCommand({ Name: "panel-help-http-api", ProtocolType: "HTTP" }));
      const webSocketApi = await gatewayV2.send(new CreateApiCommand({ Name: "panel-help-websocket-api", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
      const errors = browserErrors(page);
      const expectHelp = async (title: string, supportText: string) => {
        const button = page.getByRole("button", { name: `About ${title}` }).first();
        await expect(button).toBeVisible();
        await button.hover();
        const tooltip = button.locator("..").getByRole("tooltip");
        await expect(tooltip).toContainText(supportText);
        await expect(tooltip).toContainText("StackSim support");
      };

      await page.goto(`${consoleUrl}#/apigateway/apis`);
      await expectHelp("APIs", "REST, HTTP, and WebSocket API creation");

      for (const [section, title, text] of [
        ["resources", "Resources", "deployment"],
        ["models", "Models", "JSON Schema"],
        ["request-validators", "Request validators", "fail bad requests early"],
        ["authorizers", "Authorizers", "Lambda TOKEN and REQUEST"],
        ["gateway-responses", "Gateway responses", "locally generated gateway errors"],
        ["settings", "Binary media types and compression", "compression thresholds"],
        ["policy", "Resource policy", "explicit deny precedence"],
      ] as const) {
        await page.goto(`${consoleUrl}#/apigateway/apis/${restApi.id}/${section}`);
        await expectHelp(title, text);
      }

      await page.goto(`${consoleUrl}#/apigateway/apis/${restApi.id}/stages`);
      await expectHelp("Stages", "named, invokable release");
      await expectHelp("Logs and tracing", "local CloudWatch Logs");
      await expectHelp("Response cache", "Runtime caching");
      await expectHelp("Canary release", "Deterministic traffic splitting");
      await expect(page.locator(".stage-shell .panel-help-button")).toHaveCount(9);

      for (const [section, title, text] of [
        ["routes", "Routes", "HTTP route matching"],
        ["authorization", "Authorization", "JWT and Lambda REQUEST"],
        ["integrations", "Integrations", "Lambda and HTTP proxy"],
        ["cors", "Cross-origin resource sharing", "Preflight responses"],
        ["stages", "Stages", "manual and automatic deployments"],
      ] as const) {
        await page.goto(`${consoleUrl}#/apigateway/http-apis/${httpApi.ApiId}/${section}`);
        await expectHelp(title, text);
      }

      for (const [section, title, text] of [
        ["routes", "Routes", "Connection lifecycle"],
        ["integrations", "Integrations", "proxy, and mock integration"],
        ["models", "Models", "WebSocket message models"],
        ["authorization", "$connect authorizers", "opening handshake"],
        ["stages", "Stages", "access logs"],
      ] as const) {
        await page.goto(`${consoleUrl}#/apigateway/websocket-apis/${webSocketApi.ApiId}/${section}`);
        await expectHelp(title, text);
      }

      await page.goto(`${consoleUrl}#/apigateway/api-keys`);
      await expectHelp("API keys", "not authentication by itself");
      await page.goto(`${consoleUrl}#/apigateway/usage-plans`);
      await expectHelp("Usage plans", "rate limits and request quotas");
      await page.goto(`${consoleUrl}#/apigateway/domains`);
      await expectHelp("Custom domain names", "does not modify DNS");
      await page.goto(`${consoleUrl}#/apigateway/vpc-links`);
      await expectHelp("VPC links", "No VPC, ENI, load balancer");
      await page.goto(`${consoleUrl}#/apigateway/client-certificates`);
      await expectHelp("Client certificates", "Private keys are unavailable");
      await page.goto(`${consoleUrl}#/apigateway/apis/${restApi.id}/documentation`);
      await expectHelp("Documentation parts", "documented OpenAPI export");
      await expectHelp("Documentation versions", "version publishing");
      await expectHelp("SDK generation", "dependency-free JavaScript client");
      await page.goto(`${consoleUrl}#/apigateway/account-settings`);
      await expectHelp("CloudWatch logs role", "No AWS account or external role");
      expect(errors).toEqual([]);
    } finally {
      gateway.destroy();
      gatewayV2.destroy();
    }
  });

  test("APIG-02 and APIG-04 configure/test mappings, authorizers, policies, stages, validation, and deletion", async ({ page }) => {
    const target = await createFunction(simulator, "phase-api-target", "handler.proxyEchoHandler");
    const authorizerFunction = await createFunction(simulator, "phase-api-authorizer", "handler.authorizerHandler");
    const apigateway = new APIGatewayClient(sdkOptions(simulator));
    const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const api = await apigateway.send(new CreateRestApiCommand({ name: "phase-browser-api", description: "Target phase browser fixture" }));
      await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", description: "browser stage" }));
      await lambda.send(new AddPermissionCommand({
        FunctionName: "phase-api-target",
        StatementId: "browser-target",
        Action: "lambda:InvokeFunction",
        Principal: "apigateway.amazonaws.com",
        SourceArn: `arn:aws:execute-api:eu-west-1:000000000000:${api.id}/*/*/*`,
      }));
      const root = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;
      expect(root.id).toBeTruthy();
      expect(target.FunctionArn).toBeTruthy();
      expect(authorizerFunction.FunctionArn).toBeTruthy();
      const directAuthorizer = await lambda.send(new InvokeCommand({
        FunctionName: "phase-api-authorizer",
        Payload: Buffer.from(JSON.stringify({ authorizationToken: "allow", methodArn: "arn:aws:execute-api:eu-west-1:000000000000:test/dev/GET/" })),
      }));
      expect(directAuthorizer.FunctionError, Buffer.from(directAuthorizer.Payload ?? []).toString("utf8")).toBeUndefined();

      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`);
      await expect(page.getByRole("heading", { name: "No methods" })).toBeVisible();
      await page.getByRole("button", { name: "Create method" }).click();
      let dialog = page.getByRole("dialog");
      await fillArnCombobox(dialog.getByLabel("Lambda function"), "arn:aws:lambda:eu-west-1:000000000000:function:phase-api-target");
      await dialog.getByRole("button", { name: "Create method" }).click();
      await expect(page.getByRole("button", { name: "GET · AWS_PROXY" })).toBeVisible();

      await page.getByRole("button", { name: "GET · AWS_PROXY" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("tab", { name: "Method request" })).toBeVisible();
      await expect(dialog.getByRole("tab", { name: "Integration request" })).toBeVisible();
      await expect(dialog.getByRole("tab", { name: "Integration response" })).toBeVisible();
      await expect(dialog.getByRole("tab", { name: "Method response" })).toBeVisible();
      await dialog.getByRole("tab", { name: "Integration request" }).click();
      await dialog.getByLabel("Integration type").selectOption("MOCK");
      await dialog.getByLabel("Request mapping templates (JSON content-type map)").fill("{");
      await dialog.getByRole("button", { name: "Save method" }).click();
      await expect(page.locator("#toast-region").getByRole("alert")).toBeVisible();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Request mapping templates (JSON content-type map)").fill(JSON.stringify({
        "application/json": '{"statusCode":200,"message":"$input.path(\'$.message\')"}',
      }));
      await dialog.getByRole("tab", { name: "Integration response" }).click();
      await dialog.getByLabel("Response mapping templates").fill(JSON.stringify({
        "application/json": '{"echo":"$input.path(\'$.message\')"}',
      }));
      await dialog.getByRole("button", { name: "Save method" }).click();
      await expect(page.getByRole("button", { name: "GET · MOCK" })).toBeVisible();

      await page.getByRole("button", { name: "GET · MOCK" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Test", exact: true }).click();
      await dialog.getByLabel("Headers (JSON)").fill('{"content-type":"application/json"}');
      await dialog.getByLabel("Request body").fill('{"message":"browser-mapped"}');
      await dialog.locator("#run-method-test").click();
      await expect(dialog.locator("#method-test-result")).toContainText("browser-mapped");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).not.toBeVisible();
      await page.waitForTimeout(20);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/authorizers`);
      await expect(page.getByText("No authorizers.")).toBeVisible();
      await page.getByRole("button", { name: "Create authorizer" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("browser-token");
      await fillArnCombobox(dialog.getByLabel("Lambda function"), "arn:aws:lambda:eu-west-1:000000000000:function:phase-api-authorizer");
      await dialog.getByLabel("Cache TTL (seconds)").fill("0");
      await dialog.getByRole("button", { name: "Create authorizer" }).click();
      await expect(page.getByRole("button", { name: "View and test" })).toBeVisible();
      const authorizerRow = page.locator(".api-authorizers-table tbody tr").filter({ hasText: "browser-token" });
      const providerLink = authorizerRow.getByRole("link", { name: "phase-api-authorizer", exact: true });
      await expect(providerLink).toHaveAttribute("href", "#/lambda/functions/phase-api-authorizer");
      const authorizerColumnWidths = await page.locator(".api-authorizers-table").evaluate(table => {
        const headers = [...table.querySelectorAll("th")].map(header => header.getBoundingClientRect().width);
        return { name: headers[0], provider: headers[4] };
      });
      expect(authorizerColumnWidths.name).toBeGreaterThan(authorizerColumnWidths.provider);
      const authorizers = await apigateway.send(new GetAuthorizersCommand({ restApiId: api.id! }));
      const authorizer = authorizers.items!.find(item => item.name === "browser-token")!;
      await lambda.send(new AddPermissionCommand({
        FunctionName: "phase-api-authorizer",
        StatementId: "browser-authorizer",
        Action: "lambda:InvokeFunction",
        Principal: "apigateway.amazonaws.com",
        SourceArn: `arn:aws:execute-api:eu-west-1:000000000000:${api.id}/authorizers/${authorizer.id}`,
      }));
      await page.getByRole("button", { name: "View and test" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Headers (JSON)").fill("{");
      await dialog.locator("#run-authorizer-test").click();
      await expect(dialog.locator("#authorizer-test-result")).not.toHaveText("No test invocation yet.");
      await dialog.getByLabel("Headers (JSON)").fill('{"Authorization":"allow"}');
      await dialog.locator("#run-authorizer-test").click();
      await expect(dialog.locator("#authorizer-test-result")).toContainText("allowed-user");
      await dialog.locator("#delete-authorizer").click();
      await confirmDeletion(page, "browser-token");
      await expect(page.getByText("No authorizers.")).toBeVisible();
      await expect(page.locator("#toast-region")).toHaveCSS("pointer-events", "none");

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/policy`);
      const policy = {
        Version: "2012-10-17",
        Statement: [{ Effect: "Deny", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*" }],
      };
      await page.getByLabel("Policy JSON").fill(JSON.stringify(policy, null, 2));
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Resource policy saved" })).toBeVisible();
      expect(JSON.parse((await apigateway.send(new GetRestApiCommand({ restApiId: api.id! }))).policy!)).toEqual(policy);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/stages`);
      await page.getByRole("button", { name: "Flush authorizer cache" }).click();
      await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Authorizer cache flushed" })).toBeVisible();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await confirmDeletion(page, "dev");
      await expect(page.getByRole("heading", { name: "No stages" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      apigateway.destroy();
      lambda.destroy();
    }
  });

  test("APIG-05 manages models and validators, attaches them to a method, and shows test validation errors", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-model-api", description: "APIG-05 browser fixture" })); const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "orders" }));
      await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "POST", authorizationType: "NONE", requestParameters: { "method.request.querystring.tenant": true } })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/models`); await expect(page.getByRole("heading", { name: /Models/ })).toBeVisible(); await expect(page.getByRole("button", { name: "Empty" })).toBeVisible(); await expect(page.getByRole("button", { name: "Error" })).toBeVisible();
      await page.getByRole("button", { name: "Create model" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Model name").fill("Order"); await dialog.getByLabel("Description").fill("Browser order model"); await dialog.getByLabel("JSON Schema Draft 4").fill(JSON.stringify({ type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 3 }, quantity: { type: "integer", minimum: 1 } } }, null, 2)); await dialog.getByRole("button", { name: "Create model" }).click(); await expect(page.getByRole("button", { name: "Order" })).toBeVisible();
      await page.getByRole("button", { name: "Order" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Model: Order" })).toBeVisible(); await expect(dialog.getByText("Generated template", { exact: true })).toBeVisible(); await dialog.getByLabel("Description").fill("Updated browser order model"); await dialog.getByRole("button", { name: "Save model" }).click(); await expect(page.getByText("Updated browser order model", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Create model" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Model name").fill("Temp"); await dialog.getByLabel("JSON Schema Draft 4").fill('{"type":"object"}'); await dialog.getByRole("button", { name: "Create model" }).click(); await page.getByRole("button", { name: "Temp" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Delete model" }).click(); await confirmDeletion(page, "Temp"); await expect(page.getByRole("button", { name: "Temp" })).not.toBeVisible();

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/request-validators`); await expect(page.getByRole("heading", { name: /Request validators/ })).toBeVisible(); await page.getByRole("button", { name: "Create request validator" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("Validate all"); await dialog.getByLabel("Validate request body").check(); await dialog.getByLabel("Validate required request parameters").check(); await dialog.getByRole("button", { name: "Create validator" }).click(); let row = page.locator("tbody tr").filter({ hasText: "Validate all" }); await expect(row.getByText("Yes", { exact: true })).toHaveCount(2); await row.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("Validate body and parameters"); await dialog.getByRole("button", { name: "Save validator" }).click(); row = page.locator("tbody tr").filter({ hasText: "Validate body and parameters" }); await expect(row).toBeVisible();
      await page.getByRole("button", { name: "Create request validator" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("Temporary validator"); await dialog.getByRole("button", { name: "Create validator" }).click(); row = page.locator("tbody tr").filter({ hasText: "Temporary validator" }); await row.getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Delete validator" }).click(); await confirmDeletion(page, "Temporary validator"); await expect(page.getByRole("dialog")).not.toBeVisible(); await expect(page.locator("tbody tr").filter({ hasText: "Temporary validator" })).not.toBeVisible();
      const validator = (await gateway.send(new GetRequestValidatorsCommand({ restApiId: api.id! }))).items!.find(value => value.name === "Validate body and parameters")!;

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`); await page.getByRole("treeitem", { name: "/orders, resource" }).click(); await page.getByRole("button", { name: "POST · MOCK" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Request validator").selectOption(validator.id!); await dialog.getByLabel("Request models (JSON content-type map)").fill('{"application/json":"Order"}'); await dialog.getByRole("tab", { name: "Method response" }).click(); await dialog.getByLabel("Response models (JSON content-type map)").fill('{"application/json":"Error"}'); await dialog.getByRole("tab", { name: "Integration response" }).click(); await dialog.getByLabel("Response mapping templates").fill('{"application/json":"{\\"accepted\\":true}"}'); await dialog.getByRole("button", { name: "Save method" }).click(); await expect(dialog).not.toBeVisible(); const configured = await gateway.send(new GetMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "POST" })); expect(configured.requestValidatorId).toBe(validator.id); expect(configured.requestModels).toEqual({ "application/json": "Order" }); expect(configured.methodResponses?.["200"].responseModels).toEqual({ "application/json": "Error" });

      await page.getByRole("button", { name: "POST · MOCK" }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("tab", { name: "Test", exact: true }).click(); await dialog.getByLabel("Path with query string").fill("/orders?tenant=browser"); await dialog.getByLabel("Request body").fill("{}"); await dialog.locator("#run-method-test").click(); await expect(dialog.locator("#method-test-result")).toContainText("Validation failed"); await expect(dialog.locator("#method-test-result")).toContainText("name"); await dialog.getByLabel("Request body").fill('{"name":"browser","quantity":2}'); await dialog.locator("#run-method-test").click(); await expect(dialog.locator("#method-test-result")).toContainText("accepted");
      expect((await gateway.send(new GetModelsCommand({ restApiId: api.id! }))).items?.map(value => value.name)).toEqual(expect.arrayContaining(["Empty", "Error", "Order"]));
    } finally { gateway.destroy(); }
  });

  test("APIG-06 imports OpenAPI by upload and paste, reviews warnings, and exports a deployed stage", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const definition = { swagger: "2.0", info: { title: "Browser imported API", description: "APIG-06 browser fixture", version: "1.0" }, produces: ["application/json"], paths: { "/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } }, "x-amazon-apigateway-integration": { type: "mock", requestTemplates: { "application/json": "{\"statusCode\":200}" }, responses: { default: { statusCode: "200", responseTemplates: { "application/json": "{\"pets\":[]}" } } } } } } }, definitions: { Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } };
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/apigateway/apis`); await page.getByRole("button", { name: "Create API" }).first().click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Creation method").selectOption("import"); await dialog.getByLabel("Definition file").setInputFiles({ name: "pets.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(definition, null, 2)) }); await expect(dialog.getByLabel("OpenAPI definition")).toHaveValue(/Browser imported API/); await dialog.getByRole("button", { name: "Create API" }).click(); await expect(page.getByRole("heading", { name: "Browser imported API" })).toBeVisible();
      const api = (await gateway.send(new GetRestApisCommand({}))).items!.find(value => value.name === "Browser imported API")!; expect(api).toBeTruthy(); const resources = await gateway.send(new GetResourcesCommand({ restApiId: api.id!, embed: ["methods.methodIntegration"] })); expect(resources.items?.find(value => value.path === "/pets")?.resourceMethods?.GET.methodIntegration?.type).toBe("MOCK"); expect((await gateway.send(new GetModelsCommand({ restApiId: api.id! }))).items?.map(value => value.name)).toContain("Pet");

      await page.getByRole("button", { name: "Import API" }).click(); dialog = page.getByRole("dialog"); const warningDefinition = { openapi: "3.0.1", info: { title: "Ignored update title", version: "2.0" }, paths: { "/warning": { get: { responses: { "200": { description: "ok" } }, "x-amazon-apigateway-integration": { type: "unsupported" } } } } }; await dialog.getByLabel("OpenAPI definition").fill(JSON.stringify(warningDefinition, null, 2)); await dialog.getByRole("button", { name: "Import API" }).click(); await expect(page.getByRole("alert").filter({ hasText: "Import completed with warnings" })).toContainText("Integration type unsupported is not supported"); expect((await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items?.map(value => value.path)).toContain("/warning");

      await page.getByRole("button", { name: "Deploy API" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("New stage name").fill("dev"); await dialog.getByRole("button", { name: "Deploy", exact: true }).click(); await expect(page.getByRole("heading", { name: "Stages" })).toBeVisible(); await page.getByRole("button", { name: "Export API" }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByText("Exports use the stage deployment snapshot", { exact: false })).toBeVisible(); const downloadStarted = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Export", exact: true }).click(); const download = await downloadStarted; expect(download.suggestedFilename()).toMatch(/Browser-imported-API-dev\.json$/); const downloadPath = await download.path(); const exported = JSON.parse(await readFile(downloadPath!, "utf8")); expect(exported.openapi).toBe("3.0.1"); expect(exported.paths["/pets"].get["x-amazon-apigateway-integration"].type).toBe("mock"); expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-07 manages stage observability, throttling, variables, canaries, tags, and Monitor links", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-stage-api", description: "APIG-07 browser fixture" })); const base = await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", description: "Stable deployment" })); const canary = await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, description: "Canary deployment" })); const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/stages`); await expect(page.getByRole("heading", { name: "Deployment" })).toBeVisible(); await expect(page.getByRole("button", { name: "Logs / tracing", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Metrics", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Throttling", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Variables", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Canary", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Tags", exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "#/cloudwatch"); await expect(page.getByRole("link", { name: "Monitor stage" })).toHaveAttribute("href", "#/cloudwatch/metrics");

      await page.locator("#stage-logs").getByRole("button", { name: "Edit" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Execution logging level").selectOption("INFO"); await dialog.getByLabel("Log full request/response data").check(); await dialog.getByLabel("Enable X-Ray tracing").check(); await dialog.getByRole("button", { name: "Save logging" }).click(); await expect(page.locator("#stage-logs")).toContainText("INFO"); await expect(page.locator("#stage-logs")).toContainText("Enabled");
      await page.locator("#stage-metrics").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Enable detailed method metrics").check(); await dialog.getByRole("button", { name: "Save metrics" }).click(); await expect(page.locator("#stage-metrics")).toContainText("Enabled");
      await page.locator("#stage-cache").getByRole("button", { name: "Edit cache settings" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Enable cache cluster").check(); await dialog.getByLabel("Enable default caching for GET methods").check(); await dialog.getByLabel("Default TTL (seconds)").fill("120"); await dialog.getByRole("button", { name: "Save cache settings" }).click(); await expect(page.locator("#stage-cache")).toContainText("Active"); await expect(page.locator("#stage-cache")).toContainText("120 seconds");
      await page.locator("#stage-throttling").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Rate limit").fill("25"); await dialog.getByLabel("Burst limit").fill("10"); await dialog.getByRole("button", { name: "Save throttling" }).click(); await expect(page.locator("#stage-throttling")).toContainText("25"); await expect(page.locator("#stage-throttling")).toContainText("10");
      await page.locator("#stage-variables").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Variables (JSON)").fill('{"release":"stable"}'); await dialog.getByRole("button", { name: "Save variables" }).click(); await expect(page.locator("#stage-variables")).toContainText("release"); await expect(page.locator("#stage-variables")).toContainText("stable");
      await page.locator("#stage-canary").getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Enable canary routing").check(); await dialog.getByLabel("Canary deployment").selectOption(canary.id!); await dialog.getByLabel("Traffic percentage").fill("20"); await dialog.getByLabel("Stage variable overrides (JSON)").fill('{"release":"preview"}'); await dialog.getByRole("button", { name: "Save canary" }).click(); await expect(page.locator("#stage-canary")).toContainText("20%"); await expect(page.locator("#stage-canary")).toContainText("preview"); await expect(page.getByRole("button", { name: "Promote canary" })).toBeVisible();
      await page.locator("#stage-tags").getByRole("button", { name: "Manage tags" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.locator("#stage-tags")).toContainText("team"); await expect(page.locator("#stage-tags")).toContainText("browser");
      const stage = await gateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" })); expect(stage.deploymentId).toBe(base.id); expect(stage.tracingEnabled).toBe(true); expect(stage.methodSettings?.["*/*"]?.metricsEnabled).toBe(true); expect(stage.methodSettings?.["*/*"]?.throttlingRateLimit).toBe(25); expect(stage.variables).toEqual({ release: "stable" }); expect(stage.canarySettings?.deploymentId).toBe(canary.id); expect(stage.canarySettings?.percentTraffic).toBe(20); const arn = `arn:aws:apigateway:eu-west-1::/restapis/${api.id}/stages/dev`; expect((await gateway.send(new GetTagsCommand({ resourceArn: arn }))).tags).toEqual({ team: "browser" }); expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-08 manages API keys, usage-plan stages, throttles, quotas, associations, usage, and method requirements", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-key-api", description: "APIG-08 browser fixture" })); const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "orders" })); await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", authorizationType: "NONE" })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "prod" })); const errors = browserErrors(page);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/settings`); await expect(page.getByLabel("API key source")).toHaveValue("HEADER"); await page.getByLabel("API key source").selectOption("AUTHORIZER"); await page.getByRole("button", { name: "Save changes" }).click(); await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "API settings saved" })).toBeVisible(); expect((await gateway.send(new GetRestApiCommand({ restApiId: api.id! }))).apiKeySource).toBe("AUTHORIZER");
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`); await page.getByRole("treeitem", { name: "/orders, resource" }).click(); await page.getByRole("button", { name: "GET · MOCK" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("API key required").check(); await dialog.getByRole("button", { name: "Save method" }).click(); expect((await gateway.send(new GetMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET" }))).apiKeyRequired).toBe(true);

      await page.goto(`${consoleUrl}#/apigateway/api-keys`); await expect(page.getByRole("heading", { name: "No API keys" })).toBeVisible(); await page.getByRole("button", { name: "Create API key" }).first().click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("browser-client"); await dialog.getByLabel(/Description/).fill("Browser client credential"); await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Create API key" }).click(); await expect(page.getByRole("heading", { name: "browser-client" })).toBeVisible(); await expect(page.locator("#main").getByText("Enabled", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Reveal" }).click(); await expect(page.locator("#api-key-value")).not.toContainText("•"); const value = await page.locator("#api-key-value").textContent(); expect(value).toHaveLength(40); const listedKey = (await gateway.send(new GetApiKeyCommand({ apiKey: new URL(page.url()).hash.split("/").at(-1)!, includeValue: true }))); expect(listedKey.value).toBe(value); expect(listedKey.tags).toEqual({ team: "browser" }); const keyId = listedKey.id!;

      await page.goto(`${consoleUrl}#/apigateway/api-keys`); await page.getByRole("button", { name: "Import CSV" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("CSV content").fill("name,key,description,enabled\nimported-browser,abcdefghijklmnopqrst,Imported in browser,true"); await dialog.getByRole("button", { name: "Import keys" }).click(); await expect(page.getByRole("link", { name: "imported-browser" })).toBeVisible();

      await page.goto(`${consoleUrl}#/apigateway/usage-plans`); await expect(page.getByRole("heading", { name: "No usage plans" })).toBeVisible(); await page.getByRole("button", { name: "Create usage plan" }).first().click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("Browser standard plan"); await dialog.getByLabel("Rate limit (requests/second)").fill("25"); await dialog.getByLabel("Burst limit").fill("10"); await dialog.getByLabel("Enable request quota").check(); await dialog.getByLabel("Request limit").fill("500"); await dialog.getByLabel("Period").selectOption("MONTH"); await dialog.getByLabel("Tags (JSON)").fill('{"tier":"standard"}'); await dialog.getByRole("button", { name: "Create usage plan" }).click(); await expect(page.getByRole("heading", { name: "Browser standard plan" })).toBeVisible(); const planId = new URL(page.url()).hash.split("/").at(-1)!;
      await page.getByRole("button", { name: "Manage stages" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("phase-key-api · prod").check(); await dialog.getByLabel("Method throttles (JSON by API:stage)").fill(JSON.stringify({ [`${api.id}:prod`]: { "/orders/GET": { rateLimit: 5, burstLimit: 2 } } }, null, 2)); await dialog.getByRole("button", { name: "Save stage associations" }).click(); await expect(page.getByRole("cell", { name: /\/orders\/GET · 5\/s, 2 burst/ })).toBeVisible();
      await page.getByRole("link", { name: "Associated keys" }).click(); await page.getByRole("button", { name: "Add API key" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("API key").selectOption(keyId); await dialog.getByRole("button", { name: "Add API key" }).click(); await expect(page.getByRole("link", { name: "browser-client" })).toBeVisible();
      await page.getByRole("link", { name: "Usage", exact: true }).click(); await expect(page.getByRole("heading", { name: "Daily usage" })).toBeVisible(); await expect(page.getByText("500 remaining", { exact: false })).toBeVisible(); await page.getByRole("button", { name: "Set remaining" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Remaining requests").fill("750"); await dialog.getByRole("button", { name: "Set remaining" }).click(); await expect(page.getByText("750 remaining", { exact: false })).toBeVisible();

      const plan = await gateway.send(new GetUsagePlanCommand({ usagePlanId: planId })); expect(plan.apiStages?.[0]).toEqual(expect.objectContaining({ apiId: api.id, stage: "prod", throttle: { "/orders/GET": { rateLimit: 5, burstLimit: 2 } } })); expect(plan.throttle).toEqual({ rateLimit: 25, burstLimit: 10 }); expect(plan.quota).toEqual({ limit: 500, period: "MONTH", offset: 0 }); expect(plan.tags).toEqual({ tier: "standard" }); expect((await gateway.send(new GetUsagePlanKeysCommand({ usagePlanId: planId }))).items?.map(item => item.id)).toContain(keyId); expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-09 configures active stage caching, method overrides, cache keys, authorization, and flush", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-response-cache-api", description: "APIG-09 browser fixture" })); const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "orders" })); await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", authorizationType: "NONE", requestParameters: { "method.request.querystring.variant": false } })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "prod" })); const errors = browserErrors(page);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`); await page.getByRole("treeitem", { name: "/orders, resource" }).click(); await page.getByRole("button", { name: "GET · MOCK" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByRole("tab", { name: "Integration request" }).click(); await dialog.getByLabel("Cache namespace").fill("orders-shared"); await dialog.getByLabel("Cache key parameters (JSON array)").fill('["method.request.querystring.variant"]'); await dialog.getByRole("button", { name: "Save method" }).click(); await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Method pipeline and validation updated" })).toBeVisible(); const integration = await gateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET" })); expect(integration.cacheNamespace).toBe("orders-shared"); expect(integration.cacheKeyParameters).toEqual(["method.request.querystring.variant"]);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/stages`); await expect(page.getByRole("button", { name: "Cache", exact: true })).toBeVisible(); await expect(page.locator("#stage-cache")).toContainText("Disabled"); await expect(page.locator("#stage-cache")).toContainText("installation-managed authenticated encryption"); await expect(page.locator("#stage-cache")).toContainText("state-only copy cannot decrypt entries"); await page.locator("#stage-cache").getByRole("button", { name: "Edit cache settings" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Enable cache cluster").check(); await dialog.getByLabel("Cache cluster size").selectOption("1.6"); await dialog.getByLabel("Enable default caching for GET methods").check(); await dialog.getByLabel("Default TTL (seconds)").fill("90"); await dialog.getByLabel("Encrypt cached data").check(); await dialog.getByLabel("Require authorization for client cache invalidation").check(); await dialog.getByLabel("Unauthorized request strategy").selectOption("FAIL_WITH_403"); await dialog.getByRole("button", { name: "Save cache settings" }).click(); await expect(page.locator("#stage-cache")).toContainText("Active"); await expect(page.locator("#stage-cache")).toContainText("authenticated at rest"); await expect(page.locator("#stage-cache")).toContainText("90 seconds"); await expect(page.locator("#stage-cache")).toContainText("Authorization required");

      await page.locator("#stage-cache").getByRole("button", { name: "Edit override" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Use stage default cache settings").uncheck(); await dialog.getByLabel("Enable response caching for this method").check(); await dialog.getByLabel("TTL (seconds)").fill("45"); await dialog.getByLabel("Unauthorized request strategy").selectOption("SUCCEED_WITHOUT_RESPONSE_HEADER"); await dialog.getByRole("button", { name: "Save method override" }).click(); await expect(page.locator("#stage-cache")).toContainText("Method override"); await expect(page.locator("#stage-cache")).toContainText("45 sec"); await page.locator("#stage-cache").getByRole("button", { name: "Flush stage cache" }).click(); await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Stage cache flushed" })).toBeVisible();

      const stage = await gateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "prod" })); expect(stage.cacheClusterEnabled).toBe(true); expect(stage.cacheClusterStatus).toBe("AVAILABLE"); expect(stage.cacheClusterSize).toBe("1.6"); expect(stage.methodSettings?.["*/*"]).toEqual(expect.objectContaining({ cachingEnabled: true, cacheTtlInSeconds: 90, cacheDataEncrypted: true, requireAuthorizationForCacheControl: true, unauthorizedCacheControlHeaderStrategy: "FAIL_WITH_403" })); expect(stage.methodSettings?.["/orders/GET"]).toEqual(expect.objectContaining({ cachingEnabled: true, cacheTtlInSeconds: 45, unauthorizedCacheControlHeaderStrategy: "SUCCEED_WITHOUT_RESPONSE_HEADER" })); expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-10 creates and edits a custom domain, API mapping, tags, and local DNS guidance", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-domain-api", description: "APIG-10 browser fixture" })); const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "orders" })); await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", authorizationType: "NONE" })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "prod" })); const errors = browserErrors(page); const certificate = "arn:aws:acm:eu-west-1:000000000000:certificate/44444444-4444-4444-4444-444444444444";
      await page.goto(`${consoleUrl}#/apigateway/domains`); await expect(page.getByRole("heading", { name: "No custom domain names" })).toBeVisible(); await page.getByRole("button", { name: "Create domain name" }).first().click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Domain name").fill("browser.api.test"); await dialog.getByLabel("Endpoint type").selectOption("REGIONAL"); await dialog.getByLabel("IP address type").selectOption("dualstack"); await dialog.getByLabel("Regional certificate ARN").fill(certificate); await dialog.getByLabel("Truststore S3 URI").fill("s3://browser-trust/clients.pem"); await dialog.getByLabel("Truststore version").fill("v7"); await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Create domain name" }).click(); await expect(page.getByRole("heading", { name: "browser.api.test" })).toBeVisible(); await expect(page.getByText("Local host alias", { exact: true })).toBeVisible(); await expect(page.getByText("curl --resolve", { exact: false }).first()).toBeVisible(); await expect(page.getByText("dualstack", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Configure API mapping" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Base path").fill("v1"); await dialog.getByLabel("Destination API and stage").selectOption({ label: "phase-domain-api · prod" }); await dialog.getByRole("button", { name: "Create mapping" }).click(); const mappingRow = page.locator("tbody tr").filter({ hasText: "v1" }); await expect(mappingRow.getByRole("cell", { name: "v1" })).toBeVisible(); await expect(mappingRow).toContainText("phase-domain-api");
      await page.getByRole("button", { name: "Edit", exact: true }).first().click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Routing mode").selectOption("ROUTING_RULE_THEN_BASE_PATH_MAPPING"); await dialog.getByRole("button", { name: "Save domain" }).click(); await expect(page.locator("#main").getByText("Routing rules, then API mappings", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Manage tags" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser","environment":"test"}'); await dialog.getByRole("button", { name: "Save tags" }).click(); await expect(page.getByRole("cell", { name: "environment" })).toBeVisible();
      await page.locator("tbody tr").filter({ hasText: "v1" }).getByRole("button", { name: "Edit" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Base path").fill("v2"); await dialog.getByRole("button", { name: "Save mapping" }).click(); await expect(page.getByRole("cell", { name: "v2" })).toBeVisible(); const domain = await gateway.send(new GetDomainNameCommand({ domainName: "browser.api.test" })); expect(domain.routingMode).toBe("ROUTING_RULE_THEN_BASE_PATH_MAPPING"); expect(domain.mutualTlsAuthentication).toEqual(expect.objectContaining({ truststoreUri: "s3://browser-trust/clients.pem", truststoreVersion: "v7" })); expect(domain.tags).toEqual({ team: "browser", environment: "test" }); expect((await gateway.send(new GetBasePathMappingsCommand({ domainName: "browser.api.test" }))).items).toEqual([expect.objectContaining({ basePath: "v2", restApiId: api.id, stage: "prod" })]); expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-03 enables CORS, validates wildcard credentials, edits binary settings and gateway responses, and deploys the same SDK resources", async ({ page }) => {
    await createFunction(simulator, "phase-binary-target", "handler.binaryProxyHandler"); const gateway = new APIGatewayClient(sdkOptions(simulator)); const lambda = new LambdaClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "phase-cors-api", description: "APIG-03 browser fixture" })); const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const cors = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "cors" })); await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: cors.id!, httpMethod: "POST", authorizationType: "NONE" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: cors.id!, httpMethod: "POST", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:phase-binary-target/invocations" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); await lambda.send(new AddPermissionCommand({ FunctionName: "phase-binary-target", StatementId: "phase-cors-api", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:eu-west-1:000000000000:${api.id}/*/*/*` }));
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`); await page.getByRole("treeitem", { name: "/cors, resource" }).click(); await page.getByRole("button", { name: "Enable CORS" }).click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("Access-Control-Allow-Credentials").check(); await dialog.getByRole("button", { name: "Enable CORS and replace existing CORS headers" }).click(); await expect(page.locator("#toast-region").getByRole("alert")).toContainText("Wildcard origins"); await expect(dialog).toBeVisible(); await dialog.getByLabel("Access-Control-Allow-Origin").fill("https://app.example"); await dialog.getByLabel("Access-Control-Expose-Headers").fill("x-request-was-base64"); await dialog.getByRole("button", { name: "Enable CORS and replace existing CORS headers" }).click(); await expect(page.getByRole("button", { name: "OPTIONS · MOCK" })).toBeVisible(); expect((await gateway.send(new GetMethodCommand({ restApiId: api.id!, resourceId: cors.id!, httpMethod: "OPTIONS" }))).authorizationType).toBe("NONE"); expect((await gateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: cors.id!, httpMethod: "OPTIONS" }))).contentHandling).toBe("CONVERT_TO_TEXT");

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/settings`); await expect(page.getByRole("heading", { name: "Binary media types and compression" })).toBeVisible(); await page.getByLabel("Binary media types", { exact: true }).fill("application/octet-stream\nimage/*"); await page.getByLabel("Minimum compression size (bytes)").fill("0"); await page.getByRole("button", { name: "Save changes" }).click(); await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "API settings saved" })).toBeVisible(); const settings = await gateway.send(new GetRestApiCommand({ restApiId: api.id! })); expect(settings.binaryMediaTypes).toEqual(["application/octet-stream", "image/*"]); expect(settings.minimumCompressionSize).toBe(0);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/gateway-responses`); await expect(page.getByRole("heading", { name: "Gateway responses" })).toBeVisible(); await page.getByRole("button", { name: "MISSING_AUTHENTICATION_TOKEN" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel(/Status code/).fill("404"); await dialog.getByLabel("Response headers (JSON)").fill(JSON.stringify({ "gatewayresponse.header.Access-Control-Allow-Origin": "'https://app.example'", "gatewayresponse.header.x-browser-error": "'customized'" }, null, 2)); await dialog.getByLabel("Response templates (JSON)").fill(JSON.stringify({ "application/json": '{"type":"$context.error.responseType","message":$context.error.messageString}' }, null, 2)); await dialog.getByRole("button", { name: "Save response" }).click(); await expect(page.getByText("1 customized")).toBeVisible(); expect((await gateway.send(new GetGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN" }))).statusCode).toBe("404");

      await page.getByRole("button", { name: "Deploy API" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Deployment stage").selectOption("existing"); await dialog.getByRole("button", { name: "Deploy", exact: true }).click(); await expect(page.getByRole("heading", { name: "Stages" })).toBeVisible(); const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev`; const preflight = await fetch(`${invoke}/cors`, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" } }); expect(preflight.status).toBe(200); expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example"); expect(preflight.headers.get("access-control-allow-credentials")).toBe("true"); const missing = await fetch(`${invoke}/missing`); expect(missing.status).toBe(404); expect(missing.headers.get("x-browser-error")).toBe("customized"); expect(await missing.json()).toEqual({ type: "MISSING_AUTHENTICATION_TOKEN", message: "Missing Authentication Token" }); expect(errors).toEqual([]);
    } finally { gateway.destroy(); lambda.destroy(); }
  });

  test("APIG-11 builds and manages an HTTP API across Develop, Deploy, and Monitor", async ({ page }) => {
    const target = await createFunction(simulator, "phase-http-api-target", "handler.echoHandler");
    const gateway = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis`);
      await expect(page.getByRole("button", { name: "Create HTTP API" }).first()).toBeVisible();
      await page.getByRole("button", { name: "Create HTTP API" }).first().click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("API name").fill("browser-http-api");
      await dialog.getByLabel(/Description/).fill("APIG-11 browser fixture");
      await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser"}');
      await dialog.getByRole("button", { name: "Create HTTP API" }).click();
      await expect(page.getByRole("heading", { name: "browser-http-api" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Routes/ })).toBeVisible();
      const apiId = new URL(page.url()).hash.split("/")[3];

      await page.getByRole("link", { name: "Integrations", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No integrations" })).toBeVisible();
      await page.getByRole("button", { name: "Create integration" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Integration target").fill(target.FunctionArn!);
      await dialog.getByLabel("Description").fill("Orders Lambda");
      await dialog.getByLabel("Payload format version").selectOption("2.0");
      await dialog.getByLabel("Request parameter mappings (JSON)").fill('{"append:header.x-browser":"\'console\'"}');
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("Orders Lambda", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Authorization", exact: true }).click();
      await page.getByRole("button", { name: "Create authorizer" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("browser-jwt");
      await dialog.getByLabel("Authorizer type").selectOption("JWT");
      await dialog.getByLabel("Issuer URL").fill("https://issuer.browser.test");
      await dialog.getByLabel("Audience").fill("browser-client");
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("browser-jwt", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Routes", exact: true }).click();
      await page.getByRole("button", { name: "Create route" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Route key").fill("GET /orders/{id}");
      await dialog.getByLabel("Integration").selectOption({ index: 1 });
      await dialog.getByLabel("Authorization", { exact: true }).selectOption("JWT");
      await dialog.getByLabel("Authorizer").selectOption({ index: 1 });
      await dialog.getByLabel("Authorization scopes").fill("orders:read");
      await dialog.getByRole("button", { name: "Create" }).click();
      let routeRow = page.locator("tbody tr").filter({ hasText: "GET /orders/{id}" });
      await expect(routeRow).toContainText("browser-jwt");
      await routeRow.getByRole("button", { name: "Edit" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Route key").fill("GET /orders/{orderId}");
      await dialog.getByRole("button", { name: "Save" }).click();
      routeRow = page.locator("tbody tr").filter({ hasText: "GET /orders/{orderId}" });
      await expect(routeRow).toBeVisible();

      await page.getByRole("button", { name: "Create", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Route key").fill("DELETE /temporary");
      await dialog.getByLabel("Integration").selectOption({ index: 1 });
      await dialog.getByRole("button", { name: "Create" }).click();
      const temporary = page.locator("tbody tr").filter({ hasText: "DELETE /temporary" });
      await temporary.getByRole("button", { name: "Delete" }).click();
      await confirmDeletion(page, "DELETE /temporary");
      await expect(temporary).not.toBeVisible();

      await page.getByRole("link", { name: "CORS", exact: true }).click();
      await page.getByLabel("Access-Control-Allow-Origin").fill("https://app.browser.test");
      await page.getByLabel("Access-Control-Allow-Headers").fill("authorization, content-type");
      await page.getByLabel("Access-Control-Allow-Methods").fill("GET, OPTIONS");
      await page.getByLabel("Access-Control-Expose-Headers").fill("x-request-id");
      await page.getByLabel("Allow credentials").check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();

      await page.getByRole("link", { name: "Stages", exact: true }).click();
      await page.getByRole("button", { name: "Create", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Stage name").fill("dev");
      await dialog.getByLabel("Auto-deploy").check();
      await dialog.getByLabel("Description").fill("Browser development stage");
      await dialog.getByLabel("Stage variables (JSON)").fill('{"release":"browser"}');
      await dialog.getByLabel("Throttle rate").fill("25");
      await dialog.getByLabel("Throttle burst").fill("10");
      await dialog.getByLabel("Enable detailed metrics").check();
      await dialog.getByRole("button", { name: "Create" }).click();
      const stageRow = page.locator("tbody tr").filter({ hasText: "dev" });
      await expect(stageRow).toContainText("On");
      await expect(stageRow).toContainText("Automatic deployment");

      await page.getByRole("link", { name: "Monitor", exact: true }).click();
      await expect(page.getByRole("heading", { name: "HTTP API metrics" })).toBeVisible();
      await expect(page.getByText("Count, 4xx, 5xx", { exact: false })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("navigation", { name: "HTTP API navigation" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Routes", exact: true })).toBeVisible();

      const api = await gateway.send(new GetV2ApiCommand({ ApiId: apiId }));
      const integrations = await gateway.send(new GetV2IntegrationsCommand({ ApiId: apiId }));
      const authorizers = await gateway.send(new GetV2AuthorizersCommand({ ApiId: apiId }));
      const routes = await gateway.send(new GetV2RoutesCommand({ ApiId: apiId }));
      const stages = await gateway.send(new GetV2StagesCommand({ ApiId: apiId }));
      expect(api.CorsConfiguration).toEqual(expect.objectContaining({ AllowCredentials: true, AllowOrigins: ["https://app.browser.test"] }));
      expect(integrations.Items).toEqual([expect.objectContaining({ Description: "Orders Lambda", PayloadFormatVersion: "2.0" })]);
      expect(authorizers.Items).toEqual([expect.objectContaining({ Name: "browser-jwt", AuthorizerType: "JWT" })]);
      expect(routes.Items).toEqual([expect.objectContaining({ RouteKey: "GET /orders/{orderId}", AuthorizationType: "JWT", AuthorizationScopes: ["orders:read"] })]);
      expect(stages.Items).toEqual([expect.objectContaining({ StageName: "dev", AutoDeploy: true, DeploymentId: expect.any(String), StageVariables: { release: "browser" } })]);
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-12 builds a WebSocket API across routes, integrations, models, stages, monitor, and test guidance", async ({ page }) => {
    const target = await createFunction(simulator, "phase-websocket-target", "handler.echoHandler"); const gateway = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const errors = browserErrors(page); await page.goto(`${consoleUrl}#/apigateway/apis`); await expect(page.getByRole("button", { name: "Create WebSocket API" }).first()).toBeVisible(); await page.getByRole("button", { name: "Create WebSocket API" }).first().click(); let dialog = page.getByRole("dialog"); await dialog.getByLabel("API name").fill("browser-websocket-api"); await dialog.getByLabel("Route selection expression").fill("$request.body.operation"); await dialog.getByLabel(/Description/).fill("APIG-12 browser fixture"); await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser"}'); await dialog.getByRole("button", { name: "Create WebSocket API" }).click(); await expect(page.getByRole("heading", { name: "browser-websocket-api" })).toBeVisible(); await expect(page.getByText("$request.body.operation", { exact: true })).toBeVisible(); const apiId = new URL(page.url()).hash.split("/")[3];

      await page.getByRole("link", { name: "Integrations", exact: true }).click(); await expect(page.getByRole("heading", { name: "No integrations" })).toBeVisible(); await page.getByRole("button", { name: "Create integration" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Integration type").selectOption("AWS_PROXY"); await dialog.getByLabel("Integration target").fill(target.FunctionArn!); await dialog.getByLabel("Description").fill("Chat Lambda"); await dialog.getByLabel("Request templates (JSON)").fill('{}'); await dialog.getByRole("button", { name: "Create" }).click(); await expect(page.getByText("Chat Lambda", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Authorization", exact: true }).click(); await page.getByRole("button", { name: "Create authorizer" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("browser-connect-auth"); await dialog.getByLabel("Authorizer URI").fill(target.FunctionArn!); await dialog.getByLabel("Identity source").fill("route.request.header.Authorization"); await dialog.getByLabel("Cache TTL (seconds)").fill("0"); await dialog.getByRole("button", { name: "Create" }).click(); await expect(page.getByText("browser-connect-auth", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Routes", exact: true }).click(); await page.getByRole("button", { name: "Create route" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Route key").fill("$connect"); await dialog.getByLabel("Integration", { exact: true }).selectOption({ index: 1 }); await dialog.getByLabel("Authorization").selectOption("CUSTOM"); await dialog.getByLabel("Authorizer").selectOption({ index: 1 }); await dialog.getByRole("button", { name: "Create" }).click(); let routeRow = page.locator("tbody tr").filter({ hasText: "$connect" }); await expect(routeRow).toContainText("browser-connect-auth");
      await page.getByRole("button", { name: "Create", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Route key").fill("send"); await dialog.getByLabel("Integration", { exact: true }).selectOption({ index: 1 }); await dialog.getByLabel(/Return integration output/).check(); await dialog.getByRole("button", { name: "Create" }).click(); routeRow = page.locator("tbody tr").filter({ hasText: "send" }); await expect(routeRow).toContainText("Two-way");

      await page.getByRole("link", { name: "Models", exact: true }).click(); await page.getByRole("button", { name: "Create model" }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("ChatMessage"); await dialog.getByLabel("Description").fill("Browser message schema"); await dialog.getByLabel("JSON Schema").fill('{"type":"object","required":["operation"]}'); await dialog.getByRole("button", { name: "Create" }).click(); await expect(page.getByText("ChatMessage", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Stages", exact: true }).click(); await page.getByRole("button", { name: "Create", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByLabel("Stage name").fill("dev"); await dialog.getByLabel("Automatically deploy API changes").check(); await dialog.getByLabel("Stage variables (JSON)").fill('{"release":"browser"}'); await dialog.getByLabel("Enable detailed route metrics").check(); await dialog.getByRole("button", { name: "Create" }).click(); const stageRow = page.locator("tbody tr").filter({ hasText: "dev" }); await expect(stageRow).toContainText("On"); await expect(stageRow).toContainText("Detailed");

      await page.getByRole("link", { name: "Monitor and test", exact: true }).click(); await expect(page.getByRole("heading", { name: "Connect a test client" })).toBeVisible(); await expect(page.getByText("new WebSocket", { exact: false })).toBeVisible(); await expect(page.getByRole("heading", { name: "Post to a connection" })).toBeVisible(); await expect(page.getByText("execute-api:ManageConnections", { exact: false })).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("navigation", { name: "WebSocket API navigation" })).toBeVisible();

      const api = await gateway.send(new GetV2ApiCommand({ ApiId: apiId })); const integrations = await gateway.send(new GetV2IntegrationsCommand({ ApiId: apiId })); const authorizers = await gateway.send(new GetV2AuthorizersCommand({ ApiId: apiId })); const routes = await gateway.send(new GetV2RoutesCommand({ ApiId: apiId })); const models = await gateway.send(new GetV2ModelsCommand({ ApiId: apiId })); const stages = await gateway.send(new GetV2StagesCommand({ ApiId: apiId })); const send = routes.Items!.find(value => value.RouteKey === "send")!; const responses = await gateway.send(new GetV2RouteResponsesCommand({ ApiId: apiId, RouteId: send.RouteId }));
      expect(api).toEqual(expect.objectContaining({ ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.operation", Tags: { team: "browser" } })); expect(integrations.Items).toEqual([expect.objectContaining({ Description: "Chat Lambda", IntegrationType: "AWS_PROXY" })]); expect(authorizers.Items).toEqual([expect.objectContaining({ Name: "browser-connect-auth", AuthorizerType: "REQUEST" })]); expect(routes.Items).toEqual(expect.arrayContaining([expect.objectContaining({ RouteKey: "$connect", AuthorizationType: "CUSTOM" }), expect.objectContaining({ RouteKey: "send" })])); expect(responses.Items).toEqual([expect.objectContaining({ RouteResponseKey: "$default" })]); expect(models.Items).toEqual([expect.objectContaining({ Name: "ChatMessage" })]); expect(stages.Items).toEqual([expect.objectContaining({ StageName: "dev", AutoDeploy: true, DeploymentId: expect.any(String), StageVariables: { release: "browser" } })]); expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("APIG-13 manages VPC links, documentation, SDK generation, client certificates, and account settings", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/vpc-links`);
      await expect(page.getByRole("heading", { name: "VPC links", exact: true })).toBeVisible();
      await expect(page.getByText("No VPC or load balancer is created", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Create VPC link" }).first().click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("browser-private-link");
      await dialog.getByLabel("Description").fill("APIG-13 browser mapping");
      await dialog.getByLabel("Network/Application Load Balancer ARN").fill(browserVpcTargetArn);
      await dialog.getByLabel("Tags (JSON)").fill('{"team":"browser"}');
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("heading", { name: "browser-private-link", exact: true })).toBeVisible();
      await expect(page.getByText("AVAILABLE", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Description").fill("Updated APIG-13 mapping");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Updated APIG-13 mapping", { exact: true })).toBeVisible();
      expect((await gateway.send(new GetVpcLinksCommand({}))).items).toEqual([expect.objectContaining({ name: "browser-private-link", status: "AVAILABLE" })]);

      await page.goto(`${consoleUrl}#/apigateway/client-certificates`);
      await expect(page.getByRole("heading", { name: "Client certificates", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Generate client certificate" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Description").fill("Browser backend certificate");
      await dialog.getByLabel("Tags (JSON)").fill('{"owner":"browser"}');
      await dialog.getByRole("button", { name: "Generate", exact: true }).click();
      await expect(page.getByRole("heading", { name: "PEM-encoded public certificate" })).toBeVisible();
      await expect(page.getByText("BEGIN CERTIFICATE", { exact: false })).toBeVisible();
      expect((await gateway.send(new GetClientCertificatesCommand({}))).items).toEqual([expect.objectContaining({ description: "Browser backend certificate" })]);

      await page.goto(`${consoleUrl}#/apigateway/account-settings`);
      await expect(page.getByRole("heading", { name: "Account settings", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Account throttling" })).toBeVisible();
      await expect(page.getByText("UsagePlans", { exact: true })).toBeVisible();

      const api = await gateway.send(new CreateRestApiCommand({ name: "browser-documented-api", description: "APIG-13 documentation fixture" }));
      await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", description: "Documented browser deployment" }));
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/documentation`);
      await expect(page.getByRole("heading", { name: "Documentation parts (0)", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Create documentation part" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Location type").selectOption("API");
      await dialog.getByLabel("Properties (JSON)").fill('{"description":"Browser API documentation"}');
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByText("Browser API documentation", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Publish version" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Version").fill("browser-v1");
      await dialog.getByLabel("Description").fill("Browser publication");
      await dialog.getByLabel("Associate stage").selectOption("dev");
      await dialog.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.locator("tbody tr").filter({ hasText: "browser-v1" })).toContainText("dev");
      expect((await gateway.send(new GetDocumentationPartsCommand({ restApiId: api.id! }))).items).toEqual([expect.objectContaining({ location: expect.objectContaining({ type: "API" }) })]);
      expect((await gateway.send(new GetDocumentationVersionsCommand({ restApiId: api.id! }))).items).toEqual([expect.objectContaining({ version: "browser-v1" })]);
      expect((await gateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" }))).documentationVersion).toBe("browser-v1");

      const sdkCard = page.locator(".card").filter({ has: page.getByRole("heading", { name: "SDK generation" }) });
      const sdkBoundary = sdkCard.locator(":scope > .alert").filter({ hasText: "Language generator boundary" });
      await expect(sdkBoundary).toBeVisible();
      const sdkBoundarySpacing = await sdkBoundary.evaluate(element => {
        const alertBox = element.getBoundingClientRect();
        const cardBox = element.parentElement!.getBoundingClientRect();
        return {
          left: alertBox.left - cardBox.left,
          right: cardBox.right - alertBox.right,
        };
      });
      expect(sdkBoundarySpacing.left).toBeGreaterThanOrEqual(19);
      expect(sdkBoundarySpacing.right).toBeGreaterThanOrEqual(19);

      const downloadEvent = page.waitForEvent("download");
      await page.locator('button[data-generate-sdk="javascript"]').click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toContain("browser-documented-api-dev-javascript.zip");
      await expect(page.getByText("JavaScript SDK generated", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("heading", { name: "SDK generation" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });
});
