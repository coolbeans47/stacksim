import { activeCredentials, session } from "./state.js";
import { signRequest } from "./sigv4.js";

function inferService(path, headers) {
  const explicit = headers.get("x-stacksim-service");
  if (explicit) return explicit;
  const target = headers.get("x-amz-target") ?? "";
  if (/^DynamoDB(?:Streams)?_/.test(target)) return "dynamodb";
  if (target.startsWith("AmazonSQS.")) return "sqs";
  if (target.startsWith("AWSEvents.")) return "events";
  if (target.startsWith("AWSStepFunctions.")) return "states";
  if (target.startsWith("Logs_20140328.")) return "logs";
  if (target.startsWith("GraniteServiceVersion20100801.")) return "monitoring";
  if (target.startsWith("AWSCognitoIdentityProviderService.")) return "cognito-idp";
  if (target.startsWith("AmazonSSM.")) return "ssm";
  if (target.startsWith("secretsmanager.")) return "secretsmanager";
  const pathname = new URL(path, location.origin).pathname;
  if (pathname.startsWith("/_stacksim/api/cloudfront")) return "cloudfront";
  if (pathname.startsWith("/_stacksim/api/cloudformation/")) return "cloudformation";
  if (pathname.startsWith("/_stacksim/api/iam/")) return "iam";
  if (pathname.startsWith("/_stacksim/api/cognito/")) return "cognito-idp";
  if (pathname.startsWith("/_stacksim/api/ses/")) return "ses";
  if (pathname.startsWith("/_stacksim/api/dynamodb/")) return "dynamodb";
  if (pathname.startsWith("/_stacksim/api/lambda/")) return "lambda";
  if (pathname.startsWith("/_stacksim/api/eventbridge/")) return "events";
  if (pathname.startsWith("/_stacksim/api/sns/")) return "sns";
  if (pathname.startsWith("/_stacksim/api/rds/")) return "rds";
  if (pathname.startsWith("/_stacksim/api/xray/")) return "xray";
  if (pathname.startsWith("/_stacksim/api/")) return "sts";
  if (pathname.startsWith("/v2/email/")) return "ses";
  if (/^\/(?:2014-11-13|2015-03-31|2016-08-19|2017-03-31|2017-10-31|2018-10-31|2019-09-25|2019-09-30|2020-04-22|2020-06-30|2021-07-20|2021-10-31|2021-11-15|2024-08-31|2025-11-30|2025-12-01)(?:\/|$)/.test(pathname)) return "lambda";
  if (pathname.startsWith("/restapis") || pathname.startsWith("/v2") || pathname === "/account" || pathname.startsWith("/tags/") || pathname.startsWith("/apikeys") || pathname.startsWith("/usageplans") || pathname.startsWith("/domainnames") || pathname.startsWith("/vpclinks") || pathname.startsWith("/clientcertificates") || pathname.startsWith("/sdktypes")) return "apigateway";
  return "sts";
}

export async function awsFetch(path, options = {}) {
  const { service: suppliedService, credentials: suppliedCredentials, unsigned, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers ?? {});
  const pathname = new URL(path, location.origin).pathname;
  if (pathname.startsWith("/_stacksim/api/console-onboarding/") || (suppliedService === "iam" && String(fetchOptions.body ?? "").includes("Action=CreateAccessKey"))) {
    fetchOptions.cache = "no-store";
  }
  if (!headers.has("x-stacksim-region")) headers.set("x-stacksim-region", session.region);
  const credentials = suppliedCredentials ?? activeCredentials();
  if (unsigned || session.authMode === "off") return fetch(path, { ...fetchOptions, headers });
  if (!credentials) {
    const error = new Error("Sign in to the local console to continue.");
    error.code = "ConsoleSignInRequired";
    throw error;
  }
  const signed = await signRequest(path, { ...fetchOptions, headers }, {
    credentials,
    region: session.region,
    service: suppliedService ?? inferService(path, headers),
  });
  return fetch(signed.url, signed.options);
}

