import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "../errors.js";
import { parseRestJson } from "../protocols/rest-json.js";
import type { SesProtocolExecutor } from "./protocol-v1.js";

interface Route {
  method: string;
  pattern: RegExp;
  operation: string;
  parameters?: string[];
  query?: Record<string, string>;
}

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/v2\/email\/account$/, operation: "GetAccount" },
  { method: "PUT", pattern: /^\/v2\/email\/account\/sending$/, operation: "PutAccountSendingAttributes" },
  { method: "POST", pattern: /^\/v2\/email\/account\/details$/, operation: "PutAccountDetails" },
  { method: "PUT", pattern: /^\/v2\/email\/account\/suppression$/, operation: "PutAccountSuppressionAttributes" },
  { method: "POST", pattern: /^\/v2\/email\/identities$/, operation: "CreateEmailIdentity" },
  { method: "GET", pattern: /^\/v2\/email\/identities$/, operation: "ListEmailIdentities", query: { PageSize: "PageSize", NextToken: "NextToken" } },
  { method: "GET", pattern: /^\/v2\/email\/identities\/([^/]+)$/, operation: "GetEmailIdentity", parameters: ["EmailIdentity"] },
  { method: "DELETE", pattern: /^\/v2\/email\/identities\/([^/]+)$/, operation: "DeleteEmailIdentity", parameters: ["EmailIdentity"] },
  { method: "PUT", pattern: /^\/v2\/email\/identities\/([^/]+)\/configuration-set$/, operation: "PutEmailIdentityConfigurationSetAttributes", parameters: ["EmailIdentity"] },
  { method: "PUT", pattern: /^\/v2\/email\/identities\/([^/]+)\/dkim$/, operation: "PutEmailIdentityDkimAttributes", parameters: ["EmailIdentity"] },
  { method: "PUT", pattern: /^\/v2\/email\/identities\/([^/]+)\/dkim\/signing$/, operation: "PutEmailIdentityDkimSigningAttributes", parameters: ["EmailIdentity"] },
  { method: "PUT", pattern: /^\/v2\/email\/identities\/([^/]+)\/feedback$/, operation: "PutEmailIdentityFeedbackAttributes", parameters: ["EmailIdentity"] },
  { method: "PUT", pattern: /^\/v2\/email\/identities\/([^/]+)\/mail-from$/, operation: "PutEmailIdentityMailFromAttributes", parameters: ["EmailIdentity"] },
  { method: "GET", pattern: /^\/v2\/email\/identities\/([^/]+)\/policies$/, operation: "GetEmailIdentityPolicies", parameters: ["EmailIdentity"] },
  { method: "POST", pattern: /^\/v2\/email\/identities\/([^/]+)\/policies\/([^/]+)$/, operation: "CreateEmailIdentityPolicy", parameters: ["EmailIdentity", "PolicyName"] },
  { method: "PUT", pattern: /^\/v2\/email\/identities\/([^/]+)\/policies\/([^/]+)$/, operation: "UpdateEmailIdentityPolicy", parameters: ["EmailIdentity", "PolicyName"] },
  { method: "DELETE", pattern: /^\/v2\/email\/identities\/([^/]+)\/policies\/([^/]+)$/, operation: "DeleteEmailIdentityPolicy", parameters: ["EmailIdentity", "PolicyName"] },
  { method: "POST", pattern: /^\/v2\/email\/outbound-emails$/, operation: "SendEmail" },
  { method: "POST", pattern: /^\/v2\/email\/outbound-bulk-emails$/, operation: "SendBulkEmail" },
  { method: "POST", pattern: /^\/v2\/email\/outbound-custom-verification-emails$/, operation: "SendCustomVerificationEmail" },
  { method: "POST", pattern: /^\/v2\/email\/templates$/, operation: "CreateEmailTemplate" },
  { method: "GET", pattern: /^\/v2\/email\/templates$/, operation: "ListEmailTemplates", query: { PageSize: "PageSize", NextToken: "NextToken" } },
  { method: "GET", pattern: /^\/v2\/email\/templates\/([^/]+)$/, operation: "GetEmailTemplate", parameters: ["TemplateName"] },
  { method: "PUT", pattern: /^\/v2\/email\/templates\/([^/]+)$/, operation: "UpdateEmailTemplate", parameters: ["TemplateName"] },
  { method: "DELETE", pattern: /^\/v2\/email\/templates\/([^/]+)$/, operation: "DeleteEmailTemplate", parameters: ["TemplateName"] },
  { method: "POST", pattern: /^\/v2\/email\/templates\/([^/]+)\/render$/, operation: "TestRenderEmailTemplate", parameters: ["TemplateName"] },
  { method: "POST", pattern: /^\/v2\/email\/configuration-sets$/, operation: "CreateConfigurationSet" },
  { method: "GET", pattern: /^\/v2\/email\/configuration-sets$/, operation: "ListConfigurationSets", query: { PageSize: "PageSize", NextToken: "NextToken" } },
  { method: "GET", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)$/, operation: "GetConfigurationSet", parameters: ["ConfigurationSetName"] },
  { method: "DELETE", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)$/, operation: "DeleteConfigurationSet", parameters: ["ConfigurationSetName"] },
  { method: "PUT", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/sending$/, operation: "PutConfigurationSetSendingOptions", parameters: ["ConfigurationSetName"] },
  { method: "PUT", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/delivery-options$/, operation: "PutConfigurationSetDeliveryOptions", parameters: ["ConfigurationSetName"] },
  { method: "PUT", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/reputation-options$/, operation: "PutConfigurationSetReputationOptions", parameters: ["ConfigurationSetName"] },
  { method: "PUT", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/suppression-options$/, operation: "PutConfigurationSetSuppressionOptions", parameters: ["ConfigurationSetName"] },
  { method: "PUT", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/tracking-options$/, operation: "PutConfigurationSetTrackingOptions", parameters: ["ConfigurationSetName"] },
  { method: "GET", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/event-destinations$/, operation: "GetConfigurationSetEventDestinations", parameters: ["ConfigurationSetName"] },
  { method: "POST", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/event-destinations$/, operation: "CreateConfigurationSetEventDestination", parameters: ["ConfigurationSetName"] },
  { method: "PUT", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/event-destinations\/([^/]+)$/, operation: "UpdateConfigurationSetEventDestination", parameters: ["ConfigurationSetName", "EventDestinationName"] },
  { method: "DELETE", pattern: /^\/v2\/email\/configuration-sets\/([^/]+)\/event-destinations\/([^/]+)$/, operation: "DeleteConfigurationSetEventDestination", parameters: ["ConfigurationSetName", "EventDestinationName"] },
  { method: "POST", pattern: /^\/v2\/email\/custom-verification-email-templates$/, operation: "CreateCustomVerificationEmailTemplate" },
  { method: "GET", pattern: /^\/v2\/email\/custom-verification-email-templates$/, operation: "ListCustomVerificationEmailTemplates", query: { PageSize: "PageSize", NextToken: "NextToken" } },
  { method: "GET", pattern: /^\/v2\/email\/custom-verification-email-templates\/([^/]+)$/, operation: "GetCustomVerificationEmailTemplate", parameters: ["TemplateName"] },
  { method: "PUT", pattern: /^\/v2\/email\/custom-verification-email-templates\/([^/]+)$/, operation: "UpdateCustomVerificationEmailTemplate", parameters: ["TemplateName"] },
  { method: "DELETE", pattern: /^\/v2\/email\/custom-verification-email-templates\/([^/]+)$/, operation: "DeleteCustomVerificationEmailTemplate", parameters: ["TemplateName"] },
  { method: "POST", pattern: /^\/v2\/email\/contact-lists$/, operation: "CreateContactList" },
  { method: "GET", pattern: /^\/v2\/email\/contact-lists$/, operation: "ListContactLists", query: { PageSize: "PageSize", NextToken: "NextToken" } },
  { method: "GET", pattern: /^\/v2\/email\/contact-lists\/([^/]+)$/, operation: "GetContactList", parameters: ["ContactListName"] },
  { method: "PUT", pattern: /^\/v2\/email\/contact-lists\/([^/]+)$/, operation: "UpdateContactList", parameters: ["ContactListName"] },
  { method: "DELETE", pattern: /^\/v2\/email\/contact-lists\/([^/]+)$/, operation: "DeleteContactList", parameters: ["ContactListName"] },
  { method: "POST", pattern: /^\/v2\/email\/contact-lists\/([^/]+)\/contacts$/, operation: "CreateContact", parameters: ["ContactListName"] },
  { method: "POST", pattern: /^\/v2\/email\/contact-lists\/([^/]+)\/contacts\/list$/, operation: "ListContacts", parameters: ["ContactListName"] },
  { method: "GET", pattern: /^\/v2\/email\/contact-lists\/([^/]+)\/contacts\/([^/]+)$/, operation: "GetContact", parameters: ["ContactListName", "EmailAddress"] },
  { method: "PUT", pattern: /^\/v2\/email\/contact-lists\/([^/]+)\/contacts\/([^/]+)$/, operation: "UpdateContact", parameters: ["ContactListName", "EmailAddress"] },
  { method: "DELETE", pattern: /^\/v2\/email\/contact-lists\/([^/]+)\/contacts\/([^/]+)$/, operation: "DeleteContact", parameters: ["ContactListName", "EmailAddress"] },
  { method: "PUT", pattern: /^\/v2\/email\/suppression\/addresses$/, operation: "PutSuppressedDestination" },
  { method: "GET", pattern: /^\/v2\/email\/suppression\/addresses$/, operation: "ListSuppressedDestinations", query: { PageSize: "PageSize", NextToken: "NextToken", StartDate: "StartDate", EndDate: "EndDate", Reasons: "Reasons" } },
  { method: "GET", pattern: /^\/v2\/email\/suppression\/addresses\/([^/]+)$/, operation: "GetSuppressedDestination", parameters: ["EmailAddress"] },
  { method: "DELETE", pattern: /^\/v2\/email\/suppression\/addresses\/([^/]+)$/, operation: "DeleteSuppressedDestination", parameters: ["EmailAddress"] },
  { method: "POST", pattern: /^\/v2\/email\/metrics\/batch$/, operation: "BatchGetMetricData" },
  { method: "GET", pattern: /^\/v2\/email\/insights\/([^/]+)$/, operation: "GetMessageInsights", parameters: ["MessageId"] },
  { method: "GET", pattern: /^\/v2\/email\/tags$/, operation: "ListTagsForResource", query: { ResourceArn: "ResourceArn" } },
  { method: "POST", pattern: /^\/v2\/email\/tags$/, operation: "TagResource" },
  { method: "DELETE", pattern: /^\/v2\/email\/tags$/, operation: "UntagResource", query: { ResourceArn: "ResourceArn", TagKeys: "TagKeys" } },
];

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AwsError("BadRequestException", "The request path contains invalid percent encoding.", 400);
  }
}

