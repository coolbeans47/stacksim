import { createHash } from "node:crypto";
import type { SesService } from "../../ses.js";
import { AwsError } from "../../errors.js";
import { parseMailboxAddress } from "../../ses/validation.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderCreateResult,
  type ProviderDeleteResult,
  type ProviderOperation,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const SES_EMAIL_IDENTITY_TYPE = "AWS::SES::EmailIdentity";
export const SES_CONFIGURATION_SET_TYPE = "AWS::SES::ConfigurationSet";
export const SES_TEMPLATE_TYPE = "AWS::SES::Template";
export const SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE = "AWS::SES::ConfigurationSetEventDestination";
export const SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE = "AWS::SES::CustomVerificationEmailTemplate";
export const SES_CONTACT_LIST_TYPE = "AWS::SES::ContactList";
export const SES_CLOUDFORMATION_RESOURCE_TYPES = Object.freeze([
  SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
  SES_CONFIGURATION_SET_TYPE,
  SES_CONTACT_LIST_TYPE,
  SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
  SES_EMAIL_IDENTITY_TYPE,
  SES_TEMPLATE_TYPE,
] as const);

export const SES_CFN_STACK_ID_TAG = "aws:cloudformation:stack-id";
export const SES_CFN_LOGICAL_ID_TAG = "aws:cloudformation:logical-id";
export const SES_CFN_RESOURCE_OPERATION_ID_TAG = "aws:cloudformation:resource-operation-id";
export const SES_CFN_SYSTEM_TAG_KEYS = Object.freeze([
  SES_CFN_STACK_ID_TAG,
  SES_CFN_LOGICAL_ID_TAG,
  SES_CFN_RESOURCE_OPERATION_ID_TAG,
] as const);

type SesCloudFormationResourceType = typeof SES_CLOUDFORMATION_RESOURCE_TYPES[number];
type SesAuthorizationMatrix = Readonly<Record<SesCloudFormationResourceType, Readonly<Record<ProviderOperation, readonly string[]>>>>;

export const SES_CLOUDFORMATION_AUTHORIZATION_MATRIX: SesAuthorizationMatrix = Object.freeze({
  [SES_EMAIL_IDENTITY_TYPE]: Object.freeze({
    CREATE: Object.freeze(["ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:ListTagsForResource", "ses:TagResource", "ses:UntagResource"]),
    READ: Object.freeze(["ses:GetEmailIdentity", "ses:ListTagsForResource"]),
    UPDATE: Object.freeze(["ses:GetEmailIdentity", "ses:ListTagsForResource", "ses:PutEmailIdentityConfigurationSetAttributes", "ses:TagResource", "ses:UntagResource"]),
    DELETE: Object.freeze(["ses:GetEmailIdentity", "ses:ListTagsForResource", "ses:DeleteEmailIdentity"]),
  }),
  [SES_CONFIGURATION_SET_TYPE]: Object.freeze({
    CREATE: Object.freeze(["ses:CreateConfigurationSet", "ses:DescribeConfigurationSet", "ses:GetConfigurationSet", "ses:ListTagsForResource", "ses:TagResource", "ses:UntagResource"]),
    READ: Object.freeze(["ses:DescribeConfigurationSet", "ses:GetConfigurationSet", "ses:ListTagsForResource"]),
    UPDATE: Object.freeze(["ses:DescribeConfigurationSet", "ses:GetConfigurationSet", "ses:ListTagsForResource", "ses:PutConfigurationSetSendingOptions", "ses:TagResource", "ses:UntagResource"]),
    DELETE: Object.freeze(["ses:DescribeConfigurationSet", "ses:GetConfigurationSet", "ses:ListTagsForResource", "ses:DeleteConfigurationSet"]),
  }),
  [SES_TEMPLATE_TYPE]: Object.freeze({
    CREATE: Object.freeze(["ses:CreateEmailTemplate", "ses:GetEmailTemplate", "ses:ListTagsForResource", "ses:TagResource", "ses:UntagResource"]),
    READ: Object.freeze(["ses:GetEmailTemplate", "ses:ListTagsForResource"]),
    UPDATE: Object.freeze(["ses:GetEmailTemplate", "ses:ListTagsForResource", "ses:UpdateEmailTemplate", "ses:TagResource", "ses:UntagResource"]),
    DELETE: Object.freeze(["ses:GetEmailTemplate", "ses:ListTagsForResource", "ses:DeleteEmailTemplate"]),
  }),
  [SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE]: Object.freeze({
    CREATE: Object.freeze(["ses:CreateConfigurationSetEventDestination", "ses:GetConfigurationSetEventDestinations"]),
    READ: Object.freeze(["ses:GetConfigurationSetEventDestinations"]),
    UPDATE: Object.freeze(["ses:GetConfigurationSetEventDestinations", "ses:CreateConfigurationSetEventDestination", "ses:UpdateConfigurationSetEventDestination", "ses:DeleteConfigurationSetEventDestination"]),
    DELETE: Object.freeze(["ses:GetConfigurationSetEventDestinations", "ses:DeleteConfigurationSetEventDestination"]),
  }),
  [SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE]: Object.freeze({
    CREATE: Object.freeze(["ses:CreateCustomVerificationEmailTemplate", "ses:GetCustomVerificationEmailTemplate", "ses:ListTagsForResource", "ses:TagResource", "ses:UntagResource"]),
    READ: Object.freeze(["ses:GetCustomVerificationEmailTemplate", "ses:ListTagsForResource"]),
    UPDATE: Object.freeze(["ses:GetCustomVerificationEmailTemplate", "ses:ListTagsForResource", "ses:UpdateCustomVerificationEmailTemplate", "ses:TagResource", "ses:UntagResource"]),
    DELETE: Object.freeze(["ses:GetCustomVerificationEmailTemplate", "ses:ListTagsForResource", "ses:DeleteCustomVerificationEmailTemplate"]),
  }),
  [SES_CONTACT_LIST_TYPE]: Object.freeze({
    CREATE: Object.freeze(["ses:CreateContactList", "ses:GetContactList", "ses:ListTagsForResource", "ses:TagResource", "ses:UntagResource"]),
    READ: Object.freeze(["ses:GetContactList", "ses:ListTagsForResource"]),
    UPDATE: Object.freeze(["ses:GetContactList", "ses:ListTagsForResource", "ses:UpdateContactList", "ses:TagResource", "ses:UntagResource"]),
    DELETE: Object.freeze(["ses:GetContactList", "ses:ListTagsForResource", "ses:DeleteContactList"]),
  }),
});

export const SES_CLOUDFORMATION_EXECUTION_ACTIONS = Object.freeze(
  [...new Set(Object.values(SES_CLOUDFORMATION_AUTHORIZATION_MATRIX)
    .flatMap(operations => Object.values(operations).flat()))].sort(),
);

export interface SesCloudFormationTag {
  readonly Key: string;
  readonly Value: string;
}

export interface SesEmailIdentityModel {
  readonly EmailIdentity: string;
  readonly ConfigurationSetAttributes?: Readonly<{ ConfigurationSetName?: string }>;
  readonly Tags: readonly SesCloudFormationTag[];
}

export interface SesConfigurationSetModel {
  readonly Name: string;
  readonly SendingOptions: Readonly<{ SendingEnabled: boolean }>;
  readonly Tags: readonly SesCloudFormationTag[];
}

export interface SesTemplateModel {
  readonly Template: Readonly<{
    TemplateName: string;
    SubjectPart: string;
    TextPart?: string;
    HtmlPart?: string;
  }>;
  readonly Tags: readonly SesCloudFormationTag[];
}

export interface SesConfigurationSetEventDestinationModel {
  readonly ConfigurationSetName: string;
  readonly EventDestination: Readonly<Record<string, unknown>>;
}

