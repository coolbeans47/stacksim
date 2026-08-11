import { panelHeading } from "../components.js";

const help = {
  accountStatus: {
    level: "Supported locally",
    description: "Account status is the regional gate for all SES sending. Pause it to test how applications handle a disabled email service, or switch between sandbox and production profiles to exercise recipient-verification and quota rules without changing individual identities.",
    support: "Regional sending state, sandbox and production enforcement, configured quotas, IAM checks, durable audit state, and immediate effects on supported send APIs are active. StackSim captures accepted mail locally and never sends to external SMTP servers, so production profile does not create real deliverability or reputation behavior.",
  },
  identities: {
    level: "Partial",
    description: "A verified identity proves which email address or domain an application may use as its sender. Create an email identity for one From address or a domain identity when local tests should recognize addresses beneath that domain.",
    support: "Email identities receive signed verification messages in the local Inbox; domain identities expose deterministic descriptors and can be explicitly verified for local use. Sending enforcement, tags, default configuration sets, MAIL FROM state, identity policies, and supported CloudFormation resources are active, but StackSim performs no public DNS lookup or DKIM signing.",
  },
  defaultConfiguration: {
    level: "Supported locally",
    description: "A default configuration set applies named sending controls whenever this identity is used and the send request does not choose another set. Associate one to consistently test paused sending, suppression choices, metrics, or supported event destinations for this sender.",
    support: "Association, removal, persistence, dependency validation, and inheritance during supported sends are active. A missing or paused inherited set is enforced rather than ignored; unsupported AWS configuration-set features do not become available through this association.",
  },
  mailFrom: {
    level: "Control plane only",
    description: "MAIL FROM identifies the envelope domain used for bounce handling, which is separate from the From header recipients see. MX failure behavior says whether SES should fall back to its service domain or reject when the configured domain cannot be used.",
    support: "MAIL FROM domains, validation, failure behavior, status, feedback settings, and classic/v2 API reads and writes persist as control state. StackSim does not publish or query DNS, contact an MX server, cryptographically sign mail, forward feedback, or claim real SPF, DKIM, or DMARC alignment.",
  },
  authorizationPolicies: {
    level: "Supported locally",
    description: "A sending authorization policy lets another principal send using this identity without owning it. The JSON statements specify who may call SES, which send actions are allowed, and any supported conditions; an explicit Deny always overrides an Allow.",
    support: "Named identity-policy create, update, list, delete, validation, supported principals and conditions, exact identity resources, delegated identity inputs, and explicit-deny evaluation are active locally. Organizations policies and unimplemented SES actions or global AWS identities are not simulated implicitly.",
  },
  addresses: {
    level: "Supported locally",
    description: "Message addresses define the verified sender, envelope recipients, and Reply-To destinations. To recipients are primary, Cc recipients are visible copies, Bcc recipients are envelope-only copies, and Reply-To controls where a mail client would direct a response.",
    support: "Verified sender enforcement, To/Cc/Bcc and Reply-To parsing, syntax and recipient limits, sandbox restrictions, quota accounting, deduplication rules, and durable local capture are active. No recipient is contacted externally, and StackSim does not infer remote delivery, bounce, complaint, or reply behavior.",
  },
  content: {
    level: "Partial",
    description: "Content is either a simple subject with text and HTML bodies or a stored template rendered with a JSON data object. A configuration set can add supported sending controls and measurable local event destinations to this request.",
    support: "Simple and stored-template sends, UTF-8 content, JSON substitution, render failures, configuration-set enforcement, official SES v2 SendEmail, and durable Inbox capture are active. This form does not expose raw MIME, attachments, bulk personalization, message tags, or every API field even where a compatible SDK route exists.",
  },
  mailbox: {
    level: "Local console feature",
    description: "The Inbox is a private inspection mailbox for messages SES accepted in this account and Region. Filter by exact envelope recipient or read/trash state, then inspect rendered content and diagnostic outcomes without relying on an external mail provider.",
    support: "Durable regional capture, recipient suggestions and exact filtering, pagination, read state, Trash, restore, permanent purge, template and configuration links, raw downloads, and accepted suppression or rendering-failure rows are active. It is not an SES API mailbox, accepts no inbound internet email, and Captured never means remotely delivered.",
  },
  templates: {
    level: "Supported locally",
    description: "An email template stores reusable subject, text, and HTML content with named placeholders. Use templates when many messages share a layout but supply different JSON data for each recipient or send.",
    support: "A shared Classic and v2 template catalog, creation, retrieval, update, deletion, tags, pagination, validation, test rendering, templated sends, bulk API personalization, and supported CloudFormation resources are active. Advanced template languages and external asset hosting are not provided.",
  },
  templateContent: {
    level: "Supported locally",
    description: "Template content is the reusable subject and optional text and HTML source rendered for a templated send. Edit it to change future messages; already captured Inbox rows retain the exact content accepted at their send time.",
    support: "Subject, text and HTML storage, placeholder validation and substitution, classic/v2 updates, size limits, restart persistence, and use by supported single and bulk sends are active. Editing does not rewrite historical mail, fetch remote content, or execute arbitrary template code.",
  },
  testRender: {
    level: "Supported locally",
    description: "Test render applies a JSON object to the stored template and shows the resulting MIME without sending a message. Use it to catch missing data, invalid JSON, or malformed substitutions before an application calls a send API.",
    support: "Official TestRenderTemplate behavior, JSON validation, placeholder substitution, deterministic MIME rendering, safe result display, and modeled rendering errors are active. Rendering does not consume sending quota, create an Inbox row, contact a recipient, or load external assets.",
  },
  configurationSets: {
    level: "Partial",
    description: "A configuration set groups controls and telemetry under a name that a sender or individual request can select. Create one when related mail should share an independent sending-state switch, suppression options, or supported event reporting.",
    support: "Classic/v2 lifecycle, tags, immediate sending-state enforcement, identity inheritance, suppression options, supported CloudWatch and EventBridge destinations, tracking descriptors, and CloudFormation resources are active. Reputation dashboards, dedicated IP pools, TLS policy, archiving, VDM, and production delivery controls are unavailable.",
  },
  configuration: {
    level: "Partial",
    description: "Configuration summarizes the controls applied to sends using this set. Pause or enable sending, choose whether bounce and complaint reasons participate in local suppression, and review which supported event destinations will receive measurable outcomes.",
    support: "Sending state, suppression options, destination counts, tags, dependency checks, inheritance, and immediate enforcement are active. Tracking domains remain descriptors, while dedicated pools, VDM, reputation, archive, remote-delivery, ISP, open, and complaint telemetry are unavailable.",
  },
  eventDestinations: {
    level: "Partial",
    description: "An event destination publishes selected SES outcomes so local monitoring or automation can react to a send. Choose CloudWatch for metrics or the EventBridge default bus for events, and select only outcomes StackSim can measure directly.",
    support: "CloudWatch metric destinations and the default EventBridge bus support SEND, REJECT, rendering-failure, and bounded local-link outcomes with lifecycle and IAM enforcement. Named buses, SNS, Firehose, Pinpoint, external endpoints, and fabricated delivery, ISP, open, or remote complaint events are unavailable.",
  },
  suppression: {
    level: "Supported locally",
    description: "The suppression list records recipients that should be treated as known bounces or complaints. Add an address to test whether applications and configuration-set options handle suppressed destinations without contacting a real mailbox provider.",
    support: "Add, inspect, filter, paginate, and remove operations, BOUNCE and COMPLAINT reasons, send-time enforcement, retained diagnostic content, metrics, IAM, and restart persistence are active. A locally suppressed accepted message is marked Suppressed; StackSim does not fabricate a remote bounce or complaint.",
  },
  contactLists: {
    level: "Supported locally",
    description: "A contact list groups recipients and named subscription topics such as news or product updates. Define topic defaults when creating the list so each contact can inherit them or record explicit opt-in and opt-out preferences.",
    support: "Contact-list lifecycle, descriptions, topic definitions and validation, tags through the API, pagination, dependencies, local unsubscribe state and signed links, IAM, and restart persistence are active. Campaign orchestration, imports, external list providers, and account-wide marketing analytics are unavailable.",
  },
  contacts: {
    level: "Supported locally",
    description: "A contact stores one recipient's topic preferences and optional unsubscribe-all choice within this list. Add a contact to test personalized consent decisions and remove it when the application should fall back to list defaults or no stored preference.",
    support: "Contact create, list, read, update through the API, delete, topic-preference validation, unsubscribe-all state, send-time list-management enforcement, IAM, and persistence are active. StackSim does not synchronize contacts with an external CRM or infer consent from mail-provider activity.",
  },
  verificationTemplates: {
    level: "Supported locally",
    description: "A custom verification template controls the subject, HTML, verified sender, and success or failure redirect used when SES asks a recipient to verify an email identity. The HTML must preserve the verificationURL placeholder for the signed callback.",
    support: "Classic/v2 lifecycle, validation, verified-From enforcement, signed local verification links, bounded localhost redirect handling, tags through the API, IAM, and restart persistence are active. Messages are captured locally; StackSim does not send externally or permit the callback to become an open redirect.",
  },
};

