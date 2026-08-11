function stringAttribute(value) {
  return value === undefined || value === null || value === "" ? undefined : { S: String(value) };
}

function numberAttribute(value) {
  return typeof value === "number" && Number.isFinite(value) ? { N: String(value) } : undefined;
}

function add(item, name, attribute) {
  if (attribute) item[name] = attribute;
}

/** Add the tag set observed by a follow-up GetObjectTagging request. */
export function addObservedObjectTags(item, tagSet, observedAt, source = "s3:GetObjectTagging") {
  const tags = Array.isArray(tagSet) ? tagSet : [];
  item.objectTags = {
    M: Object.fromEntries(tags
      .filter(tag => tag?.Key !== undefined && tag?.Value !== undefined)
      .map(tag => [String(tag.Key), { S: String(tag.Value) }])),
  };
  item.objectTagCount = { N: String(tags.length) };
  item.objectTagsObservedAt = { S: String(observedAt) };
  item.objectTagsSource = { S: source };
  return item;
}

/** Keep the original notification even when optional tag enrichment fails. */
export function addObjectTagLookupError(item, error) {
  item.objectTagsSource = { S: "s3:GetObjectTagging" };
  item.objectTagsLookupError = { S: String(error?.name ?? error?.code ?? error?.message ?? error) };
  return item;
}

function decodedObjectKey(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
}

/** Convert one record from the direct S3 Records[] envelope into a DynamoDB item. */
export function buildAuditItem(record, receivedAt, lambdaRequestId, recordIndex = 0, rawEvent = { Records: [record] }) {
  const bucketName = record?.s3?.bucket?.name ?? "unknown-bucket";
  const object = record?.s3?.object ?? {};
  const objectKey = decodedObjectKey(object.key);
  const rawEventName = record?.eventName ?? "UnknownEvent";
  const eventName = String(rawEventName).startsWith("s3:") ? String(rawEventName) : `s3:${rawEventName}`;
  const eventTime = record?.eventTime ?? receivedAt;
  const requestId = record?.responseElements?.["x-amz-request-id"];
  const stableId = object.sequencer ?? requestId ?? lambdaRequestId ?? `record-${recordIndex}`;

  const item = {
    bucketName: { S: String(bucketName) },
    eventKey: { S: `${eventTime}#${stableId}#${recordIndex}` },
    eventTime: { S: String(eventTime) },
    receivedAt: { S: String(receivedAt) },
    eventName: { S: eventName },
    summary: { S: `${eventName}: ${bucketName}${objectKey ? `/${objectKey}` : ""}` },
    rawRecordJson: { S: JSON.stringify(record) },
    rawEventJson: { S: JSON.stringify(rawEvent) },
  };

  add(item, "lambdaRequestId", stringAttribute(lambdaRequestId));
  add(item, "recordIndex", numberAttribute(recordIndex));
  add(item, "eventVersion", stringAttribute(record?.eventVersion));
  add(item, "eventSource", stringAttribute(record?.eventSource));
  add(item, "region", stringAttribute(record?.awsRegion));
  add(item, "configurationId", stringAttribute(record?.s3?.configurationId));
  add(item, "bucketArn", stringAttribute(record?.s3?.bucket?.arn));
  add(item, "principalId", stringAttribute(record?.userIdentity?.principalId));
  add(item, "sourceIpAddress", stringAttribute(record?.requestParameters?.sourceIPAddress));
  add(item, "requestId", stringAttribute(requestId));
  add(item, "hostId", stringAttribute(record?.responseElements?.["x-amz-id-2"]));
  add(item, "objectKey", stringAttribute(objectKey));
  add(item, "objectSize", numberAttribute(object.size));
  add(item, "objectETag", stringAttribute(object.eTag));
  add(item, "objectVersionId", stringAttribute(object.versionId));
  add(item, "sequencer", stringAttribute(object.sequencer));
  add(item, "deleteMarker", object.deleteMarker === undefined ? undefined : { BOOL: Boolean(object.deleteMarker) });
  add(item, "glacierEventDataJson", record?.glacierEventData ? { S: JSON.stringify(record.glacierEventData) } : undefined);
  add(item, "lifecycleEventDataJson", record?.lifecycleEventData ? { S: JSON.stringify(record.lifecycleEventData) } : undefined);
  add(item, "replicationEventDataJson", record?.replicationEventData ? { S: JSON.stringify(record.replicationEventData) } : undefined);
  add(item, "intelligentTieringEventDataJson", record?.intelligentTieringEventData ? { S: JSON.stringify(record.intelligentTieringEventData) } : undefined);
  add(item, "objectAnnotationJson", object.objectAnnotation ? { S: JSON.stringify(object.objectAnnotation) } : undefined);

  return item;
}

function buildTestEventItem(event, receivedAt, lambdaRequestId) {
  const bucketName = event?.Bucket ?? "unknown-bucket";
  const eventTime = event?.Time ?? receivedAt;
  const eventName = event?.Event ?? "s3:TestEvent";
  const stableId = event?.RequestId ?? lambdaRequestId ?? "test-event";
  return {
    bucketName: { S: String(bucketName) },
    eventKey: { S: `${eventTime}#${stableId}#0` },
    eventTime: { S: String(eventTime) },
    receivedAt: { S: String(receivedAt) },
    eventName: { S: String(eventName) },
    summary: { S: `${eventName}: ${bucketName}` },
    requestId: { S: String(stableId) },
    ...(event?.HostId ? { hostId: { S: String(event.HostId) } } : {}),
    ...(lambdaRequestId ? { lambdaRequestId: { S: String(lambdaRequestId) } } : {}),
    rawRecordJson: { S: JSON.stringify(event) },
    rawEventJson: { S: JSON.stringify(event) },
  };
}

/**
 * Direct S3 notifications normally contain Records[]. S3 also sends a
 * differently shaped s3:TestEvent when the notification is configured.
 */
export function buildAuditItems(event, receivedAt, lambdaRequestId) {
  if (!Array.isArray(event?.Records) || event.Records.length === 0) {
    return [buildTestEventItem(event, receivedAt, lambdaRequestId)];
  }
  return event.Records.map((record, index) => buildAuditItem(record, receivedAt, lambdaRequestId, index, event));
}
