import { AwsError } from "../errors.js";
import { parseDeviceConfiguration } from "./devices.js";
import { throwCog07Boundary } from "./cog07-boundaries.js";
import { STANDARD_CLIENT_ATTRIBUTES, STANDARD_USER_ATTRIBUTES } from "./attributes.js";
import { parseMailboxAddress } from "../ses/validation.js";
import type {
  CognitoAppClientState,
  CognitoUserPoolConfigurationState,
} from "../types.js";

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", `${field} must be an object.`);
  }
  return value as Record<string, any>;
}

function rejectUnknown(value: Record<string, any>, allowed: readonly string[], field: string): void {
  const accepted = new Set(allowed);
  const unsupported = Object.keys(value).filter(key => !accepted.has(key));
  if (unsupported.length) {
    throw new AwsError(
      "InvalidParameterException",
      `${field}.${unsupported[0]} is outside the implemented COG-01 boundary.`,
    );
  }
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AwsError("InvalidParameterException", `${field} must be a boolean.`);
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new AwsError("InvalidParameterException", `${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new AwsError("InvalidParameterException", `${field} must be an array of strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw new AwsError("InvalidParameterException", `${field} must not contain duplicate values.`);
  }
  return value;
}

export function cognitoName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[\w\s+=,.@-]+$/u.test(value)) {
    throw new AwsError("InvalidParameterException", `${field} must be 1-128 valid characters.`);
  }
  return value;
}

export function userPoolId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d_[A-Za-z0-9]{9}$/.test(value)) {
    throw new AwsError("InvalidParameterException", "UserPoolId is invalid.");
  }
  return value;
}

export function clientId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]{26}$/.test(value)) {
    throw new AwsError("InvalidParameterException", "ClientId is invalid.");
  }
  return value;
}

const DEFAULT_PASSWORD_POLICY = {
  minimumLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: true,
  temporaryPasswordValidityDays: 7,
  passwordHistorySize: 0,
} as const;

export function defaultPoolConfiguration(): CognitoUserPoolConfigurationState {
  return {
    policies: { passwordPolicy: { ...DEFAULT_PASSWORD_POLICY } },
    deletionProtection: "INACTIVE",
    autoVerifiedAttributes: [],
    aliasAttributes: [],
    usernameAttributes: [],
    usernameConfiguration: { caseSensitive: true },
    adminCreateUserConfig: {
      allowAdminCreateUserOnly: false,
      inviteMessageTemplate: {
        emailSubject: "Your temporary password",
        emailMessage: "Your username is {username} and temporary password is {####}.",
      },
    },
    schemaAttributes: [],
    accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
    emailConfiguration: { emailSendingAccount: "COGNITO_DEFAULT" },
    verificationMessageTemplate: {
      defaultEmailOption: "CONFIRM_WITH_CODE",
      emailSubject: "Your verification code",
      emailMessage: "Your verification code is {####}.",
    },
    mfaConfiguration: "OFF",
    enabledMfas: [],
    lambdaConfig: {},
    userPoolTier: "ESSENTIALS",
  };
}

function temporaryPasswordValidityDays(value: unknown): number {
  if (value === undefined) return DEFAULT_PASSWORD_POLICY.temporaryPasswordValidityDays;
  const days = integer(value, "Policies.PasswordPolicy.TemporaryPasswordValidityDays", 0, 365);
  return days === 0 ? DEFAULT_PASSWORD_POLICY.temporaryPasswordValidityDays : days;
}

function passwordPolicy(value: unknown): CognitoUserPoolConfigurationState["policies"] {
  if (value === undefined) return { passwordPolicy: { ...DEFAULT_PASSWORD_POLICY } };
  const policies = object(value, "Policies");
  rejectUnknown(policies, ["PasswordPolicy"], "Policies");
  const password = policies.PasswordPolicy === undefined ? {} : object(policies.PasswordPolicy, "Policies.PasswordPolicy");
  rejectUnknown(password, [
    "MinimumLength", "RequireUppercase", "RequireLowercase", "RequireNumbers", "RequireSymbols",
    "TemporaryPasswordValidityDays", "PasswordHistorySize",
  ], "Policies.PasswordPolicy");
  return {
    passwordPolicy: {
      minimumLength: password.MinimumLength === undefined
        ? DEFAULT_PASSWORD_POLICY.minimumLength
        : integer(password.MinimumLength, "Policies.PasswordPolicy.MinimumLength", 6, 99),
      requireUppercase: password.RequireUppercase === undefined
        ? DEFAULT_PASSWORD_POLICY.requireUppercase
        : boolean(password.RequireUppercase, "Policies.PasswordPolicy.RequireUppercase"),
      requireLowercase: password.RequireLowercase === undefined
        ? DEFAULT_PASSWORD_POLICY.requireLowercase
        : boolean(password.RequireLowercase, "Policies.PasswordPolicy.RequireLowercase"),
      requireNumbers: password.RequireNumbers === undefined
        ? DEFAULT_PASSWORD_POLICY.requireNumbers
        : boolean(password.RequireNumbers, "Policies.PasswordPolicy.RequireNumbers"),
      requireSymbols: password.RequireSymbols === undefined
        ? DEFAULT_PASSWORD_POLICY.requireSymbols
        : boolean(password.RequireSymbols, "Policies.PasswordPolicy.RequireSymbols"),
      temporaryPasswordValidityDays: temporaryPasswordValidityDays(password.TemporaryPasswordValidityDays),
      passwordHistorySize: password.PasswordHistorySize === undefined
        ? DEFAULT_PASSWORD_POLICY.passwordHistorySize
        : integer(password.PasswordHistorySize, "Policies.PasswordPolicy.PasswordHistorySize", 0, 24),
    },
  };
}

