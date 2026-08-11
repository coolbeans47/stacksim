import { isReferencePath } from "./jsonpath.js";

export interface ValidationDiagnostic {
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  location: string;
}

export interface CompiledDefinition {
  Comment?: string;
  Version?: string;
  TimeoutSeconds?: number;
  StartAt: string;
  States: Record<string, any>;
}

const COMMON = ["Type", "Comment", "InputPath", "OutputPath", "Next", "End"];
const FIELDS: Record<string, string[]> = {
  Pass: [...COMMON, "Parameters", "Result", "ResultPath"],
  Choice: ["Type", "Comment", "InputPath", "OutputPath", "Choices", "Default"],
  Wait: [...COMMON, "Seconds", "SecondsPath", "Timestamp", "TimestampPath"],
  Succeed: ["Type", "Comment", "InputPath", "OutputPath"],
  Fail: ["Type", "Comment", "Error", "ErrorPath", "Cause", "CausePath"],
  Task: [...COMMON, "Resource", "Parameters", "ResultSelector", "ResultPath", "Retry", "Catch", "TimeoutSeconds", "TimeoutSecondsPath", "HeartbeatSeconds", "HeartbeatSecondsPath"],
  Parallel: [...COMMON, "Parameters", "ResultSelector", "ResultPath", "Branches", "Retry", "Catch"],
  Map: [...COMMON, "Parameters", "ResultSelector", "ResultPath", "ItemsPath", "ItemSelector", "MaxConcurrency", "Iterator", "ItemProcessor", "Retry", "Catch"],
};
const PATH_FIELDS = ["InputPath", "OutputPath", "ResultPath", "ItemsPath", "SecondsPath", "TimestampPath", "TimeoutSecondsPath", "HeartbeatSecondsPath", "ErrorPath", "CausePath"];
const LAMBDA_DIRECT = /^arn:aws:lambda:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):function:[A-Za-z0-9-_]+(?::(?:\$LATEST|[A-Za-z0-9-_]+))?$/;
const LAMBDA_OPTIMIZED = "arn:aws:states:::lambda:invoke";
const ACTIVITY = /^arn:aws:states:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):activity:([^:]{1,80})$/;
const INTEGRATIONS: Record<string, { fields: string[]; required: string[]; callback?: boolean }> = {
  "arn:aws:states:::lambda:invoke": { fields: ["FunctionName", "Payload", "Qualifier", "InvocationType", "ClientContext"], required: ["FunctionName"] },
  "arn:aws:states:::lambda:invoke.waitForTaskToken": { fields: ["FunctionName", "Payload", "Qualifier", "InvocationType", "ClientContext"], required: ["FunctionName"], callback: true },
  "arn:aws:states:::dynamodb:getItem": { fields: ["TableName", "Key", "ConsistentRead", "ExpressionAttributeNames", "ProjectionExpression", "ReturnConsumedCapacity"], required: ["TableName", "Key"] },
  "arn:aws:states:::dynamodb:putItem": { fields: ["TableName", "Item", "ConditionExpression", "ExpressionAttributeNames", "ExpressionAttributeValues", "ReturnConsumedCapacity", "ReturnItemCollectionMetrics", "ReturnValues"], required: ["TableName", "Item"] },
  "arn:aws:states:::dynamodb:updateItem": { fields: ["TableName", "Key", "UpdateExpression", "ConditionExpression", "ExpressionAttributeNames", "ExpressionAttributeValues", "ReturnConsumedCapacity", "ReturnItemCollectionMetrics", "ReturnValues"], required: ["TableName", "Key", "UpdateExpression"] },
  "arn:aws:states:::dynamodb:deleteItem": { fields: ["TableName", "Key", "ConditionExpression", "ExpressionAttributeNames", "ExpressionAttributeValues", "ReturnConsumedCapacity", "ReturnItemCollectionMetrics", "ReturnValues"], required: ["TableName", "Key"] },
  "arn:aws:states:::sqs:sendMessage": { fields: ["QueueUrl", "MessageBody", "DelaySeconds", "MessageAttributes", "MessageSystemAttributes", "MessageDeduplicationId", "MessageGroupId"], required: ["QueueUrl", "MessageBody"] },
  "arn:aws:states:::sqs:sendMessage.waitForTaskToken": { fields: ["QueueUrl", "MessageBody", "DelaySeconds", "MessageAttributes", "MessageSystemAttributes", "MessageDeduplicationId", "MessageGroupId"], required: ["QueueUrl", "MessageBody"], callback: true },
  "arn:aws:states:::sns:publish": { fields: ["TopicArn", "TargetArn", "PhoneNumber", "Message", "Subject", "MessageAttributes", "MessageStructure"], required: ["Message"] },
  "arn:aws:states:::sns:publish.waitForTaskToken": { fields: ["TopicArn", "TargetArn", "Message", "Subject", "MessageAttributes", "MessageStructure"], required: ["TopicArn", "Message"], callback: true },
  "arn:aws:states:::events:putEvents": { fields: ["Entries"], required: ["Entries"] },
  "arn:aws:states:::states:startExecution": { fields: ["StateMachineArn", "Input", "Name", "TraceHeader"], required: ["StateMachineArn"] },
  "arn:aws:states:::states:startExecution.sync": { fields: ["StateMachineArn", "Input", "Name", "TraceHeader"], required: ["StateMachineArn"] },
  "arn:aws:states:::states:startExecution.waitForTaskToken": { fields: ["StateMachineArn", "Input", "Name", "TraceHeader"], required: ["StateMachineArn"], callback: true },
};
const CHOICE_OPERATORS = new Set([
  "BooleanEquals", "BooleanEqualsPath", "NumericEquals", "NumericEqualsPath",
  "NumericLessThan", "NumericLessThanPath", "NumericLessThanEquals", "NumericLessThanEqualsPath",
  "NumericGreaterThan", "NumericGreaterThanPath", "NumericGreaterThanEquals", "NumericGreaterThanEqualsPath",
  "StringEquals", "StringEqualsPath", "StringEqualsIgnoreCase", "StringEqualsIgnoreCasePath",
  "StringLessThan", "StringLessThanPath", "StringLessThanEquals", "StringLessThanEqualsPath",
  "StringGreaterThan", "StringGreaterThanPath", "StringGreaterThanEquals", "StringGreaterThanEqualsPath",
  "StringMatches", "TimestampEquals", "TimestampEqualsPath", "TimestampLessThan", "TimestampLessThanPath",
  "TimestampLessThanEquals", "TimestampLessThanEqualsPath", "TimestampGreaterThan", "TimestampGreaterThanPath",
  "TimestampGreaterThanEquals", "TimestampGreaterThanEqualsPath", "IsBoolean", "IsNull", "IsNumeric",
  "IsPresent", "IsString", "IsTimestamp",
]);
const INTRINSICS = new Set(["Format", "StringToJson", "JsonToString", "Array", "ArrayPartition", "ArrayContains", "ArrayRange", "ArrayGetItem", "ArrayLength", "ArrayUnique", "Base64Encode", "Base64Decode", "Hash", "JsonMerge", "MathAdd", "MathRandom", "StringSplit", "UUID"]);

