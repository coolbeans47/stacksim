import { panelHeading } from "../components.js";

const help = {
  topics: {
    level: "Partial",
    description: "A topic is a named channel that accepts a message once and fans it out to every matching subscription. Create a topic when publishers should not need to know which queues or functions consume their events, then use the name, display name, signature version, and tags to identify and organize that channel.",
    support: "Standard-topic lifecycle, display names, signatures, tags, topic policies, publishing and batch publishing, durable local acceptance, metrics, and supported CloudFormation resources are active. FIFO topics, customer KMS keys, active tracing, Firehose, mobile, SMS, email, and HTTP/S delivery are unavailable.",
  },
  topicDetails: {
    level: "Partial",
    description: "Topic details describe the stable channel applications publish to. Configure controls who may publish, which local signature version is recorded, and where SQS or Lambda delivery feedback is logged; Publish message supplies the body, optional subject, routing attributes, and protocol-specific content sent through the topic.",
    support: "Topic policies and IAM checks, durable Publish and PublishBatch acceptance, protocol-specific JSON, message attributes, installation-local signatures, feedback sampling, managed retry, redacted logs, and AWS/SNS metrics are active. Acceptance means SNS stored the message for asynchronous fan-out, not that every subscriber completed; internal encrypted storage is not AWS KMS encryption.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for grouping topics by application, environment, owner, or another convention. They are useful when automation needs stable metadata that is independent of the topic name and its subscriptions.",
    support: "Creating, listing, adding, replacing, and removing topic tags, validation, pagination, restart persistence, compatible SDK operations, and supported CloudFormation behavior are active. AWS billing allocation, Organizations tag policies, and cross-account governance are outside StackSim.",
  },
  subscriptions: {
    level: "Partial",
    description: "A subscription connects this topic to one destination so matching messages can be delivered there. Choose an endpoint, optionally filter on message attributes or JSON body fields, use raw SQS delivery when the queue should receive only the original body, and select a dead-letter queue to retain messages that exhaust delivery attempts.",
    support: "Confirmed same-account, same-Region SQS and Lambda endpoints, endpoint-policy checks, filtering, raw SQS delivery, managed retry, Standard SQS dead-letter queues, feedback logs, metrics, and durable delivery across restarts are active. HTTP/S, email, SMS, mobile, Firehose, confirmation workflows, and custom delivery policies are unavailable.",
  },
  subscriptionCatalog: {
    level: "Partial",
    description: "A subscription is the connection from a topic to one consumer. Use this catalog to find the topic, protocol, and endpoint for existing subscriptions; open the linked topic when you need to create a subscription or change its filter, raw-delivery, and dead-letter queue settings.",
    support: "Confirmed same-account, same-Region SQS and Lambda subscriptions, filtering, raw SQS delivery, managed retry, Standard SQS dead-letter queues, metrics, feedback logs, pagination, and restart persistence are active. HTTP/S, email, SMS, mobile, Firehose, cross-account endpoints, and confirmation workflows are unavailable.",
  },
};

const targets = [
  ['.page-width:has([data-create-sns-topic]) .card:has([data-filter-table])', "Topics", "topics"],
  [".sns-detail .card", "Topic details", "topicDetails"],
  [".sns-detail .card", "Tags", "tags"],
  [".sns-detail .card", "Subscriptions", "subscriptions"],
  ['.page-width:not(.sns-detail) .card:has([data-filter-table])', "Subscriptions", "subscriptionCatalog"],
];

export function decorateSnsPanelHelp(root = document) {
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