function emailOnlyArray(value: unknown, field: string): "email"[] {
  if (value === undefined) return [];
  const selected = strings(value, field);
  if (selected.some(item => item !== "email")) {
    throw new AwsError("InvalidParameterException", `${field} supports only email in COG-01.`);
  }
  return selected as "email"[];
}

interface CognitoConfigurationContext {
  accountId: string;
  region: string;
}

function emailConfiguration(
  value: unknown,
  context: CognitoConfigurationContext,
): CognitoUserPoolConfigurationState["emailConfiguration"] {
  if (value === undefined) return { emailSendingAccount: "COGNITO_DEFAULT" };
  const input = object(value, "EmailConfiguration");
  rejectUnknown(
    input,
    ["EmailSendingAccount", "SourceArn", "From", "ReplyToEmailAddress", "ConfigurationSet"],
    "EmailConfiguration",
  );
  const account = input.EmailSendingAccount ?? "COGNITO_DEFAULT";
  if (!["COGNITO_DEFAULT", "DEVELOPER"].includes(account)) {
    throw new AwsError("InvalidParameterException", "EmailSendingAccount must be COGNITO_DEFAULT or DEVELOPER.");
  }
  if (account === "COGNITO_DEFAULT") {
    if (["SourceArn", "From", "ReplyToEmailAddress", "ConfigurationSet"].some(field => has(input, field))) {
      throw new AwsError(
        "InvalidParameterException",
        "The COGNITO_DEFAULT profile uses the fixed local no-reply sender and does not accept developer SES fields.",
      );
    }
    return { emailSendingAccount: "COGNITO_DEFAULT" };
  }
  const partition = context.region.startsWith("cn-")
    ? "aws-cn"
    : context.region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const prefix = `arn:${partition}:ses:${context.region}:${context.accountId}:identity/`;
  if (
    typeof input.SourceArn !== "string"
    || input.SourceArn.length < prefix.length + 1
    || input.SourceArn.length > 2_048
    || !input.SourceArn.startsWith(prefix)
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "DEVELOPER SourceArn must identify an SES identity in the user pool account and Region.",
    );
  }
  const identity = input.SourceArn.slice(prefix.length);
  if (!identity || /[\u0000-\u001f\u007f/:]/.test(identity)) {
    throw new AwsError("InvalidParameterException", "DEVELOPER SourceArn identity is invalid.");
  }
  let from = typeof input.From === "string" && input.From.length > 0 ? input.From : undefined;
  try {
    if (!from) {
      if (!identity.includes("@")) {
        throw new AwsError(
          "InvalidParameterException",
          "DEVELOPER From is required when SourceArn identifies a domain.",
        );
      }
      from = identity;
    }
    const parsedFrom = parseMailboxAddress(from);
    if (identity.includes("@")) {
      if (parseMailboxAddress(identity).normalized !== parsedFrom.normalized) {
        throw new AwsError("InvalidParameterException", "DEVELOPER From must match SourceArn.");
      }
    } else {
      const domain = identity.toLowerCase().replace(/\.$/, "");
      const fromDomain = parsedFrom.domain.toLowerCase();
      if (fromDomain !== domain && !fromDomain.endsWith(`.${domain}`)) {
        throw new AwsError("InvalidParameterException", "DEVELOPER From must be covered by the SourceArn domain.");
      }
    }
  } catch (error) {
    if (error instanceof AwsError) throw error;
    throw new AwsError("InvalidParameterException", "DEVELOPER From is not a valid SES sender.");
  }
  let replyToEmailAddress: string | undefined;
  if (input.ReplyToEmailAddress !== undefined) {
    try {
      const parsed = parseMailboxAddress(input.ReplyToEmailAddress);
      if (parsed.displayName || parsed.original !== parsed.address) throw new Error();
      replyToEmailAddress = parsed.address;
    } catch {
      throw new AwsError("InvalidParameterException", "ReplyToEmailAddress must be an email address.");
    }
  }
  let configurationSet: string | undefined;
  if (input.ConfigurationSet !== undefined) {
    if (typeof input.ConfigurationSet !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.ConfigurationSet)) {
      throw new AwsError("InvalidParameterException", "ConfigurationSet is invalid.");
    }
    configurationSet = input.ConfigurationSet;
  }
  return {
    emailSendingAccount: "DEVELOPER",
    sourceArn: input.SourceArn,
    from,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
    ...(configurationSet ? { configurationSet } : {}),
  };
}