function object(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walkTemplate(value: unknown, location: string, diagnostics: ValidationDiagnostic[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => walkTemplate(item, `${location}[${index}]`, diagnostics)); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith(".$")) {
      const intrinsic = typeof item === "string" ? item.match(/^States\.([A-Za-z]+)\((.*)\)$/s) : undefined;
      if (typeof item !== "string" || !(intrinsic && INTRINSICS.has(intrinsic[1]) || isReferencePath(item))) diagnostics.push(error(`${location}.${key}`, "Dynamic values must contain a supported JSONPath or States intrinsic expression."));
    } else walkTemplate(item, `${location}.${key}`, diagnostics);
  }
}

function hasTaskToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTaskToken);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, item]) => key.endsWith(".$") && item === "$$.Task.Token" || hasTaskToken(item));
}

function validateChoiceRule(rule: unknown, location: string, diagnostics: ValidationDiagnostic[], outer = true): void {
  if (!object(rule)) { diagnostics.push(error(location, "Choice rule must be an object.")); return; }
  if (outer && typeof rule.Next !== "string") diagnostics.push(error(`${location}.Next`, "Choice rule requires Next."));
  if (!outer && rule.Next !== undefined) diagnostics.push(error(`${location}.Next`, "Nested choice expressions cannot contain Next."));
  const logical = ["And", "Or", "Not"].filter(field => rule[field] !== undefined);
  const operators = Object.keys(rule).filter(field => CHOICE_OPERATORS.has(field));
  if (logical.length + operators.length !== 1) diagnostics.push(error(location, "Choice rule must contain exactly one comparison or logical operator."));
  for (const field of Object.keys(rule)) if (!["Next", "Comment", "Variable", "And", "Or", "Not"].includes(field) && !CHOICE_OPERATORS.has(field)) diagnostics.push(error(`${location}.${field}`, `Unsupported Choice operator '${field}'.`));
  if (logical.length) {
    if (rule.Variable !== undefined) diagnostics.push(error(`${location}.Variable`, "Logical Choice rules cannot contain Variable."));
    for (const field of ["And", "Or"]) if (rule[field] !== undefined) {
      if (!Array.isArray(rule[field]) || !rule[field].length) diagnostics.push(error(`${location}.${field}`, `${field} requires a non-empty array.`));
      else rule[field].forEach((item: unknown, index: number) => validateChoiceRule(item, `${location}.${field}[${index}]`, diagnostics, false));
    }
    if (rule.Not !== undefined) validateChoiceRule(rule.Not, `${location}.Not`, diagnostics, false);
  } else {
    if (!isReferencePath(rule.Variable)) diagnostics.push(error(`${location}.Variable`, "A comparison Choice rule requires a reference-path Variable."));
    const operator = operators[0]; const value = operator ? rule[operator] : undefined;
    if (operator?.endsWith("Path") && !isReferencePath(value)) diagnostics.push(error(`${location}.${operator}`, `${operator} requires a reference path.`));
    if (operator?.startsWith("Is") && typeof value !== "boolean") diagnostics.push(error(`${location}.${operator}`, `${operator} requires a Boolean.`));
  }
}

