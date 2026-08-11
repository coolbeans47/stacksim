import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import type {
  SesConfigurationSetEventDestinationState,
  SesConfigurationSetState,
  SesContactListState,
  SesCustomVerificationTemplateState,
  SesIdentityState,
  SesRegionState,
  SesTemplateState,
  SesVerificationIntentState,
} from "./types.js";
import type { StateStore } from "./state.js";
import { awsQueryMap } from "./protocols/query-xml.js";
import { json, readJson } from "./util.js";
import { handleSesV1, type SesProtocolExecutor } from "./ses/protocol-v1.js";
import { handleSesV2 } from "./ses/protocol-v2.js";
import { buildSimpleMessage, parseRawMessage, rawSesAuthorizationHeaders, type SimpleAttachmentInput } from "./ses/mime.js";
import type { PreparedRecipient, PreparedSesMessage } from "./ses/model.js";
import { SesContentError, normalizeMailboxKey, parseMailboxAddress } from "./ses/validation.js";
import {
  renderTemplate,
  renderedTemplateSource,
  renderTemplateOrThrow,
  validateTemplateContent,
  validateTemplateName,
  type TemplateContent,
} from "./ses/templates.js";
import {
  deriveVerificationNonce,
  signVerificationToken,
  validateSesPublicUrl,
  verificationCallbackUrl,
  verificationNonceDigest,
  verifyVerificationToken,
  type VerificationTokenPayload,
} from "./ses/verification-links.js";

export interface SesServiceOptions {
  max24HourSend: number;
  maxSendRate: number;
  publicUrl?: string;
  maximumMailboxMessages: number;
  maximumMailboxBytes: number;
}

export interface SesInternalExecutionOptions {
  /**
   * Exact protected CloudFormation tag keys which an in-process provider may
   * supply on a tag-on-create call. Ordinary SDK requests never set this.
   */
  readonly cloudFormationSystemTagKeys?: readonly string[];
  readonly eventDestinationResourceId?: string;
}

export interface SesInternalProducerInput {
  messageId: string;
  acceptedAt: number;
  FromEmailAddress: string;
  FromEmailAddressIdentityArn?: string;
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: {
      Subject: { Data: string; Charset?: string };
      Body: {
        Text?: { Data: string; Charset?: string };
        Html?: { Data: string; Charset?: string };
      };
    };
  };
  ReplyToAddresses?: string[];
  ConfigurationSetName?: string;
}

export interface SesInternalProducerContext {
  servicePrincipal: "cognito-idp.amazonaws.com";
  originService: "cognito-idp";
  producerDeliveryKey: string;
  deliveryProfile: "COGNITO_DEFAULT" | "DEVELOPER";
}

type Family = "ses-v1" | "ses-v2";

const DAY = 24 * 60 * 60 * 1_000;
const RESULT_TTL = 5 * 60 * 1_000;
const LOCAL_CALLBACK_TTL = 7 * DAY;
const TEMPLATE_LIMIT = 20_000;
const CONFIGURATION_SET_LIMIT = 10_000;
const IDENTITY_LIMIT = 10_000;
const epochSeconds = (milliseconds: number): number => milliseconds / 1_000;
const wireTime = (value: unknown): number => {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  return new Date(String(value)).getTime();
};

function values<T = any>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "object" && value && Array.isArray((value as any).member)) return (value as any).member;
  return [value as T];
}

function stringValues(value: unknown): string[] {
  return values(value).map(String);
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === true || value === "true";
}

function decodeBase64(value: unknown, family: Family, fieldName: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1 || value.includes("=") && value.length % 4 !== 0) {
    throw new AwsError(family === "ses-v2" ? "BadRequestException" : "MessageRejected", `${fieldName} must be valid base64.`, 400);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new AwsError(family === "ses-v2" ? "BadRequestException" : "MessageRejected", `${fieldName} must be valid base64.`, 400);
  }
  return decoded;
}

function isCloudFormationSystemTag(key: string): boolean {
  return key.toLowerCase().startsWith("aws:cloudformation:");
}

function tagsFrom(value: unknown, systemTagKeys: readonly string[] = []): Record<string, string> {
  const allowedSystemTags = new Set(systemTagKeys);
  const result: Record<string, string> = {};
  for (const item of values<any>(value)) {
    const key = item?.Key ?? item?.Name;
    if (typeof key !== "string" || !key || key.length > 128 || Object.hasOwn(result, key)) throw new AwsError("BadRequestException", "Tags must have unique non-empty keys.", 400);
    if (key.toLowerCase().startsWith("aws:") && !allowedSystemTags.has(key)) throw new AwsError("BadRequestException", "Tag keys beginning with aws: are reserved.", 400);
    const tagValue = String(item?.Value ?? "");
    if (tagValue.length > 256) throw new AwsError("BadRequestException", "Tag values can contain at most 256 characters.", 400);
    result[key] = tagValue;
  }
  if (Object.keys(result).filter(key => !isCloudFormationSystemTag(key)).length > 50) throw new AwsError("BadRequestException", "A resource can have at most 50 user tags.", 400);
  return result;
}

function messageTagsFrom(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of values<any>(value)) {
    const key = item?.Name;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(key) || Object.hasOwn(result, key)) throw new AwsError("MessageRejected", "Message tag names must be unique and contain only letters, numbers, underscores, or hyphens.", 400);
    const tagValue = String(item?.Value ?? "");
    if (!/^[A-Za-z0-9_-]{0,256}$/.test(tagValue)) throw new AwsError("MessageRejected", "Message tag values contain unsupported characters.", 400);
    result[key] = tagValue;
  }
  if (Object.keys(result).length > 50) throw new AwsError("MessageRejected", "A message can have at most 50 tags.", 400);
  return result;
}

function canonicalIdentity(value: string): { canonical: string; type: "EMAIL_ADDRESS" | "DOMAIN"; original: string } {
  const original = String(value ?? "").trim();
  if (!original) throw new AwsError("BadRequestException", "EmailIdentity is required.", 400);
  if (original.includes("@")) return { canonical: normalizeMailboxKey(original), type: "EMAIL_ADDRESS", original };
  const domain = original.toLowerCase().replace(/\.$/, "");
  if (domain.length > 255 || domain.split(".").some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw new AwsError("BadRequestException", "EmailIdentity is not a valid email address or domain.", 400);
  return { canonical: domain, type: "DOMAIN", original };
}

function configurationSetName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new AwsError("BadRequestException", "Configuration set name must be 1-64 letters, numbers, underscores, or hyphens.", 400);
  return value;
}

function safeDecodeToken(tokens: PaginationTokens, operation: string, value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.length > 8_192) throw new AwsError("InvalidNextTokenException", "The pagination token is invalid.", 400);
  try {
    const decoded = tokens.decode<{ offset: number }>(operation, value);
    if (!Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error("invalid offset");
    return decoded.offset;
  } catch {
    throw new AwsError("InvalidNextTokenException", "The pagination token is invalid.", 400);
  }
}

