import { rest } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader, tabs } from "../components.js";
import { decorateCloudFormationPanelHelp } from "./cloudformation-help.js";

export const metadata = {
  key: "cloudformation",
  name: "CloudFormation",
  icon: "C",
  cls: "cloudformation",
  links: [["Stacks", "#/cloudformation/stacks"], ["Exports", "#/cloudformation/exports"], ["Local CDK setup", "#/cloudformation/setup"]],
  search: ["cloudformation", "cloud formation", "cfn", "stacks", "infrastructure as code", "cdk"],
};

const apiRoot = "/_stacksim/api/cloudformation/stacks";

const field = (value, ...names) => {
  for (const name of names) if (value?.[name] !== undefined) return value[name];
  return undefined;
};

const array = (value, ...names) => {
  const selected = field(value, ...names);
  if (Array.isArray(selected)) return selected;
  if (selected && typeof selected === "object") return Object.values(selected);
  return [];
};

const humanBytes = value => {
  const bytes = Number(value ?? 0);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
};

const typedConfirmation = (name, action) => `<div class="field"><label>To confirm ${escapeHtml(action)}, enter <strong>${escapeHtml(name)}</strong></label><input name="confirmation" required pattern="${escapeHtml(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}"></div>`;

function templateText(payload) {
  let body = field(payload, "templateBody", "TemplateBody");
  if (body === undefined && payload && typeof payload === "object" && !Array.isArray(payload)) body = payload;
  if (typeof body === "string") {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
  }
  return JSON.stringify(body ?? {}, null, 2);
}

function parameterOverrides(value) {
  const source = String(value ?? "").trim();
  if (!source) return undefined;
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Parameter overrides must be a JSON object");
  return Object.fromEntries(Object.entries(parsed).map(([key, nested]) => [key, String(nested)]));
}