function adminCreateUserConfig(value: unknown): CognitoUserPoolConfigurationState["adminCreateUserConfig"] {
  const defaultTemplate = {
    emailSubject: "Your temporary password",
    emailMessage: "Your username is {username} and temporary password is {####}.",
  };
  if (value === undefined) {
    return { allowAdminCreateUserOnly: false, inviteMessageTemplate: defaultTemplate };
  }
  const input = object(value, "AdminCreateUserConfig");
  rejectUnknown(
    input,
    ["AllowAdminCreateUserOnly", "UnusedAccountValidityDays", "InviteMessageTemplate"],
    "AdminCreateUserConfig",
  );
  const template = input.InviteMessageTemplate === undefined
    ? {}
    : object(input.InviteMessageTemplate, "AdminCreateUserConfig.InviteMessageTemplate");
  rejectUnknown(template, ["EmailSubject", "EmailMessage", "SMSMessage"], "AdminCreateUserConfig.InviteMessageTemplate");
  if (template.SMSMessage !== undefined) {
    throw new AwsError("InvalidParameterException", "SMS invitation delivery is unavailable.");
  }
  const emailSubject = template.EmailSubject ?? defaultTemplate.emailSubject;
  const emailMessage = template.EmailMessage ?? defaultTemplate.emailMessage;
  if (typeof emailSubject !== "string" || emailSubject.length < 1 || emailSubject.length > 140) {
    throw new AwsError("InvalidParameterException", "Invitation email subject must be 1-140 characters.");
  }
  if (
    typeof emailMessage !== "string"
    || emailMessage.length < 6
    || emailMessage.length > 20_000
    || !emailMessage.includes("{username}")
    || !emailMessage.includes("{####}")
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "Invitation email message must contain {username} and {####}.",
    );
  }
  return {
    allowAdminCreateUserOnly: input.AllowAdminCreateUserOnly === undefined
      ? false
      : boolean(input.AllowAdminCreateUserOnly, "AdminCreateUserConfig.AllowAdminCreateUserOnly"),
    ...(input.UnusedAccountValidityDays === undefined
      ? {}
      : {
          unusedAccountValidityDays: integer(
            input.UnusedAccountValidityDays,
            "AdminCreateUserConfig.UnusedAccountValidityDays",
            0,
            365,
          ),
        }),
    inviteMessageTemplate: { emailSubject, emailMessage },
  };
}

function schema(value: unknown): CognitoUserPoolConfigurationState["schemaAttributes"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AwsError("InvalidParameterException", "Schema must be an array.");
  return value.map((raw, index) => {
    const input = object(raw, `Schema[${index}]`);
    rejectUnknown(input, [
      "Name", "AttributeDataType", "DeveloperOnlyAttribute", "Required", "Mutable",
      "StringAttributeConstraints", "NumberAttributeConstraints",
    ], `Schema[${index}]`);
    if (
      typeof input.Name !== "string"
      || !/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(input.Name)
    ) {
      throw new AwsError("InvalidParameterException", `Schema[${index}].Name is invalid.`);
    }
    const standard = STANDARD_USER_ATTRIBUTES.has(input.Name);
    const attributeDataType = input.AttributeDataType ?? "String";
    if (!["String", "Number", "Boolean", "DateTime"].includes(attributeDataType)) {
      throw new AwsError("InvalidParameterException", `Schema[${index}].AttributeDataType is invalid.`);
    }
    if (standard && attributeDataType !== "String") {
      throw new AwsError("InvalidParameterException", `The standard ${input.Name} attribute must be a String.`);
    }
    const required = input.Required === undefined ? false : boolean(input.Required, `Schema[${index}].Required`);
    if (!standard && required) {
      throw new AwsError("InvalidParameterException", "Custom attributes cannot be required.");
    }
    const stringConstraints = input.StringAttributeConstraints === undefined
      ? undefined
      : object(input.StringAttributeConstraints, `Schema[${index}].StringAttributeConstraints`);
    if (stringConstraints) {
      rejectUnknown(stringConstraints, ["MinLength", "MaxLength"], `Schema[${index}].StringAttributeConstraints`);
      if (attributeDataType !== "String") {
        throw new AwsError("InvalidParameterException", "String constraints require a String attribute.");
      }
      for (const [name, constraint] of Object.entries(stringConstraints)) {
        if (typeof constraint !== "string" || !/^\d{1,4}$/.test(constraint) || Number(constraint) > 2_048) {
          throw new AwsError("InvalidParameterException", `Schema[${index}].StringAttributeConstraints.${name} is invalid.`);
        }
      }
      if (
        stringConstraints.MinLength !== undefined
        && stringConstraints.MaxLength !== undefined
        && Number(stringConstraints.MinLength) > Number(stringConstraints.MaxLength)
      ) {
        throw new AwsError("InvalidParameterException", "String attribute minimum length exceeds its maximum.");
      }
    }
    const numberConstraints = input.NumberAttributeConstraints === undefined
      ? undefined
      : object(input.NumberAttributeConstraints, `Schema[${index}].NumberAttributeConstraints`);
    if (numberConstraints) {
      rejectUnknown(numberConstraints, ["MinValue", "MaxValue"], `Schema[${index}].NumberAttributeConstraints`);
      if (attributeDataType !== "Number") {
        throw new AwsError("InvalidParameterException", "Number constraints require a Number attribute.");
      }
      for (const [name, constraint] of Object.entries(numberConstraints)) {
        if (
          typeof constraint !== "string"
          || constraint.length === 0
          || constraint.length > 131_072
          || constraint.trim() !== constraint
          || !Number.isFinite(Number(constraint))
        ) {
          throw new AwsError("InvalidParameterException", `Schema[${index}].NumberAttributeConstraints.${name} is invalid.`);
        }
      }
      if (
        numberConstraints.MinValue !== undefined
        && numberConstraints.MaxValue !== undefined
        && Number(numberConstraints.MinValue) > Number(numberConstraints.MaxValue)
      ) {
        throw new AwsError("InvalidParameterException", "Number attribute minimum value exceeds its maximum.");
      }
    }
    return {
      name: input.Name,
      attributeDataType,
      developerOnlyAttribute: input.DeveloperOnlyAttribute === undefined
        ? false
        : boolean(input.DeveloperOnlyAttribute, `Schema[${index}].DeveloperOnlyAttribute`),
      required,
      mutable: input.Mutable === undefined ? true : boolean(input.Mutable, `Schema[${index}].Mutable`),
      ...(stringConstraints
        ? {
            stringAttributeConstraints: {
              ...(stringConstraints.MinLength === undefined ? {} : { minLength: String(stringConstraints.MinLength) }),
              ...(stringConstraints.MaxLength === undefined ? {} : { maxLength: String(stringConstraints.MaxLength) }),
            },
          }
        : {}),
      ...(numberConstraints
        ? {
            numberAttributeConstraints: {
              ...(numberConstraints.MinValue === undefined ? {} : { minValue: String(numberConstraints.MinValue) }),
              ...(numberConstraints.MaxValue === undefined ? {} : { maxValue: String(numberConstraints.MaxValue) }),
            },
          }
        : {}),
    };
  });
}

