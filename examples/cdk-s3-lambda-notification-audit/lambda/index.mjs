import { createRequire } from "node:module";
import { addObjectTagLookupError, addObservedObjectTags, buildAuditItems } from "./audit-record.mjs";

// Lambda provides the AWS SDK in its runtime. createRequire also lets the
// StackSim teaching runtime resolve that runtime-provided package explicitly.
const require = createRequire(import.meta.url);
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { GetObjectTaggingCommand, S3Client } = require("@aws-sdk/client-s3");
const dynamodb = new DynamoDBClient({});
const s3 = new S3Client({ forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL) });

export async function handler(event, context) {
  const tableName = process.env.AUDIT_TABLE_NAME;
  if (!tableName) throw new Error("AUDIT_TABLE_NAME is not configured");

  const receivedAt = new Date().toISOString();
  const items = buildAuditItems(event, receivedAt, context?.awsRequestId);

  // A notification can contain more than one S3 record. Keeping this loop
  // sequential makes the teaching example easier to follow and retry safely.
  for (const [index, item] of items.entries()) {
    const record = event?.Records?.[index];

    // The real S3 notification says that tags changed, but does not include
    // their values. Fetch the object version's current tag set so the teaching
    // audit record is more useful. This is an observation made after the event,
    // so a very fast later update can legitimately change what is returned.
    if (item.eventName.S === "s3:ObjectTagging:Put" && record?.s3?.object?.key) {
      try {
        const result = await s3.send(new GetObjectTaggingCommand({
          Bucket: item.bucketName.S,
          Key: item.objectKey.S,
          ...(item.objectVersionId?.S ? { VersionId: item.objectVersionId.S } : {}),
        }));
        addObservedObjectTags(item, result.TagSet, new Date().toISOString());
      } catch (error) {
        console.warn("Could not enrich the tagging event with the current object tags", error);
        addObjectTagLookupError(item, error);
      }
    } else if (item.eventName.S === "s3:ObjectTagging:Delete") {
      addObservedObjectTags(item, [], receivedAt, "s3:ObjectTagging:Delete event");
    }

    console.log(JSON.stringify({
      message: "Recording direct S3 event notification",
      bucketName: item.bucketName.S,
      eventName: item.eventName.S,
      objectKey: item.objectKey?.S,
      configurationId: item.configurationId?.S,
      objectTags: item.objectTags?.M
        ? Object.fromEntries(Object.entries(item.objectTags.M).map(([key, value]) => [key, value.S]))
        : undefined,
    }));

    try {
      await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: item }));
    } catch (error) {
      console.error("Could not write the S3 event to DynamoDB", error);
      throw error; // S3 can retry the invocation.
    }
  }

  return { recorded: items.length };
}
