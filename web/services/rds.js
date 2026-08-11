import { rds } from "../api-client.js";
import { emptyState, escapeHtml, pageHeader, tabs } from "../components.js";
import { session } from "../state.js";
import { decorateRdsPanelHelp } from "./rds-help.js";
import { rdsQueryEditor } from "./rds-query-editor.js";

export const metadata = {
  key: "rds",
  name: "RDS",
  icon: "R",
  cls: "rds",
  links: [["Databases", "#/rds/databases"], ["Snapshots", "#/rds/snapshots"], ["Query editor", "#/rds/query-editor"], ["Parameter groups", "#/rds/parameter-groups"]],
  search: ["rds", "relational database", "mysql", "database", "snapshot", "restore", "backup", "sql", "query editor", "run query", "database objects", "db instance", "parameter group"],
};

const elements = (root, name) => [...(root?.getElementsByTagName?.(name) ?? [])];
const first = (root, name) => elements(root, name)[0]?.textContent ?? "";
const booleanValue = (root, name) => first(root, name).toLowerCase() === "true";
const numberValue = (root, name) => { const raw = first(root, name); if (!raw.trim()) return undefined; const value = Number(raw); return Number.isFinite(value) ? value : undefined; };
const formatDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : "-";
const transitionStatuses = new Set(["creating", "copying", "backing-up", "deleting", "modifying", "rebooting", "stopping", "starting"]);

function parseTags(root) {
  const list = elements(root, "TagList")[0] ?? root;
  return elements(list, "Tag").map(tag => ({ Key: first(tag, "Key"), Value: first(tag, "Value") }));
}

function parseStatusInfos(root) {
  const list = elements(root, "StatusInfos")[0];
  return elements(list, "DBInstanceStatusInfo").map(info => ({ type: first(info, "StatusType"), normal: booleanValue(info, "Normal"), message: first(info, "Message") }));
}

function parsePendingValues(root) {
  const pending = elements(root, "PendingModifiedValues")[0];
  if (!pending) return {};
  return {
    allocatedStorage: numberValue(pending, "AllocatedStorage"),
    instanceClass: first(pending, "DBInstanceClass") || undefined,
    storageType: first(pending, "StorageType") || undefined,
    port: numberValue(pending, "Port"),
  };
}

function parseInstance(root) {
  const endpoint = elements(root, "Endpoint")[0];
  const parameterGroups = elements(elements(root, "DBParameterGroups")[0], "DBParameterGroup").map(group => ({
    name: first(group, "DBParameterGroupName"),
    status: first(group, "ParameterApplyStatus"),
  }));
  return {
    identifier: first(root, "DBInstanceIdentifier"),
    status: first(root, "DBInstanceStatus"),
    arn: first(root, "DBInstanceArn"),
    resourceId: first(root, "DbiResourceId"),
    instanceClass: first(root, "DBInstanceClass"),
    engine: first(root, "Engine"),
    engineVersion: first(root, "EngineVersion"),
    databaseName: first(root, "DBName"),
    masterUsername: first(root, "MasterUsername"),
    allocatedStorage: numberValue(root, "AllocatedStorage"),
    storageType: first(root, "StorageType"),
    backupRetentionPeriod: numberValue(root, "BackupRetentionPeriod") ?? 0,
    availabilityZone: first(root, "AvailabilityZone"),
    createdAt: first(root, "InstanceCreateTime"),
    deletionProtection: booleanValue(root, "DeletionProtection"),
    publiclyAccessible: booleanValue(root, "PubliclyAccessible"),
    multiAz: booleanValue(root, "MultiAZ"),
    endpoint: endpoint ? { address: first(endpoint, "Address"), port: numberValue(endpoint, "Port") } : undefined,
    parameterGroups,
    pending: parsePendingValues(root),
    tags: parseTags(root),
    statusInfos: parseStatusInfos(root),
    providerStatus: first(root, "ProviderStatus"),
    providerMessage: first(root, "ProviderMessage"),
  };
}

const parseInstances = xml => elements(elements(xml, "DBInstances")[0] ?? xml, "DBInstance").map(parseInstance);

function parseSnapshot(root) {
  return {
    identifier: first(root, "DBSnapshotIdentifier"),
    arn: first(root, "DBSnapshotArn"),
    sourceIdentifier: first(root, "DBInstanceIdentifier"),
    status: first(root, "Status"),
    createdAt: first(root, "SnapshotCreateTime"),
    engine: first(root, "Engine"),
    engineVersion: first(root, "EngineVersion"),
    allocatedStorage: numberValue(root, "AllocatedStorage"),
    storageType: first(root, "StorageType"),
    port: numberValue(root, "Port"),
    checksum: first(root, "LocalManifestChecksum"),
    sizeBytes: numberValue(root, "LocalDataSizeBytes"),
    fileCount: numberValue(root, "LocalFileCount"),
    message: first(root, "LocalStatusMessage"),
    tags: parseTags(root),
  };
}

const parseSnapshots = xml => elements(elements(xml, "DBSnapshots")[0] ?? xml, "DBSnapshot").map(parseSnapshot);

function parseQuotas(xml) {
  return elements(xml, "AccountQuota").map(quota => ({ name: first(quota, "AccountQuotaName"), used: numberValue(quota, "Used") ?? 0, max: numberValue(quota, "Max") ?? 0 }));
}

function parseParameterGroup(root) {
  return {
    name: first(root, "DBParameterGroupName"),
    family: first(root, "DBParameterGroupFamily"),
    description: first(root, "Description"),
    arn: first(root, "DBParameterGroupArn"),
  };
}

const parseParameterGroups = xml => elements(elements(xml, "DBParameterGroups")[0] ?? xml, "DBParameterGroup").map(parseParameterGroup);

function parseParameters(xml) {
  const container = elements(xml, "Parameters")[0] ?? xml;
  return elements(container, "Parameter").map(parameter => ({
    name: first(parameter, "ParameterName"),
    value: first(parameter, "ParameterValue"),
    description: first(parameter, "Description"),
    source: first(parameter, "Source"),
    applyType: first(parameter, "ApplyType"),
    dataType: first(parameter, "DataType"),
    allowedValues: first(parameter, "AllowedValues"),
    modifiable: booleanValue(parameter, "IsModifiable"),
    applyMethod: first(parameter, "ApplyMethod"),
  }));
}