function accountRecovery(value: unknown): CognitoUserPoolConfigurationState["accountRecoverySetting"] {
  if (value === undefined) return { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] };
  const input = object(value, "AccountRecoverySetting");
  rejectUnknown(input, ["RecoveryMechanisms"], "AccountRecoverySetting");
  if (!Array.isArray(input.RecoveryMechanisms) || input.RecoveryMechanisms.length !== 1) {
    throw new AwsError("InvalidParameterException", "AccountRecoverySetting must contain one verified_email mechanism.");
  }
  const mechanism = object(input.RecoveryMechanisms[0], "AccountRecoverySetting.RecoveryMechanisms[0]");
  rejectUnknown(mechanism, ["Name", "Priority"], "AccountRecoverySetting.RecoveryMechanisms[0]");
  if (mechanism.Name !== "verified_email" || mechanism.Priority !== 1) {
    throw new AwsError("InvalidParameterException", "Only priority-1 verified_email recovery is available in COG-01.");
  }
  return { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] };
}

function verificationTemplate(
  input: Record<string, any>,
): CognitoUserPoolConfigurationState["verificationMessageTemplate"] {
  const template = input.VerificationMessageTemplate === undefined
    ? {}
    : object(input.VerificationMessageTemplate, "VerificationMessageTemplate");
  rejectUnknown(template, ["DefaultEmailOption", "EmailSubject", "EmailMessage", "SmsMessage"], "VerificationMessageTemplate");
  if ((template.DefaultEmailOption ?? "CONFIRM_WITH_CODE") !== "CONFIRM_WITH_CODE") {
    throw new AwsError("InvalidParameterException", "Only code-based email confirmation is available in COG-01.");
  }
  const emailSubject = template.EmailSubject ?? input.EmailVerificationSubject ?? "Your verification code";
  const emailMessage = template.EmailMessage ?? input.EmailVerificationMessage ?? "Your verification code is {####}.";
  const legacySmsMessage = input.SmsVerificationMessage;
  const nestedSmsMessage = template.SmsMessage;
  if (legacySmsMessage !== undefined && nestedSmsMessage !== undefined && legacySmsMessage !== nestedSmsMessage) {
    throw new AwsError(
      "InvalidParameterException",
      "SmsVerificationMessage and VerificationMessageTemplate.SmsMessage must match when both are supplied.",
    );
  }
  const smsMessage = nestedSmsMessage ?? legacySmsMessage;
  if (typeof emailSubject !== "string" || emailSubject.length < 1 || emailSubject.length > 140) {
    throw new AwsError("InvalidParameterException", "Email verification subject must be 1-140 characters.");
  }
  if (typeof emailMessage !== "string" || emailMessage.length < 6 || emailMessage.length > 20_000 || !emailMessage.includes("{####}")) {
    throw new AwsError("InvalidParameterException", "Email verification message must contain {####}.");
  }
  if (smsMessage !== undefined && (
    typeof smsMessage !== "string"
    || smsMessage.length < 6
    || smsMessage.length > 140
    || !smsMessage.includes("{####}")
  )) {
    throw new AwsError("InvalidParameterException", "SMS verification message must be 6-140 characters and contain {####}.");
  }
  return {
    defaultEmailOption: "CONFIRM_WITH_CODE",
    emailSubject,
    emailMessage,
    ...(smsMessage === undefined ? {} : { smsMessage }),
  };
}

const CREATE_POOL_FIELDS = [
  "PoolName", "Policies", "DeletionProtection", "AutoVerifiedAttributes", "AliasAttributes",
  "UsernameAttributes", "EmailVerificationMessage", "EmailVerificationSubject", "SmsVerificationMessage", "VerificationMessageTemplate",
  "EmailConfiguration", "AdminCreateUserConfig", "Schema", "UsernameConfiguration",
  "AccountRecoverySetting", "UserPoolTier", "MfaConfiguration", "EnabledMfas", "LambdaConfig",
  "UserPoolTags", "DeviceConfiguration",
] as const;

const UPDATE_POOL_FIELDS = [
  "UserPoolId", "PoolName", "Policies", "DeletionProtection", "AutoVerifiedAttributes",
  "EmailVerificationMessage", "EmailVerificationSubject", "SmsVerificationMessage", "VerificationMessageTemplate",
  "EmailConfiguration", "AdminCreateUserConfig", "AccountRecoverySetting", "UserPoolTier",
  "MfaConfiguration", "EnabledMfas", "LambdaConfig", "DeviceConfiguration",
] as const;

function phaseThreeConfiguration(input: Record<string, any>): Pick<
  CognitoUserPoolConfigurationState,
  "mfaConfiguration" | "enabledMfas" | "lambdaConfig"
