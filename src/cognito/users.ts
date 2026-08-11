import { AwsError } from "../errors.js";
import { parseMailboxAddress } from "../ses/validation.js";
import type {
  CognitoAppClientState,
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

function userAttributes(value: unknown): { email?: { value: string; canonical: string } } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new AwsError("InvalidParameterException", "UserAttributes must be an array.");
  let email: { value: string; canonical: string } | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const attribute = object(value[index], `UserAttributes[${index}]`);
    rejectUnknown(attribute, ["Name", "Value"], `UserAttributes[${index}]`);
    if (attribute.Name !== "email") {
      throw new AwsError("InvalidParameterException", "Only the email user attribute is available in COG-01.");
    }
    if (email) throw new AwsError("InvalidParameterException", "UserAttributes contains email more than once.");
    email = cognitoEmail(attribute.Value);
  }
  return { ...(email ? { email } : {}) };
}

export interface ParsedSignUp {
  submittedUsername: string;
  usernameIndexKey: string;
  email?: { value: string; canonical: string };
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
  const attributes = userAttributes(input.UserAttributes);
  let email = attributes.email;
  let usernameIndexKey: string;
  if (pool.configuration.usernameAttributes.includes("email")) {
    const usernameEmail = cognitoEmail(submittedUsername);
    if (email && email.canonical !== usernameEmail.canonical) {
      throw new AwsError("InvalidParameterException", "Username and email attribute must match.");
    }
    email = usernameEmail;
    usernameIndexKey = usernameEmail.canonical;
  } else {
    usernameIndexKey = canonicalUsername(pool, submittedUsername);
  }
  const emailRequired = pool.configuration.usernameAttributes.includes("email")
    || pool.configuration.schemaAttributes.some(attribute => attribute.name === "email" && attribute.required);
  if (!email && emailRequired) {
    throw new AwsError("InvalidParameterException", "The email attribute is required by the user-pool schema.");
  }
  if (email && !client.writeAttributes.includes("email")) {
    throw new AwsError("NotAuthorizedException", "App client cannot write the email attribute.");
  }
  return {
    submittedUsername,
    usernameIndexKey,
    ...(email ? { email } : {}),
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
