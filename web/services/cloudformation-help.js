import { panelHeading } from "../components.js";

const help = {
  stacks: {
    level: "Partial",
    description: "A stack is a collection of infrastructure resources managed as one unit from a template. Use a stack when resources should be created, updated, rolled back, and deleted together with dependency ordering and a durable event history.",
    support: "Durable stack lifecycle, nested stacks, supported resource providers, dependencies, conditions, parameters, outputs, exports, rollback, retention policies, change sets, and CDK deployments are active locally. StackSets, drift detection, resource import, hooks, modules, and arbitrary unsupported AWS resource types are unavailable.",
  },
  stackDetails: {
    level: "Supported locally",
    description: "Stack details summarize the active deployment and its lifecycle controls. Update applies a new template immediately, termination protection blocks deletion, and rollback actions recover supported failed create or update operations.",
    support: "Direct updates, durable operations and events, termination protection, automatic and manual rollback, failed-delete retry, force deletion, retention policies, execution roles, capabilities, and nested-stack deletion rules are enforced locally for supported resources.",
  },
  parameters: {
    level: "Supported locally",
    description: "Parameters are values supplied when a stack or change set is created or updated. They let one template vary by environment without editing the resource definitions; an update may provide a new value or deliberately keep the previous one.",
    support: "Defaults, supplied values, previous-value reuse, parameter overrides, supported validation constraints, resolved values, references, and change-set planning persist locally. Parameters are entered as a JSON object in this console's update and change-set dialogs.",
  },
  tags: {
    level: "Supported locally",
    description: "Stack tags are key-value metadata supplied with a create or update operation. Use them to identify environment, owner, or purpose; supported resource providers may also receive the effective CloudFormation tags defined by the template or stack.",
    support: "Stack tag storage, change-set snapshots, update behavior, listing, and supported resource tag propagation are active locally. AWS billing allocation, Organizations tag policies, and account-wide governance are outside StackSim.",
  },
  template: {
    level: "Partial",
    description: "The template is the declarative source for a stack. Original shows what was submitted, while Processed shows the condition-resolved document CloudFormation used to plan and execute resources.",
    support: "Bounded JSON templates, core sections, supported intrinsic functions, conditions, dependencies, transforms used by the supported profile, validation, planning, and execution are active. This console editor accepts JSON; YAML editing, arbitrary transforms, macros, modules, and unsupported resource types are unavailable.",
  },
  changeSets: {
    level: "Supported locally",
    description: "A change set is a reviewable plan for creating a new stack or updating an existing one. Use it to inspect additions, modifications, removals, and possible replacements before any resources are changed.",
    support: "CREATE and UPDATE change sets, JSON templates, parameter overrides, capabilities, create-failure behavior, property-level differences, replacement warnings, execution, deletion, and durable status are active locally for the supported CloudFormation profile.",
  },
  changes: {
    level: "Supported locally",
    description: "Changes are the resource-level actions CloudFormation calculated for this plan. Replacement means a physical resource may be recreated, so review the affected properties and deletion or update-replace policy before execution.",
    support: "Add, modify, remove, import-free replacement analysis, property details, recreation requirements, policy actions, and execution of the reviewed snapshot are active. The plan does not provide drift detection or preview external changes made outside CloudFormation.",
  },
  events: {
    level: "Supported locally",
    description: "Stack events are the chronological audit trail of resource and stack lifecycle transitions. Filter by operation ID to isolate one create, update, rollback, or delete attempt when diagnosing a failure.",
    support: "Durable operation IDs, resource transitions, timestamps, status reasons, newest-first listing, filtering, rollback events, and retained history are active locally for CloudFormation-managed operations.",
  },
};

const targets = [
  ['.card:has([data-filter-table])', "Stacks", "stacks"],
  [".cloudformation-stack-info", "Stack details", "stackDetails"],
  [".card", "Parameters", "parameters"],
  [".card", "Tags", "tags"],
  ["[data-template-panel]", "Template", "template"],
  ['.card:has([data-action="create-change-set"])', "Change sets", "changeSets"],
  ['.card:has(.cloudformation-change-table)', "Changes", "changes"],
  ["[data-events-panel]", "Stack events", "events"],
];

export function decorateCloudFormationPanelHelp(root = document) {
  for (const [selector, title, helpKey] of targets) {
    for (const heading of root.querySelectorAll(`${selector} > .card-header h2`)) {
      const text = heading.textContent.trim();
      if (text !== title && !text.startsWith(`${title} (`)) continue;
      if (heading.closest(".panel-title-row")) continue;
      const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
      heading.outerHTML = panelHeading(title, help[helpKey], meta);
    }
  }
}