> {
  const mfaConfiguration = input.MfaConfiguration ?? "OFF";
  if (!["OFF", "ON", "OPTIONAL"].includes(mfaConfiguration)) {
    throw new AwsError("InvalidParameterException", "MfaConfiguration is invalid.");
  }
  const enabled = input.EnabledMfas === undefined ? [] : strings(input.EnabledMfas, "EnabledMfas");
  if (enabled.some(value => !["SOFTWARE_TOKEN_MFA", "EMAIL_OTP"].includes(value))) {
    throw new AwsError("InvalidParameterException", "SMS MFA is unavailable.");
  }
  const lambdaConfig = input.LambdaConfig === undefined ? {} : object(input.LambdaConfig, "LambdaConfig");
  rejectUnknown(lambdaConfig, [
    "PreSignUp", "CustomMessage", "PostConfirmation", "PreAuthentication",
    "PostAuthentication", "PreTokenGeneration", "PreTokenGenerationConfig",
  ], "LambdaConfig");
  const arn = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined;
    if (
      typeof value !== "string"
      || !/^arn:(?:aws|aws-cn|aws-us-gov):lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?$/.test(value)
    ) {
      throw new AwsError("InvalidParameterException", `${field} must be a Lambda function ARN.`);
    }
    return value;
  };
  const preTokenConfig = lambdaConfig.PreTokenGenerationConfig === undefined
    ? undefined
    : object(lambdaConfig.PreTokenGenerationConfig, "LambdaConfig.PreTokenGenerationConfig");
  if (preTokenConfig) {
    rejectUnknown(preTokenConfig, ["LambdaArn", "LambdaVersion"], "LambdaConfig.PreTokenGenerationConfig");
    if (preTokenConfig.LambdaVersion !== "V1_0") {
      throwCog07Boundary("advanced-token-customization");
    }
  }
  const preTokenGeneration = arn(lambdaConfig.PreTokenGeneration, "LambdaConfig.PreTokenGeneration");
  const configuredPreTokenArn = preTokenConfig
    ? arn(preTokenConfig.LambdaArn, "LambdaConfig.PreTokenGenerationConfig.LambdaArn")
    : undefined;
  if (preTokenGeneration && configuredPreTokenArn && preTokenGeneration !== configuredPreTokenArn) {
    throw new AwsError("InvalidParameterException", "Pre-token generation Lambda ARNs conflict.");
  }
  return {
    mfaConfiguration,
    enabledMfas: enabled as Array<"SOFTWARE_TOKEN_MFA" | "EMAIL_OTP">,
    lambdaConfig: {
      ...(arn(lambdaConfig.PreSignUp, "LambdaConfig.PreSignUp") ? { preSignUp: lambdaConfig.PreSignUp } : {}),
      ...(arn(lambdaConfig.CustomMessage, "LambdaConfig.CustomMessage") ? { customMessage: lambdaConfig.CustomMessage } : {}),
      ...(arn(lambdaConfig.PostConfirmation, "LambdaConfig.PostConfirmation") ? { postConfirmation: lambdaConfig.PostConfirmation } : {}),
      ...(arn(lambdaConfig.PreAuthentication, "LambdaConfig.PreAuthentication") ? { preAuthentication: lambdaConfig.PreAuthentication } : {}),
      ...(arn(lambdaConfig.PostAuthentication, "LambdaConfig.PostAuthentication") ? { postAuthentication: lambdaConfig.PostAuthentication } : {}),
      ...((preTokenGeneration ?? configuredPreTokenArn)
        ? { preTokenGeneration: preTokenGeneration ?? configuredPreTokenArn }
        : {}),
      ...(configuredPreTokenArn
        ? { preTokenGenerationConfig: { lambdaArn: configuredPreTokenArn, lambdaVersion: "V1_0" as const } }
        : {}),
    },
  };
}

export function createPoolConfiguration(
  input: Record<string, any>,
  context: CognitoConfigurationContext,
): CognitoUserPoolConfigurationState {
  rejectUnknown(input, CREATE_POOL_FIELDS, "CreateUserPool");
  const aliasAttributes = emailOnlyArray(input.AliasAttributes, "AliasAttributes");
  const usernameAttributes = emailOnlyArray(input.UsernameAttributes, "UsernameAttributes");
  if (aliasAttributes.length && usernameAttributes.length) {
    throw new AwsError("InvalidParameterException", "AliasAttributes and UsernameAttributes are mutually exclusive.");
  }
  let caseSensitive = true;
  if (input.UsernameConfiguration !== undefined) {
    const username = object(input.UsernameConfiguration, "UsernameConfiguration");
    rejectUnknown(username, ["CaseSensitive"], "UsernameConfiguration");
    if (username.CaseSensitive !== undefined) {
      caseSensitive = boolean(username.CaseSensitive, "UsernameConfiguration.CaseSensitive");
    }
  }
  const deletionProtection = input.DeletionProtection ?? "INACTIVE";
  if (!["ACTIVE", "INACTIVE"].includes(deletionProtection)) {
    throw new AwsError("InvalidParameterException", "DeletionProtection must be ACTIVE or INACTIVE.");
  }
  if (!["ESSENTIALS", "PLUS"].includes(input.UserPoolTier ?? "ESSENTIALS")) {
    throw new AwsError("InvalidParameterException", "UserPoolTier must be ESSENTIALS or PLUS.");
  }
  const email = emailConfiguration(input.EmailConfiguration, context);
  const phaseThree = phaseThreeConfiguration(input);
  if (
    phaseThree.enabledMfas.includes("EMAIL_OTP")
    && (
      !["ESSENTIALS", "PLUS"].includes(input.UserPoolTier ?? "ESSENTIALS")
      || email.emailSendingAccount !== "DEVELOPER"
    )
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "EMAIL_OTP requires an Essentials or Plus user pool with DEVELOPER email delivery.",
    );
  }
  if (phaseThree.mfaConfiguration === "ON" && phaseThree.enabledMfas.length === 0) {
    throw new AwsError("InvalidParameterException", "Required MFA must enable at least one MFA method.");
  }
  const deviceConfiguration = parseDeviceConfiguration(input.DeviceConfiguration);
  return {
    policies: passwordPolicy(input.Policies),
    deletionProtection,
    autoVerifiedAttributes: emailOnlyArray(input.AutoVerifiedAttributes, "AutoVerifiedAttributes"),
    aliasAttributes,
    usernameAttributes,
    usernameConfiguration: { caseSensitive },
    adminCreateUserConfig: adminCreateUserConfig(input.AdminCreateUserConfig),
    schemaAttributes: schema(input.Schema),
    accountRecoverySetting: accountRecovery(input.AccountRecoverySetting),
    emailConfiguration: email,
    verificationMessageTemplate: verificationTemplate(input),
    ...phaseThree,
    userPoolTier: input.UserPoolTier ?? "ESSENTIALS",
    ...(deviceConfiguration ? { deviceConfiguration } : {}),
  };
}