function capabilityValues(value) {
  const values = String(value ?? "").split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function exportHref(name) {
  return `#/cloudformation/exports/${encodeURIComponent(name)}`;
}

function normalizeStack(value = {}) {
  return {
    name: String(field(value, "stackName", "StackName") ?? ""),
    id: String(field(value, "stackId", "StackId") ?? ""),
    description: String(field(value, "description", "Description") ?? ""),
    status: String(field(value, "stackStatus", "StackStatus") ?? "UNKNOWN"),
    statusReason: String(field(value, "stackStatusReason", "StackStatusReason") ?? ""),
    createdAt: field(value, "creationTime", "CreationTime"),
    updatedAt: field(value, "lastUpdatedTime", "LastUpdatedTime"),
    deletedAt: field(value, "deletionTime", "DeletionTime"),
    terminationProtection: Boolean(field(value, "enableTerminationProtection", "terminationProtection", "EnableTerminationProtection")),
    disableRollback: Boolean(field(value, "disableRollback", "DisableRollback")),
    roleArn: String(field(value, "roleArn", "RoleARN") ?? ""),
    notificationArns: array(value, "notificationArns", "NotificationARNs"),
    capabilities: array(value, "capabilities", "Capabilities"),
    activeOperation: field(value, "activeOperation", "ActiveOperation"),
    parameters: array(value, "parameters", "Parameters"),
    outputs: array(value, "outputs", "Outputs"),
    tags: field(value, "tags", "Tags") ?? {},
    parentId: String(field(value, "parentId", "ParentId") ?? ""),
    rootId: String(field(value, "rootId", "RootId") ?? ""),
    parentLogicalId: String(field(value, "parentLogicalId", "ParentLogicalId") ?? ""),
  };
}

function normalizeCollection(payload, ...names) {
  if (Array.isArray(payload)) return payload;
  return array(payload, ...names);
}

function statusMarkup(status) {
  const value = String(status || "UNKNOWN");
  const css = value.endsWith("_IN_PROGRESS") || value.endsWith("_PENDING")
    ? "pending"
    : value.includes("FAILED") || value.includes("ROLLBACK")
      ? "error"
      : value.includes("DELETE_COMPLETE") ? "inactive" : "";
  return `<span class="status ${css}">${escapeHtml(value)}</span>`;
}

function dateMarkup(value) {
  if (value === undefined || value === null || value === "") return "&ndash;";
  const date = value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : escapeHtml(formatDate(date));
}

function stackTabs(name, active) {
  const root = `#/cloudformation/stacks/${encodeURIComponent(name)}`;
  return tabs([
    { label: "Stack info", href: `${root}/overview`, active: active === "overview" },
    { label: "Events", href: `${root}/events`, active: active === "events" },
    { label: "Resources", href: `${root}/resources`, active: active === "resources" },
    { label: "Outputs", href: `${root}/outputs`, active: active === "outputs" },
    { label: "Parameters", href: `${root}/parameters`, active: active === "parameters" },
    { label: "Template", href: `${root}/template`, active: active === "template" },
    { label: "Change sets", href: `${root}/change-sets`, active: active === "change-sets" },
    { label: "Tags", href: `${root}/tags`, active: active === "tags" },
  ]);
}

function detailBreadcrumbs(stackName, active) {
  const labels = { overview: "Stack info", events: "Events", resources: "Resources", outputs: "Outputs", parameters: "Parameters", template: "Template", "change-sets": "Change sets", tags: "Tags" };
  const root = `#/cloudformation/stacks/${encodeURIComponent(stackName)}`;
  return [
    { label: "CloudFormation", href: "#/cloudformation/stacks" },
    { label: "Stacks", href: "#/cloudformation/stacks" },
    ...(active === "overview" ? [stackName] : [{ label: stackName, href: `${root}/overview` }, labels[active]]),
  ];
}

function stackPath(name, suffix = "") {
  return `${apiRoot}/${encodeURIComponent(name)}${suffix}`;
}

function parametersContent(parameters) {
  const rows = parameters.map(parameter => {
    const key = field(parameter, "parameterKey", "ParameterKey") ?? "";
    const value = field(parameter, "parameterValue", "ParameterValue", "resolvedValue", "ResolvedValue") ?? "";
    const resolved = field(parameter, "resolvedValue", "ResolvedValue");
    const previous = Boolean(field(parameter, "usePreviousValue", "UsePreviousValue"));
    return `<tr><td class="mono">${escapeHtml(key)}</td><td class="mono">${escapeHtml(value)}</td><td class="mono">${resolved === undefined ? "-" : escapeHtml(resolved)}</td><td>${previous ? "Yes" : "No"}</td></tr>`;
  }).join("");
  return `<section class="card"><div class="card-header"><h2>Parameters <span class="muted">(${parameters.length})</span></h2></div>${rows ? `<div class="table-wrap"><table class="cloudformation-parameter-table"><thead><tr><th>Key</th><th>Value</th><th>Resolved value</th><th>Use previous value</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("P", "No parameters", "This stack does not define any parameter values.")}</section>`;
}

function tagEntries(tags) {
  if (Array.isArray(tags)) return tags.map(tag => [field(tag, "key", "Key"), field(tag, "value", "Value")]);
  return Object.entries(tags ?? {});
}

function tagsContent(tags) {
  const entries = tagEntries(tags);
  const rows = entries.map(([key, value]) => `<tr><td class="mono">${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("");
  return `<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${entries.length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("T", "No tags", "This stack does not have any tags.")}</section>`;
}

function hierarchyContent(stack, hierarchy) {
  if (hierarchy.length <= 1 && !stack.parentId) return "";
  const byId = new Map(hierarchy.map(item => [item.id, item]));
  const children = new Map();
  for (const item of hierarchy) {
    const key = item.parentId || "";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(item);
  }
  for (const values of children.values()) values.sort((left, right) => left.name.localeCompare(right.name));
  const root = byId.get(stack.rootId) ?? (stack.parentId ? undefined : stack) ?? hierarchy.find(item => !item.parentId);
  const render = item => `<li><a href="#/cloudformation/stacks/${encodeURIComponent(item.name)}/overview">${escapeHtml(item.name)}</a> ${item.parentId ? '<span class="status">NESTED</span>' : '<span class="status">ROOT</span>'} ${statusMarkup(item.status)}${(children.get(item.id) ?? []).length ? `<ul>${children.get(item.id).map(render).join("")}</ul>` : ""}</li>`;
  const relationship = stack.parentId
    ? `<p class="muted small">Parent: <a href="#/cloudformation/stacks/${encodeURIComponent(byId.get(stack.parentId)?.name ?? stack.parentId)}/overview">${escapeHtml(byId.get(stack.parentId)?.name ?? stack.parentId)}</a>${stack.parentLogicalId ? ` via <span class="mono">${escapeHtml(stack.parentLogicalId)}</span>` : ""}</p>`
    : '<p class="muted small">This is the root of the deployed stack hierarchy.</p>';
  return `<section class="card cloudformation-hierarchy"><div class="card-header"><div><h2>Stack hierarchy <span class="muted">(${hierarchy.length})</span></h2>${relationship}</div></div><div class="card-body"><ul>${root ? render(root) : hierarchy.map(render).join("")}</ul></div></section>`;
}

function stackInfoContent(stack) {
  const operation = stack.activeOperation;
  return `<section class="card cloudformation-stack-info"><div class="card-header"><h2>Stack details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Status</dt><dd>${statusMarkup(stack.status)}</dd><dt>Status reason</dt><dd>${escapeHtml(stack.statusReason || "-")}</dd><dt>Rollback on create failure</dt><dd>${stack.disableRollback ? "Disabled" : "Enabled"}</dd></dl><dl class="key-value"><dt>Created</dt><dd>${dateMarkup(stack.createdAt)}</dd><dt>Last updated</dt><dd>${dateMarkup(stack.updatedAt)}</dd><dt>Deleted</dt><dd>${dateMarkup(stack.deletedAt)}</dd></dl><dl class="key-value"><dt>Termination protection</dt><dd>${stack.terminationProtection ? "Enabled" : "Disabled"}</dd><dt>Execution role</dt><dd class="mono">${escapeHtml(stack.roleArn || "Caller credentials")}</dd><dt>Capabilities</dt><dd>${stack.capabilities.length ? stack.capabilities.map(escapeHtml).join(", ") : "-"}</dd></dl></div><div class="card-body cloudformation-identifiers"><div class="detail-grid"><dl class="key-value"><dt>Stack ID</dt><dd class="mono">${escapeHtml(stack.id || "-")}</dd><dt>Description</dt><dd>${escapeHtml(stack.description || "-")}</dd></dl><dl class="key-value"><dt>Notification ARNs</dt><dd class="mono">${stack.notificationArns.length ? stack.notificationArns.map(escapeHtml).join("<br>") : "-"}</dd></dl><dl class="key-value"><dt>Active operation</dt><dd>${operation ? `${escapeHtml(field(operation, "kind", "Kind") ?? "-")} · ${escapeHtml(field(operation, "status", "Status") ?? "-")}` : "None"}</dd></dl></div></div></section>`;
}

function overviewContent(stack, hierarchy = []) {
  return `${hierarchyContent(stack, hierarchy)}${stackInfoContent(stack)}`;
}

function eventsContent(payload) {
  const events = normalizeCollection(payload, "events", "StackEvents");
  const selectedOperationId = String(field(payload, "operationId", "OperationId") ?? "");
  const operationIds = array(payload, "operationIds", "OperationIds");
  const rows = events.map(event => {
    const operationId = field(event, "operationId", "OperationId") ?? "-";
    return `<tr><td class="no-wrap">${dateMarkup(field(event, "timestamp", "Timestamp"))}</td><td class="mono">${escapeHtml(field(event, "logicalResourceId", "LogicalResourceId") ?? "-")}</td><td>${statusMarkup(field(event, "resourceStatus", "ResourceStatus"))}</td><td class="mono">${escapeHtml(field(event, "resourceType", "ResourceType") ?? "-")}</td><td class="mono cloudformation-event-operation">${escapeHtml(operationId)}</td><td>${escapeHtml(field(event, "resourceStatusReason", "ResourceStatusReason") ?? "-")}</td></tr>`;
  }).join("");
  const filter = `<label class="filter"><span>Operation</span><select data-operation-filter aria-label="Operation ID filter"><option value="">All operations</option>${operationIds.map(operationId => `<option value="${escapeHtml(operationId)}" ${selectedOperationId === operationId ? "selected" : ""}>${escapeHtml(operationId)}</option>`).join("")}</select></label>`;
  return `<section class="card" data-events-panel><div class="card-header"><div><h2>Stack events <span class="muted">(${events.length})</span></h2><p class="muted small">Newest events appear first. Filter to one durable stack operation when investigating a lifecycle attempt.</p></div></div><div class="toolbar">${filter}</div>${rows ? `<div class="table-wrap"><table class="cloudformation-event-table"><thead><tr><th>Timestamp</th><th>Logical ID</th><th>Status</th><th>Type</th><th>Operation ID</th><th>Status reason</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("E", "No stack events", selectedOperationId ? "No events were recorded for this operation." : "CloudFormation has not recorded an event for this stack.")}</section>`;
}

function resourceName(id) {
  return id.includes(":") || id.includes("/") ? id.split(/[/:]/).filter(Boolean).at(-1) : id;
}

function lambdaFunctionName(value) {
  const name = String(value ?? "");
  const arnMarker = name.indexOf(":function:");
  if (arnMarker >= 0) return name.slice(arnMarker + ":function:".length).split(":")[0];
  return name.split(":")[0];
}

function iamRoleName(value) {
  const name = String(value ?? "");
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

function s3ObjectsHref(bucketName, prefix) {
  const root = `#/s3/buckets/${encodeURIComponent(bucketName)}/objects`;
  if (typeof prefix !== "string" || !prefix) return root;
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${root}/${encodeURIComponent(normalizedPrefix)}`;
}

export function relatedResourceLinks(resource) {
  const type = String(field(resource, "resourceType", "ResourceType") ?? "");
  const id = String(field(resource, "physicalResourceId", "PhysicalResourceId") ?? "");
  if (!id) return [];
  const name = resourceName(id);
  const properties = field(resource, "properties", "Properties") ?? {};
  const restApiId = field(properties, "RestApiId", "restApiId");
  const functionProperty = field(properties, "FunctionName", "functionName");
  const permissionTarget = type === "AWS::Lambda::Permission" && id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : id;
  const functionName = lambdaFunctionName(functionProperty ?? permissionTarget);
  const single = href => href ? [{ href }] : [];

  if (type === "AWS::IAM::Policy") {
    const roles = field(properties, "Roles", "roles");
    const names = (Array.isArray(roles) ? roles : []).map(iamRoleName).filter(Boolean);
    if (!names.length) return single("#/iam/roles");
    return names.map(roleName => ({ label: roleName, href: `#/iam/roles/${encodeURIComponent(roleName)}/permissions` }));
  }
  if (type === "AWS::Lambda::Permission") return single(functionName ? `#/lambda/functions/${encodeURIComponent(functionName)}` : undefined);
  if (type === "AWS::Lambda::Version") return single(functionName ? `#/lambda/functions/${encodeURIComponent(functionName)}/versions` : undefined);
  if (type === "AWS::Lambda::Alias") return single(functionName ? `#/lambda/functions/${encodeURIComponent(functionName)}/aliases` : undefined);
  if (type === "AWS::CloudFormation::Stack") return single(`#/cloudformation/stacks/${encodeURIComponent(id)}/overview`);
  if (type === "AWS::ApiGateway::Resource" || type === "AWS::ApiGateway::Method") return single(restApiId ? `#/apigateway/apis/${encodeURIComponent(restApiId)}/resources` : undefined);
  if (type === "AWS::ApiGateway::Deployment" || type === "AWS::ApiGateway::Stage") return single(restApiId ? `#/apigateway/apis/${encodeURIComponent(restApiId)}/stages` : undefined);
  if (type === "AWS::ApiGateway::Account") return single("#/apigateway/account-settings");
  if (type === "AWS::ApiGateway::Authorizer") return single(restApiId ? `#/apigateway/apis/${encodeURIComponent(restApiId)}/authorizers` : undefined);
  if (type === "AWS::ApiGateway::Model") return single(restApiId ? `#/apigateway/apis/${encodeURIComponent(restApiId)}/models` : undefined);
  if (type === "AWS::ApiGateway::RequestValidator") return single(restApiId ? `#/apigateway/apis/${encodeURIComponent(restApiId)}/request-validators` : undefined);
  if (type === "AWS::ApiGateway::GatewayResponse") return single(restApiId ? `#/apigateway/apis/${encodeURIComponent(restApiId)}/gateway-responses` : undefined);
  if (type === "AWS::ApiGateway::ApiKey") return single(`#/apigateway/api-keys/${encodeURIComponent(id)}`);
  if (type === "AWS::ApiGateway::UsagePlan") return single(`#/apigateway/usage-plans/${encodeURIComponent(id)}/overview`);
  if (type === "AWS::ApiGateway::UsagePlanKey") {
    const usagePlanId = field(properties, "UsagePlanId", "usagePlanId");
    return single(usagePlanId ? `#/apigateway/usage-plans/${encodeURIComponent(usagePlanId)}/keys` : undefined);
  }
  if (type === "AWS::DynamoDB::Table") {
    const base = `#/dynamodb/tables/${encodeURIComponent(name)}`;
    return [
      { href: `${base}/overview` },
      { label: "Indexes", href: `${base}/indexes` },
      { label: "Streams", href: `${base}/streams` },
      { label: "Backups", href: `${base}/backups` },
      { label: "Permissions", href: `${base}/permissions` },
      { label: "Monitoring", href: `${base}/monitor` },
    ];
  }
  if (type === "Custom::CDKBucketDeployment") {
    const destinationBucketName = field(properties, "DestinationBucketName", "destinationBucketName");
    const destinationPrefix = field(properties, "DestinationBucketKeyPrefix", "destinationBucketKeyPrefix");
    return single(typeof destinationBucketName === "string" && destinationBucketName
      ? s3ObjectsHref(destinationBucketName, destinationPrefix)
      : undefined);
  }

  const routes = {
    "AWS::Lambda::Function": `#/lambda/functions/${encodeURIComponent(functionName)}`,
    "AWS::IAM::Role": `#/iam/roles/${encodeURIComponent(name)}`,
    "AWS::IAM::ManagedPolicy": `#/iam/policies/${encodeURIComponent(id)}`,
    "AWS::Logs::LogGroup": `#/cloudwatch/log-groups/${encodeURIComponent(id)}`,
    "AWS::ApiGateway::RestApi": `#/apigateway/apis/${encodeURIComponent(id)}`,
    "AWS::S3::Bucket": s3ObjectsHref(name),
    "AWS::SQS::Queue": `#/sqs/queues/${encodeURIComponent(name)}`,
    "AWS::RDS::DBInstance": `#/rds/databases/${encodeURIComponent(name)}/connectivity`,
    "AWS::SES::EmailIdentity": `#/ses/identities/${encodeURIComponent(id)}`,
    "AWS::SES::ConfigurationSet": `#/ses/configuration-sets/${encodeURIComponent(id)}`,
    "AWS::SES::Template": `#/ses/templates/${encodeURIComponent(id)}`,
    "AWS::StepFunctions::StateMachine": `#/step-functions/state-machines/${encodeURIComponent(id)}`,
  };
  return single(routes[type]);
}

