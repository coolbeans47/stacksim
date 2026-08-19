import { panelHeading } from "../components.js";

const help = {
  parameters: {
    level: "Partial",
    description: "A parameter is a named configuration value that applications can read at runtime. Names can use paths such as /my-app/dev/database/host, which makes related settings easier to organize and retrieve as a hierarchy without putting environment-specific values in source code.",
    support: "Standard and Advanced String, StringList, and SecureString parameters, names and hierarchies, policies, descriptions, versions, parameter history and labels, filtering, pagination, tags, IAM authorization, and same-account single-Region persistence are active locally. Intelligent-Tiering and the rest of Systems Manager are unavailable.",
  },
  configuration: {
    level: "Partial",
    description: "Parameter configuration defines the stable name clients request, the kind of value stored, and optional validation and metadata. Use String for one value, StringList for a comma-separated list, or SecureString when local development credentials or other sensitive text should not be kept as plaintext.",
    support: "This editor creates Standard- or Advanced-tier text parameters and supports descriptions, regular-expression allowed patterns, initial tags, and Advanced policies. SecureString values use installation-local AES-256-GCM protection; explicit KMS keys, Intelligent-Tiering, and non-text data types are unavailable.",
  },
  value: {
    level: "Supported locally",
    description: "The value is the configuration returned to authorized SDK, CLI, CDK, or application requests. It stays hidden on this page until you explicitly reveal it; editing a parameter publishes a new numbered version so existing callers can continue using the same name.",
    support: "Explicit reads, SecureString decryption, exact numeric or labeled reads, overwrite validation, durable numbered versions, history browsing, and version labels are active. Secure values are decrypted only into page memory and are cleared when you leave or refresh; AWS KMS integration is unavailable.",
  },
  history: {
    level: "Supported locally",
    description: "History shows retained immutable versions and the labels that select them. A label can identify only one version and can be moved atomically for rollback without changing the current numbered version.",
    support: "Paginated GetParameterHistory metadata, explicit ephemeral historical-value reveal, label creation and movement, safe unlabeling, ten labels per version, and labeled selectors are active locally.",
  },
  policies: {
    level: "Supported locally",
    description: "Advanced parameters can schedule expiration and notifications. Expiration deletes the parameter at the configured instant; notification policies emit safe value-free service events before expiration or after a no-change interval.",
    support: "Expiration, ExpirationNotification, and NoChangeNotification policies, persisted due times, deterministic restart-safe processing, and status display are active locally. Advanced parameters cannot be downgraded to Standard.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing parameters by environment, application, owner, or another convention. They can also participate in supported IAM conditions, so changing a tag may change which local principals can access or manage the parameter.",
    support: "Creating, listing, adding, replacing, and removing Parameter tags, persistence, validation, and supported resource-tag authorization conditions are active locally. AWS billing allocation, Organizations tag policies, and account-wide governance are outside StackSim.",
  },
};

const targets = [
  ['.card:has([data-filter-table])', "Parameters", "parameters"],
  ['.card:has(#parameter-create)', "Parameter configuration", "configuration"],
  ['.page-width:has([data-action="reveal"]) .card', "Value", "value"],
  ['.page-width:has([data-action="history"]) .card', "History and labels", "history"],
  ['.page-width:has([data-action="reveal"]) .card:has(h2)', "Policies", "policies"],
  ['.page-width:has([data-action="tags"]) .card', "Tags", "tags"],
];

export function decorateParameterStorePanelHelp(root = document) {
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
