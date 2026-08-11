export type SesApiFamily = "ses-v1" | "ses-v2";
export type SesPhase = "SES-01" | "SES-02" | "SES-04" | "SES-05" | "SES-06";
export type SesActionStatus = "implemented" | "planned" | "dependency-blocked";

export interface SesActionInventoryEntry {
  action: string;
  apiFamily: SesApiFamily;
  phase: SesPhase;
  expandsIn?: readonly SesPhase[];
  status: SesActionStatus;
  inputDepth: "phase-complete" | "phase-planned" | "dependency-boundary";
  responseDepth: "phase-complete" | "phase-planned" | "dependency-boundary";
  iamTarget: string;
  tests: string;
}

export const SES_ACTION_INVENTORY_SOURCE = {
  verifiedAt: "2026-07-23",
  classic: {
    package: "@aws-sdk/client-ses",
    version: "3.1093.0",
    commandExports: 71,
    protocol: "AWS Query/XML 2010-12-01",
    documentation: "https://docs.aws.amazon.com/ses/latest/APIReference/API_Operations.html",
  },
  v2: {
    package: "@aws-sdk/client-sesv2",
    version: "3.1093.0",
    commandExports: 112,
    documentedOperations: 111,
    protocol: "REST-JSON 2019-09-27",
    documentation: "https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Operations.html",
    drift: "PutAccountPricingAttributes is exported by the pinned SDK but is not listed in the official web operation index.",
  },
} as const;

const SES_V1_PRIMARY_PHASE_ACTIONS = {
  "SES-01": [
    "DeleteIdentity", "DeleteVerifiedEmailAddress", "GetAccountSendingEnabled", "GetIdentityVerificationAttributes",
    "GetSendQuota", "GetSendStatistics", "ListIdentities", "ListVerifiedEmailAddresses", "SendEmail", "SendRawEmail",
    "UpdateAccountSendingEnabled", "VerifyEmailAddress", "VerifyEmailIdentity",
  ],
  "SES-02": [
    "CreateConfigurationSet", "CreateTemplate", "DeleteConfigurationSet", "DeleteTemplate", "DescribeConfigurationSet",
    "GetTemplate", "ListConfigurationSets", "ListTemplates", "SendTemplatedEmail", "TestRenderTemplate",
    "UpdateConfigurationSetSendingEnabled", "UpdateTemplate",
  ],
  "SES-04": [
    "CreateConfigurationSetEventDestination", "CreateConfigurationSetTrackingOptions", "CreateCustomVerificationEmailTemplate",
    "DeleteConfigurationSetEventDestination", "DeleteConfigurationSetTrackingOptions", "DeleteCustomVerificationEmailTemplate",
    "DeleteIdentityPolicy", "GetCustomVerificationEmailTemplate", "GetIdentityDkimAttributes",
    "GetIdentityMailFromDomainAttributes", "GetIdentityNotificationAttributes", "GetIdentityPolicies",
    "ListCustomVerificationEmailTemplates", "ListIdentityPolicies", "PutConfigurationSetDeliveryOptions",
    "PutIdentityPolicy", "SendBulkTemplatedEmail", "SendCustomVerificationEmail", "SetIdentityDkimEnabled",
    "SetIdentityFeedbackForwardingEnabled", "SetIdentityHeadersInNotificationsEnabled", "SetIdentityMailFromDomain",
    "SetIdentityNotificationTopic", "UpdateConfigurationSetEventDestination",
    "UpdateConfigurationSetReputationMetricsEnabled", "UpdateConfigurationSetTrackingOptions",
    "UpdateCustomVerificationEmailTemplate", "VerifyDomainDkim", "VerifyDomainIdentity",
  ],
  "SES-05": [
    "CloneReceiptRuleSet", "CreateReceiptFilter", "CreateReceiptRule", "CreateReceiptRuleSet", "DeleteReceiptFilter",
    "DeleteReceiptRule", "DeleteReceiptRuleSet", "DescribeActiveReceiptRuleSet", "DescribeReceiptRule",
    "DescribeReceiptRuleSet", "ListReceiptFilters", "ListReceiptRuleSets", "ReorderReceiptRuleSet", "SendBounce",
    "SetActiveReceiptRuleSet", "SetReceiptRulePosition", "UpdateReceiptRule",
  ],
  "SES-06": [],
} as const satisfies Record<SesPhase, readonly string[]>;

