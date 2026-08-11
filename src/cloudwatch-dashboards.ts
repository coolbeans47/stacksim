import { createHash } from "node:crypto";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import type { StateStore } from "./state.js";
import type { CloudWatchDashboardState } from "./types.js";

export const CLOUDWATCH_DASHBOARD_ACTIONS = ["PutDashboard", "GetDashboard", "ListDashboards", "DeleteDashboards", "GetMetricWidgetImage"] as const;

type ValidationMessage = { DataPath: string; Message: string };

const DASHBOARD_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const DASHBOARD_PREFIX = /^[A-Za-z0-9._-]{0,255}$/;
const WIDGET_TYPES = new Set(["text", "metric", "log", "alarm", "explorer"]);
const METRIC_VIEWS = new Set(["timeSeries", "singleValue", "gauge", "bar", "pie", "table"]);
const PROPERTY_KEYS: Record<string, Set<string>> = {
  text: new Set(["markdown", "transparent", "background"]),
  metric: new Set(["metrics", "view", "title", "region", "accountId", "period", "stat", "stacked", "liveData", "legend", "yAxis", "annotations", "setPeriodToTimeRange", "sparkline", "trend", "timezone", "start", "end", "table", "displayLabelsOnChart"]),
  log: new Set(["query", "region", "accountId", "title", "view", "stacked", "legend"]),
  alarm: new Set(["alarms", "title", "sortBy", "states"]),
  explorer: new Set(["metrics", "labels", "aggregateBy", "splitBy", "period", "title", "widgetOptions"]),
};

function dashboardName(value: unknown): string {
  const name = String(value ?? "");
  if (!DASHBOARD_NAME.test(name)) throw new AwsError("InvalidParameterValue", "DashboardName must contain 1-255 letters, numbers, hyphens, or underscores");
  return name;
}