function physicalIdMarkup(resource) {
  const id = field(resource, "physicalResourceId", "PhysicalResourceId") ?? "";
  if (!id) return "-";
  const links = relatedResourceLinks(resource);
  const href = links[0]?.href;
  const primary = href ? `<a class="mono" href="${escapeHtml(href)}">${escapeHtml(id)}</a>` : escapeHtml(id);
  const companionLinks = links.slice(1);
  if (!companionLinks.length) return primary;
  return `${primary}<div class="small cloudformation-resource-links">${companionLinks.map(link => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join(" | ")}</div>`;
}

function resourcesContent(payload) {
  const resources = normalizeCollection(payload, "resources", "StackResources", "StackResourceSummaries");
  const invokeLinks = normalizeCollection(payload, "localApiInvokeLinks", "LocalApiInvokeLinks");
  const rows = resources.map(resource => `<tr><td class="mono">${escapeHtml(field(resource, "logicalResourceId", "LogicalResourceId") ?? "-")}</td><td class="mono">${physicalIdMarkup(resource)}</td><td class="mono">${escapeHtml(field(resource, "resourceType", "ResourceType") ?? "-")}</td><td>${statusMarkup(field(resource, "resourceStatus", "ResourceStatus"))}</td><td class="no-wrap">${dateMarkup(field(resource, "lastUpdatedTimestamp", "LastUpdatedTimestamp", "timestamp", "Timestamp"))}</td></tr>`).join("");
  const localInvoke = invokeLinks.length ? `<section class="card cloudformation-local-invoke"><div class="card-header"><div><h2>Local API invoke links</h2><p class="muted small">Derived from this stack's physical REST API and stage resources. CloudFormation outputs remain unchanged.</p></div></div><div class="table-wrap"><table><thead><tr><th>Stage resource</th><th>API / stage</th><th>Local invoke URL</th></tr></thead><tbody>${invokeLinks.map(link => `<tr><td class="mono">${escapeHtml(field(link, "logicalResourceId", "LogicalResourceId") ?? "-")}</td><td><a href="#/apigateway/apis/${encodeURIComponent(field(link, "restApiId", "RestApiId") ?? "")}/stages">${escapeHtml(field(link, "restApiId", "RestApiId") ?? "-")} / ${escapeHtml(field(link, "stageName", "StageName") ?? "-")}</a></td><td><a class="mono cloudformation-local-invoke-url" href="${escapeHtml(field(link, "url", "Url") ?? "")}" target="_blank" rel="noopener noreferrer">${escapeHtml(field(link, "url", "Url") ?? "-")}</a></td></tr>`).join("")}</tbody></table></div></section>` : "";
  return `${localInvoke}<section class="card"><div class="card-header"><h2>Stack resources <span class="muted">(${resources.length})</span></h2></div>${rows ? `<div class="table-wrap"><table class="cloudformation-resource-table"><thead><tr><th>Logical ID</th><th>Physical ID</th><th>Type</th><th>Status</th><th>Last updated</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("R", "No stack resources", "This stack does not contain any materialized resources.")}</section>`;
}

function outputsContent(outputs) {
  const rows = outputs.map(output => {
    const exportName = field(output, "exportName", "ExportName");
    return `<tr><td class="mono">${escapeHtml(field(output, "outputKey", "OutputKey") ?? "-")}</td><td class="mono cloudformation-output-value">${escapeHtml(field(output, "outputValue", "OutputValue") ?? "")}</td><td>${escapeHtml(field(output, "description", "Description") ?? "-")}</td><td class="mono">${exportName ? `<a href="${exportHref(exportName)}">${escapeHtml(exportName)}</a>` : "-"}</td></tr>`;
  }).join("");
  return `<section class="card"><div class="card-header"><h2>Outputs <span class="muted">(${outputs.length})</span></h2></div>${rows ? `<div class="table-wrap"><table class="cloudformation-output-table"><thead><tr><th>Key</th><th>Value</th><th>Description</th><th>Export name</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("O", "No outputs", "This stack does not define any outputs.")}</section>`;
}