function securityHeaders(res: ServerResponse, html = false): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  if (html) {
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader("x-frame-options", "DENY");
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

export class SesService implements SesProtocolExecutor {
  private mailbox: any;
  private started = false;
  private admitted = false;
  private shuttingDown = false;
  private publicBaseUrl?: string;
  private mutation = Promise.resolve();
  private readonly tokens: PaginationTokens;
  private metricPublisher?: { publish(event: { namespace: string; metricName: string; dimensions: Record<string, string>; value: number; unit: string; timestamp: number }): Promise<any> };
  private eventPublisher?: (input: { source: string; detailType: string; detail: unknown; resources?: string[]; time?: number; eventBusName?: string; deliveryLineage?: string[] }) => Promise<any>;
  private drainingOutbox = false;

  static validatePublicUrl(value: string): string {
    return validateSesPublicUrl(value);
  }

  constructor(
    private readonly store: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    private readonly options: SesServiceOptions,
  ) {
    this.tokens = new PaginationTokens(store.state.installation.paginationSecret);
  }

  setEventServices(
    metrics: { publish(event: { namespace: string; metricName: string; dimensions: Record<string, string>; value: number; unit: string; timestamp: number }): Promise<any> },
    publish: (input: { source: string; detailType: string; detail: unknown; resources?: string[]; time?: number; eventBusName?: string; deliveryLineage?: string[] }) => Promise<any>,
  ): void {
    this.metricPublisher = metrics;
    this.eventPublisher = publish;
    if (this.started) void this.drainEventOutbox();
  }

  private get state(): SesRegionState {
    return this.store.regionState(this.region).ses;
  }

  private async exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async start(): Promise<void> {
    if (this.started) return;
    const module = await import("./ses/mailbox-store.js");
    this.mailbox = new module.MailboxStore({
      root: this.store.root,
      accountId: this.store.accountId,
      region: this.region,
      maximumMessages: this.options.maximumMailboxMessages,
      maximumBytes: this.options.maximumMailboxBytes,
    });
    await this.mailbox.start?.();
    const account = this.state.account;
    let changed = false;
    if (account.max24HourSend !== this.options.max24HourSend) { account.max24HourSend = this.options.max24HourSend; changed = true; }
    if (account.maxSendRate !== this.options.maxSendRate) { account.maxSendRate = this.options.maxSendRate; changed = true; }
    const productionAccessEnabled = account.accessProfile === "PRODUCTION";
    if (account.productionAccessEnabled !== productionAccessEnabled) { account.productionAccessEnabled = productionAccessEnabled; changed = true; }
    if (changed) await this.store.save();
    this.started = true;
    void this.drainEventOutbox();
  }

  async completePostBind(baseUrl: string): Promise<void> {
    if (!this.started) await this.start();
    const resolved = validateSesPublicUrl(this.options.publicUrl ?? baseUrl);
    if (this.admitted && this.publicBaseUrl === resolved) return;
    this.publicBaseUrl = resolved;
    await this.recoverVerificationIntents();
    this.admitted = true;
  }

  admissionStatus(): "available" | "initializing" | "unavailable" {
    return this.admitted ? "available" : this.started ? "initializing" : "unavailable";
  }

  summary(): { messageCount: number; logicalBytes: number } {
    const usage = this.mailbox?.usage?.() ?? { messageCount: 0, logicalBytes: 0 };
    return { messageCount: Number(usage.messageCount ?? 0), logicalBytes: Number(usage.logicalBytes ?? 0) };
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.admitted = false;
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    await this.mutation;
    await this.mailbox?.stop?.();
    this.started = false;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string, _principal: PrincipalContext): Promise<void> {
    if (!this.admitted || this.shuttingDown) {
      const error = new AwsError("ServiceUnavailableException", "SES is not available while its regional mailbox is initializing or shutting down.", 503);
      return url.pathname.startsWith("/v2/email/") ? handleSesV2(req, res, url, requestId, { execute: async () => { throw error; } }) : handleSesV1(req, res, url, requestId, { execute: async () => { throw error; } });
    }
    return url.pathname.startsWith("/v2/email/")
      ? handleSesV2(req, res, url, requestId, this)
      : handleSesV1(req, res, url, requestId, this);
  }

  async execute(operation: string, input: any, family: Family, requestId: string, internal: SesInternalExecutionOptions = {}): Promise<Record<string, unknown> | void> {
    switch (operation) {
      case "VerifyEmailIdentity":
      case "VerifyEmailAddress":
        await this.createIdentity(input.EmailAddress, {}, family, true);
        return {};
      case "CreateEmailIdentity":
        return this.createIdentity(input.EmailIdentity, { tags: input.Tags, configurationSetName: input.ConfigurationSetName, dkimSigningAttributes: input.DkimSigningAttributes }, family, false, internal.cloudFormationSystemTagKeys);
      case "GetIdentityVerificationAttributes":
        return this.getIdentityVerificationAttributes(input);
      case "ListIdentities":
        return this.listIdentitiesV1(input);
      case "ListVerifiedEmailAddresses":
        return { VerifiedEmailAddresses: Object.values(this.state.identities).filter(identity => identity.identityType === "EMAIL_ADDRESS" && identity.verifiedForSendingStatus).map(identity => identity.identity).sort() };
      case "GetEmailIdentity":
        return this.getEmailIdentity(input.EmailIdentity);
      case "ListEmailIdentities":
        return this.listEmailIdentities(input);
      case "DeleteIdentity":
      case "DeleteVerifiedEmailAddress":
        return this.deleteIdentity(input.Identity ?? input.EmailAddress, false);
      case "DeleteEmailIdentity":
        return this.deleteIdentity(input.EmailIdentity, true);
      case "SendEmail":
        return this.sendEmail(input, family, requestId);
      case "SendRawEmail":
        return this.sendRawEmail(input, requestId);
      case "SendTemplatedEmail":
        return this.sendTemplatedEmail(input, requestId);
      case "SendBulkTemplatedEmail":
        return this.sendBulkTemplatedEmail(input, requestId);
      case "SendBulkEmail":
        return this.sendBulkEmail(input, requestId);
      case "CreateCustomVerificationEmailTemplate":
        return this.createCustomVerificationTemplate(input, family, internal.cloudFormationSystemTagKeys);
      case "GetCustomVerificationEmailTemplate":
        return this.getCustomVerificationTemplate(input.TemplateName, family);
      case "ListCustomVerificationEmailTemplates":
        return this.listCustomVerificationTemplates(input, family);
      case "UpdateCustomVerificationEmailTemplate":
        return this.updateCustomVerificationTemplate(input, family);
      case "DeleteCustomVerificationEmailTemplate":
        return this.deleteCustomVerificationTemplate(input.TemplateName, family);
      case "SendCustomVerificationEmail":
        return this.sendCustomVerificationEmail(input, family);
      case "VerifyDomainIdentity":
        return this.verifyDomainIdentity(input.Domain);
      case "VerifyDomainDkim":
        return this.verifyDomainDkim(input.Domain);
      case "GetIdentityDkimAttributes":
        return this.getIdentityDkimAttributes(input);
      case "SetIdentityDkimEnabled":
      case "PutEmailIdentityDkimAttributes":
        return this.putIdentityDkim(input, family);
      case "PutEmailIdentityDkimSigningAttributes":
        return this.putIdentityDkimSigning(input);
      case "GetIdentityMailFromDomainAttributes":
        return this.getIdentityMailFromAttributes(input);
      case "SetIdentityMailFromDomain":
      case "PutEmailIdentityMailFromAttributes":
        return this.putIdentityMailFrom(input, family);
      case "GetIdentityNotificationAttributes":
        return this.getIdentityNotificationAttributes(input);
      case "SetIdentityFeedbackForwardingEnabled":
      case "SetIdentityHeadersInNotificationsEnabled":
      case "SetIdentityNotificationTopic":
      case "PutEmailIdentityFeedbackAttributes":
        return this.putIdentityFeedback(input, operation);
      case "PutIdentityPolicy":
      case "CreateEmailIdentityPolicy":
      case "UpdateEmailIdentityPolicy":
        return this.putIdentityPolicy(input, family);
      case "GetIdentityPolicies":
      case "GetEmailIdentityPolicies":
        return this.getIdentityPolicies(input, family);
      case "ListIdentityPolicies":
        return this.listIdentityPolicies(input);
      case "DeleteIdentityPolicy":
      case "DeleteEmailIdentityPolicy":
        return this.deleteIdentityPolicy(input, family);
      case "CreateContactList":
        return this.createContactList(input, internal.cloudFormationSystemTagKeys);
      case "GetContactList":
        return this.getContactList(input.ContactListName);
      case "ListContactLists":
        return this.listContactLists(input);
      case "UpdateContactList":
        return this.updateContactList(input);
      case "DeleteContactList":
        return this.deleteContactList(input.ContactListName);
      case "CreateContact":
        return this.createContact(input);
      case "GetContact":
        return this.getContact(input);
      case "ListContacts":
        return this.listContacts(input);
      case "UpdateContact":
        return this.updateContact(input);
      case "DeleteContact":
        return this.deleteContact(input);
      case "PutAccountDetails":
        return this.putAccountDetails(input);
      case "PutAccountSuppressionAttributes":
        return this.putAccountSuppression(input);
      case "PutSuppressedDestination":
        return this.putSuppressedDestination(input);
      case "GetSuppressedDestination":
        return this.getSuppressedDestination(input.EmailAddress);
      case "ListSuppressedDestinations":
        return this.listSuppressedDestinations(input);
      case "DeleteSuppressedDestination":
        return this.deleteSuppressedDestination(input.EmailAddress);
      case "GetAccountSendingEnabled":
        return { Enabled: this.state.account.sendingEnabled };
      case "UpdateAccountSendingEnabled":
        return this.updateAccountSending(booleanValue(input.Enabled));
      case "GetAccount":
        return this.getAccount();
      case "PutAccountSendingAttributes":
        return this.updateAccountSending(booleanValue(input.SendingEnabled));
      case "GetSendQuota":
        return this.getSendQuota();
      case "GetSendStatistics":
        return this.getSendStatistics();
      case "TagResource":
        return this.tagResource(input.ResourceArn, input.Tags);
      case "UntagResource":
        return this.untagResource(input.ResourceArn, input.TagKeys);
      case "ListTagsForResource":
        return this.listResourceTags(input.ResourceArn);
      case "CreateTemplate":
        return this.createTemplateV1(input);
      case "CreateEmailTemplate":
        return this.createTemplateV2(input, internal.cloudFormationSystemTagKeys);
      case "GetTemplate":
        return this.getTemplateV1(input.TemplateName);
      case "GetEmailTemplate":
        return this.getTemplateV2(input.TemplateName);
      case "ListTemplates":
        return this.listTemplatesV1(input);
      case "ListEmailTemplates":
        return this.listTemplatesV2(input);
      case "UpdateTemplate":
        return this.updateTemplateV1(input);
      case "UpdateEmailTemplate":
        return this.updateTemplateV2(input);
      case "DeleteTemplate":
        return this.deleteTemplate(input.TemplateName, family);
      case "DeleteEmailTemplate":
        return this.deleteTemplate(input.TemplateName, family);
      case "TestRenderTemplate":
        return this.testRenderTemplate(input.TemplateName, input.TemplateData, family);
      case "TestRenderEmailTemplate":
        return this.testRenderTemplate(input.TemplateName, input.TemplateData, family);
      case "CreateConfigurationSet":
        return this.createConfigurationSet(input, family, internal.cloudFormationSystemTagKeys);
      case "DescribeConfigurationSet":
        return this.describeConfigurationSet(input);
      case "GetConfigurationSet":
        return this.getConfigurationSet(input.ConfigurationSetName);
      case "ListConfigurationSets":
        return this.listConfigurationSets(input, family);
      case "DeleteConfigurationSet":
        return this.deleteConfigurationSet(input.ConfigurationSetName, family);
      case "UpdateConfigurationSetSendingEnabled":
        return this.putConfigurationSetSending(input.ConfigurationSetName, booleanValue(input.Enabled), family);
      case "PutConfigurationSetSendingOptions":
        return this.putConfigurationSetSending(input.ConfigurationSetName, booleanValue(input.SendingEnabled), family);
      case "PutEmailIdentityConfigurationSetAttributes":
        return this.putIdentityConfigurationSet(input.EmailIdentity, input.ConfigurationSetName);
      case "CreateConfigurationSetEventDestination":
        return this.putConfigurationSetEventDestination(input, family, true, internal.eventDestinationResourceId);
      case "UpdateConfigurationSetEventDestination":
        return this.putConfigurationSetEventDestination(input, family, false);
      case "GetConfigurationSetEventDestinations":
        return this.getConfigurationSetEventDestinations(input.ConfigurationSetName);
      case "DeleteConfigurationSetEventDestination":
        return this.deleteConfigurationSetEventDestination(input, family);
      case "CreateConfigurationSetTrackingOptions":
      case "UpdateConfigurationSetTrackingOptions":
      case "PutConfigurationSetTrackingOptions":
        return this.putConfigurationSetTracking(input, family, operation);
      case "DeleteConfigurationSetTrackingOptions":
        return this.deleteConfigurationSetTracking(input.ConfigurationSetName);
      case "PutConfigurationSetDeliveryOptions":
        return this.putConfigurationSetDelivery(input, family);
      case "UpdateConfigurationSetReputationMetricsEnabled":
      case "PutConfigurationSetReputationOptions":
        return this.putConfigurationSetReputation(input, family);
      case "PutConfigurationSetSuppressionOptions":
        return this.putConfigurationSetSuppression(input);
      case "BatchGetMetricData":
        return this.batchGetMetricData(input);
      case "GetMessageInsights":
        return this.getMessageInsights(input.MessageId);
      default:
        throw new AwsError(family === "ses-v2" ? "NotFoundException" : "InvalidAction", `The SES operation ${operation} is not implemented.`, family === "ses-v2" ? 404 : 400);
    }
  }

  private identityArn(identity: string): string {
    return `arn:aws:ses:${this.region}:${this.store.accountId}:identity/${identity}`;
  }

  private templateArn(name: string): string {
    return `arn:aws:ses:${this.region}:${this.store.accountId}:template/${name}`;
  }

  private configurationSetArn(name: string): string {
    return `arn:aws:ses:${this.region}:${this.store.accountId}:configuration-set/${name}`;
  }

  private dkimTokens(domain: string): string[] {
    return [0, 1, 2].map(index => createHash("sha256").update(`${this.store.state.installation.id}:${this.store.accountId}:${this.region}:${domain}:${index}`).digest("base64url").slice(0, 32).toLowerCase());
  }

  private async createIdentity(
    supplied: unknown,
    options: { tags?: unknown; configurationSetName?: unknown; dkimSigningAttributes?: unknown },
    family: Family,
    allowExisting: boolean,
    systemTagKeys: readonly string[] = [],
    verificationTemplate?: SesCustomVerificationTemplateState,
  ): Promise<Record<string, unknown>> {
    const parsed = canonicalIdentity(String(supplied ?? ""));
    if (options.dkimSigningAttributes !== undefined) throw new AwsError(family === "ses-v2" ? "BadRequestException" : "InvalidParameterValue", "BYODKIM private keys are not accepted by this local simulator.", 400);
    const tags = tagsFrom(options.tags, systemTagKeys);
    const defaultConfigurationSetName = options.configurationSetName === undefined ? undefined : configurationSetName(options.configurationSetName);
    if (defaultConfigurationSetName && !this.state.configurationSets[defaultConfigurationSetName]) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "ConfigurationSetDoesNotExist", `Configuration set ${defaultConfigurationSetName} does not exist.`, family === "ses-v2" ? 404 : 400);
    return this.exclusive(async () => {
      const state = this.state;
      let identity = state.identities[parsed.canonical];
      if (identity) {
        const pending = Object.values(state.verificationIntents)
          .filter(intent => intent.identityGeneration === identity!.generationId && intent.status === "PENDING_CAPTURE")
          .sort((left, right) => left.issuedAt - right.issuedAt || left.intentId.localeCompare(right.intentId));
        const recoversOriginalCreate = pending.some(intent => identity!.activeVerificationIntentId === intent.intentId);
        if (pending.length) {
          for (const intent of pending) this.captureVerificationIntent(identity, intent, "VERIFICATION_RECOVERED");
          await this.store.save();
          if (allowExisting || recoversOriginalCreate) return this.identityCreateResponse(identity);
        }
      }
      if (identity && !allowExisting) throw new AwsError(family === "ses-v2" ? "AlreadyExistsException" : "AlreadyExists", `Email identity ${parsed.original} already exists.`, 400);
      const previousIdentity = identity ? structuredClone(identity) : undefined;
      const previousRevision = state.controlRevision;
      const created = !identity;
      if (!identity) {
        if (Object.keys(state.identities).length >= IDENTITY_LIMIT) throw new AwsError(family === "ses-v2" ? "LimitExceededException" : "LimitExceeded", "The regional SES identity limit has been reached.", 400);
        const now = this.clock.now();
        identity = {
          identity: parsed.original,
          canonicalIdentity: parsed.canonical,
          identityType: parsed.type,
          arn: this.identityArn(parsed.original),
          generationId: randomBytes(16).toString("hex"),
          verificationStatus: "PENDING",
          verifiedForSendingStatus: false,
          dkimTokens: parsed.type === "DOMAIN" ? this.dkimTokens(parsed.canonical) : [],
          dkimSigningEnabled: parsed.type === "DOMAIN",
          dkimSigningAttributesOrigin: "AWS_SES",
          dkimCurrentSigningKeyLength: "RSA_2048_BIT",
          dkimVerificationStatus: parsed.type === "DOMAIN" ? "PENDING" : "NOT_STARTED",
          ...(parsed.type === "DOMAIN" ? { verificationToken: createHash("sha256").update(`${this.store.state.installation.id}:${this.store.accountId}:${this.region}:${parsed.canonical}:verify`).digest("base64url").slice(0, 43) } : {}),
          mailFromAttributes: { behaviorOnMxFailure: "USE_DEFAULT_VALUE", mailFromDomainStatus: "PENDING" },
          feedbackForwardingStatus: true,
          headersInNotificationsEnabled: false,
          notificationTopics: {},
          tags,
          policies: {},
          createdAt: now,
          updatedAt: now,
          ...(defaultConfigurationSetName ? { defaultConfigurationSetName } : {}),
        };
        state.identities[parsed.canonical] = identity;
        state.controlRevision += 1;
      } else {
        if (Object.keys(tags).length) identity.tags = { ...identity.tags, ...tags };
        if (defaultConfigurationSetName !== undefined) identity.defaultConfigurationSetName = defaultConfigurationSetName;
        identity.updatedAt = this.clock.now();
      }
      try {
        if (parsed.type === "EMAIL_ADDRESS" && !identity.verifiedForSendingStatus) await this.issueVerificationIntent(identity, verificationTemplate);
        else await this.store.save();
      } catch (error) {
        const persistedIntent = Object.values(state.verificationIntents)
          .some(intent => intent.identityGeneration === identity!.generationId && intent.status === "PENDING_CAPTURE");
        if (!persistedIntent) {
          if (created) delete state.identities[parsed.canonical];
          else state.identities[parsed.canonical] = previousIdentity!;
          state.controlRevision = previousRevision;
        }
        throw error;
      }
      return this.identityCreateResponse(identity);
    });
  }

  private identityCreateResponse(identity: SesIdentityState): Record<string, unknown> {
    return {
      IdentityType: identity.identityType,
      VerifiedForSendingStatus: identity.verifiedForSendingStatus,
      DkimAttributes: {
        SigningEnabled: identity.dkimSigningEnabled,
        Status: identity.dkimVerificationStatus,
        Tokens: identity.dkimTokens,
        ...(identity.identityType === "DOMAIN" ? { SigningAttributesOrigin: identity.dkimSigningAttributesOrigin ?? "AWS_SES", CurrentSigningKeyLength: identity.dkimCurrentSigningKeyLength, NextSigningKeyLength: identity.dkimNextSigningKeyLength, LastKeyGenerationTimestamp: identity.lastKeyGenerationTimestamp && epochSeconds(identity.lastKeyGenerationTimestamp) } : {}),
      },
    };
  }

  private identityDetails(identity: SesIdentityState): Record<string, unknown> {
    return {
      IdentityType: identity.identityType,
      FeedbackForwardingStatus: identity.feedbackForwardingStatus ?? true,
      VerifiedForSendingStatus: identity.verifiedForSendingStatus,
      DkimAttributes: {
        SigningEnabled: identity.dkimSigningEnabled,
        Status: identity.dkimVerificationStatus,
        Tokens: identity.dkimTokens,
        ...(identity.identityType === "DOMAIN" ? { SigningAttributesOrigin: identity.dkimSigningAttributesOrigin ?? "AWS_SES", CurrentSigningKeyLength: identity.dkimCurrentSigningKeyLength, NextSigningKeyLength: identity.dkimNextSigningKeyLength, LastKeyGenerationTimestamp: identity.lastKeyGenerationTimestamp && epochSeconds(identity.lastKeyGenerationTimestamp) } : {}),
      },
      MailFromAttributes: {
        MailFromDomain: identity.mailFromAttributes?.mailFromDomain,
        MailFromDomainStatus: identity.mailFromAttributes?.mailFromDomainStatus ?? "PENDING",
        BehaviorOnMxFailure: identity.mailFromAttributes?.behaviorOnMxFailure ?? "USE_DEFAULT_VALUE",
      },
      Policies: { ...identity.policies },
      ...(identity.defaultConfigurationSetName ? { ConfigurationSetName: identity.defaultConfigurationSetName } : {}),
      Tags: Object.entries(identity.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })),
    };
  }

  private getEmailIdentity(value: unknown): Record<string, unknown> {
    const parsed = canonicalIdentity(String(value ?? ""));
    const identity = this.state.identities[parsed.canonical];
    if (!identity || identity.activeVerificationIntentId && this.state.verificationIntents[identity.activeVerificationIntentId]?.status === "PENDING_CAPTURE") throw new AwsError("NotFoundException", `Email identity ${parsed.original} does not exist.`, 404);
    return this.identityDetails(identity);
  }

  private getIdentityVerificationAttributes(input: any): Record<string, unknown> {
    const identities: Record<string, unknown> = {};
    for (const supplied of stringValues(input.Identities)) {
      let parsed: ReturnType<typeof canonicalIdentity>;
      try { parsed = canonicalIdentity(supplied); } catch { continue; }
      const identity = this.state.identities[parsed.canonical];
      if (!identity) continue;
      const verificationStatus = {
        PENDING: "Pending",
        SUCCESS: "Success",
        FAILED: "Failed",
        TEMPORARY_FAILURE: "TemporaryFailure",
        NOT_STARTED: "NotStarted",
      }[identity.verificationStatus];
      identities[supplied] = {
        VerificationStatus: verificationStatus,
        ...(identity.verificationToken ? { VerificationToken: identity.verificationToken } : {}),
      };
    }
    return { VerificationAttributes: awsQueryMap(identities) };
  }

  private listIdentitiesV1(input: any): Record<string, unknown> {
    const operation = `ses-v1:ListIdentities:${String(input.IdentityType ?? "ALL")}`;
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = input.MaxItems === undefined ? 1_000 : Math.max(1, Math.min(1_000, Number(input.MaxItems)));
    const type = input.IdentityType === "EmailAddress"
      ? "EMAIL_ADDRESS"
      : input.IdentityType === "Domain"
        ? "DOMAIN"
        : undefined;
    const all = Object.values(this.state.identities)
      .filter(identity => !type || identity.identityType === type)
      .filter(identity => !identity.activeVerificationIntentId || this.state.verificationIntents[identity.activeVerificationIntentId]?.status !== "PENDING_CAPTURE")
      .map(identity => identity.identity)
      .sort();
    const page = all.slice(offset, offset + maximum);
    return { Identities: page, ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}) };
  }

  private listEmailIdentities(input: any): Record<string, unknown> {
    const operation = "ses-v2:ListEmailIdentities";
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = input.PageSize === undefined ? 1_000 : Math.max(1, Math.min(1_000, Number(input.PageSize)));
    const all = Object.values(this.state.identities)
      .filter(identity => !identity.activeVerificationIntentId || this.state.verificationIntents[identity.activeVerificationIntentId]?.status !== "PENDING_CAPTURE")
      .sort((left, right) => left.identity.localeCompare(right.identity));
    const page = all.slice(offset, offset + maximum);
    return {
      EmailIdentities: page.map(identity => ({ IdentityType: identity.identityType, IdentityName: identity.identity, SendingEnabled: identity.verifiedForSendingStatus, VerificationStatus: identity.verificationStatus })),
      ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}),
    };
  }

  private async deleteIdentity(value: unknown, v2: boolean): Promise<Record<string, unknown>> {
    const parsed = canonicalIdentity(String(value ?? ""));
    return this.exclusive(async () => {
      const identity = this.state.identities[parsed.canonical];
      if (!identity) {
        if (v2) throw new AwsError("NotFoundException", `Email identity ${parsed.original} does not exist.`, 404);
        return {};
      }
      for (const intent of Object.values(this.state.verificationIntents)) {
        if (intent.identityGeneration === identity.generationId && !["CONSUMED", "CANCELLED", "EXPIRED", "SUPERSEDED"].includes(intent.status)) {
          intent.status = "CANCELLED";
          intent.terminalAt = this.clock.now();
        }
      }
      delete this.state.identities[parsed.canonical];
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async updateAccountSending(enabled: boolean): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (this.state.account.sendingEnabled !== enabled) {
        this.state.account.sendingEnabled = enabled;
        this.state.controlRevision += 1;
        await this.store.save();
      }
      return {};
    });
  }

  private getAccount(): Record<string, unknown> {
    const quota = this.getSendQuota();
    return {
      ProductionAccessEnabled: this.state.account.productionAccessEnabled,
      SendingEnabled: this.state.account.sendingEnabled,
      EnforcementStatus: "HEALTHY",
      SendQuota: quota,
      SuppressionAttributes: { SuppressedReasons: this.state.account.suppressionReasons ?? [] },
      Details: this.state.account.details && {
        MailType: this.state.account.details.mailType,
        WebsiteURL: this.state.account.details.websiteUrl,
        ContactLanguage: this.state.account.details.contactLanguage,
        AdditionalContactEmailAddresses: this.state.account.details.additionalContactEmailAddresses,
        ReviewDetails: this.state.account.details.reviewDetails && { Status: this.state.account.details.reviewDetails.status, CaseId: this.state.account.details.reviewDetails.caseId },
      },
    };
  }

  private effectiveQuotaLimits(): { max24HourSend: number; maxSendRate: number } {
    if (this.state.account.accessProfile !== "SANDBOX") {
      return { max24HourSend: this.state.account.max24HourSend, maxSendRate: this.state.account.maxSendRate };
    }
    return {
      max24HourSend: Math.min(this.state.account.max24HourSend, 200),
      maxSendRate: Math.min(this.state.account.maxSendRate, 1),
    };
  }

  private getSendQuota(): Record<string, unknown> {
    const sentLast24Hours = Number(this.mailbox?.recipientCountSince?.(this.clock.now() - DAY) ?? 0);
    const limits = this.effectiveQuotaLimits();
    return {
      Max24HourSend: limits.max24HourSend,
      MaxSendRate: limits.maxSendRate,
      SentLast24Hours: sentLast24Hours,
    };
  }

  private getSendStatistics(): Record<string, unknown> {
    const recipients = Number(this.mailbox?.recipientCountSince?.(this.clock.now() - DAY) ?? 0);
    return { SendDataPoints: recipients ? [{ Timestamp: new Date(Math.floor(this.clock.now() / 900_000) * 900_000), DeliveryAttempts: recipients, Bounces: 0, Complaints: 0, Rejects: 0 }] : [] };
  }

  private createTemplateV1(input: any): Promise<Record<string, unknown>> {
    const template = input.Template ?? {};
    return this.createTemplate(template.TemplateName, {
      SubjectPart: template.SubjectPart,
      TextPart: template.TextPart,
      HtmlPart: template.HtmlPart,
    }, undefined, "ses-v1");
  }

  private createTemplateV2(input: any, systemTagKeys: readonly string[] = []): Promise<Record<string, unknown>> {
    return this.createTemplate(input.TemplateName, input.TemplateContent, input.Tags, "ses-v2", systemTagKeys);
  }

  private async createTemplate(nameValue: unknown, contentValue: unknown, tagValue: unknown, family: Family, systemTagKeys: readonly string[] = []): Promise<Record<string, unknown>> {
    const name = validateTemplateName(nameValue);
    const content = validateTemplateContent(contentValue);
    const tags = tagsFrom(tagValue, systemTagKeys);
    return this.exclusive(async () => {
      if (this.state.templates[name]) throw new AwsError(family === "ses-v2" ? "AlreadyExistsException" : "AlreadyExists", `Template ${name} already exists.`, 400);
      if (Object.keys(this.state.templates).length >= TEMPLATE_LIMIT) throw new AwsError(family === "ses-v2" ? "LimitExceededException" : "LimitExceeded", "The regional SES template limit has been reached.", 400);
      const now = this.clock.now();
      this.state.templates[name] = {
        name,
        arn: this.templateArn(name),
        subjectPart: content.Subject,
        ...(content.Text === undefined ? {} : { textPart: content.Text }),
        ...(content.Html === undefined ? {} : { htmlPart: content.Html }),
        tags,
        createdAt: now,
        updatedAt: now,
      };
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private templateOrThrow(nameValue: unknown, family: Family): SesTemplateState {
    const name = validateTemplateName(nameValue);
    const template = this.state.templates[name];
    if (!template) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "TemplateDoesNotExist", `Template ${name} does not exist.`, family === "ses-v2" ? 404 : 400);
    return template;
  }

  private getTemplateV1(name: unknown): Record<string, unknown> {
    const template = this.templateOrThrow(name, "ses-v1");
    return { Template: { TemplateName: template.name, SubjectPart: template.subjectPart, ...(template.textPart === undefined ? {} : { TextPart: template.textPart }), ...(template.htmlPart === undefined ? {} : { HtmlPart: template.htmlPart }) } };
  }

  private getTemplateV2(name: unknown): Record<string, unknown> {
    const template = this.templateOrThrow(name, "ses-v2");
    return { TemplateName: template.name, TemplateContent: { Subject: template.subjectPart, ...(template.textPart === undefined ? {} : { Text: template.textPart }), ...(template.htmlPart === undefined ? {} : { Html: template.htmlPart }) } };
  }

  private listTemplatesV1(input: any): Record<string, unknown> {
    const operation = "ses-v1:ListTemplates";
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = input.MaxItems === undefined ? 10 : Math.max(1, Math.min(100, Number(input.MaxItems)));
    const all = Object.values(this.state.templates).sort((left, right) => left.name.localeCompare(right.name));
    const page = all.slice(offset, offset + maximum);
    return {
      TemplatesMetadata: page.map(template => ({ Name: template.name, CreatedTimestamp: new Date(template.createdAt) })),
      ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}),
    };
  }

  private listTemplatesV2(input: any): Record<string, unknown> {
    const operation = "ses-v2:ListEmailTemplates";
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = input.PageSize === undefined ? 10 : Math.max(1, Math.min(100, Number(input.PageSize)));
    const all = Object.values(this.state.templates).sort((left, right) => left.name.localeCompare(right.name));
    const page = all.slice(offset, offset + maximum);
    return {
      TemplatesMetadata: page.map(template => ({ TemplateName: template.name, CreatedTimestamp: epochSeconds(template.createdAt) })),
      ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}),
    };
  }

  private updateTemplateV1(input: any): Promise<Record<string, unknown>> {
    const template = input.Template ?? {};
    return this.updateTemplate(template.TemplateName, { SubjectPart: template.SubjectPart, TextPart: template.TextPart, HtmlPart: template.HtmlPart }, "ses-v1");
  }

  private updateTemplateV2(input: any): Promise<Record<string, unknown>> {
    return this.updateTemplate(input.TemplateName, input.TemplateContent, "ses-v2");
  }

  private async updateTemplate(nameValue: unknown, contentValue: unknown, family: Family): Promise<Record<string, unknown>> {
    const name = validateTemplateName(nameValue);
    const content = validateTemplateContent(contentValue);
    return this.exclusive(async () => {
      const template = this.templateOrThrow(name, family);
      template.subjectPart = content.Subject;
      if (content.Text === undefined) delete template.textPart; else template.textPart = content.Text;
      if (content.Html === undefined) delete template.htmlPart; else template.htmlPart = content.Html;
      template.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async deleteTemplate(nameValue: unknown, family: Family): Promise<Record<string, unknown>> {
    const name = validateTemplateName(nameValue);
    return this.exclusive(async () => {
      if (!this.state.templates[name]) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "TemplateDoesNotExist", `Template ${name} does not exist.`, family === "ses-v2" ? 404 : 400);
      delete this.state.templates[name];
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private testRenderTemplate(nameValue: unknown, templateData: unknown, family: Family): Record<string, unknown> {
    const template = this.templateOrThrow(nameValue, family);
    let content: TemplateContent;
    try {
      content = renderTemplateOrThrow({ Subject: template.subjectPart, Text: template.textPart, Html: template.htmlPart }, templateData);
    } catch (error) {
      if (error instanceof AwsError && family === "ses-v2") throw new AwsError("BadRequestException", error.message, 400);
      throw error;
    }
    return { RenderedTemplate: renderedTemplateSource(content) };
  }

  private named(value: unknown, label: string, maximum = 64): string {
    if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_-]{1,${maximum}}$`).test(value)) {
      throw new AwsError("BadRequestException", `${label} must contain 1-${maximum} letters, numbers, underscores, or hyphens.`, 400);
    }
    return value;
  }

  private safeWebUrl(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length > 1_000) throw new AwsError("BadRequestException", `${label} must be a valid HTTP or HTTPS URL.`, 400);
    let url: URL;
    try { url = new URL(value); } catch { throw new AwsError("BadRequestException", `${label} must be a valid HTTP or HTTPS URL.`, 400); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AwsError("BadRequestException", `${label} must be a valid HTTP or HTTPS URL without credentials.`, 400);
    return url.toString();
  }

  private customVerificationTemplateArn(name: string): string {
    return `arn:aws:ses:${this.region}:${this.store.accountId}:custom-verification-email-template/${name}`;
  }

  private contactListArn(name: string): string {
    return `arn:aws:ses:${this.region}:${this.store.accountId}:contact-list/${name}`;
  }

  private customVerificationTemplate(value: unknown, family: Family): SesCustomVerificationTemplateState {
    const name = this.named(value, "TemplateName");
    const template = this.state.customVerificationTemplates[name];
    if (!template) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "CustomVerificationEmailTemplateDoesNotExist", `Custom verification template ${name} does not exist.`, family === "ses-v2" ? 404 : 400);
    return template;
  }

  private customVerificationInput(input: any, family: Family, existing?: SesCustomVerificationTemplateState): Omit<SesCustomVerificationTemplateState, "arn" | "tags" | "createdAt" | "updatedAt"> {
    const name = this.named(input.TemplateName ?? existing?.name, "TemplateName");
    const fromEmailAddress = String(input.FromEmailAddress ?? existing?.fromEmailAddress ?? "");
    parseMailboxAddress(fromEmailAddress);
    const source = this.sourceIdentity(fromEmailAddress, family);
    if (!source.verifiedForSendingStatus) throw new AwsError("FromEmailAddressNotVerified", "The custom verification template From address is not verified.", 400);
    const templateSubject = String(input.TemplateSubject ?? existing?.templateSubject ?? "");
    const templateContent = String(input.TemplateContent ?? existing?.templateContent ?? "");
    if (!templateSubject || Buffer.byteLength(templateSubject) > 998 || !templateContent || Buffer.byteLength(templateSubject) + Buffer.byteLength(templateContent) >= 10 * 1024 * 1024) throw new AwsError("BadRequestException", "TemplateSubject and template content below 10 MB are required.", 400);
    if (!templateContent.includes("{{amazonSESVerificationURL}}") && !templateContent.includes("{{verificationURL}}")) throw new AwsError("BadRequestException", "TemplateContent must include {{verificationURL}}.", 400);
    return {
      name,
      fromEmailAddress,
      templateSubject,
      templateContent,
      successRedirectionUrl: this.safeWebUrl(input.SuccessRedirectionURL ?? existing?.successRedirectionUrl, "SuccessRedirectionURL"),
      failureRedirectionUrl: this.safeWebUrl(input.FailureRedirectionURL ?? existing?.failureRedirectionUrl, "FailureRedirectionURL"),
    };
  }

  private async createCustomVerificationTemplate(input: any, family: Family, systemTagKeys: readonly string[] = []): Promise<Record<string, unknown>> {
    const desired = this.customVerificationInput(input, family);
    const tags = family === "ses-v2" ? tagsFrom(input.Tags, systemTagKeys) : {};
    return this.exclusive(async () => {
      if (this.state.customVerificationTemplates[desired.name]) throw new AwsError(family === "ses-v2" ? "AlreadyExistsException" : "CustomVerificationEmailTemplateAlreadyExists", `Custom verification template ${desired.name} already exists.`, 400);
      const now = this.clock.now();
      this.state.customVerificationTemplates[desired.name] = { ...desired, arn: this.customVerificationTemplateArn(desired.name), tags, createdAt: now, updatedAt: now };
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private getCustomVerificationTemplate(value: unknown, family: Family): Record<string, unknown> {
    const item = this.customVerificationTemplate(value, family);
    return { TemplateName: item.name, FromEmailAddress: item.fromEmailAddress, TemplateSubject: item.templateSubject, TemplateContent: item.templateContent, SuccessRedirectionURL: item.successRedirectionUrl, FailureRedirectionURL: item.failureRedirectionUrl };
  }

  private listCustomVerificationTemplates(input: any, family: Family): Record<string, unknown> {
    const operation = `${family}:ListCustomVerificationEmailTemplates`;
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = Math.max(1, Math.min(100, Number(input.PageSize ?? input.MaxResults ?? 10)));
    const all = Object.values(this.state.customVerificationTemplates).sort((a, b) => a.name.localeCompare(b.name));
    const page = all.slice(offset, offset + maximum);
    return {
      CustomVerificationEmailTemplates: page.map(item => ({ TemplateName: item.name, FromEmailAddress: item.fromEmailAddress, TemplateSubject: item.templateSubject, SuccessRedirectionURL: item.successRedirectionUrl, FailureRedirectionURL: item.failureRedirectionUrl })),
      ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}),
    };
  }

  private async updateCustomVerificationTemplate(input: any, family: Family): Promise<Record<string, unknown>> {
    const existing = this.customVerificationTemplate(input.TemplateName, family);
    const desired = this.customVerificationInput(input, family, existing);
    return this.exclusive(async () => {
      Object.assign(existing, desired, { updatedAt: this.clock.now() });
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async deleteCustomVerificationTemplate(value: unknown, family: Family): Promise<Record<string, unknown>> {
    const existing = this.customVerificationTemplate(value, family);
    return this.exclusive(async () => {
      delete this.state.customVerificationTemplates[existing.name];
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async sendCustomVerificationEmail(input: any, family: Family): Promise<Record<string, unknown>> {
    const template = this.customVerificationTemplate(input.TemplateName, family);
    const destination = parseMailboxAddress(String(input.EmailAddress ?? ""));
    const existing = this.state.identities[destination.normalized];
    if (!existing) await this.createIdentity(destination.address, {}, family, true, [], template);
    else if (!existing.verifiedForSendingStatus) await this.exclusive(async () => this.issueVerificationIntent(existing, template));
    else throw new AwsError(family === "ses-v2" ? "BadRequestException" : "AlreadyVerified", `${destination.address} is already verified.`, 400);
    const identity = this.state.identities[destination.normalized];
    const intent = identity?.activeVerificationIntentId ? this.state.verificationIntents[identity.activeVerificationIntentId] : undefined;
    return { MessageId: intent?.messageId };
  }

  private async verifyDomainIdentity(value: unknown): Promise<Record<string, unknown>> {
    const parsed = canonicalIdentity(String(value ?? ""));
    if (parsed.type !== "DOMAIN") throw new AwsError("InvalidParameterValue", "Domain is required.", 400);
    await this.createIdentity(parsed.original, {}, "ses-v1", true);
    return { VerificationToken: this.state.identities[parsed.canonical]?.verificationToken };
  }

  private async verifyDomainDkim(value: unknown): Promise<Record<string, unknown>> {
    const parsed = canonicalIdentity(String(value ?? ""));
    if (parsed.type !== "DOMAIN") throw new AwsError("InvalidParameterValue", "Domain is required.", 400);
    if (!this.state.identities[parsed.canonical]) await this.createIdentity(parsed.original, {}, "ses-v1", true);
    return { DkimTokens: this.state.identities[parsed.canonical].dkimTokens };
  }

  private identityForSetting(value: unknown, family: Family): SesIdentityState {
    const parsed = canonicalIdentity(String(value ?? ""));
    const identity = this.state.identities[parsed.canonical];
    if (!identity) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "IdentityDoesNotExist", `Identity ${parsed.original} does not exist.`, family === "ses-v2" ? 404 : 400);
    return identity;
  }

  private getIdentityDkimAttributes(input: any): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    for (const supplied of stringValues(input.Identities)) {
      let identity: SesIdentityState;
      try { identity = this.identityForSetting(supplied, "ses-v1"); } catch { continue; }
      attributes[supplied] = { DkimEnabled: identity.dkimSigningEnabled, DkimVerificationStatus: identity.dkimVerificationStatus === "SUCCESS" ? "Success" : "Pending", DkimTokens: identity.dkimTokens };
    }
    return { DkimAttributes: awsQueryMap(attributes) };
  }

  private async putIdentityDkim(input: any, family: Family): Promise<Record<string, unknown>> {
    const identity = this.identityForSetting(input.EmailIdentity ?? input.Identity, family);
    const enabled = booleanValue(input.SigningEnabled ?? input.DkimEnabled);
    return this.exclusive(async () => {
      identity.dkimSigningEnabled = enabled;
      identity.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async putIdentityDkimSigning(input: any): Promise<Record<string, unknown>> {
    const identity = this.identityForSetting(input.EmailIdentity, "ses-v2");
    const origin = String(input.SigningAttributesOrigin ?? "");
    if (origin === "EXTERNAL") throw new AwsError("BadRequestException", "BYODKIM private keys are not accepted by this local simulator.", 400);
    if (origin !== "AWS_SES") throw new AwsError("BadRequestException", "SigningAttributesOrigin must be AWS_SES.", 400);
    const length = input.NextSigningKeyLength ?? "RSA_2048_BIT";
    if (!["RSA_1024_BIT", "RSA_2048_BIT"].includes(length)) throw new AwsError("BadRequestException", "NextSigningKeyLength is invalid.", 400);
    return this.exclusive(async () => {
      identity.dkimSigningAttributesOrigin = "AWS_SES";
      identity.dkimNextSigningKeyLength = length;
      identity.dkimCurrentSigningKeyLength = length;
      identity.lastKeyGenerationTimestamp = this.clock.now();
      identity.updatedAt = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  private getIdentityMailFromAttributes(input: any): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    for (const supplied of stringValues(input.Identities)) {
      let identity: SesIdentityState;
      try { identity = this.identityForSetting(supplied, "ses-v1"); } catch { continue; }
      const value = identity.mailFromAttributes ?? { behaviorOnMxFailure: "USE_DEFAULT_VALUE", mailFromDomainStatus: "PENDING" as const };
      attributes[supplied] = {
        MailFromDomain: value.mailFromDomain,
        MailFromDomainStatus: value.mailFromDomainStatus === "SUCCESS" ? "Success" : "Pending",
        BehaviorOnMXFailure: value.behaviorOnMxFailure === "REJECT_MESSAGE" ? "RejectMessage" : "UseDefaultValue",
      };
    }
    return { MailFromDomainAttributes: awsQueryMap(attributes) };
  }

  private async putIdentityMailFrom(input: any, family: Family): Promise<Record<string, unknown>> {
    const identity = this.identityForSetting(input.EmailIdentity ?? input.Identity, family);
    const domain = input.MailFromDomain === undefined || input.MailFromDomain === "" ? undefined : canonicalIdentity(String(input.MailFromDomain)).canonical;
    const behavior = String(input.BehaviorOnMxFailure ?? input.BehaviorOnMXFailure ?? "USE_DEFAULT_VALUE").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    if (!["USE_DEFAULT_VALUE", "REJECT_MESSAGE"].includes(behavior)) throw new AwsError(family === "ses-v2" ? "BadRequestException" : "InvalidParameterValue", "BehaviorOnMxFailure is invalid.", 400);
    if (domain && identity.identityType === "DOMAIN" && domain !== identity.canonicalIdentity && !domain.endsWith(`.${identity.canonicalIdentity}`)) throw new AwsError("MailFromDomainNotVerified", "MAIL FROM domain must be the identity domain or one of its subdomains.", 400);
    return this.exclusive(async () => {
      identity.mailFromAttributes = { ...(domain ? { mailFromDomain: domain } : {}), behaviorOnMxFailure: behavior as any, mailFromDomainStatus: domain ? "SUCCESS" : "PENDING" };
      identity.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private getIdentityNotificationAttributes(input: any): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    for (const supplied of stringValues(input.Identities)) {
      let identity: SesIdentityState;
      try { identity = this.identityForSetting(supplied, "ses-v1"); } catch { continue; }
      attributes[supplied] = {
        ForwardingEnabled: identity.feedbackForwardingStatus ?? true,
        HeadersInBounceNotificationsEnabled: identity.headersInNotificationsEnabled ?? false,
        HeadersInComplaintNotificationsEnabled: identity.headersInNotificationsEnabled ?? false,
        HeadersInDeliveryNotificationsEnabled: identity.headersInNotificationsEnabled ?? false,
        BounceTopic: identity.notificationTopics?.Bounce,
        ComplaintTopic: identity.notificationTopics?.Complaint,
        DeliveryTopic: identity.notificationTopics?.Delivery,
      };
    }
    return { NotificationAttributes: awsQueryMap(attributes) };
  }

  private async putIdentityFeedback(input: any, operation: string): Promise<Record<string, unknown>> {
    const identity = this.identityForSetting(input.EmailIdentity ?? input.Identity, operation.startsWith("Put") ? "ses-v2" : "ses-v1");
    return this.exclusive(async () => {
      if (operation === "SetIdentityFeedbackForwardingEnabled" || operation === "PutEmailIdentityFeedbackAttributes") identity.feedbackForwardingStatus = booleanValue(input.EmailForwardingEnabled ?? input.ForwardingEnabled);
      if (operation === "SetIdentityHeadersInNotificationsEnabled") identity.headersInNotificationsEnabled = booleanValue(input.Enabled);
      if (operation === "SetIdentityNotificationTopic") {
        const type = String(input.NotificationType);
        if (!["Bounce", "Complaint", "Delivery"].includes(type)) throw new AwsError("InvalidParameterValue", "NotificationType is invalid.", 400);
        identity.notificationTopics ??= {};
        if (input.SnsTopic === undefined || input.SnsTopic === "") delete identity.notificationTopics[type as "Bounce"]; else throw new AwsError("InvalidParameterValue", "SNS notification destinations require the later SNS email/event integration phase.", 400);
      }
      identity.updatedAt = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  private policyDocument(value: unknown): string {
    const source = typeof value === "string" ? value : JSON.stringify(value);
    if (Buffer.byteLength(source) > 4_096) throw new AwsError("BadRequestException", "Policy exceeds 4 KB.", 400);
    let parsed: any;
    try { parsed = JSON.parse(source); } catch { throw new AwsError("BadRequestException", "Policy must be valid JSON.", 400); }
    if (!parsed || !Array.isArray(parsed.Statement) && !parsed.Statement) throw new AwsError("BadRequestException", "Policy requires Statement.", 400);
    return JSON.stringify(parsed);
  }

  private async putIdentityPolicy(input: any, family: Family): Promise<Record<string, unknown>> {
    const identity = this.identityForSetting(input.EmailIdentity ?? input.Identity, family);
    const name = this.named(input.PolicyName, "PolicyName", 64);
    const policy = this.policyDocument(input.Policy);
    return this.exclusive(async () => {
      if (!Object.hasOwn(identity.policies, name) && Object.keys(identity.policies).length >= 20) throw new AwsError(family === "ses-v2" ? "LimitExceededException" : "LimitExceeded", "An identity can have at most 20 policies.", 400);
      identity.policies[name] = policy;
      identity.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private getIdentityPolicies(input: any, family: Family): Record<string, unknown> {
    const identity = this.identityForSetting(input.EmailIdentity ?? input.Identity, family);
    if (family === "ses-v2") return { Policies: { ...identity.policies } };
    const requested = stringValues(input.PolicyNames);
    return { Policies: awsQueryMap(Object.fromEntries(requested.filter(name => Object.hasOwn(identity.policies, name)).map(name => [name, identity.policies[name]]))) };
  }

  private listIdentityPolicies(input: any): Record<string, unknown> {
    const identity = this.identityForSetting(input.Identity, "ses-v1");
    return { PolicyNames: Object.keys(identity.policies).sort() };
  }

  private async deleteIdentityPolicy(input: any, family: Family): Promise<Record<string, unknown>> {
    const identity = this.identityForSetting(input.EmailIdentity ?? input.Identity, family);
    const name = this.named(input.PolicyName, "PolicyName");
    return this.exclusive(async () => {
      if (family === "ses-v2" && !Object.hasOwn(identity.policies, name)) throw new AwsError("NotFoundException", `Policy ${name} was not found.`, 404);
      delete identity.policies[name];
      identity.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private topicMap(value: unknown): Record<string, SesContactListState["topics"][string]> {
    const result: Record<string, SesContactListState["topics"][string]> = {};
    for (const item of values<any>(value)) {
      const topicName = this.named(item?.TopicName, "TopicName");
      if (Object.hasOwn(result, topicName)) throw new AwsError("BadRequestException", "Topic names must be unique.", 400);
      const status = String(item?.DefaultSubscriptionStatus ?? "");
      if (!["OPT_IN", "OPT_OUT"].includes(status)) throw new AwsError("BadRequestException", "DefaultSubscriptionStatus must be OPT_IN or OPT_OUT.", 400);
      if (typeof item?.DisplayName !== "string" || item.DisplayName.length > 128) throw new AwsError("BadRequestException", "DisplayName is required and must be at most 128 characters.", 400);
      result[topicName] = { topicName, displayName: item.DisplayName, ...(item?.Description === undefined ? {} : { description: String(item.Description).slice(0, 500) }), defaultSubscriptionStatus: status as "OPT_IN" };
    }
    if (Object.keys(result).length > 20) throw new AwsError("BadRequestException", "A contact list can have at most 20 topics.", 400);
    return result;
  }

  private contactList(value: unknown): SesContactListState {
    const name = this.named(value, "ContactListName");
    const list = this.state.contactLists[name];
    if (!list) throw new AwsError("NotFoundException", `Contact list ${name} was not found.`, 404);
    return list;
  }

  private async createContactList(input: any, systemTagKeys: readonly string[] = []): Promise<Record<string, unknown>> {
    const name = this.named(input.ContactListName, "ContactListName");
    const topics = this.topicMap(input.Topics);
    const tags = tagsFrom(input.Tags, systemTagKeys);
    return this.exclusive(async () => {
      if (this.state.contactLists[name]) throw new AwsError("AlreadyExistsException", `Contact list ${name} already exists.`, 400);
      const now = this.clock.now();
      this.state.contactLists[name] = { name, arn: this.contactListArn(name), ...(input.Description === undefined ? {} : { description: String(input.Description).slice(0, 500) }), topics, contacts: {}, tags, createdAt: now, updatedAt: now };
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private getContactList(value: unknown): Record<string, unknown> {
    const list = this.contactList(value);
    return { ContactListName: list.name, LastUpdatedTimestamp: epochSeconds(list.updatedAt), Description: list.description, Topics: Object.values(list.topics).map(topic => ({ TopicName: topic.topicName, DisplayName: topic.displayName, Description: topic.description, DefaultSubscriptionStatus: topic.defaultSubscriptionStatus })), Tags: Object.entries(list.tags).map(([Key, Value]) => ({ Key, Value })) };
  }

  private listContactLists(input: any): Record<string, unknown> {
    const operation = "ses-v2:ListContactLists";
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = Math.max(1, Math.min(100, Number(input.PageSize ?? 10)));
    const all = Object.values(this.state.contactLists).sort((a, b) => a.name.localeCompare(b.name));
    const page = all.slice(offset, offset + maximum);
    return { ContactLists: page.map(list => ({ ContactListName: list.name, LastUpdatedTimestamp: epochSeconds(list.updatedAt) })), ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}) };
  }

  private async updateContactList(input: any): Promise<Record<string, unknown>> {
    const list = this.contactList(input.ContactListName);
    const topics = input.Topics === undefined ? list.topics : this.topicMap(input.Topics);
    return this.exclusive(async () => {
      if (input.Description === undefined) delete list.description; else list.description = String(input.Description).slice(0, 500);
      list.topics = topics;
      for (const contact of Object.values(list.contacts)) for (const topic of Object.keys(contact.topicPreferences)) if (!topics[topic]) delete contact.topicPreferences[topic];
      list.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async deleteContactList(value: unknown): Promise<Record<string, unknown>> {
    const list = this.contactList(value);
    return this.exclusive(async () => {
      delete this.state.contactLists[list.name];
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private contactPreferences(list: SesContactListState, value: unknown): Record<string, "OPT_IN" | "OPT_OUT"> {
    const result: Record<string, "OPT_IN" | "OPT_OUT"> = {};
    for (const item of values<any>(value)) {
      const name = String(item?.TopicName ?? "");
      if (!list.topics[name]) throw new AwsError("BadRequestException", `Topic ${name} does not exist in contact list ${list.name}.`, 400);
      const status = String(item?.SubscriptionStatus ?? "");
      if (!["OPT_IN", "OPT_OUT"].includes(status)) throw new AwsError("BadRequestException", "SubscriptionStatus must be OPT_IN or OPT_OUT.", 400);
      result[name] = status as "OPT_IN";
    }
    return result;
  }

  private contactView(list: SesContactListState, emailValue: unknown): any {
    const email = parseMailboxAddress(String(emailValue ?? "")).normalized;
    const contact = list.contacts[email];
    if (!contact) throw new AwsError("NotFoundException", `Contact ${email} was not found.`, 404);
    return { ContactListName: list.name, EmailAddress: contact.emailAddress, TopicPreferences: Object.entries(contact.topicPreferences).map(([TopicName, SubscriptionStatus]) => ({ TopicName, SubscriptionStatus })), TopicDefaultPreferences: Object.values(list.topics).filter(topic => !Object.hasOwn(contact.topicPreferences, topic.topicName)).map(topic => ({ TopicName: topic.topicName, SubscriptionStatus: topic.defaultSubscriptionStatus })), UnsubscribeAll: contact.unsubscribeAll, AttributesData: contact.attributesData, CreatedTimestamp: epochSeconds(contact.createdAt), LastUpdatedTimestamp: epochSeconds(contact.updatedAt) };
  }

  private async createContact(input: any): Promise<Record<string, unknown>> {
    const list = this.contactList(input.ContactListName);
    const parsed = parseMailboxAddress(String(input.EmailAddress ?? ""));
    const preferences = this.contactPreferences(list, input.TopicPreferences);
    return this.exclusive(async () => {
      if (list.contacts[parsed.normalized]) throw new AwsError("AlreadyExistsException", `Contact ${parsed.address} already exists.`, 400);
      const now = this.clock.now();
      list.contacts[parsed.normalized] = { emailAddress: parsed.address, topicPreferences: preferences, unsubscribeAll: booleanValue(input.UnsubscribeAll), ...(input.AttributesData === undefined ? {} : { attributesData: String(input.AttributesData).slice(0, 65_536) }), createdAt: now, updatedAt: now };
      list.updatedAt = now;
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private getContact(input: any): Record<string, unknown> {
    return this.contactView(this.contactList(input.ContactListName), input.EmailAddress);
  }

  private listContacts(input: any): Record<string, unknown> {
    const list = this.contactList(input.ContactListName);
    const operation = `ses-v2:ListContacts:${list.name}`;
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = Math.max(1, Math.min(100, Number(input.PageSize ?? 10)));
    let all = Object.values(list.contacts).sort((a, b) => a.emailAddress.localeCompare(b.emailAddress));
    const filter = input.Filter;
    if (filter?.FilteredStatus) {
      const wanted = String(filter.FilteredStatus);
      all = all.filter(contact => filter.TopicFilter?.TopicName ? (contact.topicPreferences[filter.TopicFilter.TopicName] ?? list.topics[filter.TopicFilter.TopicName]?.defaultSubscriptionStatus) === wanted : (contact.unsubscribeAll ? "OPT_OUT" : "OPT_IN") === wanted);
    }
    const page = all.slice(offset, offset + maximum);
    return { Contacts: page.map(contact => ({ EmailAddress: contact.emailAddress, TopicPreferences: Object.entries(contact.topicPreferences).map(([TopicName, SubscriptionStatus]) => ({ TopicName, SubscriptionStatus })), UnsubscribeAll: contact.unsubscribeAll, LastUpdatedTimestamp: epochSeconds(contact.updatedAt) })), ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}) };
  }

  private async updateContact(input: any): Promise<Record<string, unknown>> {
    const list = this.contactList(input.ContactListName);
    const parsed = parseMailboxAddress(String(input.EmailAddress ?? ""));
    const contact = list.contacts[parsed.normalized];
    if (!contact) throw new AwsError("NotFoundException", `Contact ${parsed.address} was not found.`, 404);
    const preferences = input.TopicPreferences === undefined ? contact.topicPreferences : this.contactPreferences(list, input.TopicPreferences);
    return this.exclusive(async () => {
      contact.topicPreferences = preferences;
      contact.unsubscribeAll = booleanValue(input.UnsubscribeAll);
      if (input.AttributesData === undefined) delete contact.attributesData; else contact.attributesData = String(input.AttributesData).slice(0, 65_536);
      contact.updatedAt = list.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async deleteContact(input: any): Promise<Record<string, unknown>> {
    const list = this.contactList(input.ContactListName);
    const email = parseMailboxAddress(String(input.EmailAddress ?? "")).normalized;
    if (!list.contacts[email]) throw new AwsError("NotFoundException", `Contact ${email} was not found.`, 404);
    return this.exclusive(async () => {
      delete list.contacts[email];
      list.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async putAccountDetails(input: any): Promise<Record<string, unknown>> {
    const mailType = String(input.MailType ?? "");
    const language = String(input.ContactLanguage ?? "EN");
    if (!["MARKETING", "TRANSACTIONAL"].includes(mailType) || !["EN", "JA"].includes(language)) throw new AwsError("BadRequestException", "MailType or ContactLanguage is invalid.", 400);
    const websiteUrl = this.safeWebUrl(input.WebsiteURL, "WebsiteURL");
    const contacts = stringValues(input.AdditionalContactEmailAddresses);
    for (const contact of contacts) parseMailboxAddress(contact);
    return this.exclusive(async () => {
      this.state.account.details = { mailType: mailType as "MARKETING", websiteUrl, contactLanguage: language as "EN", additionalContactEmailAddresses: contacts, reviewDetails: { status: "GRANTED" } };
      this.state.account.productionAccessEnabled = true;
      await this.store.save();
      return {};
    });
  }

  private suppressionReasons(value: unknown): Array<"BOUNCE" | "COMPLAINT"> {
    const reasons = stringValues(value);
    if (reasons.some(reason => !["BOUNCE", "COMPLAINT"].includes(reason)) || new Set(reasons).size !== reasons.length) throw new AwsError("BadRequestException", "SuppressedReasons may contain BOUNCE and COMPLAINT.", 400);
    return reasons as Array<"BOUNCE">;
  }

  private async putAccountSuppression(input: any): Promise<Record<string, unknown>> {
    const reasons = this.suppressionReasons(input.SuppressedReasons);
    return this.exclusive(async () => {
      this.state.account.suppressionReasons = reasons;
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async putSuppressedDestination(input: any): Promise<Record<string, unknown>> {
    const parsed = parseMailboxAddress(String(input.EmailAddress ?? ""));
    const reason = String(input.Reason ?? "");
    if (!["BOUNCE", "COMPLAINT"].includes(reason)) throw new AwsError("BadRequestException", "Reason must be BOUNCE or COMPLAINT.", 400);
    return this.exclusive(async () => {
      this.state.suppressedDestinations[parsed.normalized] = { emailAddress: parsed.address, reason: reason as "BOUNCE", lastUpdateTime: this.clock.now() };
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private suppressedDestination(value: unknown) {
    const parsed = parseMailboxAddress(String(value ?? ""));
    const destination = this.state.suppressedDestinations[parsed.normalized];
    if (!destination) throw new AwsError("NotFoundException", `Suppressed destination ${parsed.address} was not found.`, 404);
    return destination;
  }

  private getSuppressedDestination(value: unknown): Record<string, unknown> {
    const destination = this.suppressedDestination(value);
    return { SuppressedDestination: { EmailAddress: destination.emailAddress, Reason: destination.reason, LastUpdateTime: epochSeconds(destination.lastUpdateTime), Attributes: destination.attributes } };
  }

  private listSuppressedDestinations(input: any): Record<string, unknown> {
    const operation = "ses-v2:ListSuppressedDestinations";
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = Math.max(1, Math.min(1_000, Number(input.PageSize ?? 1_000)));
    const reasons = this.suppressionReasons(input.Reasons);
    const start = input.StartDate === undefined ? -Infinity : wireTime(input.StartDate);
    const end = input.EndDate === undefined ? Infinity : wireTime(input.EndDate);
    const all = Object.values(this.state.suppressedDestinations).filter(item => (!reasons.length || reasons.includes(item.reason)) && item.lastUpdateTime >= start && item.lastUpdateTime <= end).sort((a, b) => a.emailAddress.localeCompare(b.emailAddress));
    const page = all.slice(offset, offset + maximum);
    return { SuppressedDestinationSummaries: page.map(item => ({ EmailAddress: item.emailAddress, Reason: item.reason, LastUpdateTime: epochSeconds(item.lastUpdateTime) })), ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}) };
  }

  private async deleteSuppressedDestination(value: unknown): Promise<Record<string, unknown>> {
    const destination = this.suppressedDestination(value);
    return this.exclusive(async () => {
      delete this.state.suppressedDestinations[normalizeMailboxKey(destination.emailAddress)];
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async createConfigurationSet(input: any, family: Family, systemTagKeys: readonly string[] = []): Promise<Record<string, unknown>> {
    const meaningfulUnsupported = ["VdmOptions", "ArchivingOptions"].filter(key => input[key] !== undefined);
    if (meaningfulUnsupported.length) throw new AwsError(family === "ses-v2" ? "BadRequestException" : "InvalidParameterValue", `Configuration options ${meaningfulUnsupported.join(", ")} require a later SES phase.`, 400);
    const name = configurationSetName(family === "ses-v1" ? input.ConfigurationSet?.Name : input.ConfigurationSetName);
    const tags = family === "ses-v2" ? tagsFrom(input.Tags, systemTagKeys) : {};
    return this.exclusive(async () => {
      if (this.state.configurationSets[name]) throw new AwsError(family === "ses-v2" ? "AlreadyExistsException" : "ConfigurationSetAlreadyExists", `Configuration set ${name} already exists.`, 400);
      if (Object.keys(this.state.configurationSets).length >= CONFIGURATION_SET_LIMIT) throw new AwsError(family === "ses-v2" ? "LimitExceededException" : "LimitExceeded", "The regional configuration-set limit has been reached.", 400);
      const now = this.clock.now();
      const delivery = input.DeliveryOptions;
      if (delivery?.SendingPoolName !== undefined) throw new AwsError("BadRequestException", "Dedicated delivery pools are not available locally.", 400);
      this.state.configurationSets[name] = {
        name,
        arn: this.configurationSetArn(name),
        sendingEnabled: family === "ses-v2" ? booleanValue(input.SendingOptions?.SendingEnabled, true) : true,
        ...(delivery ? { deliveryOptions: { ...(delivery.TlsPolicy ? { tlsPolicy: delivery.TlsPolicy } : {}), ...(delivery.MaxDeliverySeconds === undefined ? {} : { maxDeliverySeconds: Number(delivery.MaxDeliverySeconds) }) } } : {}),
        reputationOptions: { reputationMetricsEnabled: booleanValue(input.ReputationOptions?.ReputationMetricsEnabled) },
        suppressionOptions: { suppressedReasons: this.suppressionReasons(input.SuppressionOptions?.SuppressedReasons) },
        ...(input.TrackingOptions ? { trackingOptions: this.trackingOptions(input.TrackingOptions) } : {}),
        eventDestinations: {},
        tags,
        createdAt: now,
        updatedAt: now,
      };
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private configurationSetOrThrow(value: unknown, family: Family): SesConfigurationSetState {
    const name = configurationSetName(value);
    const configuration = this.state.configurationSets[name];
    if (!configuration) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "ConfigurationSetDoesNotExist", `Configuration set ${name} does not exist.`, family === "ses-v2" ? 404 : 400);
    return configuration;
  }

  private describeConfigurationSet(input: any): Record<string, unknown> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, "ses-v1");
    const requested = new Set(stringValues(input.ConfigurationSetAttributeNames));
    const all = !requested.size;
    return {
      ConfigurationSet: { Name: configuration.name },
      ...(all || requested.has("eventDestinations") ? { EventDestinations: Object.values(configuration.eventDestinations ?? {}).map(item => this.eventDestinationView(item, "ses-v1")) } : {}),
      ...(all || requested.has("trackingOptions") ? { TrackingOptions: configuration.trackingOptions ? { CustomRedirectDomain: configuration.trackingOptions.customRedirectDomain } : undefined } : {}),
      ...(all || requested.has("reputationOptions") ? { ReputationOptions: { SendingEnabled: configuration.reputationOptions?.reputationMetricsEnabled ?? false, ReputationMetricsEnabled: configuration.reputationOptions?.reputationMetricsEnabled ?? false } } : {}),
      ...(all || requested.has("deliveryOptions") ? { DeliveryOptions: { TlsPolicy: configuration.deliveryOptions?.tlsPolicy, MaxDeliverySeconds: configuration.deliveryOptions?.maxDeliverySeconds } } : {}),
    };
  }

  private getConfigurationSet(value: unknown): Record<string, unknown> {
    const configuration = this.configurationSetOrThrow(value, "ses-v2");
    return {
      ConfigurationSetName: configuration.name,
      SendingOptions: { SendingEnabled: configuration.sendingEnabled },
      DeliveryOptions: configuration.deliveryOptions && { TlsPolicy: configuration.deliveryOptions.tlsPolicy, MaxDeliverySeconds: configuration.deliveryOptions.maxDeliverySeconds },
      ReputationOptions: { ReputationMetricsEnabled: configuration.reputationOptions?.reputationMetricsEnabled ?? false, LastFreshStart: configuration.reputationOptions?.lastFreshStart && epochSeconds(configuration.reputationOptions.lastFreshStart) },
      SuppressionOptions: { SuppressedReasons: configuration.suppressionOptions?.suppressedReasons ?? [] },
      TrackingOptions: configuration.trackingOptions && { CustomRedirectDomain: configuration.trackingOptions.customRedirectDomain, HttpsPolicy: configuration.trackingOptions.httpsPolicy },
      Tags: Object.entries(configuration.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })),
    };
  }

  private listConfigurationSets(input: any, family: Family): Record<string, unknown> {
    const operation = `${family}:ListConfigurationSets`;
    const offset = safeDecodeToken(this.tokens, operation, input.NextToken);
    const maximum = family === "ses-v2" ? input.PageSize === undefined ? 1_000 : Math.max(1, Math.min(1_000, Number(input.PageSize))) : input.MaxItems === undefined ? 1_000 : Math.max(1, Math.min(1_000, Number(input.MaxItems)));
    const all = Object.values(this.state.configurationSets).sort((left, right) => left.name.localeCompare(right.name));
    const page = all.slice(offset, offset + maximum);
    return {
      ConfigurationSets: family === "ses-v1" ? page.map(configuration => ({ Name: configuration.name })) : page.map(configuration => configuration.name),
      ...(offset + page.length < all.length ? { NextToken: this.tokens.encode(operation, { offset: offset + page.length }) } : {}),
    };
  }

  private async deleteConfigurationSet(value: unknown, family: Family): Promise<Record<string, unknown>> {
    const name = configurationSetName(value);
    return this.exclusive(async () => {
      this.configurationSetOrThrow(name, family);
      const referenced = Object.values(this.state.identities).find(identity => identity.defaultConfigurationSetName === name);
      if (referenced) throw new AwsError(family === "ses-v2" ? "ConflictException" : "CannotDelete", `Configuration set ${name} is the default for identity ${referenced.identity}.`, 409);
      delete this.state.configurationSets[name];
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async putConfigurationSetSending(value: unknown, enabled: boolean, family: Family): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const configuration = this.configurationSetOrThrow(value, family);
      if (configuration.sendingEnabled !== enabled) {
        configuration.sendingEnabled = enabled;
        configuration.updatedAt = this.clock.now();
        this.state.controlRevision += 1;
        await this.store.save();
      }
      return {};
    });
  }

  private trackingOptions(input: any): NonNullable<SesConfigurationSetState["trackingOptions"]> {
    const custom = input.CustomRedirectDomain === undefined || input.CustomRedirectDomain === "" ? undefined : canonicalIdentity(String(input.CustomRedirectDomain)).canonical;
    const policy = input.HttpsPolicy === undefined ? "OPTIONAL" : String(input.HttpsPolicy);
    if (!["REQUIRE", "REQUIRE_OPEN_ONLY", "OPTIONAL"].includes(policy)) throw new AwsError("BadRequestException", "HttpsPolicy is invalid.", 400);
    return { ...(custom ? { customRedirectDomain: custom } : {}), httpsPolicy: policy as "OPTIONAL" };
  }

  private eventDestinationView(destination: SesConfigurationSetEventDestinationState, family: Family): any {
    const base = { Name: destination.name, Enabled: destination.enabled, MatchingEventTypes: destination.matchingEventTypes };
    return family === "ses-v1"
      ? { ...base, CloudWatchDestination: destination.cloudWatchDestination && { DimensionConfigurations: destination.cloudWatchDestination.dimensionConfigurations.map(item => ({ DimensionName: item.dimensionName, DimensionValueSource: item.dimensionValueSource === "MESSAGE_TAG" ? "messageTag" : item.dimensionValueSource === "EMAIL_HEADER" ? "emailHeader" : "linkTag", DefaultDimensionValue: item.defaultDimensionValue })) }, EventBridgeDestination: destination.eventBridgeDestination && {} }
      : { ...base, CloudWatchDestination: destination.cloudWatchDestination && { DimensionConfigurations: destination.cloudWatchDestination.dimensionConfigurations.map(item => ({ DimensionName: item.dimensionName, DimensionValueSource: item.dimensionValueSource, DefaultDimensionValue: item.defaultDimensionValue })) }, EventBridgeDestination: destination.eventBridgeDestination && { EventBusArn: destination.eventBridgeDestination.eventBusArn } };
  }

  private eventDestinationInput(input: any, family: Family, existing?: SesConfigurationSetEventDestinationState, resourceId?: string): SesConfigurationSetEventDestinationState {
    const body = family === "ses-v1" ? input.EventDestination ?? {} : input.EventDestination ?? input;
    const name = this.named(input.EventDestinationName ?? body.Name ?? existing?.name, "EventDestinationName");
    const enabled = booleanValue(body.Enabled, true);
    const matching = stringValues(body.MatchingEventTypes).map(type => String(type).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase());
    const supported = new Set(["SEND", "REJECT", "RENDERING_FAILURE", "BOUNCE", "CLICK"]);
    if (!matching.length || matching.some(type => !supported.has(type))) throw new AwsError(family === "ses-v2" ? "BadRequestException" : "InvalidParameterValue", "MatchingEventTypes contains an unsupported event type.", 400);
    const branches = ["CloudWatchDestination", "EventBridgeDestination", "SnsDestination", "KinesisFirehoseDestination", "PinpointDestination"].filter(key => body[key] !== undefined);
    if (branches.length !== 1) throw new AwsError(family === "ses-v2" ? "BadRequestException" : "InvalidParameterValue", "An event destination requires exactly one destination branch.", 400);
    if (!["CloudWatchDestination", "EventBridgeDestination"].includes(branches[0])) throw new AwsError("BadRequestException", `${branches[0]} is not backed by a local service integration.`, 400);
    const now = this.clock.now();
    if (body.CloudWatchDestination) {
      const dimensions = values<any>(body.CloudWatchDestination.DimensionConfigurations);
      if (!dimensions.length || dimensions.length > 10) throw new AwsError("BadRequestException", "CloudWatch destinations require 1-10 dimensions.", 400);
      return {
        resourceId: existing?.resourceId ?? resourceId ?? randomUUID(), name, enabled, matchingEventTypes: [...new Set(matching)],
        cloudWatchDestination: { dimensionConfigurations: dimensions.map(item => {
          const source = String(item.DimensionValueSource ?? "").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
          if (!["MESSAGE_TAG", "EMAIL_HEADER", "LINK_TAG"].includes(source)) throw new AwsError("BadRequestException", "DimensionValueSource is invalid.", 400);
          return { dimensionName: this.named(item.DimensionName, "DimensionName", 256), dimensionValueSource: source as "MESSAGE_TAG", defaultDimensionValue: String(item.DefaultDimensionValue ?? "").slice(0, 256) };
        }) },
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
    }
    const eventBusArn = family === "ses-v2" ? String(body.EventBridgeDestination.EventBusArn ?? "") : `arn:aws:events:${this.region}:${this.store.accountId}:event-bus/default`;
    const expected = `arn:aws:events:${this.region}:${this.store.accountId}:event-bus/default`;
    if (eventBusArn && eventBusArn !== expected) throw new AwsError("BadRequestException", "Only the same-account default EventBridge bus is supported.", 400);
    return { resourceId: existing?.resourceId ?? resourceId ?? randomUUID(), name, enabled, matchingEventTypes: [...new Set(matching)], eventBridgeDestination: { eventBusArn: expected }, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }

  private async putConfigurationSetEventDestination(input: any, family: Family, create: boolean, resourceId?: string): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, family);
    configuration.eventDestinations ??= {};
    const tentativeName = input.EventDestinationName ?? input.EventDestination?.Name;
    const existing = tentativeName ? configuration.eventDestinations[String(tentativeName)] : undefined;
    const desired = this.eventDestinationInput(input, family, existing, resourceId);
    if (create && configuration.eventDestinations[desired.name]) throw new AwsError(family === "ses-v2" ? "AlreadyExistsException" : "EventDestinationAlreadyExists", `Event destination ${desired.name} already exists.`, 400);
    if (!create && !configuration.eventDestinations[desired.name]) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "EventDestinationDoesNotExist", `Event destination ${desired.name} does not exist.`, family === "ses-v2" ? 404 : 400);
    return this.exclusive(async () => {
      configuration.eventDestinations![desired.name] = desired;
      configuration.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private getConfigurationSetEventDestinations(value: unknown): Record<string, unknown> {
    const configuration = this.configurationSetOrThrow(value, "ses-v2");
    return { EventDestinations: Object.values(configuration.eventDestinations ?? {}).sort((a, b) => a.name.localeCompare(b.name)).map(item => this.eventDestinationView(item, "ses-v2")) };
  }

  configurationEventDestination(configurationSetName: string, resourceId: string): { name: string; view: Record<string, unknown> } | undefined {
    const configuration = this.state.configurationSets[configurationSetName];
    const item = Object.values(configuration?.eventDestinations ?? {}).find(candidate => candidate.resourceId === resourceId);
    return item ? { name: item.name, view: this.eventDestinationView(item, "ses-v2") } : undefined;
  }

  private async deleteConfigurationSetEventDestination(input: any, family: Family): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, family);
    const name = this.named(input.EventDestinationName, "EventDestinationName");
    if (!configuration.eventDestinations?.[name]) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "EventDestinationDoesNotExist", `Event destination ${name} does not exist.`, family === "ses-v2" ? 404 : 400);
    return this.exclusive(async () => {
      delete configuration.eventDestinations![name];
      configuration.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async putConfigurationSetTracking(input: any, family: Family, operation: string): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, family);
    if (operation === "CreateConfigurationSetTrackingOptions" && configuration.trackingOptions) throw new AwsError("TrackingOptionsAlreadyExists", "Tracking options already exist.", 400);
    if (operation === "UpdateConfigurationSetTrackingOptions" && !configuration.trackingOptions) throw new AwsError("TrackingOptionsDoesNotExist", "Tracking options do not exist.", 400);
    const desired = this.trackingOptions(input.TrackingOptions ?? input);
    return this.exclusive(async () => {
      configuration.trackingOptions = desired;
      configuration.updatedAt = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  private async deleteConfigurationSetTracking(value: unknown): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(value, "ses-v1");
    if (!configuration.trackingOptions) throw new AwsError("TrackingOptionsDoesNotExist", "Tracking options do not exist.", 400);
    return this.exclusive(async () => {
      delete configuration.trackingOptions;
      configuration.updatedAt = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  private async putConfigurationSetDelivery(input: any, family: Family): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, family);
    if (input.SendingPoolName !== undefined) throw new AwsError("BadRequestException", "Dedicated delivery pools are unavailable locally.", 400);
    const policy = input.TlsPolicy === undefined ? configuration.deliveryOptions?.tlsPolicy : String(input.TlsPolicy).toUpperCase();
    if (policy && !["REQUIRE", "OPTIONAL"].includes(policy)) throw new AwsError("BadRequestException", "TlsPolicy is invalid.", 400);
    const seconds = input.MaxDeliverySeconds === undefined ? configuration.deliveryOptions?.maxDeliverySeconds : Number(input.MaxDeliverySeconds);
    if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 300 || seconds > 50_400)) throw new AwsError("BadRequestException", "MaxDeliverySeconds is invalid.", 400);
    return this.exclusive(async () => {
      configuration.deliveryOptions = { ...(policy ? { tlsPolicy: policy as "REQUIRE" } : {}), ...(seconds === undefined ? {} : { maxDeliverySeconds: seconds }) };
      configuration.updatedAt = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  private async putConfigurationSetReputation(input: any, family: Family): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, family);
    const enabled = booleanValue(input.ReputationMetricsEnabled ?? input.Enabled);
    return this.exclusive(async () => {
      configuration.reputationOptions = { reputationMetricsEnabled: enabled, ...(enabled ? { lastFreshStart: this.clock.now() } : {}) };
      configuration.updatedAt = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  private async putConfigurationSetSuppression(input: any): Promise<Record<string, unknown>> {
    const configuration = this.configurationSetOrThrow(input.ConfigurationSetName, "ses-v2");
    const reasons = this.suppressionReasons(input.SuppressedReasons);
    return this.exclusive(async () => {
      configuration.suppressionOptions = { suppressedReasons: reasons };
      configuration.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private batchGetMetricData(input: any): Record<string, unknown> {
    const queries = values<any>(input.Queries);
    if (!queries.length || queries.length > 40) throw new AwsError("BadRequestException", "Queries must contain 1-40 metric queries.", 400);
    return {
      Results: queries.map(query => {
        const start = query.StartDate === undefined ? this.clock.now() - DAY : wireTime(query.StartDate);
        const end = query.EndDate === undefined ? this.clock.now() : wireTime(query.EndDate);
        const counts = this.mailbox.metricCounts(start, end);
        const metric = String(query.Metric ?? "SEND").toUpperCase();
        const supported = new Set(["SEND", "SEND_ATTEMPTS", "DELIVERY", "DELIVERY_ATTEMPTS", "CLICK", "BOUNCE", "PERMANENT_BOUNCE", "COMPLAINT", "OPEN", "REJECT", "RENDERING_FAILURE"]);
        if (!supported.has(metric)) throw new AwsError("BadRequestException", `Metric ${metric} is not available from local committed SES outcomes.`, 400);
        const value = metric === "SEND" || metric === "SEND_ATTEMPTS" ? counts.sends
          : metric === "DELIVERY" || metric === "DELIVERY_ATTEMPTS" ? counts.captured
          : metric === "BOUNCE" || metric === "PERMANENT_BOUNCE" ? counts.suppressedBounces
          : metric === "COMPLAINT" || metric === "OPEN" ? 0
          : metric === "CLICK" ? counts.clicks
          : metric === "REJECT" ? counts.suppressed
          : counts.renderingFailures;
        return { Id: String(query.Id ?? ""), Timestamps: [epochSeconds(end)], Values: [value] };
      }),
    };
  }

  private getMessageInsights(value: unknown): Record<string, unknown> {
    if (typeof value !== "string" || !value) throw new AwsError("BadRequestException", "MessageId is required.", 400);
    const message = this.mailbox.detail(value);
    if (!message) throw new AwsError("NotFoundException", `Message ${value} was not found.`, 404);
    const eventType = message.renderStatus === "FAILED" ? "RENDERING_FAILURE" : message.localDisposition === "SUPPRESSED" ? "REJECT" : "SEND";
    const events = [{
      Timestamp: epochSeconds(message.acceptedAt),
      Type: eventType,
      Details: {
        RenderStatus: message.renderStatus,
        LocalDisposition: message.localDisposition,
        OutcomeCode: message.outcomeCode,
        LocalCapture: message.localDisposition === "CAPTURED",
      },
    }, ...this.mailbox.localCallbackEvents(message.messageId).map((event: any) => ({
      Timestamp: epochSeconds(event.eventAt),
      Type: event.eventType === "LOCAL_CLICK_CALLBACK" ? "CLICK" : "SUBSCRIPTION",
      Details: { LocalCallback: true },
    }))];
    return {
      MessageId: message.messageId,
      FromEmailAddress: message.source,
      Subject: message.subject,
      EmailTags: Object.entries(message.messageTags).map(([Name, Value]) => ({ Name, Value })),
      Insights: message.recipients
        .filter((item: PreparedRecipient) => item.isEnvelope)
        .map((item: PreparedRecipient) => ({ Destination: item.address, Events: events })),
    };
  }

  private async putIdentityConfigurationSet(identityValue: unknown, configurationValue: unknown): Promise<Record<string, unknown>> {
    const identityKey = canonicalIdentity(String(identityValue ?? "")).canonical;
    return this.exclusive(async () => {
      const identity = this.state.identities[identityKey];
      if (!identity) throw new AwsError("NotFoundException", `Email identity ${String(identityValue)} does not exist.`, 404);
      if (configurationValue !== undefined && configurationValue !== null && configurationValue !== "") {
        const configuration = this.configurationSetOrThrow(configurationValue, "ses-v2");
        identity.defaultConfigurationSetName = configuration.name;
      } else delete identity.defaultConfigurationSetName;
      identity.updatedAt = this.clock.now();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private taggedResource(arnValue: unknown): { tags: Record<string, string>; touch: () => void } {
    if (typeof arnValue !== "string") throw new AwsError("BadRequestException", "ResourceArn is required.", 400);
    const prefix = `arn:aws:ses:${this.region}:${this.store.accountId}:`;
    if (!arnValue.startsWith(prefix)) throw new AwsError("BadRequestException", "The SES resource ARN does not belong to the configured account and Region.", 400);
    const resource = arnValue.slice(prefix.length);
    if (resource.startsWith("identity/")) {
      const key = canonicalIdentity(resource.slice("identity/".length)).canonical;
      const identity = this.state.identities[key];
      if (!identity) throw new AwsError("NotFoundException", "The SES identity resource was not found.", 404);
      return { tags: identity.tags, touch: () => { identity.updatedAt = this.clock.now(); } };
    }
    if (resource.startsWith("template/")) {
      const template = this.state.templates[resource.slice("template/".length)];
      if (!template) throw new AwsError("NotFoundException", "The SES template resource was not found.", 404);
      return { tags: template.tags, touch: () => { template.updatedAt = this.clock.now(); } };
    }
    if (resource.startsWith("configuration-set/")) {
      const configuration = this.state.configurationSets[resource.slice("configuration-set/".length)];
      if (!configuration) throw new AwsError("NotFoundException", "The SES configuration-set resource was not found.", 404);
      return { tags: configuration.tags, touch: () => { configuration.updatedAt = this.clock.now(); } };
    }
    if (resource.startsWith("custom-verification-email-template/")) {
      const item = this.state.customVerificationTemplates[resource.slice("custom-verification-email-template/".length)];
      if (!item) throw new AwsError("NotFoundException", "The custom verification template was not found.", 404);
      return { tags: item.tags, touch: () => { item.updatedAt = this.clock.now(); } };
    }
    if (resource.startsWith("contact-list/")) {
      const item = this.state.contactLists[resource.slice("contact-list/".length)];
      if (!item) throw new AwsError("NotFoundException", "The contact list was not found.", 404);
      return { tags: item.tags, touch: () => { item.updatedAt = this.clock.now(); } };
    }
    throw new AwsError("BadRequestException", "The SES resource ARN is not taggable in this implementation phase.", 400);
  }

  private async tagResource(arn: unknown, value: unknown): Promise<Record<string, unknown>> {
    const additions = tagsFrom(value);
    return this.exclusive(async () => {
      const resource = this.taggedResource(arn);
      const merged = { ...resource.tags, ...additions };
      if (Object.keys(merged).filter(key => !isCloudFormationSystemTag(key)).length > 50) throw new AwsError("BadRequestException", "A resource can have at most 50 user tags.", 400);
      Object.assign(resource.tags, additions);
      resource.touch();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private async untagResource(arn: unknown, value: unknown): Promise<Record<string, unknown>> {
    const keys = stringValues(value);
    if (!keys.length || keys.some(key => !key || key.length > 128)) throw new AwsError("BadRequestException", "TagKeys must contain at least one valid tag key.", 400);
    if (keys.some(isCloudFormationSystemTag)) throw new AwsError("BadRequestException", "CloudFormation ownership tags are protected.", 400);
    return this.exclusive(async () => {
      const resource = this.taggedResource(arn);
      for (const key of keys) delete resource.tags[key];
      resource.touch();
      this.state.controlRevision += 1;
      await this.store.save();
      return {};
    });
  }

  private listResourceTags(arn: unknown): Record<string, unknown> {
    const resource = this.taggedResource(arn);
    return { Tags: Object.entries(resource.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })) };
  }

  /** Resource tags used by the central IAM context enrichment. */
  resourceTags(arn: string): Record<string, string> {
    try { return { ...this.taggedResource(arn).tags }; } catch { return {}; }
  }

  resourcePolicies(arn: string): any[] {
    const prefix = `arn:aws:ses:${this.region}:${this.store.accountId}:identity/`;
    if (!arn.startsWith(prefix)) return [];
    let identity: SesIdentityState | undefined;
    try { identity = this.state.identities[canonicalIdentity(arn.slice(prefix.length)).canonical]; } catch { return []; }
    if (!identity) return [];
    return Object.values(identity.policies).flatMap(policy => {
      try { return [JSON.parse(policy)]; } catch { return []; }
    });
  }

  private sourceIdentity(sourceValue: string, family: Family): SesIdentityState {
    const source = parseMailboxAddress(sourceValue);
    const exact = this.state.identities[source.normalized];
    if (exact?.verifiedForSendingStatus) return exact;
    const domains = Object.values(this.state.identities)
      .filter(identity => identity.identityType === "DOMAIN" && identity.verifiedForSendingStatus)
      .sort((left, right) => right.canonicalIdentity.length - left.canonicalIdentity.length);
    const domain = source.domain.toLowerCase();
    const covering = domains.find(identity => domain === identity.canonicalIdentity || domain.endsWith(`.${identity.canonicalIdentity}`));
    if (covering) return covering;
    throw new AwsError("MessageRejected", `Email address is not verified. The following identities failed the check in region ${this.region}: ${source.address}`, 400);
  }

  /** Resolve the exact verified identity resource used for central IAM checks. */
  authorizationIdentityArn(sourceValue: unknown): string | undefined {
    if (typeof sourceValue !== "string") return undefined;
    try { return this.sourceIdentity(sourceValue, "ses-v2").arn; }
    catch { return undefined; }
  }

  private validateDelegatedIdentityArn(
    suppliedArn: unknown,
    addressValue: unknown,
    family: Family,
    fieldName: string,
  ): void {
    if (suppliedArn === undefined || suppliedArn === null || suppliedArn === "") return;
    if (typeof suppliedArn !== "string" || typeof addressValue !== "string" || !addressValue.trim()) {
      throw new AwsError(family === "ses-v2" ? "BadRequestException" : "InvalidParameterValue", `${fieldName} requires a matching email address and SES identity ARN.`, 400);
    }
    const identity = this.sourceIdentity(addressValue, family);
    if (suppliedArn !== identity.arn) {
      throw new AwsError("MessageRejected", `${fieldName} does not match the verified identity that authorizes the supplied email address.`, 400);
    }
  }

  private sendingConfiguration(source: string, requested: unknown, family: Family): string | undefined {
    if (!this.state.account.sendingEnabled) throw new AwsError(family === "ses-v2" ? "SendingPausedException" : "AccountSendingPaused", "Email sending is disabled for this account.", 400);
    const identity = this.sourceIdentity(source, family);
    const name = requested === undefined || requested === null || requested === "" ? identity.defaultConfigurationSetName : configurationSetName(requested);
    if (!name) return undefined;
    const configuration = this.state.configurationSets[name];
    if (!configuration) throw new AwsError(family === "ses-v2" ? "NotFoundException" : "ConfigurationSetDoesNotExist", `Configuration set ${name} does not exist.`, family === "ses-v2" ? 404 : 400);
    if (!configuration.sendingEnabled) throw new AwsError(family === "ses-v2" ? "SendingPausedException" : "ConfigurationSetSendingPaused", `Email sending is disabled for configuration set ${name}.`, 400);
    return name;
  }

  private assertSandboxRecipients(message: PreparedSesMessage): void {
    if (this.state.account.accessProfile !== "SANDBOX") return;
    for (const recipient of message.recipients.filter(candidate => candidate.isEnvelope)) {
      const parsed = parseMailboxAddress(recipient.address);
      if (parsed.domain.toLowerCase() === "simulator.amazonses.com") continue;
      const exact = this.state.identities[parsed.normalized];
      const covering = Object.values(this.state.identities).some(identity => identity.identityType === "DOMAIN" && identity.verifiedForSendingStatus && (parsed.domain.toLowerCase() === identity.canonicalIdentity || parsed.domain.toLowerCase().endsWith(`.${identity.canonicalIdentity}`)));
      if (!exact?.verifiedForSendingStatus && !covering) throw new AwsError("MessageRejected", `Email address is not verified. The following identities failed the check in region ${this.region}: ${parsed.address}`, 400);
    }
  }

  private mailboxFailure(error: unknown, family: Family): never {
    const code = (error as any)?.code;
    if (code === "QuotaExceeded") throw new AwsError(family === "ses-v2" ? "TooManyRequestsException" : "Throttling", "Maximum sending rate or 24-hour sending quota exceeded.", 429);
    if (error instanceof SesContentError) throw new AwsError(family === "ses-v2" ? "BadRequestException" : "MessageRejected", error.message, 400);
    if (code === "CapacityExceeded" || code === "StorageFailure" || code === "Closed") throw new AwsError(family === "ses-v2" ? "ServiceUnavailableException" : "ServiceUnavailable", "SES could not durably accept the message.", 503);
    if (error instanceof AwsError) throw error;
    throw new AwsError(family === "ses-v2" ? "InternalServiceErrorException" : "InternalFailure", error instanceof Error ? error.message : String(error), 500);
  }

  private async captureCustomerMessage(message: PreparedSesMessage, family: Family): Promise<Record<string, unknown>> {
    this.applySuppression(message);
    this.assertSandboxRecipients(message);
    const recipientOccurrences = message.recipients.filter(recipient => recipient.isEnvelope).length;
    const limits = this.effectiveQuotaLimits();
    try {
      this.mailbox.capture(message, {
        recipientOccurrences,
        quotaWindows: [
          { windowMs: DAY, maximumRecipients: Math.max(1, Math.floor(limits.max24HourSend)) },
          { windowMs: 1_000, maximumRecipients: Math.max(1, Math.floor(limits.maxSendRate)) },
        ],
        auditEventType: "ACCEPTED",
        auditDetail: { apiFamily: family, operation: message.operation, renderStatus: message.renderStatus, disposition: message.localDisposition },
        outbox: this.messageOutbox(message),
      });
      await this.drainEventOutbox();
      return { MessageId: message.messageId };
    } catch (error) {
      return this.mailboxFailure(error, family);
    }
  }

  private messageEventType(message: PreparedSesMessage): string {
    return message.renderStatus === "FAILED"
      ? "RENDERING_FAILURE"
      : message.outcomeCode === "SUPPRESSED_BOUNCE"
        ? "BOUNCE"
        : message.localDisposition === "SUPPRESSED"
          ? "REJECT"
          : "SEND";
  }

  private messageOutbox(message: PreparedSesMessage): import("./ses/model.js").PreparedOutboxRecord[] {
    if (!message.configurationSetName) return [];
    const configuration = this.state.configurationSets[message.configurationSetName];
    if (!configuration) return [];
    const eventType = this.messageEventType(message);
    const recipients = message.recipients.filter(item => item.isEnvelope).map(item => item.address);
    return Object.values(configuration.eventDestinations ?? {}).filter(destination => destination.enabled && destination.matchingEventTypes.includes(eventType)).sort((a, b) => a.name.localeCompare(b.name)).map((destination, eventOrdinal) => ({
      outboxId: createHash("sha256").update(`${message.messageId}\0${configuration.name}\0${destination.name}\0${eventType}`).digest("hex"),
      requestId: message.messageId,
      destinationId: `${configuration.name}:${destination.name}`,
      eventOrdinal,
      eventType,
      payload: {
        destination: this.eventDestinationView(destination, "ses-v2"),
        configurationSetName: configuration.name,
        message: {
          messageId: message.messageId,
          timestamp: new Date(message.acceptedAt).toISOString(),
          source: message.source,
          destination: recipients,
          subject: message.subject,
          tags: message.messageTags,
          renderStatus: message.renderStatus,
          localDisposition: message.localDisposition,
          outcomeCode: message.outcomeCode,
        },
      },
      createdAt: message.acceptedAt,
    }));
  }

  private async drainEventOutbox(): Promise<void> {
    if (this.drainingOutbox || !this.mailbox || (!this.metricPublisher && !this.eventPublisher)) return;
    this.drainingOutbox = true;
    try {
      for (;;) {
        const pending = this.mailbox.pendingOutbox(this.clock.now(), 100);
        if (!pending.length) break;
        for (const item of pending) {
          try {
            const payload = item.payload as any;
            const destination = payload.destination ?? {};
            if (destination.CloudWatchDestination) {
              if (!this.metricPublisher) throw new Error("CloudWatch metrics service is unavailable");
              const messageTags = payload.message?.tags ?? {};
              const dimensions = Object.fromEntries(values<any>(destination.CloudWatchDestination.DimensionConfigurations).map(dimension => [
                String(dimension.DimensionName),
                dimension.DimensionValueSource === "MESSAGE_TAG" ? String(messageTags[dimension.DimensionName] ?? dimension.DefaultDimensionValue) : String(dimension.DefaultDimensionValue),
              ]));
              await this.metricPublisher.publish({
                namespace: "AWS/SES",
                metricName: item.eventType === "RENDERING_FAILURE" ? "RenderingFailure" : item.eventType[0] + item.eventType.slice(1).toLowerCase(),
                timestamp: new Date(payload.message.timestamp).getTime(),
                value: 1,
                unit: "Count",
                dimensions,
              });
            } else if (destination.EventBridgeDestination) {
              if (!this.eventPublisher) throw new Error("EventBridge service is unavailable");
              await this.eventPublisher({ source: "aws.ses", detailType: "SES Email Event", detail: { eventType: item.eventType, mail: payload.message, configurationSet: payload.configurationSetName, localSimulation: true, deliveryId: item.outboxId }, resources: [this.configurationSetArn(payload.configurationSetName)], time: new Date(payload.message.timestamp).getTime(), eventBusName: "default", deliveryLineage: [this.configurationSetArn(payload.configurationSetName), item.outboxId] });
            } else throw new Error("The event destination is no longer supported");
            this.mailbox.completeOutbox(item.outboxId);
          } catch (error) {
            const attempts = item.attempts + 1;
            this.mailbox.retryOutbox(item.outboxId, attempts, this.clock.now() + Math.min(60_000, 250 * 2 ** Math.min(attempts, 8)), (error as any)?.code ?? (error as any)?.name ?? "DeliveryFailure");
          }
        }
        if (pending.some((item: any) => item.nextAttemptAt > this.clock.now())) break;
        if (this.mailbox.pendingOutbox(this.clock.now(), 1).length === pending.length) break;
      }
    } finally {
      this.drainingOutbox = false;
    }
  }

  private callbackOutbox(callback: import("./types.js").SesLocalCallbackState): import("./ses/model.js").PreparedOutboxRecord[] {
    if (callback.purpose !== "CLICK" || !callback.messageId) return [];
    const message = this.mailbox.detail(callback.messageId);
    if (!message?.configurationSetName) return [];
    const configuration = this.state.configurationSets[message.configurationSetName];
    if (!configuration) return [];
    const createdAt = callback.consumedAt ?? this.clock.now();
    return Object.values(configuration.eventDestinations ?? {})
      .filter(destination => destination.enabled && destination.matchingEventTypes.includes("CLICK"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((destination, eventOrdinal) => {
        const outboxId = createHash("sha256").update(`${callback.callbackId}\0${configuration.name}\0${destination.name}\0CLICK`).digest("hex");
        return {
          outboxId,
          requestId: callback.callbackId,
          destinationId: `${configuration.name}:${destination.name}`,
          eventOrdinal,
          eventType: "CLICK",
          payload: {
            destination: this.eventDestinationView(destination, "ses-v2"),
            configurationSetName: configuration.name,
            message: {
              messageId: message.messageId,
              timestamp: new Date(createdAt).toISOString(),
              source: message.source,
              destination: message.recipients.filter((item: PreparedRecipient) => item.isEnvelope).map((item: PreparedRecipient) => item.address),
              subject: message.subject,
              tags: message.messageTags,
              renderStatus: message.renderStatus,
              localDisposition: message.localDisposition,
            },
          },
          createdAt,
        };
      });
  }

  private applySuppression(message: PreparedSesMessage, listManagementOptions?: any): void {
    if (message.renderStatus !== "RENDERED") return;
    const suppressed: string[] = [];
    const configuration = message.configurationSetName ? this.state.configurationSets[message.configurationSetName] : undefined;
    const activeReasons = configuration?.suppressionOptions?.suppressedReasons?.length
      ? configuration.suppressionOptions.suppressedReasons
      : this.state.account.suppressionReasons ?? [];
    for (const recipient of message.recipients.filter(item => item.isEnvelope)) {
      const normalized = normalizeMailboxKey(recipient.address);
      const destination = this.state.suppressedDestinations[normalized];
      if (destination && activeReasons.includes(destination.reason)) suppressed.push(recipient.address);
      if (listManagementOptions) {
        const list = this.state.contactLists[String(listManagementOptions.ContactListName ?? "")];
        const contact = list?.contacts[normalized];
        const topic = listManagementOptions.TopicName === undefined ? undefined : String(listManagementOptions.TopicName);
        if (!list) throw new AwsError("NotFoundException", `Contact list ${String(listManagementOptions.ContactListName)} does not exist.`, 404);
        if (topic && !list.topics[topic]) throw new AwsError("BadRequestException", `Topic ${topic} does not exist.`, 400);
        const status = contact?.unsubscribeAll ? "OPT_OUT" : topic ? contact?.topicPreferences[topic] ?? list.topics[topic].defaultSubscriptionStatus : "OPT_IN";
        if (status === "OPT_OUT") suppressed.push(recipient.address);
      }
    }
    if (suppressed.length) {
      message.localDisposition = "SUPPRESSED";
      const bounce = suppressed.some(address => this.state.suppressedDestinations[normalizeMailboxKey(address)]?.reason === "BOUNCE");
      message.outcomeCode = bounce ? "SUPPRESSED_BOUNCE" : "SUPPRESSED";
      message.outcomeDetail = { recipients: [...new Set(suppressed)].join(",") };
    }
  }

  private localCallbackToken(callback: import("./types.js").SesLocalCallbackState, nonce: string): string {
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      accountId: this.store.accountId,
      region: this.region,
      callbackId: callback.callbackId,
      purpose: callback.purpose,
      expiresAt: callback.expiresAt,
      nonce,
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", Buffer.from(this.store.state.installation.sesSigningSecret, "base64"))
      .update(`stacksim:ses:callback:v1:${payload}`)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private verifyLocalCallbackToken(token: string, expectedPurpose: import("./types.js").SesLocalCallbackState["purpose"]): import("./types.js").SesLocalCallbackState | undefined {
    const [encoded, suppliedMac, extra] = token.split(".");
    if (!encoded || !suppliedMac || extra !== undefined) return undefined;
    const expectedMac = createHmac("sha256", Buffer.from(this.store.state.installation.sesSigningSecret, "base64"))
      .update(`stacksim:ses:callback:v1:${encoded}`)
      .digest();
    let actualMac: Buffer;
    try { actualMac = Buffer.from(suppliedMac, "base64url"); } catch { return undefined; }
    if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) return undefined;
    let payload: any;
    try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return undefined; }
    if (payload?.v !== 1 || payload.accountId !== this.store.accountId || payload.region !== this.region || payload.purpose !== expectedPurpose || typeof payload.callbackId !== "string" || typeof payload.nonce !== "string" || typeof payload.expiresAt !== "number") return undefined;
    const callback = this.state.localCallbacks[payload.callbackId];
    if (!callback || callback.purpose !== expectedPurpose || callback.expiresAt !== payload.expiresAt || callback.expiresAt <= this.clock.now() || callback.consumedAt !== undefined) return undefined;
    if (createHash("sha256").update(payload.nonce).digest("base64url") !== callback.nonceDigest) return undefined;
    return callback;
  }

  private issueLocalCallback(
    purpose: import("./types.js").SesLocalCallbackState["purpose"],
    fields: Omit<import("./types.js").SesLocalCallbackState, "callbackId" | "purpose" | "nonceDigest" | "issuedAt" | "expiresAt">,
  ): { callbackId: string; url: string } {
    if (!this.publicBaseUrl) throw new AwsError("ServiceUnavailableException", "SES local callback links are unavailable until the control listener has bound.", 503);
    const now = this.clock.now();
    const callbacks = Object.values(this.state.localCallbacks).sort((left, right) => left.issuedAt - right.issuedAt || left.callbackId.localeCompare(right.callbackId));
    for (const candidate of callbacks) {
      if (candidate.expiresAt <= now || candidate.consumedAt !== undefined && candidate.consumedAt + DAY <= now) delete this.state.localCallbacks[candidate.callbackId];
    }
    const remaining = Object.values(this.state.localCallbacks).sort((left, right) => left.issuedAt - right.issuedAt || left.callbackId.localeCompare(right.callbackId));
    while (remaining.length >= 10_000) delete this.state.localCallbacks[remaining.shift()!.callbackId];
    const nonce = randomBytes(24).toString("base64url");
    const callback: import("./types.js").SesLocalCallbackState = {
      callbackId: randomUUID(),
      purpose,
      nonceDigest: createHash("sha256").update(nonce).digest("base64url"),
      issuedAt: now,
      expiresAt: now + LOCAL_CALLBACK_TTL,
      ...fields,
    };
    this.state.localCallbacks[callback.callbackId] = callback;
    const token = this.localCallbackToken(callback, nonce);
    return {
      callbackId: callback.callbackId,
      url: `${this.publicBaseUrl}/_stacksim/ses/callback/${encodeURIComponent(this.region)}/${purpose.toLowerCase()}?token=${encodeURIComponent(token)}`,
    };
  }

  private prepareLocalCallbacks(message: PreparedSesMessage, listManagementOptions?: any): string[] {
    if (message.renderStatus !== "RENDERED" || message.localDisposition !== "CAPTURED") return [];
    const callbackIds: string[] = [];
    const tracking = message.configurationSetName ? this.state.configurationSets[message.configurationSetName]?.trackingOptions : undefined;
    if (tracking && message.htmlBody) {
      message.htmlBody = message.htmlBody.replace(/href=(["'])(https?:\/\/[^"'<>]+)\1/gi, (whole, quote: string, destination: string) => {
        let safe: string;
        try { safe = this.safeWebUrl(destination, "tracked link"); } catch { return whole; }
        if (safe.startsWith(`${this.publicBaseUrl}/_stacksim/ses/`)) return whole;
        const callback = this.issueLocalCallback("CLICK", { destinationUrl: safe, messageId: message.messageId });
        callbackIds.push(callback.callbackId);
        return `href=${quote}${escapeHtml(callback.url)}${quote}`;
      });
    }
    if (listManagementOptions !== undefined) {
      const list = this.state.contactLists[String(listManagementOptions.ContactListName ?? "")];
      const topicName = listManagementOptions.TopicName === undefined ? undefined : String(listManagementOptions.TopicName);
      if (!list) throw new AwsError("NotFoundException", `Contact list ${String(listManagementOptions.ContactListName)} does not exist.`, 404);
      if (topicName && !list.topics[topicName]) throw new AwsError("BadRequestException", `Topic ${topicName} does not exist.`, 400);
      const recipients = message.recipients.filter(recipient => recipient.isEnvelope);
      if (recipients.length !== 1) throw new AwsError("BadRequestException", "ListManagementOptions requires exactly one envelope recipient.", 400);
      const emailAddress = parseMailboxAddress(recipients[0].address).address;
      const callback = this.issueLocalCallback("UNSUBSCRIBE", {
        contactListName: list.name,
        ...(topicName ? { topicName } : {}),
        emailAddress,
        messageId: message.messageId,
      });
      callbackIds.push(callback.callbackId);
      message.headers.push({ name: "List-Unsubscribe", value: `<${callback.url}>` });
      message.headers.push({ name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" });
      message.textBody = `${message.textBody ?? ""}${message.textBody ? "\n\n" : ""}Unsubscribe: ${callback.url}`;
      message.htmlBody = `${message.htmlBody ?? ""}<p><a href="${escapeHtml(callback.url)}">Unsubscribe</a></p>`;
    }
    return callbackIds;
  }

  private async captureWithLocalCallbacks(message: PreparedSesMessage, family: Family, listManagementOptions?: any): Promise<Record<string, unknown>> {
    const callbackIds = this.prepareLocalCallbacks(message, listManagementOptions);
    if (callbackIds.length) await this.store.save();
    try {
      return this.captureCustomerMessage(message, family);
    } catch (error) {
      for (const id of callbackIds) delete this.state.localCallbacks[id];
      if (callbackIds.length) await this.store.save();
      throw error;
    }
  }

  async handleLocalCallback(req: IncomingMessage, res: ServerResponse, url: URL, purposeValue: string): Promise<void> {
    securityHeaders(res, true);
    const purpose = purposeValue.toUpperCase();
    if (!["UNSUBSCRIBE", "CLICK"].includes(purpose)) return this.verificationErrorPage(res, 404, "This SES callback is unavailable.");
    if (req.method !== "GET" && !(purpose === "UNSUBSCRIBE" && req.method === "POST")) return this.verificationErrorPage(res, 405, "Method not allowed");
    const tokens = url.searchParams.getAll("token");
    if (url.searchParams.size !== 1 || tokens.length !== 1) return this.verificationErrorPage(res, 400, "The SES callback link is malformed.");
    let destinationUrl: string | undefined;
    let completed = false;
    await this.exclusive(async () => {
      const callback = this.verifyLocalCallbackToken(tokens[0], purpose as "UNSUBSCRIBE" | "CLICK");
      if (!callback) return;
      if (callback.purpose === "UNSUBSCRIBE") {
        const list = callback.contactListName ? this.state.contactLists[callback.contactListName] : undefined;
        if (!list || !callback.emailAddress) return;
        const parsed = parseMailboxAddress(callback.emailAddress);
        const now = this.clock.now();
        const contact = list.contacts[parsed.normalized] ?? {
          emailAddress: parsed.address,
          topicPreferences: {},
          unsubscribeAll: false,
          createdAt: now,
          updatedAt: now,
        };
        if (callback.topicName) contact.topicPreferences[callback.topicName] = "OPT_OUT";
        else contact.unsubscribeAll = true;
        contact.updatedAt = now;
        list.contacts[parsed.normalized] = contact;
        list.updatedAt = now;
        this.state.controlRevision += 1;
      } else destinationUrl = callback.destinationUrl;
      callback.consumedAt = this.clock.now();
      this.mailbox.recordControlAudit(randomUUID(), `LOCAL_${callback.purpose}_CALLBACK`, callback.consumedAt, {
        callbackId: callback.callbackId,
        ...(callback.messageId ? { messageId: callback.messageId } : {}),
      });
      await this.store.save();
      this.mailbox.enqueueOutbox(this.callbackOutbox(callback));
      await this.drainEventOutbox();
      completed = true;
    });
    if (!completed) return this.verificationErrorPage(res, 400, "This SES callback link is invalid, expired, or already used.");
    if (purpose === "CLICK" && destinationUrl) {
      res.statusCode = 303;
      res.setHeader("location", destinationUrl);
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>SES unsubscribe</title></head><body><main><h1>Unsubscribed</h1><p>The local contact preference was updated.</p></main></body></html>");
  }

  async sendInternal(
    input: SesInternalProducerInput,
    context: SesInternalProducerContext,
  ): Promise<{ MessageId: string }> {
    if (!this.admitted || this.shuttingDown) {
      throw new AwsError("ServiceUnavailableException", "SES is not available for internal delivery.", 503);
    }
    if (
      context.servicePrincipal !== "cognito-idp.amazonaws.com"
      || context.originService !== "cognito-idp"
      || !["COGNITO_DEFAULT", "DEVELOPER"].includes(context.deliveryProfile)
      || !/^[A-Za-z0-9_-]{32,128}$/.test(context.producerDeliveryKey)
    ) {
      throw new AwsError("AccessDeniedException", "The internal SES producer context is not authorized.", 403);
    }
    return this.exclusive(async () => {
      const source = String(input.FromEmailAddress ?? "");
      if (context.deliveryProfile === "COGNITO_DEFAULT") {
        if (
          source !== "no-reply@verificationemail.com"
          || input.FromEmailAddressIdentityArn !== undefined
          || input.ConfigurationSetName !== undefined
          || input.ReplyToAddresses?.length
        ) {
          throw new AwsError("AccessDeniedException", "The Cognito default-email profile is invalid.", 403);
        }
      }
      if (
        context.deliveryProfile === "DEVELOPER"
        && typeof input.FromEmailAddressIdentityArn !== "string"
      ) {
        throw new AwsError(
          "AccessDeniedException",
          "The Cognito developer-email profile requires an SES identity ARN.",
          403,
        );
      }
      if (context.deliveryProfile === "DEVELOPER") {
        this.validateDelegatedIdentityArn(
          input.FromEmailAddressIdentityArn,
          source,
          "ses-v2",
          "FromEmailAddressIdentityArn",
        );
      }
      const configuration = context.deliveryProfile === "DEVELOPER"
        ? this.sendingConfiguration(source, input.ConfigurationSetName, "ses-v2")
        : undefined;
      const simple = input.Content?.Simple;
      const destination = input.Destination;
      if (!simple || !destination) throw new AwsError("BadRequestException", "Internal SES simple content and destination are required.");
      let prepared: PreparedSesMessage;
      try {
        prepared = buildSimpleMessage({
          messageId: input.messageId,
          acceptedAt: input.acceptedAt,
          accountId: this.store.accountId,
          region: this.region,
          apiFamily: "internal",
          operation: "SendEmail",
          originService: context.originService,
          source,
          replyTo: input.ReplyToAddresses ?? [],
          destination: { to: input.Destination.ToAddresses },
          subject: String(simple.Subject?.Data ?? ""),
          charset: String(simple.Subject?.Charset ?? simple.Body?.Text?.Charset ?? simple.Body?.Html?.Charset ?? "UTF-8"),
          ...(simple.Body?.Text?.Data === undefined ? {} : { textBody: String(simple.Body.Text.Data) }),
          ...(simple.Body?.Html?.Data === undefined ? {} : { htmlBody: String(simple.Body.Html.Data) }),
          ...(configuration ? { configurationSetName: configuration } : {}),
          messageTags: {},
        });
      } catch (error) {
        return this.mailboxFailure(error, "ses-v2");
      }
      if (context.deliveryProfile === "DEVELOPER") this.assertSandboxRecipients(prepared);
      const contentMac = this.producerContentMac(prepared);
      const recipientOccurrences = prepared.recipients.filter(recipient => recipient.isEnvelope).length;
      const limits = this.effectiveQuotaLimits();
      try {
        const captured = this.mailbox.capture(prepared, {
          recipientOccurrences: context.deliveryProfile === "COGNITO_DEFAULT" ? 0 : recipientOccurrences,
          ...(context.deliveryProfile === "COGNITO_DEFAULT"
            ? {}
            : {
                quotaWindows: [
                  { windowMs: DAY, maximumRecipients: Math.max(1, Math.floor(limits.max24HourSend)) },
                  { windowMs: 1_000, maximumRecipients: Math.max(1, Math.floor(limits.maxSendRate)) },
                ],
              }),
          auditEventType: "SERVICE_PRODUCER_ACCEPTED",
          auditDetail: {
            origin: "SERVICE_PRODUCER",
            originService: context.originService,
            deliveryProfile: context.deliveryProfile,
          },
          producer: {
            originService: context.originService,
            deliveryKey: context.producerDeliveryKey,
            contentMac,
          },
        });
        return { MessageId: captured.messageId };
      } catch (error) {
        if ((error as any)?.code === "IdempotencyMismatch") {
          throw new AwsError("InternalServiceErrorException", "The SES producer delivery key conflicts with previously accepted content.", 500);
        }
        return this.mailboxFailure(error, "ses-v2");
      } finally {
        contentMac.fill(0);
      }
    });
  }

  private producerContentMac(message: PreparedSesMessage): Buffer {
    const root = Buffer.from(this.store.state.installation.sesSigningSecret, "base64");
    const key = Buffer.from(hkdfSync(
      "sha256",
      root,
      Buffer.from("stacksim:ses:producer:v1", "utf8"),
      Buffer.from("stacksim:ses:producer-content-mac:v1", "utf8"),
      32,
    ));
    const hmac = createHmac("sha256", key);
    const field = (value: string | Uint8Array): void => {
      const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(bytes.length);
      hmac.update(length).update(bytes);
      length.fill(0);
      bytes.fill(0);
    };
    const count = (value: number): void => {
      const bytes = Buffer.allocUnsafe(4);
      bytes.writeUInt32BE(value);
      hmac.update(bytes);
      bytes.fill(0);
    };
    try {
      field("v1");
      field(message.accountId);
      field(message.region);
      field(message.originService ?? "");
      field(message.messageId);
      field(String(message.acceptedAt));
      field(message.source);
      field(message.returnPath ?? "");
      count(message.replyTo.length);
      for (const address of message.replyTo) field(address);
      count(message.recipients.length);
      for (const recipient of message.recipients) {
        field(recipient.address);
        field(recipient.headerKind ?? "");
        field(recipient.isEnvelope ? "1" : "0");
      }
      field(message.configurationSetName ?? "");
      field(message.normalizedRaw ?? new Uint8Array());
      return hmac.digest();
    } finally {
      root.fill(0);
      key.fill(0);
    }
  }

  private async sendEmail(input: any, family: Family, requestId: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (family === "ses-v1") return this.sendSimpleV1(input, requestId);
      if (input.EndpointId !== undefined || input.TenantName !== undefined) throw new AwsError("BadRequestException", "Multi-Region endpoints and tenants begin in a later SES phase.", 400);
      const content = input.Content;
      if (!content || typeof content !== "object") throw new AwsError("BadRequestException", "Content is required.", 400);
      const branches = ["Simple", "Raw", "Template"].filter(key => content[key] !== undefined);
      if (branches.length !== 1) throw new AwsError("BadRequestException", "Content must contain exactly one of Simple, Raw, or Template.", 400);
      if (content.Raw) return this.sendRawV2(input, requestId);
      if (content.Template) return this.sendTemplateV2(input, requestId);
      return this.sendSimpleV2(input, requestId);
    });
  }

  private sendSimpleV1(input: any, _requestId: string): Promise<Record<string, unknown>> {
    const source = String(input.Source ?? "");
    this.validateDelegatedIdentityArn(input.SourceArn, source, "ses-v1", "SourceArn");
    this.validateDelegatedIdentityArn(input.ReturnPathArn, input.ReturnPath ?? source, "ses-v1", "ReturnPathArn");
    const configuration = this.sendingConfiguration(source, input.ConfigurationSetName, "ses-v1");
    const messageId = randomUUID();
    const acceptedAt = this.clock.now();
    const destination = input.Destination ?? {};
    try {
      const prepared = buildSimpleMessage({
        messageId,
        acceptedAt,
        accountId: this.store.accountId,
        region: this.region,
        apiFamily: "ses-v1",
        operation: "SendEmail",
        source,
        returnPath: input.ReturnPath,
        replyTo: stringValues(input.ReplyToAddresses),
        destination: { to: stringValues(destination.ToAddresses), cc: stringValues(destination.CcAddresses), bcc: stringValues(destination.BccAddresses) },
        subject: String(input.Message?.Subject?.Data ?? ""),
        charset: String(input.Message?.Subject?.Charset ?? input.Message?.Body?.Text?.Charset ?? input.Message?.Body?.Html?.Charset ?? "UTF-8"),
        ...(input.Message?.Body?.Text?.Data === undefined ? {} : { textBody: String(input.Message.Body.Text.Data) }),
        ...(input.Message?.Body?.Html?.Data === undefined ? {} : { htmlBody: String(input.Message.Body.Html.Data) }),
        ...(configuration ? { configurationSetName: configuration } : {}),
        messageTags: messageTagsFrom(input.Tags),
      });
      return this.captureCustomerMessage(prepared, "ses-v1");
    } catch (error) {
      return this.mailboxFailure(error, "ses-v1");
    }
  }

  private simpleAttachments(value: unknown): SimpleAttachmentInput[] {
    return values<any>(value).map(item => {
      const content = decodeBase64(item?.RawContent, "ses-v2", "Attachment RawContent");
      if (!item?.FileName || typeof item.FileName !== "string") throw new AwsError("BadRequestException", "Attachment FileName is required.", 400);
      return {
        content,
        filename: item.FileName,
        ...(item.ContentType ? { contentType: String(item.ContentType) } : {}),
        ...(item.ContentDisposition ? { disposition: String(item.ContentDisposition).toLowerCase() as "attachment" | "inline" } : {}),
        ...(item.ContentId ? { contentId: String(item.ContentId) } : {}),
      };
    });
  }

  private async sendSimpleV2(input: any, _requestId: string): Promise<Record<string, unknown>> {
    const source = String(input.FromEmailAddress ?? "");
    this.validateDelegatedIdentityArn(input.FromEmailAddressIdentityArn, source, "ses-v2", "FromEmailAddressIdentityArn");
    this.validateDelegatedIdentityArn(input.FeedbackForwardingEmailAddressIdentityArn, input.FeedbackForwardingEmailAddress, "ses-v2", "FeedbackForwardingEmailAddressIdentityArn");
    const configuration = this.sendingConfiguration(source, input.ConfigurationSetName, "ses-v2");
    const simple = input.Content.Simple ?? {};
    const destination = input.Destination ?? {};
    try {
      const prepared = buildSimpleMessage({
        messageId: randomUUID(),
        acceptedAt: this.clock.now(),
        accountId: this.store.accountId,
        region: this.region,
        apiFamily: "ses-v2",
        operation: "SendEmail",
        source,
        returnPath: input.FeedbackForwardingEmailAddress,
        replyTo: stringValues(input.ReplyToAddresses),
        destination: { to: stringValues(destination.ToAddresses), cc: stringValues(destination.CcAddresses), bcc: stringValues(destination.BccAddresses) },
        subject: String(simple.Subject?.Data ?? ""),
        charset: String(simple.Subject?.Charset ?? simple.Body?.Text?.Charset ?? simple.Body?.Html?.Charset ?? "UTF-8"),
        ...(simple.Body?.Text?.Data === undefined ? {} : { textBody: String(simple.Body.Text.Data) }),
        ...(simple.Body?.Html?.Data === undefined ? {} : { htmlBody: String(simple.Body.Html.Data) }),
        headers: values<any>(simple.Headers).map(header => ({ name: String(header.Name ?? ""), value: String(header.Value ?? "") })),
        attachments: this.simpleAttachments(simple.Attachments),
        ...(configuration ? { configurationSetName: configuration } : {}),
        messageTags: messageTagsFrom(input.EmailTags),
      });
      this.applySuppression(prepared, input.ListManagementOptions);
      return await this.captureWithLocalCallbacks(prepared, "ses-v2", input.ListManagementOptions);
    } catch (error) {
      return this.mailboxFailure(error, "ses-v2");
    }
  }

  private async sendRawEmail(input: any, _requestId: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => this.sendRawV1(input));
  }

  private sendRawV1(input: any): Promise<Record<string, unknown>> {
    const raw = decodeBase64(input.RawMessage?.Data, "ses-v1", "RawMessage.Data");
    try {
      const rawAuthorization = rawSesAuthorizationHeaders(raw);
      const prepared = parseRawMessage({
        messageId: randomUUID(),
        acceptedAt: this.clock.now(),
        accountId: this.store.accountId,
        region: this.region,
        apiFamily: "ses-v1",
        operation: "SendRawEmail",
        raw,
        ...(input.Source ? { source: String(input.Source) } : {}),
        ...(input.Destinations !== undefined ? { destinations: stringValues(input.Destinations) } : {}),
        messageTags: messageTagsFrom(input.Tags),
      });
      this.validateDelegatedIdentityArn(input.SourceArn, prepared.source, "ses-v1", "SourceArn");
      this.validateDelegatedIdentityArn(input.ReturnPathArn, prepared.returnPath ?? prepared.source, "ses-v1", "ReturnPathArn");
      this.validateDelegatedIdentityArn(rawAuthorization.sourceArn, prepared.source, "ses-v1", "X-SES-SOURCE-ARN");
      this.validateDelegatedIdentityArn(rawAuthorization.fromArn, prepared.source, "ses-v1", "X-SES-FROM-ARN");
      this.validateDelegatedIdentityArn(rawAuthorization.returnPathArn, prepared.returnPath ?? prepared.source, "ses-v1", "X-SES-RETURN-PATH-ARN");
      const configuration = this.sendingConfiguration(prepared.source, input.ConfigurationSetName, "ses-v1");
      if (configuration) prepared.configurationSetName = configuration;
      return this.captureCustomerMessage(prepared, "ses-v1");
    } catch (error) {
      return this.mailboxFailure(error, "ses-v1");
    }
  }

  private async sendRawV2(input: any, _requestId: string): Promise<Record<string, unknown>> {
    const raw = decodeBase64(input.Content.Raw?.Data, "ses-v2", "Content.Raw.Data");
    try {
      const rawAuthorization = rawSesAuthorizationHeaders(raw);
      const prepared = parseRawMessage({
        messageId: randomUUID(),
        acceptedAt: this.clock.now(),
        accountId: this.store.accountId,
        region: this.region,
        apiFamily: "ses-v2",
        operation: "SendEmail",
        raw,
        ...(input.FromEmailAddress ? { source: String(input.FromEmailAddress) } : {}),
        ...(input.Destination ? { destinations: [...stringValues(input.Destination.ToAddresses), ...stringValues(input.Destination.CcAddresses), ...stringValues(input.Destination.BccAddresses)] } : {}),
        ...(input.FeedbackForwardingEmailAddress ? { returnPath: String(input.FeedbackForwardingEmailAddress) } : {}),
        messageTags: messageTagsFrom(input.EmailTags),
      });
      this.validateDelegatedIdentityArn(input.FromEmailAddressIdentityArn, prepared.source, "ses-v2", "FromEmailAddressIdentityArn");
      this.validateDelegatedIdentityArn(input.FeedbackForwardingEmailAddressIdentityArn, prepared.returnPath, "ses-v2", "FeedbackForwardingEmailAddressIdentityArn");
      this.validateDelegatedIdentityArn(rawAuthorization.sourceArn, prepared.source, "ses-v2", "X-SES-SOURCE-ARN");
      this.validateDelegatedIdentityArn(rawAuthorization.fromArn, prepared.source, "ses-v2", "X-SES-FROM-ARN");
      this.validateDelegatedIdentityArn(rawAuthorization.returnPathArn, prepared.returnPath ?? prepared.source, "ses-v2", "X-SES-RETURN-PATH-ARN");
      const configuration = this.sendingConfiguration(prepared.source, input.ConfigurationSetName, "ses-v2");
      if (configuration) prepared.configurationSetName = configuration;
      this.applySuppression(prepared, input.ListManagementOptions);
      return await this.captureWithLocalCallbacks(prepared, "ses-v2", input.ListManagementOptions);
    } catch (error) {
      return this.mailboxFailure(error, "ses-v2");
    }
  }

  private async sendTemplatedEmail(input: any, _requestId: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const template = this.templateOrThrow(input.Template, "ses-v1");
      this.validateDelegatedIdentityArn(input.SourceArn, input.Source, "ses-v1", "SourceArn");
      this.validateDelegatedIdentityArn(input.ReturnPathArn, input.ReturnPath ?? input.Source, "ses-v1", "ReturnPathArn");
      return this.renderAndCaptureTemplate({
        family: "ses-v1",
        operation: "SendTemplatedEmail",
        source: String(input.Source ?? ""),
        destination: input.Destination ?? {},
        replyTo: stringValues(input.ReplyToAddresses),
        returnPath: input.ReturnPath,
        template,
        templateData: input.TemplateData,
        requestedConfiguration: input.ConfigurationSetName,
        messageTags: messageTagsFrom(input.Tags),
      });
    });
  }

  private prepareBulkTemplateMessage(options: {
    family: Family;
    operation: string;
    source: string;
    destination: any;
    replyTo: string[];
    returnPath?: string;
    configuration?: string;
    templateName?: string;
    content: TemplateContent;
    templateData: unknown;
    messageTags: Record<string, string>;
    listManagementOptions?: any;
  }): PreparedSesMessage {
    const rendered = renderTemplate(options.content, options.templateData);
    const messageId = randomUUID();
    const acceptedAt = this.clock.now();
    if (rendered.error) {
      const failed: PreparedSesMessage = {
        messageId, acceptedAt, accountId: this.store.accountId, region: this.region,
        apiFamily: options.family, operation: options.operation,
        source: parseMailboxAddress(options.source).address,
        ...(options.returnPath ? { returnPath: parseMailboxAddress(options.returnPath).address } : {}),
        replyTo: options.replyTo.map(address => parseMailboxAddress(address).address),
        recipients: this.preparedDestinationRecipients(options.destination),
        renderStatus: "FAILED", localDisposition: "NOT_ATTEMPTED",
        outcomeCode: rendered.error.code, outcomeDetail: { message: rendered.error.message.slice(0, 512) },
        headers: [], attachments: [], messageTags: options.messageTags,
        ...(options.configuration ? { configurationSetName: options.configuration } : {}),
        ...(options.templateName ? { templateName: options.templateName } : {}),
      };
      return failed;
    }
    const prepared = buildSimpleMessage({
      messageId, acceptedAt, accountId: this.store.accountId, region: this.region,
      apiFamily: options.family, operation: options.operation, source: options.source,
      returnPath: options.returnPath, replyTo: options.replyTo,
      destination: { to: stringValues(options.destination.ToAddresses), cc: stringValues(options.destination.CcAddresses), bcc: stringValues(options.destination.BccAddresses) },
      subject: rendered.content?.Subject ?? "",
      ...(rendered.content?.Text === undefined ? {} : { textBody: rendered.content.Text }),
      ...(rendered.content?.Html === undefined ? {} : { htmlBody: rendered.content.Html }),
      ...(options.configuration ? { configurationSetName: options.configuration } : {}),
      messageTags: options.messageTags,
      ...(options.templateName ? { templateName: options.templateName } : {}),
    });
    this.applySuppression(prepared, options.listManagementOptions);
    return prepared;
  }

  private async captureBulk(messages: PreparedSesMessage[], family: Family): Promise<void> {
    const limits = this.effectiveQuotaLimits();
    for (const message of messages) this.assertSandboxRecipients(message);
    try {
      this.mailbox.captureBatch(messages.map(message => ({
        message,
        options: {
          recipientOccurrences: message.recipients.filter(recipient => recipient.isEnvelope).length,
          quotaWindows: [
            { windowMs: DAY, maximumRecipients: Math.max(1, Math.floor(limits.max24HourSend)) },
            { windowMs: 1_000, maximumRecipients: Math.max(1, Math.floor(limits.maxSendRate)) },
          ],
          auditEventType: "ACCEPTED",
          auditDetail: { apiFamily: family, operation: message.operation, renderStatus: message.renderStatus, disposition: message.localDisposition },
          outbox: this.messageOutbox(message),
        },
      })));
      await this.drainEventOutbox();
    } catch (error) {
      this.mailboxFailure(error, family);
    }
  }

  private async sendBulkTemplatedEmail(input: any, _requestId: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const source = String(input.Source ?? "");
      this.validateDelegatedIdentityArn(input.SourceArn, source, "ses-v1", "SourceArn");
      const template = this.templateOrThrow(input.Template, "ses-v1");
      const configuration = this.sendingConfiguration(source, input.ConfigurationSetName, "ses-v1");
      const entries = values<any>(input.Destinations);
      if (!entries.length || entries.length > 50) throw new AwsError("InvalidParameterValue", "Destinations must contain 1-50 entries.", 400);
      const prepared: PreparedSesMessage[] = [];
      const statuses: any[] = [];
      for (const entry of entries) {
        try {
          const message = this.prepareBulkTemplateMessage({
            family: "ses-v1", operation: "SendBulkTemplatedEmail", source,
            destination: entry.Destination ?? {}, replyTo: stringValues(input.ReplyToAddresses),
            returnPath: input.ReturnPath, configuration, templateName: template.name,
            content: { Subject: template.subjectPart, Text: template.textPart, Html: template.htmlPart },
            templateData: entry.ReplacementTemplateData ?? input.DefaultTemplateData ?? "{}",
            messageTags: { ...messageTagsFrom(input.DefaultTags), ...messageTagsFrom(entry.ReplacementTags) },
          });
          prepared.push(message);
          statuses.push({ Status: "Success", MessageId: message.messageId });
        } catch (error) {
          statuses.push({ Status: "Failed", Error: (error as any)?.code ?? "MessageRejected", DiagnosticCode: error instanceof Error ? error.message : String(error) });
        }
      }
      await this.captureBulk(prepared, "ses-v1");
      return { Status: statuses };
    });
  }

  private async sendBulkEmail(input: any, _requestId: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const source = String(input.FromEmailAddress ?? "");
      this.validateDelegatedIdentityArn(input.FromEmailAddressIdentityArn, source, "ses-v2", "FromEmailAddressIdentityArn");
      const configuration = this.sendingConfiguration(source, input.ConfigurationSetName, "ses-v2");
      const defaultTemplate = input.DefaultContent?.Template;
      if (!defaultTemplate) throw new AwsError("BadRequestException", "DefaultContent.Template is required.", 400);
      const stored = defaultTemplate.TemplateName === undefined ? undefined : this.templateOrThrow(defaultTemplate.TemplateName, "ses-v2");
      const defaultContent: TemplateContent = stored
        ? { Subject: stored.subjectPart, Text: stored.textPart, Html: stored.htmlPart }
        : (() => { const valid = validateTemplateContent(defaultTemplate.TemplateContent); return { Subject: valid.Subject, Text: valid.Text, Html: valid.Html }; })();
      const entries = values<any>(input.BulkEmailEntries);
      if (!entries.length || entries.length > 50) throw new AwsError("BadRequestException", "BulkEmailEntries must contain 1-50 entries.", 400);
      const prepared: PreparedSesMessage[] = [];
      const results: any[] = [];
      for (const entry of entries) {
        try {
          const replacement = entry.ReplacementEmailContent?.ReplacementTemplate ?? {};
          let content = defaultContent;
          let templateName = stored?.name;
          if (replacement.ReplacementTemplateData === undefined && replacement.TemplateContent !== undefined) {
            const valid = validateTemplateContent(replacement.TemplateContent);
            content = { Subject: valid.Subject, Text: valid.Text, Html: valid.Html };
            templateName = undefined;
          }
          const message = this.prepareBulkTemplateMessage({
            family: "ses-v2", operation: "SendBulkEmail", source,
            destination: entry.Destination ?? {}, replyTo: stringValues(input.ReplyToAddresses),
            returnPath: input.FeedbackForwardingEmailAddress, configuration, templateName, content,
            templateData: replacement.ReplacementTemplateData ?? defaultTemplate.TemplateData ?? "{}",
            messageTags: { ...messageTagsFrom(input.DefaultEmailTags), ...messageTagsFrom(entry.ReplacementTags) },
            listManagementOptions: input.ListManagementOptions,
          });
          prepared.push(message);
          results.push({ Status: "SUCCESS", MessageId: message.messageId });
        } catch (error) {
          results.push({ Status: "FAILED", Error: (error as any)?.code ?? "BadRequestException", Message: error instanceof Error ? error.message : String(error) });
        }
      }
      const callbackIds = prepared.flatMap(message => this.prepareLocalCallbacks(message, input.ListManagementOptions));
      if (callbackIds.length) await this.store.save();
      try {
        await this.captureBulk(prepared, "ses-v2");
      } catch (error) {
        for (const id of callbackIds) delete this.state.localCallbacks[id];
        if (callbackIds.length) await this.store.save();
        throw error;
      }
      return { BulkEmailEntryResults: results };
    });
  }

  private sendTemplateV2(input: any, _requestId: string): Promise<Record<string, unknown>> {
    this.validateDelegatedIdentityArn(input.FromEmailAddressIdentityArn, input.FromEmailAddress, "ses-v2", "FromEmailAddressIdentityArn");
    this.validateDelegatedIdentityArn(input.FeedbackForwardingEmailAddressIdentityArn, input.FeedbackForwardingEmailAddress, "ses-v2", "FeedbackForwardingEmailAddressIdentityArn");
    const content = input.Content.Template ?? {};
    let templateName: string | undefined;
    let templateContent: TemplateContent;
    if (content.TemplateContent !== undefined) {
      const validated = validateTemplateContent(content.TemplateContent);
      templateContent = { Subject: validated.Subject, Text: validated.Text, Html: validated.Html };
    } else {
      const template = this.templateOrThrow(content.TemplateName, "ses-v2");
      templateName = template.name;
      templateContent = { Subject: template.subjectPart, Text: template.textPart, Html: template.htmlPart };
    }
    return this.renderAndCaptureTemplate({
      family: "ses-v2",
      operation: "SendEmail",
      source: String(input.FromEmailAddress ?? ""),
      destination: input.Destination ?? {},
      replyTo: stringValues(input.ReplyToAddresses),
      returnPath: input.FeedbackForwardingEmailAddress,
      template: templateName ? this.state.templates[templateName] : undefined,
      inlineContent: templateContent,
      templateData: content.TemplateData ?? "{}",
      requestedConfiguration: input.ConfigurationSetName,
      messageTags: messageTagsFrom(input.EmailTags),
      headers: values<any>(content.Headers).map(header => ({ name: String(header.Name ?? ""), value: String(header.Value ?? "") })),
      attachments: this.simpleAttachments(content.Attachments),
      listManagementOptions: input.ListManagementOptions,
    });
  }

  private async renderAndCaptureTemplate(options: {
    family: Family;
    operation: string;
    source: string;
    destination: any;
    replyTo: string[];
    returnPath?: string;
    template?: SesTemplateState;
    inlineContent?: TemplateContent;
    templateData: unknown;
    requestedConfiguration?: unknown;
    messageTags: Record<string, string>;
    headers?: Array<{ name: string; value: string }>;
    attachments?: SimpleAttachmentInput[];
    listManagementOptions?: any;
  }): Promise<Record<string, unknown>> {
    const configuration = this.sendingConfiguration(options.source, options.requestedConfiguration, options.family);
    const sourceContent = options.inlineContent ?? {
      Subject: options.template!.subjectPart,
      Text: options.template!.textPart,
      Html: options.template!.htmlPart,
    };
    const rendered = renderTemplate(sourceContent, options.templateData);
    const messageId = randomUUID();
    const acceptedAt = this.clock.now();
    if (rendered.error) {
      const recipients = this.preparedDestinationRecipients(options.destination);
      const failed: PreparedSesMessage = {
        messageId,
        acceptedAt,
        accountId: this.store.accountId,
        region: this.region,
        apiFamily: options.family,
        operation: options.operation,
        source: parseMailboxAddress(options.source).address,
        ...(options.returnPath ? { returnPath: parseMailboxAddress(options.returnPath).address } : {}),
        replyTo: options.replyTo.map(address => parseMailboxAddress(address).address),
        recipients,
        renderStatus: "FAILED",
        localDisposition: "NOT_ATTEMPTED",
        outcomeCode: rendered.error.code,
        outcomeDetail: { message: rendered.error.message.slice(0, 512) },
        headers: [],
        attachments: [],
        ...(configuration ? { configurationSetName: configuration } : {}),
        messageTags: options.messageTags,
        ...(options.template ? { templateName: options.template.name } : {}),
      };
      return this.captureCustomerMessage(failed, options.family);
    }
    try {
      const prepared = buildSimpleMessage({
        messageId,
        acceptedAt,
        accountId: this.store.accountId,
        region: this.region,
        apiFamily: options.family,
        operation: options.operation,
        source: options.source,
        returnPath: options.returnPath,
        replyTo: options.replyTo,
        destination: {
          to: stringValues(options.destination.ToAddresses),
          cc: stringValues(options.destination.CcAddresses),
          bcc: stringValues(options.destination.BccAddresses),
        },
        subject: rendered.content?.Subject ?? "",
        ...(rendered.content?.Text === undefined ? {} : { textBody: rendered.content.Text }),
        ...(rendered.content?.Html === undefined ? {} : { htmlBody: rendered.content.Html }),
        headers: options.headers,
        attachments: options.attachments,
        ...(configuration ? { configurationSetName: configuration } : {}),
        messageTags: options.messageTags,
        ...(options.template ? { templateName: options.template.name } : {}),
      });
      this.applySuppression(prepared, options.listManagementOptions);
      return await this.captureWithLocalCallbacks(prepared, options.family, options.listManagementOptions);
    } catch (error) {
      return this.mailboxFailure(error, options.family);
    }
  }

  private preparedDestinationRecipients(destination: any): PreparedRecipient[] {
    const recipients: PreparedRecipient[] = [];
    for (const [headerKind, supplied] of [["TO", destination.ToAddresses], ["CC", destination.CcAddresses], ["BCC", destination.BccAddresses]] as const) {
      for (const address of stringValues(supplied)) {
        parseMailboxAddress(address);
        recipients.push({ ordinal: recipients.length, address, headerKind, isEnvelope: true, origin: "API_DESTINATION" });
      }
    }
    if (!recipients.length || recipients.length > 50) throw new AwsError("MessageRejected", "A message must have 1-50 recipients.", 400);
    return recipients;
  }

  private verificationPayload(intent: SesVerificationIntentState, identity: SesIdentityState): VerificationTokenPayload {
    const bound = {
      accountId: this.store.accountId,
      region: this.region,
      identity: identity.canonicalIdentity,
      identityGeneration: intent.identityGeneration,
      intentId: intent.intentId,
      messageId: intent.messageId,
      issuedAt: intent.issuedAt,
      expiresAt: intent.expiresAt,
    };
    return { v: 1, ...bound, nonce: deriveVerificationNonce(this.store.state.installation.sesSigningSecret, bound) };
  }

  private verificationPreparedMessage(identity: SesIdentityState, intent: SesVerificationIntentState): PreparedSesMessage {
    const payload = this.verificationPayload(intent, identity);
    const token = signVerificationToken(this.store.state.installation.sesSigningSecret, payload);
    const link = verificationCallbackUrl(intent.publicBaseUrl, this.region, token);
    const custom = intent.customTemplate;
    const customHtml = custom?.content
      .replaceAll("{{amazonSESVerificationURL}}", escapeHtml(link))
      .replaceAll("{{verificationURL}}", escapeHtml(link));
    return buildSimpleMessage({
      messageId: intent.messageId,
      acceptedAt: intent.issuedAt,
      accountId: this.store.accountId,
      region: this.region,
      apiFamily: "internal",
      operation: custom ? "SendCustomVerificationEmail" : "VerifyEmailIdentity",
      originService: "ses",
      source: custom?.fromEmailAddress ?? "no-reply@stacksim.local",
      destination: { to: [identity.identity] },
      subject: custom?.subject ?? "SES email address verification request",
      textBody: custom
        ? `Verify ${identity.identity} for local SES use:\n\n${link}`
        : `Verify ${identity.identity} for local SES use:\n\n${link}\n\nThis simulator captures mail locally and never sends it to an external server.`,
      htmlBody: customHtml ?? `<p>Verify <strong>${escapeHtml(identity.identity)}</strong> for local SES use.</p><p><a href="${escapeHtml(link)}">Verify this email address</a></p><p>This simulator captures mail locally and never sends it to an external server.</p>`,
      verificationIntentId: intent.intentId,
      messageTags: {},
    });
  }

  private async issueVerificationIntent(identity: SesIdentityState, template?: SesCustomVerificationTemplateState): Promise<void> {
    if (!this.publicBaseUrl) throw new AwsError("ServiceUnavailableException", "SES verification links are not available until the control listener has bound.", 503);
    const now = this.clock.now();
    const priorActive = identity.activeVerificationIntentId;
    const intent: SesVerificationIntentState = {
      intentId: randomUUID(),
      identity: identity.canonicalIdentity,
      identityGeneration: identity.generationId,
      ...(priorActive ? { supersedesIntentId: priorActive } : {}),
      messageId: randomUUID(),
      nonceDigest: "",
      publicBaseUrl: this.publicBaseUrl,
      ...(template ? {
        successRedirectUrl: template.successRedirectionUrl,
        failureRedirectUrl: template.failureRedirectionUrl,
        customTemplate: {
          fromEmailAddress: template.fromEmailAddress,
          subject: template.templateSubject,
          content: template.templateContent,
        },
      } : {}),
      issuedAt: now,
      expiresAt: now + DAY,
      status: "PENDING_CAPTURE",
    };
    const payload = this.verificationPayload(intent, identity);
    intent.nonceDigest = verificationNonceDigest(payload.nonce);
    const prepared = this.verificationPreparedMessage(identity, intent);
    try {
      this.mailbox.preflightCapture(prepared, { recipientOccurrences: 0 });
    } catch (error) {
      this.mailboxFailure(error, "ses-v2");
    }
    this.state.verificationIntents[intent.intentId] = intent;
    if (!priorActive) identity.activeVerificationIntentId = intent.intentId;
    identity.updatedAt = now;
    await this.store.save();
    this.captureVerificationIntent(identity, intent, "VERIFICATION_CAPTURED");
    await this.store.save();
  }

  private captureVerificationIntent(identity: SesIdentityState, intent: SesVerificationIntentState, auditEventType: string): void {
    try {
      this.mailbox.capture(this.verificationPreparedMessage(identity, intent), {
        recipientOccurrences: 0,
        auditEventType,
        auditDetail: { origin: "SES_SYSTEM", operation: "VerifyEmailIdentity" },
      });
    } catch (error) {
      this.mailboxFailure(error, "ses-v2");
    }
    const now = this.clock.now();
    intent.status = "CAPTURED";
    const active = identity.activeVerificationIntentId;
    if (identity.verifiedForSendingStatus) {
      intent.status = "SUPERSEDED";
      intent.terminalAt = now;
      return;
    }
    if (intent.supersedesIntentId) {
      if (active && active !== intent.supersedesIntentId && active !== intent.intentId) {
        intent.status = "SUPERSEDED";
        intent.terminalAt = now;
        return;
      }
      const prior = this.state.verificationIntents[intent.supersedesIntentId];
      if (prior?.status === "CAPTURED") {
        prior.status = "SUPERSEDED";
        prior.terminalAt = now;
      }
      identity.activeVerificationIntentId = intent.intentId;
      identity.updatedAt = now;
      return;
    }
    if (!active || active === intent.intentId) {
      identity.activeVerificationIntentId = intent.intentId;
      identity.updatedAt = now;
      return;
    }
    intent.status = "SUPERSEDED";
    intent.terminalAt = now;
  }

  private async recoverVerificationIntents(): Promise<void> {
    await this.exclusive(async () => {
      let changed = false;
      for (const intent of Object.values(this.state.verificationIntents)) {
        if (intent.status !== "PENDING_CAPTURE") continue;
        const identity = this.state.identities[intent.identity];
        if (!identity || identity.generationId !== intent.identityGeneration) {
          intent.status = "CANCELLED";
          intent.terminalAt = this.clock.now();
          changed = true;
          continue;
        }
        this.captureVerificationIntent(identity, intent, "VERIFICATION_RECOVERED");
        changed = true;
      }
      this.pruneVerificationState();
      if (changed) await this.store.save();
    });
  }

  private pruneVerificationState(): void {
    const now = this.clock.now();
    for (const [id, result] of Object.entries(this.state.callbackResults)) if (result.expiresAt <= now) delete this.state.callbackResults[id];
    for (const [id, intent] of Object.entries(this.state.verificationIntents)) {
      if (intent.status === "PENDING_CAPTURE" || intent.status === "CAPTURED") continue;
      if (intent.expiresAt + RESULT_TTL <= now && (intent.terminalAt ?? 0) + RESULT_TTL <= now) delete this.state.verificationIntents[id];
    }
  }

  private callbackResult(status: import("./types.js").SesCallbackResultState["status"], identity?: string, destinationUrl?: string): string {
    this.pruneVerificationState();
    const entries = Object.entries(this.state.callbackResults).sort(([, left], [, right]) => left.expiresAt - right.expiresAt);
    while (entries.length >= 256) {
      const [oldest] = entries.shift()!;
      delete this.state.callbackResults[oldest];
    }
    const id = randomBytes(24).toString("base64url");
    this.state.callbackResults[id] = { status, ...(identity ? { identity } : {}), ...(destinationUrl ? { destinationUrl } : {}), expiresAt: this.clock.now() + RESULT_TTL };
    return id;
  }

  async handleVerificationCallback(req: IncomingMessage, res: ServerResponse, url: URL, _requestId: string): Promise<void> {
    securityHeaders(res, true);
    if (req.method !== "GET") return this.verificationErrorPage(res, 405, "Method not allowed");
    const tokenValues = url.searchParams.getAll("token");
    if (url.searchParams.size !== 1 || tokenValues.length !== 1) return this.verificationErrorPage(res, 400, "The verification link is malformed.");
    const payload = verifyVerificationToken(this.store.state.installation.sesSigningSecret, tokenValues[0]);
    if (!payload) return this.verificationErrorPage(res, 400, "The verification link is invalid.");
    let resultId: string;
    await this.exclusive(async () => {
      let status: import("./types.js").SesCallbackResultState["status"] = "INVALID";
      if (payload.accountId !== this.store.accountId || payload.region !== this.region) status = "REGION_MISMATCH";
      else {
        const intent = this.state.verificationIntents[payload.intentId];
        const identity = this.state.identities[payload.identity];
        const nonceMatches = verificationNonceDigest(payload.nonce) === intent?.nonceDigest;
        if (!intent || intent.messageId !== payload.messageId || intent.identityGeneration !== payload.identityGeneration || !nonceMatches) status = "INVALID";
        else if (!identity || identity.generationId !== payload.identityGeneration) status = "DELETED";
        else if (intent.status === "SUPERSEDED") status = "SUPERSEDED";
        else if (intent.status === "CONSUMED" || identity.verifiedForSendingStatus) status = "ALREADY_VERIFIED";
        else if (intent.status !== "CAPTURED" || intent.expiresAt <= this.clock.now() || payload.expiresAt <= this.clock.now()) {
          status = "EXPIRED";
          if (intent.status === "CAPTURED") { intent.status = "EXPIRED"; intent.terminalAt = this.clock.now(); if (identity.activeVerificationIntentId === intent.intentId) delete identity.activeVerificationIntentId; }
        } else if (identity.activeVerificationIntentId !== intent.intentId) status = "SUPERSEDED";
        else {
          identity.verificationStatus = "SUCCESS";
          identity.verifiedForSendingStatus = true;
          identity.updatedAt = this.clock.now();
          delete identity.activeVerificationIntentId;
          intent.status = "CONSUMED";
          intent.terminalAt = this.clock.now();
          this.state.controlRevision += 1;
          status = "SUCCESS";
        }
      }
      const intent = this.state.verificationIntents[payload.intentId];
      const success = status === "SUCCESS" || status === "ALREADY_VERIFIED";
      resultId = this.callbackResult(status, payload.identity, success ? intent?.successRedirectUrl : intent?.failureRedirectUrl);
      await this.store.save();
    });
    res.statusCode = 303;
    res.setHeader("location", `${this.publicBaseUrl}/_stacksim/ses/verification-result/${encodeURIComponent(this.region)}?id=${encodeURIComponent(resultId!)}`);
    res.end();
  }

  private verificationErrorPage(res: ServerResponse, status: number, message: string): void {
    res.statusCode = status;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>SES verification</title></head><body><main><h1>Email verification</h1><p>${escapeHtml(message)}</p></main></body></html>`);
  }

  async handleVerificationResult(req: IncomingMessage, res: ServerResponse, url: URL, _requestId: string): Promise<void> {
    securityHeaders(res, true);
    if (req.method !== "GET") return this.verificationErrorPage(res, 405, "Method not allowed");
    const ids = url.searchParams.getAll("id");
    if (url.searchParams.size !== 1 || ids.length !== 1 || !/^[A-Za-z0-9_-]{20,64}$/.test(ids[0])) return this.verificationErrorPage(res, 400, "The verification result is invalid.");
    let result = this.state.callbackResults[ids[0]];
    if (!result || result.expiresAt <= this.clock.now()) {
      if (result) { delete this.state.callbackResults[ids[0]]; await this.store.save(); }
      return this.verificationErrorPage(res, 404, "This verification result has expired.");
    }
    const labels: Record<string, string> = {
      SUCCESS: "The email identity is verified for local use.",
      ALREADY_VERIFIED: "This email identity was already verified.",
      EXPIRED: "This verification link has expired.",
      INVALID: "This verification link is invalid.",
      DELETED: "The email identity was deleted or recreated.",
      SUPERSEDED: "A newer verification link replaced this link.",
      REGION_MISMATCH: "This verification link belongs to a different Region.",
    };
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>SES verification</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem}a{color:#06c}</style></head><body><main><h1>Email verification</h1><p>${escapeHtml(labels[result.status])}</p>${result.identity ? `<p><code>${escapeHtml(result.identity)}</code></p>` : ""}${result.destinationUrl ? `<p><a rel="noreferrer" href="${escapeHtml(result.destinationUrl)}">Continue to the configured destination</a></p>` : ""}<p><a href="${escapeHtml(`${this.publicBaseUrl}/_stacksim/console/#/ses/identities`)}">Return to SES</a></p></main></body></html>`);
  }

  private async commitLocalAdministration(
    eventType: string,
    eventAt: number,
    detail: Record<string, unknown>,
    rollback: () => void,
  ): Promise<void> {
    try {
      await this.store.save();
      this.mailbox.recordControlAudit(randomUUID(), eventType, eventAt, detail);
    } catch {
      rollback();
      await this.store.save().catch(() => undefined);
      throw new AwsError("ServiceUnavailable", "The local SES administration change could not be durably recorded.", 503);
    }
  }

  private async setLocalAccountProfile(profile: "PRODUCTION" | "SANDBOX"): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const account = this.state.account;
      const productionAccessEnabled = profile === "PRODUCTION";
      if (account.accessProfile === profile && account.productionAccessEnabled === productionAccessEnabled) {
        return { accessProfile: profile, productionAccessEnabled, changed: false };
      }
      const eventAt = this.clock.now();
      const previousProfile = account.accessProfile;
      const previousProductionAccessEnabled = account.productionAccessEnabled;
      const previousRevision = this.state.controlRevision;
      account.accessProfile = profile;
      account.productionAccessEnabled = productionAccessEnabled;
      this.state.controlRevision += 1;
      await this.commitLocalAdministration("LOCAL_ACCOUNT_PROFILE_CHANGED", eventAt, {
        origin: "LOCAL_CONSOLE",
        previousProfile,
        profile,
        controlRevision: this.state.controlRevision,
      }, () => {
        account.accessProfile = previousProfile;
        account.productionAccessEnabled = previousProductionAccessEnabled;
        this.state.controlRevision = previousRevision;
      });
      return { accessProfile: profile, productionAccessEnabled, changed: true };
    });
  }

  private async verifyDomainForLocalUse(value: string): Promise<Record<string, unknown>> {
    const parsed = canonicalIdentity(value);
    if (parsed.type !== "DOMAIN") throw new AwsError("InvalidRequest", "Only a domain identity can be verified for local use.", 400);
    return this.exclusive(async () => {
      const identity = this.state.identities[parsed.canonical];
      if (!identity) throw new AwsError("NotFound", `The domain identity ${parsed.original} was not found.`, 404);
      if (identity.identityType !== "DOMAIN") throw new AwsError("InvalidRequest", "Only a domain identity can be verified for local use.", 400);
      if (identity.verifiedForSendingStatus || identity.verificationStatus !== "PENDING") {
        throw new AwsError("Conflict", "Only a pending domain identity can be verified for local use.", 409);
      }
      const eventAt = this.clock.now();
      const previousVerificationStatus = identity.verificationStatus;
      const previousVerifiedForSendingStatus = identity.verifiedForSendingStatus;
      const previousUpdatedAt = identity.updatedAt;
      const previousRevision = this.state.controlRevision;
      identity.verificationStatus = "SUCCESS";
      identity.verifiedForSendingStatus = true;
      identity.updatedAt = eventAt;
      this.state.controlRevision += 1;
      const identityDigest = createHash("sha256")
        .update(`${this.store.accountId}\0${this.region}\0${identity.canonicalIdentity}`)
        .digest("hex");
      await this.commitLocalAdministration("LOCAL_DOMAIN_VERIFIED_FOR_USE", eventAt, {
        origin: "LOCAL_CONSOLE",
        identityDigest,
        generationId: identity.generationId,
        controlRevision: this.state.controlRevision,
      }, () => {
        identity.verificationStatus = previousVerificationStatus;
        identity.verifiedForSendingStatus = previousVerifiedForSendingStatus;
        identity.updatedAt = previousUpdatedAt;
        this.state.controlRevision = previousRevision;
      });
      return {
        identity: identity.identity,
        verificationStatus: identity.verificationStatus,
        verifiedForSendingStatus: identity.verifiedForSendingStatus,
        localOnly: true,
      };
    });
  }

  private localError(res: ServerResponse, error: unknown): void {
    const code = (error as any)?.code ?? (error instanceof AwsError ? error.code : "InternalError");
    const status = error instanceof AwsError ? error.status : code === "Conflict" ? 409 : code === "InvalidInput" ? 400 : code === "StaleCursor" ? 409 : 500;
    securityHeaders(res);
    json(res, { message: error instanceof Error ? error.message : String(error), code }, status);
  }

  private validateLocalMutation(req: IncomingMessage, needsJson: boolean): void {
    if (req.headers["x-stacksim-console-request"] !== "1") throw new AwsError("InvalidConsoleRequest", "The console mutation header is required.", 403);
    const originValue = req.headers.origin;
    if (typeof originValue !== "string") throw new AwsError("InvalidConsoleRequest", "A same-origin Origin header is required.", 403);
    let origin: URL;
    let expected: URL;
    try {
      origin = new URL(originValue);
      if (typeof req.headers.host !== "string") throw new Error("missing Host");
      expected = new URL(`${(req.socket as any).encrypted ? "https" : "http"}://${req.headers.host}`);
    } catch {
      throw new AwsError("InvalidConsoleRequest", "The Origin or Host header is invalid.", 403);
    }
    const loopback = (hostname: string): boolean => hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!loopback(origin.hostname) || !loopback(expected.hostname) || expected.username || expected.password || expected.pathname !== "/" || origin.origin !== expected.origin || origin.pathname !== "/") {
      throw new AwsError("InvalidConsoleRequest", "The request Origin is not the bound loopback console origin.", 403);
    }
    if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") throw new AwsError("InvalidConsoleRequest", "Cross-site console mutations are not allowed.", 403);
    if (needsJson && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new AwsError("InvalidConsoleRequest", "The request must use application/json.", 415);
  }

  private exactQuery(url: URL, allowed: Set<string>): void {
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new AwsError("InvalidRequest", `Unknown or repeated query parameter: ${key}`, 400);
    }
  }

  private decodeLocalPathSegment(value: string, label: string): string {
    try { return decodeURIComponent(value); }
    catch { throw new AwsError("InvalidRequest", `The ${label} path segment is invalid.`, 400); }
  }

  private inboxCursor(
    value: string,
    recipient: string | undefined,
    originService: string | undefined,
    status: string,
    pageSize: number,
  ): any {
    if (value.length > 8_192) throw new AwsError("InvalidCursor", "The Inbox pagination token is too large.", 400);
    let decoded: any;
    try { decoded = this.tokens.decode<any>("ses-inbox", value); } catch { throw new AwsError("InvalidCursor", "The Inbox pagination token is invalid.", 400); }
    if (
      decoded.accountId !== this.store.accountId
      || decoded.region !== this.region
      || decoded.recipient !== recipient
      || decoded.originService !== originService
      || decoded.status !== status
      || decoded.pageSize !== pageSize
      || decoded.expiresAt <= this.clock.now()
    ) throw new AwsError("InvalidCursor", "The Inbox pagination token does not match this query.", 400);
    if (decoded.purgeGeneration !== this.mailbox.usage().purgeGeneration) throw new AwsError("StaleCursor", "The Inbox changed after this cursor was issued. Restart from the first page.", 409);
    return decoded;
  }

  async handleLocal(req: IncomingMessage, res: ServerResponse, url: URL, _requestId: string): Promise<void> {
    securityHeaders(res);
    try {
      if (!this.admitted || this.shuttingDown) throw new AwsError("ServiceUnavailable", "The regional SES mailbox is not available.", 503);
      const path = url.pathname.slice("/_stacksim/api/ses/".length);
      if (path === "account/profile" && req.method === "POST") {
        this.exactQuery(url, new Set());
        this.validateLocalMutation(req, true);
        const body = await readJson(req);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || Object.keys(body).sort().join(",") !== "confirmation,profile"
          || !["PRODUCTION", "SANDBOX"].includes(String((body as any).profile))
          || (body as any).confirmation !== (body as any).profile
        ) throw new AwsError("InvalidRequest", "The account-profile request requires an explicitly confirmed PRODUCTION or SANDBOX profile.", 400);
        return json(res, await this.setLocalAccountProfile((body as any).profile));
      }
      const localDomainVerification = path.match(/^identities\/([^/]+)\/verify-local$/);
      if (localDomainVerification && req.method === "POST") {
        this.exactQuery(url, new Set());
        this.validateLocalMutation(req, true);
        const suppliedIdentity = this.decodeLocalPathSegment(localDomainVerification[1], "domain identity");
        const parsed = canonicalIdentity(suppliedIdentity);
        const body = await readJson(req);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || Object.keys(body).join(",") !== "confirmation"
          || (body as any).confirmation !== parsed.canonical
        ) throw new AwsError("InvalidRequest", `Enter ${parsed.canonical} to confirm local-only domain verification.`, 400);
        return json(res, await this.verifyDomainForLocalUse(suppliedIdentity));
      }
      if (path === "inbox" && req.method === "GET") {
        this.exactQuery(url, new Set(["recipient", "originService", "status", "pageSize", "nextToken"]));
        const recipient = url.searchParams.has("recipient") ? normalizeMailboxKey(url.searchParams.get("recipient")!) : undefined;
        const originService = url.searchParams.get("originService") ?? undefined;
        if (originService !== undefined && !/^[a-z0-9-]{1,64}$/.test(originService)) {
          throw new AwsError("InvalidRequest", "originService is invalid.", 400);
        }
        const status = url.searchParams.get("status") ?? "all";
        if (!["all", "unread", "trash"].includes(status)) throw new AwsError("InvalidRequest", "status must be all, unread, or trash.", 400);
        const pageSizeText = url.searchParams.get("pageSize");
        const pageSize = pageSizeText === null ? 50 : Number(pageSizeText);
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AwsError("InvalidRequest", "pageSize must be an integer from 1 through 100.", 400);
        const suppliedToken = url.searchParams.get("nextToken");
        const cursor = suppliedToken ? this.inboxCursor(suppliedToken, recipient, originService, status, pageSize) : undefined;
        const page = this.mailbox.list({ ...(recipient ? { recipient } : {}), ...(originService ? { originService } : {}), status, pageSize, ...(cursor?.highWater ? { highWater: cursor.highWater } : {}), ...(cursor?.after ? { after: cursor.after } : {}) });
        const nextToken = page.next ? this.tokens.encode("ses-inbox", {
          accountId: this.store.accountId,
          region: this.region,
          recipient,
          originService,
          status,
          pageSize,
          highWater: page.highWater,
          after: page.next,
          purgeGeneration: page.purgeGeneration,
          expiresAt: this.clock.now() + 60 * 60 * 1_000,
        }) : undefined;
        return json(res, {
          messages: page.messages,
          total: this.mailbox.usage().messageCount,
          ...(nextToken ? { nextToken } : {}),
        });
      }
      if (path === "inbox/recipients" && req.method === "GET") {
        this.exactQuery(url, new Set(["prefix", "limit"]));
        const prefix = url.searchParams.get("prefix") ?? "";
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20;
        return json(res, { recipients: this.mailbox.recipientSuggestions(prefix, limit) });
      }
      if (path === "inbox/purge" && req.method === "POST") {
        this.validateLocalMutation(req, true);
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["messageIds", "allTrash"].includes(key))) throw new AwsError("InvalidRequest", "The purge request body is invalid.", 400);
        return json(res, this.mailbox.purge(body));
      }
      const attachmentMatch = path.match(/^inbox\/([^/]+)\/attachments\/([^/]+)$/);
      if (attachmentMatch && req.method === "GET") {
        this.exactQuery(url, new Set());
        const messageId = this.decodeLocalPathSegment(attachmentMatch[1], "message ID");
        const attachmentId = this.decodeLocalPathSegment(attachmentMatch[2], "attachment ID");
        const attachment = this.mailbox.getAttachment(messageId, attachmentId);
        if (!attachment) throw new AwsError("NotFound", "The attachment was not found.", 404);
        res.statusCode = 200;
        res.setHeader("content-type", attachment.contentType || "application/octet-stream");
        const fallback = String(attachment.filename ?? "attachment").replace(/[^\x20-\x7e]|["\\]/g, "_");
        res.setHeader("content-disposition", `attachment; filename="${fallback}"`);
        res.end(Buffer.from(attachment.content));
        return;
      }
      const rawMatch = path.match(/^inbox\/([^/]+)\/raw$/);
      if (rawMatch && req.method === "GET") {
        this.exactQuery(url, new Set(["variant"]));
        const variant = url.searchParams.get("variant") ?? "normalized";
        if (!["normalized", "original"].includes(variant)) throw new AwsError("InvalidRequest", "variant must be normalized or original.", 400);
        const raw = this.mailbox.getRaw(this.decodeLocalPathSegment(rawMatch[1], "message ID"), variant);
        if (!raw) throw new AwsError("NotFound", "The requested raw message variant was not found.", 404);
        res.statusCode = 200;
        res.setHeader("content-type", "message/rfc822");
        res.setHeader("content-disposition", `attachment; filename="message-${rawMatch[1].replace(/[^A-Za-z0-9_-]/g, "_")}.eml"`);
        res.end(Buffer.from(raw));
        return;
      }
      const messageMatch = path.match(/^inbox\/([^/]+)$/);
      if (messageMatch) {
        this.exactQuery(url, new Set());
        const messageId = this.decodeLocalPathSegment(messageMatch[1], "message ID");
        if (req.method === "GET") {
          const detail = this.mailbox.detail(messageId);
          if (!detail) throw new AwsError("NotFound", "The captured message was not found.", 404);
          return json(res, { message: detail });
        }
        if (req.method === "PATCH") {
          this.validateLocalMutation(req, true);
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !["read", "deleted"].includes(key)) || Object.values(body).some(value => typeof value !== "boolean")) throw new AwsError("InvalidRequest", "PATCH accepts only Boolean read and deleted fields.", 400);
          const detail = this.mailbox.update(messageId, body, this.clock.now());
          if (!detail) throw new AwsError("NotFound", "The captured message was not found.", 404);
          return json(res, { message: detail });
        }
        if (req.method === "DELETE") {
          this.validateLocalMutation(req, false);
          const detail = this.mailbox.softDelete(messageId, this.clock.now());
          if (!detail) throw new AwsError("NotFound", "The captured message was not found.", 404);
          return json(res, { message: detail });
        }
      }
      throw new AwsError("NotFound", "Unknown local SES Inbox route.", 404);
    } catch (error) {
      this.localError(res, error);
    }
  }
}