const SES_V2_PRIMARY_PHASE_ACTIONS = {
  "SES-01": [
    "CreateEmailIdentity", "DeleteEmailIdentity", "GetAccount", "GetEmailIdentity", "ListEmailIdentities",
    "ListTagsForResource", "PutAccountSendingAttributes", "SendEmail", "TagResource", "UntagResource",
  ],
  "SES-02": [
    "CreateConfigurationSet", "CreateEmailTemplate", "DeleteConfigurationSet", "DeleteEmailTemplate",
    "GetConfigurationSet", "GetEmailTemplate", "ListConfigurationSets", "ListEmailTemplates",
    "PutConfigurationSetSendingOptions", "PutEmailIdentityConfigurationSetAttributes", "TestRenderEmailTemplate",
    "UpdateEmailTemplate",
  ],
  "SES-04": [
    "BatchGetMetricData", "CreateConfigurationSetEventDestination", "CreateContact", "CreateContactList",
    "CreateCustomVerificationEmailTemplate", "CreateEmailIdentityPolicy", "DeleteConfigurationSetEventDestination",
    "DeleteContact", "DeleteContactList", "DeleteCustomVerificationEmailTemplate", "DeleteEmailIdentityPolicy",
    "DeleteSuppressedDestination", "GetConfigurationSetEventDestinations", "GetContact", "GetContactList",
    "GetCustomVerificationEmailTemplate", "GetEmailIdentityPolicies", "GetMessageInsights", "GetSuppressedDestination",
    "ListContactLists", "ListContacts", "ListCustomVerificationEmailTemplates", "ListSuppressedDestinations",
    "PutAccountDetails", "PutAccountSuppressionAttributes", "PutConfigurationSetDeliveryOptions",
    "PutConfigurationSetReputationOptions", "PutConfigurationSetSuppressionOptions", "PutConfigurationSetTrackingOptions",
    "PutEmailIdentityDkimAttributes", "PutEmailIdentityDkimSigningAttributes", "PutEmailIdentityFeedbackAttributes",
    "PutEmailIdentityMailFromAttributes", "PutSuppressedDestination", "SendBulkEmail", "SendCustomVerificationEmail",
    "UpdateConfigurationSetEventDestination", "UpdateContact", "UpdateContactList",
    "UpdateCustomVerificationEmailTemplate", "UpdateEmailIdentityPolicy",
  ],
  "SES-05": [],
  "SES-06": [
    "CancelExportJob", "CreateDedicatedIpPool", "CreateDeliverabilityTestReport", "CreateExportJob", "CreateImportJob",
    "CreateMultiRegionEndpoint", "CreateTenant", "CreateTenantResourceAssociation", "DeleteDedicatedIpPool",
    "DeleteMultiRegionEndpoint", "DeleteTenant", "DeleteTenantResourceAssociation", "GetBlacklistReports", "GetDedicatedIp",
    "GetDedicatedIpPool", "GetDedicatedIps", "GetDeliverabilityDashboardOptions", "GetDeliverabilityTestReport",
    "GetDomainDeliverabilityCampaign", "GetDomainStatisticsReport", "GetEmailAddressInsights", "GetExportJob", "GetImportJob",
    "GetMultiRegionEndpoint", "GetReputationEntity", "GetTenant", "ListDedicatedIpPools", "ListDeliverabilityTestReports",
    "ListDomainDeliverabilityCampaigns", "ListExportJobs", "ListImportJobs", "ListMultiRegionEndpoints", "ListRecommendations",
    "ListReputationEntities", "ListResourceTenants", "ListTenantResources", "ListTenants",
    "PutAccountDedicatedIpWarmupAttributes", "PutAccountPricingAttributes", "PutAccountVdmAttributes",
    "PutConfigurationSetArchivingOptions", "PutConfigurationSetVdmOptions", "PutDedicatedIpInPool",
    "PutDedicatedIpPoolScalingAttributes", "PutDedicatedIpWarmupAttributes", "PutDeliverabilityDashboardOption",
    "PutTenantSuppressionAttributes", "UpdateReputationEntityCustomerManagedStatus", "UpdateReputationEntityPolicy",
  ],
} as const satisfies Record<SesPhase, readonly string[]>;

