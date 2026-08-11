import { panelHeading } from "../components.js";

const help = {
  queues: {
    level: "Partial",
    description: "A queue holds messages until a consumer receives and deletes them, letting producers and workers run independently. Create a Standard queue for high-throughput, at-least-once work or a FIFO queue when messages in the same group must remain ordered and duplicate sends need a deduplication window.",
    support: "Standard and FIFO lifecycle, queue attributes, tags, delays, retention, visibility leases, long polling, batches, policies, SSE-SQS, dead-letter queues, durable messages, metrics, and supported CloudFormation resources are active locally. Production distributed throughput and quotas, customer KMS keys, networking and billing behavior, and the S3 extended client are unavailable.",
  },
  configuration: {
    level: "Supported locally",
    description: "Queue configuration controls when messages become visible, how long consumers have to process them, how long unprocessed messages are retained, the largest accepted payload, and how long receive calls wait for work. Set the visibility timeout longer than normal processing time so another worker does not receive the same message too early.",
    support: "Validation, updates, delayed availability, retention expiry, per-receive visibility leases, long polling, maximum-size enforcement, persistence, and compatible SDK reads are active. Queue type is immutable, Standard delivery remains at least once, and local timing does not reproduce production-scale throughput or network latency.",
  },
  fifo: {
    level: "Supported locally",
    description: "FIFO configuration preserves order separately within each message group. Content-based deduplication hashes the body when a sender omits a deduplication ID, while deduplication scope and throughput limit choose whether duplicate tracking and concurrency are organized across the queue or by message group.",
    support: "Immutable FIFO identity, strict per-group ordering, explicit and body-based five-minute deduplication, receive-attempt replay, monotonic sequence numbers, compatible FIFO dead-letter queues, Lambda group checkpoints, and restart recovery are active. StackSim does not reproduce AWS's distributed throughput capacity or service quotas.",
  },
  fairQueue: {
    level: "Local model",
    description: "A Standard fair queue uses an optional message group ID to keep one busy tenant from monopolizing delivery while quieter groups have work waiting. Add the group ID when sending messages that share a tenant or workload, but keep consumers idempotent because Standard queues still provide at-least-once delivery.",
    support: "Message-group storage, deterministic bounded-fair scheduling, delayed and in-flight group accounting, quiet/noisy group metrics, and restart recovery are active locally. The behavior is suitable for deterministic tests but does not claim AWS's internal distributed fairness algorithm, throughput, or latency.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing queues by application, environment, owner, or another convention. They can also participate in supported IAM resource-tag conditions, so changing a tag may change which local callers can use or administer the queue.",
    support: "Creating, listing, adding, replacing, and removing queue tags, validation, pagination, persistence, IAM tag conditions, and supported CloudFormation behavior are active. AWS billing allocation, Organizations tag policies, and external governance are outside StackSim.",
  },
  messages: {
    level: "Supported locally",
    description: "Send message adds a body and optional routing metadata to the queue. Polling receives up to the selected maximum, waits for the chosen long-poll duration, and hides returned messages for the visibility timeout; poll attempts repeat that bounded receive when no message is immediately available. Delete a successfully processed message or change its visibility when it needs more time or should be retried now.",
    support: "Single and batch send, receive and delete, delays, long polling, visibility changes, receipt handles, receive counts, message and system attributes, binary attribute values, FIFO metadata, MD5s, durable leases, IAM checks, and restart recovery are active. Receiving mutates queue state, Standard delivery is at least once, and the console inspection limit does not change the stored payload.",
  },
  accessPolicy: {
    level: "Supported locally",
    description: "A queue policy is a resource-based permission document that can let another account or an AWS service send to or consume from this queue. Scope service publishers such as EventBridge, S3, or SNS with the exact service principal, source ARN, and source account; an explicit Deny overrides an Allow.",
    support: "IAM and queue-policy composition, same-account and cross-account evaluation, supported principals, actions and conditions, explicit deny, owner-only administration, AddPermission and RemovePermission, policy validation, and active service-producer checks are modeled. The editor does not imply every IAM condition or every external AWS service is available.",
  },
  encryption: {
    level: "Partial",
    description: "SQS-managed server-side encryption records whether new queue writes use the SSE-SQS mode. This setting is separate from StackSim's private payload store, which always authenticates and encrypts message bodies on disk even when the queue's SSE-SQS descriptor is disabled.",
    support: "SqsManagedSseEnabled creation, updates, per-message mode metadata, durable reads across setting changes, SDK reporting, and installation-local authenticated payload encryption are active. Customer-managed KMS identifiers are validated but fail atomically as unsupported; StackSim never claims that an AWS KMS key encrypted local data.",
  },
  redrive: {
    level: "Supported locally",
    description: "A redrive policy sends a repeatedly received message to a dead-letter queue after its receive count exceeds the configured maximum. Use it to isolate poison messages that workers cannot process without blocking normal work, and choose a destination with the same Standard or FIFO queue type.",
    support: "Redrive policies, receive counting, compatible queue-type validation, durable cross-queue moves, payload and attribute preservation, FIFO group behavior, Lambda failure paths, metrics, source discovery, and restart recovery are active. StartMessageMoveTask and related managed message-move operations remain unavailable.",
  },
  redriveAllow: {
    level: "Supported locally",
    description: "A redrive allow policy belongs to the dead-letter queue and controls which source queues may target it. Allow all accepts same-account queues in this Region, deny all blocks new redrive relationships, and allow selected limits use to the listed queue ARNs.",
    support: "Allow-all, deny-all, and up to ten selected same-account source queues, relationship validation, source discovery, Standard/FIFO compatibility, authorization, and persistence are active. It does not grant unrelated queue API access or enable cross-Region redrive.",
  },
  lambdaTriggers: {
    level: "Supported locally",
    description: "An event source mapping makes Lambda poll this queue, invoke a function with message batches, and delete successfully handled messages. Batch size and window trade latency for efficiency, maximum concurrency bounds parallel workers, filtering skips unmatched records, and partial batch responses let a function retry only failed items.",
    support: "Create, list, enable, disable, and delete mappings, execution-role checks, filtering, batching, concurrency, partial failures, visibility-based retry, DLQ interaction, FIFO group ordering, metrics, and restart recovery are active. Delivery remains at least once, and local concurrency does not reproduce AWS fleet scale or production throughput.",
  },
};

const targets = [
  ['.sqs-queues-page .card:has([data-filter-table])', "Queues", "queues"],
  [".sqs-detail .card", "Configuration", "configuration"],
  [".sqs-detail .card", "FIFO configuration", "fifo"],
  [".sqs-detail .card", "Fair queue behavior", "fairQueue"],
  [".sqs-detail .card", "Tags", "tags"],
  [".sqs-messages-page .card", "Receive messages", "messages"],
  [".page-width .card", "Tags", "tags"],
  [".sqs-access-policy .card", "Resource-based queue policy", "accessPolicy"],
  [".sqs-encryption .card", "SQS-managed SSE", "encryption"],
  [".sqs-dead-letter .card", "Redrive policy", "redrive"],
  [".sqs-dead-letter .card", "Redrive allow policy", "redriveAllow"],
  [".sqs-lambda-triggers .card", "Event source mappings", "lambdaTriggers"],
];

export function decorateSqsPanelHelp(root = document) {
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