export function resolveSesV2Operation(method: string | undefined, pathname: string): string | undefined {
  return ROUTES.find(candidate => candidate.method === method && candidate.pattern.test(pathname))?.operation;
}

export function sendSesV2Error(res: ServerResponse, error: unknown, requestId: string): void {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  const code = aws.code.includes("Exception") || aws.code === "MessageRejected" || aws.code === "MailFromDomainNotVerified"
    ? aws.code
    : aws.status >= 500 ? "ServiceUnavailableException" : "BadRequestException";
  res.statusCode = aws.status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-amzn-requestid", requestId);
  res.setHeader("x-amzn-errortype", code);
  res.end(JSON.stringify({ message: aws.message, __type: code, ...aws.details }));
}

function queryInput(url: URL, mapping: Record<string, string> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [wireName, memberName] of Object.entries(mapping ?? {})) {
    const values = url.searchParams.getAll(wireName);
    if (!values.length) continue;
    result[memberName] = wireName === "TagKeys" ? values : values.at(-1);
  }
  return result;
}

export async function handleSesV2(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  requestId: string,
  executor: SesProtocolExecutor,
): Promise<void> {
  try {
    const route = ROUTES.find(candidate => candidate.method === req.method && candidate.pattern.test(url.pathname));
    if (!route) throw new AwsError("NotFoundException", "The requested SES v2 operation was not found.", 404);
    const match = url.pathname.match(route.pattern)!;
    const pathInput = Object.fromEntries((route.parameters ?? []).map((name, index) => [name, decodeSegment(match[index + 1])]));
    const hasBody = req.method === "POST" || req.method === "PUT";
    const bodyInput = hasBody ? await parseRestJson(req) : {};
    const input = { ...queryInput(url, route.query), ...pathInput, ...bodyInput };
    const result = await executor.execute(route.operation, input, "ses-v2", requestId) ?? {};
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-amzn-requestid", requestId);
    res.end(JSON.stringify(result));
  } catch (error) {
    sendSesV2Error(res, error, requestId);
  }
}