export function updatePoolConfiguration(
  input: Record<string, any>,
  current: CognitoUserPoolConfigurationState,
  context: CognitoConfigurationContext,
): CognitoUserPoolConfigurationState {
  rejectUnknown(input, UPDATE_POOL_FIELDS, "UpdateUserPool");
  const defaults = defaultPoolConfiguration();
  const email = emailConfiguration(input.EmailConfiguration, context);
  const phaseThree = phaseThreeConfiguration(input);
  const tier = (() => {
    if (!["ESSENTIALS", "PLUS"].includes(input.UserPoolTier ?? "ESSENTIALS")) {
      throw new AwsError("InvalidParameterException", "UserPoolTier must be ESSENTIALS or PLUS.");
    }
    return (input.UserPoolTier ?? "ESSENTIALS") as "ESSENTIALS" | "PLUS";
  })();
  if (
    phaseThree.enabledMfas.includes("EMAIL_OTP")
    && (!["ESSENTIALS", "PLUS"].includes(tier) || email.emailSendingAccount !== "DEVELOPER")
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "EMAIL_OTP requires an Essentials or Plus user pool with DEVELOPER email delivery.",
    );
  }
  if (phaseThree.mfaConfiguration === "ON" && phaseThree.enabledMfas.length === 0) {
    throw new AwsError("InvalidParameterException", "Required MFA must enable at least one MFA method.");
  }
  const deviceConfiguration = Object.prototype.hasOwnProperty.call(input, "DeviceConfiguration")
    ? parseDeviceConfiguration(input.DeviceConfiguration)
    : current.deviceConfiguration;
  return {
    ...defaults,
    aliasAttributes: [...current.aliasAttributes],
    usernameAttributes: [...current.usernameAttributes],
    usernameConfiguration: { ...current.usernameConfiguration },
    schemaAttributes: structuredClone(current.schemaAttributes),
    policies: passwordPolicy(input.Policies),
    deletionProtection: input.DeletionProtection === undefined
      ? defaults.deletionProtection
      : (() => {
          if (!["ACTIVE", "INACTIVE"].includes(input.DeletionProtection)) {
            throw new AwsError("InvalidParameterException", "DeletionProtection must be ACTIVE or INACTIVE.");
          }
          return input.DeletionProtection;
        })(),
    autoVerifiedAttributes: emailOnlyArray(input.AutoVerifiedAttributes, "AutoVerifiedAttributes"),
    adminCreateUserConfig: adminCreateUserConfig(input.AdminCreateUserConfig),
    accountRecoverySetting: accountRecovery(input.AccountRecoverySetting),
    emailConfiguration: email,
    verificationMessageTemplate: verificationTemplate(input),
    ...phaseThree,
    userPoolTier: tier,
    ...(deviceConfiguration ? { deviceConfiguration } : {}),
  };
}

const UNITS = new Set(["seconds", "minutes", "hours", "days"]);
type Unit = CognitoAppClientState["tokenValidityUnits"]["accessToken"];

function tokenUnits(value: unknown): CognitoAppClientState["tokenValidityUnits"] {
  if (value === undefined) return { accessToken: "hours", idToken: "hours", refreshToken: "days" };
  const input = object(value, "TokenValidityUnits");
  rejectUnknown(input, ["AccessToken", "IdToken", "RefreshToken"], "TokenValidityUnits");
  const unit = (name: string, fallback: Unit): Unit => {
    const selected = input[name] ?? fallback;
    if (!UNITS.has(selected)) throw new AwsError("InvalidParameterException", `TokenValidityUnits.${name} is invalid.`);
    return selected;
  };
  return {
    accessToken: unit("AccessToken", "hours"),
    idToken: unit("IdToken", "hours"),
    refreshToken: unit("RefreshToken", "days"),
  };
}

function seconds(value: number, unit: Unit): number {
  return value * ({ seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit]);
}

function validity(
  value: unknown,
  field: string,
  unit: Unit,
  fallback: number,
  minimumSeconds: number,
  maximumSeconds: number,
  zeroMeansDefault = false,
): number {
  if (value === undefined || zeroMeansDefault && value === 0) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AwsError("InvalidParameterException", `${field} must be a positive integer.`);
  }
  const duration = seconds(Number(value), unit);
  if (!Number.isSafeInteger(duration) || duration < minimumSeconds || duration > maximumSeconds) {
    throw new AwsError("InvalidParameterException", `${field} is outside the supported token lifetime.`);
  }
  return Number(value);
}