function statusMarkup(status) {
  const normalized = String(status || "unknown").toLowerCase();
  const css = transitionStatuses.has(normalized) ? "pending" : ["failed", "incompatible-restore", "incompatible-network"].includes(normalized) ? "error" : normalized === "stopped" ? "inactive" : "";
  return `<span class="status ${css}">${escapeHtml(normalized)}</span>`;
}

function databaseTabs(identifier, active) {
  const root = `#/rds/databases/${encodeURIComponent(identifier)}`;
  return tabs([
    { label: "Connectivity & security", href: `${root}/connectivity`, active: active === "connectivity" },
    { label: "Configuration", href: `${root}/configuration`, active: active === "configuration" },
    { label: "Tags", href: `${root}/tags`, active: active === "tags" },
  ]);
}

function engineVersions(xml) {
  return elements(xml, "DBEngineVersion").map(node => ({ engine: first(node, "Engine"), version: first(node, "EngineVersion") })).filter(item => item.engine === "mysql" && item.version);
}

function orderableOptions(xml) {
  return elements(xml, "OrderableDBInstanceOption").map(node => ({
    instanceClass: first(node, "DBInstanceClass"),
    storageType: first(node, "StorageType"),
    minimumStorage: numberValue(node, "MinStorageSize") ?? 20,
    maximumStorage: numberValue(node, "MaxStorageSize"),
  })).filter(item => item.instanceClass && item.storageType);
}

function parseTagInput(raw) {
  let value;
  try { value = JSON.parse(String(raw || "{}")); }
  catch { throw new Error("Tags must be a JSON object"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Tags must be a JSON object");
  return Object.entries(value).map(([Key, tagValue]) => ({ Key, Value: String(tagValue) }));
}

const tagsObject = tags => Object.fromEntries(tags.map(tag => [tag.Key, tag.Value]));

function clearPasswordInput(name) {
  const input = document.querySelector(`dialog input[name="${name}"]`);
  if (input) input.value = "";
}

function typedAction(context, { title, identifier, message, submitLabel, onSubmit, danger = true }) {
  context.showModal(title, `<p>${escapeHtml(message)}</p><div class="field"><label>To confirm, enter <strong>${escapeHtml(identifier)}</strong></label><input name="confirmation" required autocomplete="off"></div>`, submitLabel, async data => {
    if (data.get("confirmation") !== identifier) throw new Error(`Enter ${identifier} to confirm`);
    await onSubmit();
  }, false, { danger });
}

function scheduleRefresh(context) {
  const expectedHash = location.hash;
  setTimeout(() => { if (location.hash === expectedHash && !document.querySelector("dialog[open]")) void context.route(false); }, 750);
}

function bindCreateDatabase(context, disabled = false) {
  context.main.querySelectorAll('[data-action="create-rds-database"]').forEach(button => {
    button.disabled = disabled;
    if (disabled) return;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const [versionsOutput, groupsOutput] = await Promise.all([rds("DescribeDBEngineVersions", { Engine: "mysql" }), rds("DescribeDBParameterGroups")]);
        const versions = engineVersions(versionsOutput.xml);
        if (!versions.length) throw new Error("No local MySQL engine version is available");
        const options = orderableOptions((await rds("DescribeOrderableDBInstanceOptions", { Engine: "mysql", EngineVersion: versions[0].version })).xml);
        if (!options.length) throw new Error("No local MySQL DB instance option is available");
        const groups = parseParameterGroups(groupsOutput.xml);
        const classes = [...new Set(options.map(option => option.instanceClass))];
        const storageTypes = [...new Set(options.map(option => option.storageType))];
        const minimumStorage = Math.min(...options.map(option => option.minimumStorage));
        const maximumStorage = options.map(option => option.maximumStorage).filter(value => value !== undefined).sort((left, right) => right - left)[0];
        context.showModal("Create database", `<div class="alert info"><strong>Single local MySQL instance</strong><br>This installation supports one loopback-only DB instance. Compute and storage values are compatibility descriptors, not reserved capacity.</div><div class="field"><label>DB instance identifier</label><input name="identifier" required pattern="[a-z][a-z0-9\\-]{0,62}" placeholder="development-db"></div><div class="field-row"><div class="field"><label>Engine</label><input value="mysql" disabled></div><div class="field"><label>Engine version</label><select name="engineVersion">${versions.map(item => `<option value="${escapeHtml(item.version)}">${escapeHtml(item.version)}</option>`).join("")}</select></div></div><div class="field-row"><div class="field"><label>DB instance class</label><select name="instanceClass">${classes.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}</select></div><div class="field"><label>Storage type</label><select name="storageType">${storageTypes.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}</select></div></div><div class="field-row"><div class="field"><label>Allocated storage (GiB)</label><input name="allocatedStorage" type="number" min="${minimumStorage}" ${maximumStorage ? `max="${maximumStorage}"` : ""} value="${minimumStorage}" required></div><div class="field"><label>Port</label><input name="port" type="number" min="1150" max="65535" value="3306" required><span class="hint">A collision fails explicitly; no fallback port is selected.</span></div></div><div class="field"><label>Initial database name (optional)</label><input name="databaseName" pattern="[A-Za-z][A-Za-z0-9_]{0,63}" placeholder="app"></div><div class="field-row"><div class="field"><label>Master username</label><input name="masterUsername" required autocomplete="username" pattern="[A-Za-z][A-Za-z0-9_]{0,15}" value="developer"></div><div class="field"><label>Master password</label><input name="masterPassword" type="password" minlength="8" maxlength="41" required autocomplete="new-password"><span class="hint">The password is never returned. It can be rotated later.</span></div></div><div class="field"><label>DB parameter group</label><select name="parameterGroup">${groups.map(group => `<option value="${escapeHtml(group.name)}">${escapeHtml(group.name)}</option>`).join("")}</select></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><label class="field checkbox-label"><input type="checkbox" name="deletionProtection" value="true"> Enable deletion protection</label><div class="alert info"><strong>Development profile</strong><br>Automated backup retention is 0, public access is off, and Multi-AZ, replicas, clusters, proxies, and production sizing are unavailable.</div>`, "Create database", async data => {
          const identifier = String(data.get("identifier"));
          const masterPassword = String(data.get("masterPassword"));
          clearPasswordInput("masterPassword");
          await rds("CreateDBInstance", {
            DBInstanceIdentifier: identifier,
            DBInstanceClass: data.get("instanceClass"),
            Engine: "mysql",
            EngineVersion: data.get("engineVersion"),
            AllocatedStorage: Number(data.get("allocatedStorage")),
            StorageType: data.get("storageType"),
            ...(String(data.get("databaseName") ?? "").trim() ? { DBName: String(data.get("databaseName")).trim() } : {}),
            MasterUsername: data.get("masterUsername"),
            MasterUserPassword: masterPassword,
            Port: Number(data.get("port")),
            DBParameterGroupName: data.get("parameterGroup"),
            BackupRetentionPeriod: 0,
            PubliclyAccessible: false,
            DeletionProtection: data.get("deletionProtection") === "true",
            Tags: parseTagInput(data.get("tags")),
          });
          context.toast("DB instance creation started");
          location.hash = `#/rds/databases/${encodeURIComponent(identifier)}/connectivity`;
        }, true);
      } catch (error) { context.showError(error); }
      finally { if (button.isConnected) button.disabled = false; }
    });
  });
}

