import { panelHeading } from "../components.js";

const help = {
  eventBuses: {
    level: "Partial",
    description: "An event bus is a regional router that receives events and evaluates them against enabled rules. Use a custom bus to separate one application's events from the default bus; ordinary accepted events are routed immediately rather than retained as a browsable history.",
    support: "The default bus, custom-bus lifecycle, descriptions, tags, PutEvents ingestion, rule matching, explicit encrypted local archives, and durable target handoff are active locally. Partner sources, resource policies, cross-account routing, customer-managed KMS, bus DLQs, and execution logging are unavailable.",
  },
  busDetails: {
    level: "Partial",
    description: "Bus details identify the router on which rules receive events. The related-rules panel is where you add routing logic, while the Sandbox publishes development events to exercise that configuration.",
    support: "Custom bus creation and deletion, the undeletable regional default bus, descriptions, tags, rules, ingestion, local routing, and explicitly configured archives persist. Event payloads are not retained by ordinary routing unless an explicit archive captures them; unsupported AWS bus-level dependencies are not fabricated.",
  },
  rules: {
    level: "Partial",
    description: "A rule uses an event pattern, a default-bus legacy schedule expression, or both, and sends each trigger to as many as five targets. Create one when selected events or schedule occurrences should invoke code, enqueue work, write logs, or call an API.",
    support: "Event-pattern rules, default-bus legacy scheduled rules, pattern testing, enabled and disabled state, descriptions, tags, up to five independent targets, metrics, and durable delivery are active. EventBridge Scheduler is recommended for new time-driven work.",
  },
  ruleDetails: {
    level: "Partial",
    description: "Rule details control whether triggering is active and which event bus supplies events. Edit the rule to change its description, JSON pattern, or default-bus legacy schedule; target delivery and authorization are configured separately so each destination can retry independently.",
    support: "Replacement-style edits, state changes, event patterns, default-bus legacy schedules, tags, target associations, deletion safeguards, and local service metrics are active. Unsupported cross-account buses and target services remain explicit dependency boundaries.",
  },
  eventPattern: {
    level: "Supported locally",
    description: "An event pattern is a JSON filter over fields such as source, detail-type, resources, and detail. Keep it narrow enough to select the events your target understands, and test it against a representative complete event before enabling automation.",
    support: "Pattern validation, matching, nested objects, arrays, supported comparison operators, rule evaluation, and the sample-event tester run locally. Unsupported pattern syntax is rejected rather than silently treated as a match.",
  },
  targets: {
    level: "Supported integrations",
    description: "A target receives every event that matches a rule. Its input mode can pass the original event, select a JSON path, use constant JSON, or transform fields; retry age, attempt count, authorization, and a DLQ define failure handling per target.",
    support: "Lambda, same-Region Standard SQS, CloudWatch Logs, API Gateway, and Standard Step Functions targets, input transformations, target parameters, execution roles or resource policies, independent durable retries, and Standard SQS DLQs are active. Step Functions success means durable StartExecution admission. Other target types and cross-account delivery are unavailable.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing an event bus or rule by environment, owner, application, or another convention. Manage them when people, scripts, or IAM policies need consistent metadata for finding and grouping routing resources.",
    support: "Tag creation, replacement, removal, validation, listing, and persistence are active for supported EventBridge buses and rules. AWS billing allocation, Organizations tag policies, and cross-account governance are outside StackSim.",
  },
  testPattern: {
    level: "Supported locally",
    description: "The pattern tester checks whether one complete sample event matches a JSON event pattern without publishing it. Use it while designing a rule to catch field-name, nesting, or value mistakes before any target can run.",
    support: "The tester uses the same local validation and matching engine as active rules and returns a deterministic match result. It does not store the sample, invoke targets, or claim support for pattern operators outside the implemented subset.",
  },
  sendEvents: {
    level: "Supported locally",
    description: "Send events publishes up to ten custom entries to selected buses. Each entry supplies a source, detail type, JSON detail, and optional resources; use it to exercise rules and targets without first building an event-producing application.",
    support: "Ordered per-entry validation and results, generated event IDs, archive-before-ack capture, enabled-rule evaluation, durable target handoff, metrics, retries, and DLQs are active. Only explicitly archived events are retained, and PutEvents does not route to remote AWS accounts.",
  },
  archives: {
    level: "Supported locally",
    description: "An archive retains ordinary events from one source bus independently of rule and target outcomes. Use a pattern and retention period to bound recovery data, then replay after fixing a consumer.",
    support: "Encrypted atomic segments, shared pattern tests, indefinite or finite retention, committed counts/bytes, restart repair, exact deletion, and fail-closed customer-managed KMS are active. Counts and timing are labeled development-grade.",
  },
  replays: {
    level: "Supported locally",
    description: "A replay selects an archive event-time range and optionally enabled destination rules on the source bus. Replayed envelopes add replay-name and are excluded from every archive.",
    support: "Source-bus and selected-rule routing, deterministic event-time/minute order, durable leases/checkpoints, at-least-once restart, progress, cancellation, diagnostics, and 90-day history are active without inventing AWS metrics.",
  },
  schedules: {
    level: "Supported integrations",
    description: "A schedule invokes one target at a particular time or recurring rate. Use at for one-time work, rate for a fixed interval, or cron for calendar-based timing; time zones, date bounds, and flexible windows refine when invocation may occur.",
    support: "One-time, rate, and six-field cron expressions, IANA time zones and daylight-saving behavior, start and end dates, flexible windows, durable checkpoints, retries, execution roles, Standard SQS DLQs, and completion deletion are active. Supported targets are Lambda, SQS, Step Functions, and EventBridge buses.",
  },
  scheduleDetails: {
    level: "Supported integrations",
    description: "Schedule details combine timing, state, target input, authorization, and failure handling. Edit them when the cadence, time zone, delivery window, target, retry policy, or post-completion behavior should change.",
    support: "Full local create, read, update, delete, enablement, next-run calculation, pending and last-delivery diagnostics, execution-role enforcement, retries, and supported target invocation are active and durable across restarts.",
  },
  scheduleGroups: {
    level: "Supported locally",
    description: "A schedule group organizes related schedules and carries group-level tags. Use separate groups for an application, environment, or ownership boundary when one flat schedule catalog would be difficult to manage.",
    support: "The default group, custom-group lifecycle, tags, grouped listing, schedule counts, and cascading asynchronous deletion persist locally. Group tags apply only to the group and are not inherited by schedules.",
  },
};

