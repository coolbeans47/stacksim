export type SnsActionDisposition = "implemented" | "phase-deferred";

export interface SnsActionInventoryEntry {
  action: string;
  phase: "SNS-01" | "SNS-02" | "SNS-05" | "SNS-06";
  disposition: SnsActionDisposition;
  iamAction: string;
  resource: "topic" | "topic-or-target" | "subscription-parent-topic" | "platform-application" | "platform-endpoint" | "account" | "*";
  targetModes?: Readonly<Record<string, string>>;
}

export const SNS_ACTION_INVENTORY_SOURCE = {
  checked: "2026-07-27",
  sdkPackage: "@aws-sdk/client-sns",
  sdkVersion: "3.1095.0",
  url: "https://docs.aws.amazon.com/sns/latest/api/API_Operations.html",
} as const;

/**
 * Complete current SNS action inventory. The dispatcher is derived from the
 * implemented rows so a deferred action cannot become reachable by omission.
 */
export const SNS_ACTION_INVENTORY: readonly SnsActionInventoryEntry[] = [
  { action: "AddPermission", phase: "SNS-02", disposition: "implemented", iamAction: "sns:AddPermission", resource: "topic" },
  { action: "CheckIfPhoneNumberIsOptedOut", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:CheckIfPhoneNumberIsOptedOut", resource: "*" },
  { action: "ConfirmSubscription", phase: "SNS-05", disposition: "phase-deferred", iamAction: "sns:ConfirmSubscription", resource: "topic" },
  { action: "CreatePlatformApplication", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:CreatePlatformApplication", resource: "*" },
  { action: "CreatePlatformEndpoint", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:CreatePlatformEndpoint", resource: "platform-application" },
  { action: "CreateSMSSandboxPhoneNumber", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:CreateSMSSandboxPhoneNumber", resource: "*" },
  { action: "CreateTopic", phase: "SNS-01", disposition: "implemented", iamAction: "sns:CreateTopic", resource: "*" },
  { action: "DeleteEndpoint", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:DeleteEndpoint", resource: "platform-endpoint" },
  { action: "DeletePlatformApplication", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:DeletePlatformApplication", resource: "platform-application" },
  { action: "DeleteSMSSandboxPhoneNumber", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:DeleteSMSSandboxPhoneNumber", resource: "*" },
  { action: "DeleteTopic", phase: "SNS-01", disposition: "implemented", iamAction: "sns:DeleteTopic", resource: "topic" },
  { action: "GetDataProtectionPolicy", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:GetDataProtectionPolicy", resource: "topic" },
  { action: "GetEndpointAttributes", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:GetEndpointAttributes", resource: "platform-endpoint" },
  { action: "GetPlatformApplicationAttributes", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:GetPlatformApplicationAttributes", resource: "platform-application" },
  { action: "GetSMSAttributes", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:GetSMSAttributes", resource: "*" },
  { action: "GetSMSSandboxAccountStatus", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:GetSMSSandboxAccountStatus", resource: "*" },
  { action: "GetSubscriptionAttributes", phase: "SNS-01", disposition: "implemented", iamAction: "sns:GetSubscriptionAttributes", resource: "subscription-parent-topic" },
  { action: "GetTopicAttributes", phase: "SNS-01", disposition: "implemented", iamAction: "sns:GetTopicAttributes", resource: "topic" },
  { action: "ListEndpointsByPlatformApplication", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:ListEndpointsByPlatformApplication", resource: "platform-application" },
  { action: "ListOriginationNumbers", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:ListOriginationNumbers", resource: "*" },
  { action: "ListPhoneNumbersOptedOut", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:ListPhoneNumbersOptedOut", resource: "*" },
  { action: "ListPlatformApplications", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:ListPlatformApplications", resource: "*" },
  { action: "ListSMSSandboxPhoneNumbers", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:ListSMSSandboxPhoneNumbers", resource: "*" },
  { action: "ListSubscriptions", phase: "SNS-01", disposition: "implemented", iamAction: "sns:ListSubscriptions", resource: "*" },
  { action: "ListSubscriptionsByTopic", phase: "SNS-01", disposition: "implemented", iamAction: "sns:ListSubscriptionsByTopic", resource: "topic" },
  { action: "ListTagsForResource", phase: "SNS-01", disposition: "implemented", iamAction: "sns:ListTagsForResource", resource: "topic" },
  { action: "ListTopics", phase: "SNS-01", disposition: "implemented", iamAction: "sns:ListTopics", resource: "*" },
  { action: "OptInPhoneNumber", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:OptInPhoneNumber", resource: "*" },
  {
    action: "Publish",
    phase: "SNS-01",
    disposition: "implemented",
    iamAction: "sns:Publish",
    resource: "topic-or-target",
    targetModes: { TopicArn: "SNS-01 Standard topic", TargetArn: "SNS-06 mobile boundary", PhoneNumber: "SNS-06 SMS boundary" },
  },
  { action: "PublishBatch", phase: "SNS-01", disposition: "implemented", iamAction: "sns:Publish", resource: "topic" },
  { action: "PutDataProtectionPolicy", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:PutDataProtectionPolicy", resource: "topic" },
  { action: "RemovePermission", phase: "SNS-02", disposition: "implemented", iamAction: "sns:RemovePermission", resource: "topic" },
  { action: "SetEndpointAttributes", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:SetEndpointAttributes", resource: "platform-endpoint" },
  { action: "SetPlatformApplicationAttributes", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:SetPlatformApplicationAttributes", resource: "platform-application" },
  { action: "SetSMSAttributes", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:SetSMSAttributes", resource: "*" },
  { action: "SetSubscriptionAttributes", phase: "SNS-02", disposition: "implemented", iamAction: "sns:SetSubscriptionAttributes", resource: "subscription-parent-topic" },
  { action: "SetTopicAttributes", phase: "SNS-02", disposition: "implemented", iamAction: "sns:SetTopicAttributes", resource: "topic" },
  {
    action: "Subscribe",
    phase: "SNS-01",
    disposition: "implemented",
    iamAction: "sns:Subscribe",
    resource: "topic",
    targetModes: {
      sqs: "SNS-01 same-account/same-Region Standard queue",
      lambda: "SNS-01 same-account/same-Region function",
      "http/https/email/email-json": "SNS-05",
      "sms/application/firehose": "SNS-06 dependency boundary",
    },
  },
  { action: "TagResource", phase: "SNS-01", disposition: "implemented", iamAction: "sns:TagResource", resource: "topic" },
  { action: "Unsubscribe", phase: "SNS-01", disposition: "implemented", iamAction: "sns:Unsubscribe", resource: "subscription-parent-topic" },
  { action: "UntagResource", phase: "SNS-01", disposition: "implemented", iamAction: "sns:UntagResource", resource: "topic" },
  { action: "VerifySMSSandboxPhoneNumber", phase: "SNS-06", disposition: "phase-deferred", iamAction: "sns:VerifySMSSandboxPhoneNumber", resource: "*" },
] as const;

export const SNS_01_IMPLEMENTED_ACTIONS = Object.freeze(
  SNS_ACTION_INVENTORY.filter(entry => entry.phase === "SNS-01" && entry.disposition === "implemented").map(entry => entry.action),
);

export const SNS_02_IMPLEMENTED_ACTIONS = Object.freeze(
  SNS_ACTION_INVENTORY.filter(entry => entry.disposition === "implemented").map(entry => entry.action),
);
