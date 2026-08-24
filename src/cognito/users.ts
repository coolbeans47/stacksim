import { AwsError } from "../errors.js";
import { parseMailboxAddress } from "../ses/validation.js";
import { STANDARD_USER_ATTRIBUTES } from "./attributes.js";
import type {
  CognitoAppClientState,
  CognitoUserAttributeState,
  CognitoUserPoolState,
  CognitoUserState,
} from "../types.js";

function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", `${field} must be an object.`);
  }
  return value as Record<string, any>;
}

function rejectUnknown(input: Record<string, any>, allowed: readonly string[], operation: string): void {
  const unknown = Object.keys(input).find(key => !allowed.includes(key));
  if (unknown) throw new AwsError("InvalidParameterException", `${operation} does not support ${unknown} in COG-01.`);
}

export function modeledUsername(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || Buffer.byteLength(value, "utf8") > 256
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AwsError("InvalidParameterException", "Username is invalid.");
  }
  return value;
}

export function canonicalUsername(pool: CognitoUserPoolState, value: string): string {
  return pool.configuration.usernameConfiguration.caseSensitive ? value : value.toLocaleLowerCase("en-US");
}

export function cognitoEmail(value: unknown): { value: string; canonical: string } {
  if (typeof value !== "string") throw new AwsError("InvalidParameterException", "email must be a string.");
  try {
    const parsed = parseMailboxAddress(value);
    if (parsed.displayName || parsed.original !== parsed.address) {
      throw new Error();
    }
    return { value: parsed.address, canonical: parsed.normalized };
  } catch {
    throw new AwsError("InvalidParameterException", "email is not a valid address.");
  }
}

export function parseUserAttributes(
  pool: CognitoUserPoolState,
  value: unknown,
  options: { username?: string; allowVerified: boolean; requireSchemaAttributes: boolean },
): Record<string, CognitoUserAttributeState> {
  if (value !== undefined && !Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", "UserAttributes must be an array.");
  }
  const rawAttributes = value ?? [];
  const attributes: Record<string, CognitoUserAttributeState> = {};
  const verified: Record<string, boolean> = {};
  for (let index = 0; index < rawAttributes.length; index += 1) {
    const raw = object(rawAttributes[index], `UserAttributes[${index}]`);
    rejectUnknown(raw, ["Name", "Value"], `UserAttributes[${index}]`);
    if (typeof raw.Name !== "string" || typeof raw.Value !== "string") {
      throw new AwsError("InvalidParameterException", "UserAttributes contains an invalid attribute.");
    }
    if (raw.Name === "sub") {
      throw new AwsError("InvalidParameterException", "The sub attribute is immutable.");
    }
    if (["email_verified", "phone_number_verified"].includes(raw.Name)) {
      const name = raw.Name.slice(0, -"_verified".length);
      if (
        !options.allowVerified
        || !["email", "phone_number"].includes(name)
        || !["true", "false"].includes(raw.Value)
      ) {
        throw new AwsError("InvalidParameterException", `${raw.Name} cannot be set.`);
      }
      if (Object.hasOwn(verified, name)) {
        throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} is duplicated.`);
      }
      verified[name] = raw.Value === "true";
      continue;
    }

    const standard = STANDARD_USER_ATTRIBUTES.has(raw.Name);
    const custom = raw.Name.startsWith("custom:");
    const schemaName = custom ? raw.Name.slice("custom:".length) : raw.Name;
    const schema = pool.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
    if (
      !standard
      && (!custom || STANDARD_USER_ATTRIBUTES.has(schemaName) || !schema)
    ) {
      throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} is not in the schema.`);
    }
    if (Object.hasOwn(attributes, raw.Name)) {
      throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} is duplicated.`);
    }
    const attributeValue = raw.Name === "email" ? cognitoEmail(raw.Value).value : raw.Value;
    if (Buffer.byteLength(attributeValue, "utf8") > 2_048) {
      throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} is too long.`);
    }
    if (schema) {
      if (schema.attributeDataType === "String") {
        const length = [...attributeValue].length;
        const minimum = schema.stringAttributeConstraints?.minLength === undefined
          ? undefined
          : Number(schema.stringAttributeConstraints.minLength);
        const maximum = schema.stringAttributeConstraints?.maxLength === undefined
          ? undefined
          : Number(schema.stringAttributeConstraints.maxLength);
        if (minimum !== undefined && length < minimum || maximum !== undefined && length > maximum) {
          throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} violates its length constraints.`);
        }
      } else if (schema.attributeDataType === "Number") {
        const numeric = Number(attributeValue);
        const minimum = schema.numberAttributeConstraints?.minValue === undefined
          ? undefined
          : Number(schema.numberAttributeConstraints.minValue);
        const maximum = schema.numberAttributeConstraints?.maxValue === undefined
          ? undefined
          : Number(schema.numberAttributeConstraints.maxValue);
        if (
          !Number.isFinite(numeric)
          || minimum !== undefined && numeric < minimum
          || maximum !== undefined && numeric > maximum
        ) {
          throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} violates its number constraints.`);
        }
      } else if (schema.attributeDataType === "Boolean" && !["true", "false"].includes(attributeValue)) {
        throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} must be boolean.`);
      } else if (schema.attributeDataType === "DateTime" && !Number.isFinite(Date.parse(attributeValue))) {
        throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} must be a date-time.`);
      }
    }
    attributes[raw.Name] = { value: attributeValue, verified: false };
  }

  if (options.username && pool.configuration.usernameAttributes.includes("email")) {
    const usernameEmail = cognitoEmail(options.username);
    if (attributes.email && cognitoEmail(attributes.email.value).canonical !== usernameEmail.canonical) {
      throw new AwsError("InvalidParameterException", "Username and email attribute must match.");
    }
    attributes.email ??= { value: usernameEmail.value, verified: false };
  }
  for (const [name, isVerified] of Object.entries(verified)) {
    if (!attributes[name]) {
      throw new AwsError("InvalidParameterException", `${name}_verified requires ${name}.`);
    }
    attributes[name].verified = isVerified;
  }
  if (options.requireSchemaAttributes) {
    for (const schema of pool.configuration.schemaAttributes) {
      const attributeName = STANDARD_USER_ATTRIBUTES.has(schema.name)
        ? schema.name
        : `custom:${schema.name}`;
      if (schema.required && !attributes[attributeName]) {
        throw new AwsError("InvalidParameterException", `The ${attributeName} attribute is required.`);
      }
    }
  }
  return attributes;
}

