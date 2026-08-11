import { panelHeading } from "../components.js";

const help = {
  users: {
    level: "Partial",
    description: "An IAM user is a durable identity for a person, script, or local tool that needs long-lived credentials. Permissions can come directly from attached policies or indirectly through group membership; create separate users when credentials and authorization need independent lifecycle control.",
    support: "User lifecycle, paths, tags through the IAM API, managed and inline policies, group membership, up to two access keys, SigV4 authentication, and local authorization are active. Console passwords, login profiles, MFA, signing certificates, SSH keys, and service-specific credentials are unavailable.",
  },
  userPermissions: {
    level: "Supported locally",
    description: "User permissions determine which API actions this identity may perform on which resources. Attach reusable managed policies here; group and inline policies also contribute to the user's effective permissions, with an explicit Deny taking precedence over any Allow.",
    support: "Managed-policy attachments, inline user policies through the IAM API, group policies, action and resource wildcards, supported conditions, explicit denies, and exact path-qualified resource evaluation are enforced locally. This console panel manages direct managed-policy attachments only.",
  },
  credentials: {
    level: "Supported locally",
    description: "An access key ID and secret access key let an IAM user sign SDK, CLI, CDK, and application requests. Create a key for a distinct client, save its secret immediately, and deactivate or delete credentials that are no longer needed or may have been exposed.",
    support: "Two-key quotas, one-time secret display, active and inactive state, deletion, SigV4 validation, last-owner binding, restart persistence, and encrypted private credential storage are active. Secrets cannot be retrieved again, and these keys do not create an AWS console password.",
  },
  groups: {
    level: "Supported locally",
    description: "A user group collects IAM users so shared permissions can be maintained once instead of attached to every identity. Use groups for a job function or team whose members should receive the same managed or inline policies.",
    support: "Group lifecycle, paths and tags through the API, memberships, managed and inline policies, deletion conflicts, and group-policy contribution to user authorization are active. This console currently manages group creation and membership; policy administration is available through the compatible IAM API.",
  },
  members: {
    level: "Supported locally",
    description: "Members are the IAM users that inherit this group's permission policies. Add a user when it should receive the group's access, and remove it when that shared authorization should stop without deleting the user or its direct policies.",
    support: "Membership add, remove, list, persistence, deletion safeguards, and immediate participation in local policy evaluation are active. Groups cannot contain other groups, roles, or federated identities.",
  },
  roles: {
    level: "Supported locally",
    description: "An IAM role is an identity that a trusted service or principal assumes to receive temporary credentials. The trust policy controls who may assume it, while permission policies control what the resulting session may do.",
    support: "Role lifecycle, paths, descriptions, tags, trust policies, managed and inline permissions, service-role guidance, iam:PassRole, STS AssumeRole sessions, session policies and tags, expiration, and supported service assumption are enforced locally. Service-linked roles and instance profiles are unavailable.",
  },
  rolePermissions: {
    level: "Supported locally",
    description: "Role permission policies define the maximum identity permissions available after the role is assumed. Attach a managed policy for reusable access; inline policies belong only to this role and are normally useful for tightly coupled service configuration.",
    support: "Managed-policy attachments and detachment are available here, while managed and inline role policies, explicit denies, conditions, session-policy intersection, and supported permissions boundaries are enforced by the local evaluator. Unsupported actions are not treated as automatically allowed.",
  },
  trustPolicy: {
    level: "Supported locally",
    description: "A trust policy is the resource-based policy that says which account principals or AWS services may assume a role. It answers who can obtain the role; attached permission policies separately answer what those temporary credentials can do.",
    support: "AWS and service principals, supported conditions, explicit deny, STS AssumeRole, service assumption, external ID and source context, session duration, iam:PassRole checks, and durable trust-policy updates are active. This console view is read-only after creation; updates remain available through IAM APIs and supported CloudFormation roles.",
  },
  policies: {
    level: "Partial",
    description: "A managed policy is a reusable permission document that can be attached to multiple users, groups, or roles. Create a customer-managed policy when the same access should be reviewed and maintained independently from any one identity.",
    support: "Seeded service-managed policies, customer-managed lifecycle, visual and JSON creation, validation, versions, default versions, tags, attachments, deletion conflicts, and evaluator integration are active. The complete AWS managed-policy catalog, policy generation, Access Analyzer, and Organizations policy types are unavailable.",
  },
  permissionPolicy: {
    level: "Supported locally",
    description: "A permission policy contains statements that Allow or Deny actions on resources, optionally under conditions. Keep resources as narrow as practical, use explicit Deny for hard guardrails, and remember that effective access can also be limited by session or resource policies.",
    support: "Version 2012-10-17 documents, statement validation, action and ARN wildcards, explicit-deny precedence, supported condition operators and context keys, managed and inline attachment, session-policy intersection, and authorization diagnostics are active. Access Analyzer findings and the entire AWS service-action catalog are not bundled.",
  },
};

const targets = [
  ['.page-width:has([data-action="create-user"]) > .card', "Users", "users"],
  ['.page-width:has([data-action="attach-user-policy"]) .card', "Permissions", "userPermissions"],
  ['.page-width:has([data-action="attach-user-policy"]) .card', "Security credentials", "credentials"],
  ['.page-width:has([data-action="create-group"]) > .card', "User groups", "groups"],
  ['.page-width:has([data-action="add-member"]) .card', "Members", "members"],
  ['.page-width:has([data-action="create-role"]) > .card', "Roles", "roles"],
  ["#role-permissions .card", "Permissions policies", "rolePermissions"],
  ["#role-trust .card", "Trust policy", "trustPolicy"],
  ['.page-width:has([data-action="create-policy"]) > .card', "Policies", "policies"],
  ["#policy-permissions .card", "Permission policy", "permissionPolicy"],
];

export function decorateIamPanelHelp(root = document) {
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