function clientAttributes(value: unknown, field: string): string[] {
  if (value === undefined) return ["email"];
  const selected = strings(value, field);
  if (selected.some(item =>
    !STANDARD_CLIENT_ATTRIBUTES.has(item)
    && !/^custom:[A-Za-z][A-Za-z0-9_]{0,19}$/.test(item)
  )) {
    throw new AwsError("InvalidParameterException", `${field} contains an invalid user attribute.`);
  }
  return selected;
}

const CLIENT_CONFIGURATION_FIELDS = [
  "RefreshTokenValidity",
  "AccessTokenValidity", "IdTokenValidity", "TokenValidityUnits", "ReadAttributes", "WriteAttributes",
  "ExplicitAuthFlows", "PreventUserExistenceErrors", "EnableTokenRevocation", "AuthSessionValidity",
  "SupportedIdentityProviders", "CallbackURLs", "LogoutURLs", "DefaultRedirectURI", "AllowedOAuthFlows",
  "AllowedOAuthScopes", "AllowedOAuthFlowsUserPoolClient", "AnalyticsConfiguration",
  "EnablePropagateAdditionalUserContextData", "RefreshTokenRotation",
] as const;

const CREATE_CLIENT_FIELDS = [
  "UserPoolId", "ClientName", "GenerateSecret", "ClientSecret", ...CLIENT_CONFIGURATION_FIELDS,
] as const;

const UPDATE_CLIENT_FIELDS = [
  "UserPoolId", "ClientId", "ClientName", ...CLIENT_CONFIGURATION_FIELDS,
] as const;

const STANDARD_OAUTH_SCOPES = new Set([
  "openid",
  "email",
  "phone",
  "profile",
  "aws.cognito.signin.user.admin",
]);

function oauthUrls(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  const selected = strings(value, field);
  if (selected.length > 100) {
    throw new AwsError("InvalidParameterException", `${field} contains too many URLs.`);
  }
  return selected.map(item => {
    if (item.length > 1_024) throw new AwsError("InvalidParameterException", `${field} contains an invalid URL.`);
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new AwsError("InvalidParameterException", `${field} contains an invalid URL.`);
    }
    const loopback = parsed.hostname === "localhost"
      || parsed.hostname === "[::1]"
      || parsed.hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
    const httpScheme = parsed.protocol === "http:" || parsed.protocol === "https:";
    const customScheme = !httpScheme
      && /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol)
      && !["data:", "file:", "javascript:", "vbscript:"].includes(parsed.protocol)
      && parsed.hostname.length > 0;
    const omittedRootSlash = item === parsed.origin
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
    if (
      !httpScheme && !customScheme
      || parsed.username
      || parsed.password
      || parsed.hash
      || parsed.protocol === "http:" && !loopback
      || (parsed.href !== item && !omittedRootSlash)
    ) {
      throw new AwsError("InvalidParameterException", `${field} contains an invalid or unsafe URL.`);
    }
    return item;
  });
}

function oauthScopes(value: unknown): string[] {
  if (value === undefined) return [];
  const selected = strings(value, "AllowedOAuthScopes");
  if (
    selected.length > 50
    || selected.some(scope =>
      scope.length > 256
      || !STANDARD_OAUTH_SCOPES.has(scope) && !/^[A-Za-z0-9._~:/-]{1,256}\/[A-Za-z0-9._~-]{1,256}$/.test(scope)
    )
  ) {
    throw new AwsError("InvalidParameterException", "AllowedOAuthScopes contains an invalid scope.");
  }
  return selected;
}

export interface CognitoClientSecretCreation {
  generate: boolean;
  supplied?: string;
}

export function clientSecretCreation(input: Record<string, any>): CognitoClientSecretCreation {
  if (has(input, "GenerateSecret") && has(input, "ClientSecret")) {
    throw new AwsError("InvalidParameterException", "GenerateSecret and ClientSecret are mutually exclusive.");
  }
  if (input.GenerateSecret !== undefined && typeof input.GenerateSecret !== "boolean") {
    throw new AwsError("InvalidParameterException", "GenerateSecret must be a boolean.");
  }
  if (!has(input, "ClientSecret")) return { generate: input.GenerateSecret === true };
  if (
    typeof input.ClientSecret !== "string"
    || input.ClientSecret.length < 24
    || input.ClientSecret.length > 64
    || !/^[A-Za-z0-9_+]+$/.test(input.ClientSecret)
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "ClientSecret must be 24-64 characters containing only letters, numbers, underscore, or plus.",
    );
  }
  return { generate: false, supplied: input.ClientSecret };
}

