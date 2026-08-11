import { appsync, rest } from "../api-client.js";
import { escapeHtml, pageHeader } from "../components.js";
import { readPinnedServices, writePinnedServices } from "../pinned-services.js";
import { session as ui } from "../state.js";

export const metadata = { key: "home", name: "Console Home", icon: "⌂", cls: "", links: [["Home", "#/home"], ["Local environment", "#/environment"]], search: ["home", "environment", "local"] };

let context;

async function appSyncApiCount() {
  let count = 0;
  let nextToken;
  do {
    const page = await appsync("/v1/apis", { query: { maxResults: 25, apiType: "GRAPHQL", owner: "CURRENT_ACCOUNT", ...(nextToken ? { nextToken } : {}) } });
    count += page.graphqlApis?.length ?? 0;
    nextToken = page.nextToken;
  } while (nextToken);
  return count;
}

export function sortServiceDashboards(services, pinnedServices) {
  return [...services].sort((left, right) => {
    const pinOrder = Number(pinnedServices.has(right.key)) - Number(pinnedServices.has(left.key));
    return pinOrder || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function serviceIcon(cls) {
  return cls === "lambda" ? "λ" : cls === "db" ? "D" : cls === "rds" ? "R" : cls === "s3" ? "S3" : cls === "sqs" ? "Q" : cls === "sns" ? "N" : cls === "ses" ? "@" : cls === "cw" ? "◉" : cls === "iam" ? "◆" : cls === "eventbridge" ? "E" : cls === "step-functions" ? "SF" : "⇆";
}

function serviceDashboard({ key, cls, name, label, count, text, href, icon = serviceIcon(cls) }, pinned) {
  const displayCount = count === undefined ? "–" : Number(count);
  const pinLabel = `${pinned ? "Unpin" : "Pin"} ${name}`;
  return `<section class="card service-card ${cls}" data-service-key="${escapeHtml(key)}"><div class="card-header"><span class="service-icon ${cls}" aria-hidden="true">${icon}</span><div class="service-card-heading"><h2>${escapeHtml(name)}</h2><p>${escapeHtml(text)}</p></div><button type="button" class="service-pin ${pinned ? "pinned" : ""}" data-service-pin="${escapeHtml(key)}" aria-label="${escapeHtml(pinLabel)}" aria-pressed="${pinned}" title="${escapeHtml(pinLabel)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z"/></svg></button></div><div class="card-body"><div class="metric">${displayCount}</div><div class="metric-label">${escapeHtml(label)}</div></div><footer><a href="${escapeHtml(href)}">View ${escapeHtml(label.toLowerCase())}<span aria-hidden="true">→</span></a></footer></section>`;
}

function renderServiceDashboards(grid, services) {
  const pinnedServices = readPinnedServices();
  const render = focusKey => {
    grid.innerHTML = sortServiceDashboards(services, pinnedServices).map(service => serviceDashboard(service, pinnedServices.has(service.key))).join("");
    grid.querySelectorAll("[data-service-pin]").forEach(button => button.addEventListener("click", () => {
      const key = button.dataset.servicePin;
      if (pinnedServices.has(key)) pinnedServices.delete(key);
      else pinnedServices.add(key);
      writePinnedServices(pinnedServices);
      context.setHomeServices(services);
      render(key);
    }));
    if (focusKey) [...grid.querySelectorAll("[data-service-pin]")].find(button => button.dataset.servicePin === focusKey)?.focus();
  };
  render();
}

async function home() {
  context.setChrome("home", ["Console Home"]);
  const [summary, environment, appSyncCount] = await Promise.all([rest("/_stacksim/api/summary"), rest("/_stacksim/api/environment"), appSyncApiCount().catch(() => undefined)]);
  ui.summary = summary;
  ui.environment = environment;
  const services = [
    { key: "lambda", cls: "lambda", name: "Lambda", label: "Functions", count: summary.counts.functions, text: "Build and run code without thinking about servers.", href: "#/lambda/functions" },
    { key: "dynamodb", cls: "db", name: "DynamoDB", label: "Tables", count: summary.counts.tables, text: "Fast, flexible NoSQL data for your applications.", href: "#/dynamodb/tables" },
    { key: "eventbridge", cls: "eventbridge", name: "EventBridge", label: "Event buses", count: summary.counts.eventBuses ?? 0, text: "Route custom and scheduled development events to local targets.", href: "#/eventbridge/event-buses" },
    { key: "rds", cls: "rds", name: "RDS", label: "DB instances", count: summary.counts.rdsInstances ?? summary.counts.dbInstances ?? summary.counts.rds ?? 0, text: "Run one local MySQL-compatible database for development.", href: "#/rds/databases" },
    { key: "s3", cls: "s3", name: "S3", label: "Buckets", count: summary.counts.buckets, text: "Store and retrieve objects with versioned local persistence.", href: "#/s3/buckets" },
    { key: "sqs", cls: "sqs", name: "SQS", label: "Queues", count: summary.counts.queues ?? 0, text: "Buffer work with durable messages, visibility retries, and dead-letter queues.", href: "#/sqs/queues" },
    { key: "sns", cls: "sns", name: "SNS", label: "Topics", count: summary.counts.topics ?? 0, text: "Publish signed notifications to SQS queues and Lambda functions.", href: "#/sns/topics" },
    { key: "ses", cls: "ses", name: "SES", label: "Identities", count: summary.counts.sesIdentities ?? summary.counts.emailIdentities ?? 0, text: "Send application email into a safe, durable local inbox.", href: "#/ses/identities" },
    { key: "cognito", cls: "cognito", name: "Cognito", label: "User pools", count: summary.counts.cognitoUserPools ?? 0, text: "Sign up users, confirm email, and issue signed local JWTs.", href: "#/cognito/user-pools" },
    { key: "systems-manager", cls: "ssm", name: "Parameter Store", label: "Parameters", count: summary.counts.parameters ?? 0, text: "Store plain and locally protected application configuration.", href: "#/systems-manager/parameter-store" },
    { key: "secrets-manager", cls: "secrets", name: "Secrets Manager", label: "Secrets", count: summary.counts.secrets ?? 0, text: "Protect application secrets with versioned local encryption.", href: "#/secrets-manager/secrets" },
    { key: "apigateway", cls: "api", name: "API Gateway", label: "APIs", count: summary.counts.apis, text: "Create, publish, and invoke REST APIs.", href: "#/apigateway/apis" },
    { key: "appsync", cls: "appsync", name: "AppSync", label: "GraphQL APIs", count: appSyncCount, text: "Build API-key GraphQL APIs with VTL and DynamoDB.", href: "#/appsync/apis" },
    { key: "step-functions", cls: "step-functions", name: "Step Functions", label: "State machines", count: summary.counts.stateMachines ?? 0, text: "Build and inspect durable Standard Workflow orchestration.", href: "#/step-functions/state-machines" },
    { key: "cloudwatch", cls: "cw", name: "CloudWatch", label: "Log groups", count: summary.counts.logGroups ?? 0, text: "Collect and inspect logs from local services.", href: "#/cloudwatch/log-groups" },
    { key: "iam", cls: "iam", name: "IAM", label: "Roles", count: summary.counts.roles ?? 0, text: "Manage roles and policies for local authorization.", href: "#/iam/roles" },
    { key: "cloudformation", cls: "cfn", name: "CloudFormation", label: "Stacks", count: summary.counts.stacks ?? 0, text: "Inspect infrastructure deployed locally with CloudFormation and the CDK.", href: "#/cloudformation/stacks" },
  ];
  const configuredServices = new Set(services.map(service => service.key));
  Object.values(context.serviceMeta ?? {}).forEach(service => {
    if (service.key === "home" || configuredServices.has(service.key)) return;
    const firstLink = service.links?.find(link => !link[2]);
    if (!firstLink) return;
    services.push({
      key: service.key,
      cls: service.cls,
      name: service.name,
      label: "Resources",
      count: undefined,
      text: `Open the local ${service.name} console.`,
      href: firstLink[1],
      icon: service.icon,
    });
  });
  services.forEach(service => { service.icon ??= serviceIcon(service.cls); });
  context.setHomeServices(services);
  const recoveryWarning = environment.recoveryRootEnabled ? '<div class="alert warning"><strong>Recovery root is enabled</strong><br>The configured simulator-side credential pair currently resolves to account root for lockout repair. Disable recovery root and restart after access is restored; ordinary work should use IAM policies.</div>' : "";
  context.main.innerHTML = `<div class="page-width home-page">${pageHeader("Console Home", `Local account ${escapeHtml(summary.accountId)} · ${escapeHtml(summary.region)}`)}${recoveryWarning}<div class="alert info learning-banner"><strong>Local learning environment</strong><br>This console controls services running on your machine. Authentication mode is <strong>${escapeHtml(environment.authMode)}</strong>; billing is not simulated. Fresh installations sign in with access key ID <span class="mono">admin</span> and secret access key <span class="mono">password</span> as IAM <span class="mono">user/admin</span>, then offer a one-time key rotation. The reduced CDK bootstrap is created automatically unless explicitly disabled.</div><div class="dashboard-grid" data-service-dashboard></div><div class="card" style="margin-top:22px"><div class="card-header"><h2>Local environment</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>SDK endpoint</dt><dd class="mono">${escapeHtml(summary.endpoint)}</dd></dl><dl class="key-value"><dt>API invoke endpoint</dt><dd class="mono">${escapeHtml(summary.invokeEndpoint)}</dd></dl><dl class="key-value"><dt>Region</dt><dd>${escapeHtml(summary.region)}</dd></dl></div></div></div>`;
  renderServiceDashboards(context.main.querySelector("[data-service-dashboard]"), services);
}

async function environmentPage() {
  context.setChrome("home", ["Local environment"]);
  const environment = ui.environment = await rest("/_stacksim/api/environment");
  const services = Object.entries(environment.services).map(([name, status]) => `<tr><td>${escapeHtml(name)}</td><td><span class="status ${status === "available" ? "" : "muted"}">${escapeHtml(status)}</span></td></tr>`).join("");
  const recoveryWarning = environment.recoveryRootEnabled ? '<div class="alert warning"><strong>Recovery root is enabled</strong><br>Use this mode only to repair IAM or resource-policy lockout, then disable it and restart. It does not grant service-internal shortcuts.</div>' : "";
  context.main.innerHTML = `<div class="page-width">${pageHeader("Local environment", "Configuration and health for this StackSim installation.")}${recoveryWarning}<div class="card"><div class="card-header"><h2>Environment details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Account ID</dt><dd class="mono">${escapeHtml(environment.accountId)}</dd><dt>Installation ID</dt><dd class="mono">${escapeHtml(environment.installationId)}</dd><dt>Default principal</dt><dd class="mono">${escapeHtml(environment.defaultPrincipalArn ?? "Unavailable")}</dd></dl><dl class="key-value"><dt>Selected region</dt><dd>${escapeHtml(environment.region)}</dd><dt>Configured regions</dt><dd>${environment.regions.map(escapeHtml).join(", ")}</dd><dt>Credential mode</dt><dd>${escapeHtml(environment.configuredCredentialMode)}</dd></dl><dl class="key-value"><dt>Authentication mode</dt><dd>${escapeHtml(environment.authMode)}</dd><dt>State schema</dt><dd>v${environment.schemaVersion}</dd><dt>Reduced CDK bootstrap</dt><dd>${escapeHtml(environment.cdkBootstrap?.status ?? "unknown")}</dd></dl></div><div class="card-body"><dl class="key-value"><dt>State path</dt><dd class="mono">${escapeHtml(environment.statePath)}</dd></dl></div></div><div class="card"><div class="card-header"><h2>Service health</h2></div><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th></tr></thead><tbody>${services}</tbody></table></div></div></div>`;
}

export async function routeHome(parts, nextContext) {
  context = nextContext;
  if (parts[0] === "home" && parts.length === 1) return home();
  if (parts[0] === "environment" && parts.length === 1) return environmentPage();
  return context.notFound(parts);
}
