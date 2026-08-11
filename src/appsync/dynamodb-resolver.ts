import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrincipalContext } from "../auth/sigv4.js";
import type { Clock } from "../core/clock.js";
import type { DynamoDbService } from "../dynamodb.js";
import { AwsError } from "../errors.js";
import { evaluateAuthorization, evaluateResourcePolicy } from "../iam/evaluator.js";
import type { StateStore } from "../state.js";
import type {
  AppSyncDataSourceState,
  AppSyncGraphqlApiState,
  AppSyncResolverState,
  Item,
} from "../types.js";
import {
  AppSyncVtlError,
  evaluateAppSyncVtl,
  fromDynamoDBMap,
  validateAppSyncVtl,
  type AppSyncVtlContext,
  type AppSyncVtlErrorShape,
  type AppSyncVtlEvaluation,
} from "./vtl.js";

type DynamoOperation = "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem" | "Query" | "Scan";

interface ExpressionDocument {
  expression: string;
  expressionNames?: Record<string, string>;
  expressionValues?: Item;
}

interface Cursor {
  accountId: string;
  region: string;
  apiId: string;
  apiGeneration: string;
  schemaGeneration: string;
  typeName: string;
  fieldName: string;
  resolverGeneration: string;
  resolverRevision: number;
  dataSourceGeneration: string;
  dataSourceRevision: number;
  tableId: string;
  indexName?: string;
  authorizationMode: string;
  authorizationScope: string;
  requestScope: string;
  key: Item;
  expiresAt: number;
}

export interface DynamoResolverDependencies {
  store: StateStore;
  region: string;
  clock: Clock;
  dynamodb: DynamoDbService;
  assumeServiceRole(roleArn: string, sessionName: string, servicePrincipal: string): Promise<PrincipalContext>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function encodeCursor(secret: string, cursor: Cursor): string {
  const key = createHash("sha256").update(secret).update("\0AppSync.DynamoDB.NextToken").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("AppSync.DynamoDB.NextToken:v1"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cursor), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

function decodeCursor(secret: string, token: string): Cursor {
  const [version, ivText, encryptedText, tagText, extra] = token.split(".");
  if (version !== "v1" || !ivText || !encryptedText || !tagText || extra) throw new Error("Invalid cursor");
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid cursor");
  const key = createHash("sha256").update(secret).update("\0AppSync.DynamoDB.NextToken").digest();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from("AppSync.DynamoDB.NextToken:v1"));
  decipher.setAuthTag(tag);
  const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8"));
  if (!isRecord(decoded)) throw new Error("Invalid cursor");
  return decoded as unknown as Cursor;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(input).filter(key => !accepted.has(key));
  if (unknown.length) throw new AppSyncVtlError(`${label} contains unsupported member ${unknown.sort()[0]}.`);
}

function requireItem(value: unknown, label: string): Item {
  if (!isRecord(value)) throw new AppSyncVtlError(`${label} must be a DynamoDB typed-value map.`);
  return structuredClone(value) as Item;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new AppSyncVtlError(`${label} must be a boolean.`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) throw new AppSyncVtlError(`${label} must be a positive integer.`);
  return Number(value);
}

function expression(value: unknown, label: string): ExpressionDocument | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AppSyncVtlError(`${label} must be an expression object.`);
  rejectUnknown(value, ["expression", "expressionNames", "expressionValues"], label);
  if (typeof value.expression !== "string" || !value.expression.trim()) {
    throw new AppSyncVtlError(`${label}.expression must be a non-empty string.`);
  }
  if (value.expressionNames !== undefined && (!isRecord(value.expressionNames)
    || Object.values(value.expressionNames).some(item => typeof item !== "string"))) {
    throw new AppSyncVtlError(`${label}.expressionNames must be a string map.`);
  }
  return {
    expression: value.expression,
    ...(value.expressionNames === undefined
      ? {}
      : { expressionNames: structuredClone(value.expressionNames) as Record<string, string> }),
    ...(value.expressionValues === undefined
      ? {}
      : { expressionValues: requireItem(value.expressionValues, `${label}.expressionValues`) }),
  };
}