function error(location: string, message: string, code = "SCHEMA_VALIDATION_FAILED"): ValidationDiagnostic {
  return { severity: "ERROR", code, message, location };
}

function validateRetriers(value: unknown, location: string, diagnostics: ValidationDiagnostic[]): void {
  if (!Array.isArray(value)) { diagnostics.push(error(location, "Retry must be an array.")); return; }
  value.forEach((raw, index) => {
    const at = `${location}[${index}]`;
    if (!object(raw) || !Array.isArray(raw.ErrorEquals) || raw.ErrorEquals.some((item: unknown) => typeof item !== "string")) diagnostics.push(error(at, "A retrier requires an ErrorEquals string array."));
    for (const field of Object.keys(raw ?? {})) if (!["ErrorEquals", "IntervalSeconds", "MaxAttempts", "BackoffRate", "MaxDelaySeconds", "JitterStrategy"].includes(field)) diagnostics.push(error(`${at}.${field}`, `Field '${field}' is not supported in a retrier.`));
    if (raw.IntervalSeconds !== undefined && (!Number.isInteger(raw.IntervalSeconds) || raw.IntervalSeconds < 0)) diagnostics.push(error(`${at}.IntervalSeconds`, "IntervalSeconds must be a non-negative integer."));
    if (raw.MaxAttempts !== undefined && (!Number.isInteger(raw.MaxAttempts) || raw.MaxAttempts < 0)) diagnostics.push(error(`${at}.MaxAttempts`, "MaxAttempts must be a non-negative integer."));
    if (raw.BackoffRate !== undefined && (!(raw.BackoffRate > 0))) diagnostics.push(error(`${at}.BackoffRate`, "BackoffRate must be greater than zero."));
    if (raw.MaxDelaySeconds !== undefined && (!Number.isInteger(raw.MaxDelaySeconds) || raw.MaxDelaySeconds < 0)) diagnostics.push(error(`${at}.MaxDelaySeconds`, "MaxDelaySeconds must be a non-negative integer."));
    if (raw.JitterStrategy !== undefined && !["FULL", "NONE"].includes(raw.JitterStrategy)) diagnostics.push(error(`${at}.JitterStrategy`, "JitterStrategy must be FULL or NONE."));
  });
}