const targets = [
  [".eventbridge-page > .card", "Event buses", "eventBuses"],
  [".eventbridge-detail .card", "Bus details", "busDetails"],
  [".eventbridge-detail .card", "Related rules", "rules"],
  [".eventbridge-page > .card", "Rules", "rules"],
  [".eventbridge-detail .card", "Rule details", "ruleDetails"],
  [".eventbridge-detail .card", "Event pattern", "eventPattern"],
  [".eventbridge-detail .card", "Targets", "targets"],
  [".eventbridge-detail .card", "Tags", "tags"],
  [".eventbridge-sandbox-grid > .card", "Test event pattern", "testPattern"],
  [".eventbridge-sandbox-grid > .card", "Send events", "sendEvents"],
  [".eventbridge-page > .card", "Archives", "archives"],
  [".eventbridge-page > .card", "Archive details", "archives"],
  [".eventbridge-page > .card", "Replays", "replays"],
  [".eventbridge-page > .card", "Replay details", "replays"],
  [".eventbridge-page > .card", "Schedules", "schedules"],
  [".eventbridge-page > .card", "Schedule details", "scheduleDetails"],
  [".eventbridge-page > .card", "Schedule groups", "scheduleGroups"],
  [".eventbridge-page > .card", "Group details", "scheduleGroups"],
];

export function decorateEventBridgePanelHelp(root = document) {
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
