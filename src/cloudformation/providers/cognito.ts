import { createHash } from "node:crypto";
import type { CognitoService } from "../../cognito.js";
import { AwsError } from "../../errors.js";
import {
  cfn10ExactKeys,
  cfn10GeneratedName,
  cfn10GetAtt,
  cfn10Issue,
  cfn10ParsePhysical,
  cfn10Physical,
  cfn10Plan,
  cfn10Same,
  cfn10Stable,
  cfn10ThrowIssues,
  CFN10_NO_TAGS,
  CFN10_RETENTION,
} from "./cfn10-common.js";
import {
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderFailed,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const COGNITO_USER_POOL_TYPE = "AWS::Cognito::UserPool";
export const COGNITO_USER_POOL_CLIENT_TYPE = "AWS::Cognito::UserPoolClient";
export const COGNITO_USER_POOL_GROUP_TYPE = "AWS::Cognito::UserPoolGroup";
export const COGNITO_USER_POOL_USER_TYPE = "AWS::Cognito::UserPoolUser";
export const COGNITO_USER_POOL_USER_TO_GROUP_TYPE = "AWS::Cognito::UserPoolUserToGroupAttachment";
export const COGNITO_USER_POOL_RESOURCE_SERVER_TYPE = "AWS::Cognito::UserPoolResourceServer";
export const COGNITO_USER_POOL_DOMAIN_TYPE = "AWS::Cognito::UserPoolDomain";
export const COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE = "AWS::Cognito::UserPoolIdentityProvider";

type Model = Readonly<Record<string, any>>;
type Json = Record<string, any>;

const objectProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT") =>
  Object.freeze({ valueType: "object" as const, updateBehavior });
const arrayProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT") =>
  Object.freeze({ valueType: "array" as const, updateBehavior });
const stringProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT", required = false) =>
  Object.freeze({ valueType: "string" as const, updateBehavior, ...(required ? { required: true } : {}) });
const booleanProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT") =>
  Object.freeze({ valueType: "boolean" as const, updateBehavior });
const numberProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT") =>
  Object.freeze({ valueType: "number" as const, updateBehavior });

const USER_POOL_OBJECT_TAGS = Object.freeze({
  behavior: "STACK_AND_RESOURCE" as const,
  propertyName: "UserPoolTags",
  propagatesCloudFormationTags: true,
});

export const COGNITO_USER_POOL_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolName: stringProperty("MUTABLE"),
    Policies: objectProperty("MUTABLE"),
    DeletionProtection: stringProperty("MUTABLE"),
    AutoVerifiedAttributes: arrayProperty("MUTABLE"),
    AliasAttributes: arrayProperty("REPLACEMENT"),
    UsernameAttributes: arrayProperty("REPLACEMENT"),
    UsernameConfiguration: objectProperty("REPLACEMENT"),
    AdminCreateUserConfig: objectProperty("MUTABLE"),
    Schema: arrayProperty("MUTABLE"),
    AccountRecoverySetting: objectProperty("MUTABLE"),
    EmailConfiguration: objectProperty("MUTABLE"),
    EmailVerificationMessage: stringProperty("MUTABLE"),
    EmailVerificationSubject: stringProperty("MUTABLE"),
    VerificationMessageTemplate: objectProperty("MUTABLE"),
    MfaConfiguration: stringProperty("MUTABLE"),
    EnabledMfas: arrayProperty("MUTABLE"),
    LambdaConfig: objectProperty("MUTABLE"),
    UserPoolTier: stringProperty("MUTABLE"),
    UserPoolTags: objectProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "User-pool identifier." }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string" }),
    ProviderName: Object.freeze({ valueType: "string" }),
    ProviderURL: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({
    defaultOrder: "DELETE_BEFORE_CREATE" as const,
    deleteBeforeCreateReason: "User-pool names are account/Region unique and deterministic replacements can retain the same name.",
  }),
  retention: CFN10_RETENTION,
  tags: USER_POOL_OBJECT_TAGS,
});

export const COGNITO_USER_POOL_CLIENT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_CLIENT_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    ClientName: stringProperty("MUTABLE"),
    GenerateSecret: booleanProperty("REPLACEMENT"),
    RefreshTokenValidity: numberProperty("MUTABLE"),
    AccessTokenValidity: numberProperty("MUTABLE"),
    IdTokenValidity: numberProperty("MUTABLE"),
    TokenValidityUnits: objectProperty("MUTABLE"),
    ReadAttributes: arrayProperty("MUTABLE"),
    WriteAttributes: arrayProperty("MUTABLE"),
    ExplicitAuthFlows: arrayProperty("MUTABLE"),
    PreventUserExistenceErrors: stringProperty("MUTABLE"),
    EnableTokenRevocation: booleanProperty("MUTABLE"),
    AuthSessionValidity: numberProperty("MUTABLE"),
    RefreshTokenRotation: objectProperty("MUTABLE"),
    SupportedIdentityProviders: arrayProperty("MUTABLE"),
    CallbackURLs: arrayProperty("MUTABLE"),
    LogoutURLs: arrayProperty("MUTABLE"),
    DefaultRedirectURI: stringProperty("MUTABLE"),
    AllowedOAuthFlows: arrayProperty("MUTABLE"),
    AllowedOAuthScopes: arrayProperty("MUTABLE"),
    AllowedOAuthFlowsUserPoolClient: booleanProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "App-client identifier." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const COGNITO_USER_POOL_GROUP_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_GROUP_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    GroupName: stringProperty("REPLACEMENT"),
    Description: stringProperty("MUTABLE"),
    RoleArn: stringProperty("MUTABLE"),
    Precedence: numberProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const COGNITO_USER_POOL_USER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_USER_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    Username: stringProperty("REPLACEMENT"),
    UserAttributes: arrayProperty("MUTABLE"),
    ValidationData: arrayProperty("REPLACEMENT"),
    ClientMetadata: objectProperty("REPLACEMENT"),
    DesiredDeliveryMediums: arrayProperty("REPLACEMENT"),
    ForceAliasCreation: booleanProperty("REPLACEMENT"),
    MessageAction: stringProperty("REPLACEMENT"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const COGNITO_USER_POOL_USER_TO_GROUP_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_USER_TO_GROUP_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    Username: stringProperty("REPLACEMENT", true),
    GroupName: stringProperty("REPLACEMENT", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const COGNITO_USER_POOL_RESOURCE_SERVER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_RESOURCE_SERVER_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    Identifier: stringProperty("REPLACEMENT", true),
    Name: stringProperty("MUTABLE", true),
    Scopes: arrayProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const COGNITO_USER_POOL_DOMAIN_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_DOMAIN_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    Domain: stringProperty("REPLACEMENT", true),
    ManagedLoginVersion: numberProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const COGNITO_USER_POOL_IDENTITY_PROVIDER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    UserPoolId: stringProperty("REPLACEMENT", true),
    ProviderName: stringProperty("REPLACEMENT", true),
    ProviderType: stringProperty("REPLACEMENT", true),
    ProviderDetails: objectProperty("MUTABLE"),
    AttributeMapping: objectProperty("MUTABLE"),
    IdpIdentifiers: arrayProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

const schemas = Object.freeze({
  [COGNITO_USER_POOL_TYPE]: COGNITO_USER_POOL_SCHEMA,
  [COGNITO_USER_POOL_CLIENT_TYPE]: COGNITO_USER_POOL_CLIENT_SCHEMA,
  [COGNITO_USER_POOL_GROUP_TYPE]: COGNITO_USER_POOL_GROUP_SCHEMA,
  [COGNITO_USER_POOL_USER_TYPE]: COGNITO_USER_POOL_USER_SCHEMA,
  [COGNITO_USER_POOL_USER_TO_GROUP_TYPE]: COGNITO_USER_POOL_USER_TO_GROUP_SCHEMA,
  [COGNITO_USER_POOL_RESOURCE_SERVER_TYPE]: COGNITO_USER_POOL_RESOURCE_SERVER_SCHEMA,
  [COGNITO_USER_POOL_DOMAIN_TYPE]: COGNITO_USER_POOL_DOMAIN_SCHEMA,
  [COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE]: COGNITO_USER_POOL_IDENTITY_PROVIDER_SCHEMA,
});

const USER_POOL_MUTABLE = Object.freeze([
  "Policies", "DeletionProtection", "AutoVerifiedAttributes", "AdminCreateUserConfig",
  "AccountRecoverySetting", "EmailConfiguration", "EmailVerificationMessage",
  "EmailVerificationSubject", "VerificationMessageTemplate", "MfaConfiguration",
  "EnabledMfas", "LambdaConfig", "UserPoolTier",
]);

const COGNITO_OWNER_TAG = "stacksim:cloudformation:owner";

function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function owner(context: ProviderContext): string {
  return createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
}

function issue(path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): ProviderValidationIssue {
  return { path, message, code };
}

function exactObject(value: unknown, allowed: readonly string[], path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return;
  cfn10ExactKeys(value, allowed, path, issues);
}

function stringArray(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (typeof item !== "string") issues.push(issue(`${path}[${index}]`, `${path} values must be strings`, "InvalidType"));
  });
  if (new Set(value).size !== value.length) issues.push(issue(path, `${path} must not contain duplicate values`));
}