async function databasesPage(context) {
  const [described, attributes] = await Promise.all([rds("DescribeDBInstances"), rds("DescribeAccountAttributes")]);
  const instances = parseInstances(described.xml);
  const quota = parseQuotas(attributes.xml).find(item => item.name.toLowerCase().replace(/[^a-z]/g, "") === "dbinstances");
  const used = quota?.used ?? instances.length;
  const maximum = quota?.max || 1;
  const occupied = used >= maximum;
  const occupiedElsewhere = occupied && !instances.length;
  context.setChrome("rds", ["RDS", "Databases"]);
  const createButton = `<button class="button primary" data-action="create-rds-database" ${occupied ? "disabled" : ""}>Create database</button>`;
  context.main.innerHTML = `<div class="page-width">${pageHeader("Databases", "Create and operate one local MySQL-compatible DB instance.", `<button class="button refresh" data-action="refresh">&#8635;</button><a class="button" href="#/rds/query-editor">Query editor</a>${createButton}`)}${occupiedElsewhere ? '<div class="alert info"><strong>The installation-wide DB slot is occupied</strong><br>The instance belongs to another configured Region. Switch Regions to view it, or delete it there before creating another.</div>' : ""}<section class="card"><div class="card-header"><div><h2>DB instances <span class="muted">(${instances.length})</span></h2><p class="muted small">Installation quota: ${used} of ${maximum} in use.</p></div></div><div class="toolbar"><label class="filter"><span>&#8981;</span><input data-filter-table placeholder="Find databases"></label></div><div class="table-wrap">${instances.length ? `<table><thead><tr><th>DB identifier</th><th>Status</th><th>Engine</th><th>Class</th><th>Endpoint</th><th>Port</th><th>Query</th></tr></thead><tbody>${instances.map(instance => `<tr data-search-row="${escapeHtml(`${instance.identifier} ${instance.engine} ${instance.status}`.toLowerCase())}"><td><a href="#/rds/databases/${encodeURIComponent(instance.identifier)}/connectivity">${escapeHtml(instance.identifier)}</a></td><td>${statusMarkup(instance.status)}</td><td>${escapeHtml(`${instance.engine} ${instance.engineVersion}`.trim())}</td><td>${escapeHtml(instance.instanceClass)}</td><td class="mono">${instance.status === "stopped" ? "Listener stopped" : escapeHtml(instance.endpoint?.address || "Pending readiness")}</td><td>${instance.status === "stopped" ? "-" : instance.endpoint?.port ?? "-"}</td><td><a href="#/rds/query-editor/${encodeURIComponent(instance.identifier)}">Open editor</a></td></tr>`).join("")}</tbody></table>` : emptyState("R", occupiedElsewhere ? "No DB instances in this Region" : "No databases", occupiedElsewhere ? "The single local DB instance is managed from another configured Region." : "Create a local MySQL-compatible database for development.", occupied ? "" : createButton)}</div></section></div>`;
  context.bindTableFilter();
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  bindCreateDatabase(context, occupied);
  if (instances.some(instance => transitionStatuses.has(instance.status))) scheduleRefresh(context);
}

