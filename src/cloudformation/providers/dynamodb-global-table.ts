import type { DynamoDbService } from "../../dynamodb.js";
import {
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderInProgress,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import {
  CFN10_NO_TAGS,
  CFN10_RETENTION,
  cfn10ExactKeys,
  cfn10Failure,
  cfn10GeneratedName,
  cfn10GetAtt,
  cfn10Issue,
  cfn10Missing,
  cfn10Owned,
  cfn10Plan,
  cfn10Record,
  cfn10Same,
  cfn10ServiceTags,
} from "./cfn10-common.js";

export const DYNAMODB_GLOBAL_TABLE_TYPE = "AWS::DynamoDB::GlobalTable";

export interface DynamoDbGlobalAttributeDefinitionModel {
  readonly AttributeName: string;
  readonly AttributeType: "S" | "N" | "B";
}

export interface DynamoDbGlobalKeySchemaModel {
  readonly AttributeName: string;
  readonly KeyType: "HASH" | "RANGE";
}

export interface DynamoDbGlobalTableModel {
  readonly TableName: string;
  readonly AttributeDefinitions: readonly DynamoDbGlobalAttributeDefinitionModel[];
  readonly BillingMode: "PAY_PER_REQUEST";
  readonly KeySchema: readonly DynamoDbGlobalKeySchemaModel[];
  readonly Replicas: readonly { readonly Region: string }[];
  readonly StreamSpecification?: { readonly StreamViewType: "KEYS_ONLY" | "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES" };
}

export const DYNAMODB_GLOBAL_TABLE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: DYNAMODB_GLOBAL_TABLE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AttributeDefinitions: Object.freeze({ valueType: "array", required: true, updateBehavior: "REPLACEMENT" }),
    BillingMode: Object.freeze({ valueType: "string", required: true, updateBehavior: "NOT_SUPPORTED", description: "The local current global-table profile is PAY_PER_REQUEST." }),
    KeySchema: Object.freeze({ valueType: "array", required: true, updateBehavior: "REPLACEMENT" }),
    Replicas: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE", description: "MREC replicas in the simulator account." }),
    StreamSpecification: Object.freeze({ valueType: "object", updateBehavior: "REPLACEMENT" }),
    TableName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Table name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string" }),
    StreamArn: Object.freeze({ valueType: "string" }),
    TableId: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

const STREAM_VIEWS = new Set(["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"]);

function validateDefinitions(properties: Record<string, unknown>, issues: ProviderValidationIssue[]): void {
  const definitions = properties.AttributeDefinitions;
  if (Array.isArray(definitions)) {
    if (definitions.length < 1 || definitions.length > 2) cfn10Issue(issues, "Properties.AttributeDefinitions", "AttributeDefinitions must contain the one or two table key attributes");
    const names = new Set<string>();
    for (const [index, definition] of definitions.entries()) {
      const path = `Properties.AttributeDefinitions.${index}`;
      if (!cfn10Record(definition)) {
        cfn10Issue(issues, path, "Attribute definitions must be objects");
        continue;
      }
      cfn10ExactKeys(definition, ["AttributeName", "AttributeType"], path, issues);
      if (typeof definition.AttributeName !== "string" || definition.AttributeName.length < 1 || definition.AttributeName.length > 255) cfn10Issue(issues, `${path}.AttributeName`, "AttributeName must contain 1-255 characters");
      else if (names.has(definition.AttributeName)) cfn10Issue(issues, `${path}.AttributeName`, "Attribute names must be unique");
      else names.add(definition.AttributeName);
      if (!new Set(["S", "N", "B"]).has(String(definition.AttributeType))) cfn10Issue(issues, `${path}.AttributeType`, "AttributeType must be S, N, or B");
    }
  }

  const schema = properties.KeySchema;
  if (Array.isArray(schema)) {
    if (schema.length < 1 || schema.length > 2) cfn10Issue(issues, "Properties.KeySchema", "KeySchema must contain one HASH key and at most one RANGE key");
    const names = new Set<string>();
    let hashes = 0;
    let ranges = 0;
    for (const [index, key] of schema.entries()) {
      const path = `Properties.KeySchema.${index}`;
      if (!cfn10Record(key)) {
        cfn10Issue(issues, path, "Key schema entries must be objects");
        continue;
      }
      cfn10ExactKeys(key, ["AttributeName", "KeyType"], path, issues);
      if (typeof key.AttributeName !== "string" || key.AttributeName.length < 1 || key.AttributeName.length > 255) cfn10Issue(issues, `${path}.AttributeName`, "AttributeName must contain 1-255 characters");
      else if (names.has(key.AttributeName)) cfn10Issue(issues, `${path}.AttributeName`, "Key attributes must be unique");
      else names.add(key.AttributeName);
      if (key.KeyType === "HASH") hashes++;
      else if (key.KeyType === "RANGE") ranges++;
      else cfn10Issue(issues, `${path}.KeyType`, "KeyType must be HASH or RANGE");
    }
    if (hashes !== 1 || ranges > 1) cfn10Issue(issues, "Properties.KeySchema", "KeySchema must contain exactly one HASH key and at most one RANGE key");
    if (Array.isArray(definitions)) {
      const definitionNames = new Set(definitions.filter(cfn10Record).map(definition => String(definition.AttributeName)));
      if (definitionNames.size !== names.size || [...names].some(name => !definitionNames.has(name))) cfn10Issue(issues, "Properties.AttributeDefinitions", "AttributeDefinitions must exactly describe every KeySchema attribute");
    }
  }
}

function validation(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, DYNAMODB_GLOBAL_TABLE_SCHEMA);
  if (!cfn10Record(properties)) return issues;
  if (properties.TableName !== undefined && (typeof properties.TableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(properties.TableName))) cfn10Issue(issues, "Properties.TableName", "TableName must contain 3-255 letters, numbers, underscores, hyphens, or periods");
  if (properties.BillingMode !== undefined && properties.BillingMode !== "PAY_PER_REQUEST") cfn10Issue(issues, "Properties.BillingMode", "The supported current global-table profile uses PAY_PER_REQUEST");
  validateDefinitions(properties, issues);

  if (Array.isArray(properties.Replicas)) {
    if (properties.Replicas.length < 1 || properties.Replicas.length > 10) cfn10Issue(issues, "Properties.Replicas", "Replicas must contain 1-10 Regions");
    const regions = new Set<string>();
    for (const [index, replica] of properties.Replicas.entries()) {
      const path = `Properties.Replicas.${index}`;
      if (!cfn10Record(replica)) {
        cfn10Issue(issues, path, "Replica entries must be objects");
        continue;
      }
      cfn10ExactKeys(replica, ["Region"], path, issues);
      if (typeof replica.Region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(replica.Region)) cfn10Issue(issues, `${path}.Region`, "Region must be a valid AWS Region identifier");
      else if (regions.has(replica.Region)) cfn10Issue(issues, `${path}.Region`, "Replica Regions must be unique");
      else regions.add(replica.Region);
    }
    if (!regions.has(context.region)) cfn10Issue(issues, "Properties.Replicas", "Replicas must include the stack Region");
    if (regions.size > 1 && properties.StreamSpecification === undefined) {
      cfn10Issue(issues, "Properties.StreamSpecification", "StreamSpecification is required for an EVENTUAL global table with more than one replica");
    }
  }
  if (cfn10Record(properties.StreamSpecification)) {
    cfn10ExactKeys(properties.StreamSpecification, ["StreamViewType"], "Properties.StreamSpecification", issues);
    if (!STREAM_VIEWS.has(String(properties.StreamSpecification.StreamViewType))) cfn10Issue(issues, "Properties.StreamSpecification.StreamViewType", "StreamViewType must be KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, or NEW_AND_OLD_IMAGES");
  }
  return issues;
}