function stringMap(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") issues.push(issue(`${path}.${key}`, `${path}.${key} must be a string`, "InvalidType"));
  }
}

function attributeArray(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  const names = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!record(item)) {
      issues.push(issue(itemPath, `${itemPath} must be an object`, "InvalidType"));
      return;
    }
    cfn10ExactKeys(item, ["Name", "Value"], itemPath, issues);
    if (typeof item.Name !== "string" || !item.Name) issues.push(issue(`${itemPath}.Name`, "Name is required"));
    else if (names.has(item.Name)) issues.push(issue(`${itemPath}.Name`, `Duplicate attribute ${item.Name}`));
    else names.add(item.Name);
    if (typeof item.Value !== "string") issues.push(issue(`${itemPath}.Value`, "Value must be a string", "InvalidType"));
  });
}

function userPoolIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, COGNITO_USER_POOL_SCHEMA);
  if (!record(properties)) return issues;
  if (properties.UserPoolName !== undefined && (typeof properties.UserPoolName !== "string" || !/^[\w\s+=,.@-]{1,128}$/u.test(properties.UserPoolName))) {
    issues.push(issue("Properties.UserPoolName", "UserPoolName must contain 1-128 valid characters"));
  }
  for (const name of ["AutoVerifiedAttributes", "AliasAttributes", "UsernameAttributes", "EnabledMfas"] as const) {
    stringArray(properties[name], `Properties.${name}`, issues);
  }
  if (Array.isArray(properties.AliasAttributes) && properties.AliasAttributes.length && Array.isArray(properties.UsernameAttributes) && properties.UsernameAttributes.length) {
    issues.push(issue("Properties.UsernameAttributes", "AliasAttributes and UsernameAttributes are mutually exclusive"));
  }
  exactObject(properties.UsernameConfiguration, ["CaseSensitive"], "Properties.UsernameConfiguration", issues);
  exactObject(properties.Policies, ["PasswordPolicy"], "Properties.Policies", issues);
  if (record(properties.Policies?.PasswordPolicy)) {
    cfn10ExactKeys(properties.Policies.PasswordPolicy, [
      "MinimumLength", "RequireUppercase", "RequireLowercase", "RequireNumbers",
      "RequireSymbols", "TemporaryPasswordValidityDays", "PasswordHistorySize",
    ], "Properties.Policies.PasswordPolicy", issues);
  }
  exactObject(properties.AdminCreateUserConfig, ["AllowAdminCreateUserOnly", "UnusedAccountValidityDays", "InviteMessageTemplate"], "Properties.AdminCreateUserConfig", issues);
  exactObject(properties.EmailConfiguration, ["EmailSendingAccount", "SourceArn", "From", "ReplyToEmailAddress", "ConfigurationSet"], "Properties.EmailConfiguration", issues);
  exactObject(properties.VerificationMessageTemplate, ["DefaultEmailOption", "EmailMessage", "EmailSubject"], "Properties.VerificationMessageTemplate", issues);
  exactObject(properties.AccountRecoverySetting, ["RecoveryMechanisms"], "Properties.AccountRecoverySetting", issues);
  exactObject(properties.LambdaConfig, ["PreSignUp", "CustomMessage", "PostConfirmation", "PreAuthentication", "PostAuthentication", "PreTokenGeneration", "PreTokenGenerationConfig"], "Properties.LambdaConfig", issues);
  if (properties.UserPoolTags !== undefined) {
    stringMap(properties.UserPoolTags, "Properties.UserPoolTags", issues);
    if (record(properties.UserPoolTags) && Object.keys(properties.UserPoolTags).length > 49) issues.push(issue("Properties.UserPoolTags", "UserPoolTags supports at most 49 user tags"));
    if (record(properties.UserPoolTags) && Object.keys(properties.UserPoolTags).some(key => key.startsWith("aws:") || key.startsWith("stacksim:cloudformation:"))) {
      issues.push(issue("Properties.UserPoolTags", "UserPoolTags contains a reserved tag key"));
    }
  }
  return issues;
}

function clientIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, COGNITO_USER_POOL_CLIENT_SCHEMA);
  if (!record(properties)) return issues;
  if (properties.ClientName !== undefined && (typeof properties.ClientName !== "string" || !/^[\w\s+=,.@-]{1,128}$/u.test(properties.ClientName))) {
    issues.push(issue("Properties.ClientName", "ClientName must contain 1-128 valid characters"));
  }
  for (const name of ["ReadAttributes", "WriteAttributes", "ExplicitAuthFlows", "SupportedIdentityProviders", "CallbackURLs", "LogoutURLs", "AllowedOAuthFlows", "AllowedOAuthScopes"] as const) {
    stringArray(properties[name], `Properties.${name}`, issues);
  }
  exactObject(properties.TokenValidityUnits, ["AccessToken", "IdToken", "RefreshToken"], "Properties.TokenValidityUnits", issues);
  exactObject(properties.RefreshTokenRotation, ["Feature", "RetryGracePeriodSeconds"], "Properties.RefreshTokenRotation", issues);
  if (!Array.isArray(properties.ExplicitAuthFlows) || properties.ExplicitAuthFlows.length === 0) {
    issues.push(issue("Properties.ExplicitAuthFlows", "ExplicitAuthFlows must select at least one supported authentication flow"));
  }
  return issues;
}

function commonIssues(properties: unknown, schema: ProviderSchema): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, schema);
  if (!record(properties)) return issues;
  if (schema === COGNITO_USER_POOL_USER_SCHEMA) {
    attributeArray(properties.UserAttributes, "Properties.UserAttributes", issues);
    attributeArray(properties.ValidationData, "Properties.ValidationData", issues);
    stringMap(properties.ClientMetadata, "Properties.ClientMetadata", issues);
    stringArray(properties.DesiredDeliveryMediums, "Properties.DesiredDeliveryMediums", issues);
  } else if (schema === COGNITO_USER_POOL_RESOURCE_SERVER_SCHEMA && Array.isArray(properties.Scopes)) {
    const names = new Set<string>();
    properties.Scopes.forEach((scope: unknown, index: number) => {
      const path = `Properties.Scopes[${index}]`;
      if (!record(scope)) issues.push(issue(path, `${path} must be an object`, "InvalidType"));
      else {
        cfn10ExactKeys(scope, ["ScopeName", "ScopeDescription"], path, issues);
        if (typeof scope.ScopeName !== "string" || !scope.ScopeName) issues.push(issue(`${path}.ScopeName`, "ScopeName is required"));
        else if (names.has(scope.ScopeName)) issues.push(issue(`${path}.ScopeName`, `Duplicate scope ${scope.ScopeName}`));
        else names.add(scope.ScopeName);
        if (typeof scope.ScopeDescription !== "string" || !scope.ScopeDescription) issues.push(issue(`${path}.ScopeDescription`, "ScopeDescription is required"));
      }
    });
  } else if (schema === COGNITO_USER_POOL_IDENTITY_PROVIDER_SCHEMA) {
    stringMap(properties.ProviderDetails, "Properties.ProviderDetails", issues);
    stringMap(properties.AttributeMapping, "Properties.AttributeMapping", issues);
    stringArray(properties.IdpIdentifiers, "Properties.IdpIdentifiers", issues);
  }
  return issues;
}

function validationFor(typeName: string, properties: unknown): ProviderValidationIssue[] {
  if (typeName === COGNITO_USER_POOL_TYPE) return userPoolIssues(properties);
  if (typeName === COGNITO_USER_POOL_CLIENT_TYPE) return clientIssues(properties);
  return commonIssues(properties, schemas[typeName as keyof typeof schemas]);
}

const passwordPolicyDefaults = Object.freeze({
  MinimumLength: 8,
  RequireUppercase: true,
  RequireLowercase: true,
  RequireNumbers: true,
  RequireSymbols: true,
  TemporaryPasswordValidityDays: 7,
  PasswordHistorySize: 0,
});

