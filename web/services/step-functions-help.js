import { panelHeading } from "../components.js";

const help = {
  catalog: {
    level: "Partial",
    description: "A state machine is a durable workflow definition that coordinates steps, decisions, waits, parallel work, and supported service tasks. Use this catalog to find workflows in the current account and Region, then open one to inspect its definition, executions, role, and tags.",
    support: "Standard JSONPath lifecycle, optimized Lambda, DynamoDB, SQS, SNS, EventBridge and nested-workflow integrations, callbacks, Activities, signed pagination, IAM authorization, tags, durable executions, metrics, and status events are active. Express workflows, JSONata, versions, aliases, redrive, customer KMS keys, active logging, X-Ray, AWS SDK integrations, and HTTP tasks are unavailable.",
  },
  configuration: {
    level: "Partial",
    description: "Workflow configuration gives the state machine its stable name, execution role, States Language definition, and organizational tags. Use the local visual editor to add Pass, Task, Choice, Wait, Parallel, Map, Succeed, and Fail states, or switch to JSON for the full document. The role is assumed by Step Functions when a Task invokes Lambda.",
    support: "Standard JSONPath definitions, local visual authoring with JSON round-trip, shared validation, iam:PassRole and states.amazonaws.com trust checks, control flow, common optimized integrations, callbacks, nested workflows, Activities, tags, and durable creation are active. Full AWS Workflow Studio parity, Express, JSONata, Distributed Map, unlisted integrations, publishing, logging, tracing, and KMS settings are unavailable.",
  },
  definitionAndRole: {
    level: "Supported locally",
    description: "The definition is the executable States Language document, editable visually or as JSON, and the execution role supplies permissions for supported Task states. Validate before saving to catch invalid transitions, paths, retry rules, unsupported fields, or inaccessible resources; an update affects only executions started afterward.",
    support: "Local visual editor, JSON round-trip, strict validation and updates for the active Standard JSONPath integration surface, role trust and pass-role checks, revision IDs, related-resource links, callback/activity recovery, and restart persistence are active. Existing executions keep immutable definition and role snapshots; this editor does not publish versions or claim full AWS Workflow Studio, JSONata, Express, logging, X-Ray, KMS, AWS SDK integrations, or HTTP tasks.",
  },
  definition: {
    level: "Supported locally",
    description: "The definition graph is a read-only view of the saved States Language document and its transitions. Open the JSON to inspect exact configuration or choose Edit definition for the local visual editor and JSON authoring used by future executions; running and completed executions remain pinned to the revision with which they started.",
    support: "Graph rendering, nested Parallel/Map processors, integration related-resource links, callback-wait resources, retry/catch details, exact JSON display, validation, revisions, and immutable execution snapshots are active. Authoring happens on the Edit page; full AWS Workflow Studio parity, JSONata, Distributed Map, AWS SDK integrations, HTTP tasks, and unlisted service tasks are unavailable.",
  },
  executions: {
    level: "Supported locally",
    description: "An execution is one run of a state machine. Starting one supplies an optional unique name and a JSON input document; Step Functions captures that input together with the current definition, role, and revision, then records each transition until the run succeeds, fails, times out, or is stopped.",
    support: "Durable Standard starts and stops, immutable snapshots, 256 KiB payload limits, execution-name idempotency, waits, retries, catches, Lambda tasks, Parallel and Inline Map work, typed history, pagination, 90-day default retention, metrics, status events, and restart recovery are active. Redrive, aliases and versions, Express synchronous starts, and production-scale quotas are unavailable.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing state machines by application, environment, owner, or another convention. Editing this panel adds or updates the keys you provide and removes keys deleted from the JSON object.",
    support: "Create-time tags, list, add, replace and remove operations, validation, IAM enforcement, persistence, and supported CloudFormation behavior are active. AWS billing allocation, Organizations tag policies, and external governance are outside StackSim.",
  },
  inspection: {
    level: "Supported locally",
    description: "Execution inspection connects the workflow graph to the states and events observed during this run. Switch views to follow the active path, inspect state configuration, or filter and search typed history; selecting a state or event reveals its linkage, retry information, and recorded input or output.",
    support: "Complete paginated history retrieval, graph/state/event views, nested branch and iteration summaries, filters, search, ordering, bounded browser pagination, typed event details, payload omission labels, retry and failure timelines, and live bounded refresh are active. This is retained Standard history rather than CloudWatch Logs, and no unavailable logging, X-Ray, Express, redrive, or Distributed Map behavior is inferred.",
  },
};

const targets = [
  ['.sfn-page .card:has([data-filter-table])', "State machine catalog", "catalog"],
  ['.sfn-page .card:has(#sfn-create)', "Workflow configuration", "configuration"],
  ['.sfn-page .card:has(#sfn-edit)', "Definition and role", "definitionAndRole"],
  [".sfn-detail .card", "Definition", "definition"],
  [".sfn-detail .card", "Executions", "executions"],
  [".sfn-detail .card", "Tags", "tags"],
  [".sfn-detail .sfn-inspection", "Execution inspection", "inspection"],
];

export function decorateStepFunctionsPanelHelp(root = document) {
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