export interface SesCustomVerificationTemplateModel {
  readonly TemplateName: string;
  readonly FromEmailAddress: string;
  readonly TemplateSubject: string;
  readonly TemplateContent: string;
  readonly SuccessRedirectionURL: string;
  readonly FailureRedirectionURL: string;
  readonly Tags: readonly SesCloudFormationTag[];
}

export interface SesContactListModel {
  readonly ContactListName: string;
  readonly Description?: string;
  readonly Topics: readonly Readonly<Record<string, unknown>>[];
  readonly Tags: readonly SesCloudFormationTag[];
}

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const STACK_TAGS = Object.freeze({
  behavior: "STACK_AND_RESOURCE" as const,
  propertyName: "Tags",
  propagatesCloudFormationTags: true,
});

export const SES_EMAIL_IDENTITY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SES_EMAIL_IDENTITY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    EmailIdentity: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    ConfigurationSetAttributes: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The exact SES identity string." }),
  attributes: Object.freeze({
    DkimDNSTokenName1: Object.freeze({ valueType: "string" }),
    DkimDNSTokenName2: Object.freeze({ valueType: "string" }),
    DkimDNSTokenName3: Object.freeze({ valueType: "string" }),
    DkimDNSTokenValue1: Object.freeze({ valueType: "string" }),
    DkimDNSTokenValue2: Object.freeze({ valueType: "string" }),
    DkimDNSTokenValue3: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const SES_CONFIGURATION_SET_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SES_CONFIGURATION_SET_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    SendingOptions: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The SES configuration-set name." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const SES_TEMPLATE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SES_TEMPLATE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Template: Object.freeze({ valueType: "object", updateBehavior: "CONDITIONAL_REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The SES template ID/name." }),
  attributes: Object.freeze({ Id: Object.freeze({ valueType: "string", description: "The SES template ID/name." }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const SES_CONFIGURATION_SET_EVENT_DESTINATION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ConfigurationSetName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    EventDestination: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Stable configuration-set event-destination ID." }),
  attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false }),
});

export const SES_CUSTOM_VERIFICATION_TEMPLATE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    TemplateName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    FromEmailAddress: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    TemplateSubject: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    TemplateContent: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    SuccessRedirectionURL: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    FailureRedirectionURL: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Custom verification template name." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const SES_CONTACT_LIST_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SES_CONTACT_LIST_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ContactListName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Topics: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Contact-list name." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ProviderValidationIssue[], code: ProviderValidationIssue["code"], path: string, message: string): void {
  issues.push({ code, path, message });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ProviderValidationIssue[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value).sort()) {
    if (!accepted.has(key)) issue(issues, "UnsupportedProperty", `${path}.${key}`, `${path} does not support property ${key}`);
  }
}

function validateName(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    issue(issues, "InvalidProperty", path, `${path} must contain 1-64 letters, numbers, underscores, or hyphens`);
  }
}

