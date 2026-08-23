import { panelHeading } from "../components.js";

const help = {
  traces: {
    level: "Supported locally",
    description: "Traces join a request's stage segment and attempted downstream work under one trace ID. Use status and duration to find slow or failed local requests.",
    support: "The first 100 retained traces are shown for the selected Region. XRY-01 supports API Gateway stage tracing and explicitly supplied trace segments; groups, insights, sampling-rule management, and analytics are unavailable.",
  },
  trace: {
    level: "Supported locally",
    description: "A trace contains one or more segments. API Gateway records the stage request and adds an integration subsegment only after a backend attempt begins.",
    support: "Segment documents are decrypted only for this request, redacted on the server, escaped in the browser, and never placed in URLs or browser storage.",
  },
  graph: {
    level: "Partial",
    description: "The service map aggregates retained trace segments into services and directed downstream edges for the selected time window.",
    support: "Service and trace graphs are available. X-Ray groups, inferred remote nodes, insights, and AWS-hosted map integrations are outside XRY-01.",
  },
  repository: {
    level: "Supported locally",
    description: "Repository diagnostics describe the encrypted regional trace database, retention cleanup, rejected documents, and current capacity state.",
    support: "Trace documents use authenticated encryption in a dedicated SQLite repository. Keep the database and its installation key together in a stopped backup.",
  },
};

const targets = [
  ['.card[data-xray-panel="traces"]', "Retained traces", "traces"],
  ['.card[data-xray-panel="trace"]', "Segments", "trace"],
  ['.card[data-xray-panel="graph"]', "Services", "graph"],
  ['.card[data-xray-panel="repository"]', "Repository", "repository"],
];

export function decorateXRayPanelHelp(root = document) {
  for (const [selector, title, key] of targets) {
    const heading = root.querySelector(`${selector} > .card-header h2`);
    if (!heading || heading.closest(".panel-title-row")) continue;
    const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
    heading.outerHTML = panelHeading(title, help[key], meta);
  }
}