export interface ParsedSignUp {
  submittedUsername: string;
  usernameIndexKey: string;
  attributes: Record<string, CognitoUserAttributeState>;
  password: string;
}

export function parseSignUp(
  input: Record<string, any>,
  pool: CognitoUserPoolState,
  client: CognitoAppClientState,
): ParsedSignUp {
  rejectUnknown(
    input,
    [
      "ClientId", "SecretHash", "Username", "Password", "UserAttributes",
      "ValidationData", "ClientMetadata",
    ],
    "SignUp",
  );
  const submittedUsername = modeledUsername(input.Username);
  if (typeof input.Password !== "string") {
    throw new AwsError("InvalidPasswordException", "Password must be a string.");
  }
  const attributes = parseUserAttributes(pool, input.UserAttributes, {
    username: submittedUsername,
    allowVerified: false,
    requireSchemaAttributes: true,
  });
  const email = attributes.email;
  let usernameIndexKey: string;
  if (pool.configuration.usernameAttributes.includes("email")) {
    usernameIndexKey = cognitoEmail(submittedUsername).canonical;
  } else {
    usernameIndexKey = canonicalUsername(pool, submittedUsername);
  }
  const emailRequired = pool.configuration.usernameAttributes.includes("email")
    || pool.configuration.schemaAttributes.some(attribute => attribute.name === "email" && attribute.required);
  if (!email && emailRequired) {
    throw new AwsError("InvalidParameterException", "The email attribute is required by the user-pool schema.");
  }
  for (const name of Object.keys(attributes)) {
    const schemaName = name.startsWith("custom:") ? name.slice("custom:".length) : name;
    const schema = pool.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
    if (schema?.developerOnlyAttribute) {
      throw new AwsError("InvalidParameterException", `User attribute ${name} cannot be set during SignUp.`);
    }
    if (!client.writeAttributes.includes(name)) {
      throw new AwsError("NotAuthorizedException", `App client cannot write the ${name} attribute.`);
    }
  }
  return {
    submittedUsername,
    usernameIndexKey,
    attributes,
    password: input.Password,
  };
}

export function findUserByModeledUsername(
  pool: CognitoUserPoolState,
  value: unknown,
): CognitoUserState | undefined {
  const submitted = modeledUsername(value);
  let sub: string | undefined;
  if (pool.configuration.usernameAttributes.includes("email")) {
    sub = pool.usernameIndex[cognitoEmail(submitted).canonical];
  } else {
    sub = pool.usernameIndex[canonicalUsername(pool, submitted)];
    if (!sub && pool.configuration.aliasAttributes.includes("email")) {
      try { sub = pool.aliasIndex[cognitoEmail(submitted).canonical]; } catch { /* It was a username, not an email alias. */ }
    }
  }
  return sub ? pool.usersBySub[sub] : undefined;
}

export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const domainName = dot > 0 ? domain.slice(0, dot) : domain;
  const suffix = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domainName[0] ?? "*"}***${suffix}`;
}
