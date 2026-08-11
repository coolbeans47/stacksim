import { expect, test, type Page, type Route } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateDBInstanceCommand, DeleteDBInstanceCommand, DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import mysql, { type Connection } from "mysql2/promise";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForAvailable(client: RDSClient, identifier: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === "available" && instance.Endpoint?.Address && instance.Endpoint.Port) return instance;
    if (instance?.DBInstanceStatus === "failed") throw new Error(instance.StatusInfos?.[0]?.Message ?? `RDS instance ${identifier} failed to start`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`RDS instance ${identifier} did not become available`);
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", message => { if (["error", "warning"].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()}`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

function tagListXml(tags: Record<string, string> = {}): string {
  return Object.entries(tags).map(([Key, Value]) => `<Tag><Key>${Key}</Key><Value>${Value}</Value></Tag>`).join("");
}

function parameterGroupXml(group: { name: string; description?: string }): string {
  return `<DBParameterGroup><DBParameterGroupName>${group.name}</DBParameterGroupName><DBParameterGroupFamily>mysql8.0</DBParameterGroupFamily><Description>${group.description ?? "Browser parameter group"}</Description><DBParameterGroupArn>arn:aws:rds:eu-west-1:000000000000:pg:${group.name}</DBParameterGroupArn></DBParameterGroup>`;
}

function parameterXml(parameter: { name: string; value: string; source?: string; applyType?: "dynamic" | "static"; modifiable?: boolean }): string {
  const applyType = parameter.applyType ?? "dynamic";
  return `<Parameter><ParameterName>${parameter.name}</ParameterName><ParameterValue>${parameter.value}</ParameterValue><Description>Browser-safe ${parameter.name}</Description><Source>${parameter.source ?? "engine-default"}</Source><ApplyType>${applyType}</ApplyType><DataType>${parameter.name === "collation_server" ? "string" : "integer"}</DataType><AllowedValues>${parameter.name === "collation_server" ? "utf8mb4_unicode_ci,utf8mb4_general_ci" : "10-1000"}</AllowedValues><IsModifiable>${parameter.modifiable ?? true}</IsModifiable><ApplyMethod>${applyType === "static" ? "pending-reboot" : "immediate"}</ApplyMethod></Parameter>`;
}

function instanceXml(instance?: Record<string, any>): string {
  if (!instance) return "";
  const status = instance.status ?? "available";
  const parameterGroup = instance.parameterGroup ?? "default.mysql8.0";
  const pending = instance.pendingPort || instance.pendingStorage || instance.pendingAllocated
    ? `<PendingModifiedValues>${instance.pendingPort ? `<Port>${instance.pendingPort}</Port>` : ""}${instance.pendingStorage ? `<StorageType>${instance.pendingStorage}</StorageType>` : ""}${instance.pendingAllocated ? `<AllocatedStorage>${instance.pendingAllocated}</AllocatedStorage>` : ""}</PendingModifiedValues>`
    : "<PendingModifiedValues></PendingModifiedValues>";
  return `<DBInstance><DBInstanceIdentifier>${instance.identifier}</DBInstanceIdentifier><DBInstanceClass>db.t3.micro</DBInstanceClass><Engine>mysql</Engine><DBInstanceStatus>${status}</DBInstanceStatus><MasterUsername>${instance.username}</MasterUsername><DBName>${instance.database}</DBName>${instance.endpoint === false ? "" : `<Endpoint><Address>127.0.0.1</Address><Port>${instance.port}</Port></Endpoint>`}<AllocatedStorage>${instance.allocatedStorage ?? 20}</AllocatedStorage><InstanceCreateTime>2026-07-19T12:00:00.000Z</InstanceCreateTime><BackupRetentionPeriod>0</BackupRetentionPeriod><AvailabilityZone>eu-west-1-local</AvailabilityZone><MultiAZ>false</MultiAZ><EngineVersion>8.0</EngineVersion><PubliclyAccessible>false</PubliclyAccessible><StorageType>${instance.storageType ?? "gp2"}</StorageType><DbiResourceId>db-BROWSERLOCAL</DbiResourceId><DBInstanceArn>arn:aws:rds:eu-west-1:000000000000:db:${instance.identifier}</DBInstanceArn><DeletionProtection>${instance.deletionProtection ?? false}</DeletionProtection><DBParameterGroups><DBParameterGroup><DBParameterGroupName>${parameterGroup}</DBParameterGroupName><ParameterApplyStatus>${instance.parameterStatus ?? "in-sync"}</ParameterApplyStatus></DBParameterGroup></DBParameterGroups>${pending}<TagList>${tagListXml(instance.tags ?? { team: "browser" })}</TagList></DBInstance>`;
}