async function snapshotsPage(context) {
  const [snapshotOutput, instanceOutput] = await Promise.all([rds("DescribeDBSnapshots"), rds("DescribeDBInstances")]);
  const snapshots = parseSnapshots(snapshotOutput.xml); const instances = parseInstances(instanceOutput.xml); const slotFree = instances.length === 0;
  context.setChrome("rds", ["RDS", "Snapshots"]);
  const sourceOptions = instances.filter(instance => ["available", "stopped"].includes(instance.status));
  context.main.innerHTML = `<div class="page-width">${pageHeader("Snapshots", "Immutable, checksummed manual recovery points for the local MySQL development profile.", `<button class="button refresh" data-action="refresh">&#8635;</button><button class="button primary" data-action="create-rds-snapshot" ${sourceOptions.length ? "" : "disabled"}>Create snapshot</button>`)}<div class="alert info"><strong>Local recovery boundary</strong><br>Snapshot publication uses a consistent stopped-provider backup, checksums, ownership markers, and atomic rename. Restore requires the one live DB slot to be free and always asks for a new master credential. Point-in-time recovery is unavailable.</div><section class="card"><div class="card-header"><div><h2>Manual snapshots <span class="muted">(${snapshots.length})</span></h2><p class="muted small">Stored under the simulator data directory; descriptor GiB is not local file size.</p></div></div><div class="table-wrap">${snapshots.length ? `<table><thead><tr><th>Snapshot</th><th>Source</th><th>Status</th><th>Created</th><th>Validated data</th><th>Checksum</th><th>Actions</th></tr></thead><tbody>${snapshots.map(snapshot => `<tr><td>${escapeHtml(snapshot.identifier)}</td><td>${escapeHtml(snapshot.sourceIdentifier)}</td><td>${statusMarkup(snapshot.status)}${snapshot.message ? `<div class="muted small">${escapeHtml(snapshot.message)}</div>` : ""}</td><td>${escapeHtml(formatDate(snapshot.createdAt))}</td><td>${snapshot.sizeBytes === undefined ? "-" : `${snapshot.sizeBytes.toLocaleString()} bytes`} · ${snapshot.fileCount ?? 0} file(s)</td><td class="mono">${escapeHtml(snapshot.checksum ? snapshot.checksum.slice(0, 16) + "…" : "-")}</td><td><button class="button small" data-copy-rds-snapshot="${escapeHtml(snapshot.identifier)}" ${snapshot.status === "available" ? "" : "disabled"}>Copy</button> <button class="button small" data-restore-rds-snapshot="${escapeHtml(snapshot.identifier)}" ${snapshot.status === "available" && slotFree ? "" : "disabled"}>Restore</button> <button class="button small danger" data-delete-rds-snapshot="${escapeHtml(snapshot.identifier)}" ${["available", "failed"].includes(snapshot.status) ? "" : "disabled"}>Delete</button></td></tr>`).join("")}</tbody></table>` : emptyState("R", "No manual snapshots", sourceOptions.length ? "Create a recovery point before a destructive schema experiment." : "Create or switch to an available/stopped DB instance before taking a snapshot.")}</div></section>${!slotFree ? '<div class="alert info"><strong>Restore is disabled while the DB slot is occupied</strong><br>Delete the current DB instance, retaining a final snapshot if needed, before restoring under a new identity.</div>' : ""}</div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  context.main.querySelector('[data-action="create-rds-snapshot"]')?.addEventListener("click", () => context.showModal("Create manual snapshot", `<div class="field"><label>Source DB instance</label><select name="source">${sourceOptions.map(instance => `<option value="${escapeHtml(instance.identifier)}">${escapeHtml(instance.identifier)} · ${escapeHtml(instance.status)}</option>`).join("")}</select></div><div class="field"><label>DB snapshot identifier</label><input name="identifier" required pattern="[a-z][a-z0-9\\-]{0,254}" placeholder="before-destructive-change"></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><div class="alert info">Active SQL connections are drained briefly while SQLite creates a consistent backup. The snapshot is not available until its manifest and file checksums validate.</div>`, "Create snapshot", async data => {
    await rds("CreateDBSnapshot", { DBInstanceIdentifier: data.get("source"), DBSnapshotIdentifier: data.get("identifier"), Tags: parseTagInput(data.get("tags")) }); context.toast("Manual snapshot published"); await context.route(false);
  }, true));
  context.main.querySelectorAll("[data-copy-rds-snapshot]").forEach(button => button.addEventListener("click", () => {
    const source = button.getAttribute("data-copy-rds-snapshot");
    context.showModal("Copy DB snapshot", `<div class="field"><label>Source snapshot</label><input value="${escapeHtml(source)}" disabled></div><div class="field"><label>Target snapshot identifier</label><input name="target" required pattern="[a-z][a-z0-9\\-]{0,254}" placeholder="${escapeHtml(source)}-copy"></div><label class="field checkbox-label"><input type="checkbox" name="copyTags" value="true" checked> Copy source tags</label><div class="field"><label>Additional tags (JSON object)</label><textarea name="tags">{}</textarea></div>`, "Copy snapshot", async data => { await rds("CopyDBSnapshot", { SourceDBSnapshotIdentifier: source, TargetDBSnapshotIdentifier: data.get("target"), CopyTags: data.get("copyTags") === "true", Tags: parseTagInput(data.get("tags")) }); context.toast("Snapshot copy published"); await context.route(false); }, true);
  }));
  context.main.querySelectorAll("[data-restore-rds-snapshot]").forEach(button => button.addEventListener("click", () => {
    const snapshot = button.getAttribute("data-restore-rds-snapshot");
    context.showModal("Restore DB snapshot", `<div class="alert info"><strong>New live identity</strong><br>The snapshot contains no credential. Choose a new identifier, loopback port, username, and password. Restore cannot run while another live DB instance owns the slot.</div><div class="field"><label>Source snapshot</label><input value="${escapeHtml(snapshot)}" disabled></div><div class="field-row"><div class="field"><label>New DB instance identifier</label><input name="identifier" required pattern="[a-z][a-z0-9\\-]{0,62}" placeholder="restored-development"></div><div class="field"><label>Port</label><input name="port" type="number" min="1150" max="65535" value="3306" required></div></div><div class="field-row"><div class="field"><label>New master username</label><input name="masterUsername" required pattern="[A-Za-z][A-Za-z0-9_]{0,15}" value="developer"></div><div class="field"><label>New master password</label><input name="restoreMasterPassword" type="password" minlength="8" maxlength="41" required autocomplete="new-password"></div></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>`, "Restore snapshot", async data => {
      const password = String(data.get("restoreMasterPassword")); clearPasswordInput("restoreMasterPassword");
      await rds("RestoreDBInstanceFromDBSnapshot", { DBInstanceIdentifier: data.get("identifier"), DBSnapshotIdentifier: snapshot, DBInstanceClass: "db.t3.micro", Port: Number(data.get("port")), MasterUsername: data.get("masterUsername"), MasterUserPassword: password, PubliclyAccessible: false, MultiAZ: false, Tags: parseTagInput(data.get("tags")) }); context.toast("Snapshot restore started"); location.hash = `#/rds/databases/${encodeURIComponent(data.get("identifier"))}/connectivity`;
    }, true);
  }));
  context.main.querySelectorAll("[data-delete-rds-snapshot]").forEach(button => button.addEventListener("click", () => { const identifier = button.getAttribute("data-delete-rds-snapshot"); typedAction(context, { title: "Delete DB snapshot", identifier, message: `Delete immutable snapshot ${identifier} and its exact owned local files?`, submitLabel: "Delete snapshot", onSubmit: async () => { await rds("DeleteDBSnapshot", { DBSnapshotIdentifier: identifier }); context.toast("DB snapshot deleted"); await context.route(false); } }); }));
  if (snapshots.some(snapshot => transitionStatuses.has(snapshot.status))) scheduleRefresh(context);
}

function connectivityContent(instance) {
  if (instance.status !== "available" || !instance.endpoint?.address || !instance.endpoint.port) {
    const stopped = instance.status === "stopped";
    return `<section class="card"><div class="card-header"><h2>Endpoint and connection</h2></div><div class="card-body">${emptyState("R", stopped ? "Database listener is stopped" : "Database connection is not ready", stopped ? "Start the DB instance to restore authenticated SQL connectivity. Its data and installation-wide lease are preserved." : "The local provider must complete an authenticated readiness check before its endpoint can be used.")}</div></section>`;
  }
  const databaseArgument = instance.databaseName ? ` ${instance.databaseName}` : "";
  const mysql = `mysql -h ${instance.endpoint.address} -P ${instance.endpoint.port} -u ${instance.masterUsername} -p${databaseArgument}`;
  const node = `import mysql from "mysql2/promise";\n\nconst connection = await mysql.createConnection({\n  host: "${instance.endpoint.address}",\n  port: ${instance.endpoint.port},\n  user: "${instance.masterUsername}",\n  password: process.env.DB_PASSWORD,${instance.databaseName ? `\n  database: "${instance.databaseName}",` : ""}\n});`;
  return `<section class="card"><div class="card-header"><h2>Endpoint and connection</h2></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Endpoint</dt><dd class="mono">${escapeHtml(instance.endpoint.address)}</dd></dl><dl class="key-value"><dt>Port</dt><dd>${instance.endpoint.port}</dd></dl><dl class="key-value"><dt>Network access</dt><dd>Loopback only</dd></dl></div><div class="alert info"><strong>Separate authentication layers</strong><br>The RDS control plane uses simulator authorization. SQL clients authenticate independently with the MySQL master username and password.</div><h3>MySQL client</h3><pre class="code-box">${escapeHtml(mysql)}</pre><button class="button" data-copy="${escapeHtml(mysql)}">Copy mysql command</button><h3>Node.js with mysql2</h3><pre class="code-box">${escapeHtml(node)}</pre><button class="button" data-copy="${escapeHtml(node)}">Copy Node.js example</button></div></section>`;
}

