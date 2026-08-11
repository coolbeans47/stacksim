import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, type JsonWebKey } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { AwsError } from "./errors.js";
import type { SesService } from "./ses.js";
import type { LambdaService } from "./lambda.js";
import type { StateStore } from "./state.js";
import type {
  CognitoAppClientState,
  CognitoAuditEventState,
  CognitoAuthorizationCodeState,
  CognitoBrowserSessionState,
  CognitoDeliveryIntentState,
  CognitoExternalIdentityState,
  CognitoFederationTransactionState,
  CognitoIdentityProviderState,
  CognitoDeviceState,
  CognitoManagedLoginBrandingState,
  CognitoRecoverableSecretState,
  CognitoRefreshSessionState,
  CognitoResourceServerState,
  CognitoUserAttributeState,
  CognitoUserPoolConfigurationState,
  CognitoUserPoolState,
  CognitoUserState,
} from "./types.js";
import { cognitoTargetOperation } from "./cognito/action-inventory.js";
import { throwCog07BoundaryForOperation } from "./cognito/cog07-boundaries.js";
import {
  assignClientSecrets,
  clientHasSecret,
  clientSecretDescriptor,
  clientSecretEntries,
  createClientSecretEntry,
  ensureConfidentialClient,
  generatedClientSecretValue,
  MAX_ACTIVE_CLIENT_SECRETS,
  normalizedClientSecrets,
  parseAddUserPoolClientSecretInput,
  parseDeleteUserPoolClientSecretInput,
  parseListUserPoolClientSecretsInput,
} from "./cognito/client-secrets-lifecycle.js";
import { verifyClientSecretHash } from "./cognito/client-secret.js";
import {
  assertDeviceKey,
  createPendingDevice,
  decodeDeviceVerifierMaterial,
  deviceConfigurationView,
  deviceTrackingEnabled,
  ensurePendingDevices,
  MAX_DEVICES_PER_USER,
  purgeExpiredPendingDevices,
} from "./cognito/devices.js";
import { parseCognitoJson, sendCognitoError, sendCognitoJson } from "./cognito/protocol.js";
import { CognitoSecrets } from "./cognito/secrets.js";
import {
  generatePoolSigningKeys,
  signCognitoJwt,
  signingKeysEtag,
  signingPublicKeys,
} from "./cognito/signing.js";
import { CognitoPasswordHasher, validatePasswordPolicy } from "./cognito/passwords.js";
import {
  canonicalUsername,
  cognitoEmail,
  findUserByModeledUsername,
  maskEmail,
  modeledUsername,
  parseSignUp,
} from "./cognito/users.js";
import {
  clientConfiguration,
  clientId,
  clientSecretCreation,
  cognitoName,
  createPoolConfiguration,
  updatePoolConfiguration,
  userPoolId,
} from "./cognito/validation.js";
import {
  COGNITO_USER_ADMIN_SCOPE,
  cognitoIssuer,
  verifyCognitoAccessToken,
  type VerifiedCognitoAccessClaims,
} from "./cognito/tokens.js";
import { parseJwt } from "./core/jwt.js";
import {
  CognitoRestConfigurationError,
  CognitoRestTokenError,
  cognitoPoolCacheVersion,
  parseCognitoUserPoolArn,
  verifyCognitoRestToken,
  type CognitoIssuerKeySource,
  type CognitoIssuerResolution,
  type CognitoRestAuthorizerVerification,
  type CognitoRestAuthorizerVerifier,
} from "./cognito/gateway.js";
import {
  OAuthEndpointError,
  clearSessionCookie,
  cognitoDomainBase,
  cookieValue,
  escapeHtml,
  oauthHeaders,
  readOAuthForm,
  sendManagedLoginHtml,
  sendOAuthError,
  sendOAuthJson,
  sendOAuthRedirect,
  sessionCookie,
  validateCognitoPublicUrl,
} from "./cognito/oauth.js";
import {
  FederationError,
  SafeIdentityProviderHttpClient,
  createSamlRedirect,
  oidcTokenHeader,
  parseSamlMetadata,
  resolveOidcConfiguration,
  verifyOidcIdToken,
  verifySamlResponse,
  type IdentityProviderNetworkOptions,
  type OidcProviderConfiguration,
  type SamlMetadata,
} from "./cognito/federation.js";

const MAX_POOLS = 60;
const MAX_CLIENTS_PER_POOL = 1_000;
const AUDIT_LIMIT = 1_000;
const CONFIRMATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CONFIRMATION_ATTEMPTS = 5;
const RESEND_WINDOW_MS = 60 * 60 * 1_000;
const RESEND_LIMIT = 3;
const ADMISSION_WINDOW_MS = 5 * 60 * 1_000;
const INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OAUTH_CODE_LIFETIME_MS = 5 * 60 * 1_000;
const OAUTH_BROWSER_SESSION_LIFETIME_MS = 60 * 60 * 1_000;
const OAUTH_ANONYMOUS_SESSION_LIFETIME_MS = 10 * 60 * 1_000;
const OAUTH_REPLAY_RETENTION_MS = 60 * 60 * 1_000;
const OAUTH_SESSION_COOKIE = "stacksim_cognito_session";
const FEDERATION_TRANSACTION_LIFETIME_MS = 10 * 60 * 1_000;
const FEDERATION_REPLAY_RETENTION_MS = 60 * 60 * 1_000;
const STANDARD_OAUTH_SCOPES = new Set([
  "openid",
  "email",
  "phone",
  "profile",
  COGNITO_USER_ADMIN_SCOPE,
]);
const STANDARD_USER_ATTRIBUTES = new Set([
  "address",
  "birthdate",
  "email",
  "family_name",
  "gender",
  "given_name",
  "locale",
  "middle_name",
  "name",
  "nickname",
  "phone_number",
  "picture",
  "preferred_username",
  "profile",
  "updated_at",
  "website",
  "zoneinfo",
]);

interface CognitoAccessContext {
  pool: CognitoUserPoolState;
  client: CognitoAppClientState;
  user: CognitoUserState;
  session: CognitoRefreshSessionState;
  claims: VerifiedCognitoAccessClaims;
}

interface CognitoRefreshContext {
  pool: CognitoUserPoolState;
  client: CognitoAppClientState;
  user: CognitoUserState;
  session: CognitoRefreshSessionState;
}

interface CognitoAuthenticationStep {
  response: Record<string, unknown>;
  deliveryIntentId?: string;
  postAuthentication?: {
    poolId: string;
    clientId: string;
    userSub: string;
    sessionId: string;
    eventId: string;
    clientMetadata: Record<string, string>;
  };
}

function randomAlphaNumeric(length: number, alphabet: string): string {
  const output: string[] = [];
  while (output.length < length) {
    for (const byte of randomBytes(Math.max(16, length - output.length))) {
      const usable = Math.floor(256 / alphabet.length) * alphabet.length;
      if (byte >= usable) continue;
      output.push(alphabet[byte % alphabet.length]);
      if (output.length === length) break;
    }
  }
  return output.join("");
}

function base32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  if (!/^[A-Z2-7]{16,128}$/.test(value)) throw new AwsError("InvalidParameterException", "Software token secret is invalid.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];
  for (const character of value) {
    current = (current << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret: string, timeMs: number): string {
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  try {
    const digest = createHmac("sha1", key).update(counter).digest();
    try {
      const offset = digest[digest.length - 1] & 0x0f;
      const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;
      return String(binary % 1_000_000).padStart(6, "0");
    } finally {
      digest.fill(0);
    }
  } finally {
    key.fill(0);
    counter.fill(0);
  }
}

const SRP_N = BigInt(`0x${[
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1",
  "29024E088A67CC74020BBEA63B139B22514A08798E3404D",
  "DEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C",
  "245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F40",
  "6B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651EC",
  "E45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8F",
  "D24CF5F83655D23DCA3AD961C62F356208552BB9ED52907",
  "7096966D670C354E4ABC9804F1746C08CA18217C32905E4",
  "62E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55D",
  "F06F4C52C9DE2BCBF6955817183995497CEA956AE515D226",
  "1898FA051015728E5A8AAAC42DAD33170D04507A33A85521",
  "ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F",
  "85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3",
  "D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F",
  "2B18177B200CBBE117577A615D6C770988C0BAD946E208E24",
  "FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFF",
  "FFFFFFFFFFFF",
].join("")}`);
const SRP_G = 2n;
const SRP_BYTES = Math.ceil(SRP_N.toString(16).length / 2);

function srpHash(...parts: Array<string | Buffer>): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function srpPad(value: bigint): Buffer {
  const hex = value.toString(16).padStart(SRP_BYTES * 2, "0");
  return Buffer.from(hex, "hex");
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = ((base % modulus) + modulus) % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

function srpMultiplier(): bigint {
  return BigInt(`0x${srpHash(srpPad(SRP_N), srpPad(SRP_G)).toString("hex")}`);
}

function srpCredential(pool: CognitoUserPoolState, username: string, password: string): {
  salt: string;
  verifier: string;
} {
  const salt = randomBytes(16);
  const identity = srpHash(`${pool.id.split("_")[1]}${username}:${password}`);
  const x = BigInt(`0x${srpHash(salt, identity).toString("hex")}`);
  identity.fill(0);
  try {
    return {
      salt: salt.toString("hex"),
      verifier: modPow(SRP_G, x, SRP_N).toString(16),
    };
  } finally {
    salt.fill(0);
  }
}

function srpDerivedKey(shared: bigint, scramble: bigint): Buffer {
  const prk = createHmac("sha256", srpPad(scramble)).update(srpPad(shared)).digest();
  try {
    return createHmac("sha256", prk)
      .update(Buffer.concat([Buffer.from("Caldera Derived Key", "utf8"), Buffer.from([1])]))
      .digest()
      .subarray(0, 16);
  } finally {
    prk.fill(0);
  }
}

function timestamp(value: number): number {
  return value / 1_000;
}

function deviceView(device: import("./types.js").CognitoDeviceState): Record<string, unknown> {
  return {
    DeviceKey: device.key,
    DeviceAttributes: device.name
      ? [{ Name: "device_name", Value: device.name }]
      : [],
    DeviceCreateDate: timestamp(device.createdAt),
    DeviceLastModifiedDate: timestamp(device.lastModifiedAt),
    ...(device.lastAuthenticatedAt === undefined
      ? {}
      : { DeviceLastAuthenticatedDate: timestamp(device.lastAuthenticatedAt) }),
  };
}

function validitySeconds(
  value: number,
  unit: "seconds" | "minutes" | "hours" | "days",
): number {
  return value * ({ seconds: 1, minutes: 60, hours: 3_600, days: 86_400 }[unit]);
}

function canonicalDeliveryContent(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function stringRecord(value: unknown, field: string, maximumEntries = 20): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", `${field} must be an object.`);
  }
  const entries = Object.entries(value);
  if (entries.length > maximumEntries) {
    throw new AwsError("InvalidParameterException", `${field} contains too many entries.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      !key
      || key.length > 128
      || typeof item !== "string"
      || Buffer.byteLength(item, "utf8") > 2_048
    ) {
      throw new AwsError("InvalidParameterException", `${field} contains an invalid entry.`);
    }
    result[key] = item;
  }
  return result;
}

function groupName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[\p{L}\p{M}\p{S}\p{N}\p{P}]+$/u.test(value)
  ) {
    throw new AwsError("InvalidParameterException", "GroupName is invalid.");
  }
  return value;
}

function tagMap(value: unknown): Record<string, string> {
  const tags = stringRecord(value, "Tags", 50);
  for (const [key, item] of Object.entries(tags)) {
    if (
      key.length > 128
      || Buffer.byteLength(key, "utf8") > 128
      || item.length > 256
      || Buffer.byteLength(item, "utf8") > 256
      || key.toLowerCase().startsWith("aws:")
    ) {
      throw new AwsError("InvalidParameterException", "Tags contains an invalid key or value.");
    }
  }
  return tags;
}

function partitionForRegion(region: string): "aws" | "aws-cn" | "aws-us-gov" {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

function dnsSuffixForRegion(region: string): "amazonaws.com" | "amazonaws.com.cn" {
  return region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
}

function poolConfigurationView(configuration: CognitoUserPoolConfigurationState): Record<string, unknown> {
  return {
    Policies: {
      PasswordPolicy: {
        MinimumLength: configuration.policies.passwordPolicy.minimumLength,
        RequireUppercase: configuration.policies.passwordPolicy.requireUppercase,
        RequireLowercase: configuration.policies.passwordPolicy.requireLowercase,
        RequireNumbers: configuration.policies.passwordPolicy.requireNumbers,
        RequireSymbols: configuration.policies.passwordPolicy.requireSymbols,
        TemporaryPasswordValidityDays: configuration.policies.passwordPolicy.temporaryPasswordValidityDays,
        PasswordHistorySize: configuration.policies.passwordPolicy.passwordHistorySize ?? 0,
      },
    },
    DeletionProtection: configuration.deletionProtection,
    AutoVerifiedAttributes: [...configuration.autoVerifiedAttributes],
    AliasAttributes: [...configuration.aliasAttributes],
    UsernameAttributes: [...configuration.usernameAttributes],
    UsernameConfiguration: { CaseSensitive: configuration.usernameConfiguration.caseSensitive },
    AdminCreateUserConfig: {
      AllowAdminCreateUserOnly: configuration.adminCreateUserConfig.allowAdminCreateUserOnly,
      ...(configuration.adminCreateUserConfig.unusedAccountValidityDays === undefined
        ? {}
        : { UnusedAccountValidityDays: configuration.adminCreateUserConfig.unusedAccountValidityDays }),
      InviteMessageTemplate: {
        EmailSubject: configuration.adminCreateUserConfig.inviteMessageTemplate.emailSubject,
        EmailMessage: configuration.adminCreateUserConfig.inviteMessageTemplate.emailMessage,
      },
    },
    SchemaAttributes: configuration.schemaAttributes.map(attribute => ({
      Name: attribute.name,
      AttributeDataType: attribute.attributeDataType,
      DeveloperOnlyAttribute: attribute.developerOnlyAttribute,
      Mutable: attribute.mutable,
      Required: attribute.required,
      ...(attribute.stringAttributeConstraints
        ? {
            StringAttributeConstraints: {
              MinLength: attribute.stringAttributeConstraints.minLength,
              MaxLength: attribute.stringAttributeConstraints.maxLength,
            },
          }
        : {}),
      ...(attribute.numberAttributeConstraints
        ? {
            NumberAttributeConstraints: {
              MinValue: attribute.numberAttributeConstraints.minValue,
              MaxValue: attribute.numberAttributeConstraints.maxValue,
            },
          }
        : {}),
    })),
    AccountRecoverySetting: configuration.accountRecoverySetting === undefined
      ? undefined
      : {
          RecoveryMechanisms: configuration.accountRecoverySetting.recoveryMechanisms.map(mechanism => ({
            Name: mechanism.name,
            Priority: mechanism.priority,
          })),
        },
    EmailConfiguration: {
      EmailSendingAccount: configuration.emailConfiguration.emailSendingAccount,
      ...(configuration.emailConfiguration.sourceArn
        ? { SourceArn: configuration.emailConfiguration.sourceArn }
        : {}),
      ...(configuration.emailConfiguration.from
        ? { From: configuration.emailConfiguration.from }
        : {}),
      ...(configuration.emailConfiguration.replyToEmailAddress
        ? { ReplyToEmailAddress: configuration.emailConfiguration.replyToEmailAddress }
        : {}),
      ...(configuration.emailConfiguration.configurationSet
        ? { ConfigurationSet: configuration.emailConfiguration.configurationSet }
        : {}),
    },
    VerificationMessageTemplate: {
      DefaultEmailOption: configuration.verificationMessageTemplate.defaultEmailOption,
      EmailSubject: configuration.verificationMessageTemplate.emailSubject,
      EmailMessage: configuration.verificationMessageTemplate.emailMessage,
    },
    EmailVerificationSubject: configuration.verificationMessageTemplate.emailSubject,
    EmailVerificationMessage: configuration.verificationMessageTemplate.emailMessage,
    MfaConfiguration: configuration.mfaConfiguration,
    EnabledMfas: [...configuration.enabledMfas],
    LambdaConfig: {
      PreSignUp: configuration.lambdaConfig.preSignUp,
      CustomMessage: configuration.lambdaConfig.customMessage,
      PostConfirmation: configuration.lambdaConfig.postConfirmation,
      PreAuthentication: configuration.lambdaConfig.preAuthentication,
      PostAuthentication: configuration.lambdaConfig.postAuthentication,
      PreTokenGeneration: configuration.lambdaConfig.preTokenGeneration,
      PreTokenGenerationConfig: configuration.lambdaConfig.preTokenGenerationConfig
        ? {
            LambdaArn: configuration.lambdaConfig.preTokenGenerationConfig.lambdaArn,
            LambdaVersion: configuration.lambdaConfig.preTokenGenerationConfig.lambdaVersion,
          }
        : undefined,
    },
    UserPoolTier: configuration.userPoolTier,
    ...(deviceConfigurationView(configuration.deviceConfiguration)
      ? { DeviceConfiguration: deviceConfigurationView(configuration.deviceConfiguration) }
      : {}),
  };
}

function poolView(pool: CognitoUserPoolState): Record<string, unknown> {
  return {
    Id: pool.id,
    Name: pool.name,
    Status: "Enabled",
    LastModifiedDate: timestamp(pool.updatedAt),
    CreationDate: timestamp(pool.createdAt),
    EstimatedNumberOfUsers: Object.keys(pool.usersBySub ?? {}).length,
    Arn: pool.arn,
    ...poolConfigurationView(pool.configuration),
  };
}

function userAttributesView(user: CognitoUserState): Array<{ Name: string; Value: string }> {
  return [
    { Name: "sub", Value: user.sub },
    ...(user.externalIdentities?.length
      ? [{
          Name: "identities",
          Value: JSON.stringify(user.externalIdentities.map((identity, index) => ({
            userId: identity.providerSubject,
            providerName: identity.providerName,
            providerType: identity.providerType,
            primary: index === 0,
            dateCreated: identity.linkedAt,
          }))),
        }]
      : []),
    ...Object.entries(user.attributes)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, attribute]) => [
        { Name: name, Value: attribute.value },
        ...(name === "email"
          ? [{ Name: "email_verified", Value: String(attribute.verified) }]
          : []),
      ]),
  ];
}

function userView(user: CognitoUserState): Record<string, unknown> {
  return {
    Username: user.username,
    Attributes: userAttributesView(user),
    UserCreateDate: timestamp(user.createdAt),
    UserLastModifiedDate: timestamp(user.updatedAt),
    Enabled: user.enabled,
    UserStatus: user.status,
    MFAOptions: [],
  };
}

function groupView(group: import("./types.js").CognitoGroupState): Record<string, unknown> {
  return {
    GroupName: group.name,
    ...(group.description === undefined ? {} : { Description: group.description }),
    ...(group.roleArn === undefined ? {} : { RoleArn: group.roleArn }),
    ...(group.precedence === undefined ? {} : { Precedence: group.precedence }),
    LastModifiedDate: timestamp(group.updatedAt),
    CreationDate: timestamp(group.createdAt),
  };
}

function clientView(poolId: string, client: CognitoAppClientState, secret?: string): Record<string, unknown> {
  return {
    UserPoolId: poolId,
    ClientName: client.name,
    ClientId: client.id,
    ...(secret === undefined ? {} : { ClientSecret: secret }),
    LastModifiedDate: timestamp(client.updatedAt),
    CreationDate: timestamp(client.createdAt),
    RefreshTokenValidity: client.refreshTokenValidity,
    AccessTokenValidity: client.accessTokenValidity,
    IdTokenValidity: client.idTokenValidity,
    TokenValidityUnits: {
      RefreshToken: client.tokenValidityUnits.refreshToken,
      AccessToken: client.tokenValidityUnits.accessToken,
      IdToken: client.tokenValidityUnits.idToken,
    },
    ReadAttributes: [...client.readAttributes],
    WriteAttributes: [...client.writeAttributes],
    ExplicitAuthFlows: [...client.explicitAuthFlows],
    PreventUserExistenceErrors: client.preventUserExistenceErrors,
    EnableTokenRevocation: client.enableTokenRevocation,
    AuthSessionValidity: client.authSessionValidity,
    RefreshTokenRotation: {
      Feature: client.refreshTokenRotation.feature,
      RetryGracePeriodSeconds: client.refreshTokenRotation.retryGracePeriodSeconds,
    },
    SupportedIdentityProviders: [...client.supportedIdentityProviders],
    CallbackURLs: [...client.callbackUrls],
    LogoutURLs: [...client.logoutUrls],
    ...(client.defaultRedirectUri === undefined ? {} : { DefaultRedirectURI: client.defaultRedirectUri }),
    AllowedOAuthFlows: [...client.allowedOAuthFlows],
    AllowedOAuthScopes: [...client.allowedOAuthScopes],
    AllowedOAuthFlowsUserPoolClient: client.allowedOAuthFlowsUserPoolClient,
  };
}

function tokenEligibleUser(user: CognitoUserState): boolean {
  return user.status === "CONFIRMED" || user.status === "EXTERNAL_PROVIDER";
}

interface CognitoOAuthAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: "code" | "token";
  scopes: string[];
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  prompt?: "login";
  providerName?: string;
}

export class CognitoService implements CognitoIssuerKeySource, CognitoRestAuthorizerVerifier {
  private mutation = Promise.resolve();
  private readonly deliveryWork = new Map<string, Promise<void>>();
  private readonly accessProof = new WeakMap<Record<string, any>, CognitoAccessContext>();
  private readonly refreshProof = new WeakMap<Record<string, any>, CognitoRefreshContext>();
  private readonly challengeProof = new WeakMap<
    Record<string, any>,
    {
      pool: CognitoUserPoolState;
      client: CognitoAppClientState;
      user: CognitoUserState;
      challenge: import("./types.js").CognitoChallengeState;
    }
  >();
  private publicBaseUrl?: string;
  private readonly providerHttp: SafeIdentityProviderHttpClient;
  private readonly oidcKeyCache = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();

  static validatePublicUrl(value: string): string {
    return validateCognitoPublicUrl(value);
  }

  constructor(
    private readonly store: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    private readonly secrets: CognitoSecrets,
    private readonly passwords: CognitoPasswordHasher,
    private readonly ses: SesService,
    private readonly telemetry?: TelemetryBus,
    private readonly lambda?: LambdaService,
    identityProviderNetwork: IdentityProviderNetworkOptions = { allowPublic: false },
  ) {
    this.providerHttp = new SafeIdentityProviderHttpClient(identityProviderNetwork);
  }

  private get state() {
    return this.store.regionState(this.region).cognito;
  }

  private get tokens(): PaginationTokens {
    return new PaginationTokens(this.store.state.installation.paginationSecret);
  }

  private async invokeTrigger(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState | undefined,
    user: CognitoUserState | { username: string; attributes: Record<string, CognitoUserAttributeState> },
    trigger: keyof CognitoUserPoolConfigurationState["lambdaConfig"],
    triggerSource: string,
    request: Record<string, unknown> = {},
  ): Promise<Record<string, any> | undefined> {
    const configured = pool.configuration.lambdaConfig[trigger];
    const lambdaArn = typeof configured === "string"
      ? configured
      : configured && typeof configured === "object" && "lambdaArn" in configured
        ? configured.lambdaArn
        : undefined;
    if (!lambdaArn) return undefined;
    if (!this.lambda) throw new AwsError("InvalidLambdaResponseException", "Lambda trigger service is unavailable.");
    const attributes = Object.fromEntries([
      ["sub", "sub" in user ? user.sub : undefined],
      ...Object.entries(user.attributes).map(([name, attribute]) => [name, attribute.value]),
      ...(user.attributes.email ? [["email_verified", String(user.attributes.email.verified)]] : []),
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const event = {
      version: "1",
      triggerSource,
      region: this.region,
      userPoolId: pool.id,
      userName: user.username,
      callerContext: {
        awsSdkVersion: "aws-sdk-js-3",
        clientId: client?.id ?? "ADMIN",
      },
      request: {
        userAttributes: attributes,
        ...request,
      },
      response: {},
    };
    let result;
    const invocationStartedAt = this.clock.now();
    try {
      result = await this.lambda.invoke(
        lambdaArn,
        Buffer.from(JSON.stringify(event), "utf8"),
        randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
        {
          principal: "cognito-idp.amazonaws.com",
          sourceArn: pool.arn,
          sourceAccount: this.store.accountId,
          enforceResourcePolicy: true,
          timeoutOverrideMs: 5_000,
          sanitizeEnvironment: true,
          sensitiveLogValues: Object.values(attributes).filter(value => value.length >= 6),
        },
      );
    } catch (error) {
      await this.metric(`Lambda:${triggerSource}`, "TriggerFailureCount", pool.id);
      throw new AwsError(
        "InvalidLambdaResponseException",
        error instanceof Error ? `Lambda trigger failed: ${error.message}` : "Lambda trigger failed.",
      );
    }
    await this.metric(`Lambda:${triggerSource}`, "TriggerDuration", pool.id, Math.max(0, this.clock.now() - invocationStartedAt), "Milliseconds");
    if (result.functionError) {
      await this.metric(`Lambda:${triggerSource}`, "TriggerFailureCount", pool.id);
      let message = "Lambda trigger returned an error.";
      try {
        const parsed = JSON.parse(result.payload.toString("utf8"));
        if (typeof parsed?.errorMessage === "string") message = parsed.errorMessage;
      } catch { /* Preserve the safe generic message. */ }
      throw new AwsError("UserLambdaValidationException", message);
    }
    try {
      const output = JSON.parse(result.payload.toString("utf8"));
      if (!output || typeof output !== "object" || Array.isArray(output) || typeof output.response !== "object") {
        throw new Error();
      }
      await this.metric(`Lambda:${triggerSource}`, "TriggerSuccessCount", pool.id);
      return output.response as Record<string, any>;
    } catch {
      await this.metric(`Lambda:${triggerSource}`, "TriggerFailureCount", pool.id);
      throw new AwsError("InvalidLambdaResponseException", "Lambda trigger returned invalid JSON.");
    }
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  async start(): Promise<void> {
    try {
      this.secrets.assertAvailable();
    } catch {
      return;
    }
    let normalized = false;
    const now = this.clock.now();
    for (const pool of Object.values(this.state.pools)) {
      if (!pool.usersBySub) { pool.usersBySub = {}; normalized = true; }
      if (!pool.usernameIndex) { pool.usernameIndex = {}; normalized = true; }
      if (!pool.aliasIndex) { pool.aliasIndex = {}; normalized = true; }
      if (!pool.refreshSessions) { pool.refreshSessions = {}; normalized = true; }
      if (!pool.resourceServers) { pool.resourceServers = {}; normalized = true; }
      if (!pool.managedLoginBranding) { pool.managedLoginBranding = {}; normalized = true; }
      if (!pool.uiCustomizations) { pool.uiCustomizations = {}; normalized = true; }
      if (!pool.authorizationCodes) { pool.authorizationCodes = {}; normalized = true; }
      if (!pool.browserSessions) { pool.browserSessions = {}; normalized = true; }
      if (!pool.identityProviders) { pool.identityProviders = {}; normalized = true; }
      if (!pool.identityProviderIdentifierIndex) { pool.identityProviderIdentifierIndex = {}; normalized = true; }
      if (!pool.federatedIdentityIndex) { pool.federatedIdentityIndex = {}; normalized = true; }
      if (!pool.federationTransactions) { pool.federationTransactions = {}; normalized = true; }
      if (!pool.federationReplayIds) { pool.federationReplayIds = {}; normalized = true; }
      for (const user of Object.values(pool.usersBySub)) {
        if (!user.externalIdentities) { user.externalIdentities = []; normalized = true; }
        if (!user.pendingDevices) { user.pendingDevices = {}; normalized = true; }
        if (purgeExpiredPendingDevices(user, now)) normalized = true;
        for (const device of Object.values(user.devices ?? {})) {
          if (!device.groupKey) {
            device.groupKey = `-${device.key.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "device"}`;
            normalized = true;
          }
          if (device.secretVerifier && (!device.passwordVerifier || !device.salt)) {
            try {
              const wrapped = this.wrapDeviceVerifier(
                pool,
                user,
                device.key,
                device.secretVerifier.passwordVerifier,
                device.secretVerifier.salt,
              );
              device.passwordVerifier = wrapped.passwordVerifier;
              device.salt = wrapped.salt;
              delete device.secretVerifier;
              normalized = true;
            } catch {
              // Leave legacy plaintext until the cognito key is available.
            }
          }
        }
      }
      for (const client of Object.values(pool.clients)) {
        if (!client.supportedIdentityProviders) { client.supportedIdentityProviders = ["COGNITO"]; normalized = true; }
        if (!client.callbackUrls) { client.callbackUrls = []; normalized = true; }
        if (!client.logoutUrls) { client.logoutUrls = []; normalized = true; }
        if (!client.allowedOAuthFlows) { client.allowedOAuthFlows = []; normalized = true; }
        if (!client.allowedOAuthScopes) { client.allowedOAuthScopes = []; normalized = true; }
        if (client.allowedOAuthFlowsUserPoolClient === undefined) {
          client.allowedOAuthFlowsUserPoolClient = false;
          normalized = true;
        }
      }
      for (const [digest, code] of Object.entries(pool.authorizationCodes)) {
        if (
          code.status === "CONSUMED"
            ? now >= (code.consumedAt ?? code.expiresAt) + OAUTH_REPLAY_RETENTION_MS
            : now >= code.expiresAt + OAUTH_REPLAY_RETENTION_MS
        ) {
          delete pool.authorizationCodes[digest];
          normalized = true;
        }
      }
      for (const [digest, session] of Object.entries(pool.browserSessions)) {
        if (now >= session.expiresAt + OAUTH_REPLAY_RETENTION_MS) {
          delete pool.browserSessions[digest];
          normalized = true;
        }
      }
      for (const [digest, transaction] of Object.entries(pool.federationTransactions)) {
        if (
          transaction.status === "CONSUMED"
            ? now >= (transaction.consumedAt ?? transaction.expiresAt) + FEDERATION_REPLAY_RETENTION_MS
            : now >= transaction.expiresAt + FEDERATION_REPLAY_RETENTION_MS
        ) {
          delete pool.federationTransactions[digest];
          normalized = true;
        }
      }
      for (const [digest, expiresAt] of Object.entries(pool.federationReplayIds)) {
        if (now >= expiresAt) {
          delete pool.federationReplayIds[digest];
          normalized = true;
        }
      }
    }
    if (!this.state.domainIndex) { this.state.domainIndex = {}; normalized = true; }
    for (const [intentId, intent] of Object.entries(this.state.deliveryIntents)) {
      if (intent.status === "PENDING_DELIVERY") continue;
      const statusUpdatedAt = intent.statusUpdatedAt
        ?? (intent.status === "DELIVERED" ? intent.issuedAt : Math.max(intent.issuedAt, intent.expiresAt));
      if (now < statusUpdatedAt + INTENT_RETENTION_MS) continue;
      const user = this.state.pools[intent.poolId]?.usersBySub[intent.userSub];
      if (user?.activeConfirmationIntentId === intentId) {
        user.activeConfirmationIntentId = undefined;
        user.updatedAt = now;
      }
      delete this.state.deliveryIntents[intentId];
      normalized = true;
    }
    const admissionCutoff = now - ADMISSION_WINDOW_MS;
    for (const [key, bucket] of Object.entries(this.state.admissions)) {
      const timestamps = bucket.timestamps.filter(timestamp =>
        timestamp > admissionCutoff && timestamp <= now
      );
      if (timestamps.length === 0) {
        delete this.state.admissions[key];
        normalized = true;
      } else if (
        timestamps.length !== bucket.timestamps.length
        || timestamps.some((timestamp, index) => timestamp !== bucket.timestamps[index])
      ) {
        bucket.timestamps = timestamps;
        normalized = true;
      }
    }
    if (normalized) {
      this.state.revision += 1;
      await this.store.save();
    }
    const missing = Object.values(this.state.pools)
      .filter(pool => pool.signingKeys === undefined)
      .map(pool => pool.id);
    for (const poolId of missing) {
      const signingKeys = await generatePoolSigningKeys(
        this.secrets,
        this.store.accountId,
        this.region,
        poolId,
        this.clock.now(),
      );
      await this.exclusive(async () => {
        const pool = this.state.pools[poolId];
        if (!pool || pool.signingKeys) return;
        pool.signingKeys = signingKeys;
        pool.updatedAt = this.clock.now();
        this.state.revision += 1;
        await this.store.save();
      });
    }
  }

  async completePostBind(baseUrl?: string): Promise<void> {
    if (baseUrl) this.publicBaseUrl = validateCognitoPublicUrl(baseUrl);
    const pending = Object.values(this.state.deliveryIntents)
      .filter(intent => intent.status === "PENDING_DELIVERY")
      .sort((left, right) => left.issuedAt - right.issuedAt || left.id.localeCompare(right.id));
    for (const intent of pending.slice(0, 100)) {
      await this.deliverIntent(intent.id).catch(() => undefined);
    }
  }

  private async reconcilePendingPool(poolId: string): Promise<void> {
    const pending = Object.values(this.state.deliveryIntents)
      .filter(intent => intent.poolId === poolId && intent.status === "PENDING_DELIVERY")
      .sort((left, right) => left.issuedAt - right.issuedAt || left.id.localeCompare(right.id));
    for (const intent of pending.slice(0, 100)) {
      try {
        await this.deliverIntent(intent.id);
      } catch {
        throw new AwsError(
          "InternalErrorException",
          "Pending Cognito email delivery could not be reconciled for this user pool.",
          500,
        );
      }
    }
    if (Object.values(this.state.deliveryIntents).some(intent =>
      intent.poolId === poolId && intent.status === "PENDING_DELIVERY"
    )) {
      throw new AwsError(
        "InternalErrorException",
        "Pending Cognito email delivery reconciliation requires another bounded pass.",
        500,
      );
    }
  }

  private pool(value: unknown): CognitoUserPoolState {
    const id = userPoolId(value);
    const pool = this.state.pools[id];
    if (!pool) throw new AwsError("ResourceNotFoundException", "User pool not found.");
    return pool;
  }

  private appClient(pool: CognitoUserPoolState, value: unknown): CognitoAppClientState {
    const id = clientId(value);
    const client = pool.clients[id];
    if (!client) throw new AwsError("ResourceNotFoundException", "App client not found.");
    return client;
  }

  private appClientAcrossPools(value: unknown): { pool: CognitoUserPoolState; client: CognitoAppClientState } {
    const id = clientId(value);
    for (const pool of Object.values(this.state.pools)) {
      const client = pool.clients[id];
      if (client) return { pool, client };
    }
    throw new AwsError("ResourceNotFoundException", "App client not found.");
  }

  private adminUser(pool: CognitoUserPoolState, value: unknown): CognitoUserState {
    const username = modeledUsername(value);
    const direct = Object.values(pool.usersBySub).find(user => user.username === username);
    const user = direct ?? findUserByModeledUsername(pool, username);
    if (!user) throw new AwsError("UserNotFoundException", "User does not exist.");
    return user;
  }

  private parsedAttributes(
    pool: CognitoUserPoolState,
    value: unknown,
    options: { username?: string; allowVerified: boolean; requireEmail: boolean },
  ): Record<string, import("./types.js").CognitoUserAttributeState> {
    if (value === undefined) {
      if (options.username && pool.configuration.usernameAttributes.includes("email")) {
        const email = cognitoEmail(options.username);
        return { email: { value: email.value, verified: false } };
      }
      if (options.requireEmail) {
        throw new AwsError("InvalidParameterException", "The email attribute is required.");
      }
      return {};
    }
    if (!Array.isArray(value)) {
      throw new AwsError("InvalidParameterException", "UserAttributes must be an array.");
    }
    const attributes: Record<string, import("./types.js").CognitoUserAttributeState> = {};
    const verified: Record<string, boolean> = {};
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new AwsError("InvalidParameterException", "UserAttributes contains an invalid attribute.");
      }
      const keys = Object.keys(raw);
      if (keys.some(key => !["Name", "Value"].includes(key))) {
        throw new AwsError("InvalidParameterException", "UserAttributes contains an unsupported field.");
      }
      if (typeof raw.Name !== "string" || typeof raw.Value !== "string") {
        throw new AwsError("InvalidParameterException", "UserAttributes contains an invalid attribute.");
      }
      if (raw.Name === "sub") {
        throw new AwsError("InvalidParameterException", "The sub attribute is immutable.");
      }
      if (raw.Name.endsWith("_verified")) {
        const name = raw.Name.slice(0, -"_verified".length);
        if (!options.allowVerified || !["email", "phone_number"].includes(name) || !["true", "false"].includes(raw.Value)) {
          throw new AwsError("InvalidParameterException", `${raw.Name} cannot be set.`);
        }
        verified[name] = raw.Value === "true";
        continue;
      }
      const schemaName = raw.Name.startsWith("custom:") ? raw.Name.slice(7) : raw.Name;
      const schema = pool.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
      if (raw.Name !== "email" && !schema) {
        throw new AwsError("InvalidParameterException", `User attribute ${raw.Name} is not in the schema.`);
      }
      if (attributes[raw.Name]) {
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
    if (options.requireEmail && !attributes.email) {
      throw new AwsError("InvalidParameterException", "The email attribute is required.");
    }
    if (options.requireEmail) {
      for (const schema of pool.configuration.schemaAttributes) {
        const attributeName = schema.name === "email" ? "email" : `custom:${schema.name}`;
        if (schema.required && !attributes[attributeName]) {
          throw new AwsError("InvalidParameterException", `The ${attributeName} attribute is required.`);
        }
      }
    }
    return attributes;
  }

  private generatedPassword(pool: CognitoUserPoolState): string {
    const length = Math.max(16, pool.configuration.policies.passwordPolicy.minimumLength);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";
    let password = `Aa1!${randomAlphaNumeric(length - 4, alphabet)}`;
    while (Buffer.byteLength(password, "utf8") > 256) password = password.slice(0, -1);
    validatePasswordPolicy(password, pool.configuration.policies.passwordPolicy);
    return password;
  }

  private revokeUserSessions(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    reason: NonNullable<CognitoRefreshSessionState["revocationReason"]>,
  ): void {
    user.sessionEpoch += 1;
    user.updatedAt = this.clock.now();
    for (const session of Object.values(pool.refreshSessions)) {
      if (session.userSub === user.sub && session.status === "ACTIVE") {
        session.status = "REVOKED";
        session.revokedAt = this.clock.now();
        session.revocationReason = reason;
      }
    }
  }

  private removeUser(pool: CognitoUserPoolState, user: CognitoUserState): void {
    for (const identity of user.externalIdentities ?? []) {
      delete pool.federatedIdentityIndex[
        this.federatedIdentityKey(pool, identity.providerName, identity.providerSubject)
      ];
    }
    for (const [key, sub] of Object.entries(pool.usernameIndex)) {
      if (sub === user.sub) delete pool.usernameIndex[key];
    }
    for (const [key, sub] of Object.entries(pool.aliasIndex)) {
      if (sub === user.sub) delete pool.aliasIndex[key];
    }
    for (const session of Object.values(pool.refreshSessions)) {
      if (session.userSub === user.sub && session.status === "ACTIVE") {
        session.status = "REVOKED";
        session.revokedAt = this.clock.now();
        session.revocationReason = "USER_DELETED";
      }
    }
    for (const [sessionId, session] of Object.entries(pool.refreshSessions)) {
      if (session.userSub === user.sub) delete pool.refreshSessions[sessionId];
    }
    for (const [challengeId, challenge] of Object.entries(pool.challenges)) {
      if (challenge.userSub === user.sub) delete pool.challenges[challengeId];
    }
    for (const intent of Object.values(this.state.deliveryIntents)) {
      if (intent.poolId === pool.id && intent.userSub === user.sub && intent.status === "PENDING_DELIVERY") {
        intent.status = "CANCELLED";
        intent.statusUpdatedAt = this.clock.now();
        delete intent.credential.recoverableSecret;
      }
    }
    delete pool.usersBySub[user.sub];
    pool.updatedAt = this.clock.now();
  }

  private secretState(poolId: string, clientIdValue: string, value: string): CognitoRecoverableSecretState {
    const id = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const plaintext = Buffer.from(value, "utf8");
    try {
      const envelope = this.secrets.encrypt(plaintext, {
        purpose: "APP_CLIENT_SECRET",
        accountId: this.store.accountId,
        region: this.region,
        poolId,
        ownerId: clientIdValue,
        secretId: id,
        secretVersion: 1,
        field: "client-secret",
      });
      return { id, version: 1, envelope };
    } finally {
      plaintext.fill(0);
    }
  }

  private clientView(poolId: string, client: CognitoAppClientState): Record<string, unknown> {
    const primary = normalizedClientSecrets(client)[0];
    if (!primary) return clientView(poolId, client);
    const plaintext = this.secrets.decryptAppClientSecret(
      this.store.accountId,
      this.region,
      poolId,
      client.id,
      primary.envelope,
    );
    try {
      return clientView(poolId, client, plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  }

  private decryptClientSecretEntry(
    poolId: string,
    clientId: string,
    envelope: CognitoRecoverableSecretState,
  ): Buffer {
    return this.secrets.decryptAppClientSecret(
      this.store.accountId,
      this.region,
      poolId,
      clientId,
      envelope,
    );
  }

  private validateSecretHashAgainstSecrets(
    poolId: string,
    clientId: string,
    username: string,
    supplied: unknown,
    envelopes: CognitoRecoverableSecretState[],
  ): boolean {
    for (const envelope of envelopes) {
      const plaintext = this.decryptClientSecretEntry(poolId, clientId, envelope);
      try {
        if (verifyClientSecretHash(plaintext, username, clientId, supplied)) return true;
      } finally {
        plaintext.fill(0);
      }
    }
    return false;
  }

  private validateSecretHash(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    username: unknown,
    supplied: unknown,
  ): void {
    if (typeof username !== "string" || username.length < 1 || Buffer.byteLength(username, "utf8") > 128) {
      throw new AwsError("InvalidParameterException", "Username is invalid.");
    }
    if (!clientHasSecret(client)) {
      if (supplied !== undefined) {
        throw new AwsError("NotAuthorizedException", "Unable to verify app-client secret proof.");
      }
      return;
    }
    if (!this.validateSecretHashAgainstSecrets(
      pool.id,
      client.id,
      username,
      supplied,
      clientSecretEntries(client).map(entry => entry.envelope),
    )) {
      throw new AwsError("NotAuthorizedException", "Unable to verify app-client secret proof.");
    }
  }

  private validateDirectClientSecret(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    supplied: unknown,
  ): void {
    if (!clientHasSecret(client)) {
      if (supplied !== undefined) {
        throw new AwsError("NotAuthorizedException", "Unable to verify app-client secret proof.");
      }
      return;
    }
    for (const { envelope } of clientSecretEntries(client)) {
      if (this.secrets.verifyAppClientSecret(
        this.store.accountId,
        this.region,
        pool.id,
        client.id,
        envelope,
        supplied,
      )) {
        return;
      }
    }
    throw new AwsError("NotAuthorizedException", "Unable to verify app-client secret proof.");
  }

  private refreshSession(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    token: unknown,
    allowRevoked = false,
    allowRotationReplay = false,
  ): CognitoRefreshContext {
    let matched: CognitoRefreshSessionState | undefined;
    for (const session of Object.values(pool.refreshSessions)) {
      if (
        session.clientId === client.id
        && this.secrets.verifyRefreshToken(token, session.tokenDigest, {
          accountId: this.store.accountId,
          region: this.region,
          poolId: pool.id,
          clientId: client.id,
        })
      ) {
        matched = session;
        break;
      }
    }
    const user = matched ? pool.usersBySub[matched.userSub] : undefined;
    const rotationGrace = Boolean(
      matched
      && client.refreshTokenRotation.feature === "ENABLED"
      && matched.status === "REVOKED"
      && matched.revocationReason === "ROTATED"
      && matched.rotationGraceUntil !== undefined
      && this.clock.now() <= matched.rotationGraceUntil
    );
    const rotationReplay = Boolean(
      matched
      && allowRotationReplay
      && client.refreshTokenRotation.feature === "ENABLED"
      && matched.status === "REVOKED"
      && matched.revocationReason === "ROTATED"
      && matched.rotationGraceUntil !== undefined
      && this.clock.now() > matched.rotationGraceUntil
    );
    if (
      !matched
      || !user
      || user.generationId !== matched.userGenerationId
      || user.sessionEpoch !== matched.sessionEpoch
      || !user.enabled
      || !tokenEligibleUser(user)
      || !allowRevoked && (
        matched.status !== "ACTIVE" && !rotationGrace && !rotationReplay
        || this.clock.now() >= matched.expiresAt
      )
    ) {
      throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
    }
    return { pool, client, user, session: matched };
  }

  private validateRefreshProof(
    input: Record<string, any>,
    source: "InitiateAuth" | "GetTokensFromRefreshToken" | "RevokeToken",
  ): void {
    const { pool, client } = this.appClientAcrossPools(input.ClientId);
    if (
      source === "InitiateAuth"
      && (
        client.refreshTokenRotation.feature === "ENABLED"
        || !client.explicitAuthFlows.includes("ALLOW_REFRESH_TOKEN_AUTH")
      )
    ) {
      throw new AwsError("InvalidParameterException", "REFRESH_TOKEN_AUTH is not enabled for this app client.");
    }
    if (
      source === "GetTokensFromRefreshToken"
      && client.refreshTokenRotation.feature !== "ENABLED"
      && !client.explicitAuthFlows.includes("ALLOW_REFRESH_TOKEN_AUTH")
    ) {
      throw new AwsError("InvalidParameterException", "Refresh-token authentication is not enabled for this app client.");
    }
    const token = source === "InitiateAuth"
      ? input.AuthParameters?.REFRESH_TOKEN
      : source === "GetTokensFromRefreshToken"
        ? input.RefreshToken
        : input.Token;
    const context = this.refreshSession(
      pool,
      client,
      token,
      source === "RevokeToken",
      source === "GetTokensFromRefreshToken",
    );
    if (source === "InitiateAuth") {
      this.validateSecretHash(
        pool,
        client,
        context.session.secretHashUsername,
        input.AuthParameters?.SECRET_HASH,
      );
    }
    this.refreshProof.set(input, context);
  }

  private validateAccessProof(input: Record<string, any>, requiredScope: string | false = COGNITO_USER_ADMIN_SCOPE): void {
    let verified;
    try {
      verified = verifyCognitoAccessToken(
        input.AccessToken,
        this.state.pools,
        this.region,
        this.clock.now(),
        { requiredScope },
      );
    } catch {
      throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    }
    const client = verified.pool.clients[verified.claims.clientId];
    const user = verified.pool.usersBySub[verified.claims.sub];
    const session = Object.values(verified.pool.refreshSessions)
      .find(candidate => candidate.eventId === verified.claims.eventId);
    if (
      !client
      || !user
      || !session
      || session.clientId !== client.id
      || session.userSub !== user.sub
      || session.userGenerationId !== user.generationId
      || session.sessionEpoch !== user.sessionEpoch
      || session.status !== "ACTIVE"
      || !user.enabled
      || !tokenEligibleUser(user)
      || verified.claims.username !== user.username
      || client.enableTokenRevocation && (
        !verified.claims.jti
        || verified.claims.originJti !== session.originJti
      )
      || !client.enableTokenRevocation && (
        verified.claims.jti !== undefined
        || verified.claims.originJti !== undefined
      )
    ) {
      throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    }
    this.accessProof.set(input, {
      pool: verified.pool,
      client,
      user,
      session,
      claims: verified.claims,
    });
  }

  private validateChallengeProof(input: Record<string, any>): void {
    if (
      typeof input.Session !== "string"
      || input.Session.length < 20
      || input.Session.length > 2_048
      || typeof input.ClientId !== "string"
    ) {
      throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
    }
    const { pool, client } = this.appClientAcrossPools(input.ClientId);
    const challenge = pool.challenges[input.Session];
    const user = challenge ? pool.usersBySub[challenge.userSub] : undefined;
    if (
      !challenge
      || !user
      || challenge.status !== "ACTIVE"
      || challenge.clientId !== client.id
      || challenge.userGenerationId !== user.generationId
      || this.clock.now() >= challenge.expiresAt
      || !user.enabled
    ) {
      throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
    }
    const responses = input.ChallengeResponses;
    if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
      throw new AwsError("InvalidParameterException", "ChallengeResponses is required.");
    }
    const username = responses.USERNAME;
    if (typeof username !== "string") {
      throw new AwsError("InvalidParameterException", "USERNAME is required.");
    }
    const resolved = this.adminUser(pool, username);
    if (resolved.sub !== user.sub) {
      throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
    }
    this.validateSecretHash(pool, client, username, responses.SECRET_HASH);
    this.challengeProof.set(input, { pool, client, user, challenge });
  }

  private challengeBySession(sessionValue: unknown): {
    pool: CognitoUserPoolState;
    client: CognitoAppClientState;
    user: CognitoUserState;
    challenge: import("./types.js").CognitoChallengeState;
  } {
    if (typeof sessionValue !== "string" || sessionValue.length < 20 || sessionValue.length > 2_048) {
      throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
    }
    for (const pool of Object.values(this.state.pools)) {
      const challenge = pool.challenges[sessionValue];
      if (!challenge) continue;
      const client = pool.clients[challenge.clientId];
      const user = pool.usersBySub[challenge.userSub];
      if (
        client
        && user
        && challenge.status === "ACTIVE"
        && challenge.userGenerationId === user.generationId
        && this.clock.now() < challenge.expiresAt
        && user.enabled
      ) {
        return { pool, client, user, challenge };
      }
    }
    throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
  }

  private async admit(
    kind: "SIGN_UP" | "PASSWORD" | "REFRESH",
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    value: string,
    maximum: number,
  ): Promise<void> {
    const key = this.secrets.admissionKey(kind, {
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      clientId: client.id,
    }, value);
    await this.exclusive(async () => {
      const now = this.clock.now();
      const cutoff = now - ADMISSION_WINDOW_MS;
      const existing = this.state.admissions[key];
      const timestamps = (existing?.timestamps ?? []).filter(timestamp => timestamp > cutoff && timestamp <= now);
      if (timestamps.length >= maximum) {
        if (existing) existing.timestamps = timestamps;
        throw new AwsError("TooManyRequestsException", "Too many Cognito requests. Try again later.");
      }
      timestamps.push(now);
      this.state.admissions[key] = {
        kind,
        poolId: pool.id,
        clientId: client.id,
        timestamps,
      };
      this.state.revision += 1;
      await this.store.save();
    });
  }

  private async validateProof(operation: string, input: Record<string, any>): Promise<void> {
    switch (operation) {
      case "SignUp": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        this.validateSecretHash(pool, client, input.Username, input.SecretHash);
        const parsed = parseSignUp(input, pool, client);
        await this.reconcilePendingPool(pool.id);
        await this.admit("SIGN_UP", pool, client, parsed.email.canonical, 10);
        return;
      }
      case "ConfirmSignUp": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        this.validateSecretHash(pool, client, input.Username, input.SecretHash);
        return;
      }
      case "ResendConfirmationCode": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        this.validateSecretHash(pool, client, input.Username, input.SecretHash);
        await this.reconcilePendingPool(pool.id);
        return;
      }
      case "ForgotPassword":
      case "ConfirmForgotPassword": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        this.validateSecretHash(pool, client, input.Username, input.SecretHash);
        if (operation === "ForgotPassword") await this.reconcilePendingPool(pool.id);
        return;
      }
      case "InitiateAuth": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        if (input.AuthFlow === "USER_PASSWORD_AUTH") {
          const parameters = input.AuthParameters;
          if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
            throw new AwsError("InvalidParameterException", "AuthParameters is required.");
          }
          this.validateSecretHash(pool, client, parameters.USERNAME, parameters.SECRET_HASH);
          const usernameKey = pool.configuration.usernameAttributes.includes("email")
            ? cognitoEmail(parameters.USERNAME).canonical
            : canonicalUsername(pool, modeledUsername(parameters.USERNAME));
          await this.admit("PASSWORD", pool, client, usernameKey, 10);
        } else if (input.AuthFlow === "USER_SRP_AUTH") {
          const parameters = input.AuthParameters;
          if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
            throw new AwsError("InvalidParameterException", "AuthParameters is required.");
          }
          this.validateSecretHash(pool, client, parameters.USERNAME, parameters.SECRET_HASH);
          const usernameKey = pool.configuration.usernameAttributes.includes("email")
            ? cognitoEmail(parameters.USERNAME).canonical
            : canonicalUsername(pool, modeledUsername(parameters.USERNAME));
          await this.admit("PASSWORD", pool, client, usernameKey, 10);
        } else if (input.AuthFlow === "REFRESH_TOKEN_AUTH") {
          if (typeof input.AuthParameters?.REFRESH_TOKEN === "string") {
            await this.admit("REFRESH", pool, client, input.AuthParameters.REFRESH_TOKEN, 30);
          }
          this.validateRefreshProof(input, "InitiateAuth");
        }
        return;
      }
      case "AdminInitiateAuth": {
        const pool = this.pool(input.UserPoolId);
        const client = this.appClient(pool, input.ClientId);
        this.validateSecretHash(
          pool,
          client,
          input.AuthParameters?.USERNAME,
          input.AuthParameters?.SECRET_HASH,
        );
        return;
      }
      case "GetTokensFromRefreshToken": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        this.validateDirectClientSecret(pool, client, input.ClientSecret);
        if (typeof input.RefreshToken === "string") {
          await this.admit("REFRESH", pool, client, input.RefreshToken, 30);
        }
        this.validateRefreshProof(input, "GetTokensFromRefreshToken");
        return;
      }
      case "RevokeToken": {
        const { pool, client } = this.appClientAcrossPools(input.ClientId);
        this.validateDirectClientSecret(pool, client, input.ClientSecret);
        this.validateRefreshProof(input, "RevokeToken");
        return;
      }
      case "GetUser":
      case "GlobalSignOut":
      case "ChangePassword":
      case "DeleteUser":
      case "DeleteUserAttributes":
      case "GetUserAttributeVerificationCode":
      case "GetUserAuthFactors":
      case "UpdateUserAttributes":
      case "VerifyUserAttribute":
      case "ListDevices":
      case "GetDevice":
      case "ForgetDevice":
      case "ConfirmDevice":
      case "SetUserMFAPreference":
      case "SetUserSettings":
      case "UpdateDeviceStatus":
      case "UpdateAuthEventFeedback": {
        this.validateAccessProof(input);
        return;
      }
      case "RespondToAuthChallenge":
      case "AdminRespondToAuthChallenge": {
        this.validateChallengeProof(input);
        return;
      }
      case "AssociateSoftwareToken":
      case "VerifySoftwareToken": {
        if (input.AccessToken !== undefined) {
          this.validateAccessProof(input);
        } else {
          this.challengeBySession(input.Session);
        }
        return;
      }
      default:
        return;
    }
  }

  private confirmationBinding(intent: CognitoDeliveryIntentState) {
    return {
      accountId: intent.accountId,
      region: intent.region,
      poolId: intent.poolId,
      clientId: intent.clientId,
      userSub: intent.userSub,
      userGenerationId: intent.userGenerationId,
      intentId: intent.id,
      purpose: intent.purpose,
      issuedAt: intent.issuedAt,
      expiresAt: intent.expiresAt,
    };
  }

  private renderedIntent(intent: CognitoDeliveryIntentState): {
    subject: string;
    text: string;
    canonical: Buffer;
  } {
    let credential: Buffer | undefined;
    try {
      const code = intent.purpose === "ADMIN_INVITATION"
        ? (() => {
            const secret = intent.credential.recoverableSecret;
            if (!secret) throw new Error("Cognito invitation password is unavailable.");
            credential = this.secrets.decrypt(secret.envelope, {
              purpose: "INVITATION_PASSWORD",
              accountId: intent.accountId,
              region: intent.region,
              poolId: intent.poolId,
              ownerId: intent.userSub,
              secretId: secret.id,
              secretVersion: secret.version,
              field: "temporary-password",
            });
            return credential.toString("utf8");
          })()
        : this.secrets.confirmationCode(this.confirmationBinding(intent));
      const replace = (template: string): string => template
        .replaceAll("{####}", code)
        .replaceAll("{username}", intent.message.safeVariables.username);
      const subject = replace(intent.message.subjectTemplate);
      const text = replace(intent.message.textTemplate);
      return {
        subject,
        text,
        canonical: canonicalDeliveryContent([
          "1",
          intent.message.deliveryProfile,
          intent.message.sourceArn ?? "",
          intent.message.source,
          intent.message.configurationSetName ?? "",
          intent.message.destination,
          intent.message.replyTo ?? "",
          subject,
          text,
        ]),
      };
    } finally {
      credential?.fill(0);
    }
  }

  private newDeliveryIntent(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    purpose: CognitoDeliveryIntentState["purpose"],
  ): CognitoDeliveryIntentState {
    const issuedAt = this.clock.now();
    const intent: CognitoDeliveryIntentState = {
      id: randomBytes(16).toString("base64url"),
      purpose,
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      clientId: client.id,
      userSub: user.sub,
      userGenerationId: user.generationId,
      credential: { kind: "DERIVED_CODE", derivationVersion: 1, codeDigest: "" },
      message: {
        deliveryProfile: pool.configuration.emailConfiguration.emailSendingAccount,
        ...(pool.configuration.emailConfiguration.sourceArn
          ? { sourceArn: pool.configuration.emailConfiguration.sourceArn }
          : {}),
        source: pool.configuration.emailConfiguration.emailSendingAccount === "DEVELOPER"
          ? pool.configuration.emailConfiguration.from!
          : "no-reply@verificationemail.com",
        destination: user.attributes.email.value,
        ...(pool.configuration.emailConfiguration.replyToEmailAddress
          ? { replyTo: pool.configuration.emailConfiguration.replyToEmailAddress }
          : {}),
        ...(pool.configuration.emailConfiguration.configurationSet
          ? { configurationSetName: pool.configuration.emailConfiguration.configurationSet }
          : {}),
        subjectTemplate: purpose === "PASSWORD_RESET"
          ? "Reset your password"
          : purpose === "ATTRIBUTE_VERIFICATION"
            ? "Verify your email"
            : purpose === "EMAIL_MFA"
              ? pool.configuration.emailMfaConfiguration?.subject ?? "Your sign-in code"
              : pool.configuration.verificationMessageTemplate.emailSubject,
        textTemplate: purpose === "PASSWORD_RESET"
          ? "Your password reset code is {####}."
          : purpose === "ATTRIBUTE_VERIFICATION"
            ? "Your email verification code is {####}."
            : purpose === "EMAIL_MFA"
              ? pool.configuration.emailMfaConfiguration?.message ?? "Your sign-in code is {####}."
              : pool.configuration.verificationMessageTemplate.emailMessage,
        templateVersion: "1",
        safeVariables: {
          username: user.username,
          ...(purpose === "ATTRIBUTE_VERIFICATION" ? { attributeName: "email" } : {}),
        },
        renderedContentMac: "",
      },
      deliveryKey: randomBytes(32).toString("base64url"),
      issuedAt,
      expiresAt: issuedAt + CONFIRMATION_LIFETIME_MS,
      attempts: 0,
      status: "PENDING_DELIVERY",
      statusUpdatedAt: issuedAt,
      sesMessageId: randomUUID(),
    };
    const binding = this.confirmationBinding(intent);
    const code = this.secrets.confirmationCode(binding);
    intent.credential.codeDigest = this.secrets.confirmationCodeDigest(code, binding);
    const rendered = this.renderedIntent(intent);
    try {
      intent.message.renderedContentMac = this.secrets.renderedContentMac(rendered.canonical, binding);
    } finally {
      rendered.canonical.fill(0);
    }
    return intent;
  }

  private async applyCustomMessage(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    intent: CognitoDeliveryIntentState,
    clientMetadata: Record<string, string> = {},
  ): Promise<void> {
    const source = ({
      SIGN_UP: "CustomMessage_SignUp",
      RESEND_SIGN_UP: "CustomMessage_ResendCode",
      PASSWORD_RESET: "CustomMessage_ForgotPassword",
      ATTRIBUTE_VERIFICATION: "CustomMessage_UpdateUserAttribute",
      ADMIN_INVITATION: "CustomMessage_AdminCreateUser",
      EMAIL_MFA: "CustomMessage_Authentication",
    } as const)[intent.purpose];
    const response = await this.invokeTrigger(pool, client, user, "customMessage", source, {
      codeParameter: "{####}",
      usernameParameter: "{username}",
      clientMetadata,
    });
    if (!response) return;
    if (response.emailSubject !== undefined) {
      if (typeof response.emailSubject !== "string" || response.emailSubject.length < 1 || response.emailSubject.length > 140) {
        throw new AwsError("InvalidLambdaResponseException", "Custom message emailSubject is invalid.");
      }
      intent.message.subjectTemplate = response.emailSubject;
    }
    if (response.emailMessage !== undefined) {
      if (
        typeof response.emailMessage !== "string"
        || response.emailMessage.length > 20_000
        || !response.emailMessage.includes("{####}")
      ) {
        throw new AwsError("InvalidLambdaResponseException", "Custom message emailMessage is invalid.");
      }
      intent.message.textTemplate = response.emailMessage;
    }
    const rendered = this.renderedIntent(intent);
    try {
      intent.message.renderedContentMac = this.secrets.renderedContentMac(
        rendered.canonical,
        this.confirmationBinding(intent),
      );
    } finally {
      rendered.canonical.fill(0);
    }
  }

  private newAdminInvitationIntent(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    temporaryPassword: string,
  ): CognitoDeliveryIntentState {
    const issuedAt = this.clock.now();
    const intentId = randomBytes(16).toString("base64url");
    const secretId = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const plaintext = Buffer.from(temporaryPassword, "utf8");
    let recoverableSecret: CognitoRecoverableSecretState;
    try {
      recoverableSecret = {
        id: secretId,
        version: 1,
        envelope: this.secrets.encrypt(plaintext, {
          purpose: "INVITATION_PASSWORD",
          accountId: this.store.accountId,
          region: this.region,
          poolId: pool.id,
          ownerId: user.sub,
          secretId,
          secretVersion: 1,
          field: "temporary-password",
        }),
      };
    } finally {
      plaintext.fill(0);
    }
    const intent: CognitoDeliveryIntentState = {
      id: intentId,
      purpose: "ADMIN_INVITATION",
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      clientId: "ADMIN_CREATE_USER",
      userSub: user.sub,
      userGenerationId: user.generationId,
      credential: {
        kind: "DERIVED_CODE",
        derivationVersion: 1,
        codeDigest: this.secrets.confirmationCodeDigest(
          this.secrets.confirmationCode({
            accountId: this.store.accountId,
            region: this.region,
            poolId: pool.id,
            clientId: "ADMIN_CREATE_USER",
            userSub: user.sub,
            userGenerationId: user.generationId,
            intentId,
            purpose: "ADMIN_INVITATION",
            issuedAt,
            expiresAt: issuedAt + CONFIRMATION_LIFETIME_MS,
          }),
          {
            accountId: this.store.accountId,
            region: this.region,
            poolId: pool.id,
            clientId: "ADMIN_CREATE_USER",
            userSub: user.sub,
            userGenerationId: user.generationId,
            intentId,
            purpose: "ADMIN_INVITATION",
            issuedAt,
            expiresAt: issuedAt + CONFIRMATION_LIFETIME_MS,
          },
        ),
        recoverableSecret,
      },
      message: {
        deliveryProfile: pool.configuration.emailConfiguration.emailSendingAccount,
        ...(pool.configuration.emailConfiguration.sourceArn
          ? { sourceArn: pool.configuration.emailConfiguration.sourceArn }
          : {}),
        source: pool.configuration.emailConfiguration.emailSendingAccount === "DEVELOPER"
          ? pool.configuration.emailConfiguration.from!
          : "no-reply@verificationemail.com",
        destination: user.attributes.email.value,
        ...(pool.configuration.emailConfiguration.replyToEmailAddress
          ? { replyTo: pool.configuration.emailConfiguration.replyToEmailAddress }
          : {}),
        ...(pool.configuration.emailConfiguration.configurationSet
          ? { configurationSetName: pool.configuration.emailConfiguration.configurationSet }
          : {}),
        subjectTemplate: pool.configuration.adminCreateUserConfig.inviteMessageTemplate.emailSubject,
        textTemplate: pool.configuration.adminCreateUserConfig.inviteMessageTemplate.emailMessage,
        templateVersion: "1",
        safeVariables: { username: user.username },
        renderedContentMac: "",
      },
      deliveryKey: randomBytes(32).toString("base64url"),
      issuedAt,
      expiresAt: user.temporaryPasswordExpiresAt ?? (
        issuedAt + pool.configuration.policies.passwordPolicy.temporaryPasswordValidityDays * 86_400_000
      ),
      attempts: 0,
      status: "PENDING_DELIVERY",
      statusUpdatedAt: issuedAt,
      sesMessageId: randomUUID(),
    };
    const binding = this.confirmationBinding(intent);
    const rendered = this.renderedIntent(intent);
    try {
      intent.message.renderedContentMac = this.secrets.renderedContentMac(rendered.canonical, binding);
    } finally {
      rendered.canonical.fill(0);
    }
    return intent;
  }

  private createChallenge(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    purpose: import("./types.js").CognitoChallengeState["purpose"],
    clientMetadata: Record<string, string> = {},
  ): import("./types.js").CognitoChallengeState {
    const session = randomBytes(32).toString("base64url");
    const challenge: import("./types.js").CognitoChallengeState = {
      id: session,
      purpose,
      poolId: pool.id,
      clientId: client.id,
      userSub: user.sub,
      userGenerationId: user.generationId,
      createdAt: this.clock.now(),
      expiresAt: this.clock.now() + client.authSessionValidity * 60_000,
      attempts: 0,
      status: "ACTIVE",
      ...(Object.keys(clientMetadata).length ? { clientMetadata: { ...clientMetadata } } : {}),
    };
    pool.challenges[session] = challenge;
    return challenge;
  }

  private wrapDeviceVerifier(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    deviceKey: string,
    passwordVerifier: string,
    salt: string,
  ): {
    passwordVerifier: CognitoRecoverableSecretState;
    salt: CognitoRecoverableSecretState;
  } {
    const verifierId = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const saltId = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const verifierBytes = Buffer.from(passwordVerifier, "utf8");
    const saltBytes = Buffer.from(salt, "utf8");
    try {
      return {
        passwordVerifier: {
          id: verifierId,
          version: 1,
          envelope: this.secrets.encrypt(verifierBytes, {
            purpose: "DEVICE_PASSWORD_VERIFIER",
            accountId: this.store.accountId,
            region: this.region,
            poolId: pool.id,
            ownerId: user.sub,
            secretId: verifierId,
            secretVersion: 1,
            field: `device:${deviceKey}:password-verifier`,
          }),
        },
        salt: {
          id: saltId,
          version: 1,
          envelope: this.secrets.encrypt(saltBytes, {
            purpose: "DEVICE_SALT",
            accountId: this.store.accountId,
            region: this.region,
            poolId: pool.id,
            ownerId: user.sub,
            secretId: saltId,
            secretVersion: 1,
            field: `device:${deviceKey}:salt`,
          }),
        },
      };
    } finally {
      verifierBytes.fill(0);
      saltBytes.fill(0);
    }
  }

  private readDeviceVerifier(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    device: CognitoDeviceState,
  ): { passwordVerifier: string; salt: string } {
    if (device.passwordVerifier && device.salt) {
      const passwordVerifier = this.secrets.decrypt(device.passwordVerifier.envelope, {
        purpose: "DEVICE_PASSWORD_VERIFIER",
        accountId: this.store.accountId,
        region: this.region,
        poolId: pool.id,
        ownerId: user.sub,
        secretId: device.passwordVerifier.id,
        secretVersion: device.passwordVerifier.version,
        field: `device:${device.key}:password-verifier`,
      }).toString("utf8");
      const salt = this.secrets.decrypt(device.salt.envelope, {
        purpose: "DEVICE_SALT",
        accountId: this.store.accountId,
        region: this.region,
        poolId: pool.id,
        ownerId: user.sub,
        secretId: device.salt.id,
        secretVersion: device.salt.version,
        field: `device:${device.key}:salt`,
      }).toString("utf8");
      return { passwordVerifier, salt };
    }
    if (device.secretVerifier) {
      return {
        passwordVerifier: device.secretVerifier.passwordVerifier,
        salt: device.secretVerifier.salt,
      };
    }
    throw new AwsError("NotAuthorizedException", "Device credentials are invalid.");
  }

  private attachNewDeviceMetadata(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    session: CognitoRefreshSessionState,
    result: Record<string, unknown>,
    deviceKey?: string,
  ): void {
    if (!deviceTrackingEnabled(pool.configuration) || deviceKey) return;
    purgeExpiredPendingDevices(user, this.clock.now());
    const pending = createPendingDevice({
      region: this.region,
      client,
      eventId: session.eventId,
      now: this.clock.now(),
    });
    ensurePendingDevices(user)[pending.key] = pending;
    result.NewDeviceMetadata = {
      DeviceKey: pending.key,
      DeviceGroupKey: pending.groupKey,
    };
  }

  private rememberedDeviceForAuth(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    deviceKey: string | undefined,
  ): CognitoDeviceState | undefined {
    if (
      !deviceKey
      || !pool.configuration.deviceConfiguration?.challengeRequiredOnNewDevice
    ) {
      return undefined;
    }
    const device = user.devices[deviceKey];
    if (
      !device
      || device.rememberedStatus !== "remembered"
      || (!device.passwordVerifier && !device.secretVerifier)
      || (!device.salt && !device.secretVerifier)
    ) {
      return undefined;
    }
    return device;
  }

  private async authenticationStep(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    clientMetadata: Record<string, string> = {},
    deviceKey?: string,
  ): Promise<CognitoAuthenticationStep> {
    purgeExpiredPendingDevices(user, this.clock.now());
    if (this.rememberedDeviceForAuth(pool, user, deviceKey)) {
      const challenge = this.createChallenge(pool, client, user, "DEVICE_SRP_AUTH", clientMetadata);
      challenge.deviceKey = deviceKey;
      return {
        response: {
          ChallengeName: "DEVICE_SRP_AUTH",
          Session: challenge.id,
          ChallengeParameters: {
            USERNAME: user.username,
            DEVICE_KEY: deviceKey!,
          },
        },
      };
    }
    const enabled = user.userMfaSettingList.filter(method =>
      pool.configuration.enabledMfas.includes(method)
    );
    let selected = user.preferredMfaSetting && enabled.includes(user.preferredMfaSetting)
      ? user.preferredMfaSetting
      : enabled[0];
    if (
      !selected
      && pool.configuration.mfaConfiguration === "ON"
      && pool.configuration.enabledMfas.includes("EMAIL_OTP")
      && user.attributes.email?.verified
    ) {
      selected = "EMAIL_OTP";
    }
    if (selected === "SOFTWARE_TOKEN_MFA") {
      const challenge = this.createChallenge(pool, client, user, "SOFTWARE_TOKEN_MFA", clientMetadata);
      challenge.deviceKey = deviceKey;
      return {
        response: {
          ChallengeName: "SOFTWARE_TOKEN_MFA",
          Session: challenge.id,
          ChallengeParameters: { USER_ID_FOR_SRP: user.username },
        },
      };
    }
    if (selected === "EMAIL_OTP") {
      const intent = this.newDeliveryIntent(pool, client, user, "EMAIL_MFA");
      await this.applyCustomMessage(pool, client, user, intent);
      const challenge = this.createChallenge(pool, client, user, "EMAIL_OTP", clientMetadata);
      challenge.deliveryIntentId = intent.id;
      challenge.deviceKey = deviceKey;
      this.state.deliveryIntents[intent.id] = intent;
      return {
        response: {
          ChallengeName: "EMAIL_OTP",
          Session: challenge.id,
          ChallengeParameters: {
            USER_ID_FOR_SRP: user.username,
            CODE_DELIVERY_DELIVERY_MEDIUM: "EMAIL",
            CODE_DELIVERY_DESTINATION: maskEmail(user.attributes.email!.value),
          },
        },
        deliveryIntentId: intent.id,
      };
    }
    if (pool.configuration.mfaConfiguration === "ON") {
      const challenge = this.createChallenge(pool, client, user, "MFA_SETUP", clientMetadata);
      challenge.deviceKey = deviceKey;
      return {
        response: {
          ChallengeName: "MFA_SETUP",
          Session: challenge.id,
          ChallengeParameters: {
            USER_ID_FOR_SRP: user.username,
            MFAS_CAN_SETUP: JSON.stringify(
              pool.configuration.enabledMfas.filter(value => value === "SOFTWARE_TOKEN_MFA"),
            ),
          },
        },
      };
    }
    const created = this.newRefreshSession(pool, client, user);
    const result = await this.authenticationResult(
      pool,
      client,
      user,
      created.session,
      created.token,
      clientMetadata,
    );
    this.attachNewDeviceMetadata(pool, client, user, created.session, result, deviceKey);
    pool.refreshSessions[created.session.id] = created.session;
    pool.authEvents.push({
      eventId: created.session.eventId,
      userSub: user.sub,
      createdAt: this.clock.now(),
      eventType: "SignIn",
    });
    if (pool.authEvents.length > AUDIT_LIMIT) pool.authEvents.splice(0, pool.authEvents.length - AUDIT_LIMIT);
    return {
      response: {
        AuthenticationResult: result,
      },
      postAuthentication: {
        poolId: pool.id,
        clientId: client.id,
        userSub: user.sub,
        sessionId: created.session.id,
        eventId: created.session.eventId,
        clientMetadata: { ...clientMetadata },
      },
    };
  }

  private async deliverAuthenticationStep(step: CognitoAuthenticationStep): Promise<Record<string, unknown>> {
    if (step.deliveryIntentId) {
      try {
        await this.deliverIntent(step.deliveryIntentId);
      } catch {
        throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the MFA code.");
      }
    }
    if (step.postAuthentication) {
      await this.postAuthentication(step.postAuthentication);
    }
    return step.response;
  }

  private async postAuthentication(context: NonNullable<CognitoAuthenticationStep["postAuthentication"]>): Promise<void> {
    const pool = this.pool(context.poolId);
    const client = this.appClient(pool, context.clientId);
    const user = pool.usersBySub[context.userSub];
    if (!user) return;
    try {
      await this.invokeTrigger(
        pool,
        client,
        user,
        "postAuthentication",
        "PostAuthentication_Authentication",
        { clientMetadata: context.clientMetadata },
      );
    } catch (error) {
      await this.exclusive(async () => {
        const current = this.pool(context.poolId);
        delete current.refreshSessions[context.sessionId];
        current.authEvents = current.authEvents.filter(event => event.eventId !== context.eventId);
        this.state.revision += 1;
        await this.store.save();
      });
      throw error;
    }
  }

  private deliverIntent(intentId: string): Promise<void> {
    const existing = this.deliveryWork.get(intentId);
    if (existing) return existing;
    const work = this.performDelivery(intentId).finally(() => {
      if (this.deliveryWork.get(intentId) === work) this.deliveryWork.delete(intentId);
    });
    this.deliveryWork.set(intentId, work);
    return work;
  }

  private async performDelivery(intentId: string): Promise<void> {
    const stored = this.state.deliveryIntents[intentId];
    if (!stored || stored.status !== "PENDING_DELIVERY") return;
    const intent = structuredClone(stored);
    const pool = this.state.pools[intent.poolId];
    const user = pool?.usersBySub[intent.userSub];
    const eligible = intent.purpose === "ADMIN_INVITATION"
      ? user?.status === "FORCE_CHANGE_PASSWORD"
      : intent.purpose === "SIGN_UP" || intent.purpose === "RESEND_SIGN_UP"
        ? user?.status === "UNCONFIRMED"
        : user !== undefined && ["CONFIRMED", "RESET_REQUIRED"].includes(user.status);
    if (!pool || !user || user.generationId !== intent.userGenerationId || !eligible) {
      await this.exclusive(async () => {
        const current = this.state.deliveryIntents[intentId];
        if (current?.status === "PENDING_DELIVERY") {
          current.status = "CANCELLED";
          current.statusUpdatedAt = this.clock.now();
          this.state.revision += 1;
          await this.store.save();
        }
      });
      return;
    }
    const binding = this.confirmationBinding(intent);
    const rendered = this.renderedIntent(intent);
    const deliveryStartedAt = this.clock.now();
    const deliveryOperation = ({
      ADMIN_INVITATION: "AdminCreateUser",
      SIGN_UP: "SignUp",
      RESEND_SIGN_UP: "ResendConfirmationCode",
      PASSWORD_RESET: "ForgotPassword",
      ATTRIBUTE_VERIFICATION: "GetUserAttributeVerificationCode",
      EMAIL_MFA: "InitiateAuth",
    } as const)[intent.purpose];
    try {
      if (!this.secrets.verifyRenderedContentMac(rendered.canonical, intent.message.renderedContentMac, binding)) {
        throw new Error("Cognito delivery content could not be authenticated.");
      }
      const result = await this.ses.sendInternal({
        messageId: intent.sesMessageId,
        acceptedAt: intent.issuedAt,
        FromEmailAddress: intent.message.source,
        ...(intent.message.sourceArn
          ? { FromEmailAddressIdentityArn: intent.message.sourceArn }
          : {}),
        Destination: { ToAddresses: [intent.message.destination] },
        Content: {
          Simple: {
            Subject: { Data: rendered.subject, Charset: "UTF-8" },
            Body: { Text: { Data: rendered.text, Charset: "UTF-8" } },
          },
        },
        ...(intent.message.replyTo ? { ReplyToAddresses: [intent.message.replyTo] } : {}),
        ...(intent.message.configurationSetName ? { ConfigurationSetName: intent.message.configurationSetName } : {}),
      }, {
        servicePrincipal: "cognito-idp.amazonaws.com",
        originService: "cognito-idp",
        producerDeliveryKey: intent.deliveryKey,
        deliveryProfile: intent.message.deliveryProfile,
      });
      if (result.MessageId !== intent.sesMessageId) {
        throw new Error("SES returned an inconsistent producer message ID.");
      }
      await this.exclusive(async () => {
        const current = this.state.deliveryIntents[intentId];
        const currentPool = this.state.pools[intent.poolId];
        const currentUser = currentPool?.usersBySub[intent.userSub];
        if (!current || current.status !== "PENDING_DELIVERY") return;
        if (
          !currentUser
          || currentUser.generationId !== intent.userGenerationId
          || (
            intent.purpose === "ADMIN_INVITATION"
              ? currentUser.status !== "FORCE_CHANGE_PASSWORD"
              : intent.purpose === "SIGN_UP" || intent.purpose === "RESEND_SIGN_UP"
                ? currentUser.status !== "UNCONFIRMED"
                : !["CONFIRMED", "RESET_REQUIRED"].includes(currentUser.status)
          )
        ) {
          current.status = "CANCELLED";
          current.statusUpdatedAt = this.clock.now();
        } else {
          if (intent.purpose === "ADMIN_INVITATION") {
            delete current.credential.recoverableSecret;
          } else if (intent.purpose === "PASSWORD_RESET") {
            const previousId = currentUser.activePasswordResetIntentId;
            if (previousId && previousId !== current.id) {
              const previous = this.state.deliveryIntents[previousId];
              if (previous?.status === "DELIVERED") {
                previous.status = "SUPERSEDED";
                previous.statusUpdatedAt = this.clock.now();
              }
            }
            currentUser.activePasswordResetIntentId = current.id;
          } else if (intent.purpose === "ATTRIBUTE_VERIFICATION") {
            const attributeName = current.message.safeVariables.attributeName ?? "email";
            const previousId = currentUser.activeAttributeVerificationIntentIds[attributeName];
            if (previousId && previousId !== current.id) {
              const previous = this.state.deliveryIntents[previousId];
              if (previous?.status === "DELIVERED") {
                previous.status = "SUPERSEDED";
                previous.statusUpdatedAt = this.clock.now();
              }
            }
            currentUser.activeAttributeVerificationIntentIds[attributeName] = current.id;
          } else if (intent.purpose !== "EMAIL_MFA") {
            const previousId = currentUser.activeConfirmationIntentId;
            if (previousId && previousId !== current.id) {
              const previous = this.state.deliveryIntents[previousId];
              if (previous?.status === "DELIVERED") {
                previous.status = "SUPERSEDED";
                previous.statusUpdatedAt = this.clock.now();
              }
            }
            currentUser.activeConfirmationIntentId = current.id;
          }
          current.status = "DELIVERED";
          current.statusUpdatedAt = this.clock.now();
          currentUser.updatedAt = this.clock.now();
        }
        this.state.revision += 1;
        await this.store.save();
      });
      await this.metric(deliveryOperation, "EmailDeliverySuccessCount", intent.poolId);
      await this.metric(
        deliveryOperation,
        "EmailDeliveryLatency",
        intent.poolId,
        Math.max(0, this.clock.now() - deliveryStartedAt),
        "Milliseconds",
      );
    } catch (error) {
      await this.metric(deliveryOperation, "EmailDeliveryFailureCount", intent.poolId);
      throw error;
    } finally {
      rendered.canonical.fill(0);
    }
  }

  private audit(operation: string, outcome: CognitoAuditEventState["outcome"], requestId: string, poolId?: unknown): void {
    const event: CognitoAuditEventState = {
      id: requestId,
      at: this.clock.now(),
      operation,
      outcome,
      ...(typeof poolId === "string" && poolId.length <= 128 ? { poolId } : {}),
    };
    this.state.audit.push(event);
    if (this.state.audit.length > AUDIT_LIMIT) this.state.audit.splice(0, this.state.audit.length - AUDIT_LIMIT);
  }

  private async metric(
    operation: string,
    metricName: string,
    poolId?: unknown,
    value = 1,
    unit = "Count",
  ): Promise<void> {
    try {
      await this.telemetry?.publish({
        namespace: "AWS/Cognito",
        metricName,
        dimensions: {
          Operation: operation,
          Account: this.store.accountId,
          Region: this.region,
          ...(typeof poolId === "string" && poolId.length <= 128 ? { UserPool: poolId } : {}),
        },
        value,
        unit,
        timestamp: this.clock.now(),
      });
    } catch {
      // Control-plane correctness must not depend on optional metrics storage.
    }
  }

  private safePoolId(input: Record<string, any>): string | undefined {
    if (typeof input.UserPoolId === "string" && this.state.pools[input.UserPoolId]) {
      return input.UserPoolId;
    }
    if (typeof input.ClientId === "string") {
      for (const pool of Object.values(this.state.pools)) {
        if (pool.clients[input.ClientId]) return pool.id;
      }
    }
    return undefined;
  }

  private async successOutcomeMetric(
    operation: string,
    input: Record<string, any>,
    poolId?: string,
  ): Promise<void> {
    if (operation === "SignUp") await this.metric(operation, "SignUpCount", poolId);
    if (operation === "ConfirmSignUp") {
      await this.metric(operation, "ConfirmationSuccessCount", poolId);
    }
    if (operation === "InitiateAuth" && input.AuthFlow === "USER_PASSWORD_AUTH") {
      await this.metric(operation, "AuthenticationSuccessCount", poolId);
    }
    if (
      operation === "GetTokensFromRefreshToken"
      || operation === "InitiateAuth" && input.AuthFlow === "REFRESH_TOKEN_AUTH"
    ) {
      await this.metric(operation, "RefreshSuccessCount", poolId);
    }
  }

  private async failureOutcomeMetric(
    operation: string,
    input: Record<string, any> | undefined,
    poolId?: string,
  ): Promise<void> {
    if (operation === "InitiateAuth" && input?.AuthFlow === "USER_PASSWORD_AUTH") {
      await this.metric(operation, "AuthenticationFailureCount", poolId);
    }
    if (
      operation === "GetTokensFromRefreshToken"
      || operation === "InitiateAuth" && input?.AuthFlow === "REFRESH_TOKEN_AUTH"
    ) {
      await this.metric(operation, "RefreshFailureCount", poolId);
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const target = String(req.headers["x-amz-target"] ?? "");
    const operation = cognitoTargetOperation(target);
    let input: Record<string, any> | undefined;
    let metricPoolId: string | undefined;
    try {
      if (req.method !== "POST" || req.url?.split("?", 1)[0] !== "/") {
        throw new AwsError("UnknownOperationException", "Unknown operation.");
      }
      if (!operation) {
        throw new AwsError("UnknownOperationException", "Unknown operation.");
      }
      this.secrets.assertAvailable();
      input = await parseCognitoJson(req);
      metricPoolId = this.safePoolId(input);
      await this.metric(operation, "CallCount", metricPoolId);
      await this.validateProof(operation, input);
      metricPoolId ??= this.accessProof.get(input)?.pool.id ?? this.refreshProof.get(input)?.pool.id;
      const output = await this.dispatch(operation, input);
      metricPoolId ??= (output as any)?.UserPool?.Id;
      this.audit(operation, "SUCCESS", requestId, metricPoolId);
      await this.store.save();
      await this.metric(operation, "SuccessCount", metricPoolId);
      await this.successOutcomeMetric(operation, input, metricPoolId);
      sendCognitoJson(res, output);
    } catch (error) {
      const aws = error instanceof AwsError
        ? error
        : new AwsError("InternalErrorException", error instanceof Error ? error.message : String(error), 500);
      if (operation) {
        this.audit(operation, aws.status >= 500 ? "SERVER_ERROR" : "CLIENT_ERROR", requestId, metricPoolId);
        await this.store.save().catch(() => undefined);
        await this.metric(operation, aws.status >= 500 ? "ServerErrorCount" : "ClientErrorCount", metricPoolId);
        if (aws.code === "TooManyRequestsException") {
          await this.metric(operation, "ThrottleCount", metricPoolId);
        }
        await this.failureOutcomeMetric(operation, input, metricPoolId);
      }
      sendCognitoError(res, aws);
    }
  }

  private dispatch(operation: string, input: Record<string, any>): Promise<Record<string, unknown> | void> {
    switch (operation) {
      case "CreateUserPool": return this.CreateUserPool(input);
      case "DescribeUserPool": return Promise.resolve(this.DescribeUserPool(input));
      case "ListUserPools": return Promise.resolve(this.ListUserPools(input));
      case "UpdateUserPool": return this.UpdateUserPool(input);
      case "DeleteUserPool": return this.DeleteUserPool(input);
      case "CreateUserPoolClient": return this.CreateUserPoolClient(input);
      case "DescribeUserPoolClient": return Promise.resolve(this.DescribeUserPoolClient(input));
      case "ListUserPoolClients": return Promise.resolve(this.ListUserPoolClients(input));
      case "UpdateUserPoolClient": return this.UpdateUserPoolClient(input);
      case "DeleteUserPoolClient": return this.DeleteUserPoolClient(input);
      case "SignUp": return this.SignUp(input);
      case "ConfirmSignUp": return this.ConfirmSignUp(input);
      case "ResendConfirmationCode": return this.ResendConfirmationCode(input);
      case "InitiateAuth": return this.InitiateAuth(input);
      case "AdminInitiateAuth": return this.AdminInitiateAuth(input);
      case "GetTokensFromRefreshToken": return this.GetTokensFromRefreshToken(input);
      case "RevokeToken": return this.RevokeToken(input);
      case "GetUser": return Promise.resolve(this.GetUser(input));
      case "GlobalSignOut": return this.GlobalSignOut(input);
      case "RespondToAuthChallenge": return this.RespondToAuthChallenge(input);
      case "AdminRespondToAuthChallenge": return this.RespondToAuthChallenge(input);
      case "ForgotPassword": return this.ForgotPassword(input);
      case "ConfirmForgotPassword": return this.ConfirmForgotPassword(input);
      case "ChangePassword": return this.ChangePassword(input);
      case "DeleteUser": return this.DeleteUser(input);
      case "UpdateUserAttributes": return this.UpdateUserAttributes(input);
      case "AdminUpdateUserAttributes": return this.AdminUpdateUserAttributes(input);
      case "DeleteUserAttributes": return this.DeleteUserAttributes(input);
      case "AdminDeleteUserAttributes": return this.AdminDeleteUserAttributes(input);
      case "GetUserAttributeVerificationCode": return this.GetUserAttributeVerificationCode(input);
      case "VerifyUserAttribute": return this.VerifyUserAttribute(input);
      case "AssociateSoftwareToken": return this.AssociateSoftwareToken(input);
      case "VerifySoftwareToken": return this.VerifySoftwareToken(input);
      case "SetUserMFAPreference": return this.SetUserMFAPreference(input);
      case "AdminSetUserMFAPreference": return this.AdminSetUserMFAPreference(input);
      case "GetUserAuthFactors": return Promise.resolve(this.GetUserAuthFactors(input));
      case "SetUserPoolMfaConfig": return this.SetUserPoolMfaConfig(input);
      case "GetUserPoolMfaConfig": return Promise.resolve(this.GetUserPoolMfaConfig(input));
      case "ConfirmDevice": return this.ConfirmDevice(input);
      case "GetDevice": return Promise.resolve(this.GetDevice(input));
      case "ListDevices": return Promise.resolve(this.ListDevices(input));
      case "ForgetDevice": return this.ForgetDevice(input);
      case "UpdateDeviceStatus": return this.UpdateDeviceStatus(input);
      case "AdminGetDevice": return Promise.resolve(this.AdminGetDevice(input));
      case "AdminListDevices": return Promise.resolve(this.AdminListDevices(input));
      case "AdminForgetDevice": return this.AdminForgetDevice(input);
      case "AdminUpdateDeviceStatus": return this.AdminUpdateDeviceStatus(input);
      case "AdminListUserAuthEvents": return Promise.resolve(this.AdminListUserAuthEvents(input));
      case "AdminUpdateAuthEventFeedback": return this.AdminUpdateAuthEventFeedback(input);
      case "UpdateAuthEventFeedback": return this.UpdateAuthEventFeedback(input);
      case "SetUserSettings": return Promise.resolve(this.SetUserSettings(input));
      case "AdminSetUserSettings": return Promise.resolve(this.AdminSetUserSettings(input));
      case "DeleteUserPoolReplica": return Promise.resolve(this.DeleteUserPoolReplica(input));
      case "AdminCreateUser": return this.AdminCreateUser(input);
      case "AdminGetUser": return Promise.resolve(this.AdminGetUser(input));
      case "ListUsers": return Promise.resolve(this.ListUsers(input));
      case "AdminConfirmSignUp": return this.AdminConfirmSignUp(input);
      case "AdminEnableUser": return this.AdminEnableUser(input);
      case "AdminDisableUser": return this.AdminDisableUser(input);
      case "AdminDeleteUser": return this.AdminDeleteUser(input);
      case "AdminSetUserPassword": return this.AdminSetUserPassword(input);
      case "AdminResetUserPassword": return this.AdminResetUserPassword(input);
      case "AdminUserGlobalSignOut": return this.AdminUserGlobalSignOut(input);
      case "TagResource": return this.TagResource(input);
      case "UntagResource": return this.UntagResource(input);
      case "ListTagsForResource": return Promise.resolve(this.ListTagsForResource(input));
      case "CreateGroup": return this.CreateGroup(input);
      case "GetGroup": return Promise.resolve(this.GetGroup(input));
      case "ListGroups": return Promise.resolve(this.ListGroups(input));
      case "UpdateGroup": return this.UpdateGroup(input);
      case "DeleteGroup": return this.DeleteGroup(input);
      case "AdminAddUserToGroup": return this.AdminAddUserToGroup(input);
      case "AdminRemoveUserFromGroup": return this.AdminRemoveUserFromGroup(input);
      case "AdminListGroupsForUser": return Promise.resolve(this.AdminListGroupsForUser(input));
      case "ListUsersInGroup": return Promise.resolve(this.ListUsersInGroup(input));
      case "AddCustomAttributes": return this.AddCustomAttributes(input);
      case "CreateResourceServer": return this.CreateResourceServer(input);
      case "DescribeResourceServer": return Promise.resolve(this.DescribeResourceServer(input));
      case "ListResourceServers": return Promise.resolve(this.ListResourceServers(input));
      case "UpdateResourceServer": return this.UpdateResourceServer(input);
      case "DeleteResourceServer": return this.DeleteResourceServer(input);
      case "CreateUserPoolDomain": return this.CreateUserPoolDomain(input);
      case "DescribeUserPoolDomain": return Promise.resolve(this.DescribeUserPoolDomain(input));
      case "UpdateUserPoolDomain": return this.UpdateUserPoolDomain(input);
      case "DeleteUserPoolDomain": return this.DeleteUserPoolDomain(input);
      case "CreateManagedLoginBranding": return this.CreateManagedLoginBranding(input);
      case "DescribeManagedLoginBranding": return Promise.resolve(this.DescribeManagedLoginBranding(input));
      case "DescribeManagedLoginBrandingByClient": return Promise.resolve(this.DescribeManagedLoginBrandingByClient(input));
      case "UpdateManagedLoginBranding": return this.UpdateManagedLoginBranding(input);
      case "DeleteManagedLoginBranding": return this.DeleteManagedLoginBranding(input);
      case "GetUICustomization": return Promise.resolve(this.GetUICustomization(input));
      case "SetUICustomization": return this.SetUICustomization(input);
      case "CreateIdentityProvider": return this.CreateIdentityProvider(input);
      case "DescribeIdentityProvider": return Promise.resolve(this.DescribeIdentityProvider(input));
      case "GetIdentityProviderByIdentifier": return Promise.resolve(this.GetIdentityProviderByIdentifier(input));
      case "ListIdentityProviders": return Promise.resolve(this.ListIdentityProviders(input));
      case "UpdateIdentityProvider": return this.UpdateIdentityProvider(input);
      case "DeleteIdentityProvider": return this.DeleteIdentityProvider(input);
      case "AdminLinkProviderForUser": return this.AdminLinkProviderForUser(input);
      case "AdminDisableProviderForUser": return this.AdminDisableProviderForUser(input);
      case "AddUserPoolClientSecret": return this.AddUserPoolClientSecret(input);
      case "ListUserPoolClientSecrets": return Promise.resolve(this.ListUserPoolClientSecrets(input));
      case "DeleteUserPoolClientSecret": return this.DeleteUserPoolClientSecret(input);
      case "CompleteWebAuthnRegistration":
      case "DeleteWebAuthnCredential":
      case "ListWebAuthnCredentials":
      case "StartWebAuthnRegistration":
      case "CreateTerms":
      case "DeleteTerms":
      case "DescribeTerms":
      case "ListTerms":
      case "UpdateTerms":
      case "CreateUserImportJob":
      case "DescribeUserImportJob":
      case "GetCSVHeader":
      case "ListUserImportJobs":
      case "StartUserImportJob":
      case "StopUserImportJob":
      case "CreateUserPoolReplica":
      case "ListUserPoolReplicas":
      case "UpdateUserPoolReplica":
      case "DescribeRiskConfiguration":
      case "SetRiskConfiguration":
      case "GetLogDeliveryConfiguration":
      case "SetLogDeliveryConfiguration":
      case "GetProvisionedLimit":
      case "UpdateProvisionedLimit":
      case "GetSigningCertificate":
        throwCog07BoundaryForOperation(operation);
      default:
        throw new AwsError("UnknownOperationException", "Unknown operation.");
    }
  }

  /**
   * Narrow in-process control-plane contract used by CloudFormation providers.
   * Providers deliberately reuse the same validated Cognito operations as the
   * public AWS JSON endpoint and never read or mutate Cognito persistence.
   */
  async executeCloudFormationControl(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.secrets.assertAvailable();
    return (await this.dispatch(operation, input as Record<string, any>)) ?? {};
  }

  async CreateUserPool(input: Record<string, any>): Promise<Record<string, unknown>> {
    const name = cognitoName(input.PoolName, "PoolName");
    const tags = tagMap(input.UserPoolTags);
    const configuration = createPoolConfiguration(input, {
      accountId: this.store.accountId,
      region: this.region,
    });
    const id = `${this.region}_${randomAlphaNumeric(9, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`;
    const signingKeys = await generatePoolSigningKeys(
      this.secrets,
      this.store.accountId,
      this.region,
      id,
      this.clock.now(),
    );
    return this.exclusive(async () => {
      if (this.state.poolNameIndex[name]) {
        throw new AwsError("InvalidParameterException", `A user pool named ${name} already exists.`);
      }
      if (Object.keys(this.state.pools).length >= MAX_POOLS) {
        throw new AwsError("LimitExceededException", "The user-pool limit has been exceeded.");
      }
      if (this.state.pools[id]) {
        throw new AwsError("InternalErrorException", "Could not allocate a unique user-pool identifier.", 500);
      }
      const now = this.clock.now();
      const pool: CognitoUserPoolState = {
        id,
        arn: `arn:${partitionForRegion(this.region)}:cognito-idp:${this.region}:${this.store.accountId}:userpool/${id}`,
        name,
        createdAt: now,
        updatedAt: now,
        status: "ACTIVE",
        configuration,
        signingKeys,
        clients: {},
        clientNameIndex: {},
        usersBySub: {},
        usernameIndex: {},
        aliasIndex: {},
      refreshSessions: {},
      groups: {},
      challenges: {},
      authEvents: [],
      tags,
      resourceServers: {},
      managedLoginBranding: {},
      uiCustomizations: {},
        authorizationCodes: {},
        browserSessions: {},
        identityProviders: {},
        identityProviderIdentifierIndex: {},
        federatedIdentityIndex: {},
        federationTransactions: {},
        federationReplayIds: {},
      };
      this.state.pools[id] = pool;
      this.state.poolNameIndex[name] = id;
      this.state.revision += 1;
      await this.store.save();
      return { UserPool: poolView(pool) };
    });
  }

  DescribeUserPool(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => key !== "UserPoolId")) {
      throw new AwsError("InvalidParameterException", "DescribeUserPool contains an unsupported field.");
    }
    return { UserPool: poolView(this.pool(input.UserPoolId)) };
  }

  ListUserPools(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["MaxResults", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListUserPools contains an unsupported field.");
    }
    const max = input.MaxResults;
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new AwsError("InvalidParameterException", "MaxResults must be an integer from 1 through 60.");
    }
    let index = 0;
    if (input.NextToken !== undefined) {
      if (typeof input.NextToken !== "string" || input.NextToken.length > 8_192) {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
      try {
        const cursor = this.tokens.decode<{ accountId: string; region: string; index: number }>("ListUserPools", input.NextToken);
        if (cursor.accountId !== this.store.accountId || cursor.region !== this.region || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const pools = Object.values(this.state.pools).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const page = pools.slice(index, index + max);
    const next = index + page.length;
    return {
      UserPools: page.map(pool => ({
        Id: pool.id,
        Name: pool.name,
        Status: "Enabled",
        LastModifiedDate: timestamp(pool.updatedAt),
        CreationDate: timestamp(pool.createdAt),
      })),
      ...(next < pools.length
        ? { NextToken: this.tokens.encode("ListUserPools", { accountId: this.store.accountId, region: this.region, index: next }) }
        : {}),
    };
  }

  async UpdateUserPool(input: Record<string, any>): Promise<Record<string, never>> {
    const pool = this.pool(input.UserPoolId);
    const nextConfiguration = updatePoolConfiguration(input, pool.configuration, {
      accountId: this.store.accountId,
      region: this.region,
    });
    const nextName = input.PoolName === undefined ? pool.name : cognitoName(input.PoolName, "PoolName");
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const conflict = this.state.poolNameIndex[nextName];
      if (conflict && conflict !== current.id) {
        throw new AwsError("InvalidParameterException", `A user pool named ${nextName} already exists.`);
      }
      if (current.name !== nextName) {
        delete this.state.poolNameIndex[current.name];
        this.state.poolNameIndex[nextName] = current.id;
        current.name = nextName;
      }
      current.configuration = nextConfiguration;
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async DeleteUserPool(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => key !== "UserPoolId")) {
      throw new AwsError("InvalidParameterException", "DeleteUserPool contains an unsupported field.");
    }
    const id = userPoolId(input.UserPoolId);
    return this.exclusive(async () => {
      const pool = this.state.pools[id];
      if (!pool) throw new AwsError("ResourceNotFoundException", "User pool not found.");
      if (pool.configuration.deletionProtection === "ACTIVE") {
        throw new AwsError("InvalidParameterException", "User pool deletion protection is active.");
      }
      delete this.state.pools[id];
      delete this.state.poolNameIndex[pool.name];
      if (pool.domain) delete this.state.domainIndex[pool.domain.domain];
      for (const [intentId, intent] of Object.entries(this.state.deliveryIntents)) {
        if (intent.poolId === id) delete this.state.deliveryIntents[intentId];
      }
      for (const [admissionKey, admission] of Object.entries(this.state.admissions)) {
        if (admission.poolId === id) delete this.state.admissions[admissionKey];
      }
      const deletedAt = this.clock.now();
      this.state.issuerTombstones[id] = {
        issuer: `https://cognito-idp.${this.region}.${dnsSuffixForRegion(this.region)}/${id}`,
        poolId: id,
        deletedAt,
        minimumRetainUntil: deletedAt + 31 * 24 * 60 * 60 * 1_000,
      };
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async CreateUserPoolClient(input: Record<string, any>): Promise<Record<string, unknown>> {
    const pool = this.pool(input.UserPoolId);
    const name = cognitoName(input.ClientName, "ClientName");
    const configuration = clientConfiguration(input, "create");
    this.validateClientAttributes(pool, configuration.readAttributes, "ReadAttributes");
    this.validateClientAttributes(pool, configuration.writeAttributes, "WriteAttributes");
    const secretCreation = clientSecretCreation(input);
    this.validateClientOAuth(
      pool,
      configuration,
      Boolean(secretCreation.generate || secretCreation.supplied),
    );
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (current.clientNameIndex[name]) {
        throw new AwsError("InvalidParameterException", `An app client named ${name} already exists.`);
      }
      if (Object.keys(current.clients).length >= MAX_CLIENTS_PER_POOL) {
        throw new AwsError("LimitExceededException", "The app-client limit has been exceeded.");
      }
      const id = randomAlphaNumeric(26, "abcdefghijklmnopqrstuvwxyz0123456789");
      const secretValue = secretCreation.supplied
        ?? (secretCreation.generate ? randomAlphaNumeric(64, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") : undefined);
      const now = this.clock.now();
      const client: CognitoAppClientState = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        ...configuration,
      };
      if (secretValue !== undefined) {
        assignClientSecrets(client, [
          createClientSecretEntry(current.id, id, now, (poolIdValue, clientIdValue, value) =>
            this.secretState(poolIdValue, clientIdValue, value), secretValue),
        ]);
      }
      current.clients[id] = client;
      current.clientNameIndex[name] = id;
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { UserPoolClient: this.clientView(current.id, client) };
    });
  }

  DescribeUserPoolClient(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "ClientId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DescribeUserPoolClient contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    return { UserPoolClient: this.clientView(pool.id, this.appClient(pool, input.ClientId)) };
  }

  ListUserPoolClients(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "MaxResults", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListUserPoolClients contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const max = input.MaxResults === undefined ? 60 : input.MaxResults;
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new AwsError("InvalidParameterException", "MaxResults must be an integer from 1 through 60.");
    }
    let index = 0;
    if (input.NextToken !== undefined) {
      if (typeof input.NextToken !== "string" || input.NextToken.length > 8_192) {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
      try {
        const cursor = this.tokens.decode<{ poolId: string; index: number }>("ListUserPoolClients", input.NextToken);
        if (cursor.poolId !== pool.id || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const clients = Object.values(pool.clients).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const page = clients.slice(index, index + max);
    const next = index + page.length;
    return {
      UserPoolClients: page.map(client => ({ ClientId: client.id, UserPoolId: pool.id, ClientName: client.name })),
      ...(next < clients.length ? { NextToken: this.tokens.encode("ListUserPoolClients", { poolId: pool.id, index: next }) } : {}),
    };
  }

  async UpdateUserPoolClient(input: Record<string, any>): Promise<Record<string, unknown>> {
    const pool = this.pool(input.UserPoolId);
    const existing = this.appClient(pool, input.ClientId);
    const name = input.ClientName === undefined ? existing.name : cognitoName(input.ClientName, "ClientName");
    const configuration = clientConfiguration(input, "update");
    this.validateClientAttributes(pool, configuration.readAttributes, "ReadAttributes");
    this.validateClientAttributes(pool, configuration.writeAttributes, "WriteAttributes");
    this.validateClientOAuth(pool, configuration, clientHasSecret(existing));
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.appClient(currentPool, existing.id);
      const conflict = currentPool.clientNameIndex[name];
      if (conflict && conflict !== current.id) {
        throw new AwsError("InvalidParameterException", `An app client named ${name} already exists.`);
      }
      if (current.name !== name) {
        delete currentPool.clientNameIndex[current.name];
        currentPool.clientNameIndex[name] = current.id;
      }
      Object.assign(current, configuration, { name, updatedAt: this.clock.now() });
      currentPool.updatedAt = current.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return { UserPoolClient: this.clientView(currentPool.id, current) };
    });
  }

  async DeleteUserPoolClient(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "ClientId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteUserPoolClient contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const id = clientId(input.ClientId);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const client = currentPool.clients[id];
      if (!client) throw new AwsError("ResourceNotFoundException", "App client not found.");
      delete currentPool.clients[id];
      delete currentPool.clientNameIndex[client.name];
      for (const [brandingId, branding] of Object.entries(currentPool.managedLoginBranding)) {
        if (branding.clientId === id) delete currentPool.managedLoginBranding[brandingId];
      }
      delete currentPool.uiCustomizations[id];
      for (const [digest, code] of Object.entries(currentPool.authorizationCodes)) {
        if (code.clientId === id) delete currentPool.authorizationCodes[digest];
      }
      for (const [digest, transaction] of Object.entries(currentPool.federationTransactions)) {
        if (transaction.authorization.clientId === id) delete currentPool.federationTransactions[digest];
      }
      for (const [sessionId, session] of Object.entries(currentPool.refreshSessions)) {
        if (session.clientId === id) delete currentPool.refreshSessions[sessionId];
      }
      for (const [admissionKey, admission] of Object.entries(this.state.admissions)) {
        if (admission.poolId === currentPool.id && admission.clientId === id) {
          delete this.state.admissions[admissionKey];
        }
      }
      currentPool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private validateClientAttributes(pool: CognitoUserPoolState, attributes: string[], field: string): void {
    for (const attribute of attributes) {
      if (["email", "email_verified"].includes(attribute)) continue;
      const name = attribute.startsWith("custom:") ? attribute.slice(7) : attribute;
      if (!pool.configuration.schemaAttributes.some(candidate => candidate.name === name)) {
        throw new AwsError("InvalidParameterException", `${field} contains unknown attribute ${attribute}.`);
      }
    }
  }

  private validateClientOAuth(
    pool: CognitoUserPoolState,
    configuration: Pick<
      CognitoAppClientState,
      "allowedOAuthFlows" | "allowedOAuthScopes" | "allowedOAuthFlowsUserPoolClient" | "supportedIdentityProviders"
    >,
    confidential: boolean,
  ): void {
    if (configuration.allowedOAuthFlows.includes("client_credentials") && !confidential) {
      throw new AwsError(
        "InvalidParameterException",
        "The client_credentials grant requires an app-client secret.",
      );
    }
    const knownCustomScopes = new Set(
      Object.values(pool.resourceServers).flatMap(resource =>
        resource.scopes.map(scope => `${resource.identifier}/${scope.name}`)
      ),
    );
    for (const scope of configuration.allowedOAuthScopes) {
      if (!STANDARD_OAUTH_SCOPES.has(scope) && !knownCustomScopes.has(scope)) {
        throw new AwsError("InvalidParameterException", `AllowedOAuthScopes contains unknown scope ${scope}.`);
      }
    }
    if (
      configuration.allowedOAuthFlows.includes("client_credentials")
      && configuration.allowedOAuthScopes.some(scope => STANDARD_OAUTH_SCOPES.has(scope))
    ) {
      throw new AwsError(
        "InvalidParameterException",
        "The client_credentials grant can use only custom resource-server scopes.",
      );
    }
    if (
      configuration.allowedOAuthFlowsUserPoolClient
      && configuration.allowedOAuthFlows.length === 0
    ) {
      throw new AwsError("InvalidParameterException", "At least one AllowedOAuthFlows value is required.");
    }
    for (const providerName of configuration.supportedIdentityProviders) {
      if (providerName !== "COGNITO" && !pool.identityProviders[providerName]) {
        throw new AwsError(
          "InvalidParameterException",
          `SupportedIdentityProviders contains unknown provider ${providerName}.`,
        );
      }
    }
  }

  private identityProviderName(value: unknown): string {
    if (
      typeof value !== "string"
      || !/^[A-Za-z0-9._-]{1,32}$/.test(value)
      || value === "COGNITO"
    ) throw new AwsError("InvalidParameterException", "ProviderName is invalid.");
    return value;
  }

  private identityProviderIdentifiers(value: unknown): string[] {
    if (value === undefined) return [];
    if (
      !Array.isArray(value)
      || value.length > 50
      || value.some(identifier =>
        typeof identifier !== "string"
        || identifier.length < 1
        || identifier.length > 40
        || !/^[A-Za-z0-9._-]+$/.test(identifier)
      )
      || new Set(value).size !== value.length
    ) throw new AwsError("InvalidParameterException", "IdpIdentifiers is invalid.");
    return [...value];
  }

  private identityProviderMapping(
    pool: CognitoUserPoolState,
    value: unknown,
  ): Record<string, string> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AwsError("InvalidParameterException", "AttributeMapping is invalid.");
    }
    const mapping: Record<string, string> = {};
    const standard = new Set([
      "email", "email_verified", "name", "given_name", "family_name",
      "preferred_username", "picture", "locale",
    ]);
    for (const [target, source] of Object.entries(value)) {
      const schemaName = target.startsWith("custom:") ? target.slice(7) : target;
      const schema = pool.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
      if (
        target === "sub"
        || target.startsWith("dev:")
        || !standard.has(target) && !target.startsWith("custom:")
        || target.startsWith("custom:") && (!schema || schema.developerOnlyAttribute || !schema.mutable)
        || typeof source !== "string"
        || source.length < 1
        || source.length > 2_048
        || /[\u0000-\u001f\u007f]/.test(source)
      ) throw new AwsError("InvalidParameterException", `AttributeMapping.${target} is invalid.`);
      mapping[target] = source;
    }
    if (
      (pool.configuration.usernameAttributes.includes("email")
        || pool.configuration.schemaAttributes.some(attribute => attribute.name === "email" && attribute.required))
      && !mapping.email
    ) throw new AwsError("InvalidParameterException", "AttributeMapping.email is required by this user pool.");
    return mapping;
  }

  private async identityProviderConfiguration(
    pool: CognitoUserPoolState,
    providerName: string,
    providerType: unknown,
    value: unknown,
    existing?: CognitoIdentityProviderState,
  ): Promise<{
    type: CognitoIdentityProviderState["type"];
    details: Record<string, string>;
    clientSecret?: CognitoRecoverableSecretState;
    samlMetadata?: CognitoIdentityProviderState["samlMetadata"];
  }> {
    const type = (existing?.type ?? providerType) as CognitoIdentityProviderState["type"];
    if (!["OIDC", "SAML", "Google", "Facebook", "LoginWithAmazon", "SignInWithApple"].includes(type)) {
      throw new AwsError("InvalidParameterException", "ProviderType is invalid.");
    }
    if (existing && providerType !== undefined && providerType !== existing.type) {
      throw new AwsError("InvalidParameterException", "ProviderType cannot be changed.");
    }
    if (["Google", "Facebook", "LoginWithAmazon", "SignInWithApple"].includes(type)) {
      throw new AwsError(
        "UnsupportedIdentityProviderException",
        "Public social-provider presets are not simulated; configure a standards-compatible OIDC provider.",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AwsError("InvalidParameterException", "ProviderDetails is required.");
    }
    const details = Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (
        typeof entry !== "string"
        || key.length < 1
        || key.length > 64
        || entry.length < 1
        || Buffer.byteLength(entry, "utf8") > 1024 * 1024
      ) throw new AwsError("InvalidParameterException", `ProviderDetails.${key} is invalid.`);
      return [key, entry];
    }));
    if (type === "OIDC") {
      const allowed = new Set([
        "oidc_issuer", "client_id", "client_secret", "authorize_scopes",
        "authorize_url", "token_url", "jwks_uri", "attributes_url", "attributes_request_method",
      ]);
      if (Object.keys(details).some(key => !allowed.has(key))) {
        throw new AwsError("InvalidParameterException", "OIDC ProviderDetails contains an unsupported field.");
      }
      if (
        !details.oidc_issuer
        || !details.client_id
        || !details.authorize_scopes
        || details.attributes_request_method && details.attributes_request_method !== "GET"
        || !details.client_secret && !existing?.clientSecret
      ) throw new AwsError("InvalidParameterException", "OIDC provider details are incomplete.");
      let clientSecret = existing?.clientSecret;
      if (details.client_secret) {
        if (details.client_secret.length > 512) {
          throw new AwsError("InvalidParameterException", "OIDC client_secret is invalid.");
        }
        clientSecret = this.identityProviderSecretState(pool.id, providerName, details.client_secret);
        delete details.client_secret;
      }
      try {
        await resolveOidcConfiguration(details, this.providerHttp);
      } catch (error) {
        throw this.identityProviderConfigurationError(error);
      }
      return { type, details, ...(clientSecret ? { clientSecret } : {}) };
    }
    const allowed = new Set([
      "MetadataFile", "MetadataURL", "IDPInit", "IDPSignout",
      "EncryptedResponses", "RequestSigningAlgorithm",
    ]);
    if (Object.keys(details).some(key => !allowed.has(key))) {
      throw new AwsError("InvalidParameterException", "SAML ProviderDetails contains an unsupported field.");
    }
    if (Boolean(details.MetadataFile) === Boolean(details.MetadataURL)) {
      throw new AwsError("InvalidParameterException", "Exactly one of MetadataFile or MetadataURL is required.");
    }
    if (
      details.IDPInit && !["true", "false"].includes(details.IDPInit)
      || details.IDPSignout && details.IDPSignout !== "false"
      || details.EncryptedResponses && details.EncryptedResponses !== "false"
      || details.RequestSigningAlgorithm
    ) {
      throw new AwsError(
        "InvalidParameterException",
        "This local SAML profile supports optional IDPInit and signed plaintext responses; request signing, encryption, and IdP sign-out are unavailable.",
      );
    }
    let metadataText: string;
    try {
      metadataText = details.MetadataFile ?? await this.providerHttp.text(details.MetadataURL);
      const samlMetadata = parseSamlMetadata(metadataText);
      return { type, details, samlMetadata };
    } catch (error) {
      throw this.identityProviderConfigurationError(error);
    }
  }

  private identityProviderConfigurationError(error: unknown): AwsError {
    if (error instanceof AwsError) return error;
    if (error instanceof FederationError) {
      return new AwsError(
        error.code === "temporarily_unavailable" ? "InternalErrorException" : "InvalidParameterException",
        error.message,
        error.status,
      );
    }
    return new AwsError(
      "InvalidParameterException",
      error instanceof Error ? error.message : "Identity-provider configuration is invalid.",
    );
  }

  private identityProviderSecretState(
    poolIdValue: string,
    providerName: string,
    value: string,
  ): CognitoRecoverableSecretState {
    const id = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const plaintext = Buffer.from(value, "utf8");
    try {
      return {
        id,
        version: 1,
        envelope: this.secrets.encrypt(plaintext, {
          purpose: "IDP_SECRET",
          accountId: this.store.accountId,
          region: this.region,
          poolId: poolIdValue,
          ownerId: providerName,
          secretId: id,
          secretVersion: 1,
          field: "client-secret",
        }),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  private identityProviderClientSecret(
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
  ): Buffer | undefined {
    if (!provider.clientSecret) return undefined;
    return this.secrets.decrypt(provider.clientSecret.envelope, {
      purpose: "IDP_SECRET",
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      ownerId: provider.name,
      secretId: provider.clientSecret.id,
      secretVersion: 1,
      field: "client-secret",
    });
  }

  private identityProviderView(
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
    includeSecret = true,
  ): Record<string, unknown> {
    let secret: Buffer | undefined;
    try {
      secret = includeSecret ? this.identityProviderClientSecret(pool, provider) : undefined;
      return {
        UserPoolId: pool.id,
        ProviderName: provider.name,
        ProviderType: provider.type,
        ProviderDetails: {
          ...provider.providerDetails,
          ...(secret ? { client_secret: secret.toString("utf8") } : {}),
        },
        AttributeMapping: { ...provider.attributeMapping },
        IdpIdentifiers: [...provider.idpIdentifiers],
        LastModifiedDate: timestamp(provider.updatedAt),
        CreationDate: timestamp(provider.createdAt),
      };
    } finally {
      secret?.fill(0);
    }
  }

  async CreateIdentityProvider(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key =>
      !["UserPoolId", "ProviderName", "ProviderType", "ProviderDetails", "AttributeMapping", "IdpIdentifiers"].includes(key)
    )) throw new AwsError("InvalidParameterException", "CreateIdentityProvider contains an unsupported field.");
    const pool = this.pool(input.UserPoolId);
    const name = this.identityProviderName(input.ProviderName);
    const mapping = this.identityProviderMapping(pool, input.AttributeMapping);
    const identifiers = this.identityProviderIdentifiers(input.IdpIdentifiers);
    const configuration = await this.identityProviderConfiguration(
      pool,
      name,
      input.ProviderType,
      input.ProviderDetails,
    );
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (current.identityProviders[name]) {
        throw new AwsError("DuplicateProviderException", "An identity provider with this name already exists.");
      }
      if (Object.keys(current.identityProviders).length >= 20) {
        throw new AwsError("LimitExceededException", "The identity-provider limit has been exceeded.");
      }
      for (const identifier of identifiers) {
        if (current.identityProviderIdentifierIndex[identifier]) {
          throw new AwsError("DuplicateProviderException", `IdP identifier ${identifier} is already assigned.`);
        }
      }
      const now = this.clock.now();
      const provider: CognitoIdentityProviderState = {
        name,
        type: configuration.type,
        providerDetails: configuration.details,
        ...(configuration.clientSecret ? { clientSecret: configuration.clientSecret } : {}),
        ...(configuration.samlMetadata ? { samlMetadata: configuration.samlMetadata } : {}),
        attributeMapping: mapping,
        idpIdentifiers: identifiers,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      current.identityProviders[name] = provider;
      for (const identifier of identifiers) current.identityProviderIdentifierIndex[identifier] = name;
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { IdentityProvider: this.identityProviderView(current, provider) };
    });
  }

  DescribeIdentityProvider(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "ProviderName"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DescribeIdentityProvider contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const provider = pool.identityProviders[this.identityProviderName(input.ProviderName)];
    if (!provider) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
    return { IdentityProvider: this.identityProviderView(pool, provider) };
  }

  GetIdentityProviderByIdentifier(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "IdpIdentifier"].includes(key))) {
      throw new AwsError("InvalidParameterException", "GetIdentityProviderByIdentifier contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const identifiers = this.identityProviderIdentifiers([input.IdpIdentifier]);
    const name = pool.identityProviderIdentifierIndex[identifiers[0]];
    const provider = name ? pool.identityProviders[name] : undefined;
    if (!provider) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
    return { IdentityProvider: this.identityProviderView(pool, provider) };
  }

  ListIdentityProviders(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "MaxResults", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListIdentityProviders contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const max = input.MaxResults === undefined ? 60 : input.MaxResults;
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new AwsError("InvalidParameterException", "MaxResults must be an integer from 1 through 60.");
    }
    let index = 0;
    if (input.NextToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{ poolId: string; revision: number; index: number }>(
          "ListIdentityProviders",
          input.NextToken,
        );
        if (
          cursor.poolId !== pool.id
          || cursor.revision !== this.state.revision
          || !Number.isInteger(cursor.index)
          || cursor.index < 0
        ) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const providers = Object.values(pool.identityProviders)
      .sort((left, right) => left.name.localeCompare(right.name));
    const page = providers.slice(index, index + max);
    const next = index + page.length;
    return {
      Providers: page.map(provider => ({
        ProviderName: provider.name,
        ProviderType: provider.type,
        LastModifiedDate: timestamp(provider.updatedAt),
        CreationDate: timestamp(provider.createdAt),
      })),
      ...(next < providers.length
        ? {
            NextToken: this.tokens.encode("ListIdentityProviders", {
              poolId: pool.id,
              revision: this.state.revision,
              index: next,
            }),
          }
        : {}),
    };
  }

  async UpdateIdentityProvider(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key =>
      !["UserPoolId", "ProviderName", "ProviderDetails", "AttributeMapping", "IdpIdentifiers"].includes(key)
    )) throw new AwsError("InvalidParameterException", "UpdateIdentityProvider contains an unsupported field.");
    const pool = this.pool(input.UserPoolId);
    const name = this.identityProviderName(input.ProviderName);
    const existing = pool.identityProviders[name];
    if (!existing) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
    const mapping = this.identityProviderMapping(pool, input.AttributeMapping);
    const identifiers = this.identityProviderIdentifiers(input.IdpIdentifiers);
    const configuration = await this.identityProviderConfiguration(
      pool,
      name,
      undefined,
      input.ProviderDetails,
      existing,
    );
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = currentPool.identityProviders[name];
      if (!current || current.revision !== existing.revision) {
        throw new AwsError("ConcurrentModificationException", "Identity provider changed concurrently.");
      }
      for (const identifier of identifiers) {
        const owner = currentPool.identityProviderIdentifierIndex[identifier];
        if (owner && owner !== name) {
          throw new AwsError("DuplicateProviderException", `IdP identifier ${identifier} is already assigned.`);
        }
      }
      for (const identifier of current.idpIdentifiers) delete currentPool.identityProviderIdentifierIndex[identifier];
      Object.assign(current, {
        providerDetails: configuration.details,
        clientSecret: configuration.clientSecret,
        samlMetadata: configuration.samlMetadata,
        attributeMapping: mapping,
        idpIdentifiers: identifiers,
        updatedAt: this.clock.now(),
        revision: current.revision + 1,
      });
      for (const identifier of identifiers) currentPool.identityProviderIdentifierIndex[identifier] = name;
      for (const [digest, transaction] of Object.entries(currentPool.federationTransactions)) {
        if (transaction.providerName === name && transaction.status === "ACTIVE") delete currentPool.federationTransactions[digest];
      }
      this.oidcKeyCache.delete(`${currentPool.id}:${name}`);
      currentPool.updatedAt = current.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return { IdentityProvider: this.identityProviderView(currentPool, current) };
    });
  }

  async DeleteIdentityProvider(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "ProviderName"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteIdentityProvider contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const name = this.identityProviderName(input.ProviderName);
    if (!pool.identityProviders[name]) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
    if (Object.values(pool.clients).some(client => client.supportedIdentityProviders.includes(name))) {
      throw new AwsError("InvalidParameterException", "The identity provider is enabled for an app client.");
    }
    if (Object.values(pool.usersBySub).some(user =>
      user.externalIdentities.some(identity => identity.providerName === name)
    )) throw new AwsError("InvalidParameterException", "The identity provider still has linked users.");
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const provider = current.identityProviders[name];
      if (!provider) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
      delete current.identityProviders[name];
      for (const identifier of provider.idpIdentifiers) delete current.identityProviderIdentifierIndex[identifier];
      for (const [digest, transaction] of Object.entries(current.federationTransactions)) {
        if (transaction.providerName === name) delete current.federationTransactions[digest];
      }
      this.oidcKeyCache.delete(`${current.id}:${name}`);
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private providerUserIdentifier(
    value: unknown,
    field: string,
  ): { providerName: string; attributeName: string; attributeValue: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AwsError("InvalidParameterException", `${field} is invalid.`);
    }
    if (Object.keys(value).some(key =>
      !["ProviderName", "ProviderAttributeName", "ProviderAttributeValue"].includes(key)
    )) throw new AwsError("InvalidParameterException", `${field} contains an unsupported field.`);
    const providerName = (value as any).ProviderName;
    const attributeName = (value as any).ProviderAttributeName;
    const attributeValue = (value as any).ProviderAttributeValue;
    if (
      typeof providerName !== "string"
      || typeof attributeName !== "string"
      || typeof attributeValue !== "string"
      || attributeName.length < 1
      || attributeName.length > 32
      || attributeValue.length < 1
      || attributeValue.length > 2_048
      || /[\u0000-\u001f\u007f]/.test(attributeValue)
    ) throw new AwsError("InvalidParameterException", `${field} is invalid.`);
    return { providerName, attributeName, attributeValue };
  }

  private federatedIdentityKey(
    pool: CognitoUserPoolState,
    providerName: string,
    subject: string,
  ): string {
    return this.secrets.federationDigest("replay", `identity:${subject}`, {
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      providerName,
    });
  }

  async AdminLinkProviderForUser(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "DestinationUser", "SourceUser"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminLinkProviderForUser contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const destination = this.providerUserIdentifier(input.DestinationUser, "DestinationUser");
    const source = this.providerUserIdentifier(input.SourceUser, "SourceUser");
    if (destination.providerName !== "Cognito") {
      throw new AwsError("InvalidParameterException", "DestinationUser.ProviderName must be Cognito.");
    }
    const user = findUserByModeledUsername(pool, destination.attributeValue)
      ?? pool.usersBySub[destination.attributeValue];
    if (!user) throw new AwsError("UserNotFoundException", "Destination user not found.");
    if (Object.entries(user.attributes).some(([name]) => {
      const schemaName = name.startsWith("custom:") ? name.slice(7) : name;
      return pool.configuration.schemaAttributes.some(candidate =>
        candidate.name === schemaName && !candidate.mutable
      );
    })) throw new AwsError("InvalidParameterException", "Destination user has an immutable attribute.");
    const provider = pool.identityProviders[source.providerName];
    if (!provider) throw new AwsError("ResourceNotFoundException", "Source identity provider not found.");
    if (
      !["Cognito_Subject", "sub", "NameID", ...Object.keys(provider.attributeMapping)].includes(source.attributeName)
    ) throw new AwsError("InvalidParameterException", "SourceUser.ProviderAttributeName is not mapped by the provider.");
    const key = this.federatedIdentityKey(pool, provider.name, source.attributeValue);
    const owner = pool.federatedIdentityIndex[key];
    if (owner && owner !== user.sub) {
      throw new AwsError("AliasExistsException", "The external identity is already linked to another user.");
    }
    if (owner === user.sub) return {};
    if (user.externalIdentities.length >= 5) {
      throw new AwsError("LimitExceededException", "A user can have at most five linked identities.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const currentUser = current.usersBySub[user.sub];
      if (!currentUser || current.federatedIdentityIndex[key]) {
        throw new AwsError("AliasExistsException", "The external identity changed concurrently.");
      }
      currentUser.externalIdentities.push({
        providerName: provider.name,
        providerType: provider.type,
        providerSubject: source.attributeValue,
        providerAttributeName: source.attributeName,
        linkedAt: this.clock.now(),
      });
      current.federatedIdentityIndex[key] = currentUser.sub;
      currentUser.updatedAt = this.clock.now();
      current.updatedAt = currentUser.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminDisableProviderForUser(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "User"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminDisableProviderForUser contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const selected = this.providerUserIdentifier(input.User, "User");
    const provider = pool.identityProviders[selected.providerName];
    if (!provider) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
    const key = this.federatedIdentityKey(pool, provider.name, selected.attributeValue);
    const sub = pool.federatedIdentityIndex[key];
    const user = sub ? pool.usersBySub[sub] : undefined;
    if (!user) throw new AwsError("UserNotFoundException", "Linked external user not found.");
    const identity = user.externalIdentities.find(candidate =>
      candidate.providerName === provider.name
      && candidate.providerSubject === selected.attributeValue
    );
    if (!identity) throw new AwsError("UserNotFoundException", "Linked external user not found.");
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const currentUser = current.usersBySub[user.sub];
      if (!currentUser || current.federatedIdentityIndex[key] !== currentUser.sub) {
        throw new AwsError("UserNotFoundException", "Linked external user not found.");
      }
      currentUser.externalIdentities = currentUser.externalIdentities.filter(candidate =>
        !(candidate.providerName === provider.name && candidate.providerSubject === selected.attributeValue)
      );
      delete current.federatedIdentityIndex[key];
      if (currentUser.status === "EXTERNAL_PROVIDER" && currentUser.externalIdentities.length === 0) {
        this.removeUser(current, currentUser);
      } else {
        currentUser.updatedAt = this.clock.now();
        current.updatedAt = currentUser.updatedAt;
      }
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private resourceServerIdentifier(value: unknown): string {
    if (
      typeof value !== "string"
      || value.length < 1
      || value.length > 256
      || !/^[A-Za-z0-9._~:/-]+$/.test(value)
      || value.endsWith("/")
    ) {
      throw new AwsError("InvalidParameterException", "Identifier is invalid.");
    }
    return value;
  }

  private resourceServerScopes(value: unknown): CognitoResourceServerState["scopes"] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100) {
      throw new AwsError("InvalidParameterException", "Scopes must contain at most 100 entries.");
    }
    const names = new Set<string>();
    return value.map((scope, index) => {
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw new AwsError("InvalidParameterException", `Scopes[${index}] is invalid.`);
      }
      if (Object.keys(scope).some(key => !["ScopeName", "ScopeDescription"].includes(key))) {
        throw new AwsError("InvalidParameterException", `Scopes[${index}] contains an unsupported field.`);
      }
      const name = scope.ScopeName;
      const description = scope.ScopeDescription;
      if (
        typeof name !== "string"
        || name.length < 1
        || name.length > 256
        || !/^[A-Za-z0-9._~-]+$/.test(name)
        || typeof description !== "string"
        || description.length < 1
        || description.length > 256
        || names.has(name)
      ) {
        throw new AwsError("InvalidParameterException", `Scopes[${index}] is invalid.`);
      }
      names.add(name);
      return { name, description };
    });
  }

  private resourceServerView(poolIdValue: string, resource: CognitoResourceServerState): Record<string, unknown> {
    return {
      UserPoolId: poolIdValue,
      Identifier: resource.identifier,
      Name: resource.name,
      Scopes: resource.scopes.map(scope => ({
        ScopeName: scope.name,
        ScopeDescription: scope.description,
      })),
    };
  }

  async CreateResourceServer(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Identifier", "Name", "Scopes"].includes(key))) {
      throw new AwsError("InvalidParameterException", "CreateResourceServer contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const identifier = this.resourceServerIdentifier(input.Identifier);
    const name = cognitoName(input.Name, "Name");
    const scopes = this.resourceServerScopes(input.Scopes);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (current.resourceServers[identifier]) {
        throw new AwsError("InvalidParameterException", "Resource server already exists.");
      }
      if (Object.keys(current.resourceServers).length >= 25) {
        throw new AwsError("LimitExceededException", "Resource-server limit exceeded.");
      }
      const now = this.clock.now();
      const resource: CognitoResourceServerState = {
        identifier,
        name,
        scopes,
        createdAt: now,
        updatedAt: now,
      };
      current.resourceServers[identifier] = resource;
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { ResourceServer: this.resourceServerView(current.id, resource) };
    });
  }

  DescribeResourceServer(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "Identifier"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DescribeResourceServer contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const identifier = this.resourceServerIdentifier(input.Identifier);
    const resource = pool.resourceServers[identifier];
    if (!resource) throw new AwsError("ResourceNotFoundException", "Resource server not found.");
    return { ResourceServer: this.resourceServerView(pool.id, resource) };
  }

  ListResourceServers(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "MaxResults", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListResourceServers contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const max = input.MaxResults === undefined ? 60 : input.MaxResults;
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new AwsError("InvalidParameterException", "MaxResults must be an integer from 1 through 60.");
    }
    let index = 0;
    if (input.NextToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{ poolId: string; revision: number; index: number }>(
          "ListResourceServers",
          input.NextToken,
        );
        if (
          cursor.poolId !== pool.id
          || cursor.revision !== this.state.revision
          || !Number.isInteger(cursor.index)
          || cursor.index < 0
        ) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const resources = Object.values(pool.resourceServers)
      .sort((left, right) => left.identifier.localeCompare(right.identifier));
    const page = resources.slice(index, index + max);
    const next = index + page.length;
    return {
      ResourceServers: page.map(resource => this.resourceServerView(pool.id, resource)),
      ...(next < resources.length
        ? {
            NextToken: this.tokens.encode("ListResourceServers", {
              poolId: pool.id,
              revision: this.state.revision,
              index: next,
            }),
          }
        : {}),
    };
  }

  async UpdateResourceServer(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Identifier", "Name", "Scopes"].includes(key))) {
      throw new AwsError("InvalidParameterException", "UpdateResourceServer contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const identifier = this.resourceServerIdentifier(input.Identifier);
    const existing = pool.resourceServers[identifier];
    if (!existing) throw new AwsError("ResourceNotFoundException", "Resource server not found.");
    const name = cognitoName(input.Name, "Name");
    const scopes = this.resourceServerScopes(input.Scopes);
    const nextScopeNames = new Set(scopes.map(scope => `${identifier}/${scope.name}`));
    for (const client of Object.values(pool.clients)) {
      if (client.allowedOAuthScopes.some(scope => scope.startsWith(`${identifier}/`) && !nextScopeNames.has(scope))) {
        throw new AwsError(
          "InvalidParameterException",
          "A removed resource-server scope is still assigned to an app client.",
        );
      }
    }
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = currentPool.resourceServers[identifier];
      if (!current) throw new AwsError("ResourceNotFoundException", "Resource server not found.");
      current.name = name;
      current.scopes = scopes;
      current.updatedAt = this.clock.now();
      currentPool.updatedAt = current.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return { ResourceServer: this.resourceServerView(currentPool.id, current) };
    });
  }

  async DeleteResourceServer(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Identifier"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteResourceServer contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const identifier = this.resourceServerIdentifier(input.Identifier);
    if (!pool.resourceServers[identifier]) {
      throw new AwsError("ResourceNotFoundException", "Resource server not found.");
    }
    if (Object.values(pool.clients).some(client =>
      client.allowedOAuthScopes.some(scope => scope.startsWith(`${identifier}/`))
    )) {
      throw new AwsError("InvalidParameterException", "Resource server scopes are assigned to an app client.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (!current.resourceServers[identifier]) {
        throw new AwsError("ResourceNotFoundException", "Resource server not found.");
      }
      delete current.resourceServers[identifier];
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private domainName(value: unknown): string {
    if (
      typeof value !== "string"
      || value.length < 1
      || value.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
    ) {
      throw new AwsError("InvalidParameterException", "Domain is invalid.");
    }
    return value;
  }

  private domainView(pool: CognitoUserPoolState): Record<string, unknown> {
    if (!pool.domain) return {};
    return {
      UserPoolId: pool.id,
      AWSAccountId: this.store.accountId,
      Domain: pool.domain.domain,
      Version: String(pool.domain.managedLoginVersion),
      Status: "ACTIVE",
      ManagedLoginVersion: pool.domain.managedLoginVersion,
    };
  }

  async CreateUserPoolDomain(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["Domain", "UserPoolId", "ManagedLoginVersion"].includes(key))) {
      throw new AwsError(
        "InvalidParameterException",
        "Custom domains, certificates, and replica routing are unavailable in the local Cognito profile.",
      );
    }
    const pool = this.pool(input.UserPoolId);
    const domain = this.domainName(input.Domain);
    const managedLoginVersion = input.ManagedLoginVersion ?? 2;
    if (![1, 2].includes(managedLoginVersion)) {
      throw new AwsError("InvalidParameterException", "ManagedLoginVersion must be 1 or 2.");
    }
    if (!this.publicBaseUrl) {
      throw new AwsError("InvalidParameterException", "The Cognito public origin is not bound.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (current.domain) throw new AwsError("InvalidParameterException", "The user pool already has a domain.");
      if (this.store.listRegions().some(candidate =>
        Boolean(this.store.regionState(candidate).cognito.domainIndex[domain])
      )) throw new AwsError("InvalidParameterException", "Domain already exists.");
      const now = this.clock.now();
      current.domain = {
        domain,
        managedLoginVersion: managedLoginVersion as 1 | 2,
        createdAt: now,
        updatedAt: now,
      };
      this.state.domainIndex[domain] = current.id;
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { ManagedLoginVersion: managedLoginVersion };
    });
  }

  DescribeUserPoolDomain(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => key !== "Domain")) {
      throw new AwsError("InvalidParameterException", "DescribeUserPoolDomain contains an unsupported field.");
    }
    const domain = this.domainName(input.Domain);
    const poolIdValue = this.state.domainIndex[domain];
    const pool = poolIdValue ? this.state.pools[poolIdValue] : undefined;
    return { DomainDescription: pool ? this.domainView(pool) : {} };
  }

  async UpdateUserPoolDomain(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["Domain", "UserPoolId", "ManagedLoginVersion"].includes(key))) {
      throw new AwsError(
        "InvalidParameterException",
        "Custom domains, certificates, and replica routing are unavailable in the local Cognito profile.",
      );
    }
    const pool = this.pool(input.UserPoolId);
    const domain = this.domainName(input.Domain);
    if (!pool.domain || pool.domain.domain !== domain) {
      throw new AwsError("ResourceNotFoundException", "User-pool domain not found.");
    }
    const managedLoginVersion = input.ManagedLoginVersion ?? pool.domain.managedLoginVersion;
    if (![1, 2].includes(managedLoginVersion)) {
      throw new AwsError("InvalidParameterException", "ManagedLoginVersion must be 1 or 2.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (!current.domain || current.domain.domain !== domain) {
        throw new AwsError("ResourceNotFoundException", "User-pool domain not found.");
      }
      current.domain.managedLoginVersion = managedLoginVersion as 1 | 2;
      current.domain.updatedAt = this.clock.now();
      current.updatedAt = current.domain.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return { ManagedLoginVersion: managedLoginVersion };
    });
  }

  async DeleteUserPoolDomain(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["Domain", "UserPoolId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteUserPoolDomain contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const domain = this.domainName(input.Domain);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (!current.domain || current.domain.domain !== domain) {
        throw new AwsError("ResourceNotFoundException", "User-pool domain not found.");
      }
      delete current.domain;
      delete this.state.domainIndex[domain];
      current.managedLoginBranding = {};
      current.browserSessions = {};
      current.authorizationCodes = {};
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private brandingSettings(value: unknown): CognitoManagedLoginBrandingState["settings"] {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AwsError("InvalidParameterException", "Settings is invalid.");
    }
    if (Object.keys(value).some(key => !["pageTitle", "primaryColor"].includes(key))) {
      throw new AwsError("InvalidParameterException", "Settings contains an unsupported branding property.");
    }
    const pageTitle = (value as any).pageTitle;
    const primaryColor = (value as any).primaryColor;
    if (pageTitle !== undefined && (typeof pageTitle !== "string" || pageTitle.length < 1 || pageTitle.length > 80)) {
      throw new AwsError("InvalidParameterException", "Settings.pageTitle is invalid.");
    }
    if (primaryColor !== undefined && (typeof primaryColor !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(primaryColor))) {
      throw new AwsError("InvalidParameterException", "Settings.primaryColor is invalid.");
    }
    return {
      ...(pageTitle === undefined ? {} : { pageTitle }),
      ...(primaryColor === undefined ? {} : { primaryColor }),
    };
  }

  private brandingView(pool: CognitoUserPoolState, branding: CognitoManagedLoginBrandingState): Record<string, unknown> {
    return {
      ManagedLoginBrandingId: branding.id,
      UserPoolId: pool.id,
      ClientId: branding.clientId,
      UseCognitoProvidedValues: branding.useCognitoProvidedValues,
      ...(branding.settings ? { Settings: structuredClone(branding.settings) } : {}),
      Assets: [],
      CreationDate: timestamp(branding.createdAt),
      LastModifiedDate: timestamp(branding.updatedAt),
    };
  }

  async CreateManagedLoginBranding(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["UserPoolId", "ClientId", "UseCognitoProvidedValues", "Settings"].includes(key))) {
      throw new AwsError("InvalidParameterException", "Managed-login image assets are unavailable.");
    }
    const pool = this.pool(input.UserPoolId);
    const client = this.appClient(pool, input.ClientId);
    if (!pool.domain || pool.domain.managedLoginVersion !== 2) {
      throw new AwsError("InvalidParameterException", "Managed-login version 2 domain is required.");
    }
    const supplied = input.UseCognitoProvidedValues ?? input.Settings === undefined;
    if (typeof supplied !== "boolean" || supplied && input.Settings !== undefined) {
      throw new AwsError("InvalidParameterException", "UseCognitoProvidedValues and Settings are mutually exclusive.");
    }
    const settings = this.brandingSettings(input.Settings);
    if (Object.values(pool.managedLoginBranding).some(value => value.clientId === client.id)) {
      throw new AwsError("InvalidParameterException", "Managed-login branding already exists for this app client.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      this.appClient(current, client.id);
      const now = this.clock.now();
      const branding: CognitoManagedLoginBrandingState = {
        id: randomUUID(),
        clientId: client.id,
        useCognitoProvidedValues: supplied,
        ...(settings ? { settings } : {}),
        createdAt: now,
        updatedAt: now,
      };
      current.managedLoginBranding[branding.id] = branding;
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { ManagedLoginBranding: this.brandingView(current, branding) };
    });
  }

  private branding(pool: CognitoUserPoolState, id: unknown): CognitoManagedLoginBrandingState {
    if (typeof id !== "string" || id.length > 128 || !pool.managedLoginBranding[id]) {
      throw new AwsError("ResourceNotFoundException", "Managed-login branding not found.");
    }
    return pool.managedLoginBranding[id];
  }

  DescribeManagedLoginBranding(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "ManagedLoginBrandingId", "ReturnMergedResources"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DescribeManagedLoginBranding contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    return { ManagedLoginBranding: this.brandingView(pool, this.branding(pool, input.ManagedLoginBrandingId)) };
  }

  DescribeManagedLoginBrandingByClient(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "ClientId", "ReturnMergedResources"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DescribeManagedLoginBrandingByClient contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const client = this.appClient(pool, input.ClientId);
    const branding = Object.values(pool.managedLoginBranding).find(value => value.clientId === client.id);
    if (!branding) throw new AwsError("ResourceNotFoundException", "Managed-login branding not found.");
    return { ManagedLoginBranding: this.brandingView(pool, branding) };
  }

  async UpdateManagedLoginBranding(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["UserPoolId", "ManagedLoginBrandingId", "UseCognitoProvidedValues", "Settings"].includes(key))) {
      throw new AwsError("InvalidParameterException", "Managed-login image assets are unavailable.");
    }
    const pool = this.pool(input.UserPoolId);
    const existing = this.branding(pool, input.ManagedLoginBrandingId);
    const supplied = input.UseCognitoProvidedValues ?? input.Settings === undefined;
    if (typeof supplied !== "boolean" || supplied && input.Settings !== undefined) {
      throw new AwsError("InvalidParameterException", "UseCognitoProvidedValues and Settings are mutually exclusive.");
    }
    const settings = this.brandingSettings(input.Settings);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.branding(currentPool, existing.id);
      current.useCognitoProvidedValues = supplied;
      current.settings = settings;
      current.updatedAt = this.clock.now();
      currentPool.updatedAt = current.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return { ManagedLoginBranding: this.brandingView(currentPool, current) };
    });
  }

  async DeleteManagedLoginBranding(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "ManagedLoginBrandingId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteManagedLoginBranding contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const existing = this.branding(pool, input.ManagedLoginBrandingId);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      this.branding(current, existing.id);
      delete current.managedLoginBranding[existing.id];
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  GetUICustomization(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "ClientId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "GetUICustomization contains an unsupported field.");
    }
    const pool = this.pool(input.UserPoolId);
    const clientIdValue = input.ClientId === undefined ? "ALL" : String(input.ClientId);
    if (clientIdValue !== "ALL") this.appClient(pool, clientIdValue);
    const customization = pool.uiCustomizations[clientIdValue];
    return {
      UICustomization: {
        UserPoolId: pool.id,
        ClientId: clientIdValue,
        CSS: customization?.css ?? "",
        CSSVersion: customization?.cssVersion ?? "0",
        CreationDate: timestamp(customization?.createdAt ?? pool.createdAt),
        LastModifiedDate: timestamp(customization?.updatedAt ?? pool.updatedAt),
      },
    };
  }

  async SetUICustomization(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["UserPoolId", "ClientId", "CSS"].includes(key))) {
      throw new AwsError("InvalidParameterException", "Classic hosted-UI image assets are unavailable.");
    }
    const pool = this.pool(input.UserPoolId);
    const clientIdValue = input.ClientId === undefined ? "ALL" : String(input.ClientId);
    if (clientIdValue !== "ALL") this.appClient(pool, clientIdValue);
    const css = input.CSS;
    if (
      typeof css !== "string"
      || Buffer.byteLength(css, "utf8") > 20_000
      || /(?:@import|url\s*\(|expression\s*\(|<\/style)/i.test(css)
    ) {
      throw new AwsError("InvalidParameterException", "CSS contains unsupported or unsafe content.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const now = this.clock.now();
      const createdAt = current.uiCustomizations[clientIdValue]?.createdAt ?? now;
      current.uiCustomizations[clientIdValue] = {
        clientId: clientIdValue,
        css,
        cssVersion: createHash("sha256").update(css).digest("hex").slice(0, 16),
        createdAt,
        updatedAt: now,
      };
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return this.GetUICustomization({ UserPoolId: current.id, ClientId: clientIdValue });
    });
  }

  async AddCustomAttributes(input: Record<string, any>): Promise<Record<string, never>> {
    if (
      Object.keys(input).some(key => !["UserPoolId", "CustomAttributes"].includes(key))
      || !Array.isArray(input.CustomAttributes)
      || input.CustomAttributes.length < 1
    ) {
      throw new AwsError("InvalidParameterException", "AddCustomAttributes parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const parsed = createPoolConfiguration({
      PoolName: pool.name,
      Schema: input.CustomAttributes,
    }, {
      accountId: this.store.accountId,
      region: this.region,
    }).schemaAttributes;
    if (parsed.some(attribute => STANDARD_USER_ATTRIBUTES.has(attribute.name))) {
      throw new AwsError("InvalidParameterException", "Only custom attributes can be added.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      for (const attribute of parsed) {
        if (current.configuration.schemaAttributes.some(existing => existing.name === attribute.name)) {
          throw new AwsError("InvalidParameterException", `Attribute ${attribute.name} already exists.`);
        }
      }
      if (current.configuration.schemaAttributes.length + parsed.length > 50) {
        throw new AwsError("LimitExceededException", "Custom attribute limit exceeded.");
      }
      current.configuration.schemaAttributes.push(...parsed);
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminCreateUser(input: Record<string, any>): Promise<Record<string, unknown>> {
    const allowed = [
      "UserPoolId", "Username", "UserAttributes", "ValidationData", "TemporaryPassword",
      "ForceAliasCreation", "MessageAction", "DesiredDeliveryMediums", "ClientMetadata",
    ];
    const unknown = Object.keys(input).find(key => !allowed.includes(key));
    if (unknown) throw new AwsError("InvalidParameterException", `AdminCreateUser does not support ${unknown}.`);
    const pool = this.pool(input.UserPoolId);
    const submittedUsername = modeledUsername(input.Username);
    stringRecord(input.ClientMetadata, "ClientMetadata");
    if (input.ValidationData !== undefined && !Array.isArray(input.ValidationData)) {
      throw new AwsError("InvalidParameterException", "ValidationData must be an array.");
    }
    if (input.ForceAliasCreation !== undefined && typeof input.ForceAliasCreation !== "boolean") {
      throw new AwsError("InvalidParameterException", "ForceAliasCreation must be a boolean.");
    }
    if (input.MessageAction !== undefined && !["RESEND", "SUPPRESS"].includes(input.MessageAction)) {
      throw new AwsError("InvalidParameterException", "MessageAction must be RESEND or SUPPRESS.");
    }
    const mediums = input.DesiredDeliveryMediums ?? ["EMAIL"];
    if (!Array.isArray(mediums) || mediums.length !== 1 || mediums[0] !== "EMAIL") {
      throw new AwsError("InvalidParameterException", "Only EMAIL invitation delivery is available.");
    }

    const existing = (() => {
      try { return this.adminUser(pool, submittedUsername); } catch { return undefined; }
    })();
    if (input.MessageAction === "RESEND") {
      if (!existing || existing.status !== "FORCE_CHANGE_PASSWORD") {
        throw new AwsError("UserNotFoundException", "User does not exist or cannot receive an invitation.");
      }
      const temporaryPassword = typeof input.TemporaryPassword === "string"
        ? input.TemporaryPassword
        : this.generatedPassword(pool);
      validatePasswordPolicy(temporaryPassword, pool.configuration.policies.passwordPolicy);
      const hash = await this.passwords.hash(temporaryPassword);
      let intentId: string | undefined;
      await this.exclusive(async () => {
        const currentPool = this.pool(pool.id);
        const user = this.adminUser(currentPool, existing.username);
        const previous = {
          password: user.password,
          srp: user.srp,
          passwordHistory: [...user.passwordHistory],
          passwordChangedAt: user.passwordChangedAt,
          temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt,
        };
        user.password = hash;
        user.srp = srpCredential(currentPool, user.username, temporaryPassword);
        user.passwordHistory = [];
        user.passwordChangedAt = this.clock.now();
        user.temporaryPasswordExpiresAt = this.clock.now()
          + currentPool.configuration.policies.passwordPolicy.temporaryPasswordValidityDays * 86_400_000;
        let intent: CognitoDeliveryIntentState;
        try {
          intent = this.newAdminInvitationIntent(currentPool, user, temporaryPassword);
          await this.applyCustomMessage(
            currentPool,
            ({ id: "ADMIN_CREATE_USER" } as CognitoAppClientState),
            user,
            intent,
            stringRecord(input.ClientMetadata, "ClientMetadata"),
          );
        } catch (error) {
          user.password = previous.password;
          user.srp = previous.srp;
          user.passwordHistory = previous.passwordHistory;
          user.passwordChangedAt = previous.passwordChangedAt;
          user.temporaryPasswordExpiresAt = previous.temporaryPasswordExpiresAt;
          throw error;
        }
        this.state.deliveryIntents[intent.id] = intent;
        intentId = intent.id;
        currentPool.updatedAt = this.clock.now();
        this.state.revision += 1;
        await this.store.save();
      });
      try {
        await this.deliverIntent(intentId!);
      } catch {
        throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the invitation.");
      }
      return { User: userView(this.adminUser(this.pool(pool.id), existing.username)) };
    }
    if (existing) throw new AwsError("UsernameExistsException", "User account already exists.");

    const requireEmail = pool.configuration.schemaAttributes.some(attribute =>
      attribute.name === "email" && attribute.required
    );
    const attributes = this.parsedAttributes(pool, input.UserAttributes, {
      username: submittedUsername,
      allowVerified: true,
      requireEmail,
    });
    await this.invokeTrigger(
      pool,
      undefined,
      { username: submittedUsername, attributes },
      "preSignUp",
      "PreSignUp_AdminCreateUser",
      {
        validationData: Object.fromEntries(
          Array.isArray(input.ValidationData)
            ? input.ValidationData
                .filter((entry: any) => typeof entry?.Name === "string" && typeof entry?.Value === "string")
                .map((entry: any) => [entry.Name, entry.Value])
            : [],
        ),
        clientMetadata: stringRecord(input.ClientMetadata, "ClientMetadata"),
      },
    );
    if (!attributes.email && input.MessageAction !== "SUPPRESS") {
      throw new AwsError("InvalidParameterException", "An email attribute is required for invitation delivery.");
    }
    const usernameKey = pool.configuration.usernameAttributes.includes("email")
      ? cognitoEmail(submittedUsername).canonical
      : canonicalUsername(pool, submittedUsername);
    if (pool.usernameIndex[usernameKey]) {
      throw new AwsError("UsernameExistsException", "User account already exists.");
    }
    if (attributes.email?.verified && pool.configuration.aliasAttributes.includes("email")) {
      const aliasKey = cognitoEmail(attributes.email.value).canonical;
      const priorSub = pool.aliasIndex[aliasKey];
      if (priorSub && input.ForceAliasCreation !== true) {
        throw new AwsError("AliasExistsException", "An account with the email already exists.");
      }
    }
    const temporaryPassword = typeof input.TemporaryPassword === "string"
      ? input.TemporaryPassword
      : this.generatedPassword(pool);
    validatePasswordPolicy(temporaryPassword, pool.configuration.policies.passwordPolicy);
    const password = await this.passwords.hash(temporaryPassword);
    const now = this.clock.now();
    const sub = randomUUID();
    const user: CognitoUserState = {
      sub,
      username: pool.configuration.usernameAttributes.includes("email") ? sub : submittedUsername,
      generationId: randomBytes(16).toString("base64url"),
      enabled: true,
      status: "FORCE_CHANGE_PASSWORD",
      createdAt: now,
      updatedAt: now,
      attributes,
      password,
      srp: srpCredential(
        pool,
        pool.configuration.usernameAttributes.includes("email") ? sub : submittedUsername,
        temporaryPassword,
      ),
      passwordHistory: [],
      passwordChangedAt: now,
      temporaryPasswordExpiresAt: now
        + pool.configuration.policies.passwordPolicy.temporaryPasswordValidityDays * 86_400_000,
      activeAttributeVerificationIntentIds: {},
      groupNames: [],
      mfa: {},
      userMfaSettingList: [],
      devices: {},
      pendingDevices: {},
      sessionEpoch: 0,
      externalIdentities: [],
    };
    let intentId: string | undefined;
    await this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (current.usernameIndex[usernameKey]) {
        throw new AwsError("UsernameExistsException", "User account already exists.");
      }
      let invitation: CognitoDeliveryIntentState | undefined;
      if (input.MessageAction !== "SUPPRESS") {
        invitation = this.newAdminInvitationIntent(current, user, temporaryPassword);
        await this.applyCustomMessage(
          current,
          ({ id: "ADMIN_CREATE_USER" } as CognitoAppClientState),
          user,
          invitation,
          stringRecord(input.ClientMetadata, "ClientMetadata"),
        );
      }
      current.usersBySub[sub] = user;
      current.usernameIndex[usernameKey] = sub;
      if (attributes.email?.verified && current.configuration.aliasAttributes.includes("email")) {
        const aliasKey = cognitoEmail(attributes.email.value).canonical;
        const priorSub = current.aliasIndex[aliasKey];
        if (priorSub && priorSub !== sub) {
          const prior = current.usersBySub[priorSub];
          if (prior?.attributes.email) prior.attributes.email.verified = false;
        }
        current.aliasIndex[aliasKey] = sub;
      }
      if (invitation) {
        this.state.deliveryIntents[invitation.id] = invitation;
        intentId = invitation.id;
      }
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
    });
    if (intentId) {
      try {
        await this.deliverIntent(intentId);
      } catch {
        throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the invitation.");
      }
    }
    return { User: userView(this.adminUser(this.pool(pool.id), user.username)) };
  }

  AdminGetUser(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminGetUser parameters are invalid.");
    }
    const user = this.adminUser(this.pool(input.UserPoolId), input.Username);
    return {
      Username: user.username,
      UserAttributes: userAttributesView(user),
      UserCreateDate: timestamp(user.createdAt),
      UserLastModifiedDate: timestamp(user.updatedAt),
      Enabled: user.enabled,
      UserStatus: user.status,
      MFAOptions: [],
      PreferredMfaSetting: user.preferredMfaSetting,
      UserMFASettingList: [...user.userMfaSettingList],
    };
  }

  ListUsers(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "AttributesToGet", "Limit", "PaginationToken", "Filter"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListUsers parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const limit = input.Limit ?? 60;
    if (!Number.isInteger(limit) || limit < 0 || limit > 60) {
      throw new AwsError("InvalidParameterException", "Limit must be from 0 through 60.");
    }
    let users = Object.values(pool.usersBySub).sort((left, right) =>
      left.username.localeCompare(right.username) || left.sub.localeCompare(right.sub)
    );
    if (input.Filter !== undefined) {
      if (typeof input.Filter !== "string" || input.Filter.length > 256) {
        throw new AwsError("InvalidParameterException", "Filter is invalid.");
      }
      const match = /^(username|email|status|cognito:user_status)\s*(=|\^=)\s*"([^"]*)"$/.exec(input.Filter);
      if (!match) throw new AwsError("InvalidParameterException", "Filter is invalid.");
      const [, field, operator, expected] = match;
      users = users.filter(user => {
        const value = field === "username"
          ? user.username
          : field === "email"
            ? user.attributes.email?.value ?? ""
            : user.status;
        return operator === "=" ? value === expected : value.startsWith(expected);
      });
    }
    let index = 0;
    if (input.PaginationToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{ poolId: string; revision: number; index: number }>(
          "ListUsers",
          input.PaginationToken,
        );
        if (cursor.poolId !== pool.id || cursor.revision !== this.state.revision || !Number.isInteger(cursor.index)) {
          throw new Error();
        }
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "PaginationToken is invalid.");
      }
    }
    const page = users.slice(index, index + limit);
    const next = index + page.length;
    return {
      Users: page.map(userView),
      ...(next < users.length
        ? {
            PaginationToken: this.tokens.encode("ListUsers", {
              poolId: pool.id,
              revision: this.state.revision,
              index: next,
            }),
          }
        : {}),
    };
  }

  async AdminConfirmSignUp(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "ClientMetadata"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminConfirmSignUp parameters are invalid.");
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    if (user.status !== "UNCONFIRMED") {
      throw new AwsError("NotAuthorizedException", "User cannot be confirmed in the current state.");
    }
    await this.exclusive(async () => {
      const current = this.adminUser(this.pool(pool.id), user.username);
      current.status = "CONFIRMED";
      current.updatedAt = this.clock.now();
      if (current.activeConfirmationIntentId) {
        const intent = this.state.deliveryIntents[current.activeConfirmationIntentId];
        if (intent?.status === "DELIVERED") {
          intent.status = "CONSUMED";
          intent.statusUpdatedAt = this.clock.now();
        }
        current.activeConfirmationIntentId = undefined;
      }
      this.state.revision += 1;
      await this.store.save();
    });
    await this.invokeTrigger(
      this.pool(pool.id),
      undefined,
      this.adminUser(this.pool(pool.id), user.username),
      "postConfirmation",
      "PostConfirmation_ConfirmSignUp",
      { clientMetadata: stringRecord(input.ClientMetadata, "ClientMetadata") },
    );
    return {};
  }

  private async setUserEnabled(input: Record<string, any>, enabled: boolean): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username"].includes(key))) {
      throw new AwsError("InvalidParameterException", "Administrator user parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      if (current.enabled !== enabled) {
        current.enabled = enabled;
        current.updatedAt = this.clock.now();
        if (!enabled) this.revokeUserSessions(currentPool, current, "USER_DISABLED");
        this.state.revision += 1;
        await this.store.save();
      }
      return {};
    });
  }

  AdminEnableUser(input: Record<string, any>): Promise<Record<string, never>> {
    return this.setUserEnabled(input, true);
  }

  AdminDisableUser(input: Record<string, any>): Promise<Record<string, never>> {
    return this.setUserEnabled(input, false);
  }

  async AdminDeleteUser(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminDeleteUser parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      this.removeUser(currentPool, current);
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminSetUserPassword(input: Record<string, any>): Promise<Record<string, never>> {
    if (
      Object.keys(input).some(key => !["UserPoolId", "Username", "Password", "Permanent"].includes(key))
      || typeof input.Password !== "string"
      || typeof input.Permanent !== "boolean"
    ) {
      throw new AwsError("InvalidParameterException", "AdminSetUserPassword parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    validatePasswordPolicy(input.Password, pool.configuration.policies.passwordPolicy);
    const history = [user.password, ...user.passwordHistory];
    for (const prior of history.slice(0, pool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0)) {
      if (await this.passwords.verify(input.Password, prior)) {
        throw new AwsError("PasswordHistoryPolicyViolationException", "Password was used recently.");
      }
    }
    const password = await this.passwords.hash(input.Password);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      current.passwordHistory = [current.password, ...current.passwordHistory]
        .slice(0, currentPool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0);
      current.password = password;
      current.srp = srpCredential(currentPool, current.username, input.Password);
      current.passwordChangedAt = this.clock.now();
      current.status = input.Permanent ? "CONFIRMED" : "FORCE_CHANGE_PASSWORD";
      current.temporaryPasswordExpiresAt = input.Permanent
        ? undefined
        : this.clock.now() + currentPool.configuration.policies.passwordPolicy.temporaryPasswordValidityDays * 86_400_000;
      this.revokeUserSessions(currentPool, current, "PASSWORD_CHANGED");
      currentPool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminResetUserPassword(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "ClientMetadata"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminResetUserPassword parameters are invalid.");
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    if (!user.attributes.email?.verified) {
      throw new AwsError("InvalidParameterException", "User has no verified email recovery destination.");
    }
    let intentId: string | undefined;
    await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      const deliveryClient = Object.values(currentPool.clients)[0]
        ?? ({ id: "ADMIN_RESET_PASSWORD" } as CognitoAppClientState);
      const intent = this.newDeliveryIntent(currentPool, deliveryClient, current, "PASSWORD_RESET");
      await this.applyCustomMessage(
        currentPool,
        deliveryClient,
        current,
        intent,
        stringRecord(input.ClientMetadata, "ClientMetadata"),
      );
      current.status = "RESET_REQUIRED";
      this.revokeUserSessions(currentPool, current, "PASSWORD_CHANGED");
      this.state.deliveryIntents[intent.id] = intent;
      intentId = intent.id;
      currentPool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
    });
    try {
      await this.deliverIntent(intentId!);
    } catch {
      throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the password reset code.");
    }
    return {};
  }

  async AdminUserGlobalSignOut(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminUserGlobalSignOut parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      this.revokeUserSessions(currentPool, current, "GLOBAL_SIGN_OUT");
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async TagResource(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["ResourceArn", "Tags"].includes(key))) {
      throw new AwsError("InvalidParameterException", "TagResource parameters are invalid.");
    }
    const pool = Object.values(this.state.pools).find(candidate => candidate.arn === input.ResourceArn);
    if (!pool) throw new AwsError("ResourceNotFoundException", "User pool not found.");
    const tags = tagMap(input.Tags);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const merged = { ...current.tags, ...tags };
      if (Object.keys(merged).length > 50) throw new AwsError("TooManyTagsException", "Too many tags.");
      current.tags = merged;
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async UntagResource(input: Record<string, any>): Promise<Record<string, never>> {
    if (
      Object.keys(input).some(key => !["ResourceArn", "TagKeys"].includes(key))
      || !Array.isArray(input.TagKeys)
      || input.TagKeys.some((key: unknown) => typeof key !== "string")
    ) {
      throw new AwsError("InvalidParameterException", "UntagResource parameters are invalid.");
    }
    const pool = Object.values(this.state.pools).find(candidate => candidate.arn === input.ResourceArn);
    if (!pool) throw new AwsError("ResourceNotFoundException", "User pool not found.");
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      for (const key of input.TagKeys) delete current.tags[key];
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  ListTagsForResource(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => key !== "ResourceArn")) {
      throw new AwsError("InvalidParameterException", "ListTagsForResource parameters are invalid.");
    }
    const pool = Object.values(this.state.pools).find(candidate => candidate.arn === input.ResourceArn);
    if (!pool) throw new AwsError("ResourceNotFoundException", "User pool not found.");
    return { Tags: { ...pool.tags } };
  }

  async CreateGroup(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["GroupName", "UserPoolId", "Description", "RoleArn", "Precedence"].includes(key))) {
      throw new AwsError("InvalidParameterException", "CreateGroup parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const name = groupName(input.GroupName);
    const descriptor = this.groupDescriptor(input);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      if (current.groups[name]) throw new AwsError("GroupExistsException", "Group already exists.");
      const now = this.clock.now();
      current.groups[name] = { name, ...descriptor, createdAt: now, updatedAt: now };
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { Group: groupView(current.groups[name]) };
    });
  }

  private groupDescriptor(input: Record<string, any>): Pick<
    import("./types.js").CognitoGroupState,
    "description" | "roleArn" | "precedence"
  > {
    if (input.Description !== undefined && (typeof input.Description !== "string" || input.Description.length > 2_048)) {
      throw new AwsError("InvalidParameterException", "Description is invalid.");
    }
    if (
      input.RoleArn !== undefined
      && (
        typeof input.RoleArn !== "string"
        || !/^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(input.RoleArn)
      )
    ) {
      throw new AwsError("InvalidParameterException", "RoleArn is invalid.");
    }
    if (
      input.Precedence !== undefined
      && (!Number.isInteger(input.Precedence) || input.Precedence < 0 || input.Precedence > 2_147_483_647)
    ) {
      throw new AwsError("InvalidParameterException", "Precedence is invalid.");
    }
    return {
      ...(input.Description === undefined ? {} : { description: input.Description }),
      ...(input.RoleArn === undefined ? {} : { roleArn: input.RoleArn }),
      ...(input.Precedence === undefined ? {} : { precedence: input.Precedence }),
    };
  }

  GetGroup(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["GroupName", "UserPoolId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "GetGroup parameters are invalid.");
    }
    const group = this.pool(input.UserPoolId).groups[groupName(input.GroupName)];
    if (!group) throw new AwsError("ResourceNotFoundException", "Group not found.");
    return { Group: groupView(group) };
  }

  ListGroups(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "Limit", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListGroups parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const limit = input.Limit ?? 60;
    if (!Number.isInteger(limit) || limit < 0 || limit > 60) {
      throw new AwsError("InvalidParameterException", "Limit is invalid.");
    }
    const groups = Object.values(pool.groups).sort((left, right) => left.name.localeCompare(right.name));
    let index = 0;
    if (input.NextToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{ poolId: string; revision: number; index: number }>("ListGroups", input.NextToken);
        if (cursor.poolId !== pool.id || cursor.revision !== this.state.revision) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const page = groups.slice(index, index + limit);
    const next = index + page.length;
    return {
      Groups: page.map(groupView),
      ...(next < groups.length
        ? { NextToken: this.tokens.encode("ListGroups", { poolId: pool.id, revision: this.state.revision, index: next }) }
        : {}),
    };
  }

  async UpdateGroup(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["GroupName", "UserPoolId", "Description", "RoleArn", "Precedence"].includes(key))) {
      throw new AwsError("InvalidParameterException", "UpdateGroup parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const name = groupName(input.GroupName);
    if (!pool.groups[name]) throw new AwsError("ResourceNotFoundException", "Group not found.");
    const descriptor = this.groupDescriptor(input);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const group = current.groups[name];
      if (!group) throw new AwsError("ResourceNotFoundException", "Group not found.");
      if (input.Description !== undefined) group.description = descriptor.description;
      if (input.RoleArn !== undefined) group.roleArn = descriptor.roleArn;
      if (input.Precedence !== undefined) group.precedence = descriptor.precedence;
      group.updatedAt = this.clock.now();
      current.updatedAt = group.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return { Group: groupView(group) };
    });
  }

  async DeleteGroup(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["GroupName", "UserPoolId"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteGroup parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const name = groupName(input.GroupName);
    if (!pool.groups[name]) throw new AwsError("ResourceNotFoundException", "Group not found.");
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      delete current.groups[name];
      for (const user of Object.values(current.usersBySub)) {
        user.groupNames = user.groupNames.filter(candidate => candidate !== name);
      }
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private async updateGroupMembership(input: Record<string, any>, add: boolean): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["Username", "UserPoolId", "GroupName"].includes(key))) {
      throw new AwsError("InvalidParameterException", "Group membership parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    const name = groupName(input.GroupName);
    if (!pool.groups[name]) throw new AwsError("ResourceNotFoundException", "Group not found.");
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const member = this.adminUser(current, user.username);
      const names = new Set(member.groupNames);
      if (add) names.add(name); else names.delete(name);
      member.groupNames = [...names].sort();
      member.updatedAt = this.clock.now();
      current.updatedAt = member.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  AdminAddUserToGroup(input: Record<string, any>): Promise<Record<string, never>> {
    return this.updateGroupMembership(input, true);
  }

  AdminRemoveUserFromGroup(input: Record<string, any>): Promise<Record<string, never>> {
    return this.updateGroupMembership(input, false);
  }

  AdminListGroupsForUser(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["Username", "UserPoolId", "Limit", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminListGroupsForUser parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    const limit = input.Limit ?? 60;
    if (!Number.isInteger(limit) || limit < 0 || limit > 60) {
      throw new AwsError("InvalidParameterException", "Limit is invalid.");
    }
    let index = 0;
    if (input.NextToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{
          poolId: string;
          userSub: string;
          revision: number;
          index: number;
        }>("AdminListGroupsForUser", input.NextToken);
        if (
          cursor.poolId !== pool.id
          || cursor.userSub !== user.sub
          || cursor.revision !== this.state.revision
          || !Number.isInteger(cursor.index)
        ) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const groups = user.groupNames.map(name => pool.groups[name]).filter(Boolean).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    const page = groups.slice(index, index + limit);
    const next = index + page.length;
    return {
      Groups: page.map(groupView),
      ...(next < groups.length
        ? {
            NextToken: this.tokens.encode("AdminListGroupsForUser", {
              poolId: pool.id,
              userSub: user.sub,
              revision: this.state.revision,
              index: next,
            }),
          }
        : {}),
    };
  }

  ListUsersInGroup(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["GroupName", "UserPoolId", "Limit", "NextToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListUsersInGroup parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const name = groupName(input.GroupName);
    if (!pool.groups[name]) throw new AwsError("ResourceNotFoundException", "Group not found.");
    const users = Object.values(pool.usersBySub)
      .filter(user => user.groupNames.includes(name))
      .sort((left, right) => left.username.localeCompare(right.username));
    const limit = input.Limit ?? 60;
    if (!Number.isInteger(limit) || limit < 0 || limit > 60) {
      throw new AwsError("InvalidParameterException", "Limit is invalid.");
    }
    let index = 0;
    if (input.NextToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{
          poolId: string;
          groupName: string;
          revision: number;
          index: number;
        }>("ListUsersInGroup", input.NextToken);
        if (
          cursor.poolId !== pool.id
          || cursor.groupName !== name
          || cursor.revision !== this.state.revision
          || !Number.isInteger(cursor.index)
        ) throw new Error();
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "NextToken is invalid.");
      }
    }
    const page = users.slice(index, index + limit);
    const next = index + page.length;
    return {
      Users: page.map(userView),
      ...(next < users.length
        ? {
            NextToken: this.tokens.encode("ListUsersInGroup", {
              poolId: pool.id,
              groupName: name,
              revision: this.state.revision,
              index: next,
            }),
          }
        : {}),
    };
  }

  async SignUp(input: Record<string, any>): Promise<Record<string, unknown>> {
    const located = this.appClientAcrossPools(input.ClientId);
    const { pool, client } = located;
    if (pool.configuration.adminCreateUserConfig.allowAdminCreateUserOnly) {
      throw new AwsError("NotAuthorizedException", "SignUp is not permitted for this user pool.");
    }
    const parsed = parseSignUp(input, pool, client);
    validatePasswordPolicy(parsed.password, pool.configuration.policies.passwordPolicy);
    const provisionalUser = {
      username: pool.configuration.usernameAttributes.includes("email")
        ? parsed.email.value
        : parsed.submittedUsername,
      attributes: { email: { value: parsed.email.value, verified: false } },
    };
    const preSignUp = await this.invokeTrigger(pool, client, provisionalUser, "preSignUp", "PreSignUp_SignUp", {
      validationData: Object.fromEntries(
        Array.isArray(input.ValidationData)
          ? input.ValidationData
              .filter((entry: any) => typeof entry?.Name === "string" && typeof entry?.Value === "string")
              .map((entry: any) => [entry.Name, entry.Value])
          : [],
      ),
      clientMetadata: stringRecord(input.ClientMetadata, "ClientMetadata"),
    });
    const password = await this.passwords.hash(parsed.password);
    const sub = randomUUID();
    const generationId = randomBytes(16).toString("base64url");
    const now = this.clock.now();
    let intentId: string | undefined;
    const user: CognitoUserState = {
      sub,
      username: pool.configuration.usernameAttributes.includes("email") ? sub : parsed.submittedUsername,
      generationId,
      enabled: true,
      status: preSignUp?.autoConfirmUser === true ? "CONFIRMED" : "UNCONFIRMED",
      createdAt: now,
      updatedAt: now,
      attributes: {
        email: {
          value: parsed.email.value,
          verified: preSignUp?.autoVerifyEmail === true,
        },
      },
      password,
      srp: srpCredential(
        pool,
        pool.configuration.usernameAttributes.includes("email") ? sub : parsed.submittedUsername,
        parsed.password,
      ),
      passwordHistory: [],
      passwordChangedAt: now,
      activeAttributeVerificationIntentIds: {},
      groupNames: [],
      mfa: {},
      userMfaSettingList: [],
      devices: {},
      pendingDevices: {},
      sessionEpoch: 0,
      externalIdentities: [],
    };
    await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      if (currentPool.usernameIndex[parsed.usernameIndexKey]) {
        throw new AwsError("UsernameExistsException", "An account with the given username already exists.");
      }
      if (
        user.status === "UNCONFIRMED"
        && currentPool.configuration.autoVerifiedAttributes.includes("email")
      ) {
        const intent = this.newDeliveryIntent(currentPool, currentClient, user, "SIGN_UP");
        await this.applyCustomMessage(
          currentPool,
          currentClient,
          user,
          intent,
          stringRecord(input.ClientMetadata, "ClientMetadata"),
        );
        this.state.deliveryIntents[intent.id] = intent;
        intentId = intent.id;
      }
      currentPool.usersBySub[sub] = user;
      currentPool.usernameIndex[parsed.usernameIndexKey] = sub;
      if (
        user.attributes.email.verified
        && currentPool.configuration.aliasAttributes.includes("email")
      ) {
        const alias = cognitoEmail(user.attributes.email.value).canonical;
        const owner = currentPool.aliasIndex[alias];
        if (owner && owner !== user.sub) throw new AwsError("AliasExistsException", "Email alias exists.");
        currentPool.aliasIndex[alias] = user.sub;
      }
      currentPool.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
    });
    if (intentId) {
      try {
        await this.deliverIntent(intentId);
      } catch {
        throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the confirmation code.");
      }
    }
    return {
      UserConfirmed: user.status === "CONFIRMED",
      UserSub: sub,
      ...(intentId ? {
        CodeDeliveryDetails: {
          Destination: maskEmail(parsed.email.value),
          DeliveryMedium: "EMAIL",
          AttributeName: "email",
        },
      } : {}),
    };
  }

  async ConfirmSignUp(input: Record<string, any>): Promise<Record<string, never>> {
    const unknown = Object.keys(input).find(key => !["ClientId", "SecretHash", "Username", "ConfirmationCode", "ForceAliasCreation"].includes(key));
    if (unknown) throw new AwsError("InvalidParameterException", `ConfirmSignUp does not support ${unknown} in COG-01.`);
    const { pool, client } = this.appClientAcrossPools(input.ClientId);
    modeledUsername(input.Username);
    if (typeof input.ConfirmationCode !== "string") {
      throw new AwsError("CodeMismatchException", "Invalid verification code provided.");
    }
    if (input.ForceAliasCreation !== undefined && typeof input.ForceAliasCreation !== "boolean") {
      throw new AwsError("InvalidParameterException", "ForceAliasCreation must be a boolean.");
    }
    let confirmedUser: CognitoUserState | undefined;
    await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      this.appClient(currentPool, client.id);
      const user = findUserByModeledUsername(currentPool, input.Username);
      if (!user) {
        if (client.preventUserExistenceErrors === "ENABLED") {
          throw new AwsError("CodeMismatchException", "Invalid verification code provided.");
        }
        throw new AwsError("UserNotFoundException", "User does not exist.");
      }
      if (user.status === "CONFIRMED") {
        throw new AwsError("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED.");
      }
      const intent = user.activeConfirmationIntentId
        ? this.state.deliveryIntents[user.activeConfirmationIntentId]
        : undefined;
      if (!intent || intent.status !== "DELIVERED" || intent.userGenerationId !== user.generationId) {
        throw new AwsError("ExpiredCodeException", "Invalid code provided, please request a code again.");
      }
      if (this.clock.now() >= intent.expiresAt) {
        intent.status = "EXPIRED";
        intent.statusUpdatedAt = this.clock.now();
        user.activeConfirmationIntentId = undefined;
        this.state.revision += 1;
        await this.store.save();
        throw new AwsError("ExpiredCodeException", "Invalid code provided, please request a code again.");
      }
      if (intent.attempts >= CONFIRMATION_ATTEMPTS) {
        throw new AwsError("LimitExceededException", "Confirmation code attempt limit exceeded.");
      }
      if (!this.secrets.verifyConfirmationCode(
        input.ConfirmationCode,
        intent.credential.codeDigest,
        this.confirmationBinding(intent),
      )) {
        intent.attempts += 1;
        this.state.revision += 1;
        await this.store.save();
        if (intent.attempts >= CONFIRMATION_ATTEMPTS) {
          throw new AwsError("LimitExceededException", "Confirmation code attempt limit exceeded.");
        }
        throw new AwsError("CodeMismatchException", "Invalid verification code provided.");
      }
      const email = user.attributes.email;
      if (currentPool.configuration.aliasAttributes.includes("email")) {
        const priorSub = currentPool.aliasIndex[email.value.toLowerCase()];
        if (priorSub && priorSub !== user.sub) {
          if (input.ForceAliasCreation !== true) {
            throw new AwsError("AliasExistsException", "An account with the email already exists.");
          }
          const previous = currentPool.usersBySub[priorSub];
          if (previous?.attributes.email) previous.attributes.email.verified = false;
        }
        currentPool.aliasIndex[email.value.toLowerCase()] = user.sub;
      }
      email.verified = true;
      user.status = "CONFIRMED";
      user.updatedAt = this.clock.now();
      user.activeConfirmationIntentId = undefined;
      intent.status = "CONSUMED";
      intent.statusUpdatedAt = this.clock.now();
      for (const other of Object.values(this.state.deliveryIntents)) {
        if (
          other.id !== intent.id
          && other.poolId === currentPool.id
          && other.userSub === user.sub
          && other.userGenerationId === user.generationId
          && other.status === "PENDING_DELIVERY"
        ) {
          other.status = "CANCELLED";
          other.statusUpdatedAt = this.clock.now();
        }
      }
      this.state.revision += 1;
      await this.store.save();
      confirmedUser = structuredClone(user);
    });
    await this.invokeTrigger(
      this.pool(pool.id),
      this.appClient(this.pool(pool.id), client.id),
      confirmedUser!,
      "postConfirmation",
      "PostConfirmation_ConfirmSignUp",
    );
    return {};
  }

  async ResendConfirmationCode(input: Record<string, any>): Promise<Record<string, unknown>> {
    const unknown = Object.keys(input).find(key => !["ClientId", "SecretHash", "Username"].includes(key));
    if (unknown) throw new AwsError("InvalidParameterException", `ResendConfirmationCode does not support ${unknown} in COG-01.`);
    const { pool, client } = this.appClientAcrossPools(input.ClientId);
    modeledUsername(input.Username);
    let intentId: string | undefined;
    let email: string | undefined;
    await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      const user = findUserByModeledUsername(currentPool, input.Username);
      if (!user) {
        if (currentClient.preventUserExistenceErrors === "ENABLED") return;
        throw new AwsError("UserNotFoundException", "User does not exist.");
      }
      if (user.status === "CONFIRMED") {
        throw new AwsError("InvalidParameterException", "User is already confirmed.");
      }
      const recent = Object.values(this.state.deliveryIntents).filter(intent =>
        intent.userSub === user.sub
        && intent.purpose === "RESEND_SIGN_UP"
        && intent.issuedAt > this.clock.now() - RESEND_WINDOW_MS,
      ).length;
      if (recent >= RESEND_LIMIT) {
        throw new AwsError("LimitExceededException", "Confirmation code resend limit exceeded.");
      }
      const intent = this.newDeliveryIntent(currentPool, currentClient, user, "RESEND_SIGN_UP");
      await this.applyCustomMessage(currentPool, currentClient, user, intent);
      this.state.deliveryIntents[intent.id] = intent;
      intentId = intent.id;
      email = user.attributes.email.value;
      this.state.revision += 1;
      await this.store.save();
    });
    if (!intentId || !email) {
      return {
        CodeDeliveryDetails: {
          Destination: "p***@e***",
          DeliveryMedium: "EMAIL",
          AttributeName: "email",
        },
      };
    }
    try {
      await this.deliverIntent(intentId);
    } catch {
      throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the confirmation code.");
    }
    return {
      CodeDeliveryDetails: {
        Destination: maskEmail(email),
        DeliveryMedium: "EMAIL",
        AttributeName: "email",
      },
    };
  }

  private newRefreshSession(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    parent?: CognitoRefreshSessionState,
    oauth?: { scopes: string[]; nonce?: string },
  ): { session: CognitoRefreshSessionState; token: string } {
    const token = randomBytes(32).toString("base64url");
    const now = this.clock.now();
    const id = randomBytes(16).toString("base64url");
    const session: CognitoRefreshSessionState = {
      id,
      clientId: client.id,
      userSub: user.sub,
      userGenerationId: user.generationId,
      sessionEpoch: user.sessionEpoch,
      secretHashUsername: pool.configuration.usernameAttributes.includes("email")
        ? user.sub
        : user.username,
      tokenDigest: this.secrets.refreshTokenDigest(token, {
        accountId: this.store.accountId,
        region: this.region,
        poolId: pool.id,
        clientId: client.id,
      }),
      eventId: parent?.eventId ?? randomUUID(),
      originJti: parent?.originJti ?? randomUUID(),
      authTime: parent?.authTime ?? now,
      issuedAt: now,
      expiresAt: parent?.expiresAt ?? (
        now + validitySeconds(
          client.refreshTokenValidity,
          client.tokenValidityUnits.refreshToken,
        ) * 1_000
      ),
      lastUsedAt: now,
      status: "ACTIVE",
      familyId: parent?.familyId ?? parent?.id ?? id,
      ...(parent ? { parentSessionId: parent.id } : {}),
      ...(oauth?.scopes ?? parent?.oauthScopes
        ? { oauthScopes: [...(oauth?.scopes ?? parent!.oauthScopes!)] }
        : {}),
      ...(oauth?.nonce ?? parent?.oauthNonce
        ? { oauthNonce: oauth?.nonce ?? parent?.oauthNonce }
        : {}),
    };
    return { session, token };
  }

  private async authenticationResult(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    session: CognitoRefreshSessionState,
    refreshToken?: string,
    clientMetadata: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    if (!pool.signingKeys) throw new AwsError("InternalErrorException", "Cognito signing keys are unavailable.", 500);
    const issuer = cognitoIssuer(this.region, pool.id);
    const now = Math.floor(this.clock.now() / 1_000);
    const authTime = Math.floor(session.authTime / 1_000);
    const accessLifetime = validitySeconds(client.accessTokenValidity, client.tokenValidityUnits.accessToken);
    const idLifetime = validitySeconds(client.idTokenValidity, client.tokenValidityUnits.idToken);
    const oauthScopes = session.oauthScopes;
    const accessScopes = oauthScopes?.length ? oauthScopes : [COGNITO_USER_ADMIN_SCOPE];
    const includeIdToken = oauthScopes === undefined || oauthScopes.includes("openid");
    const revocation = client.enableTokenRevocation
      ? { jti: randomUUID(), origin_jti: session.originJti }
      : {};
    const groups = user.groupNames
      .map(name => pool.groups[name])
      .filter(Boolean)
      .sort((left, right) =>
        (left.precedence ?? Number.MAX_SAFE_INTEGER) - (right.precedence ?? Number.MAX_SAFE_INTEGER)
        || left.name.localeCompare(right.name)
      );
    const roles = groups.flatMap(group => group.roleArn ? [group.roleArn] : []);
    const preferredCandidates = groups.filter(group =>
      group.roleArn && group.precedence === groups.find(candidate => candidate.roleArn)?.precedence
    );
    const preferredRole = preferredCandidates.length === 1 ? preferredCandidates[0].roleArn : undefined;
    const readableAttributes = Object.fromEntries(
      Object.entries(user.attributes)
        .filter(([name]) => client.readAttributes.includes(name))
        .map(([name, attribute]) => [name, attribute.value]),
    );
    if (client.readAttributes.includes("email") && user.attributes.email) {
      readableAttributes.email = user.attributes.email.value;
    }
    const baseIdClaims: Record<string, unknown> = {
      sub: user.sub,
      aud: client.id,
      iss: issuer,
      token_use: "id",
      auth_time: authTime,
      iat: now,
      exp: now + idLifetime,
      "cognito:username": user.username,
      event_id: session.eventId,
      ...(user.externalIdentities.length
        ? {
            identities: user.externalIdentities.map((identity, index) => ({
              userId: identity.providerSubject,
              providerName: identity.providerName,
              providerType: identity.providerType,
              issuer: pool.identityProviders[identity.providerName]?.providerDetails.oidc_issuer
                ?? pool.identityProviders[identity.providerName]?.samlMetadata?.entityId,
              primary: index === 0,
              dateCreated: identity.linkedAt,
            })),
          }
        : {}),
      ...(session.oauthNonce ? { nonce: session.oauthNonce } : {}),
      ...(client.readAttributes.includes("email") && user.attributes.email
        ? {
            email: user.attributes.email.value,
            email_verified: user.attributes.email.verified,
          }
        : {}),
      ...Object.fromEntries(Object.entries(readableAttributes).filter(([name]) => name !== "email")),
      ...(groups.length ? { "cognito:groups": groups.map(group => group.name) } : {}),
      ...(roles.length ? { "cognito:roles": roles } : {}),
      ...(preferredRole ? { "cognito:preferred_role": preferredRole } : {}),
      ...revocation,
    };
    const baseAccessClaims: Record<string, unknown> = {
      sub: user.sub,
      client_id: client.id,
      iss: issuer,
      token_use: "access",
      scope: accessScopes.join(" "),
      auth_time: authTime,
      iat: now,
      exp: now + accessLifetime,
      username: user.username,
      event_id: session.eventId,
      ...(groups.length ? { "cognito:groups": groups.map(group => group.name) } : {}),
      ...(roles.length ? { "cognito:roles": roles } : {}),
      ...(preferredRole ? { "cognito:preferred_role": preferredRole } : {}),
      ...(client.enableTokenRevocation
        ? { jti: randomUUID(), origin_jti: session.originJti }
        : {}),
    };
    const preToken = await this.invokeTrigger(
      pool,
      client,
      user,
      "preTokenGeneration",
      "TokenGeneration_Authentication",
      {
        clientMetadata,
        groupConfiguration: {
          groupsToOverride: groups.map(group => group.name),
          iamRolesToOverride: roles,
          preferredRole,
        },
      },
    );
    const override = preToken?.claimsOverrideDetails;
    if (override !== undefined && (!override || typeof override !== "object" || Array.isArray(override))) {
      throw new AwsError("InvalidLambdaResponseException", "Pre-token claimsOverrideDetails is invalid.");
    }
    if (override?.claimsToAddOrOverride !== undefined) {
      if (
        !override.claimsToAddOrOverride
        || typeof override.claimsToAddOrOverride !== "object"
        || Array.isArray(override.claimsToAddOrOverride)
        || Object.values(override.claimsToAddOrOverride).some(value => typeof value !== "string")
      ) {
        throw new AwsError("InvalidLambdaResponseException", "Pre-token claim overrides are invalid.");
      }
      const reservedClaims = new Set([
        "sub", "aud", "iss", "token_use", "auth_time", "iat", "exp", "event_id",
        "jti", "origin_jti", "cognito:username", "cognito:groups",
        "cognito:roles", "cognito:preferred_role",
      ]);
      if (Object.keys(override.claimsToAddOrOverride).some(claim => reservedClaims.has(claim))) {
        throw new AwsError("InvalidLambdaResponseException", "Pre-token trigger cannot override a reserved claim.");
      }
      Object.assign(baseIdClaims, override.claimsToAddOrOverride);
    }
    if (override?.claimsToSuppress !== undefined) {
      if (!Array.isArray(override.claimsToSuppress) || override.claimsToSuppress.some((value: unknown) => typeof value !== "string")) {
        throw new AwsError("InvalidLambdaResponseException", "Pre-token suppressed claims are invalid.");
      }
      const protectedClaims = new Set(["sub", "aud", "iss", "token_use", "auth_time", "iat", "exp"]);
      for (const claim of override.claimsToSuppress) {
        if (!protectedClaims.has(claim)) delete baseIdClaims[claim];
      }
    }
    const groupOverride = override?.groupOverrideDetails;
    if (groupOverride !== undefined) {
      if (!groupOverride || typeof groupOverride !== "object" || Array.isArray(groupOverride)) {
        throw new AwsError("InvalidLambdaResponseException", "Pre-token group overrides are invalid.");
      }
      const applyGroups = (claims: Record<string, unknown>): void => {
        if (groupOverride.groupsToOverride !== undefined) {
          if (!Array.isArray(groupOverride.groupsToOverride) || groupOverride.groupsToOverride.some((value: unknown) => typeof value !== "string")) {
            throw new AwsError("InvalidLambdaResponseException", "Pre-token group overrides are invalid.");
          }
          if (groupOverride.groupsToOverride.length) claims["cognito:groups"] = groupOverride.groupsToOverride;
          else delete claims["cognito:groups"];
        }
        if (groupOverride.iamRolesToOverride !== undefined) {
          if (!Array.isArray(groupOverride.iamRolesToOverride) || groupOverride.iamRolesToOverride.some((value: unknown) => typeof value !== "string")) {
            throw new AwsError("InvalidLambdaResponseException", "Pre-token role overrides are invalid.");
          }
          if (groupOverride.iamRolesToOverride.length) claims["cognito:roles"] = groupOverride.iamRolesToOverride;
          else delete claims["cognito:roles"];
        }
        if (groupOverride.preferredRole !== undefined) {
          if (typeof groupOverride.preferredRole !== "string") {
            throw new AwsError("InvalidLambdaResponseException", "Pre-token preferred role is invalid.");
          }
          claims["cognito:preferred_role"] = groupOverride.preferredRole;
        }
      };
      applyGroups(baseIdClaims);
      applyGroups(baseAccessClaims);
    }
    const idToken = includeIdToken
      ? signCognitoJwt(
          this.secrets,
          this.store.accountId,
          this.region,
          pool.id,
          pool.signingKeys,
          "id",
          baseIdClaims,
        )
      : undefined;
    const accessToken = signCognitoJwt(
      this.secrets,
      this.store.accountId,
      this.region,
      pool.id,
      pool.signingKeys,
      "access",
      baseAccessClaims,
    );
    return {
      AccessToken: accessToken,
      ExpiresIn: accessLifetime,
      TokenType: "Bearer",
      ...(refreshToken ? { RefreshToken: refreshToken } : {}),
      ...(idToken ? { IdToken: idToken } : {}),
    };
  }

  async InitiateAuth(input: Record<string, any>): Promise<Record<string, unknown>> {
    const admin = input.UserPoolId !== undefined;
    const unknown = Object.keys(input).find(key =>
      !["AuthFlow", "AuthParameters", "ClientId", "ClientMetadata", ...(admin ? ["UserPoolId"] : [])].includes(key)
    );
    if (unknown) throw new AwsError("InvalidParameterException", `InitiateAuth does not support ${unknown}.`);
    const located = admin
      ? (() => {
          const pool = this.pool(input.UserPoolId);
          return { pool, client: this.appClient(pool, input.ClientId) };
        })()
      : this.appClientAcrossPools(input.ClientId);
    const { pool, client } = located;
    const clientMetadata = stringRecord(input.ClientMetadata, "ClientMetadata");
    if (input.AuthFlow === "REFRESH_TOKEN_AUTH") {
      const parameters = input.AuthParameters;
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
        throw new AwsError("InvalidParameterException", "AuthParameters is required.");
      }
      const unsupported = Object.keys(parameters).find(key => !["REFRESH_TOKEN", "SECRET_HASH"].includes(key));
      if (unsupported || typeof parameters.REFRESH_TOKEN !== "string") {
        throw new AwsError("InvalidParameterException", "REFRESH_TOKEN_AUTH parameters are invalid.");
      }
      return this.refreshAuthentication(input);
    }
    if (!admin && input.AuthFlow === "USER_SRP_AUTH") {
      if (!client.explicitAuthFlows.includes("ALLOW_USER_SRP_AUTH")) {
        throw new AwsError("InvalidParameterException", "USER_SRP_AUTH is not enabled for this app client.");
      }
      const parameters = input.AuthParameters;
      if (
        !parameters
        || typeof parameters !== "object"
        || Array.isArray(parameters)
        || Object.keys(parameters).some(key => !["USERNAME", "SRP_A", "SECRET_HASH", "DEVICE_KEY"].includes(key))
        || typeof parameters.USERNAME !== "string"
        || typeof parameters.SRP_A !== "string"
      ) {
        throw new AwsError("InvalidParameterException", "USER_SRP_AUTH parameters are invalid.");
      }
      const deviceKey = parameters.DEVICE_KEY === undefined
        ? undefined
        : assertDeviceKey(parameters.DEVICE_KEY);
      return this.beginSrpAuthentication(
        pool,
        client,
        parameters.USERNAME,
        parameters.SRP_A,
        clientMetadata,
        deviceKey,
      );
    }
    const expectedFlow = admin ? "ADMIN_USER_PASSWORD_AUTH" : "USER_PASSWORD_AUTH";
    if (input.AuthFlow !== expectedFlow) {
      throw new AwsError("InvalidParameterException", `${expectedFlow} is required.`);
    }
    const requiredFlow = admin ? "ALLOW_ADMIN_USER_PASSWORD_AUTH" : "ALLOW_USER_PASSWORD_AUTH";
    if (!client.explicitAuthFlows.includes(requiredFlow)) {
      throw new AwsError("InvalidParameterException", `${expectedFlow} is not enabled for this app client.`);
    }
    const parameters = input.AuthParameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new AwsError("InvalidParameterException", "AuthParameters is required.");
    }
    const unsupported = Object.keys(parameters).find(key =>
      !["USERNAME", "PASSWORD", "SECRET_HASH", "DEVICE_KEY"].includes(key)
    );
    if (
      unsupported
      || typeof parameters.USERNAME !== "string"
      || typeof parameters.PASSWORD !== "string"
    ) {
      throw new AwsError("InvalidParameterException", "USER_PASSWORD_AUTH parameters are invalid.");
    }
    const deviceKey = parameters.DEVICE_KEY === undefined
      ? undefined
      : assertDeviceKey(parameters.DEVICE_KEY);
    modeledUsername(parameters.USERNAME);
    const user = findUserByModeledUsername(pool, parameters.USERNAME);
    const passwordMatches = user
      ? await this.passwords.verify(parameters.PASSWORD, user.password)
      : await this.passwords.dummy(parameters.PASSWORD);
    if (!user) {
      if (client.preventUserExistenceErrors === "ENABLED") {
        throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
      }
      throw new AwsError("UserNotFoundException", "User does not exist.");
    }
    if (!passwordMatches || !user.enabled) {
      throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
    }
    await this.invokeTrigger(
      pool,
      client,
      user,
      "preAuthentication",
      "PreAuthentication_Authentication",
      { clientMetadata },
    );
    if (
      user.status === "FORCE_CHANGE_PASSWORD"
      && (
        user.temporaryPasswordExpiresAt === undefined
        || this.clock.now() >= user.temporaryPasswordExpiresAt
      )
    ) {
      throw new AwsError("NotAuthorizedException", "Temporary password has expired.");
    }
    if (user.status !== "CONFIRMED") {
      if (user.status === "FORCE_CHANGE_PASSWORD") {
        return this.exclusive(async () => {
          const currentPool = this.pool(pool.id);
          const currentClient = this.appClient(currentPool, client.id);
          const currentUser = currentPool.usersBySub[user.sub];
          if (
            !currentUser
            || currentUser.generationId !== user.generationId
            || currentUser.status !== "FORCE_CHANGE_PASSWORD"
            || !currentUser.enabled
          ) {
            throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
          }
          const session = randomBytes(32).toString("base64url");
          currentPool.challenges[session] = {
            id: session,
            purpose: "NEW_PASSWORD_REQUIRED",
            poolId: currentPool.id,
            clientId: currentClient.id,
            userSub: currentUser.sub,
            userGenerationId: currentUser.generationId,
            createdAt: this.clock.now(),
            expiresAt: this.clock.now() + currentClient.authSessionValidity * 60_000,
            attempts: 0,
            status: "ACTIVE",
            ...(Object.keys(clientMetadata).length ? { clientMetadata: { ...clientMetadata } } : {}),
          };
          this.state.revision += 1;
          await this.store.save();
          return {
            ChallengeName: "NEW_PASSWORD_REQUIRED",
            Session: session,
            ChallengeParameters: {
              USER_ID_FOR_SRP: currentUser.username,
              requiredAttributes: "[]",
              userAttributes: JSON.stringify(Object.fromEntries(
                userAttributesView(currentUser).map(attribute => [attribute.Name, attribute.Value]),
              )),
            },
          };
        });
      }
      if (user.status === "RESET_REQUIRED") {
        throw new AwsError("PasswordResetRequiredException", "Password reset is required.");
      }
      throw new AwsError("UserNotConfirmedException", "User is not confirmed.");
    }
    const step = await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      const currentUser = currentPool.usersBySub[user.sub];
      if (
        !currentUser
        || currentUser.generationId !== user.generationId
        || !currentUser.enabled
        || currentUser.status !== "CONFIRMED"
      ) {
        throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
      }
      const authentication = await this.authenticationStep(
        currentPool,
        currentClient,
        currentUser,
        clientMetadata,
        deviceKey,
      );
      currentUser.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return authentication;
    });
    return this.deliverAuthenticationStep(step);
  }

  AdminInitiateAuth(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (input.UserPoolId === undefined) {
      throw new AwsError("InvalidParameterException", "UserPoolId is required.");
    }
    return this.InitiateAuth(input);
  }

  private async beginSrpAuthentication(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    suppliedUsername: string,
    suppliedA: string,
    clientMetadata: Record<string, string>,
    deviceKey?: string,
  ): Promise<Record<string, unknown>> {
    modeledUsername(suppliedUsername);
    if (!/^[0-9a-fA-F]{1,2048}$/.test(suppliedA)) {
      throw new AwsError("InvalidParameterException", "SRP_A is invalid.");
    }
    const user = findUserByModeledUsername(pool, suppliedUsername);
    if (!user) {
      if (client.preventUserExistenceErrors === "ENABLED") {
        throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
      }
      throw new AwsError("UserNotFoundException", "User does not exist.");
    }
    if (!user.enabled || !user.srp || !["CONFIRMED", "FORCE_CHANGE_PASSWORD"].includes(user.status)) {
      throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
    }
    const A = BigInt(`0x${suppliedA}`);
    if (A % SRP_N === 0n) throw new AwsError("InvalidParameterException", "SRP_A is invalid.");
    const verifier = BigInt(`0x${user.srp.verifier}`);
    const b = BigInt(`0x${randomBytes(128).toString("hex")}`);
    const B = (srpMultiplier() * verifier + modPow(SRP_G, b, SRP_N)) % SRP_N;
    const scramble = BigInt(`0x${srpHash(srpPad(A), srpPad(B)).toString("hex")}`);
    if (scramble === 0n) throw new AwsError("InternalErrorException", "Could not establish SRP session.", 500);
    const shared = modPow((A * modPow(verifier, scramble, SRP_N)) % SRP_N, b, SRP_N);
    const derivedKey = srpDerivedKey(shared, scramble);
    const secretBlockBytes = randomBytes(16);
    const secretBlock = secretBlockBytes.toString("base64");
    const keyId = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    let encrypted: CognitoRecoverableSecretState;
    try {
      encrypted = {
        id: keyId,
        version: 1,
        envelope: this.secrets.encrypt(derivedKey, {
          purpose: "SRP_DERIVED_KEY",
          accountId: this.store.accountId,
          region: this.region,
          poolId: pool.id,
          ownerId: user.sub,
          secretId: keyId,
          secretVersion: 1,
          field: "password-claim-key",
        }),
      };
    } finally {
      derivedKey.fill(0);
      secretBlockBytes.fill(0);
    }
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      const currentUser = currentPool.usersBySub[user.sub];
      if (!currentUser || currentUser.generationId !== user.generationId || !currentUser.enabled) {
        throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
      }
      const challenge = this.createChallenge(
        currentPool,
        currentClient,
        currentUser,
        "PASSWORD_VERIFIER",
        clientMetadata,
      );
      challenge.srpA = A.toString(16);
      challenge.srpB = B.toString(16);
      challenge.salt = user.srp!.salt;
      challenge.secretBlock = secretBlock;
      challenge.srpKey = encrypted;
      if (deviceKey) challenge.deviceKey = deviceKey;
      this.state.revision += 1;
      await this.store.save();
      return {
        ChallengeName: "PASSWORD_VERIFIER",
        Session: challenge.id,
        ChallengeParameters: {
          SALT: challenge.salt,
          SRP_B: challenge.srpB,
          SECRET_BLOCK: secretBlock,
          USERNAME: currentUser.username,
          USER_ID_FOR_SRP: currentUser.username,
        },
      };
    });
  }

  async RespondToAuthChallenge(input: Record<string, any>): Promise<Record<string, unknown>> {
    const allowed = ["ClientId", "UserPoolId", "ChallengeName", "Session", "ChallengeResponses", "ClientMetadata"];
    const unknown = Object.keys(input).find(key => !allowed.includes(key));
    if (unknown) {
      throw new AwsError("InvalidParameterException", `RespondToAuthChallenge does not support ${unknown}.`);
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    const context = this.challengeProof.get(input);
    if (!context || context.challenge.purpose !== input.ChallengeName) {
      throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
    }
    const suppliedClientMetadata = stringRecord(input.ClientMetadata, "ClientMetadata");
    const clientMetadata = Object.keys(suppliedClientMetadata).length
      ? suppliedClientMetadata
      : context.challenge.clientMetadata ?? {};
    if (input.UserPoolId !== undefined && input.UserPoolId !== context.pool.id) {
      throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
    }
    if (input.ChallengeName === "PASSWORD_VERIFIER") {
      const responses = input.ChallengeResponses;
      if (
        typeof responses?.PASSWORD_CLAIM_SIGNATURE !== "string"
        || typeof responses?.PASSWORD_CLAIM_SECRET_BLOCK !== "string"
        || typeof responses?.TIMESTAMP !== "string"
        || responses.PASSWORD_CLAIM_SECRET_BLOCK !== context.challenge.secretBlock
        || !context.challenge.srpKey
      ) {
        throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
      }
      const parsedTimestamp = Date.parse(responses.TIMESTAMP);
      if (!Number.isFinite(parsedTimestamp) || Math.abs(this.clock.now() - parsedTimestamp) > 5 * 60_000) {
        throw new AwsError("NotAuthorizedException", "Password claim timestamp is invalid.");
      }
      const key = this.secrets.decrypt(context.challenge.srpKey.envelope, {
        purpose: "SRP_DERIVED_KEY",
        accountId: this.store.accountId,
        region: this.region,
        poolId: context.pool.id,
        ownerId: context.user.sub,
        secretId: context.challenge.srpKey.id,
        secretVersion: context.challenge.srpKey.version,
        field: "password-claim-key",
      });
      const expected = createHmac("sha256", key)
        .update(context.pool.id.split("_")[1], "utf8")
        .update(context.user.username, "utf8")
        .update(Buffer.from(context.challenge.secretBlock!, "base64"))
        .update(responses.TIMESTAMP, "utf8")
        .digest();
      key.fill(0);
      let supplied: Buffer;
      try {
        supplied = Buffer.from(responses.PASSWORD_CLAIM_SIGNATURE, "base64");
      } catch {
        expected.fill(0);
        throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
      }
      const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
      supplied.fill(0);
      expected.fill(0);
      if (!valid) {
        return this.failedMfaChallenge(context, "Incorrect username or password.", "NotAuthorizedException");
      }
      await this.invokeTrigger(
        context.pool,
        context.client,
        context.user,
        "preAuthentication",
        "PreAuthentication_Authentication",
        { clientMetadata },
      );
      const step = await this.exclusive(async () => {
        const pool = this.pool(context.pool.id);
        const client = this.appClient(pool, context.client.id);
        const user = pool.usersBySub[context.user.sub];
        const challenge = pool.challenges[context.challenge.id];
        if (!user || !challenge || challenge.status !== "ACTIVE" || !user.enabled) {
          throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
        }
        challenge.status = "CONSUMED";
        delete challenge.srpKey;
        if (user.status === "FORCE_CHANGE_PASSWORD") {
          const next = this.createChallenge(
            pool,
            client,
            user,
            "NEW_PASSWORD_REQUIRED",
            clientMetadata,
          );
          this.state.revision += 1;
          await this.store.save();
          return {
            response: {
              ChallengeName: "NEW_PASSWORD_REQUIRED",
              Session: next.id,
              ChallengeParameters: {
                USER_ID_FOR_SRP: user.username,
                requiredAttributes: "[]",
                userAttributes: JSON.stringify(Object.fromEntries(
                  userAttributesView(user).map(attribute => [attribute.Name, attribute.Value]),
                )),
              },
            },
          } satisfies CognitoAuthenticationStep;
        }
        if (user.status !== "CONFIRMED") throw new AwsError("UserNotConfirmedException", "User is not confirmed.");
        const responseDeviceKey = typeof responses.DEVICE_KEY === "string"
          ? assertDeviceKey(responses.DEVICE_KEY)
          : challenge.deviceKey;
        const authentication = await this.authenticationStep(
          pool,
          client,
          user,
          clientMetadata,
          responseDeviceKey,
        );
        this.state.revision += 1;
        await this.store.save();
        return authentication;
      });
      return this.deliverAuthenticationStep(step);
    }
    if (input.ChallengeName === "DEVICE_SRP_AUTH") {
      return this.respondDeviceSrpAuth(input, context, clientMetadata);
    }
    if (input.ChallengeName === "DEVICE_PASSWORD_VERIFIER") {
      return this.respondDevicePasswordVerifier(input, context, clientMetadata);
    }
    if (input.ChallengeName === "SOFTWARE_TOKEN_MFA") {
      const code = input.ChallengeResponses?.SOFTWARE_TOKEN_MFA_CODE;
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
        throw new AwsError("InvalidParameterException", "SOFTWARE_TOKEN_MFA_CODE is required.");
      }
      const expected = this.softwareTokenSecret(context.pool, context.user);
      const supplied = Buffer.from(code, "ascii");
      let valid = false;
      try {
        for (const offset of [-30_000, 0, 30_000]) {
          const candidate = Buffer.from(totpCode(expected, this.clock.now() + offset), "ascii");
          try { valid ||= timingSafeEqual(supplied, candidate); } finally { candidate.fill(0); }
        }
      } finally {
        supplied.fill(0);
      }
      if (!valid) return this.failedMfaChallenge(context, "Invalid software token code.");
      return this.completeMfaChallenge(context);
    }
    if (input.ChallengeName === "EMAIL_OTP") {
      const code = input.ChallengeResponses?.EMAIL_OTP_CODE;
      if (typeof code !== "string") {
        throw new AwsError("InvalidParameterException", "EMAIL_OTP_CODE is required.");
      }
      const intent = context.challenge.deliveryIntentId
        ? this.state.deliveryIntents[context.challenge.deliveryIntentId]
        : undefined;
      if (
        !intent
        || intent.purpose !== "EMAIL_MFA"
        || intent.status !== "DELIVERED"
        || this.clock.now() >= intent.expiresAt
        || !this.secrets.verifyConfirmationCode(code, intent.credential.codeDigest, this.confirmationBinding(intent))
      ) {
        return this.failedMfaChallenge(context, "Invalid MFA code.");
      }
      return this.completeMfaChallenge(context, intent);
    }
    if (input.ChallengeName === "MFA_SETUP") {
      if (!context.user.mfa.softwareToken?.enabled) {
        throw new AwsError("InvalidParameterException", "Complete software-token setup before responding.");
      }
      return this.completeMfaChallenge(context);
    }
    if (input.ChallengeName !== "NEW_PASSWORD_REQUIRED") {
      throw new AwsError("InvalidParameterException", "ChallengeName is not supported by this challenge session.");
    }
    const password = input.ChallengeResponses?.NEW_PASSWORD;
    validatePasswordPolicy(password, context.pool.configuration.policies.passwordPolicy);
    const history = [context.user.password, ...context.user.passwordHistory];
    for (const prior of history.slice(
      0,
      context.pool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0,
    )) {
      if (await this.passwords.verify(password, prior)) {
        throw new AwsError("PasswordHistoryPolicyViolationException", "Password was used recently.");
      }
    }
    const passwordHash = await this.passwords.hash(password);
    const step = await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const user = pool.usersBySub[context.user.sub];
      const challenge = pool.challenges[context.challenge.id];
      if (
        !user
        || !challenge
        || challenge.status !== "ACTIVE"
        || challenge.purpose !== "NEW_PASSWORD_REQUIRED"
        || challenge.userGenerationId !== user.generationId
        || user.status !== "FORCE_CHANGE_PASSWORD"
        || this.clock.now() >= challenge.expiresAt
      ) {
        throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
      }
      const previousPassword = user.password;
      const previousHistory = [...user.passwordHistory];
      const previousSrp = user.srp;
      const previousPasswordChangedAt = user.passwordChangedAt;
      const previousTemporaryExpiry = user.temporaryPasswordExpiresAt;
      const previousStatus = user.status;
      user.passwordHistory = [user.password, ...user.passwordHistory]
        .slice(0, pool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0);
      user.password = passwordHash;
      user.srp = srpCredential(pool, user.username, password);
      user.passwordChangedAt = this.clock.now();
      user.temporaryPasswordExpiresAt = undefined;
      user.status = "CONFIRMED";
      user.updatedAt = this.clock.now();
      let authentication: CognitoAuthenticationStep;
      try {
        authentication = await this.authenticationStep(pool, client, user, clientMetadata);
      } catch (error) {
        user.password = previousPassword;
        user.passwordHistory = previousHistory;
        user.srp = previousSrp;
        user.passwordChangedAt = previousPasswordChangedAt;
        user.temporaryPasswordExpiresAt = previousTemporaryExpiry;
        user.status = previousStatus;
        throw error;
      }
      challenge.status = "CONSUMED";
      this.state.revision += 1;
      await this.store.save();
      return authentication;
    });
    return this.deliverAuthenticationStep(step);
  }

  private async respondDeviceSrpAuth(
    input: Record<string, any>,
    context: {
      pool: CognitoUserPoolState;
      client: CognitoAppClientState;
      user: CognitoUserState;
      challenge: import("./types.js").CognitoChallengeState;
    },
    clientMetadata: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const responses = input.ChallengeResponses;
    const deviceKey = assertDeviceKey(responses?.DEVICE_KEY ?? context.challenge.deviceKey);
    if (
      typeof responses?.SRP_A !== "string"
      || !/^[0-9a-fA-F]{1,2048}$/.test(responses.SRP_A)
      || context.challenge.deviceKey !== deviceKey
    ) {
      throw new AwsError("NotAuthorizedException", "Device authentication failed.");
    }
    const device = this.rememberedDeviceForAuth(context.pool, context.user, deviceKey);
    if (!device) throw new AwsError("NotAuthorizedException", "Device authentication failed.");
    const material = this.readDeviceVerifier(context.pool, context.user, device);
    let decoded: { verifierHex: string; saltHex: string };
    try {
      decoded = decodeDeviceVerifierMaterial(material.passwordVerifier, material.salt);
    } finally {
      material.passwordVerifier = "";
      material.salt = "";
    }
    const A = BigInt(`0x${responses.SRP_A}`);
    if (A % SRP_N === 0n) throw new AwsError("InvalidParameterException", "SRP_A is invalid.");
    const verifier = BigInt(`0x${decoded.verifierHex}`);
    const b = BigInt(`0x${randomBytes(128).toString("hex")}`);
    const B = (srpMultiplier() * verifier + modPow(SRP_G, b, SRP_N)) % SRP_N;
    const scramble = BigInt(`0x${srpHash(srpPad(A), srpPad(B)).toString("hex")}`);
    if (scramble === 0n) throw new AwsError("InternalErrorException", "Could not establish device SRP session.", 500);
    const shared = modPow((A * modPow(verifier, scramble, SRP_N)) % SRP_N, b, SRP_N);
    const derivedKey = srpDerivedKey(shared, scramble);
    const secretBlockBytes = randomBytes(16);
    const secretBlock = secretBlockBytes.toString("base64");
    const keyId = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    let encrypted: CognitoRecoverableSecretState;
    try {
      encrypted = {
        id: keyId,
        version: 1,
        envelope: this.secrets.encrypt(derivedKey, {
          purpose: "SRP_DERIVED_KEY",
          accountId: this.store.accountId,
          region: this.region,
          poolId: context.pool.id,
          ownerId: context.user.sub,
          secretId: keyId,
          secretVersion: 1,
          field: "device-password-claim-key",
        }),
      };
    } finally {
      derivedKey.fill(0);
      secretBlockBytes.fill(0);
    }
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const user = pool.usersBySub[context.user.sub];
      const prior = pool.challenges[context.challenge.id];
      if (!user || !prior || prior.status !== "ACTIVE" || prior.purpose !== "DEVICE_SRP_AUTH") {
        throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
      }
      prior.status = "CONSUMED";
      const challenge = this.createChallenge(pool, client, user, "DEVICE_PASSWORD_VERIFIER", clientMetadata);
      challenge.deviceKey = deviceKey;
      challenge.srpA = A.toString(16);
      challenge.srpB = B.toString(16);
      challenge.salt = decoded.saltHex;
      challenge.secretBlock = secretBlock;
      challenge.srpKey = encrypted;
      this.state.revision += 1;
      await this.store.save();
      return {
        ChallengeName: "DEVICE_PASSWORD_VERIFIER",
        Session: challenge.id,
        ChallengeParameters: {
          SALT: challenge.salt,
          SRP_B: challenge.srpB!,
          SECRET_BLOCK: secretBlock,
          USERNAME: user.username,
          DEVICE_KEY: deviceKey,
        },
      };
    });
  }

  private async respondDevicePasswordVerifier(
    input: Record<string, any>,
    context: {
      pool: CognitoUserPoolState;
      client: CognitoAppClientState;
      user: CognitoUserState;
      challenge: import("./types.js").CognitoChallengeState;
    },
    clientMetadata: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const responses = input.ChallengeResponses;
    const deviceKey = assertDeviceKey(responses?.DEVICE_KEY ?? context.challenge.deviceKey);
    if (
      typeof responses?.PASSWORD_CLAIM_SIGNATURE !== "string"
      || typeof responses?.PASSWORD_CLAIM_SECRET_BLOCK !== "string"
      || typeof responses?.TIMESTAMP !== "string"
      || responses.PASSWORD_CLAIM_SECRET_BLOCK !== context.challenge.secretBlock
      || context.challenge.deviceKey !== deviceKey
      || !context.challenge.srpKey
    ) {
      throw new AwsError("NotAuthorizedException", "Device authentication failed.");
    }
    const parsedTimestamp = Date.parse(responses.TIMESTAMP);
    if (!Number.isFinite(parsedTimestamp) || Math.abs(this.clock.now() - parsedTimestamp) > 5 * 60_000) {
      throw new AwsError("NotAuthorizedException", "Password claim timestamp is invalid.");
    }
    const device = this.rememberedDeviceForAuth(context.pool, context.user, deviceKey);
    if (!device) throw new AwsError("NotAuthorizedException", "Device authentication failed.");
    const key = this.secrets.decrypt(context.challenge.srpKey.envelope, {
      purpose: "SRP_DERIVED_KEY",
      accountId: this.store.accountId,
      region: this.region,
      poolId: context.pool.id,
      ownerId: context.user.sub,
      secretId: context.challenge.srpKey.id,
      secretVersion: context.challenge.srpKey.version,
      field: "device-password-claim-key",
    });
    const expected = createHmac("sha256", key)
      .update(device.groupKey, "utf8")
      .update(deviceKey, "utf8")
      .update(Buffer.from(context.challenge.secretBlock!, "base64"))
      .update(responses.TIMESTAMP, "utf8")
      .digest();
    key.fill(0);
    let supplied: Buffer;
    try {
      supplied = Buffer.from(responses.PASSWORD_CLAIM_SIGNATURE, "base64");
    } catch {
      expected.fill(0);
      throw new AwsError("NotAuthorizedException", "Device authentication failed.");
    }
    const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    supplied.fill(0);
    expected.fill(0);
    if (!valid) {
      return this.failedMfaChallenge(context, "Device authentication failed.", "NotAuthorizedException");
    }
    const step = await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const user = pool.usersBySub[context.user.sub];
      const challenge = pool.challenges[context.challenge.id];
      const currentDevice = user?.devices[deviceKey];
      if (
        !user
        || !challenge
        || challenge.status !== "ACTIVE"
        || challenge.purpose !== "DEVICE_PASSWORD_VERIFIER"
        || !currentDevice
        || currentDevice.rememberedStatus !== "remembered"
      ) {
        throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
      }
      challenge.status = "CONSUMED";
      delete challenge.srpKey;
      currentDevice.lastAuthenticatedAt = this.clock.now();
      currentDevice.lastModifiedAt = currentDevice.lastAuthenticatedAt;
      const created = this.newRefreshSession(pool, client, user);
      const authentication = await this.authenticationResult(
        pool,
        client,
        user,
        created.session,
        created.token,
        clientMetadata,
      );
      // Successful remembered-device auth does not mint a new pending device.
      pool.refreshSessions[created.session.id] = created.session;
      pool.authEvents.push({
        eventId: created.session.eventId,
        userSub: user.sub,
        createdAt: this.clock.now(),
        eventType: "SignIn",
      });
      if (pool.authEvents.length > AUDIT_LIMIT) pool.authEvents.splice(0, pool.authEvents.length - AUDIT_LIMIT);
      user.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {
        response: { AuthenticationResult: authentication },
        postAuthentication: {
          poolId: pool.id,
          clientId: client.id,
          userSub: user.sub,
          sessionId: created.session.id,
          eventId: created.session.eventId,
          clientMetadata: { ...clientMetadata },
        },
      } satisfies CognitoAuthenticationStep;
    });
    return this.deliverAuthenticationStep(step);
  }

  private async failedMfaChallenge(
    context: {
      pool: CognitoUserPoolState;
      client: CognitoAppClientState;
      user: CognitoUserState;
      challenge: import("./types.js").CognitoChallengeState;
    },
    message: string,
    failureCode: "CodeMismatchException" | "NotAuthorizedException" = "CodeMismatchException",
  ): Promise<never> {
    await this.exclusive(async () => {
      const challenge = this.pool(context.pool.id).challenges[context.challenge.id];
      if (challenge?.status === "ACTIVE") {
        challenge.attempts += 1;
        if (challenge.attempts >= CONFIRMATION_ATTEMPTS) challenge.status = "CANCELLED";
        this.state.revision += 1;
        await this.store.save();
      }
    });
    throw new AwsError(
      context.challenge.attempts + 1 >= CONFIRMATION_ATTEMPTS ? "NotAuthorizedException" : failureCode,
      message,
    );
  }

  private async completeMfaChallenge(
    context: {
      pool: CognitoUserPoolState;
      client: CognitoAppClientState;
      user: CognitoUserState;
      challenge: import("./types.js").CognitoChallengeState;
    },
    intent?: CognitoDeliveryIntentState,
  ): Promise<Record<string, unknown>> {
    let completedSession: CognitoRefreshSessionState | undefined;
    const result = await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const user = pool.usersBySub[context.user.sub];
      const challenge = pool.challenges[context.challenge.id];
      if (
        !user
        || !challenge
        || challenge.status !== "ACTIVE"
        || this.clock.now() >= challenge.expiresAt
      ) {
        throw new AwsError("NotAuthorizedException", "Invalid session for the user.");
      }
      const created = this.newRefreshSession(pool, client, user);
      const authentication = await this.authenticationResult(
        pool,
        client,
        user,
        created.session,
        created.token,
        challenge.clientMetadata ?? {},
      );
      this.attachNewDeviceMetadata(
        pool,
        client,
        user,
        created.session,
        authentication,
        challenge.deviceKey,
      );
      completedSession = created.session;
      challenge.status = "CONSUMED";
      if (intent) {
        const currentIntent = this.state.deliveryIntents[intent.id];
        if (currentIntent?.status === "DELIVERED") {
          currentIntent.status = "CONSUMED";
          currentIntent.statusUpdatedAt = this.clock.now();
        }
      }
      pool.refreshSessions[created.session.id] = created.session;
      pool.authEvents.push({
        eventId: created.session.eventId,
        userSub: user.sub,
        createdAt: this.clock.now(),
        eventType: "Mfa",
      });
      if (pool.authEvents.length > AUDIT_LIMIT) pool.authEvents.splice(0, pool.authEvents.length - AUDIT_LIMIT);
      user.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {
        AuthenticationResult: authentication,
      };
    });
    await this.postAuthentication({
      poolId: context.pool.id,
      clientId: context.client.id,
      userSub: context.user.sub,
      sessionId: completedSession!.id,
      eventId: completedSession!.eventId,
      clientMetadata: { ...(context.challenge.clientMetadata ?? {}) },
    });
    return result;
  }

  async ForgotPassword(input: Record<string, any>): Promise<Record<string, unknown>> {
    const unknown = Object.keys(input).find(key => ![
      "ClientId", "SecretHash", "Username", "ClientMetadata", "UserContextData",
    ].includes(key));
    if (unknown) throw new AwsError("InvalidParameterException", `ForgotPassword does not support ${unknown}.`);
    stringRecord(input.ClientMetadata, "ClientMetadata");
    if (input.UserContextData !== undefined) {
      throw new AwsError("InvalidParameterException", "UserContextData is unavailable.");
    }
    const { pool, client } = this.appClientAcrossPools(input.ClientId);
    const user = (() => {
      try { return this.adminUser(pool, input.Username); } catch { return undefined; }
    })();
    if (!user) {
      if (client.preventUserExistenceErrors === "ENABLED") return {};
      throw new AwsError("UserNotFoundException", "User does not exist.");
    }
    if (!user.enabled || !["CONFIRMED", "RESET_REQUIRED"].includes(user.status)) {
      throw new AwsError("InvalidParameterException", "User password cannot be reset in the current state.");
    }
    if (user.preferredMfaSetting === "EMAIL_OTP") {
      throw new AwsError(
        "InvalidParameterException",
        "Password recovery cannot use the preferred email MFA destination.",
      );
    }
    if (!user.attributes.email?.verified) {
      throw new AwsError("InvalidParameterException", "User has no verified email recovery destination.");
    }
    let intentId: string | undefined;
    await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      const currentUser = this.adminUser(currentPool, user.username);
      const intent = this.newDeliveryIntent(currentPool, currentClient, currentUser, "PASSWORD_RESET");
      await this.applyCustomMessage(
        currentPool,
        currentClient,
        currentUser,
        intent,
        stringRecord(input.ClientMetadata, "ClientMetadata"),
      );
      this.state.deliveryIntents[intent.id] = intent;
      intentId = intent.id;
      this.state.revision += 1;
      await this.store.save();
    });
    try {
      await this.deliverIntent(intentId!);
    } catch {
      throw new AwsError("CodeDeliveryFailureException", "Failed to deliver the password reset code.");
    }
    return {
      CodeDeliveryDetails: {
        Destination: maskEmail(user.attributes.email.value),
        DeliveryMedium: "EMAIL",
        AttributeName: "email",
      },
    };
  }

  async ConfirmForgotPassword(input: Record<string, any>): Promise<Record<string, never>> {
    const unknown = Object.keys(input).find(key => ![
      "ClientId", "SecretHash", "Username", "ConfirmationCode", "Password",
      "ClientMetadata", "UserContextData",
    ].includes(key));
    if (unknown) {
      throw new AwsError("InvalidParameterException", `ConfirmForgotPassword does not support ${unknown}.`);
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    if (input.UserContextData !== undefined) {
      throw new AwsError("InvalidParameterException", "UserContextData is unavailable.");
    }
    const { pool } = this.appClientAcrossPools(input.ClientId);
    const user = this.adminUser(pool, input.Username);
    validatePasswordPolicy(input.Password, pool.configuration.policies.passwordPolicy);
    const history = [user.password, ...user.passwordHistory];
    for (const prior of history.slice(0, pool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0)) {
      if (await this.passwords.verify(input.Password, prior)) {
        throw new AwsError("PasswordHistoryPolicyViolationException", "Password was used recently.");
      }
    }
    const password = await this.passwords.hash(input.Password);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentUser = this.adminUser(currentPool, user.username);
      const intent = currentUser.activePasswordResetIntentId
        ? this.state.deliveryIntents[currentUser.activePasswordResetIntentId]
        : undefined;
      if (
        !intent
        || intent.purpose !== "PASSWORD_RESET"
        || intent.status !== "DELIVERED"
        || intent.userGenerationId !== currentUser.generationId
      ) {
        throw new AwsError("ExpiredCodeException", "Invalid code provided, please request a code again.");
      }
      if (this.clock.now() >= intent.expiresAt) {
        intent.status = "EXPIRED";
        intent.statusUpdatedAt = this.clock.now();
        currentUser.activePasswordResetIntentId = undefined;
        this.state.revision += 1;
        await this.store.save();
        throw new AwsError("ExpiredCodeException", "Invalid code provided, please request a code again.");
      }
      if (!this.secrets.verifyConfirmationCode(
        input.ConfirmationCode,
        intent.credential.codeDigest,
        this.confirmationBinding(intent),
      )) {
        intent.attempts += 1;
        this.state.revision += 1;
        await this.store.save();
        if (intent.attempts >= CONFIRMATION_ATTEMPTS) {
          throw new AwsError("LimitExceededException", "Confirmation code attempt limit exceeded.");
        }
        throw new AwsError("CodeMismatchException", "Invalid verification code provided.");
      }
      currentUser.passwordHistory = [currentUser.password, ...currentUser.passwordHistory]
        .slice(0, currentPool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0);
      currentUser.password = password;
      currentUser.srp = srpCredential(currentPool, currentUser.username, input.Password);
      currentUser.passwordChangedAt = this.clock.now();
      currentUser.status = "CONFIRMED";
      currentUser.activePasswordResetIntentId = undefined;
      intent.status = "CONSUMED";
      intent.statusUpdatedAt = this.clock.now();
      this.revokeUserSessions(currentPool, currentUser, "PASSWORD_CHANGED");
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async ChangePassword(input: Record<string, any>): Promise<Record<string, never>> {
    if (
      Object.keys(input).some(key => !["AccessToken", "PreviousPassword", "ProposedPassword"].includes(key))
      || typeof input.PreviousPassword !== "string"
      || typeof input.ProposedPassword !== "string"
    ) {
      throw new AwsError("InvalidParameterException", "ChangePassword parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    if (!await this.passwords.verify(input.PreviousPassword, context.user.password)) {
      throw new AwsError("NotAuthorizedException", "Incorrect username or password.");
    }
    validatePasswordPolicy(input.ProposedPassword, context.pool.configuration.policies.passwordPolicy);
    const history = [context.user.password, ...context.user.passwordHistory];
    for (const prior of history.slice(
      0,
      context.pool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0,
    )) {
      if (await this.passwords.verify(input.ProposedPassword, prior)) {
        throw new AwsError("PasswordHistoryPolicyViolationException", "Password was used recently.");
      }
    }
    const password = await this.passwords.hash(input.ProposedPassword);
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user || user.generationId !== context.user.generationId) {
        throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      }
      user.passwordHistory = [user.password, ...user.passwordHistory]
        .slice(0, pool.configuration.policies.passwordPolicy.passwordHistorySize ?? 0);
      user.password = password;
      user.srp = srpCredential(pool, user.username, input.ProposedPassword);
      user.passwordChangedAt = this.clock.now();
      this.revokeUserSessions(pool, user, "PASSWORD_CHANGED");
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async DeleteUser(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => key !== "AccessToken")) {
      throw new AwsError("InvalidParameterException", "DeleteUser parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user || user.generationId !== context.user.generationId) {
        throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      }
      this.removeUser(pool, user);
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private async updateAttributes(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    rawAttributes: unknown,
    allowVerified: boolean,
  ): Promise<{ emailChanged: boolean }> {
    const prepared = Array.isArray(rawAttributes)
      ? [
          ...rawAttributes,
          ...rawAttributes.flatMap(raw => {
            if (
              raw?.Name === "email_verified"
              && !rawAttributes.some(candidate => candidate?.Name === "email")
              && user.attributes.email
            ) {
              return [{ Name: "email", Value: user.attributes.email.value }];
            }
            return [];
          }),
        ]
      : rawAttributes;
    const attributes = this.parsedAttributes(pool, prepared, {
      allowVerified,
      requireEmail: false,
    });
    let emailChanged = false;
    for (const [name, attribute] of Object.entries(attributes)) {
      const schemaName = name.startsWith("custom:") ? name.slice(7) : name;
      const schema = pool.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
      if (schema && !schema.mutable) {
        throw new AwsError("InvalidParameterException", `User attribute ${name} is immutable.`);
      }
      if (name === "email") {
        const previous = user.attributes.email;
        emailChanged = !previous || cognitoEmail(previous.value).canonical !== cognitoEmail(attribute.value).canonical;
        if (emailChanged && !allowVerified) attribute.verified = false;
      }
    }
    Object.assign(user.attributes, attributes);
    return { emailChanged };
  }

  async UpdateUserAttributes(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => !["AccessToken", "UserAttributes", "ClientMetadata"].includes(key))) {
      throw new AwsError("InvalidParameterException", "UpdateUserAttributes parameters are invalid.");
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    let intentId: string | undefined;
    let emailChanged = false;
    await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user || user.generationId !== context.user.generationId) {
        throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      }
      for (const raw of input.UserAttributes ?? []) {
        if (typeof raw?.Name === "string" && !client.writeAttributes.includes(raw.Name)) {
          throw new AwsError("NotAuthorizedException", `App client cannot write ${raw.Name}.`);
        }
      }
      const previousAttributes = structuredClone(user.attributes);
      try {
        ({ emailChanged } = await this.updateAttributes(pool, user, input.UserAttributes, false));
        if (emailChanged && pool.configuration.autoVerifiedAttributes.includes("email")) {
          const intent = this.newDeliveryIntent(pool, client, user, "ATTRIBUTE_VERIFICATION");
          await this.applyCustomMessage(pool, client, user, intent, stringRecord(input.ClientMetadata, "ClientMetadata"));
          this.state.deliveryIntents[intent.id] = intent;
          intentId = intent.id;
        }
      } catch (error) {
        user.attributes = previousAttributes;
        throw error;
      }
      user.updatedAt = this.clock.now();
      pool.updatedAt = user.updatedAt;
      this.state.revision += 1;
      await this.store.save();
    });
    if (intentId) await this.deliverIntent(intentId);
    return {
      CodeDeliveryDetailsList: intentId
        ? [{
            Destination: maskEmail(this.adminUser(this.pool(context.pool.id), context.user.username).attributes.email.value),
            DeliveryMedium: "EMAIL",
            AttributeName: "email",
          }]
        : [],
    };
  }

  async AdminUpdateUserAttributes(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "UserAttributes", "ClientMetadata"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminUpdateUserAttributes parameters are invalid.");
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      const previousAttributes = structuredClone(current.attributes);
      const previousAliasIndex = { ...currentPool.aliasIndex };
      const oldAlias = current.attributes.email?.verified
        ? cognitoEmail(current.attributes.email.value).canonical
        : undefined;
      try {
        await this.updateAttributes(currentPool, current, input.UserAttributes, true);
        const newAlias = current.attributes.email?.verified
          ? cognitoEmail(current.attributes.email.value).canonical
          : undefined;
        if (oldAlias && oldAlias !== newAlias && currentPool.aliasIndex[oldAlias] === current.sub) {
          delete currentPool.aliasIndex[oldAlias];
        }
        if (newAlias && currentPool.configuration.aliasAttributes.includes("email")) {
          const owner = currentPool.aliasIndex[newAlias];
          if (owner && owner !== current.sub) throw new AwsError("AliasExistsException", "Email alias exists.");
          currentPool.aliasIndex[newAlias] = current.sub;
        }
      } catch (error) {
        current.attributes = previousAttributes;
        currentPool.aliasIndex = previousAliasIndex;
        throw error;
      }
      current.updatedAt = this.clock.now();
      currentPool.updatedAt = current.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private async deleteAttributes(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    names: unknown,
  ): Promise<void> {
    if (!Array.isArray(names) || names.length < 1 || names.some(name => typeof name !== "string")) {
      throw new AwsError("InvalidParameterException", "UserAttributeNames is invalid.");
    }
    for (const name of names) {
      const schemaName = name.startsWith("custom:") ? name.slice(7) : name;
      const schema = pool.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
      if (schema?.required || schema?.mutable === false || name === "sub") {
        throw new AwsError("InvalidParameterException", `User attribute ${name} cannot be deleted.`);
      }
    }
    for (const name of names) {
      if (name === "email" && user.attributes.email?.verified) {
        const alias = cognitoEmail(user.attributes.email.value).canonical;
        if (pool.aliasIndex[alias] === user.sub) delete pool.aliasIndex[alias];
      }
      delete user.attributes[name];
    }
  }

  async DeleteUserAttributes(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["AccessToken", "UserAttributeNames"].includes(key))) {
      throw new AwsError("InvalidParameterException", "DeleteUserAttributes parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      await this.deleteAttributes(pool, user, input.UserAttributeNames);
      user.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminDeleteUserAttributes(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "UserAttributeNames"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminDeleteUserAttributes parameters are invalid.");
    }
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      await this.deleteAttributes(currentPool, current, input.UserAttributeNames);
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async GetUserAttributeVerificationCode(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (
      Object.keys(input).some(key => !["AccessToken", "AttributeName", "ClientMetadata"].includes(key))
      || input.AttributeName !== "email"
    ) {
      throw new AwsError("InvalidParameterException", "Only email attribute verification is available.");
    }
    stringRecord(input.ClientMetadata, "ClientMetadata");
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    if (!context.user.attributes.email) {
      throw new AwsError("InvalidParameterException", "User has no email attribute.");
    }
    let intentId: string | undefined;
    await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      const intent = this.newDeliveryIntent(pool, client, user, "ATTRIBUTE_VERIFICATION");
      await this.applyCustomMessage(pool, client, user, intent, stringRecord(input.ClientMetadata, "ClientMetadata"));
      this.state.deliveryIntents[intent.id] = intent;
      intentId = intent.id;
      this.state.revision += 1;
      await this.store.save();
    });
    await this.deliverIntent(intentId!);
    return {
      CodeDeliveryDetails: {
        Destination: maskEmail(context.user.attributes.email.value),
        DeliveryMedium: "EMAIL",
        AttributeName: "email",
      },
    };
  }

  async VerifyUserAttribute(input: Record<string, any>): Promise<Record<string, never>> {
    if (
      Object.keys(input).some(key => !["AccessToken", "AttributeName", "Code"].includes(key))
      || input.AttributeName !== "email"
    ) {
      throw new AwsError("InvalidParameterException", "Only email attribute verification is available.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      const intentId = user.activeAttributeVerificationIntentIds.email;
      const intent = intentId ? this.state.deliveryIntents[intentId] : undefined;
      if (
        !intent
        || intent.purpose !== "ATTRIBUTE_VERIFICATION"
        || intent.status !== "DELIVERED"
        || this.clock.now() >= intent.expiresAt
      ) {
        throw new AwsError("ExpiredCodeException", "Invalid code provided, please request a code again.");
      }
      if (!this.secrets.verifyConfirmationCode(
        input.Code,
        intent.credential.codeDigest,
        this.confirmationBinding(intent),
      )) {
        intent.attempts += 1;
        this.state.revision += 1;
        await this.store.save();
        throw new AwsError("CodeMismatchException", "Invalid verification code provided.");
      }
      if (!user.attributes.email) throw new AwsError("InvalidParameterException", "User has no email attribute.");
      user.attributes.email.verified = true;
      if (pool.configuration.aliasAttributes.includes("email")) {
        const alias = cognitoEmail(user.attributes.email.value).canonical;
        const owner = pool.aliasIndex[alias];
        if (owner && owner !== user.sub) throw new AwsError("AliasExistsException", "Email alias exists.");
        pool.aliasIndex[alias] = user.sub;
      }
      user.activeAttributeVerificationIntentIds.email = "";
      delete user.activeAttributeVerificationIntentIds.email;
      user.updatedAt = this.clock.now();
      intent.status = "CONSUMED";
      intent.statusUpdatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private mfaUserContext(input: Record<string, any>): {
    pool: CognitoUserPoolState;
    client: CognitoAppClientState;
    user: CognitoUserState;
    challenge?: import("./types.js").CognitoChallengeState;
  } {
    if (input.AccessToken !== undefined) {
      const context = this.accessProof.get(input);
      if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      return context;
    }
    return this.challengeBySession(input.Session);
  }

  async AssociateSoftwareToken(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (
      Object.keys(input).some(key => !["AccessToken", "Session"].includes(key))
      || (input.AccessToken === undefined) === (input.Session === undefined)
    ) {
      throw new AwsError("InvalidParameterException", "Provide exactly one AccessToken or Session.");
    }
    const context = this.mfaUserContext(input);
    if (!context.pool.configuration.enabledMfas.includes("SOFTWARE_TOKEN_MFA")) {
      throw new AwsError("SoftwareTokenMFANotFoundException", "Software-token MFA is not enabled.");
    }
    const secretCode = base32(randomBytes(20));
    const id = randomAlphaNumeric(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const plaintext = Buffer.from(secretCode, "utf8");
    let secret: CognitoRecoverableSecretState;
    try {
      secret = {
        id,
        version: 1,
        envelope: this.secrets.encrypt(plaintext, {
          purpose: "TOTP_SEED",
          accountId: this.store.accountId,
          region: this.region,
          poolId: context.pool.id,
          ownerId: context.user.sub,
          secretId: id,
          secretVersion: 1,
          field: "totp-seed",
        }),
      };
    } finally {
      plaintext.fill(0);
    }
    await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user || user.generationId !== context.user.generationId) {
        throw new AwsError("NotAuthorizedException", "User session is no longer valid.");
      }
      user.mfa.softwareToken = { enabled: false, preferred: false, secret };
      user.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
    });
    return {
      SecretCode: secretCode,
      ...(input.Session === undefined ? {} : { Session: input.Session }),
    };
  }

  private softwareTokenSecret(pool: CognitoUserPoolState, user: CognitoUserState): string {
    const secret = user.mfa.softwareToken?.secret;
    if (!secret) throw new AwsError("SoftwareTokenMFANotFoundException", "Software token is not associated.");
    const plaintext = this.secrets.decrypt(secret.envelope, {
      purpose: "TOTP_SEED",
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      ownerId: user.sub,
      secretId: secret.id,
      secretVersion: secret.version,
      field: "totp-seed",
    });
    try {
      return plaintext.toString("utf8");
    } finally {
      plaintext.fill(0);
    }
  }

  async VerifySoftwareToken(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (
      Object.keys(input).some(key => !["AccessToken", "Session", "UserCode", "FriendlyDeviceName"].includes(key))
      || (input.AccessToken === undefined) === (input.Session === undefined)
      || typeof input.UserCode !== "string"
      || !/^\d{6}$/.test(input.UserCode)
    ) {
      throw new AwsError("InvalidParameterException", "VerifySoftwareToken parameters are invalid.");
    }
    if (input.FriendlyDeviceName !== undefined && (typeof input.FriendlyDeviceName !== "string" || input.FriendlyDeviceName.length > 128)) {
      throw new AwsError("InvalidParameterException", "FriendlyDeviceName is invalid.");
    }
    const context = this.mfaUserContext(input);
    const secret = this.softwareTokenSecret(context.pool, context.user);
    const supplied = Buffer.from(input.UserCode, "ascii");
    let valid = false;
    try {
      for (const offset of [-30_000, 0, 30_000]) {
        const expected = Buffer.from(totpCode(secret, this.clock.now() + offset), "ascii");
        try {
          valid ||= timingSafeEqual(supplied, expected);
        } finally {
          expected.fill(0);
        }
      }
    } finally {
      supplied.fill(0);
    }
    if (!valid) throw new AwsError("CodeMismatchException", "Invalid software token code.");
    await this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user?.mfa.softwareToken?.secret) {
        throw new AwsError("SoftwareTokenMFANotFoundException", "Software token is not associated.");
      }
      user.mfa.softwareToken.enabled = true;
      user.mfa.softwareToken.verifiedAt = this.clock.now();
      if (!user.userMfaSettingList.includes("SOFTWARE_TOKEN_MFA")) {
        user.userMfaSettingList.push("SOFTWARE_TOKEN_MFA");
      }
      user.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
    });
    return { Status: "SUCCESS", ...(input.Session === undefined ? {} : { Session: input.Session }) };
  }

  private mfaSettings(input: Record<string, any>): {
    software?: { enabled: boolean; preferred: boolean };
    email?: { enabled: boolean; preferred: boolean };
  } {
    const parse = (value: unknown, field: string): { enabled: boolean; preferred: boolean } | undefined => {
      if (value === undefined) return undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AwsError("InvalidParameterException", `${field} is invalid.`);
      }
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some(key => !["Enabled", "PreferredMfa"].includes(key))) {
        throw new AwsError("InvalidParameterException", `${field} contains an unsupported field.`);
      }
      if (typeof record.Enabled !== "boolean" || typeof record.PreferredMfa !== "boolean") {
        throw new AwsError("InvalidParameterException", `${field} settings are invalid.`);
      }
      if (record.PreferredMfa && !record.Enabled) {
        throw new AwsError("InvalidParameterException", `${field} cannot be preferred while disabled.`);
      }
      return { enabled: record.Enabled, preferred: record.PreferredMfa };
    };
    const software = parse(input.SoftwareTokenMfaSettings, "SoftwareTokenMfaSettings");
    const email = parse(input.EmailMfaSettings, "EmailMfaSettings");
    if (software?.preferred && email?.preferred) {
      throw new AwsError("InvalidParameterException", "Only one MFA method can be preferred.");
    }
    return { ...(software ? { software } : {}), ...(email ? { email } : {}) };
  }

  private applyMfaSettings(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    settings: ReturnType<CognitoService["mfaSettings"]>,
  ): void {
    if (settings.software) {
      if (settings.software.enabled && !user.mfa.softwareToken?.verifiedAt) {
        throw new AwsError("SoftwareTokenMFANotFoundException", "Software token has not been verified.");
      }
      if (!pool.configuration.enabledMfas.includes("SOFTWARE_TOKEN_MFA") && settings.software.enabled) {
        throw new AwsError("InvalidParameterException", "Software-token MFA is not enabled for the pool.");
      }
      user.mfa.softwareToken ??= { enabled: false, preferred: false };
      user.mfa.softwareToken.enabled = settings.software.enabled;
      user.mfa.softwareToken.preferred = settings.software.preferred;
    }
    if (settings.email) {
      if (!pool.configuration.enabledMfas.includes("EMAIL_OTP") && settings.email.enabled) {
        throw new AwsError("InvalidParameterException", "Email MFA is not enabled for the pool.");
      }
      if (settings.email.enabled && !user.attributes.email?.verified) {
        throw new AwsError("InvalidParameterException", "Email MFA requires a verified email.");
      }
      user.mfa.email = { enabled: settings.email.enabled, preferred: settings.email.preferred };
    }
    user.userMfaSettingList = [
      ...(user.mfa.softwareToken?.enabled ? ["SOFTWARE_TOKEN_MFA" as const] : []),
      ...(user.mfa.email?.enabled ? ["EMAIL_OTP" as const] : []),
    ];
    user.preferredMfaSetting = user.mfa.softwareToken?.preferred
      ? "SOFTWARE_TOKEN_MFA"
      : user.mfa.email?.preferred
        ? "EMAIL_OTP"
        : undefined;
    user.updatedAt = this.clock.now();
  }

  async SetUserMFAPreference(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["AccessToken", "SMSMfaSettings", "SoftwareTokenMfaSettings", "EmailMfaSettings"].includes(key))) {
      throw new AwsError("InvalidParameterException", "SetUserMFAPreference parameters are invalid.");
    }
    if (input.SMSMfaSettings !== undefined) throw new AwsError("InvalidParameterException", "SMS MFA is unavailable.");
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    const settings = this.mfaSettings(input);
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      this.applyMfaSettings(pool, user, settings);
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminSetUserMFAPreference(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "SMSMfaSettings", "SoftwareTokenMfaSettings", "EmailMfaSettings"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminSetUserMFAPreference parameters are invalid.");
    }
    if (input.SMSMfaSettings !== undefined) throw new AwsError("InvalidParameterException", "SMS MFA is unavailable.");
    const pool = this.pool(input.UserPoolId);
    const user = this.adminUser(pool, input.Username);
    const settings = this.mfaSettings(input);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const current = this.adminUser(currentPool, user.username);
      this.applyMfaSettings(currentPool, current, settings);
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  GetUserAuthFactors(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => key !== "AccessToken")) {
      throw new AwsError("InvalidParameterException", "GetUserAuthFactors parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return {
      ConfiguredUserAuthFactors: [
        "PASSWORD",
        ...(context.user.userMfaSettingList.includes("EMAIL_OTP") ? ["EMAIL_OTP"] : []),
      ],
    };
  }

  async SetUserPoolMfaConfig(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some(key => ![
      "UserPoolId", "SmsMfaConfiguration", "SoftwareTokenMfaConfiguration",
      "MfaConfiguration", "EmailMfaConfiguration",
    ].includes(key))) {
      throw new AwsError("InvalidParameterException", "SetUserPoolMfaConfig parameters are invalid.");
    }
    if (input.SmsMfaConfiguration !== undefined) {
      throw new AwsError("InvalidParameterException", "SMS MFA is unavailable.");
    }
    const pool = this.pool(input.UserPoolId);
    const mfaConfiguration = input.MfaConfiguration ?? "OFF";
    if (!["OFF", "ON", "OPTIONAL"].includes(mfaConfiguration)) {
      throw new AwsError("InvalidParameterException", "MfaConfiguration is invalid.");
    }
    const softwareEnabled = input.SoftwareTokenMfaConfiguration?.Enabled === true;
    if (
      input.SoftwareTokenMfaConfiguration !== undefined
      && (
        !input.SoftwareTokenMfaConfiguration
        || typeof input.SoftwareTokenMfaConfiguration !== "object"
        || Object.keys(input.SoftwareTokenMfaConfiguration).some(key => key !== "Enabled")
        || typeof input.SoftwareTokenMfaConfiguration.Enabled !== "boolean"
      )
    ) {
      throw new AwsError("InvalidParameterException", "SoftwareTokenMfaConfiguration is invalid.");
    }
    let emailMfaConfiguration: CognitoUserPoolConfigurationState["emailMfaConfiguration"];
    if (input.EmailMfaConfiguration !== undefined) {
      if (
        pool.configuration.emailConfiguration.emailSendingAccount !== "DEVELOPER"
        || !["ESSENTIALS", "PLUS"].includes(pool.configuration.userPoolTier)
      ) {
        throw new AwsError(
          "InvalidParameterException",
          "Email MFA requires an eligible pool with DEVELOPER email delivery.",
        );
      }
      const email = input.EmailMfaConfiguration;
      if (
        !email
        || typeof email !== "object"
        || Object.keys(email).some(key => !["Message", "Subject"].includes(key))
      ) {
        throw new AwsError("InvalidParameterException", "EmailMfaConfiguration is invalid.");
      }
      const subject = email.Subject ?? "Your sign-in code";
      const message = email.Message ?? "Your sign-in code is {####}.";
      if (
        typeof subject !== "string"
        || subject.length < 1
        || subject.length > 140
        || typeof message !== "string"
        || !message.includes("{####}")
        || message.length > 20_000
      ) {
        throw new AwsError("InvalidParameterException", "Email MFA template is invalid.");
      }
      emailMfaConfiguration = { subject, message };
    }
    if (mfaConfiguration === "ON" && !softwareEnabled && !emailMfaConfiguration) {
      throw new AwsError("InvalidParameterException", "Required MFA must enable at least one MFA method.");
    }
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      current.configuration.mfaConfiguration = mfaConfiguration;
      current.configuration.enabledMfas = [
        ...(softwareEnabled ? ["SOFTWARE_TOKEN_MFA" as const] : []),
        ...(emailMfaConfiguration ? ["EMAIL_OTP" as const] : []),
      ];
      current.configuration.emailMfaConfiguration = emailMfaConfiguration;
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return this.GetUserPoolMfaConfig({ UserPoolId: current.id });
    });
  }

  GetUserPoolMfaConfig(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => key !== "UserPoolId")) {
      throw new AwsError("InvalidParameterException", "GetUserPoolMfaConfig parameters are invalid.");
    }
    const configuration = this.pool(input.UserPoolId).configuration;
    return {
      MfaConfiguration: configuration.mfaConfiguration,
      SoftwareTokenMfaConfiguration: {
        Enabled: configuration.enabledMfas.includes("SOFTWARE_TOKEN_MFA"),
      },
      ...(configuration.emailMfaConfiguration
        ? {
            EmailMfaConfiguration: {
              Subject: configuration.emailMfaConfiguration.subject,
              Message: configuration.emailMfaConfiguration.message,
            },
          }
        : {}),
    };
  }

  async ConfirmDevice(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (
      Object.keys(input).some(key => ![
        "AccessToken", "DeviceKey", "DeviceName", "DeviceSecretVerifierConfig",
      ].includes(key))
    ) {
      throw new AwsError("InvalidParameterException", "ConfirmDevice parameters are invalid.");
    }
    const deviceKey = assertDeviceKey(input.DeviceKey);
    if (input.DeviceName !== undefined && (typeof input.DeviceName !== "string" || input.DeviceName.length > 1_024)) {
      throw new AwsError("InvalidParameterException", "DeviceName is invalid.");
    }
    const verifier = input.DeviceSecretVerifierConfig;
    if (
      !verifier
      || typeof verifier !== "object"
      || Array.isArray(verifier)
      || Object.keys(verifier).some(key => !["PasswordVerifier", "Salt"].includes(key))
      || typeof verifier.PasswordVerifier !== "string"
      || typeof verifier.Salt !== "string"
      || verifier.PasswordVerifier.length < 1
      || verifier.PasswordVerifier.length > 131_072
      || verifier.Salt.length < 1
      || verifier.Salt.length > 131_072
    ) {
      throw new AwsError("InvalidParameterException", "DeviceSecretVerifierConfig is invalid.");
    }
    decodeDeviceVerifierMaterial(verifier.PasswordVerifier, verifier.Salt);
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      if (!deviceTrackingEnabled(pool.configuration)) {
        throw new AwsError("InvalidParameterException", "Device tracking is not enabled for this user pool.");
      }
      purgeExpiredPendingDevices(user, this.clock.now());
      const pending = ensurePendingDevices(user)[deviceKey];
      if (
        !pending
        || pending.clientId !== context.client.id
        || pending.eventId !== context.session.eventId
        || this.clock.now() >= pending.expiresAt
      ) {
        throw new AwsError("ResourceNotFoundException", "Device does not exist.");
      }
      if (user.devices[deviceKey]) {
        throw new AwsError("DeviceKeyExistsException", "Device already exists.");
      }
      if (Object.keys(user.devices).length >= MAX_DEVICES_PER_USER) {
        throw new AwsError("LimitExceededException", "Device limit exceeded.");
      }
      const wrapped = this.wrapDeviceVerifier(
        pool,
        user,
        deviceKey,
        verifier.PasswordVerifier,
        verifier.Salt,
      );
      const deviceConfig = pool.configuration.deviceConfiguration!;
      const canRemember = deviceConfig.challengeRequiredOnNewDevice;
      const promptOnly = canRemember && deviceConfig.deviceOnlyRememberedOnUserPrompt;
      const now = this.clock.now();
      user.devices[deviceKey] = {
        key: deviceKey,
        groupKey: pending.groupKey,
        ...(input.DeviceName ? { name: input.DeviceName } : {}),
        rememberedStatus: canRemember && !promptOnly ? "remembered" : "not_remembered",
        createdAt: now,
        lastModifiedAt: now,
        passwordVerifier: wrapped.passwordVerifier,
        salt: wrapped.salt,
      };
      delete user.pendingDevices![deviceKey];
      user.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return { UserConfirmationNecessary: promptOnly };
    });
  }

  private deviceForUser(user: CognitoUserState, deviceKey: unknown): import("./types.js").CognitoDeviceState {
    if (typeof deviceKey !== "string") throw new AwsError("InvalidParameterException", "DeviceKey is required.");
    const device = user.devices[deviceKey];
    if (!device) throw new AwsError("ResourceNotFoundException", "Device does not exist.");
    return device;
  }

  GetDevice(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["AccessToken", "DeviceKey"].includes(key))) {
      throw new AwsError("InvalidParameterException", "GetDevice parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return { Device: deviceView(this.deviceForUser(context.user, input.DeviceKey)) };
  }

  private listUserDevices(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    limitValue: unknown,
    paginationToken: unknown,
    operation: "ListDevices" | "AdminListDevices",
  ): Record<string, unknown> {
    const limit = limitValue === undefined ? 60 : limitValue;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 60) {
      throw new AwsError("InvalidParameterException", "Device pagination parameters are invalid.");
    }
    const devices = Object.values(user.devices)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    let index = 0;
    if (paginationToken !== undefined) {
      if (typeof paginationToken !== "string" || paginationToken.length < 1) {
        throw new AwsError("InvalidParameterException", "PaginationToken is invalid.");
      }
      try {
        const cursor = this.tokens.decode<{
          poolId: string;
          userSub: string;
          revision: number;
          index: number;
        }>(operation, paginationToken);
        if (
          cursor.poolId !== pool.id
          || cursor.userSub !== user.sub
          || cursor.revision !== this.state.revision
          || !Number.isInteger(cursor.index)
          || cursor.index < 0
        ) {
          throw new Error();
        }
        index = cursor.index;
      } catch {
        throw new AwsError("InvalidParameterException", "PaginationToken is invalid.");
      }
    }
    const page = devices.slice(index, index + Number(limit));
    const next = index + page.length;
    return {
      Devices: page.map(deviceView),
      ...(next < devices.length
        ? {
            PaginationToken: this.tokens.encode(operation, {
              poolId: pool.id,
              userSub: user.sub,
              revision: this.state.revision,
              index: next,
            }),
          }
        : {}),
    };
  }

  ListDevices(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["AccessToken", "Limit", "PaginationToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ListDevices parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.listUserDevices(
      context.pool,
      context.user,
      input.Limit,
      input.PaginationToken,
      "ListDevices",
    );
  }

  async ForgetDevice(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["AccessToken", "DeviceKey"].includes(key))) {
      throw new AwsError("InvalidParameterException", "ForgetDevice parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.exclusive(async () => {
      const user = this.pool(context.pool.id).usersBySub[context.user.sub];
      if (!user) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      this.deviceForUser(user, input.DeviceKey);
      delete user.devices[input.DeviceKey];
      user.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private async updateDevice(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
    deviceKey: unknown,
    status: unknown,
  ): Promise<Record<string, never>> {
    if (typeof status !== "string" || !["remembered", "not_remembered"].includes(status)) {
      throw new AwsError("InvalidParameterException", "DeviceRememberedStatus is invalid.");
    }
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentUser = currentPool.usersBySub[user.sub];
      if (!currentUser) throw new AwsError("UserNotFoundException", "User does not exist.");
      if (
        status === "remembered"
        && !currentPool.configuration.deviceConfiguration?.challengeRequiredOnNewDevice
      ) {
        throw new AwsError(
          "InvalidParameterException",
          "ChallengeRequiredOnNewDevice must be enabled to remember a device.",
        );
      }
      const device = this.deviceForUser(currentUser, deviceKey);
      if (status === "remembered" && !device.passwordVerifier && !device.secretVerifier) {
        throw new AwsError("InvalidParameterException", "Device credentials are required before remembering.");
      }
      device.rememberedStatus = status as "remembered" | "not_remembered";
      device.lastModifiedAt = this.clock.now();
      currentUser.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  UpdateDeviceStatus(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["AccessToken", "DeviceKey", "DeviceRememberedStatus"].includes(key))) {
      throw new AwsError("InvalidParameterException", "UpdateDeviceStatus parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.updateDevice(context.pool, context.user, input.DeviceKey, input.DeviceRememberedStatus);
  }

  private adminDeviceContext(input: Record<string, any>): {
    pool: CognitoUserPoolState;
    user: CognitoUserState;
  } {
    const pool = this.pool(input.UserPoolId);
    return { pool, user: this.adminUser(pool, input.Username) };
  }

  AdminGetDevice(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "DeviceKey"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminGetDevice parameters are invalid.");
    }
    const { user } = this.adminDeviceContext(input);
    return { Device: deviceView(this.deviceForUser(user, input.DeviceKey)) };
  }

  AdminListDevices(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "Limit", "PaginationToken"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminListDevices parameters are invalid.");
    }
    const { pool, user } = this.adminDeviceContext(input);
    return this.listUserDevices(pool, user, input.Limit, input.PaginationToken, "AdminListDevices");
  }

  async AdminForgetDevice(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => !["UserPoolId", "Username", "DeviceKey"].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminForgetDevice parameters are invalid.");
    }
    const { pool, user } = this.adminDeviceContext(input);
    return this.exclusive(async () => {
      const current = this.adminUser(this.pool(pool.id), user.username);
      this.deviceForUser(current, input.DeviceKey);
      delete current.devices[input.DeviceKey];
      current.updatedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  AdminUpdateDeviceStatus(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => ![
      "UserPoolId", "Username", "DeviceKey", "DeviceRememberedStatus",
    ].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminUpdateDeviceStatus parameters are invalid.");
    }
    const { pool, user } = this.adminDeviceContext(input);
    return this.updateDevice(pool, user, input.DeviceKey, input.DeviceRememberedStatus);
  }

  AdminListUserAuthEvents(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => ![
      "UserPoolId", "Username", "MaxResults", "NextToken",
    ].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminListUserAuthEvents parameters are invalid.");
    }
    const { pool, user } = this.adminDeviceContext(input);
    const limit = input.MaxResults === undefined ? 60 : input.MaxResults;
    if (!Number.isInteger(limit) || limit < 1 || limit > 60 || input.NextToken !== undefined) {
      throw new AwsError("InvalidParameterException", "Auth-event pagination parameters are invalid.");
    }
    return {
      AuthEvents: pool.authEvents
        .filter(event => event.userSub === user.sub)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(event => ({
          EventId: event.eventId,
          EventType: event.eventType,
          CreationDate: timestamp(event.createdAt),
          ...(event.feedbackValue
            ? { EventFeedback: { FeedbackValue: event.feedbackValue, Provider: "User", FeedbackDate: timestamp(event.createdAt) } }
            : {}),
        })),
    };
  }

  async UpdateAuthEventFeedback(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => ![
      "AccessToken", "EventId", "FeedbackToken", "FeedbackValue",
    ].includes(key))) {
      throw new AwsError("InvalidParameterException", "UpdateAuthEventFeedback parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    if (!["Valid", "Invalid"].includes(input.FeedbackValue)) {
      throw new AwsError("InvalidParameterException", "FeedbackValue is invalid.");
    }
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const event = pool.authEvents.find(candidate =>
        candidate.eventId === input.EventId && candidate.userSub === context.user.sub
      );
      if (!event) throw new AwsError("ResourceNotFoundException", "Authentication event does not exist.");
      event.feedbackValue = input.FeedbackValue;
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  async AdminUpdateAuthEventFeedback(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => ![
      "UserPoolId", "Username", "EventId", "FeedbackToken", "FeedbackValue",
    ].includes(key))) {
      throw new AwsError("InvalidParameterException", "AdminUpdateAuthEventFeedback parameters are invalid.");
    }
    if (!["Valid", "Invalid"].includes(input.FeedbackValue)) {
      throw new AwsError("InvalidParameterException", "FeedbackValue is invalid.");
    }
    const { pool, user } = this.adminDeviceContext(input);
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const event = current.authEvents.find(candidate =>
        candidate.eventId === input.EventId && candidate.userSub === user.sub
      );
      if (!event) throw new AwsError("ResourceNotFoundException", "Authentication event does not exist.");
      event.feedbackValue = input.FeedbackValue;
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  SetUserSettings(input: Record<string, any>): Record<string, never> {
    if (
      Object.keys(input).some(key => !["AccessToken", "MFAOptions"].includes(key))
      || !Array.isArray(input.MFAOptions)
      || input.MFAOptions.length !== 0
    ) {
      throw new AwsError("InvalidParameterException", "SMS MFA options are unavailable.");
    }
    if (!this.accessProof.get(input)) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return {};
  }

  AdminSetUserSettings(input: Record<string, any>): Record<string, never> {
    if (
      Object.keys(input).some(key => !["UserPoolId", "Username", "MFAOptions"].includes(key))
      || !Array.isArray(input.MFAOptions)
      || input.MFAOptions.length !== 0
    ) {
      throw new AwsError("InvalidParameterException", "SMS MFA options are unavailable.");
    }
    this.adminUser(this.pool(input.UserPoolId), input.Username);
    return {};
  }

  DeleteUserPoolReplica(input: Record<string, any>): Record<string, never> {
    if (
      Object.keys(input).some(key => !["UserPoolId", "Region"].includes(key))
      || typeof input.Region !== "string"
    ) {
      throw new AwsError("InvalidParameterException", "DeleteUserPoolReplica parameters are invalid.");
    }
    this.pool(input.UserPoolId);
    throw new AwsError("ResourceNotFoundException", `No user-pool replica exists in ${input.Region}.`);
  }

  async AddUserPoolClientSecret(input: Record<string, any>): Promise<Record<string, unknown>> {
    const parsed = parseAddUserPoolClientSecretInput(input);
    const pool = this.pool(parsed.userPoolId);
    const existing = this.appClient(pool, parsed.clientId);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const client = this.appClient(currentPool, existing.id);
      const secrets = ensureConfidentialClient(client);
      if (secrets.length >= MAX_ACTIVE_CLIENT_SECRETS) {
        throw new AwsError("LimitExceededException", "An app client cannot have more than two active secrets.");
      }
      const secretValue = parsed.generate ? generatedClientSecretValue() : parsed.supplied!;
      const now = this.clock.now();
      const entry = createClientSecretEntry(
        currentPool.id,
        client.id,
        now,
        (poolIdValue, clientIdValue, value) => this.secretState(poolIdValue, clientIdValue, value),
        secretValue,
      );
      assignClientSecrets(client, [...secrets, entry]);
      client.updatedAt = now;
      currentPool.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return {
        ClientSecretDescriptor: clientSecretDescriptor(
          entry,
          parsed.generate ? secretValue : undefined,
        ),
      };
    });
  }

  ListUserPoolClientSecrets(input: Record<string, any>): Record<string, unknown> {
    const parsed = parseListUserPoolClientSecretsInput(input);
    const pool = this.pool(parsed.userPoolId);
    const client = this.appClient(pool, parsed.clientId);
    ensureConfidentialClient(client);
    return {
      ClientSecrets: normalizedClientSecrets(client)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(entry => clientSecretDescriptor(entry)),
    };
  }

  async DeleteUserPoolClientSecret(input: Record<string, any>): Promise<Record<string, never>> {
    const parsed = parseDeleteUserPoolClientSecretInput(input);
    const pool = this.pool(parsed.userPoolId);
    const existing = this.appClient(pool, parsed.clientId);
    return this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const client = this.appClient(currentPool, existing.id);
      const secrets = ensureConfidentialClient(client);
      if (secrets.length <= 1) {
        throw new AwsError(
          "InvalidParameterException",
          "An app client must retain at least one active client secret.",
        );
      }
      const remaining = secrets.filter(entry => entry.id !== parsed.clientSecretId);
      if (remaining.length === secrets.length) {
        throw new AwsError("ResourceNotFoundException", "Client secret does not exist.");
      }
      assignClientSecrets(client, remaining);
      client.updatedAt = this.clock.now();
      currentPool.updatedAt = client.updatedAt;
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  private async refreshAuthentication(input: Record<string, any>): Promise<Record<string, unknown>> {
    const context = this.refreshProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const client = this.appClient(pool, context.client.id);
      const session = pool.refreshSessions[context.session.id];
      const user = pool.usersBySub[context.user.sub];
      if (
        session
        && client.refreshTokenRotation.feature === "ENABLED"
        && session.status === "REVOKED"
        && session.revocationReason === "ROTATED"
        && session.rotationGraceUntil !== undefined
        && this.clock.now() > session.rotationGraceUntil
      ) {
        for (const candidate of Object.values(pool.refreshSessions)) {
          if (
            candidate.clientId === session.clientId
            && candidate.originJti === session.originJti
            && candidate.status === "ACTIVE"
          ) {
            candidate.status = "REVOKED";
            candidate.revokedAt = this.clock.now();
            candidate.revocationReason = "REPLAY";
          }
        }
        this.state.revision += 1;
        await this.store.save();
        throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
      }
      const activeOrRotationGrace = Boolean(
        session
        && (
          session.status === "ACTIVE"
          || (
            client.refreshTokenRotation.feature === "ENABLED"
            && session.revocationReason === "ROTATED"
            && session.rotationGraceUntil !== undefined
            && this.clock.now() <= session.rotationGraceUntil
          )
        )
      );
      if (
        !session
        || !user
        || !activeOrRotationGrace
        || session.clientId !== client.id
        || session.userGenerationId !== user.generationId
        || session.sessionEpoch !== user.sessionEpoch
        || this.clock.now() >= session.expiresAt
        || !user.enabled
        || !tokenEligibleUser(user)
      ) {
        throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
      }
      let result: Record<string, unknown>;
      if (
        client.refreshTokenRotation.feature === "ENABLED"
        && Object.prototype.hasOwnProperty.call(input, "RefreshToken")
      ) {
        const created = this.newRefreshSession(pool, client, user, session);
        if (created.session.expiresAt <= this.clock.now()) {
          throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
        }
        result = await this.authenticationResult(pool, client, user, created.session, created.token);
        pool.refreshSessions[created.session.id] = created.session;
        session.status = "REVOKED";
        session.revokedAt = this.clock.now();
        session.revocationReason = "ROTATED";
        session.replacedBySessionId = created.session.id;
        session.rotationGraceUntil = this.clock.now()
          + client.refreshTokenRotation.retryGracePeriodSeconds * 1_000;
      } else {
        result = await this.authenticationResult(pool, client, user, session);
        session.lastUsedAt = this.clock.now();
      }
      this.state.revision += 1;
      await this.store.save();
      return { AuthenticationResult: result };
    });
  }

  async GetTokensFromRefreshToken(input: Record<string, any>): Promise<Record<string, unknown>> {
    const unknown = Object.keys(input).find(key => !["RefreshToken", "ClientId", "ClientSecret"].includes(key));
    if (unknown || typeof input.RefreshToken !== "string") {
      throw new AwsError("InvalidParameterException", "GetTokensFromRefreshToken parameters are invalid.");
    }
    return this.refreshAuthentication(input);
  }

  async RevokeToken(input: Record<string, any>): Promise<Record<string, never>> {
    const unknown = Object.keys(input).find(key => !["Token", "ClientId", "ClientSecret"].includes(key));
    if (unknown || typeof input.Token !== "string") {
      throw new AwsError("InvalidParameterException", "RevokeToken parameters are invalid.");
    }
    const context = this.refreshProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      this.appClient(pool, context.client.id);
      const session = pool.refreshSessions[context.session.id];
      if (!session || session.clientId !== context.client.id) {
        throw new AwsError("NotAuthorizedException", "Invalid Refresh Token.");
      }
      if (session.status === "ACTIVE" || session.revocationReason === "ROTATED") {
        for (const candidate of Object.values(pool.refreshSessions)) {
          if (
            candidate.clientId === session.clientId
            && candidate.originJti === session.originJti
            && candidate.status === "ACTIVE"
          ) {
            candidate.status = "REVOKED";
            candidate.revokedAt = this.clock.now();
            candidate.revocationReason = "TOKEN_REVOKE";
          }
        }
        session.status = "REVOKED";
        session.revokedAt = this.clock.now();
        session.revocationReason = "TOKEN_REVOKE";
        this.state.revision += 1;
        await this.store.save();
      }
      return {};
    });
  }

  GetUser(input: Record<string, any>): Record<string, unknown> {
    if (Object.keys(input).some(key => key !== "AccessToken")) {
      throw new AwsError("InvalidParameterException", "GetUser parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return {
      Username: context.user.username,
      UserAttributes: userAttributesView(context.user).filter(attribute =>
        attribute.Name === "sub"
        || context.client.readAttributes.includes(attribute.Name)
        || attribute.Name === "email_verified" && context.client.readAttributes.includes("email")
      ),
      PreferredMfaSetting: context.user.preferredMfaSetting,
      UserMFASettingList: [...context.user.userMfaSettingList],
    };
  }

  async GlobalSignOut(input: Record<string, any>): Promise<Record<string, never>> {
    if (Object.keys(input).some(key => key !== "AccessToken")) {
      throw new AwsError("InvalidParameterException", "GlobalSignOut parameters are invalid.");
    }
    const context = this.accessProof.get(input);
    if (!context) throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
    return this.exclusive(async () => {
      const pool = this.pool(context.pool.id);
      const user = pool.usersBySub[context.user.sub];
      if (!user || user.generationId !== context.user.generationId) {
        throw new AwsError("NotAuthorizedException", "Access Token has been revoked.");
      }
      user.sessionEpoch += 1;
      user.updatedAt = this.clock.now();
      for (const session of Object.values(pool.refreshSessions)) {
        if (session.userSub === user.sub && session.status === "ACTIVE") {
          session.status = "REVOKED";
          session.revokedAt = this.clock.now();
          session.revocationReason = "GLOBAL_SIGN_OUT";
        }
      }
      this.state.revision += 1;
      await this.store.save();
      return {};
    });
  }

  summary(): { poolCount: number; clientCount: number } {
    const pools = Object.values(this.state.pools);
    return {
      poolCount: pools.length,
      clientCount: pools.reduce((total, pool) => total + Object.keys(pool.clients).length, 0),
    };
  }

  localUserPools(): { userPools: Array<Record<string, unknown>> } {
    return {
      userPools: Object.values(this.state.pools)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
        .map(pool => ({
          id: pool.id,
          arn: pool.arn,
          name: pool.name,
          status: pool.status,
          createdAt: pool.createdAt,
          updatedAt: pool.updatedAt,
          userCount: Object.keys(pool.usersBySub).length,
          appClientCount: Object.keys(pool.clients).length,
          tags: { ...pool.tags },
        })),
    };
  }

  localUserPool(poolIdValue: string): { userPool: Record<string, unknown> } {
    const pool = this.pool(poolIdValue);
    const configuration = pool.configuration;
    return {
      userPool: {
        id: pool.id,
        arn: pool.arn,
        name: pool.name,
        status: pool.status,
        createdAt: pool.createdAt,
        updatedAt: pool.updatedAt,
        issuer: cognitoIssuer(this.region, pool.id),
        localJwksPath: `/_stacksim/cognito-idp/${encodeURIComponent(this.region)}/${encodeURIComponent(pool.id)}/.well-known/jwks.json`,
        localDiscoveryPath: `/_stacksim/cognito-idp/${encodeURIComponent(this.region)}/${encodeURIComponent(pool.id)}/.well-known/openid-configuration`,
        domain: pool.domain
          ? {
              name: pool.domain.domain,
              managedLoginVersion: pool.domain.managedLoginVersion,
              baseUrl: this.localDomainBase(pool.id),
            }
          : undefined,
        resourceServerCount: Object.keys(pool.resourceServers).length,
        inboxPath: "#/ses/inbox?originService=cognito-idp",
        userCount: Object.keys(pool.usersBySub).length,
        appClientCount: Object.keys(pool.clients).length,
        configuration: {
          deletionProtection: configuration.deletionProtection,
          tier: configuration.userPoolTier,
          signIn: {
            usernameAttributes: [...configuration.usernameAttributes],
            aliasAttributes: [...configuration.aliasAttributes],
            caseSensitive: configuration.usernameConfiguration.caseSensitive,
          },
          selfServiceSignUp: {
            enabled: !configuration.adminCreateUserConfig.allowAdminCreateUserOnly,
            requiredAttributes: configuration.schemaAttributes
              .filter(attribute => attribute.required)
              .map(attribute => attribute.name),
            autoVerifiedAttributes: [...configuration.autoVerifiedAttributes],
          },
          passwordPolicy: { ...configuration.policies.passwordPolicy },
          accountRecovery: configuration.accountRecoverySetting
            ? structuredClone(configuration.accountRecoverySetting)
            : undefined,
          email: {
            sendingAccount: configuration.emailConfiguration.emailSendingAccount,
            sourceArn: configuration.emailConfiguration.sourceArn,
            from: configuration.emailConfiguration.from,
            replyToEmailAddress: configuration.emailConfiguration.replyToEmailAddress,
            configurationSet: configuration.emailConfiguration.configurationSet,
            verificationSubject: configuration.verificationMessageTemplate.emailSubject,
            verificationMethod: "CONFIRM_WITH_CODE",
          },
          mfa: {
            mode: configuration.mfaConfiguration,
            enabledMethods: [...configuration.enabledMfas],
            emailTemplate: configuration.emailMfaConfiguration
              ? { ...configuration.emailMfaConfiguration }
              : undefined,
          },
          lambdaTriggers: { ...configuration.lambdaConfig },
          attributeSchema: configuration.schemaAttributes.map(attribute => ({
            name: STANDARD_USER_ATTRIBUTES.has(attribute.name) ? attribute.name : `custom:${attribute.name}`,
            dataType: attribute.attributeDataType,
            developerOnly: attribute.developerOnlyAttribute,
            mutable: attribute.mutable,
            required: attribute.required,
            stringConstraints: attribute.stringAttributeConstraints
              ? { ...attribute.stringAttributeConstraints }
              : undefined,
            numberConstraints: attribute.numberAttributeConstraints
              ? { ...attribute.numberAttributeConstraints }
              : undefined,
          })),
          customAttributes: configuration.schemaAttributes
            .filter(attribute => attribute.name !== "email")
            .map(attribute => ({ ...attribute })),
        },
        boundaries: {
          tags: Object.keys(pool.tags).length ? { ...pool.tags } : "None",
          groupsAndAdminActions: "Available",
          mfa: "Software token and eligible email OTP",
          oauthAndManagedLogin: "Available",
          externalProviders: Object.keys(pool.identityProviders).length,
        },
      },
    };
  }

  localUsers(poolIdValue: string): { users: Array<Record<string, unknown>> } {
    const pool = this.pool(poolIdValue);
    return {
      users: Object.values(pool.usersBySub)
        .sort((left, right) => left.createdAt - right.createdAt || left.sub.localeCompare(right.sub))
        .map(user => this.localUserView(user)),
    };
  }

  localGroups(poolIdValue: string): { groups: Array<Record<string, unknown>> } {
    const pool = this.pool(poolIdValue);
    return {
      groups: Object.values(pool.groups)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(group => ({
          name: group.name,
          description: group.description,
          roleArn: group.roleArn,
          precedence: group.precedence,
          memberCount: Object.values(pool.usersBySub).filter(user => user.groupNames.includes(group.name)).length,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        })),
    };
  }

  async localCreateGroup(
    poolIdValue: string,
    input: Record<string, unknown>,
  ): Promise<{ group: Record<string, unknown> }> {
    const result = await this.CreateGroup({ ...input, UserPoolId: poolIdValue });
    const group = result.Group as Record<string, unknown>;
    return {
      group: this.localGroups(poolIdValue).groups.find(candidate => candidate.name === group.GroupName)!,
    };
  }

  async localDeleteGroup(poolIdValue: string, name: string): Promise<Record<string, never>> {
    return this.DeleteGroup({ UserPoolId: poolIdValue, GroupName: name });
  }

  async localSetUserGroup(
    poolIdValue: string,
    userSub: string,
    name: unknown,
    member: unknown,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    const input = { UserPoolId: pool.id, Username: user.username, GroupName: name };
    if (member === true) await this.AdminAddUserToGroup(input);
    else if (member === false) await this.AdminRemoveUserFromGroup(input);
    else throw new AwsError("InvalidParameterException", "Group membership is invalid.");
    return this.localUser(poolIdValue, userSub);
  }

  async localUpdateUserAttributes(
    poolIdValue: string,
    userSub: string,
    attributes: unknown,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    await this.AdminUpdateUserAttributes({
      UserPoolId: pool.id,
      Username: user.username,
      UserAttributes: attributes,
    });
    return this.localUser(poolIdValue, userSub);
  }

  async localDeleteUserAttributes(
    poolIdValue: string,
    userSub: string,
    attributeNames: unknown,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    await this.AdminDeleteUserAttributes({
      UserPoolId: pool.id,
      Username: user.username,
      UserAttributeNames: attributeNames,
    });
    return this.localUser(poolIdValue, userSub);
  }

  async localSetUserMfa(
    poolIdValue: string,
    userSub: string,
    emailEnabled: unknown,
    emailPreferred: unknown,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    await this.AdminSetUserMFAPreference({
      UserPoolId: pool.id,
      Username: user.username,
      EmailMfaSettings: { Enabled: emailEnabled, PreferredMfa: emailPreferred },
    });
    return this.localUser(poolIdValue, userSub);
  }

  async localResetUserPassword(
    poolIdValue: string,
    userSub: string,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    await this.AdminResetUserPassword({ UserPoolId: pool.id, Username: user.username });
    return this.localUser(poolIdValue, userSub);
  }

  async localSignOutUser(
    poolIdValue: string,
    userSub: string,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    await this.AdminUserGlobalSignOut({ UserPoolId: pool.id, Username: user.username });
    return this.localUser(poolIdValue, userSub);
  }

  async localCreateUser(
    poolIdValue: string,
    input: Record<string, unknown>,
  ): Promise<{ user: Record<string, unknown> }> {
    const created = await this.AdminCreateUser({ ...input, UserPoolId: poolIdValue });
    const username = String((created.User as Record<string, unknown>).Username);
    return { user: this.localUserView(this.adminUser(this.pool(poolIdValue), username)) };
  }

  async localSetUserEnabled(
    poolIdValue: string,
    userSub: string,
    enabled: boolean,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    if (enabled) {
      await this.AdminEnableUser({ UserPoolId: pool.id, Username: user.username });
    } else {
      await this.AdminDisableUser({ UserPoolId: pool.id, Username: user.username });
    }
    return this.localUser(poolIdValue, userSub);
  }

  async localSetUserPassword(
    poolIdValue: string,
    userSub: string,
    password: unknown,
    permanent: unknown,
  ): Promise<{ user: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    await this.AdminSetUserPassword({
      UserPoolId: pool.id,
      Username: user.username,
      Password: password,
      Permanent: permanent,
    });
    return this.localUser(poolIdValue, userSub);
  }

  async localDeleteUser(
    poolIdValue: string,
    userSub: string,
  ): Promise<Record<string, never>> {
    const pool = this.pool(poolIdValue);
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    return this.AdminDeleteUser({ UserPoolId: pool.id, Username: user.username });
  }

  localUser(poolIdValue: string, userSub: string): { user: Record<string, unknown> } {
    const pool = this.pool(poolIdValue);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userSub)) {
      throw new AwsError("InvalidParameterException", "User sub is invalid.");
    }
    const user = pool.usersBySub[userSub];
    if (!user) throw new AwsError("ResourceNotFoundException", "User not found.");
    return { user: this.localUserView(user) };
  }

  localAppClients(poolIdValue: string): { appClients: Array<Record<string, unknown>> } {
    const pool = this.pool(poolIdValue);
    return {
      appClients: Object.values(pool.clients)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
        .map(client => this.localAppClientView(client)),
    };
  }

  localAppClient(poolIdValue: string, clientIdValue: string): { appClient: Record<string, unknown> } {
    const pool = this.pool(poolIdValue);
    return { appClient: this.localAppClientView(this.appClient(pool, clientIdValue)) };
  }

  async localCreateUserPool(input: Record<string, unknown>): Promise<{ userPool: Record<string, unknown> }> {
    const created = await this.CreateUserPool(input);
    return this.localUserPool(String((created.UserPool as Record<string, unknown>).Id));
  }

  async localAddCustomAttributes(
    poolIdValue: string,
    input: Record<string, unknown>,
  ): Promise<{ userPool: Record<string, unknown> }> {
    if (Object.keys(input).some(key => key !== "CustomAttributes")) {
      throw new AwsError("InvalidParameterException", "Custom-attribute body is invalid.");
    }
    await this.AddCustomAttributes({
      UserPoolId: poolIdValue,
      CustomAttributes: input.CustomAttributes,
    });
    return this.localUserPool(poolIdValue);
  }

  async localDeleteUserPool(poolIdValue: string): Promise<Record<string, never>> {
    return this.DeleteUserPool({ UserPoolId: poolIdValue });
  }

  async localConfigureUserPool(
    poolIdValue: string,
    input: Record<string, unknown>,
  ): Promise<{ userPool: Record<string, unknown> }> {
    const pool = this.pool(poolIdValue);
    if (Object.keys(input).some(key => !["mfaMode", "softwareTokenMfa", "lambdaConfig", "tags"].includes(key))) {
      throw new AwsError("InvalidParameterException", "User-pool configuration body is invalid.");
    }
    if (input.mfaMode !== undefined || input.softwareTokenMfa !== undefined) {
      await this.SetUserPoolMfaConfig({
        UserPoolId: pool.id,
        MfaConfiguration: input.mfaMode ?? pool.configuration.mfaConfiguration,
        SoftwareTokenMfaConfiguration: {
          Enabled: input.softwareTokenMfa
            ?? pool.configuration.enabledMfas.includes("SOFTWARE_TOKEN_MFA"),
        },
        ...(pool.configuration.emailMfaConfiguration
          ? {
              EmailMfaConfiguration: {
                Subject: pool.configuration.emailMfaConfiguration.subject,
                Message: pool.configuration.emailMfaConfiguration.message,
              },
            }
          : {}),
      });
    }
    if (input.lambdaConfig !== undefined) {
      const configuration = this.pool(pool.id).configuration;
      await this.UpdateUserPool({
        UserPoolId: pool.id,
        Policies: poolConfigurationView(configuration).Policies,
        DeletionProtection: configuration.deletionProtection,
        AutoVerifiedAttributes: [...configuration.autoVerifiedAttributes],
        EmailConfiguration: poolConfigurationView(configuration).EmailConfiguration,
        VerificationMessageTemplate: poolConfigurationView(configuration).VerificationMessageTemplate,
        AdminCreateUserConfig: poolConfigurationView(configuration).AdminCreateUserConfig,
        AccountRecoverySetting: poolConfigurationView(configuration).AccountRecoverySetting,
        UserPoolTier: configuration.userPoolTier,
        MfaConfiguration: configuration.mfaConfiguration,
        EnabledMfas: [...configuration.enabledMfas],
        LambdaConfig: input.lambdaConfig,
      });
    }
    if (input.tags !== undefined) {
      const replacement = tagMap(input.tags);
      const current = this.pool(pool.id);
      await this.UntagResource({ ResourceArn: current.arn, TagKeys: Object.keys(current.tags) });
      if (Object.keys(replacement).length) {
        await this.TagResource({ ResourceArn: current.arn, Tags: replacement });
      }
    }
    return this.localUserPool(pool.id);
  }

  async localCreateAppClient(
    poolIdValue: string,
    input: Record<string, unknown>,
  ): Promise<{ appClient: Record<string, unknown> }> {
    const created = await this.CreateUserPoolClient({ ...input, UserPoolId: poolIdValue });
    const descriptor = created.UserPoolClient as Record<string, unknown>;
    return this.localAppClient(poolIdValue, String(descriptor.ClientId));
  }

  async localDeleteAppClient(
    poolIdValue: string,
    clientIdValue: string,
  ): Promise<Record<string, never>> {
    return this.DeleteUserPoolClient({ UserPoolId: poolIdValue, ClientId: clientIdValue });
  }

  private localUserView(user: CognitoUserState): Record<string, unknown> {
    return {
      sub: user.sub,
      username: user.username,
      enabled: user.enabled,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      attributes: Object.entries(user.attributes).map(([name, attribute]) => ({
        name,
        value: attribute.value,
        verified: attribute.verified,
      })),
      groups: [...user.groupNames],
      mfa: {
        preferred: user.preferredMfaSetting,
        enabled: [...user.userMfaSettingList],
      },
      externalIdentities: user.externalIdentities.map(identity => ({
        providerName: identity.providerName,
        providerType: identity.providerType,
        providerSubject: identity.providerSubject,
        linkedAt: identity.linkedAt,
      })),
      sessionCount: Object.values(this.state.pools)
        .flatMap(pool => Object.values(pool.refreshSessions))
        .filter(session => session.userSub === user.sub && session.status === "ACTIVE").length,
      groupsAvailable: true,
      adminActionsAvailable: true,
    };
  }

  private localAppClientView(client: CognitoAppClientState): Record<string, unknown> {
    return {
      id: client.id,
      name: client.name,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      enabledAuthFlows: [...client.explicitAuthFlows],
      validity: {
        accessToken: {
          value: client.accessTokenValidity,
          unit: client.tokenValidityUnits.accessToken,
        },
        idToken: {
          value: client.idTokenValidity,
          unit: client.tokenValidityUnits.idToken,
        },
        refreshToken: {
          value: client.refreshTokenValidity,
          unit: client.tokenValidityUnits.refreshToken,
        },
      },
      preventUserExistenceErrors: client.preventUserExistenceErrors,
      enableTokenRevocation: client.enableTokenRevocation,
      readAttributes: [...client.readAttributes],
      writeAttributes: [...client.writeAttributes],
      hasSecret: clientHasSecret(client),
      secretDisplay: clientHasSecret(client) ? "Masked; use the official API read surface when required" : "No client secret",
      oauthAvailable: client.allowedOAuthFlowsUserPoolClient,
      callbackUrlsAvailable: true,
      supportedIdentityProviders: [...client.supportedIdentityProviders],
      callbackUrls: [...client.callbackUrls],
      logoutUrls: [...client.logoutUrls],
      defaultRedirectUri: client.defaultRedirectUri,
      allowedOAuthFlows: [...client.allowedOAuthFlows],
      allowedOAuthScopes: [...client.allowedOAuthScopes],
      allowedOAuthFlowsUserPoolClient: client.allowedOAuthFlowsUserPoolClient,
    };
  }

  localOAuthSettings(poolIdValue: string): Record<string, unknown> {
    const pool = this.pool(poolIdValue);
    return {
      issuer: cognitoIssuer(this.region, pool.id),
      discoveryPath: `/_stacksim/cognito-idp/${encodeURIComponent(this.region)}/${encodeURIComponent(pool.id)}/.well-known/openid-configuration`,
      jwksPath: `/_stacksim/cognito-idp/${encodeURIComponent(this.region)}/${encodeURIComponent(pool.id)}/.well-known/jwks.json`,
      domain: pool.domain
        ? {
            name: pool.domain.domain,
            managedLoginVersion: pool.domain.managedLoginVersion,
            baseUrl: this.localDomainBase(pool.id),
          }
        : undefined,
      resourceServers: Object.values(pool.resourceServers)
        .sort((left, right) => left.identifier.localeCompare(right.identifier))
        .map(resource => ({
          identifier: resource.identifier,
          name: resource.name,
          scopes: resource.scopes.map(scope => ({
            name: scope.name,
            description: scope.description,
            fullName: `${resource.identifier}/${scope.name}`,
          })),
        })),
      branding: Object.values(pool.managedLoginBranding).map(value => ({
        id: value.id,
        clientId: value.clientId,
        settings: value.settings ? { ...value.settings } : undefined,
      })),
      identityProviders: Object.values(pool.identityProviders)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(provider => ({
          name: provider.name,
          type: provider.type,
          providerDetails: {
            ...provider.providerDetails,
            ...(provider.clientSecret ? { client_secret: "••••••••" } : {}),
          },
          attributeMapping: { ...provider.attributeMapping },
          idpIdentifiers: [...provider.idpIdentifiers],
          enabledClientIds: Object.values(pool.clients)
            .filter(client => client.supportedIdentityProviders.includes(provider.name))
            .map(client => client.id),
          certificateFingerprint: provider.samlMetadata
            ? createHash("sha256").update(provider.samlMetadata.certificate).digest("hex").match(/../g)?.join(":")
            : undefined,
          metadataEntityId: provider.samlMetadata?.entityId,
          metadataSsoUrl: provider.samlMetadata?.ssoUrl,
          createdAt: provider.createdAt,
          updatedAt: provider.updatedAt,
        })),
    };
  }

  async localTestIdentityProvider(
    poolIdValue: string,
    providerNameValue: string,
  ): Promise<Record<string, unknown>> {
    const pool = this.pool(poolIdValue);
    const providerName = this.identityProviderName(providerNameValue);
    const provider = pool.identityProviders[providerName];
    if (!provider) throw new AwsError("ResourceNotFoundException", "Identity provider not found.");
    try {
      if (provider.type === "OIDC") {
        const configuration = await resolveOidcConfiguration(provider.providerDetails, this.providerHttp);
        const jwks = await this.providerHttp.json(configuration.jwksUri);
        if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 20) {
          throw new FederationError("access_denied", "OIDC JWKS is invalid.");
        }
        return {
          providerName,
          protocol: "OIDC",
          status: "REACHABLE",
          issuer: configuration.issuer,
          authorizationEndpoint: configuration.authorizationEndpoint,
          tokenEndpoint: configuration.tokenEndpoint,
          jwksUri: configuration.jwksUri,
          userInfoEndpoint: configuration.userInfoEndpoint,
          signingKeyCount: jwks.keys.length,
        };
      }
      if (!provider.samlMetadata) throw new FederationError("access_denied", "SAML metadata is unavailable.");
      return {
        providerName,
        protocol: "SAML",
        status: "VALID",
        entityId: provider.samlMetadata.entityId,
        ssoUrl: provider.samlMetadata.ssoUrl,
        certificateFingerprint: createHash("sha256")
          .update(provider.samlMetadata.certificate)
          .digest("hex")
          .match(/../g)?.join(":"),
      };
    } catch (error) {
      throw this.identityProviderConfigurationError(error);
    }
  }

  async localConfigureAppClient(
    poolIdValue: string,
    clientIdValue: string,
    input: Record<string, unknown>,
  ): Promise<{ appClient: Record<string, unknown> }> {
    if (Object.keys(input).some(key => ![
      "callbackUrls", "logoutUrls", "defaultRedirectUri", "allowedOAuthFlows",
      "allowedOAuthScopes", "allowedOAuthFlowsUserPoolClient", "supportedIdentityProviders",
    ].includes(key))) {
      throw new AwsError("InvalidParameterException", "App-client OAuth configuration body is invalid.");
    }
    const pool = this.pool(poolIdValue);
    const client = this.appClient(pool, clientIdValue);
    await this.UpdateUserPoolClient({
      UserPoolId: pool.id,
      ClientId: client.id,
      ClientName: client.name,
      ExplicitAuthFlows: [...client.explicitAuthFlows],
      AccessTokenValidity: client.accessTokenValidity,
      IdTokenValidity: client.idTokenValidity,
      RefreshTokenValidity: client.refreshTokenValidity,
      TokenValidityUnits: {
        AccessToken: client.tokenValidityUnits.accessToken,
        IdToken: client.tokenValidityUnits.idToken,
        RefreshToken: client.tokenValidityUnits.refreshToken,
      },
      PreventUserExistenceErrors: client.preventUserExistenceErrors,
      EnableTokenRevocation: client.enableTokenRevocation,
      AuthSessionValidity: client.authSessionValidity,
      RefreshTokenRotation: {
        Feature: client.refreshTokenRotation.feature,
        RetryGracePeriodSeconds: client.refreshTokenRotation.retryGracePeriodSeconds,
      },
      ReadAttributes: [...client.readAttributes],
      WriteAttributes: [...client.writeAttributes],
      SupportedIdentityProviders: input.supportedIdentityProviders ?? [...client.supportedIdentityProviders],
      CallbackURLs: input.callbackUrls ?? [...client.callbackUrls],
      LogoutURLs: input.logoutUrls ?? [...client.logoutUrls],
      DefaultRedirectURI: input.defaultRedirectUri ?? client.defaultRedirectUri,
      AllowedOAuthFlows: input.allowedOAuthFlows ?? [...client.allowedOAuthFlows],
      AllowedOAuthScopes: input.allowedOAuthScopes ?? [...client.allowedOAuthScopes],
      AllowedOAuthFlowsUserPoolClient:
        input.allowedOAuthFlowsUserPoolClient ?? client.allowedOAuthFlowsUserPoolClient,
    });
    return this.localAppClient(pool.id, client.id);
  }

  private oauthDigest(
    pool: CognitoUserPoolState,
    kind: "code" | "session" | "csrf",
    value: string,
  ): string {
    return this.secrets.oauthDigest(kind, value, {
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
    });
  }

  private oauthPublicOrigin(): string {
    if (!this.publicBaseUrl) throw new OAuthEndpointError("server_error", "The Cognito public origin is not bound.", 503);
    return this.publicBaseUrl;
  }

  private oauthPoolByDomain(domain: string): CognitoUserPoolState {
    const poolIdValue = this.state.domainIndex[domain];
    const pool = poolIdValue ? this.state.pools[poolIdValue] : undefined;
    if (!pool?.domain || pool.domain.domain !== domain) {
      throw new OAuthEndpointError("invalid_request", "The user-pool domain does not exist.", 404);
    }
    return pool;
  }

  localDomainBase(poolIdValue: string): string | undefined {
    const pool = this.state.pools[poolIdValue];
    return pool?.domain && this.publicBaseUrl
      ? cognitoDomainBase(this.publicBaseUrl, pool.domain.domain)
      : undefined;
  }

  discovery(poolIdValue: string): Record<string, unknown> | undefined {
    const pool = this.state.pools[poolIdValue];
    if (!pool) return undefined;
    const issuer = cognitoIssuer(this.region, pool.id);
    const toolingRoot = `${this.oauthPublicOrigin()}/_stacksim/cognito-idp/${encodeURIComponent(this.region)}/${encodeURIComponent(pool.id)}`;
    const domainBase = this.localDomainBase(pool.id);
    return {
      issuer,
      jwks_uri: `${toolingRoot}/.well-known/jwks.json`,
      ...(domainBase
        ? {
            authorization_endpoint: `${domainBase}/oauth2/authorize`,
            token_endpoint: `${domainBase}/oauth2/token`,
            userinfo_endpoint: `${domainBase}/oauth2/userInfo`,
            revocation_endpoint: `${domainBase}/oauth2/revoke`,
            end_session_endpoint: `${domainBase}/logout`,
          }
        : {}),
      response_types_supported: ["code", "token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: [
        ...STANDARD_OAUTH_SCOPES,
        ...Object.values(pool.resourceServers).flatMap(resource =>
          resource.scopes.map(scope => `${resource.identifier}/${scope.name}`)
        ),
      ],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
    };
  }

  private oauthScopes(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    supplied: string | undefined,
  ): string[] {
    const requested = supplied === undefined || supplied === ""
      ? [...client.allowedOAuthScopes]
      : supplied.split(" ");
    if (
      requested.length === 0
      || requested.length > 50
      || requested.some(scope => !scope || scope.length > 256 || /[\u0000-\u0020\u007f]/.test(scope))
    ) {
      throw new OAuthEndpointError("invalid_scope", "The requested scope is malformed.");
    }
    const allCustom = new Set(
      Object.values(pool.resourceServers).flatMap(resource =>
        resource.scopes.map(scope => `${resource.identifier}/${scope.name}`)
      ),
    );
    const deduplicated = [...new Set(requested)];
    for (const scope of deduplicated) {
      if (!STANDARD_OAUTH_SCOPES.has(scope) && !allCustom.has(scope)) {
        throw new OAuthEndpointError("invalid_scope", `Unknown scope: ${scope}.`);
      }
    }
    const granted = deduplicated.filter(scope => client.allowedOAuthScopes.includes(scope));
    if (
      granted.some(scope => ["email", "phone", "profile"].includes(scope))
      && !granted.includes("openid")
    ) {
      throw new OAuthEndpointError("invalid_scope", "The email, phone, and profile scopes require openid.");
    }
    if (granted.length === 0) {
      throw new OAuthEndpointError("invalid_scope", "No requested scope is enabled for this app client.");
    }
    return granted;
  }

  private oauthAuthorizationRequest(
    pool: CognitoUserPoolState,
    parameters: URLSearchParams | Record<string, string>,
  ): { request: CognitoOAuthAuthorizationRequest; client: CognitoAppClientState } {
    const allowed = new Set([
      "client_id", "redirect_uri", "response_type", "scope", "state", "nonce",
      "code_challenge", "code_challenge_method", "prompt", "identity_provider", "idp_identifier",
    ]);
    const value = (name: string): string | undefined => parameters instanceof URLSearchParams
      ? parameters.get(name) ?? undefined
      : parameters[name];
    const keys = parameters instanceof URLSearchParams ? [...parameters.keys()] : Object.keys(parameters);
    if (parameters instanceof URLSearchParams) {
      for (const key of new Set(keys)) {
        if (parameters.getAll(key).length !== 1) {
          throw new OAuthEndpointError("invalid_request", `Duplicate authorization parameter: ${key}.`);
        }
      }
    }
    if (keys.some(key => !allowed.has(key))) {
      throw new OAuthEndpointError("invalid_request", "The authorization request contains an unsupported parameter.");
    }
    if (value("identity_provider") && value("idp_identifier")) {
      throw new OAuthEndpointError("invalid_request", "identity_provider and idp_identifier are mutually exclusive.");
    }
    const clientIdValue = value("client_id");
    const client = clientIdValue ? pool.clients[clientIdValue] : undefined;
    if (!client || !client.allowedOAuthFlowsUserPoolClient) {
      throw new OAuthEndpointError("unauthorized_client", "The app client is not enabled for managed login.");
    }
    const selectedProvider = value("identity_provider");
    const selectedIdentifier = value("idp_identifier");
    const providerName = selectedProvider && selectedProvider !== "COGNITO"
      ? selectedProvider
      : selectedIdentifier
        ? pool.identityProviderIdentifierIndex[selectedIdentifier]
        : undefined;
    if (selectedIdentifier && !providerName) {
      throw new OAuthEndpointError("invalid_request", "idp_identifier does not match a configured identity provider.");
    }
    if (providerName) {
      if (!pool.identityProviders[providerName] || !client.supportedIdentityProviders.includes(providerName)) {
        throw new OAuthEndpointError("unauthorized_client", "The selected identity provider is not enabled for this app client.");
      }
    } else if (selectedProvider === "COGNITO" || !selectedProvider && !selectedIdentifier) {
      if (!client.supportedIdentityProviders.includes("COGNITO") && client.supportedIdentityProviders.length === 1) {
        // An external-only client can still display its provider selection page.
      } else if (selectedProvider === "COGNITO" && !client.supportedIdentityProviders.includes("COGNITO")) {
        throw new OAuthEndpointError("unauthorized_client", "The Cognito directory is not enabled for this app client.");
      }
    }
    const redirectUri = value("redirect_uri") ?? client.defaultRedirectUri;
    if (!redirectUri || !client.callbackUrls.includes(redirectUri)) {
      throw new OAuthEndpointError("invalid_request", "redirect_uri must exactly match an app-client callback URL.");
    }
    const responseType = value("response_type");
    if (responseType !== "code" && responseType !== "token") {
      throw new OAuthEndpointError("unsupported_response_type", "response_type must be code or token.");
    }
    const requiredFlow = responseType === "code" ? "code" : "implicit";
    if (!client.allowedOAuthFlows.includes(requiredFlow)) {
      throw new OAuthEndpointError("unauthorized_client", `The ${requiredFlow} grant is not enabled.`);
    }
    const state = value("state");
    if (
      state !== undefined
      && (state.length < 1 || Buffer.byteLength(state, "utf8") > 3_072 || /[\u0000-\u001f\u007f]/.test(state))
    ) {
      throw new OAuthEndpointError("invalid_request", "state is invalid.");
    }
    const nonce = value("nonce");
    if (
      nonce !== undefined
      && (nonce.length < 1 || Buffer.byteLength(nonce, "utf8") > 1_024 || /[\u0000-\u001f\u007f]/.test(nonce))
    ) {
      throw new OAuthEndpointError("invalid_request", "nonce is invalid.");
    }
    const prompt = value("prompt");
    if (prompt !== undefined && prompt !== "login") {
      throw new OAuthEndpointError("invalid_request", "Only prompt=login is supported.");
    }
    const codeChallenge = value("code_challenge");
    if (
      responseType === "code"
      && (
        value("code_challenge_method") !== "S256"
        || typeof codeChallenge !== "string"
        || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
      )
    ) {
      throw new OAuthEndpointError("invalid_request", "Authorization code requests require PKCE S256.");
    }
    if (responseType === "token" && (codeChallenge !== undefined || value("code_challenge_method") !== undefined)) {
      throw new OAuthEndpointError("invalid_request", "PKCE parameters are only valid for authorization-code requests.");
    }
    return {
      client,
      request: {
        clientId: client.id,
        redirectUri,
        responseType,
        scopes: this.oauthScopes(pool, client, value("scope")),
        ...(state === undefined ? {} : { state }),
        ...(nonce === undefined ? {} : { nonce }),
        ...(codeChallenge === undefined ? {} : { codeChallenge }),
        ...(prompt === undefined ? {} : { prompt: "login" }),
        ...(providerName === undefined ? {} : { providerName }),
      },
    };
  }

  private oauthRedirect(
    redirectUri: string,
    values: Record<string, string | number | undefined>,
    fragment = false,
  ): string {
    const target = new URL(redirectUri);
    const output = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) output.set(key, String(value));
    }
    if (fragment) target.hash = output.toString();
    else for (const [key, value] of output) target.searchParams.append(key, value);
    return target.href;
  }

  private browserSession(
    pool: CognitoUserPoolState,
    raw: string | undefined,
  ): CognitoBrowserSessionState | undefined {
    if (!raw) return undefined;
    let digest: string;
    try {
      digest = this.oauthDigest(pool, "session", raw);
    } catch {
      return undefined;
    }
    const session = pool.browserSessions[digest];
    if (!session || this.clock.now() >= session.expiresAt || session.status === "LOGGED_OUT") return undefined;
    if (session.status === "AUTHENTICATED") {
      const user = session.userSub ? pool.usersBySub[session.userSub] : undefined;
      if (
        !user
        || !user.enabled
        || !tokenEligibleUser(user)
        || user.generationId !== session.userGenerationId
        || user.sessionEpoch !== session.sessionEpoch
      ) return undefined;
    }
    return session;
  }

  private async newBrowserSession(
    pool: CognitoUserPoolState,
    status: "ANONYMOUS" | "AUTHENTICATED",
    user?: CognitoUserState,
  ): Promise<{ raw: string; csrf: string; session: CognitoBrowserSessionState }> {
    const raw = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const now = this.clock.now();
    const digest = this.oauthDigest(pool, "session", raw);
    const session: CognitoBrowserSessionState = {
      digest,
      csrfDigest: this.oauthDigest(pool, "csrf", csrf),
      createdAt: now,
      expiresAt: now + (
        status === "AUTHENTICATED"
          ? OAUTH_BROWSER_SESSION_LIFETIME_MS
          : OAUTH_ANONYMOUS_SESSION_LIFETIME_MS
      ),
      status,
      ...(user
        ? {
            userSub: user.sub,
            userGenerationId: user.generationId,
            sessionEpoch: user.sessionEpoch,
          }
        : {}),
    };
    await this.exclusive(async () => {
      const current = this.pool(pool.id);
      current.browserSessions[digest] = session;
      this.state.revision += 1;
      await this.store.save();
    });
    return { raw, csrf, session };
  }

  private csrfMatches(pool: CognitoUserPoolState, session: CognitoBrowserSessionState, csrf: unknown): boolean {
    if (typeof csrf !== "string") return false;
    try {
      const actual = Buffer.from(this.oauthDigest(pool, "csrf", csrf), "base64url");
      const expected = Buffer.from(session.csrfDigest, "base64url");
      try {
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      } finally {
        actual.fill(0);
        expected.fill(0);
      }
    } catch {
      return false;
    }
  }

  private managedLoginStyle(pool: CognitoUserPoolState, client: CognitoAppClientState): {
    title: string;
    primaryColor: string;
    css: string;
  } {
    const branding = Object.values(pool.managedLoginBranding).find(value => value.clientId === client.id);
    const customization = pool.uiCustomizations[client.id] ?? pool.uiCustomizations.ALL;
    return {
      title: branding?.settings?.pageTitle ?? pool.name,
      primaryColor: branding?.settings?.primaryColor ?? "#2563eb",
      css: pool.domain?.managedLoginVersion === 1 ? customization?.css ?? "" : "",
    };
  }

  private managedLoginPage(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    request: CognitoOAuthAuthorizationRequest,
    csrf: string,
    message?: string,
  ): string {
    const style = this.managedLoginStyle(pool, client);
    const hidden = {
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: request.responseType,
      scope: request.scopes.join(" "),
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallenge ? "S256" : undefined,
      csrf,
    };
    const fields = Object.entries(hidden)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    const action = `${cognitoDomainBase(this.oauthPublicOrigin(), pool.domain!.domain)}/oauth2/authorize`;
    const localEnabled = client.supportedIdentityProviders.includes("COGNITO");
    const accountForms = !localEnabled
      ? ""
      : clientHasSecret(client)
        ? "<p><small>Self-service account forms require a public app client.</small></p>"
        : `<details><summary>Create or recover an account</summary><h2>Create account</h2><form method="post" action="${escapeHtml(action)}">${fields}<input type="hidden" name="account_operation" value="signup"><label for="signup_email">Email</label><input id="signup_email" name="account_username" type="email" required autocomplete="email"><label for="signup_password">Password</label><input id="signup_password" name="account_password" type="password" required autocomplete="new-password"><button type="submit">Create account</button></form><h2>Confirm account</h2><form method="post" action="${escapeHtml(action)}">${fields}<input type="hidden" name="account_operation" value="confirm"><label for="confirm_username">Username or email</label><input id="confirm_username" name="account_username" required autocomplete="username"><label for="confirm_code">Confirmation code</label><input id="confirm_code" name="account_code" required inputmode="numeric" autocomplete="one-time-code"><button type="submit">Confirm account</button></form><h2>Password recovery</h2><form method="post" action="${escapeHtml(action)}">${fields}<input type="hidden" name="account_operation" value="forgot"><label for="forgot_username">Username or email</label><input id="forgot_username" name="account_username" required autocomplete="username"><button type="submit">Send recovery code</button></form><form method="post" action="${escapeHtml(action)}">${fields}<input type="hidden" name="account_operation" value="confirm_forgot"><label for="recover_username">Username or email</label><input id="recover_username" name="account_username" required autocomplete="username"><label for="recover_code">Recovery code</label><input id="recover_code" name="account_code" required inputmode="numeric" autocomplete="one-time-code"><label for="recover_password">New password</label><input id="recover_password" name="account_password" type="password" required autocomplete="new-password"><button type="submit">Set new password</button></form></details>`;
    const localForm = localEnabled
      ? `<p>Sign in with your local user-pool account.</p><form method="post" action="${escapeHtml(action)}">${fields}<label for="username">Username or email</label><input id="username" name="username" required autocomplete="username"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"><button type="submit">Sign in</button></form>${accountForms}`
      : "";
    const providerLinks = client.supportedIdentityProviders
      .filter(name => name !== "COGNITO" && pool.identityProviders[name])
      .map(name => {
        const target = new URL(action);
        for (const [key, value] of Object.entries(hidden)) {
          if (key !== "csrf" && value !== undefined) target.searchParams.set(key, value);
        }
        target.searchParams.set("identity_provider", name);
        return `<a class="provider" href="${escapeHtml(target.href)}">Continue with ${escapeHtml(name)}</a>`;
      })
      .join("");
    const providers = providerLinks
      ? `<section class="providers"><h2>External providers</h2>${providerLinks}</section>`
      : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(style.title)} sign in</title><style>:root{color-scheme:light dark}body{font:16px system-ui;margin:0;background:#f3f4f6;color:#111827}main{max-width:28rem;margin:8vh auto;background:white;padding:2rem;border-radius:.75rem;box-shadow:0 8px 30px #0002}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.75rem;border:1px solid #9ca3af;border-radius:.35rem}button,.provider{box-sizing:border-box;display:block;width:100%;margin-top:1.25rem;padding:.8rem;border:0;border-radius:.35rem;background:${escapeHtml(style.primaryColor)};color:white;font-weight:700;text-align:center;text-decoration:none}.provider{background:#374151}.providers{margin-top:1.5rem;border-top:1px solid #d1d5db;padding-top:.5rem}.error{padding:.75rem;background:#fee2e2;color:#991b1b;border-radius:.35rem}details{margin-top:1.5rem;border-top:1px solid #d1d5db;padding-top:1rem}summary{cursor:pointer;font-weight:700}details h2{font-size:1.05rem;margin-top:1.5rem}@media(max-width:36rem){main{margin:0;min-height:100vh;border-radius:0;box-shadow:none}}${style.css}</style></head><body><main><h1>${escapeHtml(style.title)}</h1>${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}${localForm}${providers}</main></body></html>`;
  }

  private managedLoginMfaPage(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    request: CognitoOAuthAuthorizationRequest,
    csrf: string,
    challengeName: "SOFTWARE_TOKEN_MFA" | "EMAIL_OTP",
    challengeSession: string,
    destination?: string,
    message?: string,
  ): string {
    const style = this.managedLoginStyle(pool, client);
    const hidden = {
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: request.responseType,
      scope: request.scopes.join(" "),
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallenge ? "S256" : undefined,
      csrf,
      challenge_name: challengeName,
      challenge_session: challengeSession,
    };
    const fields = Object.entries(hidden)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    const action = `${cognitoDomainBase(this.oauthPublicOrigin(), pool.domain!.domain)}/oauth2/authorize`;
    const method = challengeName === "EMAIL_OTP" ? "email verification code" : "authenticator code";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(style.title)} verification</title><style>:root{color-scheme:light dark}body{font:16px system-ui;margin:0;background:#f3f4f6;color:#111827}main{max-width:28rem;margin:8vh auto;background:white;padding:2rem;border-radius:.75rem;box-shadow:0 8px 30px #0002}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.75rem;border:1px solid #9ca3af;border-radius:.35rem}button{width:100%;margin-top:1.25rem;padding:.8rem;border:0;border-radius:.35rem;background:${escapeHtml(style.primaryColor)};color:white;font-weight:700}.error{padding:.75rem;background:#fee2e2;color:#991b1b;border-radius:.35rem}@media(max-width:36rem){main{margin:0;min-height:100vh;border-radius:0;box-shadow:none}}</style></head><body><main><h1>Verify your sign-in</h1><p>Enter your ${escapeHtml(method)}${destination ? ` sent to ${escapeHtml(destination)}` : ""}.</p>${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}<form method="post" action="${escapeHtml(action)}">${fields}<label for="mfa_code">Six-digit code</label><input id="mfa_code" name="mfa_code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"><button type="submit">Verify and continue</button></form></main></body></html>`;
  }

  private managedLoginMfaRequired(
    pool: CognitoUserPoolState,
    user: CognitoUserState,
  ): boolean {
    const enabled = user.userMfaSettingList.some(method =>
      pool.configuration.enabledMfas.includes(method)
    );
    return enabled || (
      pool.configuration.mfaConfiguration === "ON"
      && pool.configuration.enabledMfas.includes("EMAIL_OTP")
      && Boolean(user.attributes.email?.verified)
    );
  }

  private federationDigest(
    pool: CognitoUserPoolState,
    providerName: string,
    kind: "state" | "nonce" | "replay",
    value: string,
  ): string {
    return this.secrets.federationDigest(kind, value, {
      accountId: this.store.accountId,
      region: this.region,
      poolId: pool.id,
      providerName,
    });
  }

  private federationAuthorization(
    request: CognitoOAuthAuthorizationRequest,
  ): CognitoFederationTransactionState["authorization"] {
    return {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      responseType: request.responseType,
      scopes: [...request.scopes],
      ...(request.state ? { state: request.state } : {}),
      ...(request.nonce ? { nonce: request.nonce } : {}),
      ...(request.codeChallenge ? { codeChallenge: request.codeChallenge } : {}),
    };
  }

  private async storeFederationTransaction(
    pool: CognitoUserPoolState,
    transaction: CognitoFederationTransactionState,
  ): Promise<void> {
    await this.exclusive(async () => {
      const current = this.pool(pool.id);
      const provider = current.identityProviders[transaction.providerName];
      if (!provider || provider.revision !== transaction.providerRevision) {
        throw new OAuthEndpointError("temporarily_unavailable", "The identity provider changed during sign-in.", 503);
      }
      current.federationTransactions[transaction.digest] = transaction;
      this.state.revision += 1;
      await this.store.save();
    });
  }

  private async beginFederation(
    pool: CognitoUserPoolState,
    request: CognitoOAuthAuthorizationRequest,
  ): Promise<string> {
    const providerName = request.providerName!;
    const provider = pool.identityProviders[providerName];
    if (!provider) throw new OAuthEndpointError("access_denied", "Identity provider not found.");
    const rawState = randomBytes(32).toString("base64url");
    const digest = this.federationDigest(pool, provider.name, "state", rawState);
    const now = this.clock.now();
    const callbackBase = cognitoDomainBase(this.oauthPublicOrigin(), pool.domain!.domain);
    if (provider.type === "OIDC") {
      let configuration: OidcProviderConfiguration;
      try {
        configuration = await resolveOidcConfiguration(provider.providerDetails, this.providerHttp);
      } catch (error) {
        throw this.federationOAuthError(error);
      }
      const nonce = randomBytes(32).toString("base64url");
      await this.storeFederationTransaction(pool, {
        digest,
        kind: "OIDC",
        providerName: provider.name,
        providerRevision: provider.revision,
        authorization: this.federationAuthorization(request),
        nonceDigest: this.federationDigest(pool, provider.name, "nonce", nonce),
        createdAt: now,
        expiresAt: now + FEDERATION_TRANSACTION_LIFETIME_MS,
        status: "ACTIVE",
      });
      const target = new URL(configuration.authorizationEndpoint);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("client_id", configuration.clientId);
      target.searchParams.set("redirect_uri", `${callbackBase}/oauth2/idpresponse`);
      target.searchParams.set("scope", configuration.authorizeScopes);
      target.searchParams.set("state", rawState);
      target.searchParams.set("nonce", nonce);
      if (request.prompt) target.searchParams.set("prompt", request.prompt);
      return target.href;
    }
    if (provider.type !== "SAML" || !provider.samlMetadata) {
      throw new OAuthEndpointError("access_denied", "The selected provider has no executable federation protocol.");
    }
    const requestId = `_${randomUUID()}`;
    await this.storeFederationTransaction(pool, {
      digest,
      kind: "SAML",
      providerName: provider.name,
      providerRevision: provider.revision,
      authorization: this.federationAuthorization(request),
      requestIdDigest: this.federationDigest(pool, provider.name, "replay", `request:${requestId}`),
      createdAt: now,
      expiresAt: now + FEDERATION_TRANSACTION_LIFETIME_MS,
      status: "ACTIVE",
    });
    try {
      return createSamlRedirect(provider.samlMetadata as SamlMetadata, {
        poolId: pool.id,
        requestId,
        acsUrl: `${callbackBase}/saml2/idpresponse`,
        relayState: rawState,
        now,
      });
    } catch (error) {
      throw this.federationOAuthError(error);
    }
  }

  private federationOAuthError(error: unknown): OAuthEndpointError {
    if (error instanceof OAuthEndpointError) return error;
    if (error instanceof FederationError) {
      return new OAuthEndpointError(error.code, error.message, error.status);
    }
    return new OAuthEndpointError("access_denied", "External identity-provider validation failed.");
  }

  private federationTransaction(
    pool: CognitoUserPoolState,
    rawState: string,
    kind: "OIDC" | "SAML",
  ): { provider: CognitoIdentityProviderState; transaction: CognitoFederationTransactionState } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawState)) {
      throw new OAuthEndpointError("access_denied", "Federation state is invalid.");
    }
    for (const provider of Object.values(pool.identityProviders)) {
      let digest: string;
      try {
        digest = this.federationDigest(pool, provider.name, "state", rawState);
      } catch {
        continue;
      }
      const transaction = pool.federationTransactions[digest];
      if (
        transaction
        && transaction.kind === kind
        && transaction.providerName === provider.name
      ) return { provider, transaction };
    }
    throw new OAuthEndpointError("access_denied", "Federation state is unknown.");
  }

  private async consumeFederationTransaction(
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
    transaction: CognitoFederationTransactionState,
  ): Promise<void> {
    await this.exclusive(async () => {
      const current = this.pool(pool.id);
      const currentProvider = current.identityProviders[provider.name];
      const currentTransaction = current.federationTransactions[transaction.digest];
      if (
        !currentProvider
        || currentProvider.revision !== transaction.providerRevision
        || !currentTransaction
        || currentTransaction.status !== "ACTIVE"
        || this.clock.now() >= currentTransaction.expiresAt
      ) throw new OAuthEndpointError("access_denied", "Federation response is expired, replayed, or no longer valid.");
      currentTransaction.status = "CONSUMED";
      currentTransaction.consumedAt = this.clock.now();
      this.state.revision += 1;
      await this.store.save();
    });
  }

  private async oidcKeys(
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
    configuration: OidcProviderConfiguration,
    requiredKid: string,
  ): Promise<JsonWebKey[]> {
    const cacheKey = `${pool.id}:${provider.name}:${provider.revision}`;
    const cached = this.oidcKeyCache.get(cacheKey);
    if (cached && this.clock.now() < cached.expiresAt && cached.keys.some(key => key.kid === requiredKid)) {
      return cached.keys;
    }
    const response = await this.providerHttp.json(configuration.jwksUri);
    if (
      !Array.isArray(response.keys)
      || response.keys.length < 1
      || response.keys.length > 20
      || response.keys.some((key: unknown) =>
        !key
        || typeof key !== "object"
        || (key as any).kty !== "RSA"
        || (key as any).alg !== "RS256"
        || (key as any).use !== "sig"
        || typeof (key as any).kid !== "string"
      )
    ) throw new FederationError("access_denied", "OIDC JWKS is invalid.");
    const keys = structuredClone(response.keys) as JsonWebKey[];
    this.oidcKeyCache.set(cacheKey, { expiresAt: this.clock.now() + 5 * 60_000, keys });
    if (!keys.some(key => key.kid === requiredKid)) {
      throw new FederationError("access_denied", "OIDC ID token signing key is unknown.");
    }
    return keys;
  }

  private mappedFederatedAttributes(
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
    claims: Record<string, any>,
  ): Record<string, CognitoUserAttributeState> {
    const attributes: Record<string, CognitoUserAttributeState> = {};
    let emailVerified = false;
    for (const [target, source] of Object.entries(provider.attributeMapping)) {
      const value = claims[source];
      if (value === undefined || value === null) continue;
      if (target === "email_verified") {
        if (value !== true && value !== false && value !== "true" && value !== "false") {
          throw new OAuthEndpointError("access_denied", "The mapped email_verified claim is invalid.");
        }
        emailVerified = value === true || value === "true";
        continue;
      }
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new OAuthEndpointError("access_denied", `Mapped identity-provider claim ${source} is not scalar.`);
      }
      const normalized = String(value);
      if (Buffer.byteLength(normalized, "utf8") > 2_048) {
        throw new OAuthEndpointError("access_denied", `Mapped identity-provider claim ${source} is too large.`);
      }
      attributes[target] = { value: normalized, verified: false };
    }
    if (attributes.email) {
      try {
        attributes.email.value = cognitoEmail(attributes.email.value).value;
      } catch {
        throw new OAuthEndpointError("access_denied", "The mapped email claim is invalid.");
      }
      attributes.email.verified = emailVerified;
    }
    for (const schema of pool.configuration.schemaAttributes) {
      const target = schema.name === "email" ? "email" : `custom:${schema.name}`;
      if (schema.required && !attributes[target]) {
        throw new OAuthEndpointError("access_denied", `The identity provider did not supply required attribute ${target}.`);
      }
    }
    if (pool.configuration.usernameAttributes.includes("email") && !attributes.email) {
      throw new OAuthEndpointError("access_denied", "The identity provider did not supply the required email claim.");
    }
    return attributes;
  }

  private async federatedUser(
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
    subject: string,
    providerAttributeName: string,
    claims: Record<string, any>,
  ): Promise<CognitoUserState> {
    const identityKey = this.federatedIdentityKey(pool, provider.name, subject);
    const mapped = this.mappedFederatedAttributes(pool, provider, claims);
    const existingSub = pool.federatedIdentityIndex[identityKey];
    const existing = existingSub ? pool.usersBySub[existingSub] : undefined;
    const generatedPassword = existing ? undefined : randomBytes(48).toString("base64url");
    const password = generatedPassword ? await this.passwords.hash(generatedPassword) : undefined;
    return this.exclusive(async () => {
      const current = this.pool(pool.id);
      const currentProvider = current.identityProviders[provider.name];
      if (!currentProvider || currentProvider.revision !== provider.revision) {
        throw new OAuthEndpointError("temporarily_unavailable", "The identity provider changed during sign-in.", 503);
      }
      const currentOwner = current.federatedIdentityIndex[identityKey];
      let user = currentOwner ? current.usersBySub[currentOwner] : undefined;
      if (currentOwner && !user) {
        throw new OAuthEndpointError("access_denied", "The linked federated profile is inconsistent.");
      }
      const mappedEmail = mapped.email ? cognitoEmail(mapped.email.value).canonical : undefined;
      if (mappedEmail) {
        const aliasOwner = current.aliasIndex[mappedEmail];
        if (aliasOwner && aliasOwner !== user?.sub) {
          throw new OAuthEndpointError("access_denied", "The mapped email alias belongs to another user.");
        }
        if (current.configuration.usernameAttributes.includes("email")) {
          const usernameOwner = current.usernameIndex[mappedEmail];
          if (usernameOwner && usernameOwner !== user?.sub) {
            throw new OAuthEndpointError("access_denied", "The mapped email belongs to another user.");
          }
        }
      }
      const now = this.clock.now();
      if (!user) {
        if (!password) throw new OAuthEndpointError("server_error", "Could not create federated profile.", 500);
        const sub = randomUUID();
        const username = `${provider.name}_${createHash("sha256").update(subject).digest("base64url").slice(0, 26)}`;
        user = {
          sub,
          username,
          generationId: randomBytes(16).toString("base64url"),
          enabled: true,
          status: "EXTERNAL_PROVIDER",
          createdAt: now,
          updatedAt: now,
          attributes: {},
          password,
          passwordHistory: [],
          passwordChangedAt: now,
          activeAttributeVerificationIntentIds: {},
          groupNames: [],
          mfa: {},
          userMfaSettingList: [],
          devices: {},
          pendingDevices: {},
          sessionEpoch: 0,
          externalIdentities: [{
            providerName: provider.name,
            providerType: provider.type,
            providerSubject: subject,
            providerAttributeName,
            linkedAt: now,
          }],
        };
        current.usersBySub[sub] = user;
        current.usernameIndex[canonicalUsername(current, username)] = sub;
        current.federatedIdentityIndex[identityKey] = sub;
      } else if (!user.externalIdentities.some(identity =>
        identity.providerName === provider.name && identity.providerSubject === subject
      )) {
        if (user.externalIdentities.length >= 5) {
          throw new OAuthEndpointError("access_denied", "The destination user has too many linked identities.");
        }
        user.externalIdentities.push({
          providerName: provider.name,
          providerType: provider.type,
          providerSubject: subject,
          providerAttributeName,
          linkedAt: now,
        });
      }
      const priorEmail = user.attributes.email?.value;
      for (const [name, attribute] of Object.entries(mapped)) {
        const schemaName = name.startsWith("custom:") ? name.slice(7) : name;
        const schema = current.configuration.schemaAttributes.find(candidate => candidate.name === schemaName);
        if (user.attributes[name] && schema && !schema.mutable) {
          if (user.attributes[name].value !== attribute.value) {
            throw new OAuthEndpointError("access_denied", `Mapped attribute ${name} is immutable.`);
          }
          continue;
        }
        user.attributes[name] = attribute;
      }
      if (priorEmail && priorEmail !== user.attributes.email?.value) {
        const priorKey = cognitoEmail(priorEmail).canonical;
        if (current.aliasIndex[priorKey] === user.sub) delete current.aliasIndex[priorKey];
        if (current.configuration.usernameAttributes.includes("email") && current.usernameIndex[priorKey] === user.sub) {
          delete current.usernameIndex[priorKey];
        }
      }
      if (user.attributes.email) {
        const emailKey = cognitoEmail(user.attributes.email.value).canonical;
        if (user.attributes.email.verified && current.configuration.aliasAttributes.includes("email")) {
          current.aliasIndex[emailKey] = user.sub;
        }
        if (current.configuration.usernameAttributes.includes("email")) current.usernameIndex[emailKey] = user.sub;
      }
      user.updatedAt = now;
      current.updatedAt = now;
      this.state.revision += 1;
      await this.store.save();
      return user;
    });
  }

  private async completeFederatedAuthorization(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    provider: CognitoIdentityProviderState,
    authorization: CognitoFederationTransactionState["authorization"],
    subject: string,
    providerAttributeName: string,
    claims: Record<string, any>,
  ): Promise<void> {
    const client = this.appClient(pool, authorization.clientId);
    if (!client.supportedIdentityProviders.includes(provider.name)) {
      throw new OAuthEndpointError("unauthorized_client", "The identity provider is no longer enabled.");
    }
    const user = await this.federatedUser(pool, provider, subject, providerAttributeName, claims);
    const oldRaw = cookieValue(req, OAUTH_SESSION_COOKIE);
    const created = await this.newBrowserSession(pool, "AUTHENTICATED", user);
    if (oldRaw) {
      await this.exclusive(async () => {
        const current = this.pool(pool.id);
        const oldDigest = this.oauthDigest(current, "session", oldRaw);
        if (current.browserSessions[oldDigest]) {
          current.browserSessions[oldDigest].status = "LOGGED_OUT";
          current.browserSessions[oldDigest].expiresAt = this.clock.now();
        }
        this.state.revision += 1;
        await this.store.save();
      });
    }
    await this.invokeTrigger(
      pool,
      client,
      user,
      "postAuthentication",
      "PostAuthentication_Authentication",
      {},
    );
    res.setHeader(
      "set-cookie",
      sessionCookie(
        OAUTH_SESSION_COOKIE,
        created.raw,
        this.oauthPublicOrigin().startsWith("https:"),
        Math.floor(OAUTH_BROWSER_SESSION_LIFETIME_MS / 1_000),
      ),
    );
    return sendOAuthRedirect(
      res,
      await this.issueAuthorizationResponse(pool, client, user, created.session, authorization),
    );
  }

  private async handleOidcResponse(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (req.method !== "GET") throw new OAuthEndpointError("invalid_request", "OIDC callback requires GET.", 405);
    for (const key of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(key).length !== 1) {
        throw new OAuthEndpointError("invalid_request", `Duplicate OIDC callback parameter: ${key}.`);
      }
    }
    if ([...url.searchParams.keys()].some(key => !["code", "state", "error", "error_description"].includes(key))) {
      throw new OAuthEndpointError("invalid_request", "OIDC callback contains an unsupported parameter.");
    }
    const rawState = url.searchParams.get("state");
    if (!rawState) throw new OAuthEndpointError("access_denied", "OIDC callback state is required.");
    const { provider, transaction } = this.federationTransaction(pool, rawState, "OIDC");
    if (url.searchParams.get("error")) {
      await this.consumeFederationTransaction(pool, provider, transaction);
      throw new OAuthEndpointError("access_denied", "The external identity provider denied sign-in.");
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4_096 || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new OAuthEndpointError("access_denied", "OIDC authorization code is invalid.");
    }
    await this.consumeFederationTransaction(pool, provider, transaction);
    try {
      const configuration = await resolveOidcConfiguration(provider.providerDetails, this.providerHttp);
      const secret = this.identityProviderClientSecret(pool, provider);
      if (!secret) throw new FederationError("access_denied", "OIDC client secret is unavailable.");
      let tokenResponse: Record<string, any>;
      try {
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: configuration.clientId,
          client_secret: secret.toString("utf8"),
          code,
          redirect_uri: `${cognitoDomainBase(this.oauthPublicOrigin(), pool.domain!.domain)}/oauth2/idpresponse`,
        });
        tokenResponse = await this.providerHttp.json(configuration.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: Buffer.from(form.toString(), "utf8"),
        });
      } finally {
        secret.fill(0);
      }
      if (typeof tokenResponse.id_token !== "string") {
        throw new FederationError("access_denied", "OIDC token response has no ID token.");
      }
      const header = oidcTokenHeader(tokenResponse.id_token);
      const keys = await this.oidcKeys(pool, provider, configuration, header.kid);
      const claims = verifyOidcIdToken(tokenResponse.id_token, keys, {
        issuer: configuration.issuer,
        clientId: configuration.clientId,
        nonceDigest: transaction.nonceDigest!,
        digestNonce: value => this.federationDigest(pool, provider.name, "nonce", value),
        now: this.clock.now(),
      });
      if (configuration.userInfoEndpoint && typeof tokenResponse.access_token === "string") {
        const userInfo = await this.providerHttp.json(configuration.userInfoEndpoint, {
          headers: { authorization: `Bearer ${tokenResponse.access_token}` },
        });
        if (userInfo.sub !== claims.sub) {
          throw new FederationError("access_denied", "OIDC userInfo subject does not match the ID token.");
        }
        for (const [name, value] of Object.entries(userInfo)) {
          if (claims[name] === undefined) claims[name] = value;
        }
      }
      this.audit(`Federation:${provider.name}`, "SUCCESS", randomUUID(), pool.id);
      return this.completeFederatedAuthorization(
        req,
        res,
        pool,
        provider,
        transaction.authorization,
        claims.sub,
        "sub",
        claims,
      );
    } catch (error) {
      this.audit(`Federation:${provider.name}`, "CLIENT_ERROR", randomUUID(), pool.id);
      throw this.federationOAuthError(error);
    }
  }

  private async handleSamlResponse(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (req.method !== "POST" || url.search) {
      throw new OAuthEndpointError("invalid_request", "SAML callback requires POST without query parameters.", 405);
    }
    const form = await readOAuthForm(req, 192 * 1024);
    if (Object.keys(form).some(key => !["SAMLResponse", "RelayState"].includes(key))) {
      throw new OAuthEndpointError("invalid_request", "SAML callback contains an unsupported parameter.");
    }
    if (!form.SAMLResponse || !form.RelayState) {
      throw new OAuthEndpointError("invalid_request", "SAMLResponse and RelayState are required.");
    }
    let provider: CognitoIdentityProviderState;
    let authorization: CognitoFederationTransactionState["authorization"];
    let expectedRequestDigest: string | undefined;
    let transaction: CognitoFederationTransactionState | undefined;
    let idpInitiated = false;
    try {
      const selected = this.federationTransaction(pool, form.RelayState, "SAML");
      provider = selected.provider;
      transaction = selected.transaction;
      authorization = selected.transaction.authorization;
      expectedRequestDigest = selected.transaction.requestIdDigest;
      await this.consumeFederationTransaction(pool, provider, selected.transaction);
    } catch (error) {
      const relay = new URLSearchParams(form.RelayState);
      const parsed = this.oauthAuthorizationRequest(pool, relay);
      const selectedName = parsed.request.providerName;
      const selected = selectedName ? pool.identityProviders[selectedName] : undefined;
      if (
        !(error instanceof OAuthEndpointError)
        || !selected
        || selected.type !== "SAML"
        || selected.providerDetails.IDPInit !== "true"
      ) throw error;
      provider = selected;
      authorization = this.federationAuthorization(parsed.request);
      idpInitiated = true;
    }
    if (!provider.samlMetadata) throw new OAuthEndpointError("access_denied", "SAML metadata is unavailable.");
    try {
      const verified = verifySamlResponse(form.SAMLResponse, {
        metadata: provider.samlMetadata as SamlMetadata,
        poolId: pool.id,
        acsUrl: `${cognitoDomainBase(this.oauthPublicOrigin(), pool.domain!.domain)}/saml2/idpresponse`,
        now: this.clock.now(),
        expectedRequestDigest,
        digestRequest: value => this.federationDigest(pool, provider.name, "replay", `request:${value}`),
        idpInitiated,
      });
      const replayDigests = [verified.responseId, verified.assertionId]
        .map(value => this.federationDigest(pool, provider.name, "replay", `response:${value}`));
      await this.exclusive(async () => {
        const current = this.pool(pool.id);
        if (replayDigests.some(digest => current.federationReplayIds[digest] > this.clock.now())) {
          throw new OAuthEndpointError("access_denied", "SAML response or assertion was replayed.");
        }
        for (const digest of replayDigests) {
          current.federationReplayIds[digest] = this.clock.now() + FEDERATION_REPLAY_RETENTION_MS;
        }
        this.state.revision += 1;
        await this.store.save();
      });
      this.audit(`Federation:${provider.name}`, "SUCCESS", randomUUID(), pool.id);
      return this.completeFederatedAuthorization(
        req,
        res,
        pool,
        provider,
        authorization,
        verified.subject,
        "NameID",
        verified.attributes,
      );
    } catch (error) {
      this.audit(`Federation:${provider.name}`, "CLIENT_ERROR", randomUUID(), pool.id);
      throw this.federationOAuthError(error);
    }
  }

  private async beginManagedLoginMfa(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
  ): Promise<Record<string, any>> {
    const step = await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      const currentUser = currentPool.usersBySub[user.sub];
      if (!currentUser || currentUser.generationId !== user.generationId || !currentUser.enabled) {
        throw new OAuthEndpointError("access_denied", "The authenticated user is unavailable.");
      }
      const result = await this.authenticationStep(currentPool, currentClient, currentUser);
      if (!result.response.ChallengeName || result.response.AuthenticationResult) {
        throw new OAuthEndpointError("server_error", "The MFA challenge could not be created.", 500);
      }
      this.state.revision += 1;
      await this.store.save();
      return result;
    });
    return this.deliverAuthenticationStep(step);
  }

  private async authenticateManagedLogin(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    username: string,
    password: string,
  ): Promise<CognitoUserState> {
    modeledUsername(username);
    if (Buffer.byteLength(password, "utf8") > 1_024) {
      throw new OAuthEndpointError("access_denied", "Incorrect username or password.");
    }
    const user = findUserByModeledUsername(pool, username);
    const matches = user
      ? await this.passwords.verify(password, user.password)
      : await this.passwords.dummy(password);
    if (!user || !matches || !user.enabled) {
      throw new OAuthEndpointError("access_denied", "Incorrect username or password.");
    }
    if (user.status !== "CONFIRMED") {
      throw new OAuthEndpointError(
        "access_denied",
        user.status === "RESET_REQUIRED"
          ? "Password reset is required."
          : "The user must be confirmed before managed login.",
      );
    }
    await this.invokeTrigger(
      pool,
      client,
      user,
      "preAuthentication",
      "PreAuthentication_Authentication",
      {},
    );
    return user;
  }

  private async issueAuthorizationResponse(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    user: CognitoUserState,
    browserSession: CognitoBrowserSessionState,
    request: CognitoOAuthAuthorizationRequest,
  ): Promise<string> {
    if (request.responseType === "code") {
      const code = randomBytes(32).toString("base64url");
      const digest = this.oauthDigest(pool, "code", code);
      const now = this.clock.now();
      const state: CognitoAuthorizationCodeState = {
        digest,
        clientId: client.id,
        userSub: user.sub,
        userGenerationId: user.generationId,
        sessionEpoch: user.sessionEpoch,
        redirectUri: request.redirectUri,
        scopes: [...request.scopes],
        codeChallenge: request.codeChallenge!,
        ...(request.nonce ? { nonce: request.nonce } : {}),
        authTime: browserSession.createdAt,
        issuedAt: now,
        expiresAt: now + OAUTH_CODE_LIFETIME_MS,
        status: "ACTIVE",
      };
      await this.exclusive(async () => {
        const current = this.pool(pool.id);
        current.authorizationCodes[digest] = state;
        this.state.revision += 1;
        await this.store.save();
      });
      return this.oauthRedirect(request.redirectUri, { code, state: request.state });
    }
    let result: Record<string, unknown>;
    await this.exclusive(async () => {
      const currentPool = this.pool(pool.id);
      const currentClient = this.appClient(currentPool, client.id);
      const currentUser = currentPool.usersBySub[user.sub];
      if (!currentUser || currentUser.generationId !== user.generationId) {
        throw new OAuthEndpointError("access_denied", "The authenticated user is unavailable.");
      }
      const created = this.newRefreshSession(currentPool, currentClient, currentUser, undefined, {
        scopes: request.scopes,
        ...(request.nonce ? { nonce: request.nonce } : {}),
      });
      created.session.authTime = browserSession.createdAt;
      result = await this.authenticationResult(currentPool, currentClient, currentUser, created.session);
      currentPool.refreshSessions[created.session.id] = created.session;
      this.state.revision += 1;
      await this.store.save();
    });
    return this.oauthRedirect(request.redirectUri, {
      access_token: String(result!.AccessToken),
      id_token: result!.IdToken === undefined ? undefined : String(result!.IdToken),
      token_type: "Bearer",
      expires_in: Number(result!.ExpiresIn),
      scope: request.scopes.join(" "),
      state: request.state,
    }, true);
  }

  private async handleAuthorize(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (req.method === "GET") {
      const { client, request } = this.oauthAuthorizationRequest(pool, url.searchParams);
      if (request.providerName) {
        return sendOAuthRedirect(res, await this.beginFederation(pool, request));
      }
      const existingRaw = cookieValue(req, OAUTH_SESSION_COOKIE);
      const existing = request.prompt === "login" ? undefined : this.browserSession(pool, existingRaw);
      if (existing?.status === "AUTHENTICATED") {
        const user = pool.usersBySub[existing.userSub!];
        return sendOAuthRedirect(
          res,
          await this.issueAuthorizationResponse(pool, client, user, existing, request),
        );
      }
      const created = await this.newBrowserSession(pool, "ANONYMOUS");
      res.setHeader(
        "set-cookie",
        sessionCookie(
          OAUTH_SESSION_COOKIE,
          created.raw,
          this.oauthPublicOrigin().startsWith("https:"),
          Math.floor(OAUTH_ANONYMOUS_SESSION_LIFETIME_MS / 1_000),
        ),
      );
      return sendManagedLoginHtml(res, this.managedLoginPage(pool, client, request, created.csrf));
    }
    if (req.method !== "POST") throw new OAuthEndpointError("invalid_request", "Method not allowed.", 405);
    const form = await readOAuthForm(req);
    const username = form.username;
    const password = form.password;
    const csrf = form.csrf;
    const challengeName = form.challenge_name;
    const challengeSession = form.challenge_session;
    const mfaCode = form.mfa_code;
    const accountOperation = form.account_operation;
    const accountUsername = form.account_username;
    const accountPassword = form.account_password;
    const accountCode = form.account_code;
    delete form.username;
    delete form.password;
    delete form.csrf;
    delete form.challenge_name;
    delete form.challenge_session;
    delete form.mfa_code;
    delete form.account_operation;
    delete form.account_username;
    delete form.account_password;
    delete form.account_code;
    const { client, request } = this.oauthAuthorizationRequest(pool, form);
    if (!client.supportedIdentityProviders.includes("COGNITO")) {
      throw new OAuthEndpointError("unauthorized_client", "The Cognito directory is not enabled for this app client.");
    }
    const rawSession = cookieValue(req, OAUTH_SESSION_COOKIE);
    const anonymous = this.browserSession(pool, rawSession);
    if (
      !anonymous
      || anonymous.status !== "ANONYMOUS"
      || !this.csrfMatches(pool, anonymous, csrf)
    ) {
      throw new OAuthEndpointError("invalid_request", "The managed-login session or CSRF proof is invalid.");
    }
    if (accountOperation !== undefined) {
      if (clientHasSecret(client)) {
        throw new OAuthEndpointError("unauthorized_client", "Self-service account forms require a public app client.");
      }
      let message: string;
      try {
        if (accountOperation === "signup") {
          const input = {
            ClientId: client.id,
            Username: accountUsername,
            Password: accountPassword,
            UserAttributes: [{ Name: "email", Value: accountUsername }],
          };
          await this.validateProof("SignUp", input);
          await this.SignUp(input);
          message = "Account created. Enter the confirmation code delivered to the local SES Inbox.";
        } else if (accountOperation === "confirm") {
          const input = {
            ClientId: client.id,
            Username: accountUsername,
            ConfirmationCode: accountCode,
          };
          await this.validateProof("ConfirmSignUp", input);
          await this.ConfirmSignUp(input);
          message = "Account confirmed. You can now sign in.";
        } else if (accountOperation === "forgot") {
          await this.ForgotPassword({ ClientId: client.id, Username: accountUsername });
          message = "If the account is eligible, a recovery code was delivered to the local SES Inbox.";
        } else if (accountOperation === "confirm_forgot") {
          await this.ConfirmForgotPassword({
            ClientId: client.id,
            Username: accountUsername,
            ConfirmationCode: accountCode,
            Password: accountPassword,
          });
          message = "Password changed. You can now sign in.";
        } else {
          throw new OAuthEndpointError("invalid_request", "The account operation is invalid.");
        }
      } catch (error) {
        message = error instanceof Error ? error.message : "The account operation failed.";
      }
      return sendManagedLoginHtml(
        res,
        this.managedLoginPage(pool, client, request, String(csrf), message),
      );
    }
    let user: CognitoUserState;
    let postAuthenticationRequired = true;
    if (challengeName !== undefined || challengeSession !== undefined || mfaCode !== undefined) {
      if (
        (challengeName !== "SOFTWARE_TOKEN_MFA" && challengeName !== "EMAIL_OTP")
        || typeof challengeSession !== "string"
        || typeof mfaCode !== "string"
      ) throw new OAuthEndpointError("invalid_request", "The MFA response is invalid.");
      const context = this.challengeBySession(challengeSession);
      if (context.pool.id !== pool.id || context.client.id !== client.id || context.challenge.purpose !== challengeName) {
        throw new OAuthEndpointError("access_denied", "The MFA challenge is invalid.");
      }
      const responseInput: Record<string, any> = {
        ClientId: client.id,
        ChallengeName: challengeName,
        Session: challengeSession,
        ChallengeResponses: {
          USERNAME: context.user.username,
          [challengeName === "EMAIL_OTP" ? "EMAIL_OTP_CODE" : "SOFTWARE_TOKEN_MFA_CODE"]: mfaCode,
        },
      };
      try {
        this.validateChallengeProof(responseInput);
        const completed = await this.RespondToAuthChallenge(responseInput);
        const authentication = completed.AuthenticationResult as Record<string, any> | undefined;
        if (!authentication?.AccessToken) throw new Error();
        const eventId = String(parseJwt(authentication.AccessToken).claims.event_id ?? "");
        await this.exclusive(async () => {
          const current = this.pool(pool.id);
          for (const [id, session] of Object.entries(current.refreshSessions)) {
            if (session.eventId === eventId) delete current.refreshSessions[id];
          }
          this.state.revision += 1;
          await this.store.save();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The MFA code is invalid.";
        return sendManagedLoginHtml(
          res,
          this.managedLoginMfaPage(
            pool,
            client,
            request,
            String(csrf),
            challengeName,
            challengeSession,
            undefined,
            message,
          ),
          400,
        );
      }
      user = context.user;
      postAuthenticationRequired = false;
    } else {
      if (typeof username !== "string" || typeof password !== "string") {
        throw new OAuthEndpointError("invalid_request", "Username and password are required.");
      }
      try {
        user = await this.authenticateManagedLogin(pool, client, username, password);
      } catch (error) {
        if (!(error instanceof OAuthEndpointError)) throw error;
        return sendManagedLoginHtml(
          res,
          this.managedLoginPage(pool, client, request, String(csrf), error.message),
          error.status,
        );
      }
      if (this.managedLoginMfaRequired(pool, user)) {
        const challenge = await this.beginManagedLoginMfa(pool, client, user);
        if (challenge.ChallengeName !== "SOFTWARE_TOKEN_MFA" && challenge.ChallengeName !== "EMAIL_OTP") {
          throw new OAuthEndpointError(
            "access_denied",
            "Managed login requires an enrolled software token or eligible email MFA.",
          );
        }
        return sendManagedLoginHtml(
          res,
          this.managedLoginMfaPage(
            pool,
            client,
            request,
            String(csrf),
            challenge.ChallengeName,
            String(challenge.Session),
            challenge.ChallengeParameters?.CODE_DELIVERY_DESTINATION,
          ),
        );
      }
    }
    const created = await this.newBrowserSession(pool, "AUTHENTICATED", user);
    await this.exclusive(async () => {
      const current = this.pool(pool.id);
      const old = rawSession ? this.oauthDigest(current, "session", rawSession) : undefined;
      if (old && current.browserSessions[old]) {
        current.browserSessions[old].status = "LOGGED_OUT";
        current.browserSessions[old].expiresAt = this.clock.now();
      }
      this.state.revision += 1;
      await this.store.save();
    });
    if (postAuthenticationRequired) {
      await this.invokeTrigger(
        pool,
        client,
        user,
        "postAuthentication",
        "PostAuthentication_Authentication",
        {},
      );
    }
    res.setHeader(
      "set-cookie",
      sessionCookie(
        OAUTH_SESSION_COOKIE,
        created.raw,
        this.oauthPublicOrigin().startsWith("https:"),
        Math.floor(OAUTH_BROWSER_SESSION_LIFETIME_MS / 1_000),
      ),
    );
    return sendOAuthRedirect(
      res,
      await this.issueAuthorizationResponse(pool, client, user, created.session, request),
    );
  }

  private oauthTokenClient(
    pool: CognitoUserPoolState,
    req: IncomingMessage,
    form: Record<string, string>,
  ): { client: CognitoAppClientState; suppliedSecret?: string } {
    let basicClientId: string | undefined;
    let basicSecret: string | undefined;
    const authorization = String(req.headers.authorization ?? "");
    if (authorization) {
      const match = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw new OAuthEndpointError("invalid_client", "Client authentication is invalid.", 401);
      let decoded: string;
      try {
        const bytes = Buffer.from(match[1], "base64");
        if (bytes.toString("base64").replace(/=+$/, "") !== match[1].replace(/=+$/, "")) throw new Error();
        decoded = bytes.toString("utf8");
      } catch {
        throw new OAuthEndpointError("invalid_client", "Client authentication is invalid.", 401);
      }
      const separator = decoded.indexOf(":");
      if (separator < 1) throw new OAuthEndpointError("invalid_client", "Client authentication is invalid.", 401);
      try {
        basicClientId = decodeURIComponent(decoded.slice(0, separator).replaceAll("+", " "));
        basicSecret = decodeURIComponent(decoded.slice(separator + 1).replaceAll("+", " "));
      } catch {
        throw new OAuthEndpointError("invalid_client", "Client authentication is invalid.", 401);
      }
      if (form.client_secret !== undefined || form.client_id !== undefined && form.client_id !== basicClientId) {
        throw new OAuthEndpointError("invalid_request", "Client credentials must use one authentication method.");
      }
    }
    const clientIdValue = basicClientId ?? form.client_id;
    const suppliedSecret = basicSecret ?? form.client_secret;
    const client = clientIdValue ? pool.clients[clientIdValue] : undefined;
    if (!client || !client.allowedOAuthFlowsUserPoolClient) {
      throw new OAuthEndpointError("invalid_client", "The app client is invalid.", 401);
    }
    try {
      this.validateDirectClientSecret(pool, client, suppliedSecret);
    } catch {
      throw new OAuthEndpointError("invalid_client", "The app-client secret is invalid.", 401);
    }
    return { client, ...(suppliedSecret === undefined ? {} : { suppliedSecret }) };
  }

  private oauthTokenResponse(result: Record<string, unknown>, scopes: string[]): Record<string, unknown> {
    return {
      access_token: result.AccessToken,
      ...(result.IdToken === undefined ? {} : { id_token: result.IdToken }),
      ...(result.RefreshToken === undefined ? {} : { refresh_token: result.RefreshToken }),
      expires_in: result.ExpiresIn,
      token_type: "Bearer",
      scope: scopes.join(" "),
    };
  }

  private clientCredentialsResult(
    pool: CognitoUserPoolState,
    client: CognitoAppClientState,
    scopes: string[],
  ): Record<string, unknown> {
    if (!pool.signingKeys) throw new OAuthEndpointError("server_error", "Cognito signing keys are unavailable.", 503);
    const now = Math.floor(this.clock.now() / 1_000);
    const lifetime = validitySeconds(client.accessTokenValidity, client.tokenValidityUnits.accessToken);
    const accessToken = signCognitoJwt(
      this.secrets,
      this.store.accountId,
      this.region,
      pool.id,
      pool.signingKeys,
      "access",
      {
        sub: client.id,
        client_id: client.id,
        iss: cognitoIssuer(this.region, pool.id),
        token_use: "access",
        scope: scopes.join(" "),
        iat: now,
        exp: now + lifetime,
        version: 2,
        ...(client.enableTokenRevocation ? { jti: randomUUID() } : {}),
      },
    );
    return {
      access_token: accessToken,
      expires_in: lifetime,
      token_type: "Bearer",
      scope: scopes.join(" "),
    };
  }

  private async handleToken(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (req.method !== "POST" || url.search) {
      throw new OAuthEndpointError("invalid_request", "The token endpoint accepts POST without query parameters.", 405);
    }
    const form = await readOAuthForm(req);
    const allowed = new Set([
      "grant_type", "client_id", "client_secret", "code", "redirect_uri",
      "code_verifier", "refresh_token", "scope",
    ]);
    if (Object.keys(form).some(key => !allowed.has(key))) {
      throw new OAuthEndpointError("invalid_request", "The token request contains an unsupported parameter.");
    }
    const { client, suppliedSecret } = this.oauthTokenClient(pool, req, form);
    if (form.grant_type === "authorization_code") {
      if (!client.allowedOAuthFlows.includes("code")) {
        throw new OAuthEndpointError("unauthorized_client", "The authorization-code grant is not enabled.");
      }
      if (
        typeof form.code !== "string"
        || typeof form.redirect_uri !== "string"
        || typeof form.code_verifier !== "string"
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(form.code_verifier)
      ) {
        throw new OAuthEndpointError("invalid_request", "code, redirect_uri, and a valid PKCE verifier are required.");
      }
      const digest = this.oauthDigest(pool, "code", form.code);
      const code = pool.authorizationCodes[digest];
      const expectedChallenge = createHash("sha256").update(form.code_verifier, "ascii").digest("base64url");
      if (
        !code
        || code.status !== "ACTIVE"
        || code.clientId !== client.id
        || code.redirectUri !== form.redirect_uri
        || code.codeChallenge !== expectedChallenge
        || this.clock.now() >= code.expiresAt
      ) {
        throw new OAuthEndpointError("invalid_grant", "The authorization code is invalid, expired, reused, or has the wrong PKCE proof.");
      }
      let result: Record<string, unknown>;
      await this.exclusive(async () => {
        const currentPool = this.pool(pool.id);
        const currentClient = this.appClient(currentPool, client.id);
        const currentCode = currentPool.authorizationCodes[digest];
        const user = currentCode ? currentPool.usersBySub[currentCode.userSub] : undefined;
        if (
          !currentCode
          || currentCode.status !== "ACTIVE"
          || this.clock.now() >= currentCode.expiresAt
          || !user
          || !user.enabled
          || !tokenEligibleUser(user)
          || user.generationId !== currentCode.userGenerationId
          || user.sessionEpoch !== currentCode.sessionEpoch
        ) {
          throw new OAuthEndpointError("invalid_grant", "The authorization code is invalid or expired.");
        }
        const created = this.newRefreshSession(currentPool, currentClient, user, undefined, {
          scopes: currentCode.scopes,
          ...(currentCode.nonce ? { nonce: currentCode.nonce } : {}),
        });
        created.session.authTime = currentCode.authTime;
        result = await this.authenticationResult(
          currentPool,
          currentClient,
          user,
          created.session,
          created.token,
        );
        currentPool.refreshSessions[created.session.id] = created.session;
        currentCode.status = "CONSUMED";
        currentCode.consumedAt = this.clock.now();
        this.state.revision += 1;
        await this.store.save();
      });
      return sendOAuthJson(res, this.oauthTokenResponse(result!, code.scopes));
    }
    if (form.grant_type === "refresh_token") {
      if (typeof form.refresh_token !== "string") {
        throw new OAuthEndpointError("invalid_request", "refresh_token is required.");
      }
      const refreshInput: Record<string, any> = {
        ClientId: client.id,
        RefreshToken: form.refresh_token,
        ...(suppliedSecret === undefined ? {} : { ClientSecret: suppliedSecret }),
      };
      try {
        this.validateRefreshProof(refreshInput, "GetTokensFromRefreshToken");
        const output = await this.refreshAuthentication(refreshInput);
        const context = this.refreshProof.get(refreshInput);
        const scopes = context?.session.oauthScopes ?? [COGNITO_USER_ADMIN_SCOPE];
        return sendOAuthJson(
          res,
          this.oauthTokenResponse(output.AuthenticationResult as Record<string, unknown>, scopes),
        );
      } catch {
        throw new OAuthEndpointError("invalid_grant", "The refresh token is invalid or expired.");
      }
    }
    if (form.grant_type === "client_credentials") {
      if (!clientHasSecret(client) || !client.allowedOAuthFlows.includes("client_credentials")) {
        throw new OAuthEndpointError("unauthorized_client", "The client_credentials grant is not enabled.");
      }
      const scopes = this.oauthScopes(pool, client, form.scope);
      if (scopes.some(scope => STANDARD_OAUTH_SCOPES.has(scope))) {
        throw new OAuthEndpointError("invalid_scope", "Client credentials can use only custom scopes.");
      }
      return sendOAuthJson(res, this.clientCredentialsResult(pool, client, scopes));
    }
    throw new OAuthEndpointError("unsupported_grant_type", "The grant_type is not supported.");
  }

  private async handleUserInfo(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (!["GET", "POST"].includes(req.method ?? "") || url.search) {
      throw new OAuthEndpointError("invalid_request", "The userInfo request is invalid.", 405);
    }
    const match = String(req.headers.authorization ?? "").match(/^Bearer ([A-Za-z0-9._-]+)$/);
    if (!match) throw new OAuthEndpointError("invalid_token", "A bearer access token is required.", 401);
    const input = { AccessToken: match[1] };
    try {
      this.validateAccessProof(input, false);
    } catch {
      throw new OAuthEndpointError("invalid_token", "The access token is invalid or revoked.", 401);
    }
    const context = this.accessProof.get(input);
    if (!context || context.pool.id !== pool.id) {
      throw new OAuthEndpointError("invalid_token", "The access token is for another user pool.", 401);
    }
    const parsed = parseJwt(match[1]);
    const scopes = typeof parsed.claims.scope === "string"
      ? parsed.claims.scope.split(/\s+/).filter(Boolean)
      : [];
    if (!scopes.includes("openid")) {
      throw new OAuthEndpointError("insufficient_scope", "The openid scope is required.", 403);
    }
    const attributes: Record<string, unknown> = {
      sub: context.user.sub,
      username: context.user.username,
    };
    if (scopes.includes("email") && context.client.readAttributes.includes("email") && context.user.attributes.email) {
      attributes.email = context.user.attributes.email.value;
      attributes.email_verified = context.user.attributes.email.verified;
    }
    if (
      scopes.includes("phone")
      && context.client.readAttributes.includes("phone_number")
      && context.user.attributes.phone_number
    ) {
      attributes.phone_number = context.user.attributes.phone_number.value;
      attributes.phone_number_verified = context.user.attributes.phone_number.verified;
    }
    if (scopes.includes("profile")) {
      const profileClaims = new Set([
        "name", "family_name", "given_name", "middle_name", "nickname",
        "preferred_username", "profile", "picture", "website", "gender",
        "birthdate", "zoneinfo", "locale", "updated_at",
      ]);
      for (const [name, attribute] of Object.entries(context.user.attributes)) {
        if (
          context.client.readAttributes.includes(name)
          && (name.startsWith("custom:") || profileClaims.has(name))
        ) {
          attributes[name] = attribute.value;
        }
      }
    }
    return sendOAuthJson(res, attributes);
  }

  private async handleRevoke(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (req.method !== "POST" || url.search) {
      throw new OAuthEndpointError("invalid_request", "The revoke endpoint accepts POST without query parameters.", 405);
    }
    const form = await readOAuthForm(req);
    if (Object.keys(form).some(key => !["token", "client_id", "client_secret", "token_type_hint"].includes(key))) {
      throw new OAuthEndpointError("invalid_request", "The revocation request contains an unsupported parameter.");
    }
    const { client, suppliedSecret } = this.oauthTokenClient(pool, req, form);
    if (typeof form.token !== "string") {
      throw new OAuthEndpointError("invalid_request", "token is required.");
    }
    const input: Record<string, any> = {
      ClientId: client.id,
      Token: form.token,
      ...(suppliedSecret === undefined ? {} : { ClientSecret: suppliedSecret }),
    };
    try {
      this.validateRefreshProof(input, "RevokeToken");
      await this.RevokeToken(input);
    } catch {
      // RFC 7009 and Cognito do not reveal whether the submitted token existed.
    }
    oauthHeaders(res);
    res.statusCode = 200;
    res.end();
  }

  private async handleLogout(
    req: IncomingMessage,
    res: ServerResponse,
    pool: CognitoUserPoolState,
    url: URL,
  ): Promise<void> {
    if (req.method !== "GET") throw new OAuthEndpointError("invalid_request", "Method not allowed.", 405);
    for (const key of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(key).length !== 1) {
        throw new OAuthEndpointError("invalid_request", `Duplicate logout parameter: ${key}.`);
      }
    }
    if ([...url.searchParams.keys()].some(key => !["client_id", "logout_uri"].includes(key))) {
      throw new OAuthEndpointError("invalid_request", "The logout request contains an unsupported parameter.");
    }
    const clientIdValue = url.searchParams.get("client_id");
    const client = clientIdValue ? pool.clients[clientIdValue] : undefined;
    const logoutUri = url.searchParams.get("logout_uri");
    if (!client || !logoutUri || !client.logoutUrls.includes(logoutUri)) {
      throw new OAuthEndpointError("invalid_request", "client_id and an exact configured logout_uri are required.");
    }
    const raw = cookieValue(req, OAUTH_SESSION_COOKIE);
    if (raw) {
      await this.exclusive(async () => {
        const current = this.pool(pool.id);
        const digest = this.oauthDigest(current, "session", raw);
        const session = current.browserSessions[digest];
        if (session) {
          session.status = "LOGGED_OUT";
          session.expiresAt = this.clock.now();
          this.state.revision += 1;
          await this.store.save();
        }
      });
    }
    res.setHeader(
      "set-cookie",
      clearSessionCookie(OAUTH_SESSION_COOKIE, this.oauthPublicOrigin().startsWith("https:")),
    );
    return sendOAuthRedirect(res, logoutUri);
  }

  async handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      const match = url.pathname.match(/^\/_stacksim\/cognito-domain\/([^/]+)(\/.*)?$/);
      if (!match) throw new OAuthEndpointError("invalid_request", "Unknown managed-login route.", 404);
      let domain: string;
      try {
        domain = decodeURIComponent(match[1]);
      } catch {
        throw new OAuthEndpointError("invalid_request", "The managed-login domain is invalid.", 404);
      }
      if (encodeURIComponent(domain) !== match[1]) {
        throw new OAuthEndpointError("invalid_request", "The managed-login domain is invalid.", 404);
      }
      const pool = this.oauthPoolByDomain(domain);
      const suffix = match[2] || "/";
      if (suffix === "/" || suffix === "/login") {
        if (req.method !== "GET") throw new OAuthEndpointError("invalid_request", "Method not allowed.", 405);
        const configuredClients = Object.values(pool.clients)
          .filter(client => client.allowedOAuthFlowsUserPoolClient);
        return sendManagedLoginHtml(res, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pool.name)} managed login</title><style>:root{color-scheme:light dark}body{font:16px system-ui;margin:0;background:#f3f4f6;color:#111827}main{max-width:44rem;margin:8vh auto;background:white;padding:2rem;border-radius:.75rem;box-shadow:0 8px 30px #0002}.mono{font-family:ui-monospace,monospace;overflow-wrap:anywhere}li{margin:.7rem 0}@media(max-width:48rem){main{margin:0;min-height:100vh;border-radius:0}}</style></head><body><main><h1>${escapeHtml(pool.name)} managed login</h1><p>This is the safe local launch page. Start authentication from your application so it supplies an exact callback URL, state, nonce, and PKCE S256 challenge.</p><h2>Configured app clients</h2>${configuredClients.length ? `<ul>${configuredClients.map(client => `<li><strong>${escapeHtml(client.name)}</strong><div class="mono">${escapeHtml(client.id)}</div><div>${escapeHtml(client.allowedOAuthFlows.join(", "))}</div><div>Providers: ${escapeHtml(client.supportedIdentityProviders.join(", "))}</div></li>`).join("")}</ul>` : "<p>No app client has managed-login OAuth enabled.</p>"}<p>External OIDC and signed SAML providers appear in the managed-login selector only when explicitly configured and enabled for the app client.</p></main></body></html>`);
      }
      if (suffix === "/oauth2/authorize") return await this.handleAuthorize(req, res, pool, url);
      if (suffix === "/oauth2/idpresponse") return await this.handleOidcResponse(req, res, pool, url);
      if (suffix === "/saml2/idpresponse") return await this.handleSamlResponse(req, res, pool, url);
      if (suffix === "/oauth2/token") return await this.handleToken(req, res, pool, url);
      if (suffix === "/oauth2/userInfo") return await this.handleUserInfo(req, res, pool, url);
      if (suffix === "/oauth2/revoke") return await this.handleRevoke(req, res, pool, url);
      if (suffix === "/logout") return await this.handleLogout(req, res, pool, url);
      throw new OAuthEndpointError("invalid_request", "Unknown managed-login route.", 404);
    } catch (error) {
      const oauth = error instanceof OAuthEndpointError
        ? error
        : new OAuthEndpointError("server_error", "The managed-login request failed.", 500);
      return sendOAuthError(res, oauth);
    }
  }

  jwks(poolIdValue: string): { keys: Array<Record<string, string>>; etag: string } | undefined {
    const pool = this.state.pools[poolIdValue];
    if (!pool?.signingKeys) return undefined;
    return {
      keys: signingPublicKeys(pool.signingKeys),
      etag: signingKeysEtag(pool.signingKeys),
    };
  }

  async resolveIssuer(issuer: string): Promise<CognitoIssuerResolution> {
    let ownerRegion: string | undefined;
    let pool: CognitoUserPoolState | undefined;
    let tombstone: ReturnType<StateStore["regionState"]>["cognito"]["issuerTombstones"][string] | undefined;
    for (const candidateRegion of this.store.listRegions()) {
      const candidateState = this.store.regionState(candidateRegion).cognito;
      const candidatePool = Object.values(candidateState.pools).find(candidate => {
        try {
          return cognitoIssuer(candidateRegion, candidate.id) === issuer;
        } catch {
          return false;
        }
      });
      const candidateTombstone = Object.values(candidateState.issuerTombstones).find(candidate =>
        candidate.issuer === issuer
      );
      if (candidatePool || candidateTombstone) {
        ownerRegion = candidateRegion;
        pool = candidatePool;
        tombstone = candidateTombstone;
        break;
      }
    }
    if (!pool && !tombstone) return { kind: "UNOWNED" };
    const userPoolId = pool?.id ?? tombstone!.poolId;
    if (!pool) {
      return {
        kind: "CLAIMED_UNAVAILABLE",
        accountId: this.store.accountId,
        region: ownerRegion!,
        userPoolId,
        reason: "DELETED",
      };
    }
    try {
      this.secrets.assertAvailable();
    } catch {
      return {
        kind: "CLAIMED_UNAVAILABLE",
        accountId: this.store.accountId,
        region: ownerRegion!,
        userPoolId,
        reason: "CLOSED",
      };
    }
    if (pool.status !== "ACTIVE") {
      return {
        kind: "CLAIMED_UNAVAILABLE",
        accountId: this.store.accountId,
        region: ownerRegion!,
        userPoolId,
        reason: "CLOSED",
      };
    }
    if (!pool.signingKeys) {
      return {
        kind: "CLAIMED_UNAVAILABLE",
        accountId: this.store.accountId,
        region: ownerRegion!,
        userPoolId,
        reason: "KEYS_UNAVAILABLE",
      };
    }
    try {
      const keys = signingPublicKeys(pool.signingKeys) as unknown as JsonWebKey[];
      if (
        keys.length < 2
        || keys.some(key =>
          key.kty !== "RSA"
          || key.alg !== "RS256"
          || key.use !== "sig"
          || typeof key.kid !== "string"
        )
      ) {
        throw new Error("invalid signing keys");
      }
      return {
        kind: "AVAILABLE",
        accountId: this.store.accountId,
        region: ownerRegion!,
        userPoolId,
        keys,
      };
    } catch {
      return {
        kind: "CLAIMED_UNAVAILABLE",
        accountId: this.store.accountId,
        region: ownerRegion!,
        userPoolId,
        reason: "KEYS_UNAVAILABLE",
      };
    }
  }

  async verify(input: {
    token: string;
    allowedUserPoolArns: string[];
    expectedUse: "id" | "access";
    audienceExpression?: string;
    requiredScopes?: string[];
  }): Promise<CognitoRestAuthorizerVerification> {
    const pools = input.allowedUserPoolArns.map(value => {
      const parsed = parseCognitoUserPoolArn(value);
      if (
        !parsed
        || parsed.accountId !== this.store.accountId
        || parsed.region !== this.region
      ) {
        throw new CognitoRestConfigurationError("The Cognito user pool ARN is invalid for this API");
      }
      const configured = this.state.pools[parsed.userPoolId];
      if (configured && configured.arn !== value) {
        throw new CognitoRestConfigurationError("The Cognito user pool ARN has the wrong partition");
      }
      return parsed;
    });
    let issuer: string;
    try {
      const parsed = parseJwt(input.token);
      if (typeof parsed.claims.iss !== "string") throw new CognitoRestTokenError();
      issuer = parsed.claims.iss;
    } catch (error) {
      if (error instanceof CognitoRestTokenError) throw error;
      throw new CognitoRestTokenError();
    }
    const selected = pools.find(candidate => {
      try {
        return cognitoIssuer(candidate.region, candidate.userPoolId) === issuer;
      } catch {
        return false;
      }
    });
    if (!selected) throw new CognitoRestTokenError();
    const resolution = await this.resolveIssuer(issuer);
    if (resolution.kind !== "AVAILABLE") {
      throw new CognitoRestConfigurationError(
        resolution.kind === "CLAIMED_UNAVAILABLE"
          ? `The Cognito issuer is unavailable: ${resolution.reason}`
          : "The Cognito issuer is not owned by this simulator",
      );
    }
    const pool = this.state.pools[selected.userPoolId];
    if (!pool) throw new CognitoRestConfigurationError();
    return {
      ...verifyCognitoRestToken(pool, this.region, this.clock.now(), {
      token: input.token,
      expectedUse: input.expectedUse,
      audienceExpression: input.audienceExpression,
      requiredScopes: input.requiredScopes,
      }),
      userPoolArn: pool.arn,
    };
  }

  async cacheVersion(allowedUserPoolArns: string[]): Promise<string> {
    const versions = allowedUserPoolArns.map(value => {
      const parsed = parseCognitoUserPoolArn(value);
      if (
        !parsed
        || parsed.accountId !== this.store.accountId
        || parsed.region !== this.region
      ) {
        throw new CognitoRestConfigurationError("The Cognito user pool ARN is invalid for this API");
      }
      const pool = this.state.pools[parsed.userPoolId];
      if (!pool) {
        const tombstone = this.state.issuerTombstones[parsed.userPoolId];
        throw new CognitoRestConfigurationError(
          tombstone ? "The Cognito user pool was deleted" : "The Cognito user pool is unavailable",
        );
      }
      if (pool.arn !== value) {
        throw new CognitoRestConfigurationError("The Cognito user pool ARN has the wrong partition");
      }
      try {
        this.secrets.assertAvailable();
      } catch {
        throw new CognitoRestConfigurationError("The Cognito issuer is closed");
      }
      return `${value}\0${cognitoPoolCacheVersion(pool)}`;
    }).sort();
    return createHash("sha256").update(versions.join("\0")).digest("hex");
  }
}
