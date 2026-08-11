import { rest } from "./api-client.js";
import { arnComboboxField, enhanceArnComboboxes } from "./arn-combobox.js";
import { associateFormLabels, escapeHtml } from "./components.js";
import { session as ui } from "./state.js";

const basicLambdaPolicy = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

export const guidedRoleTemplateVersion = 1;
export const guidedRoleTemplates = Object.freeze({
  lambda: { version: guidedRoleTemplateVersion, id: "lambda", name: "Lambda execution role", principal: "lambda.amazonaws.com", description: "Lets a Lambda function write logs and use selected application resources." },
  scheduler: { version: guidedRoleTemplateVersion, id: "scheduler", name: "EventBridge Scheduler execution role", principal: "scheduler.amazonaws.com", description: "Lets Scheduler invoke a Lambda function, send to SQS, start a state machine, or put events on a bus." },
  states: { version: guidedRoleTemplateVersion, id: "states", name: "Step Functions execution role", principal: "states.amazonaws.com", description: "Lets a state machine invoke the selected task resources." },
  appsync: { version: guidedRoleTemplateVersion, id: "appsync", name: "AppSync service role", principal: "appsync.amazonaws.com", description: "Lets an AppSync data source access the selected DynamoDB table." },
  apigateway: { version: guidedRoleTemplateVersion, id: "apigateway", name: "API Gateway CloudWatch Logs role", principal: "apigateway.amazonaws.com", description: "Lets API Gateway create log groups and deliver execution logs." },
  events: { version: guidedRoleTemplateVersion, id: "events", name: "EventBridge rule target role", principal: "events.amazonaws.com", description: "Lets an EventBridge rule invoke the selected supported target." },
  custom: { version: guidedRoleTemplateVersion, id: "custom", name: "Custom guided service role", principal: "", description: "Choose a supported service, action, and resource without editing policy JSON." },
});

const targetTypes = {
  lambda: { label: "Lambda function", kind: "lambda-function", action: "lambda:InvokeFunction", verb: "Invoke" },
  sqs: { label: "SQS queue", kind: "sqs-queue", action: "sqs:SendMessage", verb: "Send messages to" },
  states: { label: "Step Functions state machine", kind: "states-machine", action: "states:StartExecution", verb: "Start executions of" },
  events: { label: "EventBridge event bus", kind: "eventbridge-bus", action: "events:PutEvents", verb: "Put events on" },
};

const lambdaCapabilities = {
  s3: { label: "Read from an S3 bucket", kind: "s3-bucket", actions: ["s3:GetObject", "s3:ListBucket"] },
  sqs: { label: "Consume an SQS queue", kind: "sqs-queue", actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"] },
  dynamodb: { label: "Access a DynamoDB table", kind: "dynamodb-table", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"] },
  sns: { label: "Publish to an SNS topic", kind: "sns-topic", actions: ["sns:Publish"] },
  lambda: { label: "Invoke another Lambda function", kind: "lambda-function", actions: ["lambda:InvokeFunction"] },
};

function trustPolicy(principal) {
  return { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: principal }, Action: "sts:AssumeRole" }] };
}

function resourceName(arn = "") {
  return arn.split(":function:")[1]?.split(":")[0]
    ?? arn.split(":stateMachine:")[1]
    ?? (arn.includes("/") ? arn.split("/").at(-1) : undefined)
    ?? (arn.includes(":") ? arn.split(":").at(-1) : undefined)
    ?? arn
    ?? "resource";
}

function slug(value) {
  return String(value || "service").toLowerCase().replace(/[^a-z0-9+=,.@_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "service";
}

function roleNameSuggestion(template, arn) {
  const base = slug(resourceName(arn));
  return template.id === "scheduler" ? `${base}-schedule-role`
    : template.id === "lambda" ? `${base}-execution-role`
      : template.id === "states" ? `${base}-workflow-role`
        : template.id === "appsync" ? `${base}-appsync-role`
          : template.id === "apigateway" ? "apigateway-cloudwatch-logs-role"
            : template.id === "events" ? `${base}-eventbridge-role` : `${base}-service-role`;
}

function templateCards() {
  return `<fieldset class="guided-role-options"><legend>What will use this role?</legend>${Object.values(guidedRoleTemplates).map((template, index) => `<label class="guided-role-option"><input type="radio" name="useCase" value="${template.id}" ${index === 0 ? "checked" : ""}><span><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.description)}</small></span></label>`).join("")}</fieldset>`;
}