function pendingMarkup(instance) {
  const entries = [
    instance.pending.allocatedStorage === undefined ? undefined : ["Allocated storage", `${instance.pending.allocatedStorage} GiB descriptor`],
    instance.pending.instanceClass === undefined ? undefined : ["DB instance class", instance.pending.instanceClass],
    instance.pending.storageType === undefined ? undefined : ["Storage type", instance.pending.storageType],
    instance.pending.port === undefined ? undefined : ["Port", String(instance.pending.port)],
  ].filter(Boolean);
  if (!entries.length && instance.status !== "modifying") return "";
  return `<section class="card"><div class="card-header"><h2>Pending modifications</h2></div><div class="card-body">${entries.length ? `<dl class="key-value">${entries.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>` : ""}<div class="alert info"><strong>Credential-safe progress</strong><br>Changes are applied according to their apply-immediately or reboot rules. Password values are never returned or rendered.</div></div></section>`;
}

function configurationContent(instance) {
  const group = instance.parameterGroups[0] ?? { name: "default.mysql8.0", status: "in-sync" };
  return `<section class="card"><div class="card-header"><h2>Instance configuration</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Engine</dt><dd>${escapeHtml(instance.engine)}</dd><dt>Engine version</dt><dd>${escapeHtml(instance.engineVersion)}</dd><dt>DB instance class</dt><dd>${escapeHtml(instance.instanceClass)}</dd><dt>Availability Zone</dt><dd>${escapeHtml(instance.availabilityZone || `${session.region}-local`)}</dd></dl><dl class="key-value"><dt>Initial database</dt><dd>${escapeHtml(instance.databaseName || "-")}</dd><dt>Master username</dt><dd>${escapeHtml(instance.masterUsername)}</dd><dt>Publicly accessible</dt><dd>${instance.publiclyAccessible ? "Yes" : "No"}</dd><dt>Multi-AZ</dt><dd>${instance.multiAz ? "Yes" : "No"}</dd></dl><dl class="key-value"><dt>Allocated storage</dt><dd>${instance.allocatedStorage ?? "-"} GiB descriptor</dd><dt>Storage type</dt><dd>${escapeHtml(instance.storageType)}</dd><dt>Deletion protection</dt><dd>${instance.deletionProtection ? "On" : "Off"}</dd><dt>Parameter group</dt><dd><a href="#/rds/parameter-groups/${encodeURIComponent(group.name)}">${escapeHtml(group.name)}</a> · ${statusMarkup(group.status)}</dd></dl></div><div class="card-body"><dl class="key-value"><dt>DB instance ARN</dt><dd class="mono">${escapeHtml(instance.arn)}</dd><dt>Resource ID</dt><dd class="mono">${escapeHtml(instance.resourceId)}</dd><dt>Created</dt><dd>${escapeHtml(formatDate(instance.createdAt))}</dd></dl></div></section>${pendingMarkup(instance)}`;
}

function tagsContent(tags, editable = true) {
  return `<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${tags.length})</span></h2>${editable ? '<button class="button" data-action="edit-rds-tags">Manage tags</button>' : ""}</div><div class="table-wrap">${tags.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(tag => `<tr><td>${escapeHtml(tag.Key)}</td><td>${escapeHtml(tag.Value)}</td></tr>`).join("")}</tbody></table>` : emptyState("R", "No tags", editable ? "Add tags to organize the local resource and drive IAM resource-tag conditions." : "This provider-owned resource has no editable tags.")}</div></section>`;
}

function bindTagEditor(context, arn, currentTags) {
  context.main.querySelector('[data-action="edit-rds-tags"]')?.addEventListener("click", () => context.showModal("Manage tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(tagsObject(currentTags), null, 2))}</textarea><span class="hint">Removing a key here removes the RDS tag. Keys and values are validated by the service.</span></div>`, "Save tags", async data => {
    const desired = parseTagInput(data.get("tags"));
    const desiredMap = tagsObject(desired);
    const currentMap = tagsObject(currentTags);
    const removed = Object.keys(currentMap).filter(key => !Object.hasOwn(desiredMap, key));
    const added = desired.filter(tag => currentMap[tag.Key] !== tag.Value);
    if (removed.length) await rds("RemoveTagsFromResource", { ResourceName: arn, TagKeys: removed });
    if (added.length) await rds("AddTagsToResource", { ResourceName: arn, Tags: added });
    context.toast("RDS tags updated");
  }, true));
}

function diagnosticContent(instance) {
  const diagnostics = [...instance.statusInfos.map(info => ({ normal: info.normal, message: `${info.type || "Provider"}: ${info.message || (info.normal ? "Ready" : "Unavailable")}` }))];
  if (instance.providerStatus || instance.providerMessage) diagnostics.push({ normal: instance.providerStatus === "available" || instance.providerStatus === "ready", message: `${instance.providerStatus || "Provider"}: ${instance.providerMessage || "No additional diagnostic"}` });
  if (!diagnostics.length) return "";
  return `<div class="alert ${diagnostics.every(item => item.normal) ? "success" : "error"}"><strong>Local provider status</strong><br>${diagnostics.map(item => escapeHtml(item.message)).join("<br>")}</div>`;
}

