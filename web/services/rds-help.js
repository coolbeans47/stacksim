import { panelHeading } from "../components.js";

const help = {
  instances: {
    level: "Partial",
    description: "A DB instance is a managed database server with its own identifier, endpoint, engine settings, and master credentials. Create one when an application needs a relational database it can reach with an ordinary MySQL client, then use the lifecycle controls to start, stop, reboot, modify, or delete it.",
    support: "One installation-wide, loopback-only MySQL-compatible DB instance backed by durable embedded SQLite is supported. Official RDS Query/XML lifecycle, manual/final snapshot, local copy/restore, private master credential, tag, safe parameter-group, and supported CloudFormation calls are active. PITR, automated backups, clusters, replicas, Multi-AZ, public networking, IAM database authentication, other engines, and production capacity are unavailable.",
  },
  configuration: {
    level: "Partial",
    description: "Instance configuration describes how clients connect and which compatibility settings the database uses. Edit it to rotate the master password, move the loopback listener, choose a supported parameter group, enable deletion protection, or change class and storage descriptors used by infrastructure tools.",
    support: "Password rotation, port changes with rollback, deletion protection, parameter-group association, pending modifications, final snapshot deletion, and supported class, storage, and allocation descriptors persist locally. Class and storage values are compatibility descriptors rather than reserved compute or disk capacity; PITR, automated backups, encryption options, VPC settings, monitoring, replicas, and production scaling are unavailable.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing DB instances and custom parameter groups by environment, application, owner, or another convention. They can also participate in supported IAM resource-tag conditions, so changing a tag may change which local principals can manage the resource.",
    support: "Creating, listing, adding, replacing, and removing RDS tags, persistence, validation, CloudFormation propagation, and supported resource-tag authorization conditions are active locally. AWS billing allocation, Organizations tag policies, and account-wide governance are outside StackSim.",
  },
  snapshots: {
    level: "Supported locally",
    description: "A manual DB snapshot is an immutable recovery point taken before a destructive schema or data experiment. Copy it inside this installation, or restore it after the single live DB slot is free using a new instance identity and credential.",
    support: "Manual and final snapshots use a consistent SQLite backup, credential-free ownership manifests, SHA-256 file checksums, fsync, and atomic directory publication. Restart removes incomplete owned work and marks corrupt data failed. Snapshot attributes and tags persist. PITR, automated schedules, AWS backup storage, sharing outside this installation, encryption claims, and production durability are unavailable.",
  },
  parameterGroups: {
    level: "Partial",
    description: "A DB parameter group is a reusable set of engine settings attached to a DB instance. Create a custom group when a development database needs values that differ from the provider-owned defaults, then associate it through the instance configuration.",
    support: "Custom groups in the safe mysql8.0 family, descriptions, tags, instance association, deletion safeguards, CloudFormation resources, and reset workflows are active locally. Other engine families, option groups, arbitrary MySQL variables, filesystem or plugin controls, replication, and production server tuning are unavailable.",
  },
  parameters: {
    level: "Partial",
    description: "Engine parameters adjust database behavior without rebuilding the instance. Dynamic values may be applied immediately with a brief managed listener restart, while static values remain pending until the DB instance is rebooted; reset restores the local engine default.",
    support: "A six-parameter safe allowlist is exposed, with validation, immediate or pending-reboot control workflows, durable overrides, association status, rollback protection, and reset. max_connections has its named engine effect; timeout, packet, durability, and default-collation effects remain a documented follow-up dependency. These are not general MySQL or SQLite configuration, and the provider-owned character set is read-only.",
  },
  objects: {
    level: "Partial",
    description: "Database objects are the tables and views available in the selected database, with their columns shown underneath. Filter this list to understand a schema or use Preview to place a bounded SELECT statement into the editor before refining it.",
    support: "Browsing local databases, tables, views, and columns, filtering, refresh, and preview-query generation are active through the mysql8-orm-v1 SHOW metadata forms. Stored routines, triggers, events, users, privileges, metadata outside the bounded information_schema profile, and arbitrary MySQL administration are unavailable.",
  },
  query: {
    level: "Partial",
    description: "The SQL query editor sends selected text, or the whole editor when nothing is selected, to the chosen local database. Use it to inspect data, exercise application queries, or perform supported development DDL and DML without exposing the master password to the browser.",
    support: "The fail-closed mysql8-orm-v1 data plane supports the published DDL/DML, transaction, generated-ID, prepared-value, SHOW/DESCRIBE, and bounded information_schema forms; pinned Knex 3.3.0 and Sequelize 6.37.8 migration/CRUD fixtures pass. Unsupported and SQLite-only SQL returns a stable MySQL-shaped error before execution. Other ORM versions, full MySQL syntax/types/functions/collations/metadata, administration, privileges, performance, and production behavior are not promised.",
  },
};

const targets = [
  ['.page-width:has([data-action="create-rds-database"]) .card', "DB instances", "instances"],
  ['.page-width:has([data-action="create-rds-snapshot"]) .card', "Manual snapshots", "snapshots"],
  ['.page-width:has([data-action="edit-rds-database"]) .card', "Instance configuration", "configuration"],
  ['.page-width:has([data-action="edit-rds-tags"]) .card', "Tags", "tags"],
  ['.page-width:has([data-action="create-rds-parameter-group"]) .card', "DB parameter groups", "parameterGroups"],
  ['.card:has([data-edit-rds-parameter])', "Parameters", "parameters"],
  [".rds-query-explorer", "Database objects", "objects"],
  [".rds-query-editor-card", "SQL query", "query"],
];

export function decorateRdsPanelHelp(root = document) {
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