const V2_EXPANSIONS: Readonly<Record<string, readonly SesPhase[]>> = {
  GetAccount: ["SES-04", "SES-06"],
  GetConfigurationSet: ["SES-04", "SES-06"],
  GetEmailIdentity: ["SES-02", "SES-04"],
  ListTagsForResource: ["SES-02", "SES-04", "SES-06"],
  SendEmail: ["SES-02"],
  TagResource: ["SES-02", "SES-04", "SES-06"],
  UntagResource: ["SES-02", "SES-04", "SES-06"],
};

function statusForPhase(phase: SesPhase): SesActionStatus {
  if (phase === "SES-01" || phase === "SES-02" || phase === "SES-04") return "implemented";
  if (phase === "SES-06") return "dependency-blocked";
  return "planned";
}

function inventory(
  apiFamily: SesApiFamily,
  phases: Readonly<Record<SesPhase, readonly string[]>>,
): readonly SesActionInventoryEntry[] {
  return Object.entries(phases).flatMap(([phase, actions]) => actions.map(action => {
    const owner = phase as SesPhase;
    const status = statusForPhase(owner);
    const depth = status === "implemented" ? "phase-complete" : status === "planned" ? "phase-planned" : "dependency-boundary";
    const expandsIn = apiFamily === "ses-v2" ? V2_EXPANSIONS[action] : undefined;
    return {
      action,
      apiFamily,
      phase: owner,
      ...(expandsIn ? { expandsIn } : {}),
      status,
      inputDepth: depth,
      responseDepth: depth,
      iamTarget: `ses:${action}`,
      tests: `${owner} official-client, raw-protocol, IAM, validation, and restart coverage`,
    } as SesActionInventoryEntry;
  })).sort((left, right) => left.action.localeCompare(right.action));
}

/** Exact command exports from @aws-sdk/client-ses@3.1093.0, excluding the abstract $Command export. */
export const SES_V1_ACTION_INVENTORY = inventory("ses-v1", SES_V1_PRIMARY_PHASE_ACTIONS);
/** Exact command exports from @aws-sdk/client-sesv2@3.1093.0, excluding the abstract $Command export. */
export const SES_V2_ACTION_INVENTORY = inventory("ses-v2", SES_V2_PRIMARY_PHASE_ACTIONS);

export const SES_V1_ACTIONS = SES_V1_ACTION_INVENTORY.map(entry => entry.action);
export const SES_V2_ACTIONS = SES_V2_ACTION_INVENTORY.map(entry => entry.action);

export const SES_V1_SES01_ACTIONS = [...SES_V1_PRIMARY_PHASE_ACTIONS["SES-01"]].sort();
export const SES_V1_SES02_ACTIONS = [...SES_V1_PRIMARY_PHASE_ACTIONS["SES-02"]].sort();
export const SES_V1_SES04_ACTIONS = [...SES_V1_PRIMARY_PHASE_ACTIONS["SES-04"]].sort();
export const SES_V2_SES01_ACTIONS = [...SES_V2_PRIMARY_PHASE_ACTIONS["SES-01"]].sort();
export const SES_V2_SES02_ACTIONS = [
  ...SES_V2_PRIMARY_PHASE_ACTIONS["SES-02"],
  "GetEmailIdentity",
  "ListTagsForResource",
  "SendEmail",
  "TagResource",
  "UntagResource",
].sort();
export const SES_V2_SES04_ACTIONS = [
  ...SES_V2_PRIMARY_PHASE_ACTIONS["SES-04"],
  "GetAccount", "GetConfigurationSet", "GetEmailIdentity",
  "ListTagsForResource", "TagResource", "UntagResource",
].sort();

export const SES_IMPLEMENTED_V1_ACTIONS = SES_V1_ACTION_INVENTORY
  .filter(entry => entry.status === "implemented")
  .map(entry => entry.action);
export const SES_IMPLEMENTED_V2_ACTIONS = SES_V2_ACTION_INVENTORY
  .filter(entry => entry.status === "implemented" || entry.expandsIn?.some(phase => phase === "SES-02" || phase === "SES-04"))
  .map(entry => entry.action);
