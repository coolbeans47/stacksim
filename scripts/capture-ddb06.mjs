import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient, UpdateTableReplicaAutoScalingCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb06-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let dynamodb;
try {
  await simulator.start(); dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  await dynamodb.send(new CreateTableCommand({ TableName: "LearningInventory", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 8, WriteCapacityUnits: 5 }, AttributeDefinitions: [{ AttributeName: "inventoryId", AttributeType: "S" }], KeySchema: [{ AttributeName: "inventoryId", KeyType: "HASH" }], TableClass: "STANDARD_INFREQUENT_ACCESS", DeletionProtectionEnabled: true, WarmThroughput: { ReadUnitsPerSecond: 120, WriteUnitsPerSecond: 60 }, SSESpecification: { Enabled: true, SSEType: "KMS", KMSMasterKeyId: "alias/learning-inventory" }, Tags: [{ Key: "environment", Value: "learning" }, { Key: "owner", Value: "platform-team" }, { Key: "cost-center", Value: "local-lab" }, { Key: "data-class", Value: "inventory" }] }));
  const scaling = { MinimumUnits: 2, MaximumUnits: 20, AutoScalingDisabled: false, ScalingPolicyUpdate: { PolicyName: "LearningInventory-target", TargetTrackingScalingPolicyConfiguration: { TargetValue: 70, DisableScaleIn: false, ScaleInCooldown: 30, ScaleOutCooldown: 15 } } };
  await dynamodb.send(new UpdateTableReplicaAutoScalingCommand({ TableName: "LearningInventory", ProvisionedWriteCapacityAutoScalingUpdate: scaling, ReplicaUpdates: [{ RegionName: "eu-west-1", ReplicaProvisionedReadCapacityAutoScalingUpdate: scaling }] }));
  const pages = [{ route: "capacity", output: "capacity" }, { route: "settings", output: "settings" }, { route: "tags", output: "tags" }]; browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-15/dynamodb/table-configuration", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#/dynamodb/tables/LearningInventory/${pageSpec.route}`); await page.locator("main").waitFor(); await page.getByRole("heading", { name: "LearningInventory" }).waitFor(); await page.waitForTimeout(200);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close();
    }
  }
} finally { dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