function templateContent(payload) {
  const templateStage = String(field(payload, "templateStage", "TemplateStage") ?? "Original");
  const rendered = templateText(payload);
  const description = templateStage === "Processed" ? "The condition-processed template used for planning and execution." : "The original template accepted for this stack.";
  return `<section class="card" data-template-panel><div class="card-header"><div><h2>Template</h2><p class="muted small">${escapeHtml(description)}</p></div><div class="actions"><label for="cloudformation-template-stage" class="small">Template stage</label><select id="cloudformation-template-stage" data-template-stage aria-label="Template stage"><option value="Original" ${templateStage === "Original" ? "selected" : ""}>Original</option><option value="Processed" ${templateStage === "Processed" ? "selected" : ""}>Processed</option></select><button class="button" type="button" data-copy="${escapeHtml(rendered)}">Copy</button></div></div><pre class="code-box cloudformation-template" data-template-stage-value="${escapeHtml(templateStage)}">${escapeHtml(rendered)}</pre></section>`;
}

function changeSetPath(stackName, changeSetName, suffix = "") {
  return `${stackPath(stackName, "/change-sets")}/${encodeURIComponent(changeSetName)}${suffix}`;
}

function changeSetsContent(payload, stackName) {
  const changeSets = normalizeCollection(payload, "changeSets", "Summaries");
  const rows = changeSets.map(changeSet => {
    const name = String(field(changeSet, "changeSetName", "ChangeSetName") ?? "");
    const status = field(changeSet, "status", "Status");
    const executionStatus = field(changeSet, "executionStatus", "ExecutionStatus");
    return `<tr data-search-row="${escapeHtml(`${name} ${status ?? ""} ${executionStatus ?? ""}`.toLowerCase())}"><td><a href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/change-sets/${encodeURIComponent(name)}">${escapeHtml(name)}</a></td><td>${statusMarkup(status)}</td><td>${statusMarkup(executionStatus)}</td><td class="no-wrap">${dateMarkup(field(changeSet, "creationTime", "CreationTime"))}</td><td>${escapeHtml(field(changeSet, "description", "Description") ?? "-")}</td></tr>`;
  }).join("");
  return `<section class="card"><div class="card-header"><div><h2>Change sets <span class="muted">(${changeSets.length})</span></h2><p class="muted small">Proposed changes created by CDK or the CloudFormation API.</p></div><button class="button primary" data-action="create-change-set">Create change set</button></div>${rows ? `<div class="toolbar"><label class="filter"><span aria-hidden="true">&#8981;</span><input data-filter-table placeholder="Find change sets"></label></div><div class="table-wrap"><table class="cloudformation-change-set-table"><thead><tr><th>Name</th><th>Status</th><th>Execution status</th><th>Created</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("C", "No change sets", "Create a reviewed CREATE or UPDATE plan from a JSON template before execution.")}</section>`;
}

function changeValue(value) {
  if (value === undefined) return "-";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function changeDetailsMarkup(details) {
  if (!details.length) return "-";
  return `<div class="cloudformation-change-details">${details.map(detail => {
    const target = field(detail, "target", "Target") ?? {};
    const attribute = field(target, "attribute", "Attribute") ?? "Properties";
    const name = field(target, "name", "Name");
    const label = name ? `${attribute}.${name}` : attribute;
    const before = field(target, "beforeValue", "BeforeValue");
    const after = field(target, "afterValue", "AfterValue");
    const source = field(detail, "changeSource", "ChangeSource") ?? field(detail, "evaluation", "Evaluation") ?? "-";
    const recreation = field(target, "requiresRecreation", "RequiresRecreation");
    const causingEntity = field(detail, "causingEntity", "CausingEntity");
    const context = [source, recreation ? `${recreation} recreation` : undefined, causingEntity ? `caused by ${causingEntity}` : undefined].filter(Boolean).join(" · ");
    return `<div><strong class="mono">${escapeHtml(label)}</strong><span class="muted small">${escapeHtml(context)}</span>${before !== undefined || after !== undefined ? `<span class="mono">${escapeHtml(changeValue(before))} &rarr; ${escapeHtml(changeValue(after))}</span>` : ""}</div>`;
  }).join("")}</div>`;
}

function changeSetDetailContent(payload, stackName) {
  const changeSet = field(payload, "changeSet", "ChangeSet") ?? payload;
  const name = String(field(changeSet, "changeSetName", "ChangeSetName") ?? "");
  const id = field(changeSet, "changeSetId", "ChangeSetId") ?? "";
  const status = String(field(changeSet, "status", "Status") ?? "UNKNOWN");
  const executionStatus = String(field(changeSet, "executionStatus", "ExecutionStatus") ?? "UNAVAILABLE");
  const changes = normalizeCollection(changeSet, "changes", "Changes");
  const replacementResources = changes.map(change => field(change, "resourceChange", "ResourceChange") ?? change).filter(resource => ["True", "Conditional"].includes(String(field(resource, "replacement", "Replacement") ?? "False")));
  const rows = changes.map(change => {
    const resource = field(change, "resourceChange", "ResourceChange") ?? change;
    const scope = array(resource, "scope", "Scope");
    const details = array(resource, "details", "Details");
    const replacement = String(field(resource, "replacement", "Replacement") ?? "False");
    const replacementMarkup = replacement === "False" ? "No" : `<span class="status error">${escapeHtml(replacement === "True" ? "Required" : "Conditional")}</span>`;
    return `<tr class="${replacement === "False" ? "" : "cloudformation-replacement-row"}"><td class="mono">${escapeHtml(field(resource, "logicalResourceId", "LogicalResourceId") ?? "-")}</td><td>${escapeHtml(field(resource, "action", "Action") ?? "-")}</td><td class="mono">${escapeHtml(field(resource, "resourceType", "ResourceType") ?? "-")}</td><td>${replacementMarkup}</td><td>${escapeHtml(field(resource, "policyAction", "PolicyAction") ?? "-")}</td><td>${scope.length ? scope.map(value => escapeHtml(value)).join(", ") : "-"}</td><td>${changeDetailsMarkup(details)}</td></tr>`;
  }).join("");
  const canExecute = status === "CREATE_COMPLETE" && executionStatus === "AVAILABLE";
  const canDelete = executionStatus !== "EXECUTE_IN_PROGRESS";
  const actionMarkup = `<div class="actions"><a class="button" href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/change-sets">All change sets</a>${canExecute ? '<button class="button primary" data-action="execute-change-set">Execute</button>' : ""}${canDelete ? '<button class="button danger" data-action="delete-change-set">Delete</button>' : ""}</div>`;
  const tags = field(changeSet, "tags", "Tags") ?? {};
  const parameters = array(changeSet, "parameters", "Parameters");
  const replacementNames = replacementResources.map(resource => field(resource, "logicalResourceId", "LogicalResourceId") ?? "Unknown resource");
  const replacementWarning = replacementResources.length ? `<div class="alert warning cloudformation-replacement-warning" role="alert"><strong>${replacementResources.length} resource replacement${replacementResources.length === 1 ? "" : "s"} may occur</strong><br>${replacementNames.map(value => `<span class="mono">${escapeHtml(value)}</span>`).join(", ")}. Review recreation requirements and replacement policy actions before execution.</div>` : "";
  return `<section class="card cloudformation-change-set-detail" data-change-set-name="${escapeHtml(name)}" data-replacement-count="${replacementResources.length}" data-replacement-resources="${escapeHtml(replacementNames.join(", "))}"><div class="card-header"><div><h2>${escapeHtml(name)}</h2><p class="muted small">${escapeHtml(field(changeSet, "description", "Description") ?? "CloudFormation change set")}</p></div>${actionMarkup}</div><div class="card-body detail-grid"><dl class="key-value"><dt>Status</dt><dd>${statusMarkup(status)}</dd><dt>Status reason</dt><dd>${escapeHtml(field(changeSet, "statusReason", "StatusReason") ?? "-")}</dd></dl><dl class="key-value"><dt>Execution status</dt><dd>${statusMarkup(executionStatus)}</dd><dt>Type</dt><dd>${escapeHtml(field(changeSet, "changeSetType", "ChangeSetType") ?? "-")}</dd></dl><dl class="key-value"><dt>Created</dt><dd>${dateMarkup(field(changeSet, "creationTime", "CreationTime"))}</dd><dt>Change set ID</dt><dd class="mono">${escapeHtml(id)}</dd></dl></div></section>${replacementWarning}<section class="card"><div class="card-header"><h2>Changes <span class="muted">(${changes.length})</span></h2></div>${rows ? `<div class="table-wrap"><table class="cloudformation-change-table"><thead><tr><th>Logical ID</th><th>Action</th><th>Resource type</th><th>Replacement</th><th>Policy action</th><th>Scope</th><th>Property details</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("C", "No resource changes", "This change set does not contain material resource changes.")}</section><div class="cloudformation-change-set-metadata">${parametersContent(parameters)}${tagsContent(tags)}</div>`;
}

const emptyTemplate = JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources: {} }, null, 2);

async function openCreateChangeSet(context, defaults = {}) {
  const fixedStackName = String(defaults.stackName ?? "");
  const type = String(defaults.changeSetType ?? (fixedStackName ? "UPDATE" : "CREATE"));
  const templateBody = String(defaults.templateBody ?? emptyTemplate);
  const stackField = fixedStackName
    ? `<input value="${escapeHtml(fixedStackName)}" disabled><input type="hidden" name="stackName" value="${escapeHtml(fixedStackName)}">`
    : '<input name="stackName" required pattern="[A-Za-z][A-Za-z0-9-]*" placeholder="my-stack">';
  const body = `<div class="detail-grid"><div class="field"><label>Stack name</label>${stackField}</div><div class="field"><label>Change set type</label><select name="changeSetType"><option value="CREATE" ${type === "CREATE" ? "selected" : ""}>CREATE</option><option value="UPDATE" ${type === "UPDATE" ? "selected" : ""}>UPDATE</option></select><span class="hint">CREATE targets a new stack; UPDATE targets an existing stable stack.</span></div><div class="field"><label>Change set name</label><input name="changeSetName" required pattern="[A-Za-z][A-Za-z0-9-]*" placeholder="review-update"></div></div><div class="field"><label>Description</label><input name="description" placeholder="Reason for this proposed change"></div><div class="field"><label>Template (JSON)</label><textarea class="code-editor" name="templateBody" required spellcheck="false" style="min-height:300px">${escapeHtml(templateBody)}</textarea><span class="hint">The simulator's bounded CloudFormation profile accepts JSON templates. Creating a change set does not execute it.</span></div><div class="detail-grid"><div class="field"><label>Parameter overrides (JSON object)</label><textarea name="parameters" spellcheck="false">{}</textarea></div><div class="field"><label>Capabilities</label><textarea name="capabilities" placeholder="CAPABILITY_IAM&#10;CAPABILITY_NAMED_IAM">${escapeHtml((defaults.capabilities ?? []).join("\n"))}</textarea></div><div class="field"><label>On create failure</label><select name="onStackFailure"><option value="">Default rollback</option><option value="ROLLBACK">Rollback</option><option value="DELETE">Delete stack</option><option value="DO_NOTHING">Preserve failed resources</option></select><span class="hint">Applies only to CREATE change sets.</span></div></div>`;
  context.showModal("Create change set", body, "Create change set", async data => {
    const stackName = String(data.get("stackName") ?? "");
    const source = String(data.get("templateBody") ?? "");
    JSON.parse(source);
    const changeSetName = String(data.get("changeSetName") ?? "");
    await rest(stackPath(stackName, "/change-sets"), "POST", {
      changeSetName,
      changeSetType: String(data.get("changeSetType") ?? "UPDATE"),
      description: String(data.get("description") ?? ""),
      templateBody: source,
      parameters: parameterOverrides(data.get("parameters")),
      capabilities: capabilityValues(data.get("capabilities")),
      onStackFailure: String(data.get("onStackFailure") ?? ""),
    });
    context.toast("Change set created for review");
    location.hash = `#/cloudformation/stacks/${encodeURIComponent(stackName)}/change-sets/${encodeURIComponent(changeSetName)}`;
  }, true);
}