function validateCatchers(value: unknown, location: string, states: Record<string, any>, diagnostics: ValidationDiagnostic[]): void {
  if (!Array.isArray(value)) { diagnostics.push(error(location, "Catch must be an array.")); return; }
  value.forEach((raw, index) => {
    const at = `${location}[${index}]`;
    if (!object(raw) || !Array.isArray(raw.ErrorEquals) || typeof raw.Next !== "string") diagnostics.push(error(at, "A catcher requires ErrorEquals and Next."));
    for (const field of Object.keys(raw ?? {})) if (!["ErrorEquals", "Next", "ResultPath", "Output"].includes(field)) diagnostics.push(error(`${at}.${field}`, `Field '${field}' is not supported in a catcher.`));
    if (typeof raw?.Next === "string" && !states[raw.Next]) diagnostics.push(error(`${at}.Next`, `Target '${raw.Next}' does not exist.`));
    if (raw?.ResultPath !== undefined && raw.ResultPath !== null && !isReferencePath(raw.ResultPath)) diagnostics.push(error(`${at}.ResultPath`, "ResultPath must be null or a reference path."));
  });
}

function validateGraph(definition: any, location: string, diagnostics: ValidationDiagnostic[], region: string, accountId: string): void {
  if (!object(definition)) { diagnostics.push(error(location, "The state machine definition must be an object.")); return; }
  for (const field of Object.keys(definition)) if (!["Comment", "Version", "TimeoutSeconds", "StartAt", "States", "QueryLanguage"].includes(field)) diagnostics.push(error(`${location}.${field}`, `Unsupported top-level field '${field}'.`));
  if (definition.QueryLanguage !== undefined && definition.QueryLanguage !== "JSONPath") diagnostics.push(error(`${location}.QueryLanguage`, "JSONata requires SFN-05; P0 supports JSONPath only.", "UNSUPPORTED_FEATURE"));
  if (definition.Version !== undefined && definition.Version !== "1.0") diagnostics.push(error(`${location}.Version`, "Version must be '1.0'."));
  if (definition.TimeoutSeconds !== undefined && (!Number.isInteger(definition.TimeoutSeconds) || definition.TimeoutSeconds < 1 || definition.TimeoutSeconds > 31_536_000)) diagnostics.push(error(`${location}.TimeoutSeconds`, "TimeoutSeconds must be between 1 and 31536000."));
  if (typeof definition.StartAt !== "string") diagnostics.push(error(`${location}.StartAt`, "StartAt is required."));
  if (!object(definition.States) || Object.keys(definition.States).length === 0) { diagnostics.push(error(`${location}.States`, "States must be a non-empty object.")); return; }
  if (typeof definition.StartAt === "string" && !definition.States[definition.StartAt]) diagnostics.push(error(`${location}.StartAt`, `StartAt target '${definition.StartAt}' does not exist.`));
  const states = definition.States as Record<string, any>;
  for (const [name, state] of Object.entries(states)) {
    const at = `${location}.States.${name}`;
    if (!name || [...name].length > 128) diagnostics.push(error(at, "State names must contain 1-128 characters."));
    if (!object(state) || typeof state.Type !== "string" || !FIELDS[state.Type]) { diagnostics.push(error(`${at}.Type`, `Unsupported state type '${state?.Type ?? ""}'.`)); continue; }
    for (const field of Object.keys(state)) if (!FIELDS[state.Type].includes(field)) diagnostics.push(error(`${at}.${field}`, `Field '${field}' is not supported for ${state.Type}.`));
    const terminal = ["Succeed", "Fail"].includes(state.Type);
    if (!terminal && state.Type !== "Choice" && (state.End === true) === (typeof state.Next === "string")) diagnostics.push(error(at, `${state.Type} must contain exactly one of Next or End.`));
    if (terminal && (state.Next !== undefined || state.End !== undefined)) diagnostics.push(error(at, `${state.Type} cannot contain Next or End.`));
    if (typeof state.Next === "string" && !states[state.Next]) diagnostics.push(error(`${at}.Next`, `Target '${state.Next}' does not exist.`));
    for (const pathField of PATH_FIELDS) if (state[pathField] !== undefined && state[pathField] !== null && !isReferencePath(state[pathField])) diagnostics.push(error(`${at}.${pathField}`, `${pathField} must be null or a reference path.`));
    for (const templateField of ["Parameters", "ResultSelector", "ItemSelector"]) if (state[templateField] !== undefined) walkTemplate(state[templateField], `${at}.${templateField}`, diagnostics);
    if (state.Type === "Choice") {
      if (!Array.isArray(state.Choices) || !state.Choices.length) diagnostics.push(error(`${at}.Choices`, "Choice requires at least one rule."));
      for (const [index, choice] of (state.Choices ?? []).entries()) {
        validateChoiceRule(choice, `${at}.Choices[${index}]`, diagnostics);
        if (object(choice) && typeof choice.Next === "string" && !states[choice.Next]) diagnostics.push(error(`${at}.Choices[${index}].Next`, `Target '${choice.Next}' does not exist.`));
      }
      if (state.Default !== undefined && !states[state.Default]) diagnostics.push(error(`${at}.Default`, `Default target '${state.Default}' does not exist.`));
    }
    if (state.Type === "Wait") {
      const forms = ["Seconds", "SecondsPath", "Timestamp", "TimestampPath"].filter(field => state[field] !== undefined);
      if (forms.length !== 1) diagnostics.push(error(at, "Wait requires exactly one Seconds, SecondsPath, Timestamp, or TimestampPath field."));
      if (state.Seconds !== undefined && (!Number.isInteger(state.Seconds) || state.Seconds < 0 || state.Seconds > 31_536_000)) diagnostics.push(error(`${at}.Seconds`, "Seconds is outside the supported range."));
      if (state.Timestamp !== undefined && (typeof state.Timestamp !== "string" || !Number.isFinite(Date.parse(state.Timestamp)))) diagnostics.push(error(`${at}.Timestamp`, "Timestamp must be an RFC3339 timestamp."));
    }
    if (state.Type === "Task") {
      if (typeof state.Resource !== "string") diagnostics.push(error(`${at}.Resource`, "Task Resource is required."));
      else if (INTEGRATIONS[state.Resource]) {
        const integration = INTEGRATIONS[state.Resource];
        if (!object(state.Parameters)) diagnostics.push(error(`${at}.Parameters`, "Optimized integrations require a Parameters object."));
        else {
          for (const field of Object.keys(state.Parameters)) if (!integration.fields.includes(field.replace(/\.\$$/, ""))) diagnostics.push(error(`${at}.Parameters.${field}`, `Parameter '${field}' is not supported by this integration.`));
          for (const field of integration.required) if (state.Parameters[field] === undefined && state.Parameters[`${field}.$`] === undefined) diagnostics.push(error(`${at}.Parameters.${field}`, `${field} is required.`));
          if (integration.callback && !hasTaskToken(state.Parameters)) diagnostics.push(error(`${at}.Parameters`, "A wait-for-task-token integration must place $$.Task.Token in Parameters."));
          const staticArnScope = (field: string, pattern: RegExp, label: string) => {
            const value = state.Parameters[field]; if (typeof value !== "string" || !value.startsWith("arn:")) return;
            const match = value.match(pattern); if (!match || match[1] !== region || match[2] !== accountId) diagnostics.push(error(`${at}.Parameters.${field}`, `${label} must target the same account and Region.`, "UNSUPPORTED_FEATURE"));
          };
          if (state.Resource.startsWith("arn:aws:states:::lambda:")) staticArnScope("FunctionName", /^arn:aws:lambda:([^:]+):(\d{12}):function:/, "Lambda integration");
          if (state.Resource.startsWith("arn:aws:states:::dynamodb:")) staticArnScope("TableName", /^arn:aws:dynamodb:([^:]+):(\d{12}):table\//, "DynamoDB integration");
          if (state.Resource.startsWith("arn:aws:states:::sns:")) {
            if (state.Parameters.TopicArn === undefined && state.Parameters["TopicArn.$"] === undefined && state.Parameters.TargetArn === undefined && state.Parameters["TargetArn.$"] === undefined) diagnostics.push(error(`${at}.Parameters.TopicArn`, "The local SNS integration requires TopicArn or TargetArn."));
            staticArnScope(state.Parameters.TopicArn !== undefined ? "TopicArn" : "TargetArn", /^arn:aws:sns:([^:]+):(\d{12}):/, "SNS integration");
          }
          if (state.Resource.startsWith("arn:aws:states:::states:")) staticArnScope("StateMachineArn", /^arn:aws:states:([^:]+):(\d{12}):stateMachine:/, "Nested workflow");
          if (state.Resource.startsWith("arn:aws:states:::sqs:") && typeof state.Parameters.QueueUrl === "string") {
            try { const parts = new URL(state.Parameters.QueueUrl).pathname.split("/").filter(Boolean); const suppliedAccount = parts.at(-2); if (/^\d{12}$/.test(suppliedAccount ?? "") && suppliedAccount !== accountId) diagnostics.push(error(`${at}.Parameters.QueueUrl`, "SQS integrations must target the same account.", "UNSUPPORTED_FEATURE")); }
            catch { diagnostics.push(error(`${at}.Parameters.QueueUrl`, "QueueUrl must be a valid URL.")); }
          }
          if (state.Resource === "arn:aws:states:::events:putEvents" && Array.isArray(state.Parameters.Entries)) for (const [index, entry] of state.Parameters.Entries.entries()) if (object(entry)) {
            const bus = entry.EventBusName; if (typeof bus === "string" && bus.startsWith("arn:")) { const match = bus.match(/^arn:aws:events:([^:]+):(\d{12}):event-bus\//); if (!match || match[1] !== region || match[2] !== accountId) diagnostics.push(error(`${at}.Parameters.Entries[${index}].EventBusName`, "EventBridge integrations must target the same account and Region.", "UNSUPPORTED_FEATURE")); }
          }
        }
      } else if (state.Resource !== LAMBDA_OPTIMIZED) {
        const match = state.Resource.match(LAMBDA_DIRECT);
        const activity = state.Resource.match(ACTIVITY);
        if (!match && !activity) diagnostics.push(error(`${at}.Resource`, "The Task resource or integration pattern is not supported by SFN-03.", "UNSUPPORTED_FEATURE"));
        else if (match && (match[1] !== region || match[2] !== accountId)) diagnostics.push(error(`${at}.Resource`, "Lambda tasks must target the same account and Region."));
        else if (activity && (activity[1] !== region || activity[2] !== accountId)) diagnostics.push(error(`${at}.Resource`, "Activities must target the same account and Region."));
        else if (activity && /[\s<>{}\[\]?*"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f]/u.test(activity[3])) diagnostics.push(error(`${at}.Resource`, "Activity name is invalid."));
        else if (activity && hasTaskToken(state.Parameters)) diagnostics.push(error(`${at}.Parameters`, "Activity tasks receive their task token from GetActivityTask; $$.Task.Token is unsupported in Activity input.", "UNSUPPORTED_FEATURE"));
      }
      if (state.Resource === LAMBDA_OPTIMIZED && typeof state.Parameters?.FunctionName !== "string" && typeof state.Parameters?.["FunctionName.$"] !== "string") diagnostics.push(error(`${at}.Parameters.FunctionName`, "Optimized Lambda invoke requires FunctionName."));
      for (const prefix of ["Timeout", "Heartbeat"]) {
        const seconds = state[`${prefix}Seconds`]; const path = state[`${prefix}SecondsPath`];
        if (seconds !== undefined && path !== undefined) diagnostics.push(error(at, `${prefix}Seconds and ${prefix}SecondsPath are mutually exclusive.`));
        if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 99_999_999)) diagnostics.push(error(`${at}.${prefix}Seconds`, `${prefix}Seconds must be an integer from 1 through 99999999.`));
      }
    }
    if (state.Retry !== undefined) validateRetriers(state.Retry, `${at}.Retry`, diagnostics);
    if (state.Catch !== undefined) validateCatchers(state.Catch, `${at}.Catch`, states, diagnostics);
    if (state.Type === "Parallel") {
      if (!Array.isArray(state.Branches) || !state.Branches.length) diagnostics.push(error(`${at}.Branches`, "Parallel requires at least one branch."));
      else state.Branches.forEach((branch: any, index: number) => validateGraph(branch, `${at}.Branches[${index}]`, diagnostics, region, accountId));
    }
    if (state.Type === "Map") {
      if (state.Iterator !== undefined && state.ItemProcessor !== undefined) diagnostics.push(error(at, "Map cannot contain both Iterator and ItemProcessor."));
      const processor = state.ItemProcessor ?? state.Iterator;
      if (!processor) diagnostics.push(error(at, "Map requires ItemProcessor or Iterator."));
      else {
        if (processor.ProcessorConfig?.Mode && processor.ProcessorConfig.Mode !== "INLINE") diagnostics.push(error(`${at}.ItemProcessor.ProcessorConfig.Mode`, "Distributed Map requires SFN-07.", "UNSUPPORTED_FEATURE"));
        const graph = { ...processor }; delete graph.ProcessorConfig; validateGraph(graph, `${at}.${state.ItemProcessor ? "ItemProcessor" : "Iterator"}`, diagnostics, region, accountId);
      }
      if (state.MaxConcurrency !== undefined && (!Number.isInteger(state.MaxConcurrency) || state.MaxConcurrency < 0 || state.MaxConcurrency > 40)) diagnostics.push(error(`${at}.MaxConcurrency`, "Inline Map MaxConcurrency must be between 0 and 40."));
    }
  }
}

export function validateDefinition(definitionText: unknown, region: string, accountId: string): { definition?: CompiledDefinition; diagnostics: ValidationDiagnostic[] } {
  const diagnostics: ValidationDiagnostic[] = [];
  if (typeof definitionText !== "string") return { diagnostics: [error("/", "Definition must be a JSON string.")] };
  if (Buffer.byteLength(definitionText) > 1024 * 1024) return { diagnostics: [error("/", "Definition exceeds the 1 MiB limit.")] };
  let definition: unknown;
  try { definition = JSON.parse(definitionText); }
  catch (cause) { return { diagnostics: [error("/", `Definition is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, "INVALID_JSON_DESCRIPTION")] }; }
  validateGraph(definition, "$", diagnostics, region, accountId);
  return diagnostics.some(item => item.severity === "ERROR") ? { diagnostics } : { definition: definition as CompiledDefinition, diagnostics };
}
