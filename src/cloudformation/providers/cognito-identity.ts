import type { CognitoIdentityService } from "../../cognito-identity.js";
import { AwsError } from "../../errors.js";
import {
  cfn10ExactKeys,
  cfn10GeneratedName,
  cfn10GetAtt,
  cfn10Issue,
  cfn10Plan,
  cfn10Stable,
  cfn10ThrowIssues,
  CFN10_NO_TAGS,
  CFN10_RETENTION,
  type Cfn10Object,
} from "./cfn10-common.js";
import {
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const COGNITO_IDENTITY_POOL_TYPE = "AWS::Cognito::IdentityPool";
export const COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE = "AWS::Cognito::IdentityPoolRoleAttachment";

type Model = Readonly<Record<string, any>>;
type Json = Record<string, any>;

const stringProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "NOT_SUPPORTED", required = false) =>
  Object.freeze({ valueType: "string" as const, updateBehavior, ...(required ? { required: true } : {}) });
const booleanProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "NOT_SUPPORTED", required = false) =>
  Object.freeze({ valueType: "boolean" as const, updateBehavior, ...(required ? { required: true } : {}) });
const objectProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "NOT_SUPPORTED") =>
  Object.freeze({ valueType: "object" as const, updateBehavior });
const arrayProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "NOT_SUPPORTED") =>
  Object.freeze({ valueType: "array" as const, updateBehavior });

export const COGNITO_IDENTITY_POOL_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_IDENTITY_POOL_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AllowUnauthenticatedIdentities: booleanProperty("MUTABLE", true),
    IdentityPoolName: stringProperty("MUTABLE"),
    CognitoIdentityProviders: arrayProperty("MUTABLE"),
    IdentityPoolTags: objectProperty("MUTABLE"),
    AllowClassicFlow: booleanProperty("MUTABLE"),
    DeveloperProviderName: stringProperty("NOT_SUPPORTED"),
    SupportedLoginProviders: objectProperty("NOT_SUPPORTED"),
    SamlProviderARNs: arrayProperty("NOT_SUPPORTED"),
    OpenIdConnectProviderARNs: arrayProperty("NOT_SUPPORTED"),
    CognitoEvents: objectProperty("NOT_SUPPORTED"),
    CognitoStreams: objectProperty("NOT_SUPPORTED"),
    PushSync: objectProperty("NOT_SUPPORTED"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Identity pool identifier." }),
  attributes: Object.freeze({
    Id: Object.freeze({ valueType: "string" }),
    Name: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE" as const }),
  retention: CFN10_RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE" as const, propertyName: "IdentityPoolTags", propagatesCloudFormationTags: true }),
});

export const COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    IdentityPoolId: stringProperty("REPLACEMENT", true),
    Roles: objectProperty("MUTABLE"),
    RoleMappings: objectProperty("NOT_SUPPORTED"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Identity pool identifier." }),
  attributes: Object.freeze({
    Id: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({
    defaultOrder: "DELETE_BEFORE_CREATE" as const,
    deleteBeforeCreateReason: "IdentityPoolId change replaces the unique role attachment for that pool.",
  }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

function failed<Model = unknown>(error: unknown): ProviderUpdateResult<Model> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function isMissing(error: unknown): boolean {
  return error instanceof AwsError && error.code === "ResourceNotFoundException";
}

function success(physicalId: string, desired: Model, attributes: Cfn10Object = {}): ProviderUpdateResult<Model> {
  return { status: "SUCCESS", physicalId, model: Object.freeze({ physicalId, properties: desired, attributes }) };
}

function tagArrayToMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((item: any) => [String(item.Key), String(item.Value ?? "")]));
  }
  if (value && typeof value === "object") return { ...(value as Record<string, string>) };
  return {};
}

function canonicalProviders(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return cfn10Stable(value.map((item: any) => ({
    ProviderName: item.ProviderName,
    ClientId: item.ClientId,
    ...(item.ServerSideTokenCheck === undefined ? {} : { ServerSideTokenCheck: item.ServerSideTokenCheck }),
  })).sort((left: any, right: any) => String(left.ProviderName).localeCompare(String(right.ProviderName))
    || String(left.ClientId).localeCompare(String(right.ClientId))));
}

const REJECTED_POOL_PROPERTIES = [
  "DeveloperProviderName",
  "SupportedLoginProviders",
  "SamlProviderARNs",
  "OpenIdConnectProviderARNs",
  "CognitoEvents",
  "CognitoStreams",
  "PushSync",
] as const;

function poolIssues(properties: unknown, _context: ProviderContext): ProviderValidationIssue[] {
  const issues = [...validateDeclaredProperties(properties, COGNITO_IDENTITY_POOL_SCHEMA)];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return issues;
  const record = properties as Cfn10Object;
  if (record.AllowClassicFlow === true) {
    cfn10Issue(issues, "Properties.AllowClassicFlow", "AllowClassicFlow=true is not supported.");
  }
  for (const field of REJECTED_POOL_PROPERTIES) {
    if (record[field] !== undefined) {
      cfn10Issue(issues, `Properties.${field}`, `${field} is not supported.`);
    }
  }
  if (Array.isArray(record.CognitoIdentityProviders)) {
    for (const [index, provider] of record.CognitoIdentityProviders.entries()) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
        cfn10Issue(issues, `Properties.CognitoIdentityProviders[${index}]`, "Provider entries must be objects.");
        continue;
      }
      cfn10ExactKeys(provider as Cfn10Object, ["ProviderName", "ClientId", "ServerSideTokenCheck"], `Properties.CognitoIdentityProviders[${index}]`, issues);
    }
  }
  return issues;
}

function attachmentIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = [...validateDeclaredProperties(properties, COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_SCHEMA)];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return issues;
  const record = properties as Cfn10Object;
  if (record.RoleMappings !== undefined) {
    cfn10Issue(issues, "Properties.RoleMappings", "RoleMappings is not supported.");
  }
  if (record.Roles && typeof record.Roles === "object" && !Array.isArray(record.Roles)) {
    cfn10ExactKeys(record.Roles as Cfn10Object, ["authenticated", "unauthenticated"], "Properties.Roles", issues);
  }
  return issues;
}

function canonicalPool(input: Cfn10Object, context: ProviderContext): Model {
  const name = typeof input.IdentityPoolName === "string" && input.IdentityPoolName
    ? input.IdentityPoolName
    : cfn10GeneratedName(context, "", 128, /[^\w\s+=,.@-]/g);
  const tags = tagArrayToMap(input.IdentityPoolTags);
  return cfn10Stable({
    AllowUnauthenticatedIdentities: Boolean(input.AllowUnauthenticatedIdentities),
    IdentityPoolName: name,
    ...(input.CognitoIdentityProviders === undefined ? {} : { CognitoIdentityProviders: canonicalProviders(input.CognitoIdentityProviders) }),
    ...(Object.keys(tags).length ? { IdentityPoolTags: tags } : {}),
    ...(input.AllowClassicFlow === true ? { AllowClassicFlow: true } : {}),
  });
}

function canonicalAttachment(input: Cfn10Object): Model {
  return cfn10Stable({
    IdentityPoolId: input.IdentityPoolId,
    ...(input.Roles === undefined ? {} : { Roles: input.Roles }),
  });
}

async function readPool(service: CognitoIdentityService, poolId: string): Promise<ProviderReadModel<Model>> {
  const raw = (await service.executeCloudFormationControl("DescribeIdentityPool", { IdentityPoolId: poolId })) as Json;
  const tags = (await service.executeCloudFormationControl("ListTagsForResource", { ResourceArn: service.resourceArn(poolId) })).Tags as Record<string, string> | undefined;
  const properties = cfn10Stable({
    AllowUnauthenticatedIdentities: Boolean(raw.AllowUnauthenticatedIdentities),
    IdentityPoolName: raw.IdentityPoolName,
    ...(Array.isArray(raw.CognitoIdentityProviders) && raw.CognitoIdentityProviders.length
      ? { CognitoIdentityProviders: canonicalProviders(raw.CognitoIdentityProviders) }
      : {}),
    ...(tags && Object.keys(tags).length ? { IdentityPoolTags: cfn10Stable(tags) } : {}),
  });
  return Object.freeze({
    physicalId: poolId,
    properties,
    attributes: Object.freeze({ Id: poolId, Name: String(raw.IdentityPoolName ?? "") }),
  });
}

