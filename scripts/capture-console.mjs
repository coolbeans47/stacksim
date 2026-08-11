import { chromium } from "@playwright/test";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../dist/src/server.js";

const artifactRoot = join(process.cwd(), "docs/ui-reference/2026-07-14/foundation");
const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "390x844", width: 390, height: 844 },
];
const dataDir = await mkdtemp(join(tmpdir(), "stacksim-console-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1" });
let browser;
let dynamodb;

function observeDiagnostics(page) {
  const diagnostics = [];
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") {
      const location = message.location();
      diagnostics.push(`${message.type()}: ${message.text()}${location.url ? ` (${location.url}:${location.lineNumber ?? 0})` : ""}`);
    }
  });
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => diagnostics.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown error"})`));
  page.on("response", response => {
    if (response.status() >= 400) diagnostics.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return diagnostics;
}

async function resetPointer(page, viewport) {
  await page.mouse.move(Math.max(1, viewport.width - 2), Math.max(45, viewport.height - 2));
}

async function capturePage(page, baseUrl, folder, hash, prepare) {
  await mkdir(join(artifactRoot, folder), { recursive: true });
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const captureUrl = `${baseUrl}?capture=${encodeURIComponent(`${folder}-${viewport.name}`)}`;
    await page.goto(`${captureUrl}#/home`);
    await page.locator("main h1").waitFor();
    await page.goto(`${captureUrl}${hash}`);
    await page.locator("main h1").waitFor();
    if (prepare) await prepare(page);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth }));
    if (dimensions.width !== viewport.width || dimensions.height !== viewport.height || dimensions.documentWidth !== viewport.width) {
      throw new Error(`${folder} did not fit ${viewport.name}: ${JSON.stringify(dimensions)}`);
    }
    await resetPointer(page, viewport);
    await page.screenshot({ path: join(artifactRoot, folder, `final-${viewport.name}.png`) });
  }
}

try {
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const baseUrl = `${endpoint}/_stacksim/console`;
  dynamodb = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  await dynamodb.send(new CreateTableCommand({
    TableName: "LearningNotes", BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  }));
  for (let index = 1; index <= 5; index++) await dynamodb.send(new PutItemCommand({
    TableName: "LearningNotes",
    Item: { id: { S: `note-${index}` }, title: { S: `Learning note ${index}` }, body: { S: "Foundation visual fixture" } },
  }));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const diagnostics = observeDiagnostics(page);

  await capturePage(page, baseUrl, "home", "#/home");
  await capturePage(page, baseUrl, "list", "#/dynamodb/tables");
  await capturePage(page, baseUrl, "create", "#/dynamodb/tables/create", async current => {
    const form = current.locator("#create-table-form");
    await form.getByLabel("Table name").fill("Music");
    await form.getByLabel("Partition key", { exact: true }).fill("Artist");
    await form.getByLabel("Sort key", { exact: true }).fill("SongTitle");
  });
  await capturePage(page, baseUrl, "details", "#/dynamodb/tables/LearningNotes/overview");
  await capturePage(page, baseUrl, "error", "#/not-found");

  for (let index = 1; index <= 55; index++) await dynamodb.send(new PutItemCommand({
    TableName: "LearningNotes",
    Item: {
      id: { S: `dense-${String(index).padStart(3, "0")}` },
      title: { S: `Learning note ${index} with a deliberately descriptive title` },
      body: { S: "Dense table visual verification" },
      reference: { S: `arn:aws:dynamodb:eu-west-1:000000000000:table/LearningNotes/item/dense-${index}` },
    },
  }));
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const captureUrl = `${baseUrl}?capture=${encodeURIComponent(`dense-${viewport.name}`)}`;
    await page.goto(`${captureUrl}#/home`);
    await page.locator("main h1").waitFor();
    await page.goto(`${captureUrl}#/dynamodb/tables/LearningNotes/items`);
    await page.getByLabel("Page size").selectOption("100");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.locator("#item-result-summary").filter({ hasText: "60 matched" }).waitFor();
    const itemsScroller = page.locator("#items-table .table-wrap").first();
    await itemsScroller.scrollIntoViewIfNeeded();
    const containment = await itemsScroller.evaluate(container => {
      const rect = container.getBoundingClientRect();
      const overflowX = getComputedStyle(container).overflowX;
      const originalScrollLeft = container.scrollLeft;
      const maximumScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      if (maximumScrollLeft > 0) container.scrollLeft = Math.min(1, maximumScrollLeft);
      const canScrollHorizontally = maximumScrollLeft === 0 || container.scrollLeft > 0;
      container.scrollLeft = originalScrollLeft;
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        left: rect.left,
        right: rect.right,
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
        maximumScrollLeft,
        overflowX,
        canScrollHorizontally,
      };
    });
    const insideViewport = containment.left >= -0.5 && containment.right <= containment.viewportWidth + 0.5;
    const ownsHorizontalOverflow = ["auto", "scroll", "overlay"].includes(containment.overflowX);
    if (containment.documentWidth !== viewport.width || !insideViewport || !ownsHorizontalOverflow || !containment.canScrollHorizontally) {
      throw new Error(`dense table containment failed at ${viewport.name}: ${JSON.stringify(containment)}`);
    }
    if (viewport.width === 390 && containment.maximumScrollLeft <= 0) {
      throw new Error(`dense table did not expose its expected narrow horizontal scroller at ${viewport.name}: ${JSON.stringify(containment)}`);
    }
    await resetPointer(page, viewport);
    await page.screenshot({ path: join(artifactRoot, "list", `dense-${viewport.name}.png`) });
    if (containment.maximumScrollLeft > 0) {
      const rightEdge = await itemsScroller.evaluate(container => {
        container.scrollLeft = container.scrollWidth - container.clientWidth;
        return {
          scrollLeft: container.scrollLeft,
          maximumScrollLeft: Math.max(0, container.scrollWidth - container.clientWidth),
          tableRight: container.querySelector("table")?.getBoundingClientRect().right,
          containerRight: container.getBoundingClientRect().right,
        };
      });
      if (Math.abs(rightEdge.scrollLeft - rightEdge.maximumScrollLeft) > 1 || rightEdge.tableRight === undefined || Math.abs(rightEdge.tableRight - rightEdge.containerRight) > 1.5) {
        throw new Error(`dense table right edge was not reachable at ${viewport.name}: ${JSON.stringify(rightEdge)}`);
      }
      await resetPointer(page, viewport);
      await page.screenshot({ path: join(artifactRoot, "list", `dense-right-edge-${viewport.name}.png`) });
    }
  }

  await dynamodb.send(new DeleteTableCommand({ TableName: "LearningNotes" }));
  await capturePage(page, baseUrl, "empty", "#/dynamodb/tables");
  if (diagnostics.length) throw new Error(`Browser diagnostics were emitted:\n${diagnostics.join("\n")}`);
  console.log(`Captured FND-02 final states under ${artifactRoot}`);
} finally {
  dynamodb?.destroy();
  await browser?.close();
  await simulator.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

await import("./capture-iam-default-admin.mjs");