export function clientConfiguration(
  input: Record<string, any>,
  operation: "create" | "update",
): Omit<CognitoAppClientState, "id" | "name" | "createdAt" | "updatedAt" | "secret"> {
  rejectUnknown(input, operation === "create" ? CREATE_CLIENT_FIELDS : UPDATE_CLIENT_FIELDS, "UserPoolClient");
  for (const deferred of [
    "AnalyticsConfiguration", "EnablePropagateAdditionalUserContextData",
  ]) {
    if (has(input, deferred)) {
      throw new AwsError("InvalidParameterException", `${deferred} is implemented in a later Cognito phase.`);
    }
  }
  if (operation === "create") clientSecretCreation(input);
  const flows = strings(input.ExplicitAuthFlows, "ExplicitAuthFlows");
  if (!flows.length || flows.some(flow => ![
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
  ].includes(flow))) {
    throw new AwsError(
      "InvalidParameterException",
      "ExplicitAuthFlows contains an unsupported authentication flow.",
    );
  }
  const rotationInput = input.RefreshTokenRotation === undefined
    ? {}
    : object(input.RefreshTokenRotation, "RefreshTokenRotation");
  rejectUnknown(rotationInput, ["Feature", "RetryGracePeriodSeconds"], "RefreshTokenRotation");
  const rotationFeature = rotationInput.Feature ?? "DISABLED";
  if (!["ENABLED", "DISABLED"].includes(rotationFeature)) {
    throw new AwsError("InvalidParameterException", "RefreshTokenRotation.Feature is invalid.");
  }
  if (rotationFeature === "ENABLED" && flows.includes("ALLOW_REFRESH_TOKEN_AUTH")) {
    throw new AwsError(
      "InvalidParameterException",
      "ALLOW_REFRESH_TOKEN_AUTH cannot be enabled with refresh-token rotation.",
    );
  }
  const units = tokenUnits(input.TokenValidityUnits);
  const prevent = input.PreventUserExistenceErrors ?? "LEGACY";
  if (!["LEGACY", "ENABLED"].includes(prevent)) {
    throw new AwsError("InvalidParameterException", "PreventUserExistenceErrors must be LEGACY or ENABLED.");
  }
  if (input.EnableTokenRevocation !== undefined && typeof input.EnableTokenRevocation !== "boolean") {
    throw new AwsError("InvalidParameterException", "EnableTokenRevocation must be a boolean.");
  }
  if (
    input.AllowedOAuthFlowsUserPoolClient !== undefined
    && typeof input.AllowedOAuthFlowsUserPoolClient !== "boolean"
  ) {
    throw new AwsError("InvalidParameterException", "AllowedOAuthFlowsUserPoolClient must be a boolean.");
  }
  const supportedIdentityProviders = input.SupportedIdentityProviders === undefined
    ? ["COGNITO"]
    : strings(input.SupportedIdentityProviders, "SupportedIdentityProviders");
  if (
    supportedIdentityProviders.length < 1
    || supportedIdentityProviders.length > 32
    || new Set(supportedIdentityProviders).size !== supportedIdentityProviders.length
    || supportedIdentityProviders.some(provider =>
      provider !== "COGNITO" && !/^[A-Za-z0-9._-]{1,32}$/.test(provider)
    )
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "SupportedIdentityProviders contains an invalid provider name.",
    );
  }
  const callbackUrls = oauthUrls(input.CallbackURLs, "CallbackURLs");
  const logoutUrls = oauthUrls(input.LogoutURLs, "LogoutURLs");
  const defaultRedirectUri = input.DefaultRedirectURI;
  if (
    defaultRedirectUri !== undefined
    && (typeof defaultRedirectUri !== "string" || !callbackUrls.includes(defaultRedirectUri))
  ) {
    throw new AwsError("InvalidParameterException", "DefaultRedirectURI must exactly match a callback URL.");
  }
  const allowedOAuthFlows = input.AllowedOAuthFlows === undefined
    ? []
    : strings(input.AllowedOAuthFlows, "AllowedOAuthFlows");
  if (
    allowedOAuthFlows.some(flow => !["code", "implicit", "client_credentials"].includes(flow))
    || allowedOAuthFlows.includes("client_credentials") && allowedOAuthFlows.length !== 1
  ) {
    throw new AwsError("InvalidParameterException", "AllowedOAuthFlows contains an unsupported grant combination.");
  }
  if (
    allowedOAuthFlows.some(flow => flow === "code" || flow === "implicit")
    && callbackUrls.length === 0
  ) {
    throw new AwsError("InvalidParameterException", "CallbackURLs is required for browser OAuth grants.");
  }
  const allowedOAuthFlowsUserPoolClient = input.AllowedOAuthFlowsUserPoolClient ?? false;
  const allowedOAuthScopes = oauthScopes(input.AllowedOAuthScopes);
  if (!allowedOAuthFlowsUserPoolClient && (allowedOAuthFlows.length || allowedOAuthScopes.length)) {
    throw new AwsError(
      "InvalidParameterException",
      "AllowedOAuthFlowsUserPoolClient must be true when OAuth flows or scopes are configured.",
    );
  }
  return {
    explicitAuthFlows: flows as CognitoAppClientState["explicitAuthFlows"],
    refreshTokenValidity: validity(input.RefreshTokenValidity, "RefreshTokenValidity", units.refreshToken, 30, 3600, 315_360_000, true),
    accessTokenValidity: validity(input.AccessTokenValidity, "AccessTokenValidity", units.accessToken, 1, 300, 86_400),
    idTokenValidity: validity(input.IdTokenValidity, "IdTokenValidity", units.idToken, 1, 300, 86_400),
    tokenValidityUnits: units,
    readAttributes: clientAttributes(input.ReadAttributes, "ReadAttributes"),
    writeAttributes: clientAttributes(input.WriteAttributes, "WriteAttributes"),
    preventUserExistenceErrors: prevent,
    enableTokenRevocation: input.EnableTokenRevocation ?? true,
    authSessionValidity: input.AuthSessionValidity === undefined
      ? 3
      : integer(input.AuthSessionValidity, "AuthSessionValidity", 3, 15),
    refreshTokenRotation: {
      feature: rotationFeature,
      retryGracePeriodSeconds: rotationInput.RetryGracePeriodSeconds === undefined
        ? 0
        : integer(rotationInput.RetryGracePeriodSeconds, "RefreshTokenRotation.RetryGracePeriodSeconds", 0, 60),
    },
    supportedIdentityProviders,
    callbackUrls,
    logoutUrls,
    ...(defaultRedirectUri === undefined ? {} : { defaultRedirectUri }),
    allowedOAuthFlows: allowedOAuthFlows as CognitoAppClientState["allowedOAuthFlows"],
    allowedOAuthScopes,
    allowedOAuthFlowsUserPoolClient,
  };
}