function canonicalDefinitions(value: unknown): readonly DynamoDbGlobalAttributeDefinitionModel[] {
  return Object.freeze((value as Record<string, unknown>[]).map(definition => Object.freeze({
    AttributeName: String(definition.AttributeName),
    AttributeType: String(definition.AttributeType) as DynamoDbGlobalAttributeDefinitionModel["AttributeType"],
  })).sort((left, right) => left.AttributeName.localeCompare(right.AttributeName)));
}

function canonicalKeys(value: unknown): readonly DynamoDbGlobalKeySchemaModel[] {
  return Object.freeze((value as Record<string, unknown>[]).map(key => Object.freeze({
    AttributeName: String(key.AttributeName),
    KeyType: String(key.KeyType) as DynamoDbGlobalKeySchemaModel["KeyType"],
  })).sort((left, right) => left.KeyType === right.KeyType ? left.AttributeName.localeCompare(right.AttributeName) : left.KeyType === "HASH" ? -1 : 1));
}

function canonicalReplicas(value: unknown): readonly { readonly Region: string }[] {
  return Object.freeze((value as Record<string, unknown>[]).map(replica => Object.freeze({ Region: String(replica.Region) })).sort((left, right) => left.Region.localeCompare(right.Region)));
}

function model(properties: Record<string, unknown>, context: ProviderContext): DynamoDbGlobalTableModel {
  return Object.freeze({
    TableName: String(properties.TableName ?? cfn10GeneratedName(context, "", 255)),
    AttributeDefinitions: canonicalDefinitions(properties.AttributeDefinitions),
    BillingMode: "PAY_PER_REQUEST" as const,
    KeySchema: canonicalKeys(properties.KeySchema),
    Replicas: canonicalReplicas(properties.Replicas),
    ...(cfn10Record(properties.StreamSpecification) ? { StreamSpecification: Object.freeze({ StreamViewType: String(properties.StreamSpecification.StreamViewType) as NonNullable<DynamoDbGlobalTableModel["StreamSpecification"]>["StreamViewType"] }) } : {}),
  });
}