export async function request(path, options = {}) {
  const response = await awsFetch(path, options);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) { const error = new Error(body.message || body.Message || body.__type || `Request failed (${response.status})`); error.code = String(body.__type ?? body.code ?? "RequestError").split("#").at(-1); error.details = body; error.status = response.status; throw error; }
  return body;
}

export function dynamo(operation, input = {}) {
  return request("/", { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${operation}` }, body: JSON.stringify(input) });
}

export function sqs(operation, input = {}, options = {}) {
  const { region, headers: suppliedHeaders, ...requestOptions } = options;
  const headers = new Headers(suppliedHeaders ?? {});
  headers.set("content-type", "application/x-amz-json-1.0");
  headers.set("x-amz-target", `AmazonSQS.${operation}`);
  if (region) headers.set("x-stacksim-region", region);
  return request("/", { ...requestOptions, method: "POST", headers, body: JSON.stringify(input) });
}

export function events(operation, input = {}, region = session.region) {
  return request("/", { method: "POST", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSEvents.${operation}`, "x-stacksim-region": region }, body: JSON.stringify(input) });
}

export function states(operation, input = {}, region = session.region) {
  return request("/", { service: "states", method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `AWSStepFunctions.${operation}`, "x-stacksim-region": region }, body: JSON.stringify(input) });
}

/** Call the distinct EventBridge Scheduler REST-JSON surface. */
export function scheduler(path, { method = "GET", body, query } = {}) {
  return request(withQuery(path, query), {
    service: "scheduler",
    method,
    headers: body === undefined ? { accept: "application/json", "x-stacksim-service": "scheduler" } : { accept: "application/json", "content-type": "application/json", "x-stacksim-service": "scheduler" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function logs(operation, input = {}, region = session.region) {
  return request("/", { method: "POST", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `Logs_20140328.${operation}`, "x-stacksim-region": region }, body: JSON.stringify(input) });
}

export function metrics(operation, input = {}, region = session.region) {
  return request("/", { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `GraniteServiceVersion20100801.${operation}`, "x-stacksim-region": region }, body: JSON.stringify(input) });
}

/** Call the official Cognito User Pools JSON 1.1 surface. */
export function cognito(operation, input = {}, region = session.region) {
  return request("/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
      "x-stacksim-region": region,
    },
    body: JSON.stringify(input),
  });
}

export function rest(path, method = "GET", body) {
  return request(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

function withQuery(path, query = {}) {
  const url = new URL(path, location.origin);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(name, String(item)));
    else url.searchParams.set(name, String(value));
  }
  return `${url.pathname}${url.search}`;
}

/** Call the official AppSync REST-JSON control plane. */
export async function appsync(path, { method = "GET", body, query, responseType = "json" } = {}) {
  const response = await awsFetch(withQuery(path, query), {
    service: "appsync",
    method,
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      accept: responseType === "json" ? "application/json" : "application/octet-stream",
      "x-stacksim-service": "appsync",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (responseType === "text") {
    const text = await response.text();
    if (!response.ok) {
      let parsed = {};
      try { parsed = JSON.parse(text); } catch {}
      const error = new Error(parsed.message || `AppSync request failed (${response.status})`);
      error.code = String(parsed.__type ?? "RequestError").split("#").at(-1);
      error.status = response.status;
      error.details = parsed;
      throw error;
    }
    return text;
  }
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) {
    const error = new Error(parsed.message || `AppSync request failed (${response.status})`);
    error.code = String(parsed.__type ?? "RequestError").split("#").at(-1);
    error.status = response.status;
    error.details = parsed;
    throw error;
  }
  return parsed;
}

/** Call the official SES v2 REST-JSON surface without simulator-only commands. */
export function sesV2(path, { method = "GET", body, query } = {}) {
  const suffix = String(path || "").replace(/^\/+/, "");
  return request(withQuery(`/v2/email/${suffix}`, query), {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Call the official SES v1 Query/XML surface from console workflows. */
export async function sesV1(action, input = {}) {
  const parameters = new URLSearchParams({ Action: action, Version: "2010-12-01" });
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item, index) => parameters.set(`${name}.member.${index + 1}`, String(item)));
    else parameters.set(name, String(value));
  }
  const response = await awsFetch("/", {
    service: "ses",
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-stacksim-service": "ses",
      "x-stacksim-region": session.region,
    },
    body: parameters,
  });
  const text = await response.text();
  const xml = text.trimStart().startsWith("<") ? new DOMParser().parseFromString(text, "application/xml") : undefined;
  if (!response.ok) {
    const code = xml?.getElementsByTagName("Code")?.[0]?.textContent ?? `SESError${response.status}`;
    const message = xml?.getElementsByTagName("Message")?.[0]?.textContent ?? `SES request failed (${response.status})`;
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    error.details = { code, message, text };
    throw error;
  }
  return { response, text, xml };
}