async function openStackUpdate(context, stack) {
  const current = templateText(await rest(`${stackPath(stack.name, "/template")}?templateStage=Original`));
  const body = `<div class="alert warning"><strong>Direct stack update</strong><br>CloudFormation validates and starts this update immediately. Use a change set when replacement review is required first.</div><div class="field"><label>Template (JSON)</label><textarea class="code-editor" name="templateBody" required spellcheck="false" style="min-height:320px">${escapeHtml(current)}</textarea></div><div class="detail-grid"><div class="field"><label>Parameter overrides (JSON object)</label><textarea name="parameters" spellcheck="false">{}</textarea><span class="hint">Omitted parameters keep their previous values.</span></div><div class="field"><label>Capabilities</label><textarea name="capabilities">${escapeHtml(stack.capabilities.join("\n"))}</textarea></div></div><label class="checkbox-label"><input type="checkbox" name="disableRollback" value="true"> Disable automatic rollback if this update fails</label><label class="checkbox-label"><input type="checkbox" name="retainExceptOnCreate" value="true"> Delete newly created Retain resources if this update rolls back</label>`;
  context.showModal(`Update stack · ${stack.name}`, body, "Update stack", async data => {
    const source = String(data.get("templateBody") ?? "");
    JSON.parse(source);
    await rest(stackPath(stack.name), "PUT", { templateBody: source, parameters: parameterOverrides(data.get("parameters")), capabilities: capabilityValues(data.get("capabilities")), disableRollback: data.get("disableRollback") === "true", retainExceptOnCreate: data.get("retainExceptOnCreate") === "true" });
    context.toast("Stack update started");
  }, true);
}

async function exportsPage(context, exportName) {
  const payload = exportName === undefined
    ? await rest("/_stacksim/api/cloudformation/exports")
    : await rest(`/_stacksim/api/cloudformation/exports/${encodeURIComponent(exportName)}`);
  if (exportName !== undefined) {
    const item = field(payload, "export", "Export") ?? payload;
    const name = String(field(item, "name", "Name") ?? exportName);
    const exportingStack = String(field(item, "exportingStackName", "ExportingStackName") ?? "");
    const imports = array(item, "imports", "Imports");
    context.setChrome("cloudformation", [{ label: "CloudFormation", href: "#/cloudformation/stacks" }, { label: "Exports", href: "#/cloudformation/exports" }, name]);
    context.main.innerHTML = `<div class="page-width cloudformation-export-detail">${pageHeader(name, "CloudFormation cross-stack export and its active import relationships.", '<a class="button" href="#/cloudformation/exports">All exports</a>')}<section class="card"><div class="card-header"><h2>Export details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Name</dt><dd class="mono">${escapeHtml(name)}</dd><dt>Value</dt><dd class="mono">${escapeHtml(field(item, "value", "Value") ?? "")}</dd></dl><dl class="key-value"><dt>Exporting stack</dt><dd>${exportingStack ? `<a href="#/cloudformation/stacks/${encodeURIComponent(exportingStack)}/outputs">${escapeHtml(exportingStack)}</a>` : "-"}</dd><dt>Stack ID</dt><dd class="mono">${escapeHtml(field(item, "exportingStackId", "ExportingStackId") ?? "-")}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Importing stacks <span class="muted">(${imports.length})</span></h2></div>${imports.length ? `<div class="table-wrap"><table class="cloudformation-import-table"><thead><tr><th>Stack</th><th>Relationship</th></tr></thead><tbody>${imports.map(stackName => `<tr><td><a href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/overview">${escapeHtml(stackName)}</a></td><td>Imports <span class="mono">${escapeHtml(name)}</span></td></tr>`).join("")}</tbody></table></div>` : emptyState("I", "No active importers", "This export is not currently referenced by another stack.")}</section></div>`;
    return;
  }
  const exports = normalizeCollection(payload, "exports", "Exports");
  const rows = exports.map(item => {
    const name = String(field(item, "name", "Name") ?? "");
    const exportingStack = String(field(item, "exportingStackName", "ExportingStackName") ?? "");
    const imports = array(item, "imports", "Imports");
    return `<tr data-search-row="${escapeHtml(`${name} ${exportingStack} ${imports.join(" ")}`.toLowerCase())}"><td><a class="mono" href="${exportHref(name)}">${escapeHtml(name)}</a></td><td class="mono">${escapeHtml(field(item, "value", "Value") ?? "")}</td><td>${exportingStack ? `<a href="#/cloudformation/stacks/${encodeURIComponent(exportingStack)}/outputs">${escapeHtml(exportingStack)}</a>` : "-"}</td><td>${imports.length ? imports.map(stackName => `<a href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/overview">${escapeHtml(stackName)}</a>`).join(", ") : "None"}</td></tr>`;
  }).join("");
  context.setChrome("cloudformation", ["CloudFormation", "Exports"]);
  context.main.innerHTML = `<div class="page-width cloudformation-exports">${pageHeader("Exports", "Values shared between stacks in the selected local account and Region.")}<section class="card"><div class="card-header"><div><h2>Exports <span class="muted">(${exports.length})</span></h2><p class="muted small">Exporting stacks cannot be deleted or change an exported value while an active importer exists.</p></div></div>${rows ? `<div class="toolbar"><label class="filter"><span aria-hidden="true">&#8981;</span><input data-filter-table placeholder="Find exports"></label></div><div class="table-wrap"><table class="cloudformation-export-table"><thead><tr><th>Name</th><th>Value</th><th>Exporting stack</th><th>Importing stacks</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("E", "No exports", "Add an Output with Export.Name to share a value with another stack.")}</section></div>`;
  context.bindTableFilter(context.main);
}