async function openEditDatabase(context, instance) {
  const button = context.main.querySelector('[data-action="edit-rds-database"]');
  if (button) button.disabled = true;
  try {
    const [, groupsOutput] = await Promise.all([rds("DescribeValidDBInstanceModifications", { DBInstanceIdentifier: instance.identifier }), rds("DescribeDBParameterGroups")]);
    const groups = parseParameterGroups(groupsOutput.xml);
    const selectedGroup = instance.parameterGroups[0]?.name ?? "default.mysql8.0";
    context.showModal("Modify DB instance", `<div class="alert info"><strong>Apply rules</strong><br>Password rotation is applied without returning the credential. Port and descriptor changes can be applied now or left pending for reboot. A failed port move keeps the old working listener.</div><div class="field-row"><div class="field"><label>DB instance class</label><select name="instanceClass"><option value="db.t3.micro">db.t3.micro</option></select></div><div class="field"><label>Allocated storage (GiB descriptor)</label><input name="allocatedStorage" type="number" min="20" max="65536" value="${instance.pending.allocatedStorage ?? instance.allocatedStorage}" required></div></div><div class="field-row"><div class="field"><label>Storage type</label><select name="storageType"><option value="gp2" ${(instance.pending.storageType ?? instance.storageType) === "gp2" ? "selected" : ""}>gp2</option><option value="gp3" ${(instance.pending.storageType ?? instance.storageType) === "gp3" ? "selected" : ""}>gp3</option></select></div><div class="field"><label>Port</label><input name="port" type="number" min="1150" max="65535" value="${instance.pending.port ?? instance.endpoint?.port ?? 3306}" required></div></div><div class="field"><label>New master password (optional)</label><input name="newMasterPassword" type="password" minlength="8" maxlength="41" autocomplete="new-password"><span class="hint">Leave blank to keep the current password. The submitted value is cleared from the form immediately.</span></div><div class="field"><label>DB parameter group</label><select name="parameterGroup">${groups.map(group => `<option value="${escapeHtml(group.name)}" ${group.name === selectedGroup ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("")}</select></div><label class="field checkbox-label"><input type="checkbox" name="deletionProtection" value="true" ${instance.deletionProtection ? "checked" : ""}> Enable deletion protection</label><label class="field checkbox-label"><input type="checkbox" name="applyImmediately" value="true" checked> Apply descriptor and port changes immediately</label>`, "Modify DB instance", async data => {
      const password = String(data.get("newMasterPassword") ?? "");
      clearPasswordInput("newMasterPassword");
      await rds("ModifyDBInstance", {
        DBInstanceIdentifier: instance.identifier,
        DBInstanceClass: data.get("instanceClass"),
        AllocatedStorage: Number(data.get("allocatedStorage")),
        StorageType: data.get("storageType"),
        DBPortNumber: Number(data.get("port")),
        DBParameterGroupName: data.get("parameterGroup"),
        DeletionProtection: data.get("deletionProtection") === "true",
        ApplyImmediately: data.get("applyImmediately") === "true",
        ...(password ? { MasterUserPassword: password } : {}),
      });
      context.toast("DB instance modification submitted");
    }, true);
  } catch (error) { context.showError(error); }
  finally { if (button?.isConnected) button.disabled = false; }
}

async function databaseDetail(context, identifier, active) {
  const output = await rds("DescribeDBInstances", { DBInstanceIdentifier: identifier });
  const instance = parseInstances(output.xml)[0];
  if (!instance) throw new Error(`DB instance ${identifier} was not found`);
  if (active === "tags") instance.tags = parseTags((await rds("ListTagsForResource", { ResourceName: instance.arn })).xml);
  context.setChrome("rds", ["RDS", "Databases", identifier]);
  const transitioning = transitionStatuses.has(instance.status);
  const canEdit = new Set(["available", "stopped"]).has(instance.status);
  const canStop = instance.status === "available";
  const canStart = instance.status === "stopped";
  const deleteDisabled = transitioning || instance.deletionProtection;
  context.main.innerHTML = `<div class="page-width">${pageHeader(instance.identifier, `MySQL DB instance in ${escapeHtml(session.region)}.`, `<button class="button" data-action="refresh">Refresh</button><a class="button" href="#/rds/query-editor/${encodeURIComponent(identifier)}">Query editor</a><button class="button" data-action="create-rds-snapshot" ${canEdit ? "" : "disabled"}>Take snapshot</button><button class="button" data-action="edit-rds-database" ${canEdit ? "" : "disabled"}>Edit</button>${canStart ? '<button class="button primary" data-action="start-rds-database">Start</button>' : '<button class="button" data-action="stop-rds-database" ' + (canStop ? "" : "disabled") + '>Stop</button>'}<button class="button" data-action="reboot-rds-database" ${canStop ? "" : "disabled"}>Reboot</button><button class="button danger" data-action="delete-rds-database" ${deleteDisabled ? "disabled" : ""}>Delete</button>`)}${instance.deletionProtection ? '<div class="alert info"><strong>Deletion protection is on</strong><br>Edit this DB instance and turn deletion protection off before deleting it.</div>' : ""}${diagnosticContent(instance)}<div class="card"><div class="card-body detail-grid"><dl class="key-value"><dt>Status</dt><dd>${statusMarkup(instance.status)}</dd></dl><dl class="key-value"><dt>Engine</dt><dd>${escapeHtml(`${instance.engine} ${instance.engineVersion}`.trim())}</dd></dl><dl class="key-value"><dt>Endpoint</dt><dd class="mono">${instance.status === "stopped" ? "Listener stopped" : escapeHtml(instance.endpoint?.address || "Pending readiness") + (instance.endpoint?.port ? `:${instance.endpoint.port}` : "")}</dd></dl></div></div>${databaseTabs(identifier, active)}${active === "connectivity" ? connectivityContent(instance) : active === "configuration" ? configurationContent(instance) : tagsContent(instance.tags)}</div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  context.main.querySelector('[data-action="edit-rds-database"]')?.addEventListener("click", () => void openEditDatabase(context, instance));
  context.main.querySelector('[data-action="create-rds-snapshot"]')?.addEventListener("click", () => context.showModal("Create manual snapshot", `<div class="field"><label>Source DB instance</label><input value="${escapeHtml(identifier)}" disabled></div><div class="field"><label>DB snapshot identifier</label><input name="identifier" required pattern="[a-z][a-z0-9\\-]{0,254}" placeholder="${escapeHtml(identifier)}-manual"></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><div class="alert info">The listener is drained briefly, and the snapshot is published only after its ownership manifest and checksums validate.</div>`, "Create snapshot", async data => { await rds("CreateDBSnapshot", { DBInstanceIdentifier: identifier, DBSnapshotIdentifier: data.get("identifier"), Tags: parseTagInput(data.get("tags")) }); context.toast("Manual snapshot published"); location.hash = "#/rds/snapshots"; }, true));
  context.main.querySelector('[data-action="stop-rds-database"]')?.addEventListener("click", () => typedAction(context, { title: "Stop DB instance", identifier, message: `Stop ${identifier}? The SQL listener closes while data and the singleton lease remain.`, submitLabel: "Stop", onSubmit: async () => { await rds("StopDBInstance", { DBInstanceIdentifier: identifier }); context.toast("DB instance is stopping"); } }));
  context.main.querySelector('[data-action="start-rds-database"]')?.addEventListener("click", () => typedAction(context, { title: "Start DB instance", identifier, message: `Start ${identifier} and restore authenticated SQL connectivity?`, submitLabel: "Start", danger: false, onSubmit: async () => { await rds("StartDBInstance", { DBInstanceIdentifier: identifier }); context.toast("DB instance is starting"); } }));
  context.main.querySelector('[data-action="reboot-rds-database"]')?.addEventListener("click", () => typedAction(context, { title: "Reboot DB instance", identifier, message: `Reboot ${identifier}? Active SQL connections are drained and pending reboot changes are applied.`, submitLabel: "Reboot", onSubmit: async () => { await rds("RebootDBInstance", { DBInstanceIdentifier: identifier }); context.toast("DB instance is rebooting"); } }));
  context.main.querySelector('[data-action="delete-rds-database"]')?.addEventListener("click", () => context.showModal("Delete DB instance", `<div class="alert error"><strong>Destructive operation</strong><br>Choose a final immutable snapshot or explicitly skip it. Deletion starts only after a requested final snapshot is fully published and validated.</div><div class="field"><label>Snapshot choice</label><select name="snapshotChoice"><option value="final">Create final snapshot</option><option value="skip">Skip final snapshot</option></select></div><div class="field"><label>Final DB snapshot identifier</label><input name="finalSnapshotIdentifier" pattern="[a-z][a-z0-9\\-]{0,254}" value="${escapeHtml(identifier)}-final"></div><div class="field"><label>To confirm, enter <strong>${escapeHtml(identifier)}</strong></label><input name="confirmation" required autocomplete="off"></div>`, "Delete DB instance", async data => {
    if (data.get("confirmation") !== identifier) throw new Error(`Enter ${identifier} to confirm`);
    const skip = data.get("snapshotChoice") === "skip"; const finalIdentifier = String(data.get("finalSnapshotIdentifier") ?? "").trim();
    if (!skip && !finalIdentifier) throw new Error("Enter a final DB snapshot identifier or choose Skip final snapshot");
    await rds("DeleteDBInstance", { DBInstanceIdentifier: identifier, SkipFinalSnapshot: skip, ...(!skip ? { FinalDBSnapshotIdentifier: finalIdentifier } : {}) }); context.toast(skip ? "DB instance deletion started" : "Final snapshot published; DB instance deletion started"); location.hash = "#/rds/databases";
  }, false, { danger: true }));
  if (active === "tags") bindTagEditor(context, instance.arn, instance.tags);
  if (transitioning) scheduleRefresh(context);
}

async function parameterGroupsPage(context) {
  const groups = parseParameterGroups((await rds("DescribeDBParameterGroups")).xml);
  context.setChrome("rds", ["RDS", "Parameter groups"]);
  context.main.innerHTML = `<div class="page-width">${pageHeader("Parameter groups", "Manage the documented safe local MySQL parameter allowlist.", '<button class="button refresh" data-action="refresh">&#8635;</button><button class="button primary" data-action="create-rds-parameter-group">Create parameter group</button>')}<div class="alert info"><strong>Safe development subset</strong><br>Filesystem paths, plugin loading, non-loopback networking, external replication, audit-output paths, and provider-ownership options are not exposed.</div><section class="card"><div class="card-header"><h2>DB parameter groups <span class="muted">(${groups.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Family</th><th>Description</th></tr></thead><tbody>${groups.map(group => `<tr><td><a href="#/rds/parameter-groups/${encodeURIComponent(group.name)}">${escapeHtml(group.name)}</a></td><td>${escapeHtml(group.family)}</td><td>${escapeHtml(group.description)}</td></tr>`).join("")}</tbody></table></div></section></div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  context.main.querySelector('[data-action="create-rds-parameter-group"]')?.addEventListener("click", () => context.showModal("Create DB parameter group", '<div class="field"><label>Name</label><input name="name" required pattern="[a-z][a-z0-9\\-]{0,254}" placeholder="development-mysql"></div><div class="field"><label>Parameter group family</label><input name="family" value="mysql8.0" readonly></div><div class="field"><label>Description</label><input name="description" maxlength="255" required placeholder="Safe development overrides"></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>', "Create parameter group", async data => {
    const name = String(data.get("name"));
    await rds("CreateDBParameterGroup", { DBParameterGroupName: name, DBParameterGroupFamily: "mysql8.0", Description: data.get("description"), Tags: parseTagInput(data.get("tags")) });
    context.toast("DB parameter group created");
    location.hash = `#/rds/parameter-groups/${encodeURIComponent(name)}`;
  }, true));
}