function queryResponse(action: string, result: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>browser-rds-request</RequestId></ResponseMetadata></${action}Response>`;
}

test.describe("RDS console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("creates, inspects, and deletes the singleton without rendering its password", async ({ page }) => {
    let instance: Record<string, any> | undefined;
    let createInput: URLSearchParams | undefined;
    let deleteInput: URLSearchParams | undefined;
    const handleRds = async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST" || request.headers()["x-stacksim-service"] !== "rds") return route.continue();
      const input = new URLSearchParams(request.postData() ?? "");
      const action = input.get("Action") ?? "";
      let body: string;
      if (action === "DescribeDBInstances") body = queryResponse(action, `<DBInstances>${instanceXml(instance)}</DBInstances>`);
      else if (action === "DescribeAccountAttributes") body = queryResponse(action, `<AccountQuotas><AccountQuota><AccountQuotaName>DBInstances</AccountQuotaName><Used>${instance ? 1 : 0}</Used><Max>1</Max></AccountQuota></AccountQuotas>`);
      else if (action === "DescribeDBEngineVersions") body = queryResponse(action, "<DBEngineVersions><DBEngineVersion><Engine>mysql</Engine><EngineVersion>8.0.local</EngineVersion></DBEngineVersion></DBEngineVersions>");
      else if (action === "DescribeOrderableDBInstanceOptions") body = queryResponse(action, "<OrderableDBInstanceOptions><OrderableDBInstanceOption><DBInstanceClass>db.t3.micro</DBInstanceClass><Engine>mysql</Engine><EngineVersion>8.0.local</EngineVersion><StorageType>gp2</StorageType><MinStorageSize>20</MinStorageSize><MaxStorageSize>100</MaxStorageSize></OrderableDBInstanceOption></OrderableDBInstanceOptions>");
      else if (action === "DescribeDBParameterGroups") body = queryResponse(action, `<DBParameterGroups>${parameterGroupXml({ name: "default.mysql8.0", description: "Browser default" })}</DBParameterGroups>`);
      else if (action === "ListTagsForResource") body = queryResponse(action, `<TagList>${tagListXml(instance?.tags ?? { team: "browser" })}</TagList>`);
      else if (action === "CreateDBInstance") {
        createInput = input;
        instance = { identifier: input.get("DBInstanceIdentifier")!, username: input.get("MasterUsername")!, database: input.get("DBName")!, port: input.get("Port")!, parameterGroup: input.get("DBParameterGroupName")!, tags: { team: "browser" } };
        body = queryResponse(action, instanceXml(instance));
      } else if (action === "DeleteDBInstance") {
        deleteInput = input;
        const deleted = instanceXml(instance);
        instance = undefined;
        body = queryResponse(action, deleted);
      } else throw new Error(`Unexpected RDS action ${action}`);
      await route.fulfill({ status: 200, contentType: "text/xml; charset=utf-8", body });
    };
    await page.route(`http://127.0.0.1:${simulator.port}/`, handleRds);

    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/rds/databases`);
    await expect(page.getByRole("heading", { name: "No databases" })).toBeVisible();
    await page.getByRole("button", { name: "Create database" }).first().click();
    const create = page.getByRole("dialog");
    await create.getByLabel("DB instance identifier").fill("browser-db");
    await create.getByLabel("Initial database name").fill("app");
    await create.getByLabel("Master username").fill("developer");
    await create.getByLabel("Master password").fill("local-browser-secret");
    await create.getByLabel("Port").fill("13306");
    await create.getByLabel("Tags (JSON object)").fill('{"team":"browser"}');
    await create.getByRole("button", { name: "Create database" }).click();

    await expect(page).toHaveURL(/#\/rds\/databases\/browser-db\/connectivity$/);
    await expect(page.getByRole("heading", { name: "browser-db" })).toBeVisible();
    await expect(page.getByText("127.0.0.1:13306", { exact: true })).toBeVisible();
    await expect(page.getByText("local-browser-secret")).toHaveCount(0);
    expect(createInput?.get("Version")).toBe("2014-10-31");
    expect(createInput?.get("Engine")).toBe("mysql");
    expect(createInput?.get("PubliclyAccessible")).toBe("false");
    expect(createInput?.get("DBParameterGroupName")).toBe("default.mysql8.0");
    expect(createInput?.get("DeletionProtection")).toBe("false");
    expect(createInput?.get("Tags.Tag.1.Key")).toBe("team");
    expect(createInput?.get("Tags.Tag.1.Value")).toBe("browser");

    await page.getByRole("tab", { name: "Configuration" }).click();
    await expect(page.getByText("20 GiB descriptor", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Tags" }).click();
    await expect(page.getByRole("cell", { name: "team" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByLabel("Snapshot choice").selectOption("skip");
    await page.getByLabel(/To confirm, enter browser-db/).fill("browser-db");
    await page.getByRole("dialog").getByRole("button", { name: "Delete DB instance" }).click();
    await expect(page).toHaveURL(/#\/rds\/databases$/);
    await expect(page.getByRole("heading", { name: "No databases" })).toBeVisible();
    expect(deleteInput?.get("SkipFinalSnapshot")).toBe("true");
    expect(errors).toEqual([]);
  });

  test("operates daily lifecycle, pending changes, tags, and safe parameter groups", async ({ page }) => {
    test.setTimeout(60_000);
    const groups = new Map<string, { name: string; description: string }>([
      ["default.mysql8.0", { name: "default.mysql8.0", description: "Browser-safe defaults" }],
    ]);
    const groupTags = new Map<string, Record<string, string>>();
    const overrides = new Map<string, Record<string, { value: string; applyType: "dynamic" | "static" }>>();
    const captured = new Map<string, URLSearchParams[]>();
    const instance: Record<string, any> = {
      identifier: "browser-db",
      username: "developer",
      database: "app",
      port: "13306",
      status: "available",
      endpoint: true,
      parameterGroup: "default.mysql8.0",
      parameterStatus: "in-sync",
      deletionProtection: false,
      tags: { team: "browser", remove: "old" },
    };
    let transition: { states: string[]; complete?: () => void } | undefined;

    const definitions = [
      { name: "max_connections", value: "100", applyType: "dynamic" as const },
      { name: "collation_server", value: "utf8mb4_unicode_ci", applyType: "static" as const },
    ];
    const parametersFor = (groupName: string) => definitions.map(definition => {
      const override = overrides.get(groupName)?.[definition.name];
      return { ...definition, value: override?.value ?? definition.value, source: override ? "user" : "engine-default" };
    });
    const tagsFromInput = (input: URLSearchParams) => {
      const result: Record<string, string> = {};
      for (let index = 1; input.has(`Tags.Tag.${index}.Key`); index += 1) result[input.get(`Tags.Tag.${index}.Key`)!] = input.get(`Tags.Tag.${index}.Value`) ?? "";
      return result;
    };
    const record = (action: string, input: URLSearchParams) => captured.set(action, [...(captured.get(action) ?? []), input]);
    const transitionResponse = () => {
      if (!transition?.states.length) return;
      instance.status = transition.states.shift()!;
      if (!transition.states.length) {
        const complete = transition.complete;
        transition = undefined;
        complete?.();
      }
    };

    await page.route(`http://127.0.0.1:${simulator.port}/`, async route => {
      const request = route.request();
      if (request.method() !== "POST" || request.headers()["x-stacksim-service"] !== "rds") return route.continue();
      const input = new URLSearchParams(request.postData() ?? "");
      const action = input.get("Action") ?? "";
      record(action, input);
      let result = "";
      if (action === "DescribeDBInstances") {
        transitionResponse();
        result = `<DBInstances>${instanceXml(instance)}</DBInstances>`;
      } else if (action === "DescribeDBParameterGroups") {
        const requested = input.get("DBParameterGroupName");
        const listed = requested ? [groups.get(requested)].filter(Boolean) : [...groups.values()];
        result = `<DBParameterGroups>${listed.map(group => parameterGroupXml(group!)).join("")}</DBParameterGroups>`;
      } else if (action === "CreateDBParameterGroup") {
        const name = input.get("DBParameterGroupName")!;
        const group = { name, description: input.get("Description")! };
        groups.set(name, group);
        groupTags.set(name, tagsFromInput(input));
        result = parameterGroupXml(group);
      } else if (action === "DeleteDBParameterGroup") {
        groups.delete(input.get("DBParameterGroupName")!);
      } else if (action === "DescribeDBParameters" || action === "DescribeEngineDefaultParameters") {
        const groupName = action === "DescribeDBParameters" ? input.get("DBParameterGroupName")! : "default.mysql8.0";
        const values = action === "DescribeEngineDefaultParameters" ? definitions.map(value => ({ ...value, source: "engine-default" })) : parametersFor(groupName);
        const xml = values.map(parameterXml).join("");
        result = action === "DescribeEngineDefaultParameters" ? `<EngineDefaults><DBParameterGroupFamily>mysql8.0</DBParameterGroupFamily><Parameters>${xml}</Parameters></EngineDefaults>` : `<Parameters>${xml}</Parameters>`;
      } else if (action === "ModifyDBParameterGroup") {
        const groupName = input.get("DBParameterGroupName")!;
        const parameterName = input.get("Parameters.Parameter.1.ParameterName")!;
        const definition = definitions.find(candidate => candidate.name === parameterName)!;
        overrides.set(groupName, { ...(overrides.get(groupName) ?? {}), [parameterName]: { value: input.get("Parameters.Parameter.1.ParameterValue")!, applyType: definition.applyType } });
        result = `<DBParameterGroupName>${groupName}</DBParameterGroupName>`;
      } else if (action === "ResetDBParameterGroup") {
        const groupName = input.get("DBParameterGroupName")!;
        if (input.get("ResetAllParameters") === "true") overrides.delete(groupName);
        else {
          const parameterName = input.get("Parameters.Parameter.1.ParameterName")!;
          const next = { ...(overrides.get(groupName) ?? {}) };
          delete next[parameterName];
          overrides.set(groupName, next);
        }
        result = `<DBParameterGroupName>${groupName}</DBParameterGroupName>`;
      } else if (action === "ListTagsForResource") {
        const arn = input.get("ResourceName")!;
        const tags = arn.includes(":db:") ? instance.tags : groupTags.get(arn.split(":pg:")[1]) ?? {};
        result = `<TagList>${tagListXml(tags)}</TagList>`;
      } else if (action === "RemoveTagsFromResource") {
        const arn = input.get("ResourceName")!;
        const tags = arn.includes(":db:") ? instance.tags : groupTags.get(arn.split(":pg:")[1]) ?? {};
        for (let index = 1; input.has(`TagKeys.member.${index}`); index += 1) delete tags[input.get(`TagKeys.member.${index}`)!];
      } else if (action === "AddTagsToResource") {
        const arn = input.get("ResourceName")!;
        const target = arn.includes(":db:") ? instance.tags : groupTags.get(arn.split(":pg:")[1]) ?? {};
        Object.assign(target, tagsFromInput(input));
        if (!arn.includes(":db:")) groupTags.set(arn.split(":pg:")[1], target);
      } else if (action === "DescribeValidDBInstanceModifications") {
        result = "<ValidDBInstanceModificationsMessage><Storage><ValidStorageOptions><StorageType>gp2</StorageType></ValidStorageOptions><ValidStorageOptions><StorageType>gp3</StorageType></ValidStorageOptions></Storage></ValidDBInstanceModificationsMessage>";
      } else if (action === "ModifyDBInstance") {
        instance.pendingPort = input.get("DBPortNumber");
        instance.parameterGroup = input.get("DBParameterGroupName");
        instance.parameterStatus = "pending-reboot";
        instance.deletionProtection = input.get("DeletionProtection") === "true";
        result = instanceXml(instance);
      } else if (action === "RebootDBInstance") {
        instance.status = "rebooting";
        transition = { states: ["rebooting", "available"], complete: () => {
          if (instance.pendingPort) instance.port = instance.pendingPort;
          delete instance.pendingPort;
          instance.parameterStatus = "in-sync";
          instance.endpoint = true;
        } };
        result = instanceXml(instance);
      } else if (action === "StopDBInstance") {
        instance.status = "stopping";
        transition = { states: ["stopping", "stopped"], complete: () => { instance.endpoint = false; } };
        result = instanceXml(instance);
      } else if (action === "StartDBInstance") {
        instance.status = "starting";
        transition = { states: ["starting", "available"], complete: () => { instance.endpoint = true; } };
        result = instanceXml(instance);
      } else throw new Error(`Unexpected RDS-02 action ${action}`);
      await route.fulfill({ status: 200, contentType: "text/xml; charset=utf-8", body: queryResponse(action, result) });
    });

    const errors = browserErrors(page);

    await page.goto(`${consoleUrl}#/rds/parameter-groups`);
    await expect(page.getByRole("heading", { name: "Parameter groups", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create parameter group" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("browser-custom");
    await dialog.getByLabel("Description").fill("Browser custom parameters");
    await dialog.getByRole("button", { name: "Create parameter group" }).click();
    await expect(page).toHaveURL(/#\/rds\/parameter-groups\/browser-custom$/);
    await expect(page.getByRole("heading", { name: "browser-custom" })).toBeVisible();

    let row = page.getByRole("row").filter({ hasText: "max_connections" });
    await row.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Value").fill("250");
    await dialog.getByRole("button", { name: "Save parameter" }).click();
    row = page.getByRole("row").filter({ hasText: "max_connections" });
    await expect(row).toContainText("250");
    expect(captured.get("ModifyDBParameterGroup")?.at(-1)?.get("Parameters.Parameter.1.ApplyMethod")).toBe("immediate");

    await row.getByRole("button", { name: "Reset" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm/).fill("browser-custom");
    await dialog.getByRole("button", { name: "Reset parameter" }).click();
    await expect(page.getByRole("row").filter({ hasText: "max_connections" })).toContainText("engine-default");
    expect(captured.get("ResetDBParameterGroup")?.at(-1)?.get("Parameters.Parameter.1.ParameterName")).toBe("max_connections");

    row = page.getByRole("row").filter({ hasText: "collation_server" });
    await row.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/static value remains pending until reboot/i)).toBeVisible();
    await dialog.getByLabel("Value").fill("utf8mb4_general_ci");
    await dialog.getByRole("button", { name: "Save parameter" }).click();
    await expect(page.getByRole("row").filter({ hasText: "collation_server" })).toContainText("utf8mb4_general_ci");
    expect(captured.get("ModifyDBParameterGroup")?.at(-1)?.get("Parameters.Parameter.1.ApplyMethod")).toBe("pending-reboot");

    await page.goto(`${consoleUrl}#/rds/parameter-groups`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Parameter groups", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create parameter group" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("browser-delete");
    await dialog.getByLabel("Description").fill("Disposable browser group");
    await dialog.getByRole("button", { name: "Create parameter group" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm/).fill("browser-delete");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveURL(/#\/rds\/parameter-groups$/);
    await expect(page.getByRole("link", { name: "browser-delete" })).toHaveCount(0);

    await page.goto(`${consoleUrl}#/rds/databases/browser-db/configuration`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Port", { exact: true }).fill("14406");
    await dialog.getByLabel("New master password").fill("rotated-browser-secret");
    await dialog.getByLabel("DB parameter group").selectOption("browser-custom");
    await dialog.getByLabel("Enable deletion protection").check();
    await dialog.getByLabel("Apply descriptor and port changes immediately").uncheck();
    await dialog.getByRole("button", { name: "Modify DB instance" }).click();
    await expect(page.getByRole("heading", { name: "Pending modifications" })).toBeVisible();
    await expect(page.getByText("14406", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeDisabled();
    await expect(page.locator('dialog input[name="newMasterPassword"]')).toHaveValue("");
    await expect(page.getByText("rotated-browser-secret")).toHaveCount(0);
    const modify = captured.get("ModifyDBInstance")?.at(-1);
    expect(modify?.get("DBPortNumber")).toBe("14406");
    expect(modify?.get("ApplyImmediately")).toBe("false");
    expect(modify?.get("MasterUserPassword")).toBe("rotated-browser-secret");

    await page.getByRole("button", { name: "Reboot" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm/).fill("browser-db");
    await dialog.getByRole("button", { name: "Reboot" }).click();
    await expect(page.getByText("127.0.0.1:14406", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pending modifications" })).toHaveCount(0);

    await page.getByRole("button", { name: "Stop" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm/).fill("browser-db");
    await dialog.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("Listener stopped", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm/).fill("browser-db");
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(page.getByText("127.0.0.1:14406", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Tags" }).click();
    await page.getByRole("button", { name: "Manage tags" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tags (JSON object)").fill('{"team":"platform","environment":"development"}');
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(page.getByRole("cell", { name: "environment" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "remove" })).toHaveCount(0);
    expect(captured.get("RemoveTagsFromResource")?.at(-1)?.get("TagKeys.member.1")).toBe("remove");
    expect(captured.get("AddTagsToResource")?.at(-1)?.get("Tags.Tag.1.Key")).toBe("team");

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });

  test("creates a manual snapshot, restores it with a new credential, and takes a final snapshot", async ({ page }) => {
    test.setTimeout(90_000);
    const sourcePort = await freePort(); const restorePort = await freePort(); const sourcePassword = "BrowserSnapshotSource123"; const restoredPassword = "BrowserSnapshotRestore456";
    const client = new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    const errors = browserErrors(page);
    try {
      await client.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "browser-snapshot-source", DBInstanceClass: "db.t3.micro", Engine: "mysql", EngineVersion: "8.0", AllocatedStorage: 20, StorageType: "gp3", DBName: "browserdata", MasterUsername: "developer", MasterUserPassword: sourcePassword, Port: sourcePort, BackupRetentionPeriod: 0, PubliclyAccessible: false }));
      await waitForAvailable(client, "browser-snapshot-source");
      const source = await mysql.createConnection({ host: "127.0.0.1", port: sourcePort, user: "developer", password: sourcePassword, database: "browserdata" });
      await source.query("CREATE TABLE browser_rows (id INT AUTO_INCREMENT PRIMARY KEY, body VARCHAR(120) NOT NULL)"); await source.execute("INSERT INTO browser_rows (body) VALUES (?)", ["before browser snapshot"]); await source.end();

      await page.goto(`${consoleUrl}#/rds/databases/browser-snapshot-source/connectivity`);
      await page.getByRole("button", { name: "Take snapshot" }).click();
      const create = page.getByRole("dialog"); await create.getByLabel("DB snapshot identifier").fill("browser-before-change"); await create.getByLabel("Tags (JSON object)").fill('{"workflow":"browser"}'); await create.getByRole("button", { name: "Create snapshot" }).click();
      await expect(page).toHaveURL(/#\/rds\/snapshots$/); await expect(page.getByRole("cell", { name: "browser-before-change" })).toBeVisible(); await expect(page.getByText(/bytes · 1 file/)).toBeVisible();

      await client.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "browser-snapshot-source", SkipFinalSnapshot: true, DeleteAutomatedBackups: true }));
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) { try { await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "browser-snapshot-source" })); await new Promise(resolve => setTimeout(resolve, 50)); } catch { break; } }
      await page.getByRole("button", { name: "↻" }).click();
      const row = page.getByRole("row").filter({ hasText: "browser-before-change" }); await expect(row.getByRole("button", { name: "Restore" })).toBeEnabled(); await row.getByRole("button", { name: "Restore" }).click();
      const restore = page.getByRole("dialog"); await restore.getByLabel("New DB instance identifier").fill("browser-snapshot-restored"); await restore.getByLabel("Port").fill(String(restorePort)); await restore.getByLabel("New master username").fill("restoredadmin"); await restore.getByLabel("New master password").fill(restoredPassword); await restore.getByLabel("Tags (JSON object)").fill('{"identity":"restored"}'); await restore.getByRole("button", { name: "Restore snapshot" }).click();
      await expect(page).toHaveURL(/#\/rds\/databases\/browser-snapshot-restored\/connectivity$/); await waitForAvailable(client, "browser-snapshot-restored"); await page.getByRole("button", { name: "Refresh" }).click();
      const restored = await mysql.createConnection({ host: "127.0.0.1", port: restorePort, user: "restoredadmin", password: restoredPassword, database: "browserdata" }); assert.deepEqual((await restored.query("SELECT body FROM browser_rows"))[0], [{ body: "before browser snapshot" }]); await restored.end();

      await page.getByRole("button", { name: "Delete" }).click(); const deletion = page.getByRole("dialog"); await expect(deletion.getByLabel("Snapshot choice")).toHaveValue("final"); await deletion.getByLabel("Final DB snapshot identifier").fill("browser-final"); await deletion.getByLabel(/To confirm, enter browser-snapshot-restored/).fill("browser-snapshot-restored"); await deletion.getByRole("button", { name: "Delete DB instance" }).click();
      await expect(page).toHaveURL(/#\/rds\/databases$/); await page.goto(`${consoleUrl}#/rds/snapshots`); await expect(page.getByRole("cell", { name: "browser-final" })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390); expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("browses real shipping objects and runs SQL in the query editor", async ({ page }) => {
    test.setTimeout(60_000);
    const identifier = "shipping-query-db";
    const database = "shipping";
    const username = "developer";
    const password = "BrowserQueryEditorSecret123";
    const sqlPort = await freePort();
    const rdsClient = new RDSClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: "eu-west-1",
      credentials,
      maxAttempts: 1,
    });
    let connection: Connection | undefined;

    try {
      await rdsClient.send(new CreateDBInstanceCommand({
        DBInstanceIdentifier: identifier,
        DBInstanceClass: "db.t3.micro",
        Engine: "mysql",
        EngineVersion: "8.0",
        DBName: database,
        MasterUsername: username,
        MasterUserPassword: password,
        Port: sqlPort,
        AllocatedStorage: 20,
        StorageType: "gp3",
        BackupRetentionPeriod: 0,
        PubliclyAccessible: false,
      }));
      const instance = await waitForAvailable(rdsClient, identifier);
      connection = await mysql.createConnection({
        host: instance.Endpoint!.Address!,
        port: instance.Endpoint!.Port!,
        user: username,
        password,
        database,
        connectTimeout: 5_000,
      });
      await connection.execute("CREATE TABLE oil_tankers (imo_number VARCHAR(7) PRIMARY KEY, vessel_name VARCHAR(128) NOT NULL, tanker_class VARCHAR(32) NOT NULL, deadweight_tonnes INT NOT NULL)");
      await connection.execute("CREATE TABLE bills_of_lading (bill_number VARCHAR(32) PRIMARY KEY, tanker_imo VARCHAR(7) NOT NULL, oil_grade VARCHAR(64) NOT NULL, quantity_barrels INT NOT NULL, lifecycle_status VARCHAR(24) NOT NULL, CONSTRAINT fk_bill_tanker FOREIGN KEY (tanker_imo) REFERENCES oil_tankers(imo_number))");
      await connection.execute("INSERT INTO oil_tankers (imo_number, vessel_name, tanker_class, deadweight_tonnes) VALUES (?, ?, ?, ?)", ["9876543", "MT Northstar", "VLCC", 312_000]);
      await connection.execute("INSERT INTO oil_tankers (imo_number, vessel_name, tanker_class, deadweight_tonnes) VALUES (?, ?, ?, ?)", ["9765432", "MV Meridian", "Suezmax", 158_000]);
      await connection.execute("INSERT INTO bills_of_lading (bill_number, tanker_imo, oil_grade, quantity_barrels, lifecycle_status) VALUES (?, ?, ?, ?, ?)", ["BL-2026-001", "9876543", "Brent crude", 1_750_000, "DRAFT"]);
      await connection.execute("INSERT INTO bills_of_lading (bill_number, tanker_imo, oil_grade, quantity_barrels, lifecycle_status) VALUES (?, ?, ?, ?, ?)", ["BL-2026-002", "9765432", "Forties blend", 920_000, "REVIEW"]);

      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/rds/databases`);
      await expect(page.getByRole("link", { name: identifier })).toBeVisible();
      const queryEditorLink = page.locator(".page-header").getByRole("link", { name: "Query editor", exact: true });
      await expect(queryEditorLink).toBeVisible();
      await queryEditorLink.click();

      await expect(page.getByRole("heading", { name: "Query editor", exact: true })).toBeVisible();
      await expect(page.getByLabel("Database", { exact: true })).toHaveValue(database);
      const tankerObject = page.locator("[data-rds-object-entry]").filter({ hasText: "oil_tankers" });
      const billObject = page.locator("[data-rds-object-entry]").filter({ hasText: "bills_of_lading" });
      await expect(tankerObject).toBeVisible();
      await expect(billObject).toBeVisible();
      await tankerObject.locator("summary").click();
      await expect(tankerObject.getByText("imo_number", { exact: true })).toBeVisible();
      await expect(tankerObject.getByText("vessel_name", { exact: true })).toBeVisible();

      const editor = page.getByLabel("SQL", { exact: true });
      await editor.fill(`SELECT t.vessel_name AS tanker_name,
       b.bill_number,
       b.lifecycle_status,
       b.quantity_barrels
FROM oil_tankers AS t
JOIN bills_of_lading AS b ON b.tanker_imo = t.imo_number
ORDER BY b.bill_number;`);
      await editor.press("Control+Enter");

      const results = page.locator("[data-rds-query-results]");
      await expect(results.getByText("Succeeded", { exact: true })).toBeVisible();
      await expect(results.locator(".rds-query-status")).toContainText("2 rows");
      const grid = results.getByRole("table", { name: "Query results" });
      await expect(grid).toBeVisible();
      await expect(grid.getByRole("columnheader", { name: "tanker_name" })).toBeVisible();
      await expect(grid.getByRole("columnheader", { name: "bill_number" })).toBeVisible();
      await expect(grid.getByRole("columnheader", { name: "lifecycle_status" })).toBeVisible();
      await expect(grid.getByRole("columnheader", { name: "quantity_barrels" })).toBeVisible();
      await expect(grid.getByRole("cell", { name: "MT Northstar", exact: true })).toBeVisible();
      await expect(grid.getByRole("cell", { name: "BL-2026-001", exact: true })).toBeVisible();
      await expect(grid.getByRole("cell", { name: "MV Meridian", exact: true })).toBeVisible();
      await expect(grid.getByRole("cell", { name: "REVIEW", exact: true })).toBeVisible();
      await expect(grid.getByRole("row")).toHaveCount(3);

      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      if (connection) await connection.end().catch(() => undefined);
      rdsClient.destroy();
    }
  });

  test("shows installation-wide ownership guidance when another Region holds the singleton", async ({ page }) => {
    await page.route(`http://127.0.0.1:${simulator.port}/`, async route => {
      const request = route.request();
      if (request.method() !== "POST" || request.headers()["x-stacksim-service"] !== "rds") return route.continue();
      const input = new URLSearchParams(request.postData() ?? "");
      const action = input.get("Action") ?? "";
      const result = action === "DescribeDBInstances"
        ? "<DBInstances></DBInstances>"
        : action === "DescribeAccountAttributes"
          ? "<AccountQuotas><AccountQuota><AccountQuotaName>DBInstances</AccountQuotaName><Used>1</Used><Max>1</Max></AccountQuota></AccountQuotas>"
          : "";
      await route.fulfill({ status: 200, contentType: "text/xml; charset=utf-8", body: queryResponse(action, result) });
    });
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${consoleUrl}#/rds/databases`);
    await expect(page.getByText("The installation-wide DB slot is occupied")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create database" }).first()).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });

  test("explains RDS input panels and their StackSim support", async ({ page }) => {
    const instance = { identifier: "tooltip-db", username: "developer", database: "app", port: "13306", parameterGroup: "tooltip-parameters", tags: { environment: "browser" } };
    const defaultGroup = { name: "default.mysql8.0", description: "Provider defaults" };
    const customGroup = { name: "tooltip-parameters", description: "Tooltip parameter group" };
    const parameters = [
      { name: "max_connections", value: "100", applyType: "dynamic" as const },
      { name: "collation_server", value: "utf8mb4_unicode_ci", applyType: "static" as const },
    ];

    await page.route(`http://127.0.0.1:${simulator.port}/`, async route => {
      const request = route.request();
      if (request.method() !== "POST" || request.headers()["x-stacksim-service"] !== "rds") return route.continue();
      const input = new URLSearchParams(request.postData() ?? "");
      const action = input.get("Action") ?? "";
      let result = "";
      if (action === "DescribeDBInstances") result = `<DBInstances>${instanceXml(instance)}</DBInstances>`;
      else if (action === "DescribeAccountAttributes") result = "<AccountQuotas><AccountQuota><AccountQuotaName>DBInstances</AccountQuotaName><Used>1</Used><Max>1</Max></AccountQuota></AccountQuotas>";
      else if (action === "DescribeDBParameterGroups") {
        const requested = input.get("DBParameterGroupName");
        const groups = requested === customGroup.name ? [customGroup] : [defaultGroup, customGroup];
        result = `<DBParameterGroups>${groups.map(parameterGroupXml).join("")}</DBParameterGroups>`;
      } else if (action === "DescribeDBParameters") result = `<Parameters>${parameters.map(parameterXml).join("")}</Parameters>`;
      else if (action === "DescribeEngineDefaultParameters") result = `<EngineDefaults><DBParameterGroupFamily>mysql8.0</DBParameterGroupFamily><Parameters>${parameters.map(parameterXml).join("")}</Parameters></EngineDefaults>`;
      else if (action === "ListTagsForResource") result = `<TagList>${tagListXml({ environment: "browser" })}</TagList>`;
      else throw new Error(`Unexpected RDS tooltip action ${action}`);
      await route.fulfill({ status: 200, contentType: "text/xml; charset=utf-8", body: queryResponse(action, result) });
    });
    await page.route(`**/_stacksim/api/rds/query-editor/**`, async route => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        databases: ["app"],
        selectedDatabase: "app",
        objects: [{ type: "table", name: "orders", columns: [{ name: "id", dataType: "INTEGER", nullable: false }] }],
      }) });
    });

    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const expectHelp = async (title: string, supportText: string) => {
      const button = page.getByRole("button", { name: `About ${title}`, exact: true }).first();
      await expect(button).toBeVisible();
      await button.hover();
      const tooltip = button.locator("..").getByRole("tooltip");
      await expect(tooltip).toContainText(supportText);
      await expect(tooltip).toContainText("StackSim support");
      await page.mouse.move(385, 839);
      return tooltip;
    };

    await page.goto(`${consoleUrl}#/rds/databases`);
    await expectHelp("DB instances", "One installation-wide");

    await page.goto(`${consoleUrl}#/rds/databases/tooltip-db/configuration`);
    await expectHelp("Instance configuration", "compatibility descriptors");

    await page.goto(`${consoleUrl}#/rds/databases/tooltip-db/tags`);
    await expectHelp("Tags", "resource-tag authorization conditions");

    await page.goto(`${consoleUrl}#/rds/parameter-groups`);
    await expectHelp("DB parameter groups", "safe mysql8.0 family");

    await page.goto(`${consoleUrl}#/rds/parameter-groups/tooltip-parameters`);
    await expectHelp("Parameters", "six-parameter safe allowlist");
    await expectHelp("Tags", "resource-tag authorization conditions");

    await page.goto(`${consoleUrl}#/rds/query-editor/tooltip-db`);
    await expectHelp("Database objects", "tables, views, and columns");
    const queryTooltip = await expectHelp("SQL query", "fail-closed mysql8-orm-v1 data plane");
    await page.getByRole("button", { name: "About SQL query" }).hover();
    const tooltipBox = await queryTooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