function applyExpression(target: Record<string, unknown>, value: ExpressionDocument | undefined, prefix: string): void {
  if (!value) return;
  target[`${prefix}Expression`] = value.expression;
  if (value.expressionNames) target.ExpressionAttributeNames = value.expressionNames;
  if (value.expressionValues) target.ExpressionAttributeValues = value.expressionValues;
}

function projection(value: unknown): ExpressionDocument | undefined {
  return expression(value, "projection");
}

function operationDocument(value: unknown): Record<string, unknown> & { version: string; operation: DynamoOperation } {
  if (!isRecord(value)) throw new AppSyncVtlError("The DynamoDB request mapping must produce an object.");
  if (value.version !== "2017-02-28" && value.version !== "2018-05-29") {
    throw new AppSyncVtlError("The DynamoDB request version must be 2017-02-28 or 2018-05-29.");
  }
  if (!["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan"].includes(String(value.operation))) {
    throw new AppSyncVtlError("The DynamoDB request operation is unsupported.");
  }
  return value as Record<string, unknown> & { version: string; operation: DynamoOperation };
}

export function validateDynamoResolverTemplates(requestTemplate: string, responseTemplate: string): void {
  validateAppSyncVtl(requestTemplate);
  validateAppSyncVtl(responseTemplate);
  const request = evaluateAppSyncVtl(requestTemplate, {
    arguments: {
      id: "validation",
      input: { id: "validation", value: "value" },
      limit: 1,
      nextToken: null,
    },
    source: null,
    result: null,
    error: null,
    identity: null,
    stash: {
      conditions: [], hasAuth: true, metadata: {}, connectionAttributes: {}, adminRoles: [],
      defaultValues: { id: "validation", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    },
    prev: { result: null },
    request: { headers: {} },
    info: { fieldName: "field", parentTypeName: "Query", variables: {} },
    authType: "API Key Authorization",
  }, 0);
  operationDocument(request.value);
}

function mergeExpressions(
  target: Record<string, unknown>,
  documents: Array<ExpressionDocument | undefined>,
): void {
  const names: Record<string, string> = {};
  const values: Item = {};
  for (const document of documents) {
    Object.assign(names, document?.expressionNames);
    Object.assign(values, document?.expressionValues);
  }
  if (Object.keys(names).length) target.ExpressionAttributeNames = names;
  if (Object.keys(values).length) target.ExpressionAttributeValues = values;
}

function safeSessionName(apiId: string): string {
  return `appsync-${apiId.slice(0, 26)}`;
}

function mapDynamoError(error: unknown): AppSyncVtlError {
  if (error instanceof AppSyncVtlError) return error;
  if (error instanceof AwsError) {
    const type = error.code === "AccessDeniedException" || error.code === "AccessDenied"
      ? "Unauthorized"
      : `DynamoDB:${error.code}`;
    const safeMessage = error.code === "ResourceNotFoundException"
      ? "The configured DynamoDB resource was not found."
      : error.code === "ConditionalCheckFailedException"
        ? "The DynamoDB conditional request failed."
        : error.code === "ValidationException"
          ? "The DynamoDB request is invalid."
          : type === "Unauthorized"
            ? "The AppSync data source role is not authorized for this DynamoDB request."
            : "The DynamoDB resolver request failed.";
    return new AppSyncVtlError(safeMessage, type);
  }
  return new AppSyncVtlError("The DynamoDB resolver failed internally.", "DynamoDB:InternalFailure");
}

function appended(
  request: AppSyncVtlEvaluation,
  response: AppSyncVtlEvaluation,
): AppSyncVtlErrorShape[] {
  return [...request.appendedErrors, ...response.appendedErrors];
}

function evaluateFailureResponse(
  resolver: AppSyncResolverState,
  context: Omit<AppSyncVtlContext, "result" | "error">,
  request: AppSyncVtlEvaluation,
  error: unknown,
  now: number,
): AppSyncVtlEvaluation {
  const mapped = mapDynamoError(error);
  const response = evaluateAppSyncVtl(resolver.responseMappingTemplate, {
    ...context,
    result: null,
    error: { message: mapped.message, type: mapped.errorType },
  }, now);
  return {
    ...response,
    appendedErrors: appended(request, response),
    logs: [...request.logs, ...response.logs],
  };
}

export async function executeDynamoResolver(
  dependencies: DynamoResolverDependencies,
  api: AppSyncGraphqlApiState,
  resolver: AppSyncResolverState,
  dataSource: AppSyncDataSourceState & {
    type: "AMAZON_DYNAMODB";
    serviceRoleArn: string;
    dynamodbConfig: { tableName: string; awsRegion: string };
  },
  context: Omit<AppSyncVtlContext, "result" | "error">,
): Promise<AppSyncVtlEvaluation> {
  const now = dependencies.clock.now();
  const requestEvaluation = evaluateAppSyncVtl(resolver.requestMappingTemplate, context, now);
  if (requestEvaluation.returned) return requestEvaluation;
  const document = operationDocument(requestEvaluation.value);
  const indexName = document.index === undefined ? undefined : String(document.index);
  const input: Record<string, unknown> = { TableName: dataSource.dynamodbConfig.tableName };
  const query = document.operation === "Query";
  let suppliedCursor: Cursor | undefined;

  // Fully validate and translate the request document before any authoritative
  // DynamoDB service call. Unsupported request forms therefore cannot mutate or
  // even observe the configured table.
  if (document.operation === "GetItem") {
    rejectUnknown(document, ["version", "operation", "key", "consistentRead", "projection"], "GetItem request");
    input.Key = requireItem(document.key, "key");
    input.ConsistentRead = optionalBoolean(document.consistentRead, "consistentRead");
    const selected = projection(document.projection);
    applyExpression(input, selected, "Projection");
    mergeExpressions(input, [selected]);
  } else if (document.operation === "PutItem") {
    rejectUnknown(document, ["version", "operation", "key", "attributeValues", "condition"], "PutItem request");
    const key = requireItem(document.key, "key");
    const attributes = document.attributeValues === undefined ? {} : requireItem(document.attributeValues, "attributeValues");
    input.Item = { ...attributes, ...key };
    const condition = expression(document.condition, "condition");
    applyExpression(input, condition, "Condition");
    mergeExpressions(input, [condition]);
  } else if (document.operation === "UpdateItem") {
    rejectUnknown(document, ["version", "operation", "key", "update", "condition"], "UpdateItem request");
    input.Key = requireItem(document.key, "key");
    const update = expression(document.update, "update");
    if (!update) throw new AppSyncVtlError("UpdateItem requires an update expression.");
    const condition = expression(document.condition, "condition");
    applyExpression(input, update, "Update");
    applyExpression(input, condition, "Condition");
    mergeExpressions(input, [update, condition]);
    input.ReturnValues = "ALL_NEW";
  } else if (document.operation === "DeleteItem") {
    rejectUnknown(document, ["version", "operation", "key", "condition"], "DeleteItem request");
    input.Key = requireItem(document.key, "key");
    const condition = expression(document.condition, "condition");
    applyExpression(input, condition, "Condition");
    mergeExpressions(input, [condition]);
    input.ReturnValues = "ALL_OLD";
  } else {
    rejectUnknown(document, [
      "version", "operation", "query", "filter", "projection", "index", "nextToken",
      "limit", "scanIndexForward", "consistentRead", "select", "segment", "totalSegments",
    ], `${document.operation} request`);
    const queryExpression = query ? expression(document.query, "query") : undefined;
    if (query && !queryExpression) throw new AppSyncVtlError("Query requires a query expression.");
    const filter = expression(document.filter, "filter");
    const selected = projection(document.projection);
    applyExpression(input, queryExpression, "KeyCondition");
    applyExpression(input, filter, "Filter");
    applyExpression(input, selected, "Projection");
    mergeExpressions(input, [queryExpression, filter, selected]);
    if (indexName) input.IndexName = indexName;
    input.Limit = optionalPositiveInteger(document.limit, "limit");
    input.ScanIndexForward = optionalBoolean(document.scanIndexForward, "scanIndexForward");
    input.ConsistentRead = optionalBoolean(document.consistentRead, "consistentRead");
    if (document.select !== undefined) {
      if (!["ALL_ATTRIBUTES", "ALL_PROJECTED_ATTRIBUTES", "SPECIFIC_ATTRIBUTES", "COUNT"].includes(String(document.select))) {
        throw new AppSyncVtlError("select is invalid.");
      }
      input.Select = String(document.select);
    }
    if (!query) {
      if (document.segment !== undefined) input.Segment = Number(document.segment);
      if (document.totalSegments !== undefined) input.TotalSegments = Number(document.totalSegments);
    }
    if (document.nextToken !== undefined && document.nextToken !== null) {
      if (typeof document.nextToken !== "string") throw new AppSyncVtlError("nextToken must be a string or null.");
      try {
        suppliedCursor = decodeCursor(dependencies.store.state.installation.paginationSecret, document.nextToken);
      } catch {
        throw new AppSyncVtlError("The AppSync DynamoDB nextToken is invalid.", "BadRequestException");
      }
    }
  }

  const scopedDocument = { ...document };
  delete scopedDocument.nextToken;
  const requestScope = createHash("sha256").update(canonicalJson(scopedDocument)).digest("hex");
  const authorizationMode = context.authType ?? "Unknown Authorization";
  const authorizationScope = context.authorizationScope
    ?? createHash("sha256").update(`${authorizationMode}\0anonymous`).digest("hex");

  const action = `dynamodb:${document.operation}`;
  const configuredTableArn = `arn:aws:dynamodb:${dataSource.dynamodbConfig.awsRegion}:${api.owner}:table/${dataSource.dynamodbConfig.tableName}`;
  const configuredResource = indexName ? `${configuredTableArn}/index/${indexName}` : configuredTableArn;
  let principal: PrincipalContext;
  try {
    principal = await dependencies.assumeServiceRole(dataSource.serviceRoleArn, safeSessionName(api.apiId), "appsync.amazonaws.com");
  } catch {
    return evaluateFailureResponse(resolver, context, requestEvaluation,
      new AppSyncVtlError("AppSync cannot assume the configured data source role.", "Unauthorized"), now);
  }
  const authorization = evaluateAuthorization(dependencies.store.ensureAccount().iam, principal, action, configuredResource, {
    "aws:PrincipalArn": principal.principalArn,
    "aws:PrincipalAccount": principal.accountId,
    "aws:RequestedRegion": dependencies.region,
    "aws:CurrentTime": new Date(now).toISOString(),
  });
  if (authorization.decision !== "allowed") {
    return evaluateFailureResponse(resolver, context, requestEvaluation,
      new AppSyncVtlError("The AppSync data source role is not authorized for this DynamoDB request.", "Unauthorized"), now);
  }

  let table: { name: string; arn: string; id: string };
  try {
    const description = (await dependencies.dynamodb.DescribeTable({
      TableName: dataSource.dynamodbConfig.tableName,
    })).Table;
    if (!description || description.TableStatus !== "ACTIVE") throw new AwsError("ResourceNotFoundException", "Table is not active");
    table = { name: String(description.TableName), arn: String(description.TableArn), id: String(description.TableId) };
  } catch (error) {
    return evaluateFailureResponse(resolver, context, requestEvaluation, error, now);
  }

  const resource = indexName ? `${table.arn}/index/${indexName}` : table.arn;
  try {
    const attached = await dependencies.dynamodb.GetResourcePolicy({ ResourceArn: table.arn });
    const decision = evaluateResourcePolicy(JSON.parse(attached.Policy), principal.principalArn, action, resource, {
      "aws:PrincipalArn": principal.principalArn,
      "aws:PrincipalAccount": principal.accountId,
      "aws:RequestedRegion": dependencies.region,
    });
    if (decision.decision === "explicitDeny") {
      return evaluateFailureResponse(resolver, context, requestEvaluation,
        new AppSyncVtlError("The DynamoDB resource policy denies the AppSync data source role.", "Unauthorized"), now);
    }
  } catch (error) {
    if (!(error instanceof AwsError && error.code === "PolicyNotFoundException")) {
      return evaluateFailureResponse(resolver, context, requestEvaluation, error, now);
    }
  }

  if (suppliedCursor) {
    const cursor = suppliedCursor;
    if (cursor.accountId !== api.owner
      || cursor.region !== dependencies.region
      || cursor.apiId !== api.apiId
      || cursor.apiGeneration !== api.generation
      || cursor.schemaGeneration !== api.schema?.generation
      || cursor.typeName !== resolver.typeName
      || cursor.fieldName !== resolver.fieldName
      || cursor.resolverGeneration !== resolver.generation
      || cursor.resolverRevision !== resolver.revision
      || cursor.dataSourceGeneration !== dataSource.generation
      || cursor.dataSourceRevision !== dataSource.revision
      || cursor.tableId !== table.id
      || cursor.indexName !== indexName
      || cursor.authorizationMode !== authorizationMode
      || cursor.authorizationScope !== authorizationScope
      || cursor.requestScope !== requestScope
      || !isRecord(cursor.key)
      || !Number.isFinite(cursor.expiresAt)
      || cursor.expiresAt <= now) {
      throw new AppSyncVtlError("The AppSync DynamoDB nextToken is stale or belongs to another request scope.", "BadRequestException");
    }
    input.ExclusiveStartKey = structuredClone(cursor.key);
  }

  let result: unknown;
  try {
    if (document.operation === "GetItem") {
      const response = await dependencies.dynamodb.GetItem(input);
      result = response.Item ? fromDynamoDBMap(response.Item) : null;
    } else if (document.operation === "PutItem") {
      await dependencies.dynamodb.PutItem(input);
      result = fromDynamoDBMap(input.Item as Item);
    } else if (document.operation === "UpdateItem") {
      const response = await dependencies.dynamodb.UpdateItem(input);
      result = response.Attributes ? fromDynamoDBMap(response.Attributes) : null;
    } else if (document.operation === "DeleteItem") {
      const response = await dependencies.dynamodb.DeleteItem(input);
      result = response.Attributes ? fromDynamoDBMap(response.Attributes) : null;
    } else {
      const response = query ? await dependencies.dynamodb.Query(input) : await dependencies.dynamodb.Scan(input);
      const nextToken = response.LastEvaluatedKey
        ? encodeCursor(dependencies.store.state.installation.paginationSecret, {
            accountId: api.owner,
            region: dependencies.region,
            apiId: api.apiId,
            apiGeneration: api.generation,
            schemaGeneration: api.schema!.generation,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            resolverGeneration: resolver.generation,
            resolverRevision: resolver.revision,
            dataSourceGeneration: dataSource.generation,
            dataSourceRevision: dataSource.revision,
            tableId: table.id,
            ...(indexName ? { indexName } : {}),
            authorizationMode,
            authorizationScope,
            requestScope,
            key: response.LastEvaluatedKey,
            expiresAt: now + 60 * 60 * 1000,
          } satisfies Cursor)
        : null;
      result = {
        items: (response.Items ?? []).map((item: Item) => fromDynamoDBMap(item)),
        nextToken,
        scannedCount: Number(response.ScannedCount ?? 0),
      };
    }
  } catch (error) {
    return evaluateFailureResponse(resolver, context, requestEvaluation, error, now);
  }

  const responseEvaluation = evaluateAppSyncVtl(resolver.responseMappingTemplate, {
    ...context,
    result,
    error: null,
  }, now);
  return {
    ...responseEvaluation,
    appendedErrors: appended(requestEvaluation, responseEvaluation),
    logs: [...requestEvaluation.logs, ...responseEvaluation.logs],
  };
}