function canonicalTags(value: unknown): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(record(value) ? value : {})
      .map(([key, item]) => [key, String(item)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function canonicalUserPool(properties: unknown, context: ProviderContext): Model {
  const issues = userPoolIssues(properties);
  cfn10ThrowIssues(issues);
  const input = properties as Json;
  const password = record(input.Policies?.PasswordPolicy) ? input.Policies.PasswordPolicy : {};
  return Object.freeze(cfn10Stable({
    UserPoolName: input.UserPoolName ?? cfn10GeneratedName(context, "pool-", 128, /[^\w\s+=,.@-]/gu),
    Policies: { PasswordPolicy: { ...passwordPolicyDefaults, ...password } },
    DeletionProtection: input.DeletionProtection ?? "INACTIVE",
    AutoVerifiedAttributes: [...(input.AutoVerifiedAttributes ?? [])].sort(),
    AliasAttributes: [...(input.AliasAttributes ?? [])].sort(),
    UsernameAttributes: [...(input.UsernameAttributes ?? [])].sort(),
    UsernameConfiguration: { CaseSensitive: input.UsernameConfiguration?.CaseSensitive ?? true },
    AdminCreateUserConfig: {
      AllowAdminCreateUserOnly: input.AdminCreateUserConfig?.AllowAdminCreateUserOnly ?? false,
      ...(input.AdminCreateUserConfig?.UnusedAccountValidityDays === undefined ? {} : { UnusedAccountValidityDays: input.AdminCreateUserConfig.UnusedAccountValidityDays }),
      InviteMessageTemplate: {
        EmailSubject: input.AdminCreateUserConfig?.InviteMessageTemplate?.EmailSubject ?? "Your temporary password",
        EmailMessage: input.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage ?? "Your username is {username} and temporary password is {####}.",
      },
    },
    Schema: cfn10Stable(input.Schema ?? []),
    AccountRecoverySetting: cfn10Stable(input.AccountRecoverySetting ?? { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] }),
    EmailConfiguration: cfn10Stable(input.EmailConfiguration ?? { EmailSendingAccount: "COGNITO_DEFAULT" }),
    VerificationMessageTemplate: cfn10Stable(input.VerificationMessageTemplate ?? {
      DefaultEmailOption: "CONFIRM_WITH_CODE",
      EmailSubject: input.EmailVerificationSubject ?? "Your verification code",
      EmailMessage: input.EmailVerificationMessage ?? "Your verification code is {####}.",
    }),
    MfaConfiguration: input.MfaConfiguration ?? "OFF",
    EnabledMfas: [...(input.EnabledMfas ?? [])].sort(),
    LambdaConfig: cfn10Stable(input.LambdaConfig ?? {}),
    UserPoolTier: input.UserPoolTier ?? "ESSENTIALS",
    UserPoolTags: canonicalTags(input.UserPoolTags),
  }));
}

function canonicalClient(properties: unknown, context: ProviderContext): Model {
  const issues = clientIssues(properties);
  cfn10ThrowIssues(issues);
  const input = properties as Json;
  return Object.freeze(cfn10Stable({
    UserPoolId: input.UserPoolId,
    ClientName: input.ClientName ?? cfn10GeneratedName(context, "client-", 128, /[^\w\s+=,.@-]/gu),
    GenerateSecret: input.GenerateSecret ?? false,
    RefreshTokenValidity: input.RefreshTokenValidity ?? 30,
    AccessTokenValidity: input.AccessTokenValidity ?? 1,
    IdTokenValidity: input.IdTokenValidity ?? 1,
    TokenValidityUnits: input.TokenValidityUnits ?? { AccessToken: "hours", IdToken: "hours", RefreshToken: "days" },
    ReadAttributes: [...(input.ReadAttributes ?? ["email"])].sort(),
    WriteAttributes: [...(input.WriteAttributes ?? ["email"])].sort(),
    ExplicitAuthFlows: [...input.ExplicitAuthFlows].sort(),
    PreventUserExistenceErrors: input.PreventUserExistenceErrors ?? "LEGACY",
    EnableTokenRevocation: input.EnableTokenRevocation ?? true,
    AuthSessionValidity: input.AuthSessionValidity ?? 3,
    RefreshTokenRotation: input.RefreshTokenRotation ?? { Feature: "DISABLED", RetryGracePeriodSeconds: 0 },
    SupportedIdentityProviders: [...(input.SupportedIdentityProviders ?? ["COGNITO"])].sort(),
    CallbackURLs: [...(input.CallbackURLs ?? [])].sort(),
    LogoutURLs: [...(input.LogoutURLs ?? [])].sort(),
    ...(input.DefaultRedirectURI === undefined ? {} : { DefaultRedirectURI: input.DefaultRedirectURI }),
    AllowedOAuthFlows: [...(input.AllowedOAuthFlows ?? [])].sort(),
    AllowedOAuthScopes: [...(input.AllowedOAuthScopes ?? [])].sort(),
    AllowedOAuthFlowsUserPoolClient: input.AllowedOAuthFlowsUserPoolClient ?? false,
  }));
}

function canonicalCommon(typeName: string, properties: unknown, context: ProviderContext): Model {
  const issues = validationFor(typeName, properties);
  cfn10ThrowIssues(issues);
  const input = structuredClone(properties as Json);
  if (typeName === COGNITO_USER_POOL_GROUP_TYPE) {
    input.GroupName ??= cfn10GeneratedName(context, "group-", 128, /[^\p{L}\p{M}\p{S}\p{N}\p{P} ]/gu);
  } else if (typeName === COGNITO_USER_POOL_USER_TYPE) {
    input.Username ??= cfn10GeneratedName(context, "user-", 128, /[^\p{L}\p{M}\p{S}\p{N}\p{P}]/gu);
    input.UserAttributes ??= [];
  } else if (typeName === COGNITO_USER_POOL_RESOURCE_SERVER_TYPE) {
    input.Scopes ??= [];
  } else if (typeName === COGNITO_USER_POOL_DOMAIN_TYPE) {
    input.ManagedLoginVersion ??= 2;
  } else if (typeName === COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE) {
    input.ProviderDetails ??= {};
    input.AttributeMapping ??= {};
    input.IdpIdentifiers ??= [];
  }
  return Object.freeze(cfn10Stable(input));
}

function canonicalFor(typeName: string, properties: unknown, context: ProviderContext): Model {
  if (typeName === COGNITO_USER_POOL_TYPE) return canonicalUserPool(properties, context);
  if (typeName === COGNITO_USER_POOL_CLIENT_TYPE) return canonicalClient(properties, context);
  return canonicalCommon(typeName, properties, context);
}

function failed(error: unknown): ProviderFailed {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return {
    status: "FAILED",
    errorCode: aws.code,
    message: aws.message,
    ...(aws.status >= 500 ? { retryable: true } : {}),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof AwsError && ["ResourceNotFoundException", "UserNotFoundException"].includes(error.code);
}

function success(physicalId: string, properties: Model, attributes: Record<string, unknown> = {}) {
  return {
    status: "SUCCESS" as const,
    physicalId,
    model: { physicalId, properties, attributes },
  };
}

function providerName(context: ProviderContext, poolId: string): string {
  const suffix = context.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `cognito-idp.${context.region}.${suffix}/${poolId}`;
}

function poolAttributes(context: ProviderContext, poolId: string, arn?: unknown): Record<string, string> {
  const name = providerName(context, poolId);
  return {
    Arn: typeof arn === "string" ? arn : `arn:${context.partition}:cognito-idp:${context.region}:${context.accountId}:userpool/${poolId}`,
    ProviderName: name,
    ProviderURL: `https://${name}`,
  };
}

function servicePoolInput(model: Model, context: ProviderContext, create: boolean): Json {
  const input: Json = {
    PoolName: model.UserPoolName,
    ...Object.fromEntries(USER_POOL_MUTABLE.filter(name => model[name] !== undefined).map(name => [name, model[name]])),
  };
  if (create) {
    input.AliasAttributes = model.AliasAttributes;
    input.UsernameAttributes = model.UsernameAttributes;
    input.UsernameConfiguration = model.UsernameConfiguration;
    input.Schema = model.Schema;
    input.UserPoolTags = { ...model.UserPoolTags, [COGNITO_OWNER_TAG]: owner(context) };
  }
  return input;
}

function poolModel(raw: Json, tags: Record<string, string>): Model {
  const cleanTags = Object.fromEntries(Object.entries(tags).filter(([key]) => key !== COGNITO_OWNER_TAG));
  return Object.freeze(cfn10Stable({
    UserPoolName: raw.Name,
    Policies: raw.Policies,
    DeletionProtection: raw.DeletionProtection,
    AutoVerifiedAttributes: raw.AutoVerifiedAttributes ?? [],
    AliasAttributes: raw.AliasAttributes ?? [],
    UsernameAttributes: raw.UsernameAttributes ?? [],
    UsernameConfiguration: raw.UsernameConfiguration,
    AdminCreateUserConfig: raw.AdminCreateUserConfig,
    Schema: raw.SchemaAttributes ?? [],
    AccountRecoverySetting: raw.AccountRecoverySetting,
    EmailConfiguration: raw.EmailConfiguration,
    VerificationMessageTemplate: raw.VerificationMessageTemplate,
    MfaConfiguration: raw.MfaConfiguration,
    EnabledMfas: raw.EnabledMfas ?? [],
    LambdaConfig: Object.fromEntries(Object.entries(raw.LambdaConfig ?? {}).filter(([, value]) => value !== undefined)),
    UserPoolTier: raw.UserPoolTier,
    UserPoolTags: canonicalTags(cleanTags),
  }));
}

async function readPool(service: CognitoService, poolId: string, context: ProviderContext): Promise<ProviderReadModel<Model>> {
  const raw = (await service.executeCloudFormationControl("DescribeUserPool", { UserPoolId: poolId })).UserPool as Json;
  const tags = (await service.executeCloudFormationControl("ListTagsForResource", { ResourceArn: raw.Arn })).Tags as Record<string, string>;
  return { physicalId: poolId, properties: poolModel(raw, tags), attributes: poolAttributes(context, poolId, raw.Arn) };
}

function clientInput(model: Model, create: boolean, clientId?: string): Json {
  return {
    UserPoolId: model.UserPoolId,
    ...(create ? { ClientName: model.ClientName, GenerateSecret: model.GenerateSecret } : { ClientId: clientId, ClientName: model.ClientName }),
    RefreshTokenValidity: model.RefreshTokenValidity,
    AccessTokenValidity: model.AccessTokenValidity,
    IdTokenValidity: model.IdTokenValidity,
    TokenValidityUnits: model.TokenValidityUnits,
    ReadAttributes: model.ReadAttributes,
    WriteAttributes: model.WriteAttributes,
    ExplicitAuthFlows: model.ExplicitAuthFlows,
    PreventUserExistenceErrors: model.PreventUserExistenceErrors,
    EnableTokenRevocation: model.EnableTokenRevocation,
    AuthSessionValidity: model.AuthSessionValidity,
    RefreshTokenRotation: model.RefreshTokenRotation,
    SupportedIdentityProviders: model.SupportedIdentityProviders,
    CallbackURLs: model.CallbackURLs,
    LogoutURLs: model.LogoutURLs,
    DefaultRedirectURI: model.DefaultRedirectURI,
    AllowedOAuthFlows: model.AllowedOAuthFlows,
    AllowedOAuthScopes: model.AllowedOAuthScopes,
    AllowedOAuthFlowsUserPoolClient: model.AllowedOAuthFlowsUserPoolClient,
  };
}

function clientModel(raw: Json, generateSecret: boolean): Model {
  return Object.freeze(cfn10Stable({
    UserPoolId: raw.UserPoolId,
    ClientName: raw.ClientName,
    GenerateSecret: generateSecret,
    RefreshTokenValidity: raw.RefreshTokenValidity,
    AccessTokenValidity: raw.AccessTokenValidity,
    IdTokenValidity: raw.IdTokenValidity,
    TokenValidityUnits: raw.TokenValidityUnits,
    ReadAttributes: raw.ReadAttributes ?? [],
    WriteAttributes: raw.WriteAttributes ?? [],
    ExplicitAuthFlows: raw.ExplicitAuthFlows ?? [],
    PreventUserExistenceErrors: raw.PreventUserExistenceErrors,
    EnableTokenRevocation: raw.EnableTokenRevocation,
    AuthSessionValidity: raw.AuthSessionValidity,
    RefreshTokenRotation: raw.RefreshTokenRotation,
    SupportedIdentityProviders: raw.SupportedIdentityProviders ?? [],
    CallbackURLs: raw.CallbackURLs ?? [],
    LogoutURLs: raw.LogoutURLs ?? [],
    ...(raw.DefaultRedirectURI === undefined ? {} : { DefaultRedirectURI: raw.DefaultRedirectURI }),
    AllowedOAuthFlows: raw.AllowedOAuthFlows ?? [],
    AllowedOAuthScopes: raw.AllowedOAuthScopes ?? [],
    AllowedOAuthFlowsUserPoolClient: raw.AllowedOAuthFlowsUserPoolClient,
  }));
}

async function readClient(service: CognitoService, poolId: string, clientId: string): Promise<ProviderReadModel<Model>> {
  const raw = (await service.executeCloudFormationControl("DescribeUserPoolClient", { UserPoolId: poolId, ClientId: clientId })).UserPoolClient as Json;
  const physicalId = cfn10Physical("cognito-client", [poolId, clientId]);
  return {
    physicalId,
    properties: clientModel(raw, typeof raw.ClientSecret === "string" && raw.ClientSecret.length > 0),
    attributes: {},
  };
}

function createPoolProvider(service: CognitoService): ProductionResourceProvider<Model> {
  return {
    typeName: COGNITO_USER_POOL_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: COGNITO_USER_POOL_SCHEMA,
    validate: userPoolIssues,
    canonicalize: canonicalUserPool,
    plan(previous, desired) { return cfn10Plan(previous, desired, COGNITO_USER_POOL_SCHEMA); },
    async create(desired, context) {
      try {
        const listed = await service.executeCloudFormationControl("ListUserPools", { MaxResults: 60 });
        for (const item of listed.UserPools as Json[]) {
          if (item.Name !== desired.UserPoolName) continue;
          const existing = await readPool(service, String(item.Id), context);
          const tags = (await service.executeCloudFormationControl("ListTagsForResource", { ResourceArn: existing.attributes.Arn })).Tags as Record<string, string>;
          if (tags[COGNITO_OWNER_TAG] === owner(context) && cfn10Same(existing.properties, desired)) {
            return success(existing.physicalId, desired, existing.attributes);
          }
          return { status: "FAILED", errorCode: "AlreadyExists", message: `Cognito user pool ${desired.UserPoolName} already exists` };
        }
        const response = await service.executeCloudFormationControl("CreateUserPool", servicePoolInput(desired, context, true));
        const raw = response.UserPool as Json;
        return success(String(raw.Id), desired, poolAttributes(context, String(raw.Id), raw.Arn));
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<Model>> {
      try { const model = await readPool(service, physicalId, context); return { status: "SUCCESS", physicalId, model }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<Model>> {
      try {
        const desiredSchema = new Map((desired.Schema as Json[]).map(attribute => [attribute.Name, attribute]));
        for (const existing of previous.Schema as Json[]) {
          const next = desiredSchema.get(existing.Name);
          if (!next || !cfn10Same(existing, next)) {
            throw new AwsError(
              "RequiresReplacement",
              `Schema attribute ${existing.Name} cannot be removed or changed in place`,
              409,
            );
          }
        }
        const previousNames = new Set((previous.Schema as Json[]).map(attribute => attribute.Name));
        const additions = (desired.Schema as Json[]).filter(attribute => !previousNames.has(attribute.Name));
        await service.executeCloudFormationControl("UpdateUserPool", {
          UserPoolId: physicalId,
          ...servicePoolInput(desired, context, false),
        });
        try {
          if (additions.length) {
            await service.executeCloudFormationControl("AddCustomAttributes", {
              UserPoolId: physicalId,
              CustomAttributes: additions,
            });
          }
        } catch (error) {
          await service.executeCloudFormationControl("UpdateUserPool", {
            UserPoolId: physicalId,
            ...servicePoolInput(previous, context, false),
          }).catch(() => undefined);
          throw error;
        }
        const current = await readPool(service, physicalId, context);
        const existingTags = (await service.executeCloudFormationControl("ListTagsForResource", { ResourceArn: current.attributes.Arn })).Tags as Record<string, string>;
        const wanted = { ...desired.UserPoolTags, [COGNITO_OWNER_TAG]: owner(context) };
        const removed = Object.keys(existingTags).filter(key => !Object.hasOwn(wanted, key));
        if (removed.length) await service.executeCloudFormationControl("UntagResource", { ResourceArn: current.attributes.Arn, TagKeys: removed });
        if (Object.keys(wanted).length) await service.executeCloudFormationControl("TagResource", { ResourceArn: current.attributes.Arn, Tags: wanted });
        return success(physicalId, desired, current.attributes);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        await service.executeCloudFormationControl("DeleteUserPool", { UserPoolId: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { return cfn10GetAtt(COGNITO_USER_POOL_TYPE, COGNITO_USER_POOL_SCHEMA, model, attribute); },
  };
}

function createClientProvider(service: CognitoService): ProductionResourceProvider<Model> {
  return {
    typeName: COGNITO_USER_POOL_CLIENT_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: COGNITO_USER_POOL_CLIENT_SCHEMA,
    validate: clientIssues,
    canonicalize: canonicalClient,
    plan(previous, desired) { return cfn10Plan(previous, desired, COGNITO_USER_POOL_CLIENT_SCHEMA); },
    async create(desired) {
      try {
        const response = await service.executeCloudFormationControl("CreateUserPoolClient", clientInput(desired, true));
        const raw = response.UserPoolClient as Json;
        const physicalId = cfn10Physical("cognito-client", [desired.UserPoolId, String(raw.ClientId)]);
        return success(physicalId, desired);
      } catch (error) { return failed(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<Model>> {
      try {
        const [poolId, clientId] = cfn10ParsePhysical(physicalId, "cognito-client", 2);
        const model = await readClient(service, poolId, clientId);
        return { status: "SUCCESS", physicalId, model };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<Model>> {
      try {
        const [poolId, clientId] = cfn10ParsePhysical(physicalId, "cognito-client", 2);
        if (previous.UserPoolId !== desired.UserPoolId || previous.GenerateSecret !== desired.GenerateSecret || poolId !== desired.UserPoolId) {
          throw new AwsError("RequiresReplacement", "UserPoolId and GenerateSecret changes require replacement", 409);
        }
        await service.executeCloudFormationControl("UpdateUserPoolClient", clientInput(desired, false, clientId));
        return success(physicalId, desired);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        const [poolId, clientId] = cfn10ParsePhysical(physicalId, "cognito-client", 2);
        await service.executeCloudFormationControl("DeleteUserPoolClient", { UserPoolId: poolId, ClientId: clientId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    ref(model) { return cfn10ParsePhysical(model.physicalId, "cognito-client", 2)[1]; },
    getAtt(_model, attribute) { throw new Error(`${COGNITO_USER_POOL_CLIENT_TYPE} does not support Fn::GetAtt ${attribute}`); },
  };
}

function groupModel(poolId: string, raw: Json): Model {
  return Object.freeze(cfn10Stable({
    UserPoolId: poolId,
    GroupName: raw.GroupName,
    ...(raw.Description === undefined ? {} : { Description: raw.Description }),
    ...(raw.RoleArn === undefined ? {} : { RoleArn: raw.RoleArn }),
    ...(raw.Precedence === undefined ? {} : { Precedence: raw.Precedence }),
  }));
}

function createGroupProvider(service: CognitoService): ProductionResourceProvider<Model> {
  return simpleProvider(service, {
    typeName: COGNITO_USER_POOL_GROUP_TYPE,
    schema: COGNITO_USER_POOL_GROUP_SCHEMA,
    kind: "cognito-group",
    parts: model => [model.UserPoolId, model.GroupName],
    createAction: "CreateGroup",
    readAction: "GetGroup",
    updateAction: "UpdateGroup",
    deleteAction: "DeleteGroup",
    input: model => ({ ...model }),
    readInput: ([UserPoolId, GroupName]) => ({ UserPoolId, GroupName }),
    responseKey: "Group",
    fromRaw: (raw, parts) => groupModel(parts[0], raw),
    ref: parts => parts[1],
  });
}

function userModel(poolId: string, raw: Json): Model {
  return Object.freeze(cfn10Stable({
    UserPoolId: poolId,
    Username: raw.Username,
    UserAttributes: raw.UserAttributes ?? raw.Attributes ?? [],
  }));
}

function createUserProvider(service: CognitoService): ProductionResourceProvider<Model> {
  const base = simpleProvider(service, {
    typeName: COGNITO_USER_POOL_USER_TYPE,
    schema: COGNITO_USER_POOL_USER_SCHEMA,
    kind: "cognito-user",
    parts: model => [model.UserPoolId, model.Username],
    createAction: "AdminCreateUser",
    readAction: "AdminGetUser",
    updateAction: "AdminUpdateUserAttributes",
    deleteAction: "AdminDeleteUser",
    input: model => ({ ...model }),
    readInput: ([UserPoolId, Username]) => ({ UserPoolId, Username }),
    updateInput: model => ({ UserPoolId: model.UserPoolId, Username: model.Username, UserAttributes: model.UserAttributes }),
    responseKey: "User",
    fromRaw: (raw, parts) => userModel(parts[0], raw),
    ref: parts => parts[1],
  });
  const originalUpdate = base.update.bind(base);
  return {
    ...base,
    async update(physicalId, previous, desired, context) {
      try {
        const removed = (previous.UserAttributes ?? [])
          .map((item: Json) => item.Name)
          .filter((name: string) => !(desired.UserAttributes ?? []).some((item: Json) => item.Name === name));
        if (removed.length) {
          await service.executeCloudFormationControl("AdminDeleteUserAttributes", {
            UserPoolId: desired.UserPoolId,
            Username: desired.Username,
            UserAttributeNames: removed,
          });
        }
        return originalUpdate(physicalId, previous, desired, context);
      } catch (error) { return failed(error); }
    },
  };
}

function createMembershipProvider(service: CognitoService): ProductionResourceProvider<Model> {
  const schema = COGNITO_USER_POOL_USER_TO_GROUP_SCHEMA;
  return {
    typeName: COGNITO_USER_POOL_USER_TO_GROUP_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema,
    validate(properties) { return commonIssues(properties, schema); },
    canonicalize(properties, context) { return canonicalCommon(COGNITO_USER_POOL_USER_TO_GROUP_TYPE, properties, context); },
    plan(previous, desired) { return cfn10Plan(previous, desired, schema); },
    async create(desired) {
      const physicalId = cfn10Physical("cognito-membership", [desired.UserPoolId, desired.Username, desired.GroupName]);
      try {
        await service.executeCloudFormationControl("AdminAddUserToGroup", desired as Json);
        return success(physicalId, desired);
      } catch (error) { return failed(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<Model>> {
      try {
        const [UserPoolId, Username, GroupName] = cfn10ParsePhysical(physicalId, "cognito-membership", 3);
        const response = await service.executeCloudFormationControl("AdminListGroupsForUser", { UserPoolId, Username, Limit: 60 });
        if (!(response.Groups as Json[]).some(group => group.GroupName === GroupName)) return { status: "NOT_FOUND", physicalId };
        return { status: "SUCCESS", physicalId, model: { physicalId, properties: { UserPoolId, Username, GroupName }, attributes: {} } };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<Model>> {
      return cfn10Same(previous, desired) ? success(physicalId, desired) : { status: "FAILED", errorCode: "RequiresReplacement", message: "Membership properties require replacement" };
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        const [UserPoolId, Username, GroupName] = cfn10ParsePhysical(physicalId, "cognito-membership", 3);
        await service.executeCloudFormationControl("AdminRemoveUserFromGroup", { UserPoolId, Username, GroupName });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    ref(model) { return cfn10ParsePhysical(model.physicalId, "cognito-membership", 3).join("|"); },
    getAtt(_model, attribute) { throw new Error(`${COGNITO_USER_POOL_USER_TO_GROUP_TYPE} does not support Fn::GetAtt ${attribute}`); },
  };
}

function resourceServerModel(raw: Json): Model {
  return Object.freeze(cfn10Stable({
    UserPoolId: raw.UserPoolId,
    Identifier: raw.Identifier,
    Name: raw.Name,
    Scopes: raw.Scopes ?? [],
  }));
}

function createResourceServerProvider(service: CognitoService): ProductionResourceProvider<Model> {
  return simpleProvider(service, {
    typeName: COGNITO_USER_POOL_RESOURCE_SERVER_TYPE,
    schema: COGNITO_USER_POOL_RESOURCE_SERVER_SCHEMA,
    kind: "cognito-resource-server",
    parts: model => [model.UserPoolId, model.Identifier],
    createAction: "CreateResourceServer",
    readAction: "DescribeResourceServer",
    updateAction: "UpdateResourceServer",
    deleteAction: "DeleteResourceServer",
    input: model => ({ ...model }),
    readInput: ([UserPoolId, Identifier]) => ({ UserPoolId, Identifier }),
    responseKey: "ResourceServer",
    fromRaw: raw => resourceServerModel(raw),
    ref: parts => parts[1],
  });
}

function createDomainProvider(service: CognitoService): ProductionResourceProvider<Model> {
  const schema = COGNITO_USER_POOL_DOMAIN_SCHEMA;
  return {
    typeName: COGNITO_USER_POOL_DOMAIN_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema,
    validate(properties) { return commonIssues(properties, schema); },
    canonicalize(properties, context) { return canonicalCommon(COGNITO_USER_POOL_DOMAIN_TYPE, properties, context); },
    plan(previous, desired) { return cfn10Plan(previous, desired, schema); },
    async create(desired) {
      const physicalId = cfn10Physical("cognito-domain", [desired.UserPoolId, desired.Domain]);
      try {
        await service.executeCloudFormationControl("CreateUserPoolDomain", desired as Json);
        return success(physicalId, desired);
      } catch (error) { return failed(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<Model>> {
      try {
        const [UserPoolId, Domain] = cfn10ParsePhysical(physicalId, "cognito-domain", 2);
        const description = (await service.executeCloudFormationControl("DescribeUserPoolDomain", { Domain })).DomainDescription as Json;
        if (!description?.Domain || description.UserPoolId !== UserPoolId) return { status: "NOT_FOUND", physicalId };
        const properties = { UserPoolId, Domain, ManagedLoginVersion: Number(description.ManagedLoginVersion ?? description.Version ?? 2) };
        return { status: "SUCCESS", physicalId, model: { physicalId, properties, attributes: {} } };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<Model>> {
      try {
        if (previous.UserPoolId !== desired.UserPoolId || previous.Domain !== desired.Domain) throw new AwsError("RequiresReplacement", "UserPoolId and Domain changes require replacement", 409);
        await service.executeCloudFormationControl("UpdateUserPoolDomain", desired as Json);
        return success(physicalId, desired);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        const [UserPoolId, Domain] = cfn10ParsePhysical(physicalId, "cognito-domain", 2);
        await service.executeCloudFormationControl("DeleteUserPoolDomain", { UserPoolId, Domain });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    ref(model) { return cfn10ParsePhysical(model.physicalId, "cognito-domain", 2)[1]; },
    getAtt(_model, attribute) { throw new Error(`${COGNITO_USER_POOL_DOMAIN_TYPE} does not support Fn::GetAtt ${attribute}`); },
  };
}

function identityProviderModel(raw: Json): Model {
  return Object.freeze(cfn10Stable({
    UserPoolId: raw.UserPoolId,
    ProviderName: raw.ProviderName,
    ProviderType: raw.ProviderType,
    ProviderDetails: raw.ProviderDetails ?? {},
    AttributeMapping: raw.AttributeMapping ?? {},
    IdpIdentifiers: raw.IdpIdentifiers ?? [],
  }));
}

function createIdentityProviderProvider(service: CognitoService): ProductionResourceProvider<Model> {
  return simpleProvider(service, {
    typeName: COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE,
    schema: COGNITO_USER_POOL_IDENTITY_PROVIDER_SCHEMA,
    kind: "cognito-idp",
    parts: model => [model.UserPoolId, model.ProviderName],
    createAction: "CreateIdentityProvider",
    readAction: "DescribeIdentityProvider",
    updateAction: "UpdateIdentityProvider",
    deleteAction: "DeleteIdentityProvider",
    input: model => ({ ...model }),
    readInput: ([UserPoolId, ProviderName]) => ({ UserPoolId, ProviderName }),
    responseKey: "IdentityProvider",
    fromRaw: raw => identityProviderModel(raw),
    ref: parts => parts[1],
  });
}

interface SimpleSpec {
  readonly typeName: string;
  readonly schema: ProviderSchema;
  readonly kind: string;
  readonly parts: (model: Model) => string[];
  readonly createAction: string;
  readonly readAction: string;
  readonly updateAction: string;
  readonly deleteAction: string;
  readonly input: (model: Model) => Json;
  readonly readInput: (parts: string[]) => Json;
  readonly updateInput?: (model: Model) => Json;
  readonly responseKey: string;
  readonly fromRaw: (raw: Json, parts: string[]) => Model;
  readonly ref: (parts: string[]) => string;
}

function simpleProvider(service: CognitoService, spec: SimpleSpec): ProductionResourceProvider<Model> {
  return {
    typeName: spec.typeName,
    providerVersion: 1,
    visibility: "production",
    schema: spec.schema,
    validate(properties) { return validationFor(spec.typeName, properties); },
    canonicalize(properties, context) { return canonicalFor(spec.typeName, properties, context); },
    plan(previous, desired) { return cfn10Plan(previous, desired, spec.schema); },
    async create(desired) {
      const parts = spec.parts(desired);
      const physicalId = cfn10Physical(spec.kind, parts);
      try {
        const response = await service.executeCloudFormationControl(spec.createAction, spec.input(desired));
        const raw = response[spec.responseKey] as Json;
        return success(physicalId, raw ? spec.fromRaw(raw, parts) : desired);
      } catch (error) { return failed(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<Model>> {
      try {
        const parts = cfn10ParsePhysical(physicalId, spec.kind, spec.parts({} as Model).length || (() => {
          if (spec.kind === "cognito-group" || spec.kind === "cognito-user" || spec.kind === "cognito-resource-server" || spec.kind === "cognito-idp") return 2;
          return 1;
        })());
        const response = await service.executeCloudFormationControl(spec.readAction, spec.readInput(parts));
        const raw = response[spec.responseKey] as Json;
        return { status: "SUCCESS", physicalId, model: { physicalId, properties: spec.fromRaw(raw, parts), attributes: {} } };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<Model>> {
      try {
        const previousParts = spec.parts(previous);
        const desiredParts = spec.parts(desired);
        if (!cfn10Same(previousParts, desiredParts)) throw new AwsError("RequiresReplacement", "Resource identity changes require replacement", 409);
        const response = await service.executeCloudFormationControl(spec.updateAction, spec.updateInput?.(desired) ?? spec.input(desired));
        const raw = response[spec.responseKey] as Json;
        return success(physicalId, raw ? spec.fromRaw(raw, desiredParts) : desired);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        const count = ["cognito-group", "cognito-user", "cognito-resource-server", "cognito-idp"].includes(spec.kind) ? 2 : 1;
        const parts = cfn10ParsePhysical(physicalId, spec.kind, count);
        await service.executeCloudFormationControl(spec.deleteAction, spec.readInput(parts));
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    ref(model) {
      const count = ["cognito-group", "cognito-user", "cognito-resource-server", "cognito-idp"].includes(spec.kind) ? 2 : 1;
      return spec.ref(cfn10ParsePhysical(model.physicalId, spec.kind, count));
    },
    getAtt(_model, attribute) { throw new Error(`${spec.typeName} does not support Fn::GetAtt ${attribute}`); },
  };
}

export function createCognitoCloudFormationProviders(
  service: CognitoService,
): readonly ProductionResourceProvider<Model>[] {
  return Object.freeze([
    createPoolProvider(service),
    createClientProvider(service),
    createGroupProvider(service),
    createUserProvider(service),
    createMembershipProvider(service),
    createResourceServerProvider(service),
    createDomainProvider(service),
    createIdentityProviderProvider(service),
  ]);
}

export const COGNITO_CLOUDFORMATION_RESOURCE_TYPES = Object.freeze([
  COGNITO_USER_POOL_TYPE,
  COGNITO_USER_POOL_CLIENT_TYPE,
  COGNITO_USER_POOL_GROUP_TYPE,
  COGNITO_USER_POOL_USER_TYPE,
  COGNITO_USER_POOL_USER_TO_GROUP_TYPE,
  COGNITO_USER_POOL_RESOURCE_SERVER_TYPE,
  COGNITO_USER_POOL_DOMAIN_TYPE,
  COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE,
].sort());

export const COGNITO_CLOUDFORMATION_AUTHORIZATION_MATRIX = Object.freeze({
  [COGNITO_USER_POOL_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:ListUserPools", "cognito-idp:CreateUserPool", "cognito-idp:DescribeUserPool", "cognito-idp:ListTagsForResource"]),
    READ: Object.freeze(["cognito-idp:DescribeUserPool", "cognito-idp:ListTagsForResource"]),
    UPDATE: Object.freeze(["cognito-idp:DescribeUserPool", "cognito-idp:UpdateUserPool", "cognito-idp:ListTagsForResource", "cognito-idp:TagResource", "cognito-idp:UntagResource"]),
    DELETE: Object.freeze(["cognito-idp:DeleteUserPool"]),
  }),
  [COGNITO_USER_POOL_CLIENT_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:CreateUserPoolClient"]),
    READ: Object.freeze(["cognito-idp:DescribeUserPoolClient"]),
    UPDATE: Object.freeze(["cognito-idp:UpdateUserPoolClient"]),
    DELETE: Object.freeze(["cognito-idp:DeleteUserPoolClient"]),
  }),
  [COGNITO_USER_POOL_GROUP_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:CreateGroup"]),
    READ: Object.freeze(["cognito-idp:GetGroup"]),
    UPDATE: Object.freeze(["cognito-idp:UpdateGroup"]),
    DELETE: Object.freeze(["cognito-idp:DeleteGroup"]),
  }),
  [COGNITO_USER_POOL_USER_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:AdminCreateUser"]),
    READ: Object.freeze(["cognito-idp:AdminGetUser"]),
    UPDATE: Object.freeze(["cognito-idp:AdminGetUser", "cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminDeleteUserAttributes"]),
    DELETE: Object.freeze(["cognito-idp:AdminDeleteUser"]),
  }),
  [COGNITO_USER_POOL_USER_TO_GROUP_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:AdminAddUserToGroup"]),
    READ: Object.freeze(["cognito-idp:AdminListGroupsForUser"]),
    UPDATE: Object.freeze(["cognito-idp:AdminListGroupsForUser"]),
    DELETE: Object.freeze(["cognito-idp:AdminRemoveUserFromGroup"]),
  }),
  [COGNITO_USER_POOL_RESOURCE_SERVER_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:CreateResourceServer"]),
    READ: Object.freeze(["cognito-idp:DescribeResourceServer"]),
    UPDATE: Object.freeze(["cognito-idp:UpdateResourceServer"]),
    DELETE: Object.freeze(["cognito-idp:DeleteResourceServer"]),
  }),
  [COGNITO_USER_POOL_DOMAIN_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:CreateUserPoolDomain"]),
    READ: Object.freeze(["cognito-idp:DescribeUserPoolDomain"]),
    UPDATE: Object.freeze(["cognito-idp:UpdateUserPoolDomain"]),
    DELETE: Object.freeze(["cognito-idp:DeleteUserPoolDomain"]),
  }),
  [COGNITO_USER_POOL_IDENTITY_PROVIDER_TYPE]: Object.freeze({
    CREATE: Object.freeze(["cognito-idp:CreateIdentityProvider"]),
    READ: Object.freeze(["cognito-idp:DescribeIdentityProvider"]),
    UPDATE: Object.freeze(["cognito-idp:UpdateIdentityProvider"]),
    DELETE: Object.freeze(["cognito-idp:DeleteIdentityProvider"]),
  }),
});

export const COGNITO_CLOUDFORMATION_EXECUTION_ACTIONS = Object.freeze(
  [...new Set(Object.values(COGNITO_CLOUDFORMATION_AUTHORIZATION_MATRIX)
    .flatMap(operations => Object.values(operations).flat()))].sort(),
);