function targetPermissionMarkup(template, selected = "lambda") {
  const supported = template.id === "events" ? ["lambda", "sqs", "states"] : Object.keys(targetTypes);
  const type = supported.includes(selected) ? selected : supported[0]; const target = targetTypes[type];
  return `<div class="field"><label>Target kind</label><select name="targetType">${supported.map(key => `<option value="${key}" ${key === type ? "selected" : ""}>${escapeHtml(targetTypes[key].label)}</option>`).join("")}</select></div><div data-guided-target-picker>${arnComboboxField("Target resource ARN", { name: "targetArn", required: true, kinds: [target.kind], localExistence: "preferred", accountScope: "same", regionScope: "same" }, "Select an existing local resource or type or paste an accepted ARN.")}</div>`;
}

function lambdaPermissionMarkup() {
  return `<div class="alert info"><strong>Basic CloudWatch Logs included</strong><br>The AWSLambdaBasicExecutionRole managed policy will be attached by default.</div><fieldset class="guided-capabilities"><legend>Optional application permissions</legend>${Object.entries(lambdaCapabilities).map(([id, capability]) => `<label><input type="checkbox" name="lambdaCapability" value="${id}"> ${escapeHtml(capability.label)}</label>`).join("")}</fieldset><div data-lambda-capability-fields>${Object.entries(lambdaCapabilities).map(([id, capability]) => `<div class="guided-capability-resource" data-capability="${id}" hidden><h4>${escapeHtml(capability.label)}</h4><div data-capability-rows>${arnComboboxField("Resource ARN", { name: "capabilityArn", required: true, kinds: [capability.kind], localExistence: "preferred" })}</div><button class="button" type="button" data-add-capability-resource="${id}">Add another resource</button></div>`).join("")}</div>`;
}

function taskRowMarkup() {
  return `<div class="guided-task-row"><div class="field"><label>Task kind</label><select name="taskType">${Object.entries(targetTypes).map(([key, target]) => `<option value="${key}">${escapeHtml(target.label)}</option>`).join("")}</select></div><div data-guided-task-picker>${arnComboboxField("Task resource ARN", { name: "taskArn", required: true, kinds: ["lambda-function"], localExistence: "preferred", accountScope: "same", regionScope: "same" })}</div><button class="button link danger" type="button" data-remove-task hidden>Remove task</button></div>`;
}

function statesPermissionMarkup() {
  return `<div data-guided-task-rows>${taskRowMarkup()}</div><button class="button" type="button" data-add-guided-task>Add another task</button>`;
}

function appsyncPermissionMarkup() {
  return `${arnComboboxField("DynamoDB table ARN", { name: "tableArn", required: true, kinds: ["dynamodb-table"], localExistence: "preferred", accountScope: "same", regionScope: "same" }, "The table must be in the current account and Region.")}<fieldset class="guided-capabilities"><legend>Table actions</legend>${[["read", "Read items"], ["write", "Write items"], ["delete", "Delete items"]].map(([value, label], index) => `<label><input type="checkbox" name="tableAction" value="${value}" ${index === 0 ? "checked" : ""}> ${label}</label>`).join("")}</fieldset>`;
}

function customPermissionMarkup() {
  return `<div class="field-row"><div class="field"><label>Trusted service</label><select name="customService">${[["lambda.amazonaws.com", "Lambda"], ["scheduler.amazonaws.com", "EventBridge Scheduler"], ["states.amazonaws.com", "Step Functions"], ["appsync.amazonaws.com", "AppSync"], ["apigateway.amazonaws.com", "API Gateway"], ["events.amazonaws.com", "EventBridge"]].map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></div><div class="field"><label>Permission</label><select name="customPermission">${Object.entries(targetTypes).map(([value, target]) => `<option value="${value}">${escapeHtml(target.action)}</option>`).join("")}</select></div></div><div data-guided-custom-picker>${arnComboboxField("Resource ARN", { name: "customArn", required: true, kinds: ["lambda-function"], localExistence: "preferred" })}</div>`;
}

