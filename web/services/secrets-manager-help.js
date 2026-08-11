import { panelHeading } from "../components.js";

const help = {
  secrets: {
    level: "Partial",
    description: "A secret is a named, encrypted value such as a database credential, API token, or signing key that an application retrieves at runtime. Keeping secrets here separates sensitive configuration from source code and gives each value its own versions, tags, access checks, and deletion lifecycle.",
    support: "Same-account, single-Region secret lifecycle, encrypted string and binary values, batch reads, custom staging labels, configured-account identity resource policies, tags, filtering, pagination, IAM authorization, generated passwords through the API, and recovery-window deletion are active locally. Customer KMS keys, automatic rotation, replication, CloudFormation secret resources, and the complete AWS catalog are unavailable.",
  },
  configuration: {
    level: "Partial",
    description: "Secret configuration establishes the stable name applications request, an optional initial value, a human-readable description, and organizational tags. The initial value may be credentials encoded as JSON or any other text your application understands; leaving it empty creates metadata ready for a later version.",
    support: "This editor creates locally encrypted SecretString values or metadata-only secrets with descriptions and initial tags. SecretBinary and GetRandomPassword are supported through the compatible SDK, but this form does not enter binary data or generate a password; explicit KMS keys, replicas, and automatic rotation are unavailable.",
  },
  overview: {
    level: "Supported locally",
    description: "Overview identifies the secret and summarizes metadata that changes independently from its protected value. Edit updates the description or optionally publishes a value, while scheduled deletion blocks reads and changes during a 7–30 day recovery window so an accidental deletion can be restored.",
    support: "Metadata updates, scheduled deletion, restoration, immediate permanent deletion, name-reuse safeguards, durable recovery deadlines, and blocking access while deletion is pending are active locally. There is no snapshot or recovery after an immediate deletion or after the recovery window expires.",
  },
  value: {
    level: "Supported locally",
    description: "The secret value is the protected material returned to an authorized application. Retrieval is deliberately explicit on this page; editing with a new value creates a version instead of overwriting the stored bytes in place, allowing the current and previous values to be distinguished.",
    support: "Installation-local AES-256-GCM protection, explicit current-value reads, string and binary SDK values, authenticated persistence, IAM checks, and value updates are active. Revealed console plaintext exists only in page memory, clears after 60 seconds or navigation, and is never written to the URL; AWS KMS integration and automatic rotation are unavailable.",
  },
  versions: {
    level: "Supported locally",
    description: "A version is an immutable stored value identified by a request token. Publishing a new value moves AWSCURRENT to it and marks the former current version AWSPREVIOUS, so clients can request the active value or deliberately retrieve an earlier one while troubleshooting or rolling back application configuration.",
    support: "Exact AWSCURRENT and AWSPREVIOUS movement, custom stage creation/move/removal, explicit rollback, exact version-ID or stage reads, deprecated-version listing, idempotency tokens, retention limits, and encrypted version storage are active.",
  },
  permissions: {
    level: "Partial",
    description: "A secret resource policy can grant a configured-account IAM identity access in addition to its identity policies. Explicit deny still wins, and the editor validates the JSON and blocks policies that would create public access.",
    support: "Policy validation, read, update, delete, public-policy blocking, durable revisions, and grants to existing identities in the configured account are active. Foreign, federated, public, and not-yet-activated service principals are rejected; cross-account sharing is unavailable.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing secrets by environment, application, owner, or another convention. They can also participate in supported IAM conditions, so changing a tag may change which local principals can retrieve or manage the secret.",
    support: "Creating, listing, adding, replacing, and removing secret tags, persistence, validation, filtering, and supported resource-tag authorization conditions are active locally. AWS billing allocation, Organizations tag policies, and cross-account governance are outside StackSim.",
  },
};

const targets = [
  ['.card:has([data-filter-table])', "Secret catalog", "secrets"],
  ['.card:has(#secret-create)', "Secret configuration", "configuration"],
  [".card", "Overview", "overview"],
  [".card", "Secret value", "value"],
  [".card", "Versions", "versions"],
  [".card", "Resource permissions", "permissions"],
  [".card", "Tags", "tags"],
];

export function decorateSecretsManagerPanelHelp(root = document) {
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
