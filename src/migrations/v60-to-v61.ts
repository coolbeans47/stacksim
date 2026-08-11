import type { SimState } from "../types.js";

function defaultPolicy(topicArn: string, owner: string): string {
  return JSON.stringify({
    Version: "2008-10-17",
    Id: "__default_policy_ID",
    Statement: [{
      Sid: "__default_statement_ID",
      Effect: "Allow",
      Principal: { AWS: "*" },
      Action: ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"],
      Resource: topicArn,
      Condition: { StringEquals: { "AWS:SourceOwner": owner } },
    }],
  });
}

/** Adds the SNS-02 policy, delivery-feedback, filter, raw-delivery, and redrive descriptors. */
export function migrateV60ToV61(input: SimState): SimState {
  const state = structuredClone(input);
  for (const [accountId, account] of Object.entries(state.accounts)) {
    for (const region of Object.values(account.regions)) {
      for (const topic of Object.values(region.sns.topics)) {
        topic.policy ??= defaultPolicy(topic.arn, accountId);
        topic.signatureVersion ??= "1";
        topic.sqsSuccessFeedbackSampleRate ??= 0;
        topic.lambdaSuccessFeedbackSampleRate ??= 0;
      }
      for (const subscription of Object.values(region.sns.subscriptions)) {
        subscription.filterPolicyScope ??= "MessageAttributes";
        subscription.rawMessageDelivery ??= false;
        subscription.filterRevision ??= 1;
        subscription.deliveryRevision ??= 1;
      }
    }
  }
  state.schemaVersion = 61;
  return state;
}