function validateIdentity(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0) {
    issue(issues, "InvalidProperty", path, `${path} must be a non-empty identity string without surrounding whitespace`);
    return;
  }
  if (value.includes("@")) {
    try {
      const parsed = parseMailboxAddress(value);
      if (parsed.address !== value) throw new Error("display names are not identity values");
    } catch (error) {
      issue(issues, "InvalidProperty", path, `${path} is not a valid SES email identity: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  const domain = value.toLowerCase().replace(/\.$/, "");
  if (domain.length > 255 || domain.split(".").some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) {
    issue(issues, "InvalidProperty", path, `${path} is not a valid SES domain identity`);
  }
}

function canonicalTags(value: unknown, issues?: ProviderValidationIssue[], path = "Properties.Tags"): readonly SesCloudFormationTag[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return Object.freeze([]);
  const output: SesCloudFormationTag[] = [];
  const seen = new Set<string>();
  value.forEach((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    if (!record(candidate)) {
      if (issues) issue(issues, "InvalidProperty", itemPath, `${itemPath} must be an object containing Key and Value`);
      return;
    }
    exactKeys(candidate, ["Key", "Value"], itemPath, issues ?? []);
    if (typeof candidate.Key !== "string" || !candidate.Key || candidate.Key.length > 128) {
      if (issues) issue(issues, "InvalidProperty", `${itemPath}.Key`, `${itemPath}.Key must be a non-empty string of at most 128 characters`);
      return;
    }
    if (candidate.Key.toLowerCase().startsWith("aws:")) {
      if (issues) issue(issues, "InvalidProperty", `${itemPath}.Key`, `${itemPath}.Key uses the reserved aws: prefix`);
      return;
    }
    if (seen.has(candidate.Key)) {
      if (issues) issue(issues, "InvalidProperty", `${itemPath}.Key`, `${path} contains duplicate key ${candidate.Key}`);
      return;
    }
    if (typeof candidate.Value !== "string" || candidate.Value.length > 256) {
      if (issues) issue(issues, "InvalidProperty", `${itemPath}.Value`, `${itemPath}.Value must be a string of at most 256 characters`);
      return;
    }
    seen.add(candidate.Key);
    output.push({ Key: candidate.Key, Value: candidate.Value });
  });
  if (value.length > 50 && issues) issue(issues, "InvalidProperty", path, `${path} supports at most 50 user tags`);
  return Object.freeze(output.sort((left, right) => left.Key.localeCompare(right.Key)));
}

function validateEmailIdentity(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, SES_EMAIL_IDENTITY_SCHEMA);
  if (!record(properties)) return issues;
  if (typeof properties.EmailIdentity === "string") validateIdentity(properties.EmailIdentity, "Properties.EmailIdentity", issues);
  if (record(properties.ConfigurationSetAttributes)) {
    exactKeys(properties.ConfigurationSetAttributes, ["ConfigurationSetName"], "Properties.ConfigurationSetAttributes", issues);
    if (properties.ConfigurationSetAttributes.ConfigurationSetName !== undefined) {
      validateName(properties.ConfigurationSetAttributes.ConfigurationSetName, "Properties.ConfigurationSetAttributes.ConfigurationSetName", issues);
    }
  }
  canonicalTags(properties.Tags, issues);
  return issues;
}

function validateConfigurationSet(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, SES_CONFIGURATION_SET_SCHEMA);
  if (!record(properties)) return issues;
  if (properties.Name !== undefined && typeof properties.Name === "string") validateName(properties.Name, "Properties.Name", issues);
  if (record(properties.SendingOptions)) {
    exactKeys(properties.SendingOptions, ["SendingEnabled"], "Properties.SendingOptions", issues);
    if (properties.SendingOptions.SendingEnabled !== undefined && typeof properties.SendingOptions.SendingEnabled !== "boolean") {
      issue(issues, "InvalidProperty", "Properties.SendingOptions.SendingEnabled", "Properties.SendingOptions.SendingEnabled must be a Boolean");
    }
  }
  canonicalTags(properties.Tags, issues);
  return issues;
}

function validateTemplate(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, SES_TEMPLATE_SCHEMA);
  if (!record(properties)) return issues;
  if (properties.Template === undefined) {
    issue(issues, "InvalidProperty", "Properties.Template", "InvalidRequest: Properties.Template is required to create a usable SES template");
  } else if (record(properties.Template)) {
    exactKeys(properties.Template, ["TemplateName", "SubjectPart", "TextPart", "HtmlPart"], "Properties.Template", issues);
    if (!Object.hasOwn(properties.Template, "SubjectPart")) {
      issue(issues, "MissingRequiredProperty", "Properties.Template.SubjectPart", "Properties.Template requires SubjectPart");
    } else if (typeof properties.Template.SubjectPart !== "string") {
      issue(issues, "InvalidProperty", "Properties.Template.SubjectPart", "Properties.Template.SubjectPart must be a string");
    }
    if (properties.Template.TemplateName !== undefined) validateName(properties.Template.TemplateName, "Properties.Template.TemplateName", issues);
    for (const part of ["TextPart", "HtmlPart"] as const) {
      if (properties.Template[part] !== undefined && typeof properties.Template[part] !== "string") {
        issue(issues, "InvalidProperty", `Properties.Template.${part}`, `Properties.Template.${part} must be a string`);
      }
    }
    if (typeof properties.Template.SubjectPart === "string"
      && (properties.Template.TextPart === undefined || typeof properties.Template.TextPart === "string")
      && (properties.Template.HtmlPart === undefined || typeof properties.Template.HtmlPart === "string")) {
      const bytes = Buffer.byteLength(properties.Template.SubjectPart)
        + (typeof properties.Template.TextPart === "string" ? Buffer.byteLength(properties.Template.TextPart) : 0)
        + (typeof properties.Template.HtmlPart === "string" ? Buffer.byteLength(properties.Template.HtmlPart) : 0);
      if (bytes > 500 * 1024) issue(issues, "InvalidProperty", "Properties.Template", "Properties.Template content exceeds the 500 KB SES limit");
    }
  }
  canonicalTags(properties.Tags, issues);
  return issues;
}

function validateCustomVerification(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, SES_CUSTOM_VERIFICATION_TEMPLATE_SCHEMA);
  if (!record(properties)) return issues;
  if (typeof properties.TemplateName === "string") validateName(properties.TemplateName, "Properties.TemplateName", issues);
  if (typeof properties.FromEmailAddress === "string") validateIdentity(properties.FromEmailAddress, "Properties.FromEmailAddress", issues);
  for (const name of ["TemplateSubject", "TemplateContent", "SuccessRedirectionURL", "FailureRedirectionURL"] as const) {
    if (typeof properties[name] !== "string" || !properties[name]) issue(issues, "InvalidProperty", `Properties.${name}`, `Properties.${name} must be a non-empty string`);
  }
  if (typeof properties.TemplateContent === "string" && !properties.TemplateContent.includes("{{amazonSESVerificationURL}}") && !properties.TemplateContent.includes("{{verificationURL}}")) issue(issues, "InvalidProperty", "Properties.TemplateContent", "TemplateContent must include {{verificationURL}}");
  if (typeof properties.TemplateSubject === "string" && typeof properties.TemplateContent === "string"
    && Buffer.byteLength(properties.TemplateSubject) + Buffer.byteLength(properties.TemplateContent) >= 10 * 1024 * 1024) issue(issues, "InvalidProperty", "Properties.TemplateContent", "Template email content must be below 10 MB");
  for (const name of ["SuccessRedirectionURL", "FailureRedirectionURL"] as const) if (typeof properties[name] === "string") {
    try { const url = new URL(properties[name]); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { issue(issues, "InvalidProperty", `Properties.${name}`, `Properties.${name} must be an HTTP(S) URL without credentials`); }
  }
  canonicalTags(properties.Tags, issues);
  return issues;
}

function canonicalTopics(value: unknown, issues?: ProviderValidationIssue[]): readonly Readonly<Record<string, unknown>>[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set<string>();
  const topics = value.flatMap((candidate, index) => {
    const path = `Properties.Topics[${index}]`;
    if (!record(candidate)) { if (issues) issue(issues, "InvalidProperty", path, `${path} must be an object`); return []; }
    exactKeys(candidate, ["TopicName", "DisplayName", "Description", "DefaultSubscriptionStatus"], path, issues ?? []);
    if (typeof candidate.TopicName !== "string") { if (issues) issue(issues, "InvalidProperty", `${path}.TopicName`, "TopicName is required"); return []; }
    validateName(candidate.TopicName, `${path}.TopicName`, issues ?? []);
    if (seen.has(candidate.TopicName)) { if (issues) issue(issues, "InvalidProperty", `${path}.TopicName`, "Topic names must be unique"); return []; }
    seen.add(candidate.TopicName);
    if (typeof candidate.DisplayName !== "string" || candidate.DisplayName.length > 128) if (issues) issue(issues, "InvalidProperty", `${path}.DisplayName`, "DisplayName is required and must be a string of at most 128 characters");
    if (candidate.Description !== undefined && (typeof candidate.Description !== "string" || candidate.Description.length > 500)) if (issues) issue(issues, "InvalidProperty", `${path}.Description`, "Description must be at most 500 characters");
    if (!["OPT_IN", "OPT_OUT"].includes(String(candidate.DefaultSubscriptionStatus))) if (issues) issue(issues, "InvalidProperty", `${path}.DefaultSubscriptionStatus`, "DefaultSubscriptionStatus must be OPT_IN or OPT_OUT");
    return [Object.freeze({ TopicName: candidate.TopicName, DisplayName: String(candidate.DisplayName ?? ""), ...(candidate.Description === undefined ? {} : { Description: candidate.Description }), DefaultSubscriptionStatus: candidate.DefaultSubscriptionStatus })];
  });
  if (topics.length > 20 && issues) issue(issues, "InvalidProperty", "Properties.Topics", "At most 20 topics are supported");
  return Object.freeze(topics.sort((left, right) => String(left.TopicName).localeCompare(String(right.TopicName))));
}

function validateContactList(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, SES_CONTACT_LIST_SCHEMA);
  if (!record(properties)) return issues;
  if (properties.ContactListName !== undefined) validateName(properties.ContactListName, "Properties.ContactListName", issues);
  if (properties.Description !== undefined && (typeof properties.Description !== "string" || properties.Description.length > 500)) issue(issues, "InvalidProperty", "Properties.Description", "Description must be at most 500 characters");
  canonicalTopics(properties.Topics, issues);
  canonicalTags(properties.Tags, issues);
  return issues;
}

function validateEventDestination(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, SES_CONFIGURATION_SET_EVENT_DESTINATION_SCHEMA);
  if (!record(properties)) return issues;
  if (typeof properties.ConfigurationSetName === "string") validateName(properties.ConfigurationSetName, "Properties.ConfigurationSetName", issues);
  if (record(properties.EventDestination)) {
    const destination = properties.EventDestination;
    exactKeys(destination, ["Name", "Enabled", "MatchingEventTypes", "CloudWatchDestination", "EventBridgeDestination", "KinesisFirehoseDestination", "SnsDestination", "PinpointDestination"], "Properties.EventDestination", issues);
    if (destination.Name !== undefined) validateName(destination.Name, "Properties.EventDestination.Name", issues);
    if (destination.Enabled !== undefined && typeof destination.Enabled !== "boolean") issue(issues, "InvalidProperty", "Properties.EventDestination.Enabled", "Enabled must be Boolean");
    const eventTypes = Array.isArray(destination.MatchingEventTypes) ? destination.MatchingEventTypes : [];
    const supported = new Set(["send", "reject", "renderingFailure", "bounce", "click", "SEND", "REJECT", "RENDERING_FAILURE", "BOUNCE", "CLICK"]);
    if (!eventTypes.length || eventTypes.some(value => typeof value !== "string" || !supported.has(value))) issue(issues, "InvalidProperty", "Properties.EventDestination.MatchingEventTypes", "MatchingEventTypes requires locally measurable event types");
    const branches = ["CloudWatchDestination", "EventBridgeDestination", "KinesisFirehoseDestination", "SnsDestination", "PinpointDestination"].filter(name => destination[name] !== undefined);
    if (branches.length !== 1 || !["CloudWatchDestination", "EventBridgeDestination"].includes(branches[0])) issue(issues, "InvalidProperty", "Properties.EventDestination", "Exactly one CloudWatchDestination or EventBridgeDestination is required");
    if (record(destination.CloudWatchDestination)) {
      exactKeys(destination.CloudWatchDestination, ["DimensionConfigurations"], "Properties.EventDestination.CloudWatchDestination", issues);
      const dimensions = destination.CloudWatchDestination.DimensionConfigurations;
      if (!Array.isArray(dimensions) || dimensions.length < 1 || dimensions.length > 10) {
        issue(issues, "InvalidProperty", "Properties.EventDestination.CloudWatchDestination.DimensionConfigurations", "DimensionConfigurations requires 1-10 items");
      } else dimensions.forEach((candidate, index) => {
        const path = `Properties.EventDestination.CloudWatchDestination.DimensionConfigurations[${index}]`;
        if (!record(candidate)) return issue(issues, "InvalidProperty", path, `${path} must be an object`);
        exactKeys(candidate, ["DimensionName", "DimensionValueSource", "DefaultDimensionValue"], path, issues);
        if (typeof candidate.DimensionName !== "string" || !/^[a-zA-Z0-9_:-]{1,256}$/.test(candidate.DimensionName)) issue(issues, "InvalidProperty", `${path}.DimensionName`, "DimensionName is invalid");
        if (!["messageTag", "emailHeader", "linkTag", "MESSAGE_TAG", "EMAIL_HEADER", "LINK_TAG"].includes(String(candidate.DimensionValueSource))) issue(issues, "InvalidProperty", `${path}.DimensionValueSource`, "DimensionValueSource is invalid");
        if (typeof candidate.DefaultDimensionValue !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(candidate.DefaultDimensionValue)) issue(issues, "InvalidProperty", `${path}.DefaultDimensionValue`, "DefaultDimensionValue is invalid");
      });
    }
    if (record(destination.EventBridgeDestination)) {
      exactKeys(destination.EventBridgeDestination, ["EventBusArn"], "Properties.EventDestination.EventBridgeDestination", issues);
      if (typeof destination.EventBridgeDestination.EventBusArn !== "string" || !destination.EventBridgeDestination.EventBusArn) issue(issues, "MissingRequiredProperty", "Properties.EventDestination.EventBridgeDestination.EventBusArn", "EventBusArn is required");
    }
  }
  return issues;
}

function throwIssues(issues: readonly ProviderValidationIssue[]): void {
  if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
}

function stableName(context: Pick<ProviderContext, "stackId" | "logicalId">): string {
  const stack = context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const base = `${stack}-${context.logicalId}`.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resource";
  return `${base.slice(0, Math.max(1, 63 - suffix.length))}-${suffix}`;
}

export function sesCloudFormationPhysicalId(
  typeName: string,
  properties: Readonly<Record<string, unknown>>,
): string | undefined {
  if (typeName === SES_EMAIL_IDENTITY_TYPE) return typeof properties.EmailIdentity === "string" ? properties.EmailIdentity : undefined;
  if (typeName === SES_CONFIGURATION_SET_TYPE) return typeof properties.Name === "string" ? properties.Name : undefined;
  if (typeName === SES_TEMPLATE_TYPE && record(properties.Template)) {
    return typeof properties.Template.TemplateName === "string" ? properties.Template.TemplateName : undefined;
  }
  if (typeName === SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE) return typeof properties.TemplateName === "string" ? properties.TemplateName : undefined;
  if (typeName === SES_CONTACT_LIST_TYPE) return typeof properties.ContactListName === "string" ? properties.ContactListName : undefined;
  if (typeName === SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE && typeof properties.ConfigurationSetName === "string" && record(properties.EventDestination) && typeof properties.EventDestination.Name === "string") return `${properties.ConfigurationSetName}:${properties.EventDestination.Name}`;
  return undefined;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changed<Model extends object>(previous: Model, desired: Model, names: readonly (keyof Model)[]): string[] {
  return names.filter(name => !same(previous[name], desired[name])).map(String);
}

function systemTags(context: ProviderContext): readonly SesCloudFormationTag[] {
  return Object.freeze([
    { Key: SES_CFN_LOGICAL_ID_TAG, Value: context.logicalId },
    { Key: SES_CFN_RESOURCE_OPERATION_ID_TAG, Value: context.resourceOperationId },
    { Key: SES_CFN_STACK_ID_TAG, Value: context.stackId },
  ].sort((left, right) => left.Key.localeCompare(right.Key)));
}

function serviceTags(user: readonly SesCloudFormationTag[], context: ProviderContext): readonly SesCloudFormationTag[] {
  return Object.freeze([...user, ...systemTags(context)].sort((left, right) => left.Key.localeCompare(right.Key)));
}

function tagMap(tags: readonly SesCloudFormationTag[]): Record<string, string> {
  return Object.fromEntries(tags.map(tag => [tag.Key, tag.Value]));
}

function visibleTags(tags: Readonly<Record<string, string>>): readonly SesCloudFormationTag[] {
  return Object.freeze(Object.entries(tags)
    .filter(([key]) => !key.toLowerCase().startsWith("aws:cloudformation:"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([Key, Value]) => Object.freeze({ Key, Value })));
}

function ownsResource(tags: Readonly<Record<string, string>>, context: ProviderContext): boolean {
  return tags[SES_CFN_STACK_ID_TAG] === context.stackId
    && tags[SES_CFN_LOGICAL_ID_TAG] === context.logicalId
    && typeof tags[SES_CFN_RESOURCE_OPERATION_ID_TAG] === "string"
    && tags[SES_CFN_RESOURCE_OPERATION_ID_TAG].length > 0;
}

function ownsCurrentCreate(tags: Readonly<Record<string, string>>, context: ProviderContext): boolean {
  return ownsResource(tags, context)
    && tags[SES_CFN_RESOURCE_OPERATION_ID_TAG] === context.resourceOperationId;
}

function arn(kind: "identity" | "configuration-set" | "template" | "custom-verification-email-template" | "contact-list", name: string, context: ProviderContext): string {
  return `arn:${context.partition}:ses:${context.region}:${context.accountId}:${kind}/${name}`;
}

function requestId(context: ProviderContext, operation: string): string {
  return `${context.resourceOperationId.slice(0, 24)}-${operation}`;
}

function failed<Model = unknown>(error: unknown): ProviderUpdateResult<Model> {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return {
    status: "FAILED",
    errorCode: aws.code,
    message: aws.message,
    ...(aws.status >= 500 ? { retryable: true } : {}),
  };
}

function missing(error: unknown): boolean {
  return error instanceof AwsError && new Set([
    "NotFoundException",
    "ConfigurationSetDoesNotExist",
    "TemplateDoesNotExist",
  ]).has(error.code);
}

function alreadyExists(error: unknown): boolean {
  return error instanceof AwsError && new Set([
    "AlreadyExists",
    "AlreadyExistsException",
    "ConfigurationSetAlreadyExists",
  ]).has(error.code);
}

function checkpoint<Model>(physicalId: string, context: ProviderContext): ProviderCreateResult<Model> | undefined {
  if (context.callbackContext?.stage === "create") return undefined;
  if (context.callbackContext !== undefined && context.callbackContext.stage !== undefined) {
    return { status: "FAILED", errorCode: "InvalidCallbackContext", message: "SES provider callback context is invalid" };
  }
  return {
    status: "IN_PROGRESS",
    callbackAfterMs: 0,
    checkpoint: {
      schemaVersion: 1,
      physicalId,
      callbackContext: { stage: "create" },
    },
    message: "SES physical identity and ownership operation were durably recorded before create",
  };
}

interface RawModel<Model> {
  readonly model: Model;
  readonly tags: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, unknown>>;
}

function success<Model>(physicalId: string, current: RawModel<Model>): ProviderSuccess<Model> {
  return {
    status: "SUCCESS",
    physicalId,
    model: {
      physicalId,
      properties: current.model,
      attributes: current.attributes,
    },
  };
}

function ownershipFailure<Model>(kind: string, physicalId: string): ProviderUpdateResult<Model> {
  return { status: "FAILED", errorCode: "OwnershipConflict", message: `${kind} ${physicalId} is not owned by this CloudFormation stack resource` };
}

function duplicateFailure<Model>(kind: string, physicalId: string): ProviderUpdateResult<Model> {
  return { status: "FAILED", errorCode: "AlreadyExists", message: `${kind} ${physicalId} already exists and does not carry every marker for the active CloudFormation create operation` };
}

function replacementPlan<Model extends object>(
  previous: Model | undefined,
  desired: Model,
  names: readonly (keyof Model)[],
  replacement: (keyof Model)[],
): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: names.map(String), replacementProperties: [] };
  const differences = changed(previous, desired, names);
  if (!differences.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacements = replacement.map(String).filter(name => differences.includes(name));
  return replacements.length
    ? { action: "REPLACE", desired, changedProperties: differences, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" }
    : { action: "UPDATE", desired, changedProperties: differences, replacementProperties: [] };
}

export function createSesCloudFormationProviders(service: SesService): readonly ProductionResourceProvider<any>[] {
  const execute = async (operation: string, input: Record<string, unknown>, context: ProviderContext, family: "ses-v1" | "ses-v2" = "ses-v2", protectedCreateTags = false, eventDestinationResourceId?: string): Promise<Record<string, any>> => {
    return (await service.execute(operation, input, family, requestId(context, operation), {
      ...(protectedCreateTags ? { cloudFormationSystemTagKeys: SES_CFN_SYSTEM_TAG_KEYS } : {}),
      ...(eventDestinationResourceId ? { eventDestinationResourceId } : {}),
    })) as Record<string, any>;
  };

  const listTags = async (resourceArn: string, context: ProviderContext): Promise<Record<string, string>> => {
    const response = await execute("ListTagsForResource", { ResourceArn: resourceArn }, context);
    return Object.fromEntries((response.Tags ?? []).map((tag: any) => [String(tag.Key), String(tag.Value)]));
  };

  const identityRaw = async (physicalId: string, context: ProviderContext): Promise<RawModel<SesEmailIdentityModel>> => {
    const details = await execute("GetEmailIdentity", { EmailIdentity: physicalId }, context);
    const tags = await listTags(arn("identity", physicalId, context), context);
    const tokens = Array.isArray(details.DkimAttributes?.Tokens) ? details.DkimAttributes.Tokens.map(String) : [];
    const isDomain = details.IdentityType === "DOMAIN";
    const domain = physicalId.toLowerCase().replace(/\.$/, "");
    const attributes: Record<string, string> = {};
    for (let index = 0; index < 3; index += 1) {
      const token = isDomain ? tokens[index] ?? "" : "";
      attributes[`DkimDNSTokenName${index + 1}`] = token ? `${token}._domainkey.${domain}` : "";
      attributes[`DkimDNSTokenValue${index + 1}`] = token ? `${token}.dkim.amazonses.com` : "";
    }
    return {
      model: Object.freeze({
        EmailIdentity: physicalId,
        ...(typeof details.ConfigurationSetName === "string" && details.ConfigurationSetName
          ? { ConfigurationSetAttributes: Object.freeze({ ConfigurationSetName: details.ConfigurationSetName }) }
          : {}),
        Tags: visibleTags(tags),
      }),
      tags,
      attributes: Object.freeze(attributes),
    };
  };

  const configurationSetRaw = async (physicalId: string, context: ProviderContext): Promise<RawModel<SesConfigurationSetModel>> => {
    const described = await execute("DescribeConfigurationSet", { ConfigurationSetName: physicalId }, context, "ses-v1");
    const details = await execute("GetConfigurationSet", { ConfigurationSetName: physicalId }, context);
    const describedName = String(described.ConfigurationSet?.Name ?? "");
    if (describedName !== physicalId || String(details.ConfigurationSetName ?? "") !== physicalId) {
      throw new AwsError("ResourceConflict", `SES configuration-set descriptors disagree for ${physicalId}`, 409);
    }
    const tags = await listTags(arn("configuration-set", physicalId, context), context);
    return {
      model: Object.freeze({
        Name: physicalId,
        SendingOptions: Object.freeze({ SendingEnabled: details.SendingOptions?.SendingEnabled !== false }),
        Tags: visibleTags(tags),
      }),
      tags,
      attributes: Object.freeze({}),
    };
  };

  const templateRaw = async (physicalId: string, context: ProviderContext): Promise<RawModel<SesTemplateModel>> => {
    const details = await execute("GetEmailTemplate", { TemplateName: physicalId }, context);
    const tags = await listTags(arn("template", physicalId, context), context);
    const content = details.TemplateContent ?? {};
    return {
      model: Object.freeze({
        Template: Object.freeze({
          TemplateName: physicalId,
          SubjectPart: String(content.Subject ?? ""),
          ...(content.Text === undefined ? {} : { TextPart: String(content.Text) }),
          ...(content.Html === undefined ? {} : { HtmlPart: String(content.Html) }),
        }),
        Tags: visibleTags(tags),
      }),
      tags,
      attributes: Object.freeze({ Id: physicalId }),
    };
  };

  const reconcileTags = async (
    resourceArn: string,
    currentTags: Readonly<Record<string, string>>,
    desiredTags: readonly SesCloudFormationTag[],
    context: ProviderContext,
  ): Promise<void> => {
    const wanted = tagMap(desiredTags);
    const removals = Object.keys(currentTags)
      .filter(key => !key.toLowerCase().startsWith("aws:cloudformation:") && !Object.hasOwn(wanted, key))
      .sort();
    if (removals.length) await execute("UntagResource", { ResourceArn: resourceArn, TagKeys: removals }, context);
    const additions = Object.entries(wanted)
      .filter(([key, value]) => currentTags[key] !== value)
      .map(([Key, Value]) => ({ Key, Value }));
    if (additions.length) await execute("TagResource", { ResourceArn: resourceArn, Tags: additions }, context);
  };

  const finishCreate = <Model>(
    kind: string,
    physicalId: string,
    desired: Model,
    current: RawModel<Model>,
    context: ProviderContext,
    recovering: boolean,
  ): ProviderCreateResult<Model> => {
    if (!ownsCurrentCreate(current.tags, context)) {
      return recovering ? duplicateFailure(kind, physicalId) : ownershipFailure(kind, physicalId);
    }
    if (!same(current.model, desired)) {
      return {
        status: "FAILED",
        errorCode: "ResourceConflict",
        message: `${kind} ${physicalId} owned by the active create operation does not match its intended descriptor`,
      };
    }
    return success(physicalId, current);
  };

  const identityProvider: ProductionResourceProvider<SesEmailIdentityModel> = {
    typeName: SES_EMAIL_IDENTITY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SES_EMAIL_IDENTITY_SCHEMA,
    validate(properties) { return validateEmailIdentity(properties); },
    canonicalize(properties): SesEmailIdentityModel {
      const issues = validateEmailIdentity(properties); throwIssues(issues);
      const input = properties as Record<string, unknown>;
      const configuration = input.ConfigurationSetAttributes as Record<string, unknown> | undefined;
      return Object.freeze({
        EmailIdentity: String(input.EmailIdentity),
        ...(typeof configuration?.ConfigurationSetName === "string"
          ? { ConfigurationSetAttributes: Object.freeze({ ConfigurationSetName: configuration.ConfigurationSetName }) }
          : {}),
        Tags: canonicalTags(input.Tags),
      });
    },
    plan(previous, desired) {
      return replacementPlan(previous, desired, ["EmailIdentity", "ConfigurationSetAttributes", "Tags"], ["EmailIdentity"]);
    },
    async create(desired, context): Promise<ProviderCreateResult<SesEmailIdentityModel>> {
      const pending = checkpoint<SesEmailIdentityModel>(desired.EmailIdentity, context); if (pending) return pending;
      try {
        let recovering = false;
        try {
          await execute("CreateEmailIdentity", {
            EmailIdentity: desired.EmailIdentity,
            ...(desired.ConfigurationSetAttributes?.ConfigurationSetName ? { ConfigurationSetName: desired.ConfigurationSetAttributes.ConfigurationSetName } : {}),
            Tags: serviceTags(desired.Tags, context),
          }, context, "ses-v2", true);
        } catch (error) {
          if (!alreadyExists(error)) throw error;
          recovering = true;
        }
        const current = await identityRaw(desired.EmailIdentity, context);
        return finishCreate("SES email identity", desired.EmailIdentity, desired, current, context, recovering);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SesEmailIdentityModel>> {
      try {
        const current = await identityRaw(physicalId, context);
        return ownsResource(current.tags, context) ? success(physicalId, current) : ownershipFailure("SES email identity", physicalId);
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<SesEmailIdentityModel>> {
      try {
        if (physicalId !== desired.EmailIdentity || previous.EmailIdentity !== desired.EmailIdentity) {
          return { status: "FAILED", errorCode: "RequiresReplacement", message: "EmailIdentity changes require replacement" };
        }
        let current = await identityRaw(physicalId, context);
        if (!ownsResource(current.tags, context)) return ownershipFailure("SES email identity", physicalId);
        if (same(previous, desired)) return success(physicalId, current);
        if (!same(current.model.ConfigurationSetAttributes, desired.ConfigurationSetAttributes)) {
          await execute("PutEmailIdentityConfigurationSetAttributes", {
            EmailIdentity: physicalId,
            ConfigurationSetName: desired.ConfigurationSetAttributes?.ConfigurationSetName,
          }, context);
        }
        await reconcileTags(arn("identity", physicalId, context), current.tags, desired.Tags, context);
        current = await identityRaw(physicalId, context);
        return success(physicalId, current);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const current = await identityRaw(physicalId, context);
        if (!ownsResource(current.tags, context)) return ownershipFailure("SES email identity", physicalId);
        await execute("DeleteEmailIdentity", { EmailIdentity: physicalId }, context);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) {
      if (!Object.hasOwn(SES_EMAIL_IDENTITY_SCHEMA.attributes, attribute)) throw new ProviderReferenceError(SES_EMAIL_IDENTITY_TYPE, `Fn::GetAtt ${attribute}`);
      return model.attributes[attribute];
    },
  };

  const configurationSetProvider: ProductionResourceProvider<SesConfigurationSetModel> = {
    typeName: SES_CONFIGURATION_SET_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SES_CONFIGURATION_SET_SCHEMA,
    validate(properties) { return validateConfigurationSet(properties); },
    canonicalize(properties, context): SesConfigurationSetModel {
      const issues = validateConfigurationSet(properties); throwIssues(issues);
      const input = properties as Record<string, unknown>;
      const sending = input.SendingOptions as Record<string, unknown> | undefined;
      return Object.freeze({
        Name: String(input.Name ?? stableName(context)),
        SendingOptions: Object.freeze({ SendingEnabled: sending?.SendingEnabled === undefined ? true : Boolean(sending.SendingEnabled) }),
        Tags: canonicalTags(input.Tags),
      });
    },
    plan(previous, desired) {
      return replacementPlan(previous, desired, ["Name", "SendingOptions", "Tags"], ["Name"]);
    },
    async create(desired, context): Promise<ProviderCreateResult<SesConfigurationSetModel>> {
      const pending = checkpoint<SesConfigurationSetModel>(desired.Name, context); if (pending) return pending;
      try {
        let recovering = false;
        try {
          await execute("CreateConfigurationSet", {
            ConfigurationSetName: desired.Name,
            SendingOptions: desired.SendingOptions,
            Tags: serviceTags(desired.Tags, context),
          }, context, "ses-v2", true);
        } catch (error) {
          if (!alreadyExists(error)) throw error;
          recovering = true;
        }
        const current = await configurationSetRaw(desired.Name, context);
        return finishCreate("SES configuration set", desired.Name, desired, current, context, recovering);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SesConfigurationSetModel>> {
      try {
        const current = await configurationSetRaw(physicalId, context);
        return ownsResource(current.tags, context) ? success(physicalId, current) : ownershipFailure("SES configuration set", physicalId);
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<SesConfigurationSetModel>> {
      try {
        if (physicalId !== desired.Name || previous.Name !== desired.Name) {
          return { status: "FAILED", errorCode: "RequiresReplacement", message: "Configuration-set Name changes require replacement" };
        }
        let current = await configurationSetRaw(physicalId, context);
        if (!ownsResource(current.tags, context)) return ownershipFailure("SES configuration set", physicalId);
        if (same(previous, desired)) return success(physicalId, current);
        if (!same(current.model.SendingOptions, desired.SendingOptions)) {
          await execute("PutConfigurationSetSendingOptions", {
            ConfigurationSetName: physicalId,
            SendingEnabled: desired.SendingOptions.SendingEnabled,
          }, context);
        }
        await reconcileTags(arn("configuration-set", physicalId, context), current.tags, desired.Tags, context);
        current = await configurationSetRaw(physicalId, context);
        return success(physicalId, current);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const current = await configurationSetRaw(physicalId, context);
        if (!ownsResource(current.tags, context)) return ownershipFailure("SES configuration set", physicalId);
        await execute("DeleteConfigurationSet", { ConfigurationSetName: physicalId }, context);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(_model, attribute) { throw new ProviderReferenceError(SES_CONFIGURATION_SET_TYPE, `Fn::GetAtt ${attribute}`); },
  };

  const templateProvider: ProductionResourceProvider<SesTemplateModel> = {
    typeName: SES_TEMPLATE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SES_TEMPLATE_SCHEMA,
    validate(properties) { return validateTemplate(properties); },
    canonicalize(properties, context): SesTemplateModel {
      const issues = validateTemplate(properties); throwIssues(issues);
      const input = properties as Record<string, unknown>;
      const template = input.Template as Record<string, unknown>;
      return Object.freeze({
        Template: Object.freeze({
          TemplateName: String(template.TemplateName ?? stableName(context)),
          SubjectPart: String(template.SubjectPart),
          ...(template.TextPart === undefined ? {} : { TextPart: String(template.TextPart) }),
          ...(template.HtmlPart === undefined ? {} : { HtmlPart: String(template.HtmlPart) }),
        }),
        Tags: canonicalTags(input.Tags),
      });
    },
    plan(previous, desired): ProviderPlan<SesTemplateModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: ["Tags", "Template"], replacementProperties: [] };
      const differences = changed(previous, desired, ["Template", "Tags"]);
      if (!differences.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replace = previous.Template.TemplateName !== desired.Template.TemplateName;
      return replace
        ? { action: "REPLACE", desired, changedProperties: differences, replacementProperties: ["Template.TemplateName"], replacementOrder: "CREATE_BEFORE_DELETE" }
        : { action: "UPDATE", desired, changedProperties: differences, replacementProperties: [] };
    },
    async create(desired, context): Promise<ProviderCreateResult<SesTemplateModel>> {
      if (!record(desired?.Template)) {
        return {
          status: "FAILED",
          errorCode: "InvalidRequest",
          message: "Properties.Template is required to create a usable SES template",
        };
      }
      const physicalId = desired.Template.TemplateName;
      const pending = checkpoint<SesTemplateModel>(physicalId, context); if (pending) return pending;
      try {
        let recovering = false;
        try {
          await execute("CreateEmailTemplate", {
            TemplateName: physicalId,
            TemplateContent: {
              Subject: desired.Template.SubjectPart,
              ...(desired.Template.TextPart === undefined ? {} : { Text: desired.Template.TextPart }),
              ...(desired.Template.HtmlPart === undefined ? {} : { Html: desired.Template.HtmlPart }),
            },
            Tags: serviceTags(desired.Tags, context),
          }, context, "ses-v2", true);
        } catch (error) {
          if (!alreadyExists(error)) throw error;
          recovering = true;
        }
        const current = await templateRaw(physicalId, context);
        return finishCreate("SES template", physicalId, desired, current, context, recovering);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SesTemplateModel>> {
      try {
        const current = await templateRaw(physicalId, context);
        return ownsResource(current.tags, context) ? success(physicalId, current) : ownershipFailure("SES template", physicalId);
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<SesTemplateModel>> {
      try {
        if (physicalId !== desired.Template.TemplateName || previous.Template.TemplateName !== desired.Template.TemplateName) {
          return { status: "FAILED", errorCode: "RequiresReplacement", message: "Template.TemplateName changes require replacement" };
        }
        let current = await templateRaw(physicalId, context);
        if (!ownsResource(current.tags, context)) return ownershipFailure("SES template", physicalId);
        if (same(previous, desired)) return success(physicalId, current);
        if (!same(current.model.Template, desired.Template)) {
          await execute("UpdateEmailTemplate", {
            TemplateName: physicalId,
            TemplateContent: {
              Subject: desired.Template.SubjectPart,
              ...(desired.Template.TextPart === undefined ? {} : { Text: desired.Template.TextPart }),
              ...(desired.Template.HtmlPart === undefined ? {} : { Html: desired.Template.HtmlPart }),
            },
          }, context);
        }
        await reconcileTags(arn("template", physicalId, context), current.tags, desired.Tags, context);
        current = await templateRaw(physicalId, context);
        return success(physicalId, current);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const current = await templateRaw(physicalId, context);
        if (!ownsResource(current.tags, context)) return ownershipFailure("SES template", physicalId);
        await execute("DeleteEmailTemplate", { TemplateName: physicalId }, context);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) {
      if (attribute !== "Id") throw new ProviderReferenceError(SES_TEMPLATE_TYPE, `Fn::GetAtt ${attribute}`);
      return model.attributes.Id;
    },
  };

  const customVerificationRaw = async (physicalId: string, context: ProviderContext): Promise<RawModel<SesCustomVerificationTemplateModel>> => {
    const details = await execute("GetCustomVerificationEmailTemplate", { TemplateName: physicalId }, context);
    const tags = await listTags(arn("custom-verification-email-template", physicalId, context), context);
    return {
      model: Object.freeze({
        TemplateName: physicalId,
        FromEmailAddress: String(details.FromEmailAddress),
        TemplateSubject: String(details.TemplateSubject),
        TemplateContent: String(details.TemplateContent),
        SuccessRedirectionURL: String(details.SuccessRedirectionURL),
        FailureRedirectionURL: String(details.FailureRedirectionURL),
        Tags: visibleTags(tags),
      }),
      tags,
      attributes: Object.freeze({}),
    };
  };

  const customVerificationProvider: ProductionResourceProvider<SesCustomVerificationTemplateModel> = {
    typeName: SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE, providerVersion: 1, visibility: "production", schema: SES_CUSTOM_VERIFICATION_TEMPLATE_SCHEMA,
    validate: validateCustomVerification,
    canonicalize(properties): SesCustomVerificationTemplateModel {
      const issues = validateCustomVerification(properties); throwIssues(issues); const input = properties as Record<string, unknown>;
      return Object.freeze({
        TemplateName: String(input.TemplateName), FromEmailAddress: String(input.FromEmailAddress),
        TemplateSubject: String(input.TemplateSubject), TemplateContent: String(input.TemplateContent),
        SuccessRedirectionURL: String(input.SuccessRedirectionURL), FailureRedirectionURL: String(input.FailureRedirectionURL),
        Tags: canonicalTags(input.Tags),
      });
    },
    plan(previous, desired) { return replacementPlan(previous, desired, ["TemplateName", "FromEmailAddress", "TemplateSubject", "TemplateContent", "SuccessRedirectionURL", "FailureRedirectionURL", "Tags"], ["TemplateName"]); },
    async create(desired, context) {
      const pending = checkpoint<SesCustomVerificationTemplateModel>(desired.TemplateName, context); if (pending) return pending;
      try {
        let recovering = false;
        try { await execute("CreateCustomVerificationEmailTemplate", { ...desired, Tags: serviceTags(desired.Tags, context) }, context, "ses-v2", true); }
        catch (error) { if (!alreadyExists(error)) throw error; recovering = true; }
        const current = await customVerificationRaw(desired.TemplateName, context);
        return finishCreate("SES custom verification template", desired.TemplateName, desired, current, context, recovering);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context) {
      try { const current = await customVerificationRaw(physicalId, context); return ownsResource(current.tags, context) ? success(physicalId, current) : ownershipFailure("SES custom verification template", physicalId); }
      catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired, context) {
      try {
        if (physicalId !== desired.TemplateName || previous.TemplateName !== desired.TemplateName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "TemplateName changes require replacement" };
        let current = await customVerificationRaw(physicalId, context); if (!ownsResource(current.tags, context)) return ownershipFailure("SES custom verification template", physicalId);
        if (!same({ ...current.model, Tags: [] }, { ...desired, Tags: [] })) await execute("UpdateCustomVerificationEmailTemplate", { ...desired, Tags: undefined }, context);
        await reconcileTags(arn("custom-verification-email-template", physicalId, context), current.tags, desired.Tags, context);
        current = await customVerificationRaw(physicalId, context); return success(physicalId, current);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context) {
      try { const current = await customVerificationRaw(physicalId, context); if (!ownsResource(current.tags, context)) return ownershipFailure("SES custom verification template", physicalId); await execute("DeleteCustomVerificationEmailTemplate", { TemplateName: physicalId }, context); return { status: "SUCCESS", physicalId }; }
      catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(_model, attribute) { throw new ProviderReferenceError(SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE, `Fn::GetAtt ${attribute}`); },
  };

  const contactListRaw = async (physicalId: string, context: ProviderContext): Promise<RawModel<SesContactListModel>> => {
    const details = await execute("GetContactList", { ContactListName: physicalId }, context);
    const tags = await listTags(arn("contact-list", physicalId, context), context);
    return {
      model: Object.freeze({
        ContactListName: physicalId,
        ...(details.Description === undefined ? {} : { Description: String(details.Description) }),
        Topics: Object.freeze((details.Topics ?? []).map((topic: any) => Object.freeze({
          TopicName: String(topic.TopicName), DisplayName: String(topic.DisplayName),
          ...(topic.Description === undefined ? {} : { Description: String(topic.Description) }),
          DefaultSubscriptionStatus: String(topic.DefaultSubscriptionStatus),
        })).sort((left: any, right: any) => left.TopicName.localeCompare(right.TopicName))),
        Tags: visibleTags(tags),
      }),
      tags,
      attributes: Object.freeze({}),
    };
  };

  const contactListProvider: ProductionResourceProvider<SesContactListModel> = {
    typeName: SES_CONTACT_LIST_TYPE, providerVersion: 1, visibility: "production", schema: SES_CONTACT_LIST_SCHEMA,
    validate: validateContactList,
    canonicalize(properties, context): SesContactListModel {
      const issues = validateContactList(properties); throwIssues(issues); const input = properties as Record<string, unknown>;
      return Object.freeze({ ContactListName: String(input.ContactListName ?? stableName(context)), ...(input.Description === undefined ? {} : { Description: String(input.Description) }), Topics: canonicalTopics(input.Topics), Tags: canonicalTags(input.Tags) });
    },
    plan(previous, desired) { return replacementPlan(previous, desired, ["ContactListName", "Description", "Topics", "Tags"], ["ContactListName"]); },
    async create(desired, context) {
      const pending = checkpoint<SesContactListModel>(desired.ContactListName, context); if (pending) return pending;
      try {
        let recovering = false;
        try { await execute("CreateContactList", { ...desired, Tags: serviceTags(desired.Tags, context) }, context, "ses-v2", true); }
        catch (error) { if (!alreadyExists(error)) throw error; recovering = true; }
        const current = await contactListRaw(desired.ContactListName, context);
        return finishCreate("SES contact list", desired.ContactListName, desired, current, context, recovering);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context) {
      try { const current = await contactListRaw(physicalId, context); return ownsResource(current.tags, context) ? success(physicalId, current) : ownershipFailure("SES contact list", physicalId); }
      catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error); }
    },
    async update(physicalId, previous, desired, context) {
      try {
        if (physicalId !== desired.ContactListName || previous.ContactListName !== desired.ContactListName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "ContactListName changes require replacement" };
        let current = await contactListRaw(physicalId, context); if (!ownsResource(current.tags, context)) return ownershipFailure("SES contact list", physicalId);
        if (!same({ ...current.model, Tags: [] }, { ...desired, Tags: [] })) await execute("UpdateContactList", { ContactListName: physicalId, Description: desired.Description, Topics: desired.Topics }, context);
        await reconcileTags(arn("contact-list", physicalId, context), current.tags, desired.Tags, context);
        current = await contactListRaw(physicalId, context); return success(physicalId, current);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context) {
      try { const current = await contactListRaw(physicalId, context); if (!ownsResource(current.tags, context)) return ownershipFailure("SES contact list", physicalId); await execute("DeleteContactList", { ContactListName: physicalId }, context); return { status: "SUCCESS", physicalId }; }
      catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(_model, attribute) { throw new ProviderReferenceError(SES_CONTACT_LIST_TYPE, `Fn::GetAtt ${attribute}`); },
  };

  const eventCanonical = (properties: unknown, context: ProviderContext): SesConfigurationSetEventDestinationModel => {
    const issues = validateEventDestination(properties); throwIssues(issues); const input = properties as Record<string, unknown>; const raw = input.EventDestination as Record<string, unknown>;
    const eventMap: Record<string, string> = { send: "SEND", reject: "REJECT", renderingFailure: "RENDERING_FAILURE", bounce: "BOUNCE", click: "CLICK" };
    const sourceMap: Record<string, string> = { messageTag: "MESSAGE_TAG", emailHeader: "EMAIL_HEADER", linkTag: "LINK_TAG" };
    const cloudWatch = raw.CloudWatchDestination as Record<string, unknown> | undefined;
    const eventBridge = raw.EventBridgeDestination as Record<string, unknown> | undefined;
    const destination = Object.freeze({
      Name: String(raw.Name ?? stableName(context)),
      Enabled: raw.Enabled === undefined ? false : Boolean(raw.Enabled),
      MatchingEventTypes: Object.freeze((raw.MatchingEventTypes as unknown[]).map(value => eventMap[String(value)] ?? String(value)).sort()),
      ...(cloudWatch === undefined ? {} : {
        CloudWatchDestination: Object.freeze({
          DimensionConfigurations: Object.freeze((cloudWatch.DimensionConfigurations as Record<string, unknown>[]).map(item => Object.freeze({
            DimensionName: String(item.DimensionName),
            DimensionValueSource: sourceMap[String(item.DimensionValueSource)] ?? String(item.DimensionValueSource),
            DefaultDimensionValue: String(item.DefaultDimensionValue),
          })).sort((left, right) => `${left.DimensionName}\0${left.DimensionValueSource}\0${left.DefaultDimensionValue}`.localeCompare(`${right.DimensionName}\0${right.DimensionValueSource}\0${right.DefaultDimensionValue}`))),
        }),
      }),
      ...(eventBridge === undefined ? {} : { EventBridgeDestination: Object.freeze({ EventBusArn: String(eventBridge.EventBusArn) }) }),
    });
    return Object.freeze({ ConfigurationSetName: String(input.ConfigurationSetName), EventDestination: destination });
  };
  const eventChildId = (context: ProviderContext): string => createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 24);
  const eventPhysical = (parent: string, childId: string): string => `${parent.length}:${parent}${childId}`;
  const parseEventPhysical = (physicalId: string): { parent: string; childId: string } => {
    const match = physicalId.match(/^(\d+):/); if (!match) throw new AwsError("InvalidPhysicalResourceId", "The SES event-destination physical ID is invalid", 400);
    const length = Number(match[1]); const offset = match[0].length; const parent = physicalId.slice(offset, offset + length); const childId = physicalId.slice(offset + length);
    if (!parent || !/^[a-f0-9]{24}$/.test(childId)) throw new AwsError("InvalidPhysicalResourceId", "The SES event-destination physical ID is invalid", 400);
    return { parent, childId };
  };
  const eventRaw = (physicalId: string): RawModel<SesConfigurationSetEventDestinationModel> | undefined => {
    const { parent, childId } = parseEventPhysical(physicalId); const found = service.configurationEventDestination(parent, childId); if (!found) return undefined;
    return { model: Object.freeze({ ConfigurationSetName: parent, EventDestination: Object.freeze(found.view) }), tags: {}, attributes: Object.freeze({ Id: physicalId }) };
  };
  const eventDestinationProvider: ProductionResourceProvider<SesConfigurationSetEventDestinationModel> = {
    typeName: SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE, providerVersion: 1, visibility: "production", schema: SES_CONFIGURATION_SET_EVENT_DESTINATION_SCHEMA,
    validate: validateEventDestination, canonicalize: eventCanonical,
    plan(previous, desired) { return replacementPlan(previous, desired, ["ConfigurationSetName", "EventDestination"], ["ConfigurationSetName"]); },
    async create(desired, context) {
      const childId = eventChildId(context); const physicalId = eventPhysical(desired.ConfigurationSetName, childId); const pending = checkpoint<SesConfigurationSetEventDestinationModel>(physicalId, context); if (pending) return pending;
      try {
        const existing = eventRaw(physicalId); if (!existing) await execute("CreateConfigurationSetEventDestination", { ConfigurationSetName: desired.ConfigurationSetName, EventDestinationName: desired.EventDestination.Name, EventDestination: desired.EventDestination }, context, "ses-v2", false, childId);
        const current = eventRaw(physicalId);
        if (!current) return { status: "FAILED", errorCode: "NotStabilized", message: "SES event destination did not stabilize" };
        if (!same(current.model, desired)) return { status: "FAILED", errorCode: "ResourceConflict", message: `SES event destination ${physicalId} does not match the active create descriptor` };
        return success(physicalId, current);
      } catch (error) { return failed(error); }
    },
    async read(physicalId) { try { const current = eventRaw(physicalId); return current ? success(physicalId, current) : { status: "NOT_FOUND", physicalId }; } catch (error) { return failed(error); } },
    async update(physicalId, previous, desired, context) {
      try {
        const { parent, childId } = parseEventPhysical(physicalId); if (parent !== desired.ConfigurationSetName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "ConfigurationSetName changes require replacement" };
        const current = eventRaw(physicalId); if (!current) return { status: "FAILED", errorCode: "NotFound", message: `SES event destination ${physicalId} no longer exists` };
        const oldName = String((current.model.EventDestination as any).Name); const newName = String((desired.EventDestination as any).Name);
        if (oldName === newName) await execute("UpdateConfigurationSetEventDestination", { ConfigurationSetName: parent, EventDestinationName: oldName, EventDestination: desired.EventDestination }, context);
        else {
          await execute("CreateConfigurationSetEventDestination", { ConfigurationSetName: parent, EventDestinationName: newName, EventDestination: desired.EventDestination }, context, "ses-v2", false, childId);
          await execute("DeleteConfigurationSetEventDestination", { ConfigurationSetName: parent, EventDestinationName: oldName }, context);
        }
        const next = eventRaw(physicalId); return next ? success(physicalId, next) : { status: "FAILED", errorCode: "NotStabilized", message: "SES event destination update did not stabilize" };
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context) {
      try { const { parent } = parseEventPhysical(physicalId); const current = eventRaw(physicalId); if (!current) return { status: "NOT_FOUND", physicalId }; await execute("DeleteConfigurationSetEventDestination", { ConfigurationSetName: parent, EventDestinationName: String((current.model.EventDestination as any).Name) }, context); return { status: "SUCCESS", physicalId }; }
      catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { if (attribute !== "Id") throw new ProviderReferenceError(SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE, `Fn::GetAtt ${attribute}`); return model.attributes.Id; },
  };

  return Object.freeze([identityProvider, configurationSetProvider, templateProvider, eventDestinationProvider, customVerificationProvider, contactListProvider]);
}