function createPoolProvider(service: CognitoIdentityService): ProductionResourceProvider<Model> {
  return {
    typeName: COGNITO_IDENTITY_POOL_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: COGNITO_IDENTITY_POOL_SCHEMA,
    validate: (properties, context) => poolIssues(properties, context),
    canonicalize: (properties, context) => canonicalPool((properties ?? {}) as Cfn10Object, context),
    plan(previous, desired) { return cfn10Plan(previous, desired, COGNITO_IDENTITY_POOL_SCHEMA); },
    async create(desired) {
      try {
        cfn10ThrowIssues(poolIssues(desired, { stackId: "", logicalId: "", region: service.region, accountId: "", partition: "aws" } as ProviderContext));
        const tags = tagArrayToMap(desired.IdentityPoolTags);
        const response = await service.executeCloudFormationControl("CreateIdentityPool", {
          IdentityPoolName: desired.IdentityPoolName,
          AllowUnauthenticatedIdentities: desired.AllowUnauthenticatedIdentities,
          ...(desired.CognitoIdentityProviders ? { CognitoIdentityProviders: desired.CognitoIdentityProviders } : {}),
          ...(Object.keys(tags).length ? { IdentityPoolTags: tags } : {}),
        });
        const poolId = String(response.IdentityPoolId);
        return success(poolId, desired, { Id: poolId, Name: String(response.IdentityPoolName ?? desired.IdentityPoolName) });
      } catch (error) { return failed(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<Model>> {
      try {
        const model = await readPool(service, physicalId);
        return { status: "SUCCESS", model };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND" } : failed(error) as ProviderReadResult<Model>;
      }
    },
    async update(physicalId, _previous, desired) {
      try {
        const tags = tagArrayToMap(desired.IdentityPoolTags);
        await service.executeCloudFormationControl("UpdateIdentityPool", {
          IdentityPoolId: physicalId,
          IdentityPoolName: desired.IdentityPoolName,
          AllowUnauthenticatedIdentities: desired.AllowUnauthenticatedIdentities,
          CognitoIdentityProviders: desired.CognitoIdentityProviders ?? [],
          IdentityPoolTags: tags,
        });
        const current = await readPool(service, physicalId);
        return success(physicalId, desired, current.attributes);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        await service.executeCloudFormationControl("DeleteIdentityPool", { IdentityPoolId: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { return cfn10GetAtt(COGNITO_IDENTITY_POOL_TYPE, COGNITO_IDENTITY_POOL_SCHEMA, model, attribute); },
  };
}

function createAttachmentProvider(service: CognitoIdentityService): ProductionResourceProvider<Model> {
  return {
    typeName: COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_SCHEMA,
    validate: properties => attachmentIssues(properties),
    canonicalize: properties => canonicalAttachment((properties ?? {}) as Cfn10Object),
    plan(previous, desired) { return cfn10Plan(previous, desired, COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_SCHEMA); },
    async create(desired) {
      try {
        await service.executeCloudFormationControl("SetIdentityPoolRoles", {
          IdentityPoolId: desired.IdentityPoolId,
          Roles: desired.Roles ?? {},
        });
        return success(String(desired.IdentityPoolId), desired, { Id: desired.IdentityPoolId });
      } catch (error) { return failed(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<Model>> {
      try {
        const raw = await service.executeCloudFormationControl("GetIdentityPoolRoles", { IdentityPoolId: physicalId });
        const model = Object.freeze({
          physicalId,
          properties: canonicalAttachment({ IdentityPoolId: physicalId, Roles: raw.Roles }),
          attributes: Object.freeze({ Id: physicalId }),
        });
        return { status: "SUCCESS", model };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND" } : failed(error) as ProviderReadResult<Model>;
      }
    },
    async update(physicalId, _previous, desired) {
      try {
        await service.executeCloudFormationControl("SetIdentityPoolRoles", {
          IdentityPoolId: desired.IdentityPoolId ?? physicalId,
          Roles: desired.Roles ?? {},
        });
        return success(physicalId, desired, { Id: physicalId });
      } catch (error) { return failed(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        await service.executeCloudFormationControl("SetIdentityPoolRoles", { IdentityPoolId: physicalId, Roles: {} });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { return cfn10GetAtt(COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE, COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_SCHEMA, model, attribute); },
  };
}

export function createCognitoIdentityCloudFormationProviders(
  service: CognitoIdentityService,
): readonly ProductionResourceProvider<Model>[] {
  return Object.freeze([
    createPoolProvider(service),
    createAttachmentProvider(service),
  ]);
}

export const COGNITO_IDENTITY_CLOUDFORMATION_RESOURCE_TYPES = Object.freeze([
  COGNITO_IDENTITY_POOL_TYPE,
  COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE,
].sort());

export const COGNITO_IDENTITY_CLOUDFORMATION_AUTHORIZATION_MATRIX = Object.freeze({
  [COGNITO_IDENTITY_POOL_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-identity:CreateIdentityPool", "cognito-identity:DescribeIdentityPool", "cognito-identity:ListTagsForResource"]),
    READ: Object.freeze(["cognito-identity:DescribeIdentityPool", "cognito-identity:ListTagsForResource"]),
    UPDATE: Object.freeze(["cognito-identity:DescribeIdentityPool", "cognito-identity:UpdateIdentityPool", "cognito-identity:ListTagsForResource", "cognito-identity:TagResource", "cognito-identity:UntagResource"]),
    DELETE: Object.freeze(["cognito-identity:DeleteIdentityPool"]),
  }),
  [COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-identity:SetIdentityPoolRoles", "cognito-identity:GetIdentityPoolRoles"]),
    READ: Object.freeze(["cognito-identity:GetIdentityPoolRoles"]),
    UPDATE: Object.freeze(["cognito-identity:SetIdentityPoolRoles", "cognito-identity:GetIdentityPoolRoles"]),
    DELETE: Object.freeze(["cognito-identity:SetIdentityPoolRoles", "cognito-identity:GetIdentityPoolRoles"]),
  }),
});

export const COGNITO_IDENTITY_CLOUDFORMATION_EXECUTION_ACTIONS = Object.freeze(
  [...new Set(Object.values(COGNITO_IDENTITY_CLOUDFORMATION_AUTHORIZATION_MATRIX)
    .flatMap(operations => Object.values(operations).flat()))].sort(),
);
