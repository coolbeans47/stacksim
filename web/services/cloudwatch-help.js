import { panelHeading } from "../components.js";

const help = {
  alarms: {
    level: "Partial",
    description: "An alarm watches a metric, scheduled log query, or combination of other alarms and changes state when its condition is met. Use alarms to turn telemetry into a durable signal that can notify code, suppress downstream actions during maintenance, or summarize service health.",
    support: "Static, metric-math, anomaly, composite, and scheduled-log alarm evaluation, M-of-N conditions, missing-data handling, history, tags, and Lambda actions are active locally. SNS, Auto Scaling, SSM, and EC2 action ARNs are retained with an explicit unavailable-dependency result instead of being delivered.",
  },
  alarmConfiguration: {
    level: "Partial",
    description: "Alarm configuration records what is observed, how often it is evaluated, the threshold or rule that changes state, and which actions run. Edit it when the signal, sensitivity, evaluation window, or response should change.",
    support: "The displayed metric, rule, scheduled query, evaluation settings, action state, contributors, suppression, history, and tags persist and are evaluated locally. Action delivery is limited to supported local Lambda targets; unavailable service targets are recorded as dependency-blocked.",
  },
  muteRules: {
    level: "Supported locally",
    description: "A mute rule schedules a maintenance window during which selected alarms continue evaluating but do not run their actions. Use one to avoid expected notifications or automation while a deployment, repair, or recurring task is in progress.",
    support: "One-time and cron schedules, IANA time zones, ISO-8601 durations, date bounds, alarm targets, status filters, tags, and action suppression are active and durable. Deleting an active rule replays eligible actions for targeted alarms that are still in ALARM.",
  },
  dashboards: {
    level: "Partial",
    description: "A dashboard combines metrics, log queries, alarm status, explanatory text, and variables into one operational view. Create one when a team needs a repeatable overview for a service, investigation, or learning exercise.",
    support: "Dashboard lifecycle, 24-column layouts, variables, text, metric, alarm, Logs Insights, and supported metrics-explorer widgets render from local telemetry. GetMetricWidgetImage and unsupported AWS widget properties do not have a fabricated rendering path.",
  },
  metricExplorer: {
    level: "Supported locally",
    description: "The metric explorer is the catalog of available time-series identities. Filter by namespace, search by metric or dimension, and select series to compare values or add a metric widget to a dashboard.",
    support: "Custom metrics and telemetry emitted by supported StackSim services are listed with their namespaces and dimensions. Selection, filtering, GetMetricData graphing, statistics, periods, time ranges, and dashboard handoff use durable local metric data.",
  },
  selectedMetrics: {
    level: "Supported locally",
    description: "This panel graphs the metrics selected in the explorer. The range, period, statistic, and axis controls determine which datapoints are aggregated and how the resulting series are displayed; Source shows the equivalent request.",
    support: "Local GetMetricData queries, standard statistics, supported percentiles, retention roll-ups, multiple series, graph display, and generated request source are active. The chart reads stored StackSim telemetry and never substitutes sample values.",
  },
  metricsInsights: {
    level: "Partial",
    description: "Metrics Insights uses SQL-like syntax to aggregate and group many related metric series without selecting each one individually. Build or edit a query when you need questions such as the busiest hosts, largest error totals, or grouped service trends.",
    support: "A bounded Metrics Insights SQL subset supports metric selection, aggregates, filters, grouping, ordering, limits, recent time ranges, multi-series results, and the default dataset descriptor. Queries are limited to the most recent three hours and do not provide the full AWS grammar or cross-account data.",
  },
  metricStreams: {
    level: "Partial",
    description: "A metric stream continuously forwards selected metric updates to another system. Filters choose which namespaces or metrics leave CloudWatch, while the output format and additional statistics define the records a destination receives.",
    support: "Lifecycle, include or exclude filters, tags, JSON/OpenTelemetry descriptors, and percentile additional statistics persist locally. Real delivery requires STACKSIM_ALLOW_LOCAL_FILES=true, JSON output, and an absolute file:// directory; Firehose, S3, KMS, IAM, and linked-account delivery remain unavailable dependencies.",
  },
  streamOverview: {
    level: "Partial",
    description: "The stream overview identifies the destination, delivery role descriptor, output format, state, and most recent configuration change. Edit these settings when the receiving system or the set of exported metric records needs to change.",
    support: "Configuration, running and stopped state, filters, tags, and opted-in local JSON delivery are durable. AWS Firehose and OpenTelemetry transport are represented but dependency-blocked; no external IAM role or AWS destination is contacted.",
  },
  streamFilters: {
    level: "Supported locally",
    description: "Metric stream filters narrow delivery to selected namespaces and optional metric names, or exclude selected identities from an otherwise complete stream. Use them to reduce noise and avoid exporting telemetry a consumer does not need.",
    support: "Include and exclude filters are validated, normalized, displayed, and applied to opted-in local JSON stream delivery. Linked-account metrics are unavailable in StackSim's single-account model.",
  },
  additionalStatistics: {
    level: "Partial",
    description: "Additional statistics add calculated values beyond the default minimum, maximum, sum, and sample count for selected streamed metrics. They are useful when a downstream consumer needs a percentile such as p90 or p99.",
    support: "Percentile configurations such as p90 and p99.9 are validated and included in supported local JSON delivery. Other AWS additional-statistic families and external OpenTelemetry or Firehose delivery are not executed locally.",
  },
  insightRules: {
    level: "Partial",
    description: "A Contributor Insights rule extracts high-cardinality keys from logs or supported service telemetry and ranks the values contributing most to an aggregate. Use rules to find hot keys, noisy callers, slow routes, or other concentrated sources of load.",
    support: "Custom CloudWatchLogRule definitions and managed DynamoDB templates, lifecycle, tags, filters, durable telemetry, and reports are active. Cross-account log groups, PrivateLink managed templates, and the complete AWS rule surface are unavailable.",
  },
  insightReport: {
    level: "Partial",
    description: "A rule report ranks contributors for a chosen time range, period, ordering statistic, and result limit. Adjust these controls to compare the largest contributors, total activity, or uniqueness over a useful investigation window.",
    support: "Reports over collected local log and DynamoDB telemetry provide supported aggregates, top contributors, charts, tables, and request source. Values are deterministic local approximations and no AWS-managed telemetry is queried.",
  },
  insightDefinition: {
    level: "Partial",
    description: "The rule definition describes the source logs or managed resource, fields that identify a contributor, optional filters and value extraction, and how matching events are aggregated. Edit a custom definition when the operational question changes.",
    support: "Bounded JSON and CLF custom definitions plus managed DynamoDB templates are validated and evaluated locally. Log transformers are unavailable, so rules normally consume original segmented events; cross-account sources are rejected explicitly.",
  },
  logsInsights: {
    level: "Partial",
    description: "The Logs Insights editor searches one or more log groups over a selected time range. Use the query language to select fields, filter events, sort records, calculate statistics, and inspect the original record behind a result.",
    support: "The generated CloudWatch Logs Insights QL core subset, bounded jobs, cancellation, partial and final results, pointers, visualizations, CSV export, and query history are active. PPL and SQL definitions can be stored but are not executed, and the full AWS command and function catalog is unavailable.",
  },
  savedQueries: {
    level: "Supported locally",
    description: "Saved queries retain useful query text and its selected log groups so it can be loaded again without rebuilding an investigation. Parameterized definitions let a reusable query ask for values when it is opened.",
    support: "Create, update, list, load, delete, language metadata, selected log groups, and StackSim query parameters persist locally. CWLI definitions execute through the supported subset; saved PPL and SQL definitions remain non-executable metadata.",
  },
  logGroups: {
    level: "Supported locally",
    description: "A log group is the durable container for related log streams, usually one application or service. Create one to choose a retention policy and give producers a common destination for events that should be searched, filtered, or exported together.",
    support: "Log-group lifecycle, retention, tags, streams, segmented events, filtering, pagination, metrics, subscriptions, queries, and supported resource policies are active locally. KMS encryption, log classes, field indexes, and cross-account observability are outside this console flow.",
  },
  logGroupDetails: {
    level: "Supported locally",
    description: "Log group details summarize storage and retention for the container. Retention determines how long events remain available, while streams separate events from individual producers or execution instances.",
    support: "Creation time, stored bytes, retention updates and expiry, stream lifecycle, related local resources, and deletion are backed by durable StackSim state. No AWS storage tier, KMS key, or remote account is created.",
  },
  logStreams: {
    level: "Supported locally",
    description: "A log stream is an ordered sequence of events from one producer within a log group, such as a Lambda execution environment or application instance. Create separate streams when producers need distinct identities while remaining searchable together.",
    support: "Stream creation, event ingestion, ordering, timestamps, pagination, filtering, and deep links are active on durable local events. StackSim accepts the compatible API without contacting the CloudWatch Logs service.",
  },
  logMetricFilters: {
    level: "Supported locally",
    description: "A metric filter matches incoming log events and publishes a numeric CloudWatch metric. Use one when a text or JSON pattern—such as an error, route, or status—should become a graphable value or alarm signal.",
    support: "Pattern testing, JSON and space-delimited matching, values, defaults, units, and up to three extracted dimensions publish through StackSim's durable metric path. The supported pattern subset is validated explicitly rather than silently treated as AWS-complete.",
  },
  subscriptionFilters: {
    level: "Partial",
    description: "A subscription filter continuously sends matching log events to another processor. Use it when a Lambda function should react to log batches in near real time, for example to enrich, audit, or route selected events.",
    support: "Up to two filters per group, pattern matching, same-Region Lambda destinations, permission checks, durable checkpoints, asynchronous retries, and recursion protection are active. Kinesis, Firehose, cross-account destinations, and transformed-log delivery are unavailable.",
  },
  resourcePolicy: {
    level: "Partial",
    description: "A log-group resource policy grants an AWS service permission to write events to this specific group. Configure one when a supported producer such as EventBridge needs an explicit destination-side allow statement.",
    support: "Resource-scoped policy names, JSON documents, revisions, persistence, deletion, and supported local service-principal authorization are active. Account-wide policy management, cross-account delivery, Organizations conditions, and external AWS services are not contacted.",
  },
  exports: {
    level: "Local extension",
    description: "An export task copies events from a bounded time range, optionally limited to a stream-name prefix, into durable files for offline inspection. Use it when a local tool needs a snapshot rather than an interactive Logs Insights query.",
    support: "Task lifecycle, time bounds, prefix filtering, status, cancellation, and gzip output work only when local files are explicitly enabled and the destination is a safe absolute file:// directory. S3 delivery and its IAM or KMS dependencies are unavailable.",
  },
  anomalyDetectors: {
    level: "Partial",
    description: "An anomaly detector learns an expected-value band for a metric or metric-math expression instead of relying on one fixed threshold. Configure one when normal behavior changes by time or season and an alarm should focus on unusual values.",
    support: "Single-metric and metric-math identities, time zones, excluded training ranges, periodic-spike hints, state, previews, and anomaly alarms are active. Bands use a bounded deterministic median/MAD model for repeatable learning and are not production CloudWatch machine-learning output.",
  },
  detectorConfiguration: {
    level: "Partial",
    description: "Detector configuration records the metric source and the training rules that shape its expected band. Excluded ranges remove known incidents or deployments from training, while the time zone aligns recurring local-time behavior.",
    support: "Source identity, deterministic training state, IANA time zones, exclusions, periodic-spike widening, preview queries, editing, and deletion persist locally. Retraining is simulated and the resulting band does not claim parity with AWS's production model.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels used to organize CloudWatch resources by environment, owner, service, or another convention. Manage them when people or local tooling need consistent metadata for finding and grouping resources.",
    support: "Tags on supported alarms, mute rules, metric streams, Contributor Insights rules, and log groups are validated, stored, listed, replaced, and removed locally. AWS billing allocation, Organizations tag policies, and cross-account governance are outside StackSim.",
  },
};