interface GlobalTableSnapshot {
  readonly model: DynamoDbGlobalTableModel;
  readonly arn: string;
  readonly tableId: string;
  readonly streamArn?: string;
  readonly tags: readonly { Key: string; Value: string }[];
  readonly active: boolean;
}

function success(snapshot: GlobalTableSnapshot): ProviderSuccess<DynamoDbGlobalTableModel> {
  return {
    status: "SUCCESS",
    physicalId: snapshot.model.TableName,
    model: {
      physicalId: snapshot.model.TableName,
      properties: snapshot.model,
      attributes: {
        Arn: snapshot.arn,
        ...(snapshot.streamArn ? { StreamArn: snapshot.streamArn } : {}),
        TableId: snapshot.tableId,
      },
    },
  };
}

function inProgress(physicalId: string, phase: string): ProviderInProgress {
  return {
    status: "IN_PROGRESS",
    callbackAfterMs: 25,
    checkpoint: { schemaVersion: 1, callbackContext: { phase }, physicalId },
    message: phase,
  };
}

export function createDynamoDbGlobalTableProvider(dynamodb: DynamoDbService): ProductionResourceProvider<DynamoDbGlobalTableModel> {
  const describe = async (name: string, context: ProviderContext): Promise<GlobalTableSnapshot> => {
    const table = (await dynamodb.DescribeTable({ TableName: name })).Table;
    const tags = ((await dynamodb.ListTagsOfResource({ ResourceArn: table.TableArn })).Tags ?? []) as Array<{ Key: string; Value: string }>;
    const regions = Array.isArray(table.Replicas) && table.Replicas.length
      ? table.Replicas.map((replica: Record<string, unknown>) => ({ Region: String(replica.RegionName) }))
      : [{ Region: context.region }];
    const current: DynamoDbGlobalTableModel = Object.freeze({
      TableName: String(table.TableName),
      AttributeDefinitions: canonicalDefinitions(table.AttributeDefinitions),
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: canonicalKeys(table.KeySchema),
      Replicas: canonicalReplicas(regions),
      ...(table.StreamSpecification?.StreamEnabled ? { StreamSpecification: Object.freeze({ StreamViewType: String(table.StreamSpecification.StreamViewType) as NonNullable<DynamoDbGlobalTableModel["StreamSpecification"]>["StreamViewType"] }) } : {}),
    });
    return {
      model: current,
      arn: String(table.TableArn),
      tableId: String(table.TableId),
      ...(table.LatestStreamArn ? { streamArn: String(table.LatestStreamArn) } : {}),
      tags,
      active: table.TableStatus === "ACTIVE" && (table.Replicas ?? []).every((replica: Record<string, unknown>) => replica.ReplicaStatus === "ACTIVE"),
    };
  };

  const reconcile = async (physicalId: string, desired: DynamoDbGlobalTableModel, context: ProviderContext): Promise<ProviderUpdateResult<DynamoDbGlobalTableModel>> => {
    const current = await describe(physicalId, context);
    if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Global table ${physicalId} is not owned by this stack resource` };
    if (physicalId !== desired.TableName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "TableName changes require replacement" };
    for (const property of ["AttributeDefinitions", "KeySchema", "StreamSpecification"] as const) {
      if (!cfn10Same(current.model[property], desired[property])) return { status: "FAILED", errorCode: "RequiresReplacement", message: `${property} changes require replacement` };
    }
    if (!current.active) return inProgress(physicalId, "Waiting for the global table to become ACTIVE");

    const existing = new Set(current.model.Replicas.map(replica => replica.Region));
    const wanted = new Set(desired.Replicas.map(replica => replica.Region));
    const removal = [...existing].filter(region => region !== context.region && !wanted.has(region)).sort()[0];
    if (removal) {
      await dynamodb.UpdateTable({
        TableName: physicalId,
        MultiRegionConsistency: "EVENTUAL",
        ReplicaUpdates: [{ Delete: { RegionName: removal } }],
      });
      return inProgress(physicalId, `Removing replica ${removal}`);
    }
    const addition = [...wanted].filter(region => region !== context.region && !existing.has(region)).sort()[0];
    if (addition) {
      await dynamodb.UpdateTable({
        TableName: physicalId,
        MultiRegionConsistency: "EVENTUAL",
        ReplicaUpdates: [{ Create: { RegionName: addition } }],
      });
      return inProgress(physicalId, `Creating replica ${addition}`);
    }

    return success(await describe(physicalId, context));
  };

  return {
    typeName: DYNAMODB_GLOBAL_TABLE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: DYNAMODB_GLOBAL_TABLE_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validation(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): DynamoDbGlobalTableModel {
      if (!cfn10Record(properties)) throw new TypeError(`${DYNAMODB_GLOBAL_TABLE_TYPE} Properties must be an object`);
      const issues = validation(properties, context);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return model(properties, context);
    },
    plan(previous: DynamoDbGlobalTableModel | undefined, desired: DynamoDbGlobalTableModel): ProviderPlan<DynamoDbGlobalTableModel> {
      const planned = cfn10Plan(previous as DynamoDbGlobalTableModel & Record<string, unknown> | undefined, desired as DynamoDbGlobalTableModel & Record<string, unknown>, DYNAMODB_GLOBAL_TABLE_SCHEMA) as ProviderPlan<DynamoDbGlobalTableModel>;
      if (planned.action !== "REPLACE" || !previous || previous.TableName !== desired.TableName) return planned;
      return { ...planned, replacementOrder: "DELETE_BEFORE_CREATE", reason: "DynamoDB table names are unique within an account and Region" };
    },
    async create(desired: DynamoDbGlobalTableModel, context: ProviderContext) {
      try {
        try {
          const current = await describe(desired.TableName, context);
          if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Table ${desired.TableName} already exists and is not owned by this stack resource` };
          return await reconcile(desired.TableName, desired, context);
        } catch (error) {
          if (!cfn10Missing(error)) throw error;
        }
        await dynamodb.CreateTable({
          TableName: desired.TableName,
          AttributeDefinitions: desired.AttributeDefinitions,
          KeySchema: desired.KeySchema,
          BillingMode: "PAY_PER_REQUEST",
          ...(desired.StreamSpecification ? { StreamSpecification: { StreamEnabled: true, StreamViewType: desired.StreamSpecification.StreamViewType } } : {}),
          SSESpecification: { Enabled: false },
          Tags: cfn10ServiceTags([], context),
        });
        return inProgress(desired.TableName, "Creating global-table replicas");
      } catch (error) {
        return cfn10Failure(error);
      }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<DynamoDbGlobalTableModel>> {
      try {
        const current = await describe(physicalId, context);
        if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Global table ${physicalId} is not owned by this stack resource` };
        return success(current);
      }
      catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error); }
    },
    async update(physicalId: string, _previous: DynamoDbGlobalTableModel, desired: DynamoDbGlobalTableModel, context: ProviderContext): Promise<ProviderUpdateResult<DynamoDbGlobalTableModel>> {
      try { return await reconcile(physicalId, desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async delete(physicalId: string, _previous: DynamoDbGlobalTableModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await describe(physicalId, context);
        if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Global table ${physicalId} is not owned by this stack resource` };
        if (!current.active) return inProgress(physicalId, "Waiting for the global table to become ACTIVE");
        const replica = current.model.Replicas.map(item => item.Region).filter(region => region !== context.region).sort()[0];
        if (replica) {
          await dynamodb.UpdateTable({
            TableName: physicalId,
            MultiRegionConsistency: "EVENTUAL",
            ReplicaUpdates: [{ Delete: { RegionName: replica } }],
          });
          return inProgress(physicalId, `Removing replica ${replica}`);
        }
        await dynamodb.DeleteTable({ TableName: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderDeleteResult;
      }
    },
    ref(current: ProviderReadModel<DynamoDbGlobalTableModel>): unknown { return current.physicalId; },
    getAtt(current: ProviderReadModel<DynamoDbGlobalTableModel>, attribute: string): unknown {
      return cfn10GetAtt(DYNAMODB_GLOBAL_TABLE_TYPE, DYNAMODB_GLOBAL_TABLE_SCHEMA, current, attribute);
    },
  };
}