function permissionMarkup(template) {
  if (template.id === "lambda") return lambdaPermissionMarkup();
  if (template.id === "states") return statesPermissionMarkup();
  if (template.id === "scheduler" || template.id === "events") return targetPermissionMarkup(template);
  if (template.id === "appsync") return appsyncPermissionMarkup();
  if (template.id === "apigateway") return '<div class="alert info"><strong>No resource selection required</strong><br>API Gateway CloudWatch Logs delivery actions cannot be scoped to one log group. The review step explains the required wildcard resource.</div>';
  return customPermissionMarkup();
}

function baseMarkup() {
  return `<div class="wizard-steps guided-role-progress" aria-label="Service role creation progress"><span class="active" data-guided-marker="1">1 Use case</span><span data-guided-marker="2">2 Permissions</span><span data-guided-marker="3">3 Role details</span><span data-guided-marker="4">4 Review</span></div><section data-guided-step="1">${templateCards()}</section><section data-guided-step="2" hidden><h3>Choose permissions and resources</h3><p class="muted">Who assumes the role and what the role may do are kept as separate policies.</p><div data-guided-permissions></div></section><section data-guided-step="3" hidden><h3>Role details</h3><div class="field"><label>Role name</label><input name="name" required pattern="[A-Za-z0-9_+=,.@-]+" maxlength="64"></div><div class="field"><label>Description (optional)</label><input name="description" maxlength="1000"></div><div class="field"><label>Tags (JSON object, optional)</label><textarea name="tags">{}</textarea></div><div class="field-error" data-guided-name-error hidden></div></section><section data-guided-step="4" hidden><div data-guided-review></div></section>`;
}

function addWizardFooter(root) {
  const footer = root.querySelector(".modal-footer");
  const submit = footer.querySelector("#modal-submit");
  footer.classList.add("guided-role-footer");
  footer.querySelector("[data-modal-close]").insertAdjacentHTML("afterend", '<span class="guided-role-footer-spacer" aria-hidden="true"></span><button type="button" class="button" data-guided-back hidden>Back</button><button type="button" class="button primary" data-guided-next>Next</button>');
  submit.hidden = true;
}

function selectedTemplate(root) { return guidedRoleTemplates[root.querySelector('[name="useCase"]:checked')?.value] ?? guidedRoleTemplates.lambda; }
function values(root, name) { return [...root.querySelectorAll(`[name="${name}"]:checked`)].map(input => input.value); }