const targets = [
  [".card", "Alarms", "alarms"],
  [".card", "Scheduled log query", "alarmConfiguration"],
  [".card", "Alarm rule", "alarmConfiguration"],
  [".card", "Alarm details", "alarmConfiguration"],
  [".card", "Mute rules", "muteRules"],
  [".card", "Schedule", "muteRules"],
  [".card", "Target alarms", "muteRules"],
  [".card", "Custom dashboards", "dashboards"],
  [".card", "Metric explorer", "metricExplorer"],
  [".card", "Selected metrics graph", "selectedMetrics"],
  [".metrics-insights-page .card", "Query editor", "metricsInsights"],
  [".card", "Metric streams", "metricStreams"],
  [".metric-stream-detail .card", "Overview", "streamOverview"],
  [".metric-stream-detail .card", "Metric filters", "streamFilters"],
  [".metric-stream-detail .card", "Additional statistics", "additionalStatistics"],
  [".card", "Insight rules", "insightRules"],
  [".card", "Rule report", "insightReport"],
  [".card", "Rule definition", "insightDefinition"],
  [".card", "Rule details", "insightDefinition"],
  [".insights-workbench", "Query editor", "logsInsights"],
  ["#insights-saved", "Saved queries", "savedQueries"],
  [".card", "Log groups", "logGroups"],
  [".card", "Log group details", "logGroupDetails"],
  [".card", "Log streams", "logStreams"],
  [".page-width:has(.tabs) > .card", "Metric filters", "logMetricFilters"],
  [".card", "Subscription filters", "subscriptionFilters"],
  [".log-resource-policy-card", "Resource policy", "resourcePolicy"],
  [".card", "Export tasks", "exports"],
  [".card", "Anomaly detectors", "anomalyDetectors"],
  [".card", "Excluded training ranges", "detectorConfiguration"],
  [".card", "Detector details", "detectorConfiguration"],
  [".card", "Tags", "tags"],
];

export function decorateCloudWatchPanelHelp(root = document) {
  for (const [selector, title, helpKey] of targets) {
    for (const panel of root.querySelectorAll(selector)) {
      const heading = panel.querySelector(":scope > .card-header h2");
      if (!heading || heading.closest(".panel-title-row")) continue;
      const text = heading.textContent.trim();
      if (text !== title && !text.startsWith(`${title} (`)) continue;
      const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
      heading.outerHTML = panelHeading(title, help[helpKey], meta);
    }
  }
}