function dashboardArn(accountId: string, name: string): string { return `arn:aws:cloudwatch::${accountId}:dashboard/${name}`; }
function isObject(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validationError(messages: ValidationMessage[]): never { throw new AwsError("InvalidParameterInput", messages.map(item => `${item.DataPath}: ${item.Message}`).join("; ")); }

export function validateDashboardBody(input: unknown): { body: Record<string, any>; warnings: ValidationMessage[] } {
  if (typeof input !== "string" || !input) throw new AwsError("InvalidParameterInput", "DashboardBody is required and must be a JSON string");
  if (Buffer.byteLength(input, "utf8") > 1024 * 1024) throw new AwsError("InvalidParameterInput", "DashboardBody must not exceed 1 MB");
  let body: unknown;
  try { body = JSON.parse(input); } catch (error) { throw new AwsError("InvalidParameterInput", `DashboardBody is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const errors: ValidationMessage[] = []; const warnings: ValidationMessage[] = [];
  if (!isObject(body)) validationError([{ DataPath: "$", Message: "DashboardBody must be a JSON object" }]);
  if (!Array.isArray(body.widgets)) errors.push({ DataPath: "$.widgets", Message: "The widgets array is required" });
  else if (body.widgets.length > 500) errors.push({ DataPath: "$.widgets", Message: "A dashboard can contain at most 500 widgets" });
  if (body.variables !== undefined && (!Array.isArray(body.variables) || body.variables.length > 25)) errors.push({ DataPath: "$.variables", Message: "Variables must be an array containing at most 25 items" });
  if (body.periodOverride !== undefined && !["auto", "inherit"].includes(body.periodOverride)) errors.push({ DataPath: "$.periodOverride", Message: "periodOverride must be auto or inherit" });
  if (body.end !== undefined && body.start === undefined) errors.push({ DataPath: "$.end", Message: "start is required when end is set" });
  if (body.start !== undefined && typeof body.start !== "string") errors.push({ DataPath: "$.start", Message: "start must be a string" });
  if (body.end !== undefined && typeof body.end !== "string") errors.push({ DataPath: "$.end", Message: "end must be a string" });
  for (const [index, widget] of (Array.isArray(body.widgets) ? body.widgets : []).entries()) {
    const path = `$.widgets[${index}]`;
    if (!isObject(widget)) { errors.push({ DataPath: path, Message: "Widget must be an object" }); continue; }
    if (typeof widget.type !== "string" || !widget.type) errors.push({ DataPath: `${path}.type`, Message: "Widget type is required" });
    else if (!WIDGET_TYPES.has(widget.type)) warnings.push({ DataPath: `${path}.type`, Message: `Widget type ${widget.type} is preserved but is not rendered by stacksim` });
    if (!isObject(widget.properties)) errors.push({ DataPath: `${path}.properties`, Message: "Widget properties are required" });
    for (const [key, maximum] of [["x", 23], ["y", Number.MAX_SAFE_INTEGER], ["width", 24], ["height", 1000]] as const) if (widget[key] !== undefined && (!Number.isInteger(widget[key]) || widget[key] < (key === "width" || key === "height" ? 1 : 0) || widget[key] > maximum)) errors.push({ DataPath: `${path}.${key}`, Message: `${key} is outside its supported grid range` });
    if ((widget.x === undefined) !== (widget.y === undefined)) errors.push({ DataPath: path, Message: "x and y must either both be specified or both be omitted" });
    if (widget.x !== undefined && widget.width !== undefined && widget.x + widget.width > 24) errors.push({ DataPath: path, Message: "Widget extends beyond the 24-column grid" });
    if (isObject(widget.properties) && WIDGET_TYPES.has(widget.type)) {
      const allowed = PROPERTY_KEYS[widget.type];
      for (const key of Object.keys(widget.properties)) if (!allowed.has(key)) warnings.push({ DataPath: `${path}.properties.${key}`, Message: `Property ${key} is preserved but is not interpreted by stacksim` });
      if (widget.type === "text" && typeof widget.properties.markdown !== "string") errors.push({ DataPath: `${path}.properties.markdown`, Message: "Text widgets require markdown" });
      if (widget.type === "metric") {
        if (!Array.isArray(widget.properties.metrics) && !Array.isArray(widget.properties.annotations?.alarms)) errors.push({ DataPath: `${path}.properties.metrics`, Message: "Metric widgets require metrics or an alarm annotation" });
        if (widget.properties.view !== undefined && !METRIC_VIEWS.has(widget.properties.view)) warnings.push({ DataPath: `${path}.properties.view`, Message: `Metric view ${widget.properties.view} is preserved but is not rendered by stacksim` });
      }
      if (widget.type === "log" && (typeof widget.properties.query !== "string" || !widget.properties.query)) errors.push({ DataPath: `${path}.properties.query`, Message: "Log widgets require a query" });
      if (widget.type === "alarm" && !Array.isArray(widget.properties.alarms)) errors.push({ DataPath: `${path}.properties.alarms`, Message: "Alarm widgets require an alarms array" });
      if (widget.type === "explorer" && !Array.isArray(widget.properties.metrics)) errors.push({ DataPath: `${path}.properties.metrics`, Message: "Explorer widgets require a metrics array" });
    }
  }
  for (const [index, variable] of (Array.isArray(body.variables) ? body.variables : []).entries()) {
    const path = `$.variables[${index}]`;
    if (!isObject(variable)) { errors.push({ DataPath: path, Message: "Variable must be an object" }); continue; }
    if (!["property", "pattern"].includes(variable.type)) errors.push({ DataPath: `${path}.type`, Message: "Variable type must be property or pattern" });
    if (!["input", "select", "radio"].includes(variable.inputType)) errors.push({ DataPath: `${path}.inputType`, Message: "Variable inputType must be input, select, or radio" });
    if (typeof variable.id !== "string" || !/^[0-9A-Za-z_-]{1,32}$/.test(variable.id)) errors.push({ DataPath: `${path}.id`, Message: "Variable id is invalid" });
    if (variable.type === "property" && typeof variable.property !== "string") errors.push({ DataPath: `${path}.property`, Message: "Property variables require property" });
    if (variable.type === "pattern" && typeof variable.pattern !== "string") errors.push({ DataPath: `${path}.pattern`, Message: "Pattern variables require pattern" });
    if (variable.values !== undefined && (!Array.isArray(variable.values) || variable.values.length < 1 || variable.values.length > 500)) errors.push({ DataPath: `${path}.values`, Message: "Variable values must contain between 1 and 500 items" });
  }
  if (errors.length) validationError(errors);
  return { body, warnings };
}

export class CloudWatchDashboardEngine {
  private readonly tokens: PaginationTokens;
  constructor(private readonly store: StateStore, private readonly clock: Clock) { this.tokens = new PaginationTokens(store.state.installation.paginationSecret); }
  private get dashboards(): Record<string, CloudWatchDashboardState> { return this.store.ensureAccount().cloudwatchDashboards; }

  async PutDashboard(input: any): Promise<any> {
    const name = dashboardName(input.DashboardName); const bodyText = input.DashboardBody; const { warnings } = validateDashboardBody(bodyText);
    if (!this.dashboards[name] && Object.keys(this.dashboards).length >= 500) throw new AwsError("LimitExceeded", "The account dashboard quota of 500 has been reached");
    const previous = this.dashboards[name]; const tags = previous?.tags ?? Object.fromEntries((Array.isArray(input.Tags) ? input.Tags : []).map((tag: any) => [String(tag?.Key ?? ""), String(tag?.Value ?? "")]));
    if (!previous && Object.keys(tags).length > 50) throw new AwsError("InvalidParameterValue", "A dashboard can have at most 50 tags");
    this.dashboards[name] = { dashboardName: name, dashboardArn: dashboardArn(this.store.accountId, name), dashboardBody: bodyText, lastModified: this.clock.now(), size: Buffer.byteLength(bodyText, "utf8"), tags };
    await this.store.save(); return { DashboardValidationMessages: warnings };
  }

  async GetDashboard(input: any): Promise<any> {
    const name = dashboardName(input.DashboardName); const dashboard = this.dashboards[name];
    if (!dashboard) throw new AwsError("ResourceNotFound", `Dashboard ${name} does not exist`, 404);
    return { DashboardArn: dashboard.dashboardArn, DashboardBody: dashboard.dashboardBody, DashboardName: dashboard.dashboardName };
  }

  async ListDashboards(input: any): Promise<any> {
    const prefix = input.DashboardNamePrefix === undefined ? "" : String(input.DashboardNamePrefix);
    if (!DASHBOARD_PREFIX.test(prefix)) throw new AwsError("InvalidParameterValue", "DashboardNamePrefix is invalid");
    const signature = createHash("sha256").update(prefix).digest("hex"); let index = 0;
    if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; signature: string }>("ListDashboards", input.NextToken); if (cursor.signature !== signature) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidParameterValue", "The next token is invalid"); }
    const values = Object.values(this.dashboards).filter(item => item.dashboardName.startsWith(prefix)).sort((left, right) => left.dashboardName.localeCompare(right.dashboardName)); const page = values.slice(index, index + 1000); const next = index + page.length;
    return { DashboardEntries: page.map(item => ({ DashboardName: item.dashboardName, DashboardArn: item.dashboardArn, LastModified: new Date(item.lastModified), Size: item.size })), ...(next < values.length ? { NextToken: this.tokens.encode("ListDashboards", { index: next, signature }) } : {}) };
  }

  async DeleteDashboards(input: any): Promise<Record<string, never>> {
    const names = Array.isArray(input.DashboardNames) ? input.DashboardNames : [];
    if (names.length < 1 || names.length > 100) throw new AwsError("InvalidParameterValue", "DashboardNames must contain between 1 and 100 names");
    for (const value of names) delete this.dashboards[dashboardName(value)];
    await this.store.save(); return {};
  }

  async GetMetricWidgetImage(_input: any): Promise<never> {
    throw new AwsError("UnsupportedOperation", "GetMetricWidgetImage is not available because stacksim does not yet include a deterministic PNG renderer");
  }
}