function generated(root) {
  const template = selectedTemplate(root);
  let principal = template.principal;
  let statements = [];
  let managedPolicies = [];
  let summary = [];
  let firstArn = "";
  if (template.id === "lambda") {
    managedPolicies = [basicLambdaPolicy]; summary.push("Write function logs to CloudWatch Logs.");
    for (const id of values(root, "lambdaCapability")) {
      const capability = lambdaCapabilities[id]; const arns = [...root.querySelectorAll(`[data-capability="${id}"] input[name="capabilityArn"]`)].map(input => input.value.trim()).filter(Boolean);
      if (!arns.length) throw new Error(`Choose a resource for ${capability.label.toLowerCase()}.`);
      if (new Set(arns).size !== arns.length) throw new Error(`Remove the duplicate resource for ${capability.label.toLowerCase()}.`);
      firstArn ||= arns[0];
      if (id === "s3") {
        statements.push({ Effect: "Allow", Action: "s3:ListBucket", Resource: arns.length === 1 ? arns[0] : arns });
        const objects = arns.map(arn => `${arn.replace(/\/$/, "")}/*`); statements.push({ Effect: "Allow", Action: "s3:GetObject", Resource: objects.length === 1 ? objects[0] : objects });
      } else statements.push({ Effect: "Allow", Action: capability.actions, Resource: arns.length === 1 ? arns[0] : arns });
      summary.push(`${capability.label}: ${arns.map(resourceName).join(", ")}.`);
    }
  } else if (["scheduler", "events"].includes(template.id)) {
    const target = targetTypes[root.querySelector('[name="targetType"]').value]; const arn = root.querySelector('[name="targetArn"]').value.trim();
    if (!arn) throw new Error("Choose or enter a target resource ARN."); firstArn = arn;
    statements.push({ Effect: "Allow", Action: target.action, Resource: arn }); summary.push(`${target.verb} ${resourceName(arn)}.`);
  } else if (template.id === "states") {
    const grouped = new Map(); const seen = new Set();
    for (const row of root.querySelectorAll(".guided-task-row")) {
      const target = targetTypes[row.querySelector('[name="taskType"]').value]; const arn = row.querySelector('[name="taskArn"]').value.trim();
      if (!arn) throw new Error("Choose or enter every task resource ARN.");
      if (seen.has(arn)) throw new Error("Remove the duplicate task resource ARN."); seen.add(arn); firstArn ||= arn;
      grouped.set(target.action, [...(grouped.get(target.action) ?? []), arn]); summary.push(`${target.verb} ${resourceName(arn)}.`);
    }
    for (const [action, resources] of grouped) statements.push({ Effect: "Allow", Action: action, Resource: resources.length === 1 ? resources[0] : resources });
  } else if (template.id === "appsync") {
    const arn = root.querySelector('[name="tableArn"]').value.trim(); if (!arn) throw new Error("Choose or enter a DynamoDB table ARN."); firstArn = arn;
    const selected = values(root, "tableAction"); if (!selected.length) throw new Error("Choose at least one table action.");
    const actions = [...new Set(selected.flatMap(action => action === "read" ? ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan"] : action === "write" ? ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"] : ["dynamodb:DeleteItem"]))];
    statements.push({ Effect: "Allow", Action: actions, Resource: [arn, `${arn}/index/*`] }); summary.push(`Use selected DynamoDB operations on ${resourceName(arn)}.`);
  } else if (template.id === "apigateway") {
    statements.push({ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:PutLogEvents", "logs:GetLogEvents", "logs:FilterLogEvents"], Resource: "*" });
    summary.push("Create and write API Gateway CloudWatch Logs. These API actions require Resource \"*\".");
  } else {
    principal = root.querySelector('[name="customService"]').value; const target = targetTypes[root.querySelector('[name="customPermission"]').value]; const arn = root.querySelector('[name="customArn"]').value.trim();
    if (!arn) throw new Error("Choose or enter a resource ARN."); firstArn = arn; statements.push({ Effect: "Allow", Action: target.action, Resource: arn }); summary.push(`${target.verb} ${resourceName(arn)}.`);
  }
  return { template, principal, trust: trustPolicy(principal), permissions: { Version: "2012-10-17", Statement: statements }, managedPolicies, summary, firstArn };
}

function reviewMarkup(root) {
  const result = generated(root); const name = root.querySelector('[name="name"]').value.trim();
  const actor = result.template.id === "custom" ? result.principal : ({ lambda: "Lambda", scheduler: "EventBridge Scheduler", states: "Step Functions", appsync: "AppSync", apigateway: "API Gateway", events: "EventBridge" })[result.template.id];
  const wildcardExplanation = result.permissions.Statement.some(statement => statement.Resource === "*")
    ? "The selected CloudWatch Logs control-plane and delivery actions do not support resource-level scoping in this modeled workflow."
    : result.template.id === "lambda" ? "The basic Lambda Logs managed policy uses the wildcard resources required for creating function log groups and streams; every optional application permission remains scoped to the resources above." : "";
  return `<h3>Review and create</h3><div class="guided-review-summary"><h4>Who can use this role</h4><p>${escapeHtml(actor)} can assume this role.</p><h4>What this role can do</h4><ul>${result.summary.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h4>Role name</h4><p class="mono">${escapeHtml(name)}</p></div><details><summary>Generated trust-policy JSON</summary><pre class="code-box">${escapeHtml(JSON.stringify(result.trust, null, 2))}</pre></details><details><summary>Generated permission-policy JSON</summary><pre class="code-box">${escapeHtml(JSON.stringify(result.permissions, null, 2))}</pre></details><details><summary>Managed policies that will be attached</summary>${result.managedPolicies.length ? `<ul>${result.managedPolicies.map(arn => `<li class="mono">${escapeHtml(arn)}</li>`).join("")}</ul>` : '<p class="muted">No managed policies.</p>'}</details>${wildcardExplanation ? `<div class="alert warning"><strong>Wildcard resource required</strong><br>${escapeHtml(wildcardExplanation)}</div>` : ""}`;
}

function showStep(root, step) {
  root.dataset.guidedCurrentStep = String(step);
  root.querySelectorAll("[data-guided-step]").forEach(section => { section.hidden = section.dataset.guidedStep !== String(step); });
  root.querySelectorAll("[data-guided-marker]").forEach(marker => marker.classList.toggle("active", Number(marker.dataset.guidedMarker) <= step));
  const back = root.querySelector("[data-guided-back]");
  const next = root.querySelector("[data-guided-next]");
  back.hidden = step === 1;
  next.hidden = step === 4;
  next.textContent = step === 3 ? "Review role" : "Next";
  const submit = root.querySelector("#modal-submit");
  submit.hidden = step !== 4;
  submit.disabled = step !== 4;
  root.querySelector(`[data-guided-step="${step}"] input:not([disabled]), [data-guided-step="${step}"] select:not([disabled]), [data-guided-step="${step}"] button:not([disabled])`)?.focus();
}

function replacePicker(container, label, name, target) {
  container.innerHTML = arnComboboxField(label, { name, required: true, kinds: [target.kind], localExistence: "preferred", accountScope: "same", regionScope: "same" });
  enhanceArnComboboxes(container);
}

function bindPermissionControls(root, template) {
  const permissions = root.querySelector("[data-guided-permissions]");
  permissions.innerHTML = permissionMarkup(template); associateFormLabels(permissions); enhanceArnComboboxes(permissions);
  permissions.querySelector('[name="targetType"]')?.addEventListener("change", event => replacePicker(permissions.querySelector("[data-guided-target-picker]"), "Target resource ARN", "targetArn", targetTypes[event.target.value]));
  permissions.querySelectorAll('[name="lambdaCapability"]').forEach(checkbox => {
    const updateCapability = () => {
      const capability = permissions.querySelector(`[data-capability="${checkbox.value}"]`);
      capability.hidden = !checkbox.checked;
      capability.querySelectorAll('input[name="capabilityArn"]').forEach(input => { input.disabled = !checkbox.checked; });
    };
    checkbox.addEventListener("change", updateCapability);
    updateCapability();
  });
  permissions.querySelectorAll("[data-add-capability-resource]").forEach(button => button.addEventListener("click", () => {
    const capability = lambdaCapabilities[button.dataset.addCapabilityResource]; const rows = button.closest("[data-capability]").querySelector("[data-capability-rows]");
    const holder = document.createElement("div"); holder.className = "guided-repeated-resource"; holder.innerHTML = `${arnComboboxField("Resource ARN", { name: "capabilityArn", required: true, kinds: [capability.kind], localExistence: "preferred" })}<button class="button link danger" type="button" data-remove-capability-resource>Remove</button>`;
    rows.append(holder); associateFormLabels(holder); enhanceArnComboboxes(holder); holder.querySelector("[data-remove-capability-resource]").addEventListener("click", () => holder.remove()); holder.querySelector("input").focus();
  }));
  const bindTaskRow = row => {
    const select = row.querySelector('[name="taskType"]'); select.addEventListener("change", () => replacePicker(row.querySelector("[data-guided-task-picker]"), "Task resource ARN", "taskArn", targetTypes[select.value]));
    row.querySelector("[data-remove-task]").addEventListener("click", () => { row.remove(); permissions.querySelectorAll("[data-remove-task]").forEach(button => { button.hidden = permissions.querySelectorAll(".guided-task-row").length === 1; }); });
  };
  permissions.querySelectorAll(".guided-task-row").forEach(bindTaskRow);
  permissions.querySelector("[data-add-guided-task]")?.addEventListener("click", () => {
    const holder = document.createElement("div"); holder.innerHTML = taskRowMarkup(); const row = holder.firstElementChild; permissions.querySelector("[data-guided-task-rows]").append(row); associateFormLabels(row); enhanceArnComboboxes(row); bindTaskRow(row); permissions.querySelectorAll("[data-remove-task]").forEach(button => { button.hidden = false; }); row.querySelector("select").focus();
  });
  permissions.querySelector('[name="customPermission"]')?.addEventListener("change", event => replacePicker(permissions.querySelector("[data-guided-custom-picker]"), "Resource ARN", "customArn", targetTypes[event.target.value]));
}

export async function openGuidedRoleCreator(context, existingRoles = []) {
  const knownNames = new Set(existingRoles.map(role => role.roleName));
  context.showModal("Create service role", baseMarkup(), "Create role", async data => {
    const root = document.querySelector("#modal"); const output = generated(root); const roleName = String(data.get("name")).trim();
    if (knownNames.has(roleName)) throw new Error(`A role named ${roleName} already exists.`);
    let tags;
    try { tags = JSON.parse(String(data.get("tags") || "{}")); } catch { throw new Error("Tags must be a JSON object."); }
    if (!tags || Array.isArray(tags) || typeof tags !== "object") throw new Error("Tags must be a JSON object.");
    const createdPolicyArns = []; const attachedPolicyArns = [];
    try {
      await rest("/_stacksim/api/iam/roles", "POST", { RoleName: roleName, Description: String(data.get("description") || ""), AssumeRolePolicyDocument: output.trust, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value: String(Value) })) });
      if (output.permissions.Statement.length) {
        const policy = await rest("/_stacksim/api/iam/policies", "POST", { PolicyName: `${roleName}-guided-policy`, Description: `Generated permissions for ${output.template.name}`, PolicyDocument: output.permissions, Tags: [{ Key: "stacksim:guided-template", Value: `${output.template.id}@${output.template.version}` }] });
        const arn = policy.Policy?.Arn; if (!arn) throw new Error("The generated policy did not return an ARN.");
        createdPolicyArns.push(arn); await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(roleName)}/attach`, "POST", { PolicyArn: arn }); attachedPolicyArns.push(arn);
      }
      for (const arn of output.managedPolicies) { await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(roleName)}/attach`, "POST", { PolicyArn: arn }); attachedPolicyArns.push(arn); }
    } catch (error) {
      for (const arn of attachedPolicyArns.reverse()) await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(roleName)}/detach`, "POST", { PolicyArn: arn }).catch(() => undefined);
      for (const arn of createdPolicyArns.reverse()) await rest(`/_stacksim/api/iam/policies/${encodeURIComponent(arn)}`, "DELETE").catch(() => undefined);
      await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(roleName)}`, "DELETE").catch(() => undefined);
      throw error;
    }
    context.toast("Guided role created"); location.hash = `#/iam/roles/${encodeURIComponent(roleName)}`;
  }, true);
  const root = document.querySelector("#modal"); addWizardFooter(root); const submit = root.querySelector("#modal-submit"); submit.disabled = true;
  let renderedTemplate;
  const ensurePermissions = () => { const template = selectedTemplate(root); if (renderedTemplate !== template.id) { renderedTemplate = template.id; bindPermissionControls(root, template); } return template; };
  const showPermissions = () => { ensurePermissions(); showStep(root, 2); };
  const showDetails = () => {
    const invalid = root.querySelector('[data-guided-step="2"] input:invalid, [data-guided-step="2"] select:invalid');
    if (invalid) { invalid.reportValidity(); return; }
    try { const output = generated(root); const nameInput = root.querySelector('[name="name"]'); if (!nameInput.value || nameInput.dataset.suggested === "true") { nameInput.value = roleNameSuggestion(output.template, output.firstArn); nameInput.dataset.suggested = "true"; } showStep(root, 3); }
    catch (error) { context.showError(error); }
  };
  root.querySelector('[name="name"]').addEventListener("input", event => { event.target.dataset.suggested = "false"; root.querySelector("[data-guided-name-error]").hidden = true; });
  const showReview = () => {
    const name = root.querySelector('[name="name"]'); const error = root.querySelector("[data-guided-name-error]");
    if (!name.reportValidity()) return;
    if (knownNames.has(name.value.trim())) { error.textContent = `A role named ${name.value.trim()} already exists.`; error.hidden = false; name.focus(); return; }
    try { const tags = JSON.parse(root.querySelector('[name="tags"]').value || "{}"); if (!tags || Array.isArray(tags) || typeof tags !== "object") throw new Error(); root.querySelector("[data-guided-review]").innerHTML = reviewMarkup(root); showStep(root, 4); }
    catch { context.showError(new Error("Tags must be a JSON object.")); }
  };
  root.querySelector("[data-guided-next]").addEventListener("click", () => {
    const step = Number(root.dataset.guidedCurrentStep || "1");
    if (step === 1) showPermissions();
    else if (step === 2) showDetails();
    else if (step === 3) showReview();
  });
  root.querySelector("[data-guided-back]").addEventListener("click", () => showStep(root, Number(root.dataset.guidedCurrentStep) - 1));
  showStep(root, 1);
}
