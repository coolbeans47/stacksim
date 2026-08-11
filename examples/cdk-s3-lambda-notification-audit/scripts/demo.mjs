import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, DeleteObjectTaggingCommand, PutObjectCommand, PutObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import { clientOptions, deployedOutputs, endpoint } from "./runtime.mjs";

const outputs = await deployedOutputs();
const options = clientOptions();
const s3 = new S3Client({ ...options, forcePathStyle: Boolean(endpoint) });
const dynamodb = new DynamoDBClient(options);
const key = `education/demo-${Date.now()}.txt`;

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function recordsForDemoObject() {
  const result = await dynamodb.send(new ScanCommand({ TableName: outputs.AuditTableName }));
  return (result.Items ?? []).filter(item => item.objectKey?.S === key);
}

function tagMap(item) {
  return Object.fromEntries(Object.entries(item?.objectTags?.M ?? {}).map(([name, value]) => [name, value.S]));
}

async function waitForRecord(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const match = (await recordsForDemoObject()).find(predicate);
    if (match) return match;
    await pause(250);
  }
  return undefined;
}

try {
  console.log(`Creating s3://${outputs.BucketName}/${key}`);
  await s3.send(new PutObjectCommand({ Bucket: outputs.BucketName, Key: key, Body: "Hello from the direct S3 Lambda notification demo!\n", ContentType: "text/plain" }));
  console.log("Adding two object tags");
  await s3.send(new PutObjectTaggingCommand({ Bucket: outputs.BucketName, Key: key, Tagging: { TagSet: [{ Key: "lesson", Value: "direct-notification" }, { Key: "stage", Value: "demo" }] } }));
  const taggingRecord = await waitForRecord(item => item.eventName?.S === "s3:ObjectTagging:Put" && item.objectTags?.M?.lesson?.S === "direct-notification");
  if (!taggingRecord) throw new Error("The ObjectTagging:Put audit record did not contain the observed object tags");
  console.log("Lambda observed tags:", tagMap(taggingRecord));
  console.log("Removing all object tags");
  await s3.send(new DeleteObjectTaggingCommand({ Bucket: outputs.BucketName, Key: key }));
  console.log("Deleting the object (the versioned bucket creates a delete marker)");
  await s3.send(new DeleteObjectCommand({ Bucket: outputs.BucketName, Key: key }));

  let records = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    records = await recordsForDemoObject();
    if (records.length >= 4) break;
    await pause(250);
  }

  const rows = records.map(item => ({
    time: item.eventTime?.S,
    event: item.eventName?.S,
    object: item.objectKey?.S,
    version: item.objectVersionId?.S ?? "–",
    deleteMarker: item.deleteMarker?.BOOL ?? false,
    tags: Object.keys(tagMap(item)).length ? JSON.stringify(tagMap(item)) : "–",
  })).sort((left, right) => String(left.time).localeCompare(String(right.time)));
  console.table(rows);
  if (records.length < 4) throw new Error(`Expected at least four audit records for ${key}, found ${records.length}`);
  console.log("Demo succeeded: create, tag-add, tag-delete, and object-delete events were recorded.");
} finally {
  s3.destroy();
  dynamodb.destroy();
}