function xmlValue(xml, name) {
  return xml?.getElementsByTagName(name)?.[0]?.textContent ?? undefined;
}

export async function awsQuery(service, action, input = {}, { credentials } = {}) {
  const parameters = new URLSearchParams({ Action: action, Version: service === "sts" ? "2011-06-15" : service === "iam" ? "2010-05-08" : service === "sns" ? "2010-03-31" : "2010-05-15" });
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((item, index) => parameters.set(`${name}.member.${index + 1}`, String(item)));
    else parameters.set(name, String(value));
  }
  const response = await awsFetch("/", {
    service,
    credentials,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": service },
    body: parameters,
  });
  const text = await response.text();
  const xml = text.trimStart().startsWith("<") ? new DOMParser().parseFromString(text, "application/xml") : undefined;
  if (!response.ok) {
    const code = xmlValue(xml, "Code") ?? `RequestError${response.status}`;
    const message = xmlValue(xml, "Message") ?? `Service request failed (${response.status})`;
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return { response, text, xml, value: name => xmlValue(xml, name) };
}

export function secretsManager(operation, input = {}, region = session.region) {
  return request("/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `secretsmanager.${operation}`,
      "x-stacksim-region": region,
    },
    body: JSON.stringify(input),
  });
}

/** Call the official Systems Manager JSON 1.1 surface. */
export function ssm(operation, input = {}, region = session.region) {
  return request("/", {
    service: "ssm",
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AmazonSSM.${operation}`,
      "x-stacksim-region": region,
    },
    body: JSON.stringify(input),
  });
}

function appendSnsQuery(parameters, name, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendSnsQuery(parameters, `${name}.member.${index + 1}`, item));
    return;
  }
  if (typeof value === "object") {
    if (name.endsWith("MessageAttributes")) {
      Object.entries(value).forEach(([key, item], index) => {
        parameters.set(`${name}.entry.${index + 1}.Name`, key);
        appendSnsQuery(parameters, `${name}.entry.${index + 1}.Value`, item);
      });
      return;
    }
    for (const [key, item] of Object.entries(value)) appendSnsQuery(parameters, `${name}.${key}`, item);
    return;
  }
  parameters.set(name, String(value));
}

/** Call the official SNS Query/XML surface from console workflows. */
export async function sns(action, input = {}) {
  const parameters = new URLSearchParams({ Action: action, Version: "2010-03-31" });
  for (const [name, value] of Object.entries(input)) appendSnsQuery(parameters, name, value);
  const response = await awsFetch("/", {
    service: "sns",
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-stacksim-service": "sns",
      "x-stacksim-region": session.region,
    },
    body: parameters,
  });
  const text = await response.text();
  const xml = text.trimStart().startsWith("<") ? new DOMParser().parseFromString(text, "application/xml") : undefined;
  if (!response.ok) {
    const code = xmlValue(xml, "Code") ?? `SNSError${response.status}`;
    const message = xmlValue(xml, "Message") ?? `SNS request failed (${response.status})`;
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    error.details = { code, message, text };
    throw error;
  }
  return { response, text, xml, value: name => xmlValue(xml, name) };
}

export async function getCallerIdentity(credentials) {
  const result = await awsQuery("sts", "GetCallerIdentity", {}, { credentials });
  return { userId: result.value("UserId"), account: result.value("Account"), arn: result.value("Arn") };
}

export async function assumeRole(roleArn, credentials) {
  const result = await awsQuery("sts", "AssumeRole", {
    RoleArn: roleArn,
    RoleSessionName: `stacksim-console-${Date.now().toString(36)}`.slice(0, 64),
  }, { credentials });
  return {
    accessKeyId: result.value("AccessKeyId"),
    secretAccessKey: result.value("SecretAccessKey"),
    sessionToken: result.value("SessionToken"),
    expiration: result.value("Expiration"),
    identity: {
      arn: result.value("Arn"),
      account: roleArn.split(":")[4],
      userId: result.value("AssumedRoleId"),
    },
  };
}

/** Mutate private same-origin console state such as Inbox read/Trash flags. */
export function consoleMutation(path, method, body) {
  return request(path, {
    method,
    headers: {
      "X-StackSim-Console-Request": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Fetch a local binary artifact while retaining the selected simulator Region. */
export async function binaryRequest(path, options = {}) {
  const response = await awsFetch(path, options);
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    const error = new Error(body.message || body.Message || body.__type || `Request failed (${response.status})`);
    error.code = String(body.__type ?? body.code ?? "RequestError").split("#").at(-1);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return response;
}

export async function rds(action, input = {}, region = session.region) {
  const parameters = new URLSearchParams({ Action: action, Version: "2014-10-31" });
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (name === "Tags" && Array.isArray(value)) {
      value.forEach((tag, index) => {
        parameters.set(`Tags.Tag.${index + 1}.Key`, String(tag.Key));
        parameters.set(`Tags.Tag.${index + 1}.Value`, String(tag.Value));
      });
      continue;
    }
    if (name === "TagKeys" && Array.isArray(value)) {
      value.forEach((key, index) => parameters.set(`TagKeys.member.${index + 1}`, String(key)));
      continue;
    }
    if (name === "Parameters" && Array.isArray(value)) {
      value.forEach((parameter, index) => {
        for (const field of ["ParameterName", "ParameterValue", "ApplyMethod"]) {
          if (parameter?.[field] !== undefined && parameter?.[field] !== null) parameters.set(`Parameters.Parameter.${index + 1}.${field}`, String(parameter[field]));
        }
      });
      continue;
    }
    parameters.set(name, String(value));
  }
  const response = await awsFetch("/", {
    service: "rds",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "rds", "x-stacksim-region": region },
    body: parameters,
  });
  const text = await response.text();
  const xml = text.trimStart().startsWith("<") ? new DOMParser().parseFromString(text, "application/xml") : undefined;
  if (!response.ok) {
    const code = xml?.getElementsByTagName("Code")?.[0]?.textContent ?? `RDSError${response.status}`;
    const message = xml?.getElementsByTagName("Message")?.[0]?.textContent ?? `RDS request failed (${response.status})`;
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    error.details = { code, message, text };
    throw error;
  }
  return { response, text, xml };
}

export async function s3Request(path, options = {}) {
  const headers = new Headers(options.headers ?? {}); headers.set("x-stacksim-service", "s3"); headers.set("x-stacksim-region", options.region ?? session.region);
  const response = await awsFetch(path, { service: "s3", method: options.method ?? "GET", headers, body: options.body, signal: options.signal }); const body = new Uint8Array(await response.arrayBuffer()); const text = new TextDecoder().decode(body); let xml;
  if (text && (response.headers.get("content-type") ?? "").includes("xml")) xml = new DOMParser().parseFromString(text, "application/xml");
  if (!response.ok) { const code = xml?.querySelector("Code")?.textContent ?? `S3Error${response.status}`; const message = xml?.querySelector("Message")?.textContent ?? `S3 request failed (${response.status})`; const error = new Error(message); error.code = code; error.status = response.status; error.details = { code, message, text }; throw error; }
  return { response, body, text, xml };
}