const targets = [
  ['.card:has([data-action="toggle-ses-sending"])', "Account status", "accountStatus"],
  ['.card:has([data-filter-table])', "Identities", "identities"],
  ['.card:has(#ses-identity-configuration)', "Default configuration set", "defaultConfiguration"],
  ['.card:has([data-action="edit-mail-from"])', "MAIL FROM and feedback", "mailFrom"],
  ['.card:has([data-action="put-identity-policy"])', "Sending authorization policies", "authorizationPolicies"],
  ["#ses-send-test .card", "Message addresses", "addresses"],
  ["#ses-send-test .card", "Content", "content"],
  [".ses-inbox-page .card", "Mailbox messages", "mailbox"],
  ['.card:has([data-filter-table])', "Templates", "templates"],
  ['.page-width:has([data-action="edit-template"]) .card', "Template content", "templateContent"],
  ['.card:has(#ses-test-render)', "Test render", "testRender"],
  ['.card:has([data-filter-table])', "Configuration sets", "configurationSets"],
  ['.page-width:has([data-action="configure-suppression"]) .card', "Configuration", "configuration"],
  ['.page-width:has([data-action="create-event-destination"]) .card', "Event destinations", "eventDestinations"],
  ['.card:has([data-action="delete-suppressed"], [data-filter-table])', "Suppressed destinations", "suppression"],
  ['.page-width:has([data-action="create-contact-list"]) .card', "Contact lists", "contactLists"],
  ['.page-width:has([data-action="create-contact"]) .card', "Contacts", "contacts"],
  ['.page-width:has([data-action="create-custom-verification"]) .card', "Verification templates", "verificationTemplates"],
];

export function decorateSesPanelHelp(root = document) {
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
