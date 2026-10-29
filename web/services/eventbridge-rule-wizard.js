// EventBridge rule builders (EVB-10): the builder-selection page, the five-step Advanced Builder, and the
// Scheduled rule (legacy) page. Layout follows the AWS console wizard: step list on the left, one step at a time.
import { events } from "../api-client.js";
import { associateFormLabels, escapeHtml, formatDate, pageHeader } from "../components.js";
import { session as ui, setDirty } from "../state.js";
import {
  bindPatternBuilder, bindTagRows, bindTargetModal, lambdaFunctions, listBuses, listRules, nextCronDates, parseObject, patternBuilderMarkup, readPatternBuilder, readTagRows,
  ruleRoot, scopedFormData, stateMarkup, tagRowsMarkup, targetArnFromForm, targetDisplayName, targetFields, targetFromForm, targetType, targetTypeLabel,
} from "./eventbridge-shared.js";

const PREFILL_KEY = "eventbridge.ruleWizard.prefill";

export function setRuleWizardPrefill(value) { try { sessionStorage.setItem(PREFILL_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ } }
function takePrefill() { try { const raw = sessionStorage.getItem(PREFILL_KEY); sessionStorage.removeItem(PREFILL_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }

/** AWS shows a builder-selection page after "Create rule": Enhanced Builder (visual canvas) or Advanced Builder (JSON wizard). */
export async function ruleBuilderSelectionPage(context) {
  context.setChrome("eventbridge", ["EventBridge", { label: "Rules", href: "#/eventbridge/rules" }, "Create rule"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Create rule", "Choose how you want to build the rule.")}<div class="eventbridge-builder-choice"><section class="card eventbridge-builder-card"><div class="card-body"><h2>Enhanced Builder</h2><p>A visual canvas for building rules and targets. Drag and drop events and targets, filter on event attributes, and test with sample events.</p><span class="status inactive">Not available locally</span><p class="muted small">The Enhanced Builder is a visual AWS console surface that StackSim does not reproduce; use the Advanced Builder for the same rule configuration.</p><button class="button" type="button" disabled aria-disabled="true">Choose Enhanced Builder</button></div></section><section class="card eventbridge-builder-card"><div class="card-body"><h2>Advanced Builder</h2><p>JSON patterns and configuration for rules and targets. Define the rule, build the event pattern, select up to five targets, add tags, and review.</p><span class="status">Available</span><p class="muted small">Scheduled rules are a legacy feature; create them from <a href="#/eventbridge/scheduled-rules">Scheduled rule (legacy)</a> or use EventBridge Scheduler.</p><a class="button primary" href="#/eventbridge/rules/create/advanced">Choose Advanced Builder</a></div></section></div></div>`;
}

function stepList(steps, current) {
  return `<nav class="eventbridge-wizard-nav" aria-label="Create rule steps"><ol>${steps.map((label, index) => `<li class="${index + 1 === current ? "active" : index + 1 < current ? "done" : ""}" data-step-link="${index + 1}"><span>Step ${index + 1}</span><strong>${escapeHtml(label)}</strong></li>`).join("")}</ol></nav>`;
}

function ruleDetailStep(mode, buses, prefill) {
  const busOptions = buses.map(bus => `<option value="${escapeHtml(bus.Name)}" ${bus.Name === (prefill.bus ?? "default") ? "selected" : ""}>${escapeHtml(bus.Name)}</option>`).join("");
  const common = `<section class="card"><div class="card-header"><h2>Rule detail</h2></div><div class="card-body"><div class="field"><label>Name</label><input name="name" required maxlength="64" pattern="[A-Za-z0-9_.\\-]+" value="${escapeHtml(prefill.name ?? "")}" placeholder="my-rule"><span class="hint">Maximum of 64 characters consisting of numbers, lower/upper case letters, ., -, _.</span></div><div class="field"><label>Description <span class="muted small">– optional</span></label><input name="description" maxlength="512" value="${escapeHtml(prefill.description ?? "")}"></div>`;
  if (mode === "schedule") {
    return `${common}<label class="checkbox-label"><input type="checkbox" name="enabled" checked> Enable the scheduled rule</label><div class="alert info"><strong>Scheduled rules are a legacy feature of EventBridge</strong><br>We recommend that you use <a href="#/eventbridge/schedules">EventBridge Scheduler</a> to invoke targets on a schedule. Legacy scheduled rules run on the default event bus, in UTC, with one-minute precision.</div></div></section>
<section class="card" data-schedule-pattern><div class="card-header"><h2>Schedule pattern</h2></div><div class="card-body"><fieldset class="setting-options eventbridge-choice-grid"><legend class="sr-only">Schedule pattern</legend><label class="setting-option"><input type="radio" name="scheduleKind" value="cron" checked><span><strong>A fine-grained schedule that runs at a specific time, such as 8:00 a.m. PST on the first Monday of every month.</strong></span></label><label class="setting-option"><input type="radio" name="scheduleKind" value="rate"><span><strong>A schedule that runs at a regular rate, such as every 10 minutes.</strong></span></label></fieldset>
<div data-schedule-cron><h3>Cron expression</h3><div class="eventbridge-cron-grid"><div class="field"><label>Minutes</label><input name="cronMinutes" value="0" required></div><div class="field"><label>Hours</label><input name="cronHours" value="9" required></div><div class="field"><label>Day of month</label><input name="cronDayOfMonth" value="?" required></div><div class="field"><label>Month</label><input name="cronMonth" value="*" required></div><div class="field"><label>Day of the week</label><input name="cronDayOfWeek" value="MON-FRI" required></div><div class="field"><label>Year</label><input name="cronYear" value="*" required></div></div><p class="mono" data-cron-expression></p><div class="field"><fieldset class="eventbridge-inline-radios"><legend>Next 10 trigger date(s)</legend><label class="radio-label"><input type="radio" name="cronZone" value="utc" checked> UTC</label><label class="radio-label"><input type="radio" name="cronZone" value="local"> Local time zone</label></fieldset></div><ol class="eventbridge-cron-dates" data-cron-dates></ol></div>
<div data-schedule-rate hidden><h3>Rate expression</h3><div class="field-row"><div class="field"><label>Value</label><input name="rateValue" type="number" min="1" step="1" value="5"></div><div class="field"><label>Unit</label><select name="rateUnit"><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></div></div><p class="mono" data-rate-expression></p></div></div></section>`;
  }
  return `${common}<div class="field"><label>Event bus</label><select name="bus">${busOptions}</select><span class="hint">Select the event bus this rule applies to.</span></div><label class="checkbox-label"><input type="checkbox" name="enabled" checked> Enable the rule on the selected event bus</label></div></section>
<section class="card"><div class="card-header"><h2>Rule type</h2></div><div class="card-body"><fieldset class="setting-options eventbridge-choice-grid"><legend class="sr-only">Rule type</legend><label class="setting-option"><input type="radio" name="ruleType" value="pattern" checked><span><strong>Rule with an event pattern</strong><small>A rule that runs when an event matches the event pattern.</small></span></label><label class="setting-option"><input type="radio" name="ruleType" value="schedule"><span><strong>Schedule</strong><small>A rule that runs on a schedule. Scheduled rules are a legacy feature; EventBridge Scheduler is recommended.</small></span></label></fieldset><div class="alert info" data-schedule-redirect hidden><strong>EventBridge Scheduler is recommended</strong><br>Scheduler supports one-time schedules, time zones, flexible windows, and more targets. To create a legacy scheduled rule on the default bus instead, <a href="#/eventbridge/scheduled-rules/create">continue to create scheduled rule</a>.</div></div></section>`;
}

function targetBlockMarkup(functions, index, sourceArn) {
  return `<fieldset class="card eventbridge-target-block" data-target-block><div class="card-header"><h3>Target ${index}</h3><button class="button link danger" type="button" data-remove-target-block aria-label="Remove target ${index}">Remove</button></div><div class="card-body"><fieldset class="setting-options eventbridge-choice-grid"><legend>Target types</legend><label class="setting-option disabled"><input type="radio" name="targetKind" value="bus" disabled><span><strong>EventBridge event bus</strong><small>Event bus targets require cross-account event-bus routing (EVB-06), which is not available locally.</small></span></label><label class="setting-option disabled"><input type="radio" name="targetKind" value="apidestination" disabled><span><strong>EventBridge API destination</strong><small>API destinations and connections require EVB-06.</small></span></label><label class="setting-option"><input type="radio" name="targetKind" value="service" checked><span><strong>AWS service</strong><small>Invoke a Lambda function, send to SQS or SNS, write to CloudWatch Logs, call an API Gateway endpoint, or start a Step Functions workflow.</small></span></label></fieldset>${targetFields(functions, {}, true, sourceArn)}</div></fieldset>`;
}

function readTargets(root) {
  const targets = [];
  for (const block of root.querySelectorAll("[data-target-block]")) {
    const data = scopedFormData(block); const arn = targetArnFromForm(data);
    if (!arn) throw new Error("Select a target resource for every target, or remove the empty target");
    targets.push(targetFromForm(data, arn));
  }
  return targets;
}

function cronExpressionFrom(data) { return `cron(${["cronMinutes", "cronHours", "cronDayOfMonth", "cronMonth", "cronDayOfWeek", "cronYear"].map(name => String(data.get(name) ?? "").trim()).join(" ")})`; }
function rateExpressionFrom(data) { const value = Number(data.get("rateValue")); const unit = String(data.get("rateUnit") ?? "minutes"); return `rate(${value} ${value === 1 ? unit.replace(/s$/, "") : unit})`; }

/** The Advanced Builder (mode "pattern") and the Scheduled rule (legacy) wizard (mode "schedule"). */
export async function ruleWizardPage(context, mode = "pattern") {
  const prefill = takePrefill();
  const [buses, functions] = await Promise.all([listBuses(), lambdaFunctions()]);
  const steps = mode === "schedule" ? ["Define scheduled rule", "Select target(s)", "Configure tags", "Review and create"] : ["Define rule detail", "Build event pattern", "Select target(s)", "Configure tags", "Review and create"];
  const title = mode === "schedule" ? "Create scheduled rule" : "Create rule";
  const crumbs = mode === "schedule" ? ["EventBridge", { label: "Scheduled rule (legacy)", href: "#/eventbridge/scheduled-rules" }, title] : ["EventBridge", { label: "Rules", href: "#/eventbridge/rules" }, "Create rule", "Advanced Builder"];
  context.setChrome("eventbridge", crumbs);
  let step = 1;
  const stepSections = steps.map((label, index) => {
    const number = index + 1; let body = "";
    if (mode === "pattern") {
      if (number === 1) body = ruleDetailStep(mode, buses, prefill);
      if (number === 2) body = patternBuilderMarkup({ pattern: prefill.pattern, sampleEvent: prefill.sampleEvent, method: prefill.pattern ? "custom" : "form", sourceMode: prefill.pattern ? "other" : "aws" });
      if (number === 3) body = `<section class="card"><div class="card-header"><h2>Target(s)</h2></div><div class="card-body"><p class="muted">Select up to five targets. Each target receives the matched event independently and can transform its input, retry, and dead-letter on its own.</p></div></section><div data-targets></div><div class="eventbridge-inline-actions start"><button class="button" type="button" data-add-target-block>Add another target</button></div>`;
      if (number === 4) body = `<section class="card"><div class="card-header"><h2>Tags <span class="muted small">– optional</span></h2></div><div class="card-body"><p class="muted">Tags are key-value pairs that help you organize and identify your rule.</p>${tagRowsMarkup(prefill.tags ?? {})}</div></section>`;
      if (number === 5) body = `<div data-review></div>`;
    } else {
      if (number === 1) body = ruleDetailStep(mode, buses, prefill);
      if (number === 2) body = `<section class="card"><div class="card-header"><h2>Target(s)</h2></div><div class="card-body"><p class="muted">Select up to five targets for each scheduled occurrence.</p></div></section><div data-targets></div><div class="eventbridge-inline-actions start"><button class="button" type="button" data-add-target-block>Add another target</button></div>`;
      if (number === 3) body = `<section class="card"><div class="card-header"><h2>Tags <span class="muted small">– optional</span></h2></div><div class="card-body">${tagRowsMarkup(prefill.tags ?? {})}</div></section>`;
      if (number === 4) body = `<div data-review></div>`;
    }
    return `<section data-wizard-step="${number}" ${number === 1 ? "" : "hidden"}><h2 class="eventbridge-wizard-title">Step ${number}: ${escapeHtml(label)}</h2>${body}</section>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width eventbridge-page eventbridge-wizard">${pageHeader(title, mode === "schedule" ? "Legacy scheduled rules run on the default event bus. EventBridge Scheduler is recommended for new schedules." : "Define the rule, build its event pattern, choose targets, add tags, and review.")}<div class="eventbridge-wizard-layout"><div data-wizard-nav>${stepList(steps, 1)}</div><form class="eventbridge-wizard-form" data-rule-wizard novalidate><div class="alert error" data-wizard-error hidden role="alert"></div>${stepSections}<div class="actions page-actions eventbridge-wizard-actions"><a class="button" href="${mode === "schedule" ? "#/eventbridge/scheduled-rules" : "#/eventbridge/rules"}">Cancel</a><button class="button" type="button" data-wizard-previous hidden>Previous</button><button class="button primary" type="button" data-wizard-next>Next</button><button class="button primary" type="submit" data-wizard-submit hidden>${escapeHtml(title)}</button></div></form></div></div>`;
  const form = context.main.querySelector("[data-rule-wizard]"); associateFormLabels(form);
  const markDirty = () => setDirty(true, "page");
  form.addEventListener("input", markDirty); form.addEventListener("change", markDirty);
  const errorBox = form.querySelector("[data-wizard-error]");
  const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; if (message) errorBox.scrollIntoView({ block: "nearest" }); };
  const sectionFor = number => form.querySelector(`[data-wizard-step="${number}"]`);
  const data = () => scopedFormData(form);
  const targetsStep = mode === "schedule" ? 2 : 3; const tagsStep = mode === "schedule" ? 3 : 4; const reviewStep = steps.length;
  let targetCount = 0;
  const ruleName = () => String(data().get("name") ?? "").trim();
  const busName = () => mode === "schedule" ? "default" : String(data().get("bus") ?? "default");
  const ruleArn = () => `arn:aws:events:${ui.region}:${ui.summary?.accountId ?? "000000000000"}:rule/${busName() === "default" ? "" : `${busName()}/`}${ruleName() || "RULE_NAME"}`;
  const targetsRoot = form.querySelector("[data-targets]");
  const addTargetBlock = () => {
    if (targetsRoot.querySelectorAll("[data-target-block]").length >= 5) return;
    targetsRoot.insertAdjacentHTML("beforeend", targetBlockMarkup(functions, ++targetCount, ruleArn()));
    const block = targetsRoot.lastElementChild; associateFormLabels(block);
    const idField = block.querySelector('input[name="targetId"]'); idField.value = `Id${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`; idField.closest(".field").hidden = true;
    bindTargetModal(block);
    block.querySelector("[data-remove-target-block]").addEventListener("click", () => { block.remove(); renumberTargets(); markDirty(); });
    renumberTargets();
  };
  const renumberTargets = () => { const blocks = [...targetsRoot.querySelectorAll("[data-target-block]")]; blocks.forEach((block, index) => { block.querySelector("h3").textContent = `Target ${index + 1}`; block.querySelector("[data-remove-target-block]").setAttribute("aria-label", `Remove target ${index + 1}`); }); form.querySelector("[data-add-target-block]").disabled = blocks.length >= 5; };
  form.querySelector("[data-add-target-block]").addEventListener("click", addTargetBlock);
  addTargetBlock();
  bindTagRows(sectionFor(tagsStep), markDirty);
  if (mode === "pattern") {
    bindPatternBuilder(sectionFor(2), { onChange: markDirty });
    const redirect = form.querySelector("[data-schedule-redirect]");
    form.querySelectorAll('[name="ruleType"]').forEach(input => input.addEventListener("change", () => { redirect.hidden = data().get("ruleType") !== "schedule"; }));
  } else {
    const cronBox = form.querySelector("[data-schedule-cron]"); const rateBox = form.querySelector("[data-schedule-rate]");
    const syncSchedule = () => {
      const kind = data().get("scheduleKind"); cronBox.hidden = kind !== "cron"; rateBox.hidden = kind !== "rate";
      if (kind === "rate") { form.querySelector("[data-rate-expression]").textContent = rateExpressionFrom(data()); return; }
      const expression = cronExpressionFrom(data()); form.querySelector("[data-cron-expression]").textContent = expression; const list = form.querySelector("[data-cron-dates]");
      try { const dates = nextCronDates(expression, 10); const local = data().get("cronZone") === "local"; list.innerHTML = dates === null ? '<li class="muted">Preview is not available for L, W, or # fields; the expression is validated when the rule is created.</li>' : dates.length ? dates.map(value => `<li>${escapeHtml(local ? formatDate(value) : new Date(value).toISOString().replace(".000Z", " UTC").replace("T", " "))}</li>`).join("") : '<li class="muted">No trigger dates in the next six years.</li>'; }
      catch (error) { list.innerHTML = `<li class="eventbridge-cron-error">${escapeHtml(error.message)}</li>`; }
    };
    form.querySelectorAll("[data-schedule-pattern] input, [data-schedule-pattern] select").forEach(control => { control.addEventListener("input", syncSchedule); control.addEventListener("change", syncSchedule); });
    syncSchedule();
  }

  const scheduleExpression = () => data().get("scheduleKind") === "rate" ? rateExpressionFrom(data()) : cronExpressionFrom(data());
  const collect = () => {
    const name = ruleName(); if (!name) throw new Error("Enter a rule name");
    const description = String(data().get("description") ?? "").trim();
    const enabled = data().get("enabled") !== null;
    const pattern = mode === "pattern" ? readPatternBuilder(sectionFor(2)) : undefined;
    if (mode === "pattern" && !pattern) throw new Error("Enter an event pattern");
    return { Name: name, EventBusName: busName(), ...(description ? { Description: description } : {}), State: enabled ? "ENABLED" : "DISABLED", ...(pattern ? { EventPattern: pattern } : {}), ...(mode === "schedule" ? { ScheduleExpression: scheduleExpression() } : {}), tags: readTagRows(sectionFor(tagsStep)), targets: readTargets(targetsRoot) };
  };
  const validateStep = number => {
    const section = sectionFor(number);
    for (const control of section.querySelectorAll("input, select, textarea")) { if (control.disabled || control.closest("[hidden]")) continue; if (!control.checkValidity()) { control.reportValidity(); return false; } }
    if (mode === "pattern" && number === 1 && data().get("ruleType") === "schedule") { showError("Legacy scheduled rules are created from Scheduled rule (legacy). Choose \"Rule with an event pattern\" to continue here."); return false; }
    try {
      if (mode === "pattern" && number === 2) { if (!readPatternBuilder(section)) throw new Error("Enter an event pattern"); }
      if (mode === "schedule" && number === 1) { if (data().get("scheduleKind") === "cron") { const dates = nextCronDates(cronExpressionFrom(data()), 1); if (dates && !dates.length) throw new Error("The cron expression never triggers in the next six years"); } }
      if (number === targetsStep) readTargets(targetsRoot);
      if (number === tagsStep) readTagRows(section);
    } catch (error) { showError(error.message); return false; }
    showError(""); return true;
  };
  const renderReview = () => {
    let rule; try { rule = collect(); } catch (error) { showError(error.message); return; }
    const editButton = number => `<button class="button" type="button" data-step-jump="${number}">Edit</button>`;
    const targetRows = rule.targets.map(target => `<tr><td>${escapeHtml(targetTypeLabel(targetType(target)))}</td><td class="mono">${escapeHtml(targetDisplayName(target))}</td><td>${escapeHtml(target.Input !== undefined ? "Constant (JSON text)" : target.InputPath !== undefined ? `Part of the matched event ${target.InputPath}` : target.InputTransformer ? "Input transformer" : "Matched events")}</td><td>${escapeHtml(target.RoleArn ? target.RoleArn.split("/").at(-1) : "Resource policy")}</td><td>${escapeHtml(target.DeadLetterConfig?.Arn ? target.DeadLetterConfig.Arn.split(":").at(-1) : "None")}</td><td>${target.RetryPolicy.MaximumEventAgeInSeconds} s · ${target.RetryPolicy.MaximumRetryAttempts}</td></tr>`).join("");
    form.querySelector("[data-review]").innerHTML = `<section class="card"><div class="card-header"><h2>Step 1: ${escapeHtml(steps[0])}</h2>${editButton(1)}</div><div class="card-body"><dl class="key-value"><dt>Name</dt><dd>${escapeHtml(rule.Name)}</dd><dt>Description</dt><dd>${escapeHtml(rule.Description ?? "–")}</dd><dt>Event bus</dt><dd>${escapeHtml(rule.EventBusName)}</dd><dt>State</dt><dd>${rule.State === "ENABLED" ? "Enabled" : "Disabled"}</dd><dt>Rule type</dt><dd>${mode === "schedule" ? "Schedule (legacy)" : "Rule with an event pattern"}</dd>${mode === "schedule" ? `<dt>Schedule expression</dt><dd class="mono">${escapeHtml(rule.ScheduleExpression)}</dd>` : ""}</dl></div></section>${mode === "pattern" ? `<section class="card"><div class="card-header"><h2>Step 2: ${escapeHtml(steps[1])}</h2>${editButton(2)}</div><div class="card-body"><pre class="code-box eventbridge-json-preview">${escapeHtml(JSON.stringify(JSON.parse(rule.EventPattern), null, 2))}</pre></div></section>` : ""}<section class="card"><div class="card-header"><h2>Step ${targetsStep}: Select target(s)</h2>${editButton(targetsStep)}</div><div class="table-wrap">${rule.targets.length ? `<table><thead><tr><th>Target</th><th>Resource</th><th>Input</th><th>Execution role</th><th>Dead-letter queue</th><th>Max age · retries</th></tr></thead><tbody>${targetRows}</tbody></table>` : '<p class="muted" style="padding:16px">No targets. Events that match the rule are counted but delivered nowhere until a target is added.</p>'}</div></section><section class="card"><div class="card-header"><h2>Step ${tagsStep}: Configure tags</h2>${editButton(tagsStep)}</div><div class="table-wrap">${Object.keys(rule.tags).length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${Object.entries(rule.tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted" style="padding:16px">No tags.</p>'}</div></section>`;
    form.querySelectorAll("[data-step-jump]").forEach(button => button.addEventListener("click", () => showStep(Number(button.dataset.stepJump))));
  };
  const showStep = number => {
    step = number;
    form.querySelectorAll("[data-wizard-step]").forEach(section => { section.hidden = Number(section.dataset.wizardStep) !== number; });
    context.main.querySelector("[data-wizard-nav]").innerHTML = stepList(steps, number);
    form.querySelector("[data-wizard-previous]").hidden = number === 1;
    form.querySelector("[data-wizard-next]").hidden = number === reviewStep;
    form.querySelector("[data-wizard-submit]").hidden = number !== reviewStep;
    if (number === reviewStep) renderReview();
    showError(""); context.main.scrollIntoView({ block: "start" }); window.scrollTo({ top: 0 });
  };
  form.querySelector("[data-wizard-next]").addEventListener("click", () => { if (validateStep(step)) showStep(step + 1); });
  form.querySelector("[data-wizard-previous]").addEventListener("click", () => showStep(step - 1));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector("[data-wizard-submit]"); submit.disabled = true;
    try {
      const { tags, targets, ...rule } = collect();
      await events("PutRule", { ...rule, ...(Object.keys(tags).length ? { Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } : {}) });
      setDirty(false, "page");
      if (targets.length) {
        const result = await events("PutTargets", { Rule: rule.Name, EventBusName: rule.EventBusName, Targets: targets });
        if (result.FailedEntryCount) { context.toast(`Rule created, but ${result.FailedEntryCount} target(s) failed: ${result.FailedEntries?.[0]?.ErrorMessage ?? "unknown error"}`, "error"); location.hash = `${ruleRoot(rule.EventBusName, rule.Name)}/targets`; return; }
      }
      context.toast(mode === "schedule" ? "Scheduled rule created" : "Rule created");
      location.hash = `${ruleRoot(rule.EventBusName, rule.Name)}/details`;
    } catch (error) { showError(error instanceof Error ? error.message : String(error)); submit.disabled = false; }
  });
}

/** Scheduler › Scheduled rule (legacy): the default-bus rules that carry a schedule expression. */
export async function scheduledRulesPage(context) {
  const rules = (await listRules("default")).filter(rule => rule.ScheduleExpression);
  context.setChrome("eventbridge", ["EventBridge", "Scheduled rule (legacy)"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Scheduled rule (legacy)", "Rules on the default event bus that run on a rate or cron schedule.", '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh scheduled rules">↻</button><a class="button primary" href="#/eventbridge/scheduled-rules/create">Create scheduled rule</a>')}<div class="alert info"><strong>Scheduled rules are a legacy feature of EventBridge</strong><br>We recommend that you use <a href="#/eventbridge/schedules">EventBridge Scheduler</a> to invoke targets on a schedule. Legacy rules use UTC, one-minute precision, and the default event bus only.</div><section class="card"><div class="card-header"><h2>Scheduled rules <span class="muted">(${rules.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find scheduled rules"></label></div><div class="table-wrap">${rules.length ? `<table class="eventbridge-rule-table"><thead><tr><th>Name</th><th>Status</th><th>Schedule expression</th><th>Description</th></tr></thead><tbody>${rules.map(rule => `<tr data-search-row="${escapeHtml(`${rule.Name} ${rule.Description || ""}`.toLowerCase())}"><td><a href="${ruleRoot("default", rule.Name)}/details">${escapeHtml(rule.Name)}</a></td><td>${stateMarkup(rule.State)}</td><td class="mono">${escapeHtml(rule.ScheduleExpression)}</td><td>${escapeHtml(rule.Description || "–")}</td></tr>`).join("")}</tbody></table>` : `<div class="empty"><div class="empty-icon">◷</div><h3>No scheduled rules</h3><p>Create a legacy scheduled rule, or use EventBridge Scheduler for new time-driven work.</p></div>`}</div></section></div>`;
  context.bindTableFilter(); document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

export { parseObject };
