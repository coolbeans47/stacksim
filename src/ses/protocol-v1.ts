import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "../errors.js";
import { awsQueryXml, parseAwsQuery } from "../protocols/query-xml.js";
import { readBody } from "../util.js";

export const SES_V1_NAMESPACE = "http://ses.amazonaws.com/doc/2010-12-01/";

export const SES_V1_IMPLEMENTED_ACTIONS = new Set([
  "VerifyEmailIdentity",
  "VerifyEmailAddress",
  "GetIdentityVerificationAttributes",
  "ListIdentities",
  "ListVerifiedEmailAddresses",
  "DeleteIdentity",
  "DeleteVerifiedEmailAddress",
  "SendEmail",
  "SendRawEmail",
  "GetAccountSendingEnabled",
  "UpdateAccountSendingEnabled",
  "GetSendQuota",
  "GetSendStatistics",
  "CreateTemplate",
  "GetTemplate",
  "ListTemplates",
  "UpdateTemplate",
  "DeleteTemplate",
  "TestRenderTemplate",
  "SendTemplatedEmail",
  "CreateConfigurationSet",
  "DescribeConfigurationSet",
  "ListConfigurationSets",
  "DeleteConfigurationSet",
  "UpdateConfigurationSetSendingEnabled",
  "SendBulkTemplatedEmail",
  "CreateCustomVerificationEmailTemplate", "GetCustomVerificationEmailTemplate",
  "ListCustomVerificationEmailTemplates", "UpdateCustomVerificationEmailTemplate",
  "DeleteCustomVerificationEmailTemplate", "SendCustomVerificationEmail",
  "VerifyDomainIdentity", "VerifyDomainDkim", "GetIdentityDkimAttributes",
  "SetIdentityDkimEnabled", "GetIdentityMailFromDomainAttributes", "SetIdentityMailFromDomain",
  "GetIdentityNotificationAttributes", "SetIdentityFeedbackForwardingEnabled",
  "SetIdentityHeadersInNotificationsEnabled", "SetIdentityNotificationTopic",
  "PutIdentityPolicy", "GetIdentityPolicies", "ListIdentityPolicies", "DeleteIdentityPolicy",
  "CreateConfigurationSetEventDestination", "UpdateConfigurationSetEventDestination",
  "DeleteConfigurationSetEventDestination", "CreateConfigurationSetTrackingOptions",
  "UpdateConfigurationSetTrackingOptions", "DeleteConfigurationSetTrackingOptions",
  "PutConfigurationSetDeliveryOptions", "UpdateConfigurationSetReputationMetricsEnabled",
]);
/** Backward-compatible export name retained for the central service router. */
export const SES_V1_PHASE_01_02_ACTIONS = SES_V1_IMPLEMENTED_ACTIONS;

export interface SesProtocolExecutor {
  execute(operation: string, input: any, family: "ses-v1" | "ses-v2", requestId: string): Promise<Record<string, unknown> | void>;
}

function v1ErrorCode(error: AwsError): string {
  if (error.code === "AlreadyExistsException") return "AlreadyExists";
  if (error.code === "NotFoundException") return "NotFound";
  if (error.code === "BadRequestException") return "InvalidParameterValue";
  if (error.code === "TooManyRequestsException") return "Throttling";
  return error.code.replace(/Exception$/, "");
}

export function sendSesV1Error(res: ServerResponse, error: unknown, requestId: string): void {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  const type = aws.status >= 500 ? "Receiver" : "Sender";
  res.statusCode = aws.status;
  res.setHeader("content-type", "text/xml; charset=utf-8");
  res.setHeader("x-amzn-requestid", requestId);
  res.end(awsQueryXml("ErrorResponse", {
    Error: { Type: type, Code: v1ErrorCode(aws), Message: aws.message },
    RequestId: requestId,
  }, SES_V1_NAMESPACE));
}

export async function parseSesV1Request(req: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
  const input = req.method === "GET"
    ? parseAwsQuery(url.searchParams)
    : parseAwsQuery((await readBody(req)).toString("utf8"));
  if (input.Version !== "2010-12-01") throw new AwsError("InvalidAction", "The action or version requested is not supported by SES.", 400);
  return input;
}

export async function handleSesV1(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  requestId: string,
  executor: SesProtocolExecutor,
): Promise<void> {
  try {
    if (req.method !== "POST" && req.method !== "GET") throw new AwsError("InvalidAction", "The requested action is not supported.", 400);
    const input = await parseSesV1Request(req, url);
    const operation = typeof input.Action === "string" ? input.Action : "";
    if (!SES_V1_IMPLEMENTED_ACTIONS.has(operation)) throw new AwsError("InvalidAction", `The action ${operation || "(missing)"} is not valid for this web service.`, 400);
    const result = await executor.execute(operation, input, "ses-v1", requestId) ?? {};
    res.statusCode = 200;
    res.setHeader("content-type", "text/xml; charset=utf-8");
    res.setHeader("x-amzn-requestid", requestId);
    res.end(awsQueryXml(`${operation}Response`, {
      [`${operation}Result`]: result,
      ResponseMetadata: { RequestId: requestId },
    }, SES_V1_NAMESPACE));
  } catch (error) {
    sendSesV1Error(res, error, requestId);
  }
}