export async function stacksPage(context) {
  const payload = await rest(apiRoot);
  const stacks = normalizeCollection(payload, "stacks", "StackSummaries", "Stacks").map(normalizeStack);
  context.setChrome("cloudformation", ["CloudFormation", "Stacks"]);
  const rows = stacks.map(stack => `<tr data-search-row="${escapeHtml(`${stack.name} ${stack.status} ${stack.parentId ? "nested" : "root"}`.toLowerCase())}"><td><a href="#/cloudformation/stacks/${encodeURIComponent(stack.name)}/overview">${escapeHtml(stack.name)}</a></td><td>${stack.parentId ? '<span class="status">NESTED</span>' : '<span class="status">ROOT</span>'}</td><td>${statusMarkup(stack.status)}</td><td class="no-wrap">${dateMarkup(stack.createdAt)}</td><td class="no-wrap">${dateMarkup(stack.updatedAt)}</td><td>${stack.terminationProtection ? "Enabled" : "Disabled"}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width cloudformation-page">${pageHeader("Stacks", "Inspect infrastructure deployed to this local simulator environment with the CDK or CloudFormation API.", '<div class="actions"><button class="button" data-action="create-change-set">Create change set</button><button class="button refresh" data-action="refresh" aria-label="Refresh stacks">&#8635;</button></div>')}<div class="alert info"><strong>Use standard tools or reviewed local operations</strong><br>CDK and the CLI remain the primary deployment workflow. The console can submit bounded JSON updates and CREATE/UPDATE change sets through the same durable engine.</div><section class="card"><div class="card-header"><div><h2>Stacks <span class="muted">(${stacks.length})</span></h2><p class="muted small">Root and nested stacks in the selected account and Region.</p></div></div>${rows ? `<div class="toolbar"><label class="filter"><span aria-hidden="true">&#8981;</span><input data-filter-table placeholder="Find stacks"></label></div><div class="table-wrap"><table class="cloudformation-stack-table"><thead><tr><th>Stack name</th><th>Role</th><th>Status</th><th>Created</th><th>Last updated</th><th>Termination protection</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("C", "No stacks", "Deploy a CDK or create a reviewed CREATE change set to begin.")}</section></div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route(false));
  context.main.querySelector('[data-action="create-change-set"]')?.addEventListener("click", () => openCreateChangeSet(context));
  context.bindTableFilter(context.main);
}

async function setupPage(context) {
  const [summary, environment] = await Promise.all([rest("/_stacksim/api/summary"), rest("/_stacksim/api/environment")]);
  const endpoint = String(summary.endpoint ?? location.origin);
  const region = String(summary.region ?? environment.region ?? "eu-west-1");
  const bootstrap = environment.bootstrap;
  const bootstrapStatus = environment.cdkBootstrap ?? { status: bootstrap ? "ready" : "disabled", collisions: [] };
  const roleLabels = { deploy: "Deployment", filePublishing: "File publishing", imagePublishing: "Image publishing", lookup: "Lookup", cloudFormationExecution: "CloudFormation execution" };
  const bootstrapRoles = array(bootstrap, "roles");
  const roleRows = bootstrapRoles.map(role => {
    const name = String(role.roleName ?? role.arn ?? role.key ?? "Unknown role");
    const available = role.status === "available";
    const roleValue = available ? `<a class="mono" href="#/iam/roles/${encodeURIComponent(name)}">${escapeHtml(name)}</a>` : `<span class="mono">${escapeHtml(name)}</span>`;
    return `<tr><td>${escapeHtml(roleLabels[role.key] ?? role.key ?? "Role")}</td><td><span class="status ${available ? "" : "error"}">${available ? "Available" : "Missing"}</span></td><td>${roleValue}</td></tr>`;
  }).join("");
  const assetCount = Number(bootstrap?.fileAssets?.count ?? 0);
  const assetBytes = Number(bootstrap?.fileAssets?.totalBytes ?? 0);
  const posix = `export AWS_ENDPOINT_URL="${endpoint}"\nexport AWS_ACCESS_KEY_ID="<your-local-access-key>"\nexport AWS_SECRET_ACCESS_KEY="<your-local-secret-key>"\nexport AWS_REGION="${region}"\nexport AWS_DEFAULT_REGION="${region}"\nexport AWS_EC2_METADATA_DISABLED="true"\nnpx cdk deploy`;
  const powershell = `$env:AWS_ENDPOINT_URL="${endpoint}"\n$env:AWS_ACCESS_KEY_ID="<your-local-access-key>"\n$env:AWS_SECRET_ACCESS_KEY="<your-local-secret-key>"\n$env:AWS_REGION="${region}"\n$env:AWS_DEFAULT_REGION="${region}"\n$env:AWS_EC2_METADATA_DISABLED="true"\nnpx cdk deploy`;
  context.setChrome("cloudformation", ["CloudFormation", "Local CDK setup"]);
  const collisionRows = array(bootstrapStatus, "collisions").map(collision => `<li><span class="mono">${escapeHtml(collision.type)}</span> ${escapeHtml(collision.name)} <span class="mono">${escapeHtml(collision.arn)}</span></li>`).join("");
  const bootstrapDetails = bootstrap ? `<div class="card-body cloudformation-identifiers detail-grid"><dl class="key-value"><dt>Owner</dt><dd>${escapeHtml(bootstrap.owner)}</dd><dt>Compatibility version</dt><dd>${escapeHtml(bootstrap.compatibilityVersion)}</dd><dt>Qualifier</dt><dd class="mono">${escapeHtml(bootstrap.qualifier)}</dd></dl><dl class="key-value"><dt>SSM version parameter</dt><dd class="mono">${escapeHtml(bootstrap.versionParameterName)}</dd><dt>SSM parameter value</dt><dd class="mono">${escapeHtml(bootstrap.versionParameterValue)}</dd><dt>Bootstrap status</dt><dd><span class="status ${bootstrap.status === "ready" ? "" : "error"}">${bootstrap.status === "ready" ? "Ready" : "Degraded"}</span></dd></dl><dl class="key-value"><dt>File asset bucket</dt><dd><a class="mono" href="#/s3/buckets/${encodeURIComponent(bootstrap.bucketName)}/objects">${escapeHtml(bootstrap.bucketName)}</a></dd><dt>File asset count</dt><dd>${assetCount.toLocaleString()}</dd><dt>Stored asset size</dt><dd>${escapeHtml(humanBytes(assetBytes))}</dd></dl></div>` : bootstrapStatus.status === "blocked" ? `<div class="alert error"><strong>Automatic bootstrap is blocked</strong><br>A deterministic bootstrap name is already owned by another resource. stacksim did not adopt or overwrite it.${collisionRows ? `<ul>${collisionRows}</ul>` : ""}</div>` : '<div class="alert warning"><strong>Automatic bootstrap is disabled</strong><br>Restart without <span class="mono">STACKSIM_CDK_BOOTSTRAP=false</span> to create the reduced bootstrap, or keep it disabled for an intentional unbootstrapped/custom-bootstrap test.</div>';
  const roles = bootstrap ? `<section class="card"><div class="card-header"><div><h2>Bootstrap roles <span class="muted">(${bootstrapRoles.length})</span></h2><p class="muted small">Distinct local roles used by lookup, publishing, deployment, and CloudFormation execution.</p></div></div><div class="table-wrap"><table class="cloudformation-bootstrap-role-table"><thead><tr><th>Purpose</th><th>Status</th><th>Role</th></tr></thead><tbody>${roleRows}</tbody></table></div><div class="alert info"><strong>Image assets are unavailable</strong><br>The image publishing role is present, but ECR publication remains dependency-blocked.</div></section>` : "";
  context.main.innerHTML = `<div class="page-width cloudformation-setup">${pageHeader("Local CDK setup", "Configure the standard CDK and SDKs to use this simulator.")}<div class="alert info"><strong>One endpoint for standard tools</strong><br>The global service endpoint setting directs CloudFormation and the service clients created by CDK to this local control plane. Keep deployed application invoke URLs separate.</div><section class="card"><div class="card-header"><h2>Environment</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Control endpoint</dt><dd class="mono">${escapeHtml(endpoint)}</dd><dt>Region</dt><dd>${escapeHtml(region)}</dd><dt>Account</dt><dd class="mono">${escapeHtml(summary.accountId ?? environment.accountId ?? "000000000000")}</dd></dl><dl class="key-value"><dt>Authentication mode</dt><dd>${escapeHtml(environment.authMode ?? "enforce")}</dd><dt>Reduced bootstrap</dt><dd>${bootstrap ? `Ready (version ${escapeHtml(bootstrap.compatibilityVersion)})` : bootstrapStatus.status === "blocked" ? "Blocked" : "Disabled"}</dd></dl></div>${bootstrapDetails}</section>${roles}<section class="card"><div class="card-header"><div><h2>PowerShell</h2><p class="muted small">Run in the terminal where you invoke CDK.</p></div><button class="button" type="button" data-copy="${escapeHtml(powershell)}">Copy</button></div><pre class="code-box cloudformation-setup-code">${escapeHtml(powershell)}</pre></section><section class="card"><div class="card-header"><div><h2>macOS or Linux shell</h2><p class="muted small">Run in the terminal where you invoke CDK.</p></div><button class="button" type="button" data-copy="${escapeHtml(posix)}">Copy</button></div><pre class="code-box cloudformation-setup-code">${escapeHtml(posix)}</pre></section><div class="alert info"><strong>Automatic reduced bootstrap</strong><br>stacksim creates its reduced file-asset bootstrap in the configured Region by default. Do not run the full <span class="mono">cdk bootstrap</span> template. Ordinary CDK work uses IAM user policies; recovery root is unrelated and is only for lockout repair. After access-key rotation, replace the example pair with your saved client-side credentials.</div></div>`;
}

async function stackPage(name, active, context, changeSetName) {
  const detailPayload = await rest(stackPath(name));
  const stack = normalizeStack(field(detailPayload, "stack", "Stack") ?? detailPayload);
  const canonicalName = stack.name || name;
  let content;
  if (active === "events") content = eventsContent(await rest(stackPath(name, "/events")));
  else if (active === "resources") content = resourcesContent(await rest(stackPath(name, "/resources")));
  else if (active === "outputs") content = outputsContent(stack.outputs);
  else if (active === "parameters") content = parametersContent(stack.parameters);
  else if (active === "template") content = templateContent(await rest(`${stackPath(name, "/template")}?templateStage=Original`));
  else if (active === "change-sets" && changeSetName) content = changeSetDetailContent(await rest(changeSetPath(name, changeSetName)), canonicalName);
  else if (active === "change-sets") content = changeSetsContent(await rest(stackPath(name, "/change-sets")), canonicalName);
  else if (active === "tags") content = tagsContent(stack.tags);
  else content = overviewContent(stack, normalizeCollection(detailPayload, "hierarchy", "Hierarchy").map(normalizeStack));

  const breadcrumbs = detailBreadcrumbs(canonicalName, active);
  context.setChrome("cloudformation", changeSetName ? [...breadcrumbs, changeSetName] : breadcrumbs);
  const protectionLabel = stack.terminationProtection ? "Disable termination protection" : "Enable termination protection";
  const deleted = stack.status === "DELETE_COMPLETE";
  const deleting = stack.status === "DELETE_IN_PROGRESS";
  const mutating = stack.status.endsWith("_IN_PROGRESS");
  const canDelete = !stack.terminationProtection && !deleted && !mutating;
  const canUpdate = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.status);
  const deleteFailed = stack.status === "DELETE_FAILED";
  const lifecycleActions = `<button class="button" data-action="refresh">Refresh</button>${canUpdate ? '<button class="button primary" data-action="update-stack">Update</button>' : ""}<button class="button" data-action="toggle-termination" ${deleted || deleting || stack.parentId ? "disabled" : ""}>${protectionLabel}</button>${stack.status === "CREATE_FAILED" || stack.status === "UPDATE_FAILED" ? '<button class="button" data-action="rollback-stack">Roll back</button>' : ""}${stack.status === "UPDATE_ROLLBACK_FAILED" ? '<button class="button" data-action="continue-update-rollback">Continue update rollback</button>' : ""}<button class="button danger" data-action="delete-stack" ${canDelete ? "" : "disabled"}>${deleteFailed ? "Retry delete" : "Delete"}</button>`;
  context.main.innerHTML = `<div class="page-width cloudformation-detail">${pageHeader(canonicalName, "CloudFormation stack in the selected local account and Region.", lifecycleActions)}${stack.terminationProtection ? '<div class="alert info"><strong>Termination protection is enabled</strong><br>Disable termination protection before deleting this stack.</div>' : ""}${stack.statusReason ? `<div class="alert ${stack.status.includes("FAILED") || stack.status.includes("ROLLBACK") ? "error" : "info"}"><strong>${escapeHtml(stack.status)}</strong><br>${escapeHtml(stack.statusReason)}</div>` : ""}${stackTabs(canonicalName, active)}${content}</div>`;
  const bindTemplateStage = () => {
    const selector = context.main.querySelector("[data-template-stage]");
    selector?.addEventListener("change", async () => {
      selector.disabled = true;
      try {
        const templateStage = selector.value;
        const payload = await rest(`${stackPath(canonicalName, "/template")}?templateStage=${encodeURIComponent(templateStage)}`);
        const panel = selector.closest("[data-template-panel]");
        if (panel) panel.outerHTML = templateContent(payload);
        decorateCloudFormationPanelHelp(context.main);
        bindTemplateStage();
      } catch (error) {
        selector.disabled = false;
        context.showError(error);
      }
    });
  };
  bindTemplateStage();
  const bindOperationFilter = () => {
    const selector = context.main.querySelector("[data-operation-filter]");
    selector?.addEventListener("change", async () => {
      selector.disabled = true;
      try {
        const operationId = selector.value;
        const payload = await rest(`${stackPath(canonicalName, "/events")}${operationId ? `?operationId=${encodeURIComponent(operationId)}` : ""}`);
        const panel = selector.closest("[data-events-panel]");
        if (panel) panel.outerHTML = eventsContent(payload);
        decorateCloudFormationPanelHelp(context.main);
        bindOperationFilter();
      } catch (error) {
        selector.disabled = false;
        context.showError(error);
      }
    });
  };
  bindOperationFilter();
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route(false));
  context.main.querySelector('[data-action="update-stack"]')?.addEventListener("click", async () => {
    try { await openStackUpdate(context, stack); } catch (error) { context.showError(error); }
  });
  context.main.querySelector('[data-action="toggle-termination"]')?.addEventListener("click", () => {
    const enabled = !stack.terminationProtection;
    context.showModal(protectionLabel, `<p>${enabled ? "Enable" : "Disable"} termination protection for <strong>${escapeHtml(canonicalName)}</strong>?</p><div class="alert info">${enabled ? "Protected stacks cannot be deleted until protection is disabled." : "After protection is disabled, this stack can be deleted through the console, CLI, SDK, or CDK."}</div>`, enabled ? "Enable" : "Disable", async () => {
      await rest(stackPath(canonicalName, "/termination-protection"), "PUT", { enabled });
      context.toast(`Termination protection ${enabled ? "enabled" : "disabled"}`);
    });
  });
  context.main.querySelector('[data-action="rollback-stack"]')?.addEventListener("click", () => context.showModal("Roll back stack", `<div class="alert warning"><strong>This is a destructive recovery operation</strong><br>CloudFormation reverts the failed create or update according to its deletion and replacement policies.</div>${typedConfirmation(canonicalName, "rollback")}`, "Roll back", async data => {
    if (data.get("confirmation") !== canonicalName) throw new Error(`Enter ${canonicalName} to confirm`);
    await rest(stackPath(canonicalName, "/rollback"), "POST", {});
    context.toast("Stack rollback started");
  }, false, { danger: true }));
  context.main.querySelector('[data-action="continue-update-rollback"]')?.addEventListener("click", () => context.showModal("Continue update rollback", `<div class="alert warning"><strong>Skipped resources may no longer match the template</strong><br>Skip resources only when they cannot be rolled back, then reconcile them before the next update.</div><div class="field"><label>Resources to skip <span class="muted small">&ndash; optional</span></label><textarea name="resources" placeholder="LogicalResourceIdOne&#10;LogicalResourceIdTwo"></textarea><span class="hint">Enter logical IDs separated by commas, spaces, or new lines.</span></div>${typedConfirmation(canonicalName, "continuing rollback")}`, "Continue rollback", async data => {
    if (data.get("confirmation") !== canonicalName) throw new Error(`Enter ${canonicalName} to confirm`);
    const resourcesToSkip = String(data.get("resources") ?? "").split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
    await rest(stackPath(canonicalName, "/continue-update-rollback"), "POST", { resourcesToSkip });
    context.toast("Update rollback continued");
  }, false, { danger: true }));
  context.main.querySelector('[data-action="delete-stack"]')?.addEventListener("click", async () => {
    if (!deleteFailed) {
      context.confirmDeletion(canonicalName, `Delete stack ${canonicalName}? CloudFormation will delete the resources owned by this stack according to its retention policies.`, async () => {
        await rest(stackPath(canonicalName), "DELETE", {});
        context.toast("Stack deletion started");
        location.hash = "#/cloudformation/stacks";
      });
      return;
    }
    try {
      const payload = await rest(stackPath(canonicalName, "/resources"));
      const resources = normalizeCollection(payload, "resources", "StackResources", "StackResourceSummaries").filter(resource => field(resource, "resourceStatus", "ResourceStatus") !== "DELETE_COMPLETE");
      const retainChoices = resources.length ? `<div class="field"><label>Resources to retain</label><div class="region-list">${resources.map(resource => { const logicalId = field(resource, "logicalResourceId", "LogicalResourceId") ?? ""; return `<label><input type="checkbox" name="retainResource" value="${escapeHtml(logicalId)}"><span><strong class="mono">${escapeHtml(logicalId)}</strong>${escapeHtml(field(resource, "resourceType", "ResourceType") ?? "")}</span></label>`; }).join("")}</div><span class="hint">Selected resources are marked DELETE_SKIPPED and remain in the backing service.</span></div>` : "";
      const body = `<div class="alert warning"><strong>Retry a failed stack deletion</strong><br>Standard mode retries provider deletion. Force mode is available only for DELETE_FAILED and retains a resource if its provider deletion still fails.</div><div class="field"><label>Deletion mode</label><select name="deletionMode"><option value="STANDARD">Standard retry</option><option value="FORCE_DELETE_STACK">Force delete stack</option></select></div>${retainChoices}${typedConfirmation(canonicalName, "retrying deletion")}`;
      context.showModal("Retry stack deletion", body, "Retry delete", async data => {
        if (data.get("confirmation") !== canonicalName) throw new Error(`Enter ${canonicalName} to confirm`);
        await rest(stackPath(canonicalName), "DELETE", { deletionMode: String(data.get("deletionMode") ?? "STANDARD"), retainResources: data.getAll("retainResource").map(String) });
        context.toast("Stack deletion retry started");
        location.hash = "#/cloudformation/stacks";
      }, false, { danger: true });
    } catch (error) { context.showError(error); }
  });
  context.main.querySelector('[data-action="create-change-set"]')?.addEventListener("click", async () => {
    try {
      const payload = await rest(`${stackPath(canonicalName, "/template")}?templateStage=Original`);
      await openCreateChangeSet(context, { stackName: canonicalName, changeSetType: "UPDATE", templateBody: templateText(payload), capabilities: stack.capabilities });
    } catch (error) { context.showError(error); }
  });
  context.main.querySelector('[data-action="execute-change-set"]')?.addEventListener("click", () => {
    const detail = context.main.querySelector(".cloudformation-change-set-detail");
    const replacementCount = Number(detail?.dataset.replacementCount ?? 0);
    const replacementResources = detail?.dataset.replacementResources ?? "";
    const replacementWarning = replacementCount ? `<div class="alert warning"><strong>${replacementCount} replacement${replacementCount === 1 ? "" : "s"} will be evaluated during execution</strong><br>${escapeHtml(replacementResources)}. Physical identities may change and replacement policies control cleanup of the old resources.</div>` : "";
    context.showModal("Execute change set", `${replacementWarning}<div class="alert warning"><strong>This starts a stack operation</strong><br>CloudFormation will apply the reviewed changes and normal rollback behavior.</div><p>Execute <strong>${escapeHtml(changeSetName)}</strong> on <strong>${escapeHtml(canonicalName)}</strong>?</p>`, "Execute", async () => {
    await rest(changeSetPath(canonicalName, changeSetName, "/execute"), "POST", {});
    context.toast("Change set execution started");
    });
  });
  context.main.querySelector('[data-action="delete-change-set"]')?.addEventListener("click", () => context.confirmDeletion(changeSetName, `Delete change set ${changeSetName}? This does not alter the stack or its resources.`, async () => {
    await rest(changeSetPath(canonicalName, changeSetName), "DELETE");
    context.toast("Change set deleted");
    location.hash = `#/cloudformation/stacks/${encodeURIComponent(canonicalName)}/change-sets`;
  }));
  context.bindTableFilter(context.main);
}

export async function routeCloudFormation(parts, context) {
  if (parts[0] !== metadata.key) return false;
  const render = async pending => { const result = await pending; decorateCloudFormationPanelHelp(context.main); return result; };
  if (parts.length === 1 || (parts[1] === "stacks" && parts.length === 2)) return render(stacksPage(context));
  if (parts[1] === "exports" && parts.length <= 3) return render(exportsPage(context, parts[2]));
  if (parts[1] === "setup" && parts.length === 2) return render(setupPage(context));
  if (parts[1] !== "stacks" || !parts[2]) return context.notFound(parts);
  const active = parts.length === 3 ? "overview" : parts[3];
  const changeSetName = active === "change-sets" && parts.length === 5 ? parts[4] : undefined;
  if (parts.length > 5 || (parts.length === 5 && !changeSetName) || !["overview", "events", "resources", "outputs", "parameters", "template", "change-sets", "tags"].includes(active)) return context.notFound(parts);
  return render(stackPage(parts[2], active, context, changeSetName));
}