async function parameterGroupDetail(context, name) {
  const groupOutput = await rds("DescribeDBParameterGroups", { DBParameterGroupName: name });
  const group = parseParameterGroups(groupOutput.xml)[0];
  if (!group) throw new Error(`DB parameter group ${name} was not found`);
  const isDefault = group.name === "default.mysql8.0";
  const requests = [rds("DescribeDBParameters", { DBParameterGroupName: group.name }), rds("DescribeEngineDefaultParameters", { DBParameterGroupFamily: group.family }), rds("DescribeDBInstances")];
  if (!isDefault) requests.push(rds("ListTagsForResource", { ResourceName: group.arn }));
  const [parametersOutput, defaultsOutput, instancesOutput, tagsOutput] = await Promise.all(requests);
  const parameters = parseParameters(parametersOutput.xml);
  const defaults = new Map(parseParameters(defaultsOutput.xml).map(parameter => [parameter.name, parameter.value]));
  const association = parseInstances(instancesOutput.xml).find(instance => instance.parameterGroups.some(candidate => candidate.name === group.name));
  const groupTags = tagsOutput ? parseTags(tagsOutput.xml) : [];
  context.setChrome("rds", ["RDS", "Parameter groups", group.name]);
  const actions = isDefault ? '<button class="button" data-action="refresh">Refresh</button>' : '<button class="button" data-action="refresh">Refresh</button><button class="button" data-action="reset-all-rds-parameters">Reset all</button><button class="button danger" data-action="delete-rds-parameter-group">Delete</button>';
  context.main.innerHTML = `<div class="page-width">${pageHeader(group.name, group.description, actions)}<div class="card"><div class="card-body detail-grid"><dl class="key-value"><dt>Family</dt><dd>${escapeHtml(group.family)}</dd><dt>Type</dt><dd>${isDefault ? "Provider-owned default" : "Custom"}</dd></dl><dl class="key-value"><dt>Association</dt><dd>${association ? `<a href="#/rds/databases/${encodeURIComponent(association.identifier)}/configuration">${escapeHtml(association.identifier)}</a> · ${statusMarkup(association.parameterGroups.find(candidate => candidate.name === group.name)?.status)}` : "Not associated"}</dd></dl><dl class="key-value"><dt>ARN</dt><dd class="mono">${escapeHtml(group.arn)}</dd></dl></div></div><section class="card"><div class="card-header"><div><h2>Parameters <span class="muted">(${parameters.length})</span></h2><p class="muted small">Immediate dynamic changes briefly restart the managed listener with rollback protection. Static values require a reboot.</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Value</th><th>Default</th><th>Source</th><th>Type</th><th>Allowed</th><th>Actions</th></tr></thead><tbody>${parameters.map(parameter => `<tr><td class="mono">${escapeHtml(parameter.name)}</td><td>${escapeHtml(parameter.value)}</td><td>${escapeHtml(defaults.get(parameter.name) ?? "-")}</td><td>${escapeHtml(parameter.source)}</td><td>${escapeHtml(`${parameter.applyType} · ${parameter.dataType}`)}</td><td>${escapeHtml(parameter.allowedValues)}</td><td>${!isDefault && parameter.modifiable ? `<button class="button small" data-edit-rds-parameter="${escapeHtml(parameter.name)}">Edit</button>${parameter.source === "user" ? ` <button class="button small" data-reset-rds-parameter="${escapeHtml(parameter.name)}">Reset</button>` : ""}` : "Managed"}</td></tr>`).join("")}</tbody></table></div></section>${tagsContent(groupTags, !isDefault)}</div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  context.main.querySelectorAll("[data-edit-rds-parameter]").forEach(button => button.addEventListener("click", () => {
    const parameter = parameters.find(candidate => candidate.name === button.getAttribute("data-edit-rds-parameter"));
    if (!parameter) return;
    const staticParameter = parameter.applyType === "static";
    context.showModal(`Edit parameter · ${parameter.name}`, `<div class="alert info">${escapeHtml(parameter.description)}${staticParameter ? " This static value remains pending until reboot." : " Immediate apply briefly interrupts the SQL listener; the provider rolls back if restart readiness fails."}</div><div class="field"><label>Value</label><input name="value" value="${escapeHtml(parameter.value)}" required><span class="hint">Allowed: ${escapeHtml(parameter.allowedValues)}</span></div><div class="field"><label>Apply method</label><select name="applyMethod">${staticParameter ? '<option value="pending-reboot">Pending reboot</option>' : '<option value="immediate">Immediate</option><option value="pending-reboot">Pending reboot</option>'}</select></div>`, "Save parameter", async data => {
      await rds("ModifyDBParameterGroup", { DBParameterGroupName: group.name, Parameters: [{ ParameterName: parameter.name, ParameterValue: data.get("value"), ApplyMethod: data.get("applyMethod") }] });
      context.toast(`Parameter ${parameter.name} updated`);
    });
  }));
  context.main.querySelectorAll("[data-reset-rds-parameter]").forEach(button => button.addEventListener("click", () => {
    const parameter = parameters.find(candidate => candidate.name === button.getAttribute("data-reset-rds-parameter"));
    if (!parameter) return;
    typedAction(context, { title: "Reset DB parameter", identifier: group.name, message: `Reset ${parameter.name} to its engine default in ${group.name}?`, submitLabel: "Reset parameter", onSubmit: async () => {
      await rds("ResetDBParameterGroup", { DBParameterGroupName: group.name, Parameters: [{ ParameterName: parameter.name, ApplyMethod: parameter.applyType === "static" ? "pending-reboot" : "immediate" }] });
      context.toast(`Parameter ${parameter.name} reset`);
    } });
  }));
  context.main.querySelector('[data-action="reset-all-rds-parameters"]')?.addEventListener("click", () => typedAction(context, { title: "Reset all DB parameters", identifier: group.name, message: `Reset every override in ${group.name} to its safe engine default?`, submitLabel: "Reset all", onSubmit: async () => {
    await rds("ResetDBParameterGroup", { DBParameterGroupName: group.name, ResetAllParameters: true });
    context.toast("All DB parameters reset");
  } }));
  context.main.querySelector('[data-action="delete-rds-parameter-group"]')?.addEventListener("click", () => typedAction(context, { title: "Delete DB parameter group", identifier: group.name, message: `Delete ${group.name}? Associated groups must be detached first.`, submitLabel: "Delete", onSubmit: async () => {
    await rds("DeleteDBParameterGroup", { DBParameterGroupName: group.name });
    context.toast("DB parameter group deleted");
    location.hash = "#/rds/parameter-groups";
  } }));
  if (!isDefault) bindTagEditor(context, group.arn, groupTags);
}

export async function routeRds(parts, context) {
  const render = async pending => {
    const result = await pending;
    decorateRdsPanelHelp(context.main);
    return result;
  };
  if (parts.length === 1 || (parts[1] === "databases" && parts.length === 2)) return render(databasesPage(context));
  if (parts[1] === "snapshots" && parts.length === 2) return render(snapshotsPage(context));
  if (parts[1] === "query-editor") {
    if (parts.length === 2 || parts.length === 3) return render(rdsQueryEditor(context, parts[2]));
    return context.notFound(parts);
  }
  if (parts[1] === "parameter-groups") {
    if (parts.length === 2) return render(parameterGroupsPage(context));
    if (parts.length === 3) return render(parameterGroupDetail(context, parts[2]));
    return context.notFound(parts);
  }
  if (parts[1] !== "databases" || !parts[2] || parts.length > 4) return context.notFound(parts);
  const active = parts[3] ?? "connectivity";
  if (!["connectivity", "configuration", "tags"].includes(active)) return context.notFound(parts);
  return render(databaseDetail(context, parts[2], active));
}
