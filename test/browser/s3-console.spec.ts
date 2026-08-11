import { expect, test, type Page } from "@playwright/test";
import { CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectAclCommand, ListMultipartUploadsCommand, ListObjectVersionsCommand, PutBucketOwnershipControlsCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function sdkOptions(target: StackSim) {
  return { endpoint: `http://127.0.0.1:${target.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
}

async function createNotificationQueue(sqs: SQSClient, bucket: string, name: string) {
  const created = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  const QueueUrl = created.QueueUrl!;
  const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }));
  const arn = attributes.Attributes!.QueueArn!;
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sqs:SendMessage", Resource: arn, Condition: { ArnEquals: { "aws:SourceArn": `arn:aws:s3:::${bucket}` }, StringEquals: { "aws:SourceAccount": simulator.store.accountId } } }] }) } }));
  return arn;
}

function browserErrors(page: Page): string[] {
  const errors: string[] = []; page.on("pageerror", error => errors.push(`pageerror: ${error.message}`)); page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()}`)); page.on("response", response => { if (response.status() >= 400 && !(response.status() === 404 && (/[?&](?:website|policy)(?:[=&]|$)/.test(response.url()) || response.url().includes("/v20180820/configuration/publicAccessBlock")))) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); }); return errors;
}

test.describe("S3-01 through S3-08 console", () => {
  test.beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-console-")); simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off", cdkBootstrap: false }); await simulator.start(); consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`; });
  test.afterEach(async ({ page }) => { await page.close(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); });

  test("creates a bucket, uploads and previews an object, and manages version history", async ({ page }) => {
    const errors = browserErrors(page); await page.goto(`${consoleUrl}#/s3/buckets`); await expect(page.getByRole("heading", { name: "General purpose buckets" })).toBeVisible(); await expect(page.getByRole("heading", { name: "No buckets" })).toBeVisible();
    await page.getByRole("button", { name: "Create bucket" }).first().click(); const create = page.getByRole("dialog"); await create.getByLabel("Bucket name").fill("browser-s3-learning"); await create.getByRole("button", { name: "Create bucket" }).click(); await expect(page).toHaveURL(/#\/s3\/buckets\/browser-s3-learning\/objects$/); await expect(page.getByRole("heading", { name: "browser-s3-learning" })).toBeVisible();
    await page.getByRole("button", { name: "Upload" }).first().click(); const upload = page.getByRole("dialog"); await upload.getByLabel("File").setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("first version") }); await upload.getByLabel("Destination key").fill("notes/hello.txt"); await upload.getByRole("button", { name: "Upload" }).click(); await page.getByRole("link", { name: /notes\// }).click(); await expect(page.getByRole("link", { name: "hello.txt" })).toBeVisible();
    await page.getByRole("button", { name: "Preview" }).click(); await expect(page.getByRole("dialog")).toContainText("first version"); await page.locator("#modal-submit").click();
    await page.getByRole("tab", { name: "Properties" }).click(); await page.getByRole("button", { name: "Enable" }).click(); await expect(page.getByText("Enabled", { exact: true })).toBeVisible(); await page.getByRole("tab", { name: "Objects" }).click();
    await page.getByRole("button", { name: "Upload" }).first().click(); const overwrite = page.getByRole("dialog"); await overwrite.getByLabel("File").setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("second version") }); await overwrite.getByLabel("Destination key").fill("notes/hello.txt"); await overwrite.getByRole("button", { name: "Upload" }).click();
    await page.getByRole("link", { name: /notes\// }).click(); await page.getByRole("link", { name: "hello.txt" }).click();
    await expect(page).toHaveURL(/\/object\/notes%2Fhello.txt\/properties$/); await expect(page.getByRole("heading", { name: "Object overview" })).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "Governance" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Versions" }).click(); await expect(page.getByRole("row")).toHaveCount(3); await page.getByRole("button", { name: "Restore this version" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click(); await expect(page.getByRole("row")).toHaveCount(4);
    await page.getByRole("link", { name: "notes/" }).click(); await page.getByRole("button", { name: "Copy" }).first().click(); const copy = page.getByRole("dialog"); await copy.getByLabel("Destination key").fill("notes/copied.txt"); await copy.getByLabel("Metadata", { exact: true }).selectOption("REPLACE"); await copy.getByLabel("Replacement metadata (JSON)").fill('{"edited":"yes"}'); await copy.getByLabel("Replacement content type").fill("text/plain"); await copy.getByRole("button", { name: "Copy" }).click();
    await page.getByRole("link", { name: "copied.txt" }).click(); await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible(); await page.getByText("Presigned URL guidance", { exact: true }).click(); await expect(page.getByText("Secret keys are used to sign locally", { exact: false })).toBeVisible(); await page.getByRole("link", { name: "notes/" }).click();
    await page.getByRole("checkbox", { name: "Select notes/copied.txt" }).check(); await page.getByRole("button", { name: "Delete selected" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click(); await expect(page.getByRole("link", { name: "copied.txt" })).not.toBeVisible(); await expect(page.locator("#toast-region")).toContainText("1 deleted");
    await page.getByRole("tab", { name: "Management" }).click(); await expect(page.getByRole("heading", { name: "No incomplete uploads" })).toBeVisible(); expect(errors).toEqual([]);
  });

  test("object routes preserve unusual keys and expose version-scoped ACL permissions", async ({ page }) => {
    const errors = browserErrors(page); const bucket = "browser-s3-object-details"; const key = "folder/a #?% ✓.txt";
    await page.goto(`${consoleUrl}#/s3/buckets`); await page.getByRole("button", { name: "Create bucket" }).first().click(); await page.getByLabel("Bucket name").fill(bucket); await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();
    const s3 = new S3Client(sdkOptions(simulator));
    try {
      await s3.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] } }));
      await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "first" })); await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "second" })); await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}-extra`, Body: "sibling" }));
      await page.goto(`${consoleUrl}#/s3/buckets/${bucket}/objects/${encodeURIComponent("folder/")}`); await page.getByRole("link", { name: "a #?% ✓.txt", exact: true }).click();
      await expect(page).toHaveURL(/\/object\/folder%2Fa%20%23%3F%25%20%E2%9C%93\.txt\/properties$/); await expect(page.getByRole("link", { name: "folder/" })).toHaveAttribute("href", `#/s3/buckets/${bucket}/objects/folder%2F`);
      await page.getByRole("tab", { name: "Permissions" }).click(); await expect(page.getByText("ACLs enabled", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Edit" }).click(); await page.getByLabel("Canned object ACL").selectOption("public-read"); await page.getByLabel(/I acknowledge that this ACL/).check(); await page.getByLabel("Type the bucket name to confirm").fill(bucket); await page.getByRole("button", { name: "Save ACL" }).click();
      await expect(page.getByText("Everyone (public access)", { exact: true })).toBeVisible(); expect((await s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: key }))).Grants?.some(grant => grant.Grantee?.URI?.endsWith("/AllUsers") && grant.Permission === "READ")).toBe(true);
      await page.getByRole("tab", { name: "Versions" }).click(); await expect(page.locator(".s3-object-version-table tbody tr")).toHaveCount(2); await expect(page.locator(".s3-object-version-table")).not.toContainText("-extra");
    } finally { s3.destroy(); }
    expect(errors).toEqual([]);
  });

  test("selects, empties, and deletes a bucket from the bucket list with permanent-action warnings", async ({ page }) => {
    const errors = browserErrors(page);
    const bucket = "s3eventbridgeauditstack-learningbucket31486d4a-35b8f6baf7bd";
    await page.goto(`${consoleUrl}#/s3/buckets`);
    await page.getByRole("button", { name: "Create bucket" }).first().click();
    await page.getByLabel("Bucket name").fill(bucket);
    await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();

    const s3 = new S3Client(sdkOptions(simulator));
    try {
      await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "hidden.txt", Body: "first" }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "hidden.txt", Body: "second" }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "hidden.txt" }));
      await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: "unfinished.bin" }));

      await page.goto(`${consoleUrl}#/s3/buckets`);
      await expect(page.getByRole("button", { name: "Empty" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
      await page.getByRole("radio", { name: `Select ${bucket}` }).check();
      await expect(page.getByText(`1 bucket selected: ${bucket}`)).toBeVisible();

      await page.getByRole("button", { name: "Empty" }).click();
      let dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("All objects, object versions, and delete markers");
      await expect(dialog).toContainText("This action cannot be undone");
      await dialog.getByLabel(/To confirm emptying the bucket/).fill("permanently delete");
      await dialog.getByRole("button", { name: "Empty" }).click();
      await expect(page.locator("#toast-region")).toContainText(/Bucket emptied: \d+ object versions deleted; 1 multipart upload aborted/);
      expect((await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }))).Versions).toBeUndefined();
      expect((await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }))).DeleteMarkers).toBeUndefined();
      expect((await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads).toBeUndefined();

      await page.getByRole("radio", { name: `Select ${bucket}` }).check();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("The bucket must be empty, including all object versions");
      await dialog.getByLabel(/To confirm deletion/).fill(bucket);
      await dialog.getByRole("button", { name: "Delete bucket" }).click();
      await expect(page.getByRole("link", { name: bucket })).not.toBeVisible();
    } finally {
      s3.destroy();
    }
    expect(errors).toEqual([]);
  });

  test("large browser uploads use multipart and leave no incomplete upload", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = browserErrors(page); await page.goto(`${consoleUrl}#/s3/buckets`); await page.getByRole("button", { name: "Create bucket" }).first().click(); await page.getByLabel("Bucket name").fill("browser-s3-multipart"); await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click(); await page.getByRole("button", { name: "Upload" }).first().click(); const upload = page.getByRole("dialog"); await upload.getByLabel("File").setInputFiles({ name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(6 * 1024 * 1024, 3) }); await upload.getByLabel("Destination key").fill("large.bin"); await upload.getByRole("button", { name: "Upload" }).click(); await expect(page.getByRole("link", { name: "large.bin" })).toBeVisible(); await page.getByRole("tab", { name: "Management" }).click(); await expect(page.getByRole("heading", { name: "No incomplete uploads" })).toBeVisible(); expect(errors).toEqual([]);
  });

  test("properties manages static website hosting and displays the bucket website endpoint", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/s3/buckets`);
    await page.getByRole("button", { name: "Create bucket" }).first().click();
    await page.getByLabel("Bucket name").fill("browser-s3-website");
    await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();
    await page.getByRole("tab", { name: "Properties" }).click();
    const card = page.locator(".s3-static-website-hosting");
    await expect(card.getByRole("heading", { name: "Static website hosting" })).toBeVisible();
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Edit" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Enable").check();
    await dialog.getByLabel("Index document").fill("home.html");
    await dialog.getByLabel(/Error document/).fill("error.html");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const endpoint = `${consoleUrl.replace("/_stacksim/console", "")}/_stacksim/s3-website/browser-s3-website/`;
    await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(card.getByText("home.html", { exact: true })).toBeVisible();
    await expect(card.getByText("error.html", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: endpoint })).toHaveAttribute("href", endpoint);
    await card.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Disable").check();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: endpoint })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("event notification CRUD preserves every configuration and the bucket-wide EventBridge setting", async ({ page }) => {
    const errors = browserErrors(page); const bucket = "browser-s3-notifications";
    await page.goto(`${consoleUrl}#/s3/buckets`);
    await page.getByRole("button", { name: "Create bucket" }).first().click();
    await page.getByLabel("Bucket name").fill(bucket);
    await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();
    await page.getByRole("tab", { name: "Properties" }).click();

    const notifications = page.locator(".s3-event-notifications");
    const eventBridge = page.locator(".s3-eventbridge-notifications");
    await expect(notifications.getByRole("heading", { name: /Event notifications/ })).toBeVisible();
    await expect(notifications.getByRole("heading", { name: "No event notifications" })).toBeVisible();
    await expect(eventBridge.getByRole("heading", { name: "Amazon EventBridge" })).toBeVisible();
    await expect(eventBridge.getByText("Disabled", { exact: true })).toBeVisible();

    const sqs = new SQSClient(sdkOptions(simulator));
    let uploadsArn: string;
    let tagsArn: string;
    try {
      uploadsArn = await createNotificationQueue(sqs, bucket, "browser-s3-uploads");
      tagsArn = await createNotificationQueue(sqs, bucket, "browser-s3-tags");
    } finally {
      sqs.destroy();
    }

    await notifications.getByRole("button", { name: "Create event notification" }).first().click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Destination permission required", { exact: true })).toBeVisible();
    await dialog.getByLabel("Configuration ID").fill("uploads-created");
    await dialog.getByLabel("Destination type").selectOption("queue");
    await dialog.getByLabel("Destination ARN").fill(uploadsArn);
    await dialog.getByLabel("s3:ObjectCreated:Put", { exact: true }).check();
    await dialog.getByLabel("s3:ObjectRemoved:Delete", { exact: true }).check();
    await dialog.getByLabel(/Prefix/).fill("incoming/&");
    await dialog.getByLabel(/Suffix/).fill(".json");
    await dialog.getByRole("button", { name: "Create event notification" }).click();
    await expect(notifications.getByText("uploads-created", { exact: true })).toBeVisible();
    await expect(notifications.getByText(uploadsArn, { exact: true })).toBeVisible();
    await expect(notifications.getByText("s3:ObjectCreated:Put", { exact: true })).toBeVisible();
    await expect(notifications.getByText("s3:ObjectRemoved:Delete", { exact: true })).toBeVisible();
    await expect(notifications.getByText("incoming/&", { exact: true })).toBeVisible();
    await expect(notifications.getByText(".json", { exact: true })).toBeVisible();

    await notifications.getByRole("button", { name: "Create event notification" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Configuration ID").fill("tag-updates");
    await dialog.getByLabel("Destination type").selectOption("queue");
    await dialog.getByLabel("Destination ARN").fill(tagsArn);
    await dialog.getByLabel("s3:ObjectTagging:Put", { exact: true }).check();
    await dialog.getByLabel(/Prefix/).fill("archive/");
    await dialog.getByLabel(/Suffix/).fill(".txt");
    await dialog.getByRole("button", { name: "Create event notification" }).click();
    await expect(notifications.getByText("uploads-created", { exact: true })).toBeVisible();
    await expect(notifications.getByText("tag-updates", { exact: true })).toBeVisible();
    await expect(notifications.getByText(tagsArn, { exact: true })).toBeVisible();

    await eventBridge.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Publish events to Amazon EventBridge").check();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(eventBridge.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(notifications.getByText("uploads-created", { exact: true })).toBeVisible();
    await expect(notifications.getByText("tag-updates", { exact: true })).toBeVisible();

    await notifications.getByRole("button", { name: "Edit uploads-created" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Configuration ID")).toHaveValue("uploads-created");
    await expect(dialog.getByLabel("Destination ARN")).toHaveValue(uploadsArn);
    await expect(dialog.getByLabel("s3:ObjectCreated:Put", { exact: true })).toBeChecked();
    await expect(dialog.getByLabel("s3:ObjectRemoved:Delete", { exact: true })).toBeChecked();
    await expect(dialog.getByLabel(/Prefix/)).toHaveValue("incoming/&");
    await expect(dialog.getByLabel(/Suffix/)).toHaveValue(".json");
    await dialog.getByLabel("Configuration ID").fill("uploads-v2");
    await dialog.getByLabel("s3:ObjectRemoved:Delete", { exact: true }).uncheck();
    await dialog.getByLabel("s3:ObjectCreated:Copy", { exact: true }).check();
    await dialog.getByLabel(/Prefix/).fill("processed/<");
    await dialog.getByLabel(/Suffix/).fill(".csv");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(notifications.getByText("uploads-v2", { exact: true })).toBeVisible();
    await expect(notifications.getByText("tag-updates", { exact: true })).toBeVisible();
    await expect(notifications.getByText("s3:ObjectCreated:Copy", { exact: true })).toBeVisible();
    await expect(notifications.getByText("processed/<", { exact: true })).toBeVisible();
    await expect(eventBridge.getByText("Enabled", { exact: true })).toBeVisible();

    await notifications.getByRole("button", { name: "Edit uploads-v2" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Configuration ID").fill("tag-updates");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("#toast-region").getByRole("alert")).toContainText("already exists");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Configuration ID")).toHaveValue("tag-updates");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.reload();
    await expect(notifications.getByText("uploads-v2", { exact: true })).toBeVisible();
    await expect(notifications.getByText("tag-updates", { exact: true })).toBeVisible();
    await expect(notifications.getByText("s3:ObjectCreated:Put", { exact: true })).toBeVisible();
    await expect(notifications.getByText("s3:ObjectCreated:Copy", { exact: true })).toBeVisible();
    await expect(eventBridge.getByText("Enabled", { exact: true })).toBeVisible();

    await eventBridge.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Publish events to Amazon EventBridge").uncheck();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(eventBridge.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(notifications.getByText("uploads-v2", { exact: true })).toBeVisible();
    await expect(notifications.getByText("tag-updates", { exact: true })).toBeVisible();
    await eventBridge.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog").getByLabel("Publish events to Amazon EventBridge").check();
    await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();

    await notifications.getByRole("button", { name: "Delete uploads-v2" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion/).fill("uploads-v2");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(notifications.getByText("uploads-v2", { exact: true })).not.toBeVisible();
    await expect(notifications.getByText("tag-updates", { exact: true })).toBeVisible();
    await expect(eventBridge.getByText("Enabled", { exact: true })).toBeVisible();

    await notifications.getByRole("button", { name: "Delete tag-updates" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion/).fill("tag-updates");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(notifications.getByRole("heading", { name: "No event notifications" })).toBeVisible();
    await expect(eventBridge.getByText("Enabled", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("permissions manages policy, ownership, ACL, public access, Requester Pays, and ABAC", async ({ page }) => {
    const errors = browserErrors(page); const bucket = "browser-s3-permissions";
    await page.goto(`${consoleUrl}#/s3/buckets`);
    await page.getByRole("button", { name: "Create bucket" }).first().click();
    await page.getByLabel("Bucket name").fill(bucket);
    await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();
    await page.getByRole("tab", { name: "Permissions" }).click();
    await expect(page.getByRole("heading", { name: "Block public access (bucket settings)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Access findings" })).toBeVisible();
    await expect(page.getByText(/not IAM Access Analyzer results/)).toBeVisible();
    await expect(page.getByText("BucketOwnerEnforced", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Access control list (ACL)" }).locator("xpath=ancestor::section[1]").getByText("Disabled", { exact: true })).toBeVisible();

    await page.getByRole("heading", { name: "Bucket policy" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Policy JSON").fill(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }, null, 2));
    await dialog.getByLabel(/this policy can grant public/).check();
    await dialog.getByLabel("Type the bucket name to confirm").fill(bucket);
    await dialog.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Public", { exact: true })).toBeVisible();

    await page.getByRole("heading", { name: "Object Ownership" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog"); await dialog.getByLabel("Object Ownership").selectOption("ObjectWriter"); await dialog.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("heading", { name: "Access control list (ACL)" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog"); await dialog.getByLabel("Canned ACL").selectOption("public-read"); await dialog.getByLabel(/a public ACL can expose data/).check(); await dialog.getByLabel(/Type the bucket name/).fill(bucket); await dialog.getByRole("button", { name: "Save ACL" }).click();
    await expect(page.getByText(/AllUsers/)).toBeVisible();

    await page.getByRole("heading", { name: "Block public access (bucket settings)" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog"); for (const name of ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]) await dialog.getByLabel(name).check(); await dialog.getByLabel(/disabling protections can make data public/).check(); await dialog.getByLabel("Type the bucket name to confirm").fill(bucket); await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("All effective protections are enabled")).toBeVisible();

    await page.getByRole("heading", { name: "Requester Pays" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog"); await dialog.getByLabel("Payer").selectOption("Requester"); await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Requester Pays", exact: true }).locator("xpath=ancestor::section[1]")).toContainText("Requester");
    await page.getByRole("heading", { name: "Attribute-based access control (ABAC)" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog"); await dialog.getByLabel("Status").selectOption("Enabled"); await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Attribute-based access control (ABAC)", exact: true }).locator("xpath=ancestor::section[1]")).toContainText("Enabled");
    await page.getByRole("heading", { name: "Bucket policy" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Delete" }).click();
    await page.getByLabel(/To confirm deletion/).fill(bucket); await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No bucket policy is configured.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("manages governance, lifecycle, EventBridge notifications, and delivery health", async ({ page }) => {
    const errors = browserErrors(page); const bucket = "browser-s3-governance";
    await page.goto(`${consoleUrl}#/s3/buckets`);
    await page.getByRole("button", { name: "Create bucket" }).first().click();
    await page.getByLabel("Bucket name").fill(bucket);
    await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();

    await page.getByRole("tab", { name: "Properties" }).click();
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await page.locator(".s3-governance").getByRole("button", { name: "Configure Object Lock" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Enable", exact: true }).click();
    await page.locator(".s3-governance").getByRole("button", { name: "Edit tags" }).click();
    await page.getByRole("dialog").getByLabel("One key=value per line").fill("team=platform");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    const eventCard = page.locator(".s3-eventbridge-notifications");
    await eventCard.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog").getByLabel("Publish events to Amazon EventBridge").check();
    await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
    await expect(eventCard.getByText("Enabled", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Objects" }).click();
    await page.getByRole("button", { name: "Upload" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("File").setInputFiles({ name: "governed.txt", mimeType: "text/plain", buffer: Buffer.from("governed") });
    await dialog.getByLabel("Destination key").fill("governed.txt");
    await dialog.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("button", { name: "Governance" })).toHaveCount(0);
    await page.getByRole("link", { name: "governed.txt" }).click();
    await expect(page.getByRole("heading", { name: "Object overview" })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await page.getByLabel("Tag key").fill("stage"); await page.getByLabel("Tag value").fill("locked"); await page.getByRole("button", { name: "Save tags" }).click();
    await page.getByRole("button", { name: "Create annotation" }).click(); await page.getByLabel("Annotation name").fill("review"); await page.getByLabel("UTF-8 annotation payload").fill("approved"); await page.getByRole("button", { name: "Save annotation" }).click();
    await expect(page.getByText("review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add retention" }).click(); await page.getByLabel("Retention mode").selectOption("GOVERNANCE"); await page.getByLabel("Retain until").fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16)); await page.getByRole("button", { name: "Save retention" }).click();
    await page.getByRole("heading", { name: "Legal hold" }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Edit" }).click(); await page.getByLabel("Legal hold", { exact: true }).selectOption("ON"); await page.getByRole("button", { name: "Save legal hold" }).click();
    await expect(page.getByRole("heading", { name: "Object Lock retention" }).locator("xpath=ancestor::section[1]")).toContainText("GOVERNANCE"); await expect(page.getByRole("heading", { name: "Legal hold" }).locator("xpath=ancestor::section[1]")).toContainText("On"); await expect(page.getByRole("button", { name: "Create annotation" })).toBeDisabled();
    await page.getByRole("tab", { name: "Permissions" }).click(); await expect(page.getByText("ACLs disabled", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: bucket, exact: true }).click();
    await page.getByRole("tab", { name: "Management" }).click();
    await page.getByRole("button", { name: "Create rule" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Lifecycle XML").fill(`<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>archive-later</ID><Filter><Prefix>archive/</Prefix></Filter><Status>Enabled</Status><Transition><Days>30</Days><StorageClass>GLACIER</StorageClass></Transition></Rule></LifecycleConfiguration>`);
    await dialog.getByRole("button", { name: "Save rules" }).click();
    await expect(page.locator(".s3-lifecycle-rules")).toContainText("archive-later");
    await page.getByRole("tab", { name: "Metrics" }).click();
    await expect(page.getByRole("heading", { name: "Pending notifications" })).toBeVisible();
    await expect(page.getByText("Payloads are never shown")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("explains editable S3 panels and their StackSim support", async ({ page }) => {
    const errors = browserErrors(page);
    const bucket = "browser-s3-panel-help";
    const s3 = new S3Client(sdkOptions(simulator));
    try {
      await page.goto(`${consoleUrl}#/s3/buckets`);
      await expect(page.getByRole("button", { name: "About Buckets" })).toBeVisible();
      await page.getByRole("button", { name: "Create bucket" }).first().click();
      await page.getByLabel("Bucket name").fill(bucket);
      await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click();
      await expect(page.getByRole("button", { name: "About Objects" })).toBeVisible();

      await page.getByRole("tab", { name: "Properties" }).click();
      for (const label of ["Bucket Versioning", "Static website hosting", "Data governance", "Event notifications", "Amazon EventBridge"]) {
        await expect(page.getByRole("button", { name: `About ${label}` })).toBeVisible();
      }
      await page.getByRole("button", { name: "About Data governance" }).hover();
      const governanceHelp = page.locator(".panel-help-tooltip:visible");
      await expect(governanceHelp).toContainText("protect and classify bucket data");
      await expect(governanceHelp).toContainText("StackSim support · Partial");
      const eventNotificationsHelpButton = page.getByRole("button", { name: "About Event notifications" });
      await eventNotificationsHelpButton.hover();
      const eventNotificationsHelp = eventNotificationsHelpButton.locator("..").getByRole("tooltip");
      await expect(eventNotificationsHelp).toContainText("examples/cdk-s3-lambda-notification-audit");
      await expect(eventNotificationsHelp).toContainText("comes from that deployed example, not from StackSim itself");
      await page.getByRole("button", { name: "Enable", exact: true }).click();
      await page.locator(".s3-governance").getByRole("button", { name: "Configure Object Lock" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Enable", exact: true }).click();

      await page.getByRole("tab", { name: "Permissions" }).click();
      for (const label of ["Block public access (bucket settings)", "Bucket policy", "Object Ownership", "Requester Pays", "Attribute-based access control (ABAC)"]) {
        await expect(page.getByRole("button", { name: `About ${label}` })).toBeVisible();
      }
      await s3.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] } }));
      await page.reload();
      await expect(page.getByRole("button", { name: "About Access control list (ACL)" })).toBeVisible();

      await page.getByRole("tab", { name: "Management" }).click();
      await expect(page.getByRole("button", { name: "About Lifecycle rules" })).toBeVisible();

      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "current.txt", Body: "current" }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "archived.txt", Body: "archived", StorageClass: "GLACIER" }));
      await page.goto(`${consoleUrl}#/s3/buckets/${bucket}/object/${encodeURIComponent("current.txt")}/properties`);
      for (const label of ["Tags", "Object Lock retention", "Legal hold", "Annotations"]) {
        await expect(page.getByRole("button", { name: `About ${label}` })).toBeVisible();
      }
      await page.getByRole("tab", { name: "Permissions" }).click();
      await expect(page.getByRole("button", { name: "About Object access control list (ACL)" })).toBeVisible();

      await page.goto(`${consoleUrl}#/s3/buckets/${bucket}/object/${encodeURIComponent("archived.txt")}/properties`);
      await expect(page.getByRole("button", { name: "About Archive restore" })).toBeVisible();
      await page.getByRole("button", { name: "About Archive restore" }).focus();
      await expect(page.locator(".panel-help-tooltip:visible")).toContainText("does not move bytes to Glacier infrastructure");
    } finally { s3.destroy(); }
    expect(errors).toEqual([]);
  });

  test("S3 bucket and object workflows remain usable at a narrow viewport", async ({ page }) => {
    const errors = browserErrors(page); const bucket = "narrow-s3-learning"; await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${consoleUrl}#/s3/buckets`); await page.getByRole("button", { name: "Create bucket" }).first().click(); await page.getByLabel("Bucket name").fill(bucket); await page.getByRole("dialog").getByRole("button", { name: "Create bucket" }).click(); await expect(page.getByRole("tab", { name: "Objects" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("tab", { name: "Properties" }).click(); await expect(page.getByRole("heading", { name: /Event notifications/ })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390); await page.locator(".s3-event-notifications").getByRole("button", { name: "Create event notification" }).first().click(); const notificationDialog = page.getByRole("dialog"); await expect(notificationDialog.getByRole("group", { name: "Events" })).toBeVisible(); expect(await notificationDialog.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(350); await notificationDialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("tab", { name: "Objects" }).click(); await page.getByRole("button", { name: "Upload" }).first().click(); const upload = page.getByRole("dialog"); await upload.getByLabel("File").setInputFiles({ name: "narrow.txt", mimeType: "text/plain", buffer: Buffer.from("narrow") }); await upload.getByRole("button", { name: "Upload" }).click(); await page.getByRole("link", { name: "narrow.txt" }).click(); await expect(page.getByRole("heading", { name: "Object overview" })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390); await expect(page.getByRole("tab", { name: "Versions" })).toBeVisible();
    await page.getByRole("button", { name: "Delete object" }).click(); await page.getByLabel(/To confirm deletion/).fill("narrow.txt"); await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click(); await page.getByRole("link", { name: bucket, exact: true }).click(); await page.getByRole("tab", { name: "Properties" }).click(); await page.getByRole("button", { name: "Delete bucket" }).click(); await page.getByLabel(/To confirm deletion, enter narrow-s3-learning/).fill(bucket); await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click(); await expect(page).toHaveURL(/#\/s3\/buckets$/); expect(errors).toEqual([]);
  });
});
