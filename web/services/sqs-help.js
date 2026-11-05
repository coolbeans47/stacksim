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
    description: "Poll for messages keeps receiving for the polling duration, or until the maximum message count is listed, and shows each message in the Messages table. Received messages are hidden from other consumers while they are listed and become visible again when you poll again or leave the page, unless you set an explicit visibility timeout. Open a message to read its body, attributes and details, change its visibility, or select messages and delete them.",
    support: "Single and batch send, receive and delete, delays, long polling, visibility changes, receipt handles, receive counts, message and system attributes, binary attribute values, FIFO metadata, MD5s, durable leases, IAM checks, and restart recovery are active. Receiving mutates queue state, Standard delivery is at least once, and the console inspection limit does not change the stored payload.",
  },
  sendMessage: {
    level: "Supported locally",
    description: "Send message adds a body and optional metadata to the queue. A Standard queue accepts a per-message delivery delay and an optional message group ID for fair-queue scheduling; a FIFO queue needs a message group ID and, unless content-based deduplication is on, a deduplication ID. Message attributes carry typed metadata beside the body: add a row for each name, type and value.",
    support: "SendMessage with String, Number and Binary attributes, custom type suffixes, delays, FIFO identifiers, the trace header system attribute, size limits, MD5 digests and sequence numbers is active. The console sends one message at a time; batch sends are available through the SDK and CLI.",
  },
  snsSubscriptions: {
    level: "Supported locally",
    description: "An SNS subscription delivers every message published to a topic into this queue, so one publisher can fan out to several queues. Subscribing needs two things: the subscription on the topic, and a statement in the queue access policy that lets the topic send messages.",
    support: "Standard topic to Standard queue fan-out, the SNS message envelope, raw message delivery, filter policies and the queue-policy check are active. Subscribing here creates the subscription and adds the policy statement. SNS FIFO topics are not available in StackSim.",
  },
  redriveTasks: {
    level: "Supported locally",
    description: "A redrive task moves the messages in a dead-letter queue back to their source queues, or to one queue you choose, so they can be processed again after the consumer is fixed. Only a queue that another queue uses as its dead-letter queue can be redriven, and one task runs at a time.",
    support: "Starting, listing and cancelling tasks, source or custom destinations, a custom maximum velocity, approximate progress, failure reasons, a bounded history of ten tasks and restart recovery are active. Completion confirms movement, not successful processing. KMS and VPC endpoint dependencies are unavailable.",
  },
  accessPolicy: {
    level: "Supported locally",
    description: "A queue policy is a resource-based permission document that can let another account or an AWS service send to or consume from this queue. Scope service publishers such as EventBridge, S3, or SNS with the exact service principal, source ARN, and source account; an explicit Deny overrides an Allow.",
    support: "IAM and queue-policy composition, same-account and cross-account evaluation, supported principals, actions and conditions, explicit deny, owner-only administration, AddPermission and RemovePermission, policy validation, and active service-producer checks are modeled. The editor does not imply every IAM condition or every external AWS service is available.",
  },
  encryption: {
    level: "Partial",
    description: "Server-side encryption with an Amazon SQS key (SSE-SQS) records whether new queue writes use the SQS-managed mode. This setting is separate from StackSim's private payload store, which always authenticates and encrypts message bodies on disk even when the queue's SSE-SQS descriptor is disabled.",
    support: "SqsManagedSseEnabled creation, updates, per-message mode metadata, durable reads across setting changes, SDK reporting, and installation-local authenticated payload encryption are active. Customer-managed KMS identifiers are validated but fail atomically as unsupported; StackSim never claims that an AWS KMS key encrypted local data.",
  },
  redrive: {
    level: "Supported locally",
    description: "A redrive policy sends a repeatedly received message to a dead-letter queue after its receive count exceeds the configured maximum. Use it to isolate poison messages that workers cannot process without blocking normal work, and choose a destination with the same Standard or FIFO queue type.",
    support: "Redrive policies, receive counting, compatible queue-type validation, durable cross-queue moves, payload and attribute preservation, FIFO group behavior, Lambda failure paths, metrics, source discovery, and restart recovery are active. Start/list/cancel message-move tasks, original or custom destinations, velocity controls, bounded history, and restart recovery are available. Completion confirms movement; verify application processing in consumer logs. KMS and VPC endpoint dependencies remain unavailable.",
  },
  redriveAllow: {
    level: "Supported locally",
    description: "A redrive allow policy belongs to the dead-letter queue and controls which source queues may target it. Allow all accepts same-account queues in this Region, Deny all blocks new redrive relationships, and By queue limits use to the listed queue ARNs.",
    support: "Allow all, Deny all, and By queue with up to ten same-account source queues, relationship validation, source discovery, Standard/FIFO compatibility, authorization, and persistence are active. It does not grant unrelated queue API access or enable cross-Region redrive.",
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
  [".sqs-queue-form .card", "Configuration", "configuration"],
  [".sqs-queue-form .card", "Access policy", "accessPolicy"],
  [".sqs-queue-form .card", "Redrive allow policy", "redriveAllow"],
  [".sqs-queue-form .card", "Encryption", "encryption"],
  [".sqs-queue-form .card", "Dead-letter queue", "redrive"],
  [".sqs-queue-form .card", "Tags", "tags"],
  [".sqs-messages-page .card", "Send message", "sendMessage"],
  [".sqs-messages-page .card", "Receive messages", "messages"],
  [".sqs-sns-subscriptions .card", "SNS subscriptions", "snsSubscriptions"],
  [".sqs-tagging .card", "Tags", "tags"],
  [".sqs-access-policy .card", "Access policy", "accessPolicy"],
  [".sqs-access-policy .card", "Redrive allow policy", "redriveAllow"],
  [".sqs-encryption .card", "Encryption", "encryption"],
  [".sqs-dead-letter .card", "Dead-letter queue", "redrive"],
  [".sqs-dead-letter .card", "Redrive allow policy", "redriveAllow"],
  [".sqs-redrive-tasks .card", "Dead-letter queue redrive tasks", "redriveTasks"],
  [".sqs-lambda-triggers .card", "Lambda triggers", "lambdaTriggers"],
];

export function decorateSqsPanelHelp(root = document) {
  for (const [selector, title, helpKey] of targets) {
    for (const panel of root.querySelectorAll(selector)) {
      const heading = panel.querySelector(":scope > .card-header h2");
      if (!heading || heading.closest(".panel-title-row")) continue;
      const text = heading.textContent.trim();
      if (text !== title && !text.startsWith(`${title} (`) && !text.startsWith(`${title} -`)) continue;
      const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
      heading.outerHTML = panelHeading(title, help[helpKey], meta);
    }
  }
}
