import { dynamo } from "../api-client.js";
import { escapeHtml, pageHeader } from "../components.js";
import { session, setDirty } from "../state.js";

let indexRowId = 0;
let tagRowId = 0;

const keyTypeOptions = (selected = "S") => ["S", "N", "B"].map(type => `<option value="${type}" ${type === selected ? "selected" : ""}>${{ S: "String", N: "Number", B: "Binary" }[type]}</option>`).join("");

function capacitySide(side) {
  const id = `create-${side}-capacity`; const label = side === "read" ? "Read" : "Write";
  return `<div class="create-capacity-side" data-capacity-side="${side}"><h4>${label} capacity</h4><fieldset class="radio-list"><legend class="sr-only">${label} auto scaling</legend><label class="radio-label"><input type="radio" name="${side}AutoScaling" value="on" checked> Auto scaling on</label><label class="radio-label"><input type="radio" name="${side}AutoScaling" value="off"> Auto scaling off</label></fieldset><div class="field-row" data-auto-scaling-fields="${side}"><div class="field"><label for="${id}-min">Minimum capacity units</label><input id="${id}-min" name="${side}Min" type="number" min="1" value="1"></div><div class="field"><label for="${id}-max">Maximum capacity units</label><input id="${id}-max" name="${side}Max" type="number" min="1" value="10"></div><div class="field"><label for="${id}-target">Target utilization (%)</label><input id="${id}-target" name="${side}Target" type="number" min="20" max="90" value="70"></div></div><div class="field" data-provisioned-fields="${side}" hidden><label for="${id}-units">Provisioned capacity units</label><input id="${id}-units" name="${side}Units" type="number" min="1" value="5"><span class="hint">${label} capacity units allocated to the table and, by default, to each global secondary index.</span></div></div>`;
}

export async function enhancedDynamoCreateTable(context) {
  const { main, setChrome, showError, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "Tables", "Create table"]);
  main.innerHTML = `<div class="page-width create-table-page"><form id="create-table-form">${pageHeader("Create table", "Create a DynamoDB table with a primary key and optional indexes.")}<div id="create-table-error" class="alert error" role="alert" tabindex="-1" hidden></div>
<section class="card"><div class="card-header"><div><h2>Table details</h2><p class="muted small">DynamoDB is a schemaless database that requires only a table name and a primary key when you create the table.</p></div></div><div class="card-body"><div class="field"><label for="create-table-name">Table name</label><span class="field-description">This will be used to identify your table.</span><input id="create-table-name" name="name" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="Music"><span class="hint">Between 3 and 255 characters, containing only letters, numbers, underscores (_), hyphens (-), and periods (.).</span></div><hr class="form-divider"><div class="create-key-section"><h3>Partition key</h3><p class="muted small">The partition key is part of the table's primary key. It is used to retrieve items and distribute data for scalability and availability.</p><div class="field-row create-key-fields"><div class="field"><label for="create-partition-key">Partition key</label><input id="create-partition-key" name="partition" required maxlength="255" placeholder="Artist"><span class="hint">1 to 255 characters and case sensitive.</span></div><div class="field"><label for="create-partition-type">Data type</label><select id="create-partition-type" name="partitionType">${keyTypeOptions()}</select></div></div></div><div class="create-key-section"><h3>Sort key <span class="muted small">– optional</span></h3><p class="muted small">Use a sort key as the second part of the primary key to sort or search items that share the same partition key.</p><div class="field-row create-key-fields"><div class="field"><label for="create-sort-key">Sort key</label><input id="create-sort-key" name="sort" maxlength="255" placeholder="SongTitle"><span class="hint">1 to 255 characters and case sensitive.</span></div><div class="field"><label for="create-sort-type">Data type</label><select id="create-sort-type" name="sortType">${keyTypeOptions()}</select></div></div></div></div></section>
<section class="card"><div class="card-header"><div><h2>Table settings</h2><p class="muted small">Default settings are the fastest way to create a table. Customize settings to choose the table class, capacity, indexes, encryption, and protection up front.</p></div></div><div class="card-body"><fieldset class="setting-options"><legend class="sr-only">Table settings</legend><label class="setting-option"><input type="radio" name="settingsMode" value="default" checked><span><strong>Default settings</strong><small>The fastest way to create your table. On-demand capacity, DynamoDB Standard table class, no secondary indexes, encryption owned by Amazon DynamoDB, and deletion protection off. You can change most settings after the table is created.</small></span></label><label class="setting-option"><input type="radio" name="settingsMode" value="customize"><span><strong>Customize settings</strong><small>Use these advanced features to make DynamoDB work better for your needs.</small></span></label></fieldset><div id="create-default-summary" class="create-default-summary"><dl class="key-value"><dt>Table class</dt><dd>DynamoDB Standard</dd><dt>Capacity mode</dt><dd>On-demand</dd><dt>Secondary indexes</dt><dd>None</dd><dt>Encryption key management</dt><dd>Owned by Amazon DynamoDB</dd><dt>Deletion protection</dt><dd>Off</dd></dl></div></div></section>
<div id="create-customize-sections" hidden>
<section class="card"><div class="card-header"><div><h2>Table class</h2><p class="muted small">Choose a table class that best matches your workload's storage and throughput pattern. The table class can be changed later.</p></div></div><div class="card-body"><fieldset class="setting-options"><legend class="sr-only">Table class</legend><label class="setting-option"><input type="radio" name="tableClass" value="STANDARD" checked><span><strong>DynamoDB Standard</strong><small>General-purpose table class for the majority of workloads.</small></span></label><label class="setting-option"><input type="radio" name="tableClass" value="STANDARD_INFREQUENT_ACCESS"><span><strong>DynamoDB Standard-IA</strong><small>Lower storage cost for tables that store data accessed infrequently.</small></span></label></fieldset></div></section>
<section class="card"><div class="card-header"><div><h2>Read/write capacity settings</h2><p class="muted small">Choose how the table handles throughput. Capacity mode can be changed once every 24 hours in AWS; locally there is no charge and throttling is optional.</p></div></div><div class="card-body"><fieldset class="setting-options"><legend class="sr-only">Capacity mode</legend><label class="setting-option"><input type="radio" name="capacityMode" value="PAY_PER_REQUEST" checked><span><strong>On-demand</strong><small>Simplified billing based on actual reads and writes. Ideal for unpredictable or spiky workloads.</small></span></label><label class="setting-option"><input type="radio" name="capacityMode" value="PROVISIONED"><span><strong>Provisioned</strong><small>Specify read and write capacity units, optionally adjusted by auto scaling.</small></span></label></fieldset><div data-capacity-section="PAY_PER_REQUEST"><h3>Maximum table throughput <span class="muted small">– optional</span></h3><label class="checkbox-label"><input type="checkbox" name="onDemandMax" value="yes"> Set a maximum number of read and write request units per second</label><div class="field-row" data-on-demand-max-fields hidden><div class="field"><label for="create-max-read">Maximum read request units</label><input id="create-max-read" name="maxRead" type="number" min="1" placeholder="Unlimited"></div><div class="field"><label for="create-max-write">Maximum write request units</label><input id="create-max-write" name="maxWrite" type="number" min="1" placeholder="Unlimited"></div></div></div><div data-capacity-section="PROVISIONED" hidden><div class="create-capacity-grid">${capacitySide("read")}${capacitySide("write")}</div><div class="alert info"><strong>Configuration storage only</strong><br>Auto scaling targets are stored through the DynamoDB API for learning and inspection. No Application Auto Scaling controller adjusts capacity locally.</div></div></div></section>
<section class="card"><div class="card-header"><div><h2>Secondary indexes <span class="muted small">– optional</span></h2><p class="muted small">Add global or local secondary indexes with explicit key types and attribute projections. Local secondary indexes can be created only with the table.</p></div><div class="actions"><button class="button" type="button" id="add-create-local-index">Create local index</button><button class="button" type="button" id="add-create-index">Create global index</button></div></div><div class="card-body"><div id="create-index-rows"><p class="muted" id="no-create-indexes">No secondary indexes configured.</p></div></div></section>
<section class="card"><div class="card-header"><div><h2>Encryption at rest</h2><p class="muted small">All user data stored in Amazon DynamoDB is fully encrypted at rest. Choose who manages the encryption key.</p></div></div><div class="card-body"><fieldset class="radio-list"><legend class="sr-only">Encryption key management</legend><label class="radio-label"><input type="radio" name="encryption" value="OWNED" checked> <span><strong>Owned by Amazon DynamoDB</strong><br><small class="muted">The key is owned and managed by DynamoDB at no additional cost.</small></span></label><label class="radio-label"><input type="radio" name="encryption" value="AWS_MANAGED"> <span><strong>AWS managed key</strong><br><small class="muted">The key is stored in your account and managed by AWS Key Management Service (aws/dynamodb).</small></span></label><label class="radio-label"><input type="radio" name="encryption" value="CUSTOMER_MANAGED"> <span><strong>Stored in your account, and owned and managed by you</strong><br><small class="muted">A customer managed key in AWS KMS.</small></span></label></fieldset><div class="field" data-kms-key-field hidden><label for="create-kms-key">KMS key</label><input id="create-kms-key" name="kmsKey" placeholder="alias/my-key or key ARN"></div><div class="alert info"><strong>Local encryption boundary</strong><br>Local table files are protected by filesystem permissions. KMS selections are persisted as dependency-blocked configuration and are not reported as active encryption.</div></div></section>
<section class="card"><div class="card-header"><div><h2>Deletion protection</h2><p class="muted small">Protect this table from being accidentally deleted. Deletion protection can be turned off later.</p></div></div><div class="card-body"><label class="checkbox-label"><input type="checkbox" name="deletionProtection" value="yes"> Turn on deletion protection</label></div></section>
<section class="card"><div class="card-header"><div><h2>Warm throughput <span class="muted small">– optional</span></h2><p class="muted small">Pre-warm the table so it can instantly serve a higher number of reads and writes per second.</p></div></div><div class="card-body"><div class="field-row"><div class="field"><label for="create-warm-read">Read units per second</label><input id="create-warm-read" name="warmRead" type="number" min="12000" placeholder="12000"></div><div class="field"><label for="create-warm-write">Write units per second</label><input id="create-warm-write" name="warmWrite" type="number" min="4000" placeholder="4000"></div></div></div></section>
<section class="card"><div class="card-header"><div><h2>Resource-based policy <span class="muted small">– optional</span></h2><p class="muted small">Attach a policy document that grants or denies access to this table and its indexes.</p></div></div><div class="card-body"><div class="field"><label for="create-resource-policy">Policy document (JSON)</label><textarea id="create-resource-policy" name="resourcePolicy" class="code-editor" spellcheck="false" placeholder='{"Version":"2012-10-17","Statement":[]}'></textarea><span class="hint">Leave empty to attach no policy. The document is sent as CreateTable.ResourcePolicy.</span></div></div></section>
<section class="card"><div class="card-header"><div><h2>Tags <span class="muted small">– optional</span></h2><p class="muted small">Tags help you organize and identify your resources. You can add up to 50 tags.</p></div><button class="button" type="button" id="add-create-tag">Add new tag</button></div><div class="card-body"><div id="create-tag-rows"><p class="muted" id="no-create-tags">No tags associated with the resource.</p></div></div></section>
</div>
<div class="actions page-actions"><a class="button" href="#/dynamodb/tables">Cancel</a><button class="button primary" type="submit" id="submit-create-table">Create table</button></div></form></div>`;

  const form = document.querySelector("#create-table-form");
  form.elements.name.pattern = "[A-Za-z0-9_.\\-]{3,255}";
  const errorRoot = document.querySelector("#create-table-error");
  const indexRoot = document.querySelector("#create-index-rows");
  const tagRoot = document.querySelector("#create-tag-rows");
  const markDirty = () => setDirty(true, "page");
  form.querySelectorAll("input, textarea, select").forEach(control => { control.addEventListener("input", markDirty); control.addEventListener("change", markDirty); });

  const customize = document.querySelector("#create-customize-sections"); const defaultSummary = document.querySelector("#create-default-summary");
  const syncSettingsMode = () => { const custom = form.elements.settingsMode.value === "customize"; customize.hidden = !custom; defaultSummary.hidden = custom; };
  form.querySelectorAll('input[name="settingsMode"]').forEach(input => input.addEventListener("change", syncSettingsMode)); syncSettingsMode();
  const syncCapacityMode = () => { const mode = form.elements.capacityMode.value; form.querySelectorAll("[data-capacity-section]").forEach(section => { section.hidden = section.dataset.capacitySection !== mode; }); };
  form.querySelectorAll('input[name="capacityMode"]').forEach(input => input.addEventListener("change", syncCapacityMode)); syncCapacityMode();
  const syncOnDemandMax = () => { form.querySelector("[data-on-demand-max-fields]").hidden = !form.elements.onDemandMax.checked; }; form.elements.onDemandMax.addEventListener("change", syncOnDemandMax);
  for (const side of ["read", "write"]) { const sync = () => { const on = form.elements[`${side}AutoScaling`].value === "on"; form.querySelector(`[data-auto-scaling-fields="${side}"]`).hidden = !on; form.querySelector(`[data-provisioned-fields="${side}"]`).hidden = on; }; form.querySelectorAll(`input[name="${side}AutoScaling"]`).forEach(input => input.addEventListener("change", sync)); sync(); }
  const syncEncryption = () => { form.querySelector("[data-kms-key-field]").hidden = form.elements.encryption.value !== "CUSTOMER_MANAGED"; }; form.querySelectorAll('input[name="encryption"]').forEach(input => input.addEventListener("change", syncEncryption)); syncEncryption();

  const addIndex = kind => { document.querySelector("#no-create-indexes")?.remove(); indexRoot.insertAdjacentHTML("beforeend", indexRowMarkup(kind)); bindIndexRows(indexRoot, () => String(form.elements.partition.value ?? ""), () => String(form.elements.partitionType.value ?? "S"), markDirty); markDirty(); };
  document.querySelector("#add-create-index").addEventListener("click", () => addIndex("GSI"));
  document.querySelector("#add-create-local-index").addEventListener("click", () => addIndex("LSI"));
  document.querySelector("#add-create-tag").addEventListener("click", () => { document.querySelector("#no-create-tags")?.remove(); tagRoot.insertAdjacentHTML("beforeend", tagRowMarkup()); const row = tagRoot.lastElementChild; row.querySelector("[data-remove-tag]").addEventListener("click", () => { row.remove(); if (!tagRoot.children.length) tagRoot.innerHTML = '<p class="muted" id="no-create-tags">No tags associated with the resource.</p>'; markDirty(); }); row.querySelectorAll("input").forEach(control => control.addEventListener("input", markDirty)); markDirty(); });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = document.querySelector("#submit-create-table");
    submit.disabled = true; errorRoot.hidden = true;
    try {
      const { request, autoScaling } = createTableRequest(new FormData(form), form, indexRoot, tagRoot);
      await dynamo("CreateTable", request);
      if (autoScaling) await applyAutoScaling(request.TableName, autoScaling);
      setDirty(false, "page");
      toast("Table created successfully");
      location.hash = `#/dynamodb/tables/${encodeURIComponent(request.TableName)}/overview`;
    } catch (error) {
      markDirty(); submit.disabled = false;
      const message = error instanceof Error ? error.message : String(error);
      errorRoot.innerHTML = `<strong>Table couldn't be created</strong><br>${escapeHtml(message)}`; errorRoot.hidden = false; errorRoot.focus({ preventScroll: true });
      showError(error);
    }
  });
}

/** The local table activates on the next scheduler tick; wait for it before storing auto scaling descriptors. */
async function applyAutoScaling(TableName, autoScaling) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = (await dynamo("DescribeTable", { TableName })).Table?.TableStatus;
    if (status === "ACTIVE") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const setting = (side, values) => ({ MinimumUnits: values.min, MaximumUnits: values.max, AutoScalingDisabled: false, ScalingPolicyUpdate: { PolicyName: `${TableName}-${side}-target`, TargetTrackingScalingPolicyConfiguration: { TargetValue: values.target, DisableScaleIn: false, ScaleInCooldown: 0, ScaleOutCooldown: 0 } } });
  await dynamo("UpdateTableReplicaAutoScaling", { TableName, ...(autoScaling.write ? { ProvisionedWriteCapacityAutoScalingUpdate: setting("write", autoScaling.write) } : {}), ...(autoScaling.read ? { ReplicaUpdates: [{ RegionName: autoScaling.region, ReplicaProvisionedReadCapacityAutoScalingUpdate: setting("read", autoScaling.read) }] } : {}) });
}

function createTableRequest(data, form, indexRoot, tagRoot) {
  const definitions = [];
  const addDefinition = (AttributeName, AttributeType) => {
    if (!AttributeName) return;
    const existing = definitions.find(definition => definition.AttributeName === AttributeName);
    if (existing && existing.AttributeType !== AttributeType) throw new Error(`Attribute ${AttributeName} has conflicting key types`);
    if (!existing) definitions.push({ AttributeName, AttributeType });
  };
  const text = name => String(data.get(name) ?? "").trim(); const number = name => { const raw = text(name); return raw ? Number(raw) : undefined; };
  const partition = text("partition"); const partitionType = text("partitionType"); const sort = text("sort"); const sortType = text("sortType");
  addDefinition(partition, partitionType); if (sort) addDefinition(sort, sortType);
  const keySchema = [{ AttributeName: partition, KeyType: "HASH" }]; if (sort) keySchema.push({ AttributeName: sort, KeyType: "RANGE" });
  const customize = text("settingsMode") === "customize";
  const billingMode = customize ? text("capacityMode") : "PAY_PER_REQUEST";
  let provisioned; let autoScaling;
  if (billingMode === "PROVISIONED") {
    const side = name => { const on = text(`${name}AutoScaling`) === "on"; if (on) { const min = number(`${name}Min`) ?? 1; const max = number(`${name}Max`) ?? 10; const target = number(`${name}Target`) ?? 70; if (min < 1 || max < min) throw new Error(`${name === "read" ? "Read" : "Write"} capacity range must have a maximum of at least the minimum`); return { units: min, scaling: { min, max, target } }; } const units = number(`${name}Units`); if (!units || units < 1) throw new Error(`${name === "read" ? "Read" : "Write"} capacity units are required in provisioned mode`); return { units }; };
    const read = side("read"); const write = side("write");
    provisioned = { ReadCapacityUnits: read.units, WriteCapacityUnits: write.units };
    if (read.scaling || write.scaling) autoScaling = { region: session.region, read: read.scaling, write: write.scaling };
  }
  const globals = []; const locals = []; const names = new Set();
  for (const row of indexRoot.querySelectorAll(".secondary-index-row")) {
    const value = selector => String(row.querySelector(selector).value ?? "").trim();
    const name = value("[data-index-name]"); const kind = value("[data-index-kind]"); const indexPartition = kind === "LSI" ? partition : value("[data-index-partition]"); const indexPartitionType = kind === "LSI" ? partitionType : value("[data-index-partition-type]"); const indexSort = value("[data-index-sort]"); const indexSortType = value("[data-index-sort-type]"); const projectionType = value("[data-index-projection]"); const nonKeys = value("[data-index-nonkeys]").split(",").map(item => item.trim()).filter(Boolean);
    if (!name) throw new Error("Every secondary index needs a name"); if (names.has(name)) throw new Error(`Duplicate secondary index name: ${name}`); names.add(name);
    if (!indexPartition) throw new Error(`Index ${name} needs a partition key`); if (kind === "LSI" && (!sort || !indexSort)) throw new Error(`Local secondary index ${name} requires table and index sort keys`); if (kind === "GSI" && !value("[data-index-partition]")) throw new Error(`Global secondary index ${name} needs a partition key`);
    if (projectionType === "INCLUDE" && !nonKeys.length) throw new Error(`INCLUDE projection for ${name} needs at least one non-key attribute`); if (projectionType !== "INCLUDE" && nonKeys.length) throw new Error(`Non-key attributes are valid only for INCLUDE projection (${name})`);
    addDefinition(indexPartition, indexPartitionType); if (indexSort) addDefinition(indexSort, indexSortType);
    const index = { IndexName: name, KeySchema: [{ AttributeName: indexPartition, KeyType: "HASH" }, ...(indexSort ? [{ AttributeName: indexSort, KeyType: "RANGE" }] : [])], Projection: { ProjectionType: projectionType, ...(projectionType === "INCLUDE" ? { NonKeyAttributes: nonKeys } : {}) } };
    if (kind === "LSI") locals.push(index); else { if (provisioned) index.ProvisionedThroughput = { ...provisioned }; globals.push(index); }
  }
  const request = { TableName: text("name"), BillingMode: billingMode, AttributeDefinitions: definitions, KeySchema: keySchema, ...(globals.length ? { GlobalSecondaryIndexes: globals } : {}), ...(locals.length ? { LocalSecondaryIndexes: locals } : {}) };
  if (provisioned) request.ProvisionedThroughput = provisioned;
  if (!customize) return { request };
  if (billingMode === "PAY_PER_REQUEST" && text("onDemandMax") === "yes") { const maxRead = number("maxRead"); const maxWrite = number("maxWrite"); if (maxRead || maxWrite) request.OnDemandThroughput = { ...(maxRead ? { MaxReadRequestUnits: maxRead } : {}), ...(maxWrite ? { MaxWriteRequestUnits: maxWrite } : {}) }; }
  request.TableClass = text("tableClass") || "STANDARD";
  const encryption = text("encryption");
  if (encryption === "AWS_MANAGED") request.SSESpecification = { Enabled: true, SSEType: "KMS" };
  else if (encryption === "CUSTOMER_MANAGED") { const key = text("kmsKey"); if (!key) throw new Error("Enter the customer managed KMS key"); request.SSESpecification = { Enabled: true, SSEType: "KMS", KMSMasterKeyId: key }; }
  if (text("deletionProtection") === "yes") request.DeletionProtectionEnabled = true;
  const warmRead = number("warmRead"); const warmWrite = number("warmWrite"); if (warmRead || warmWrite) { if (!warmRead || !warmWrite) throw new Error("Enter both warm throughput values"); request.WarmThroughput = { ReadUnitsPerSecond: warmRead, WriteUnitsPerSecond: warmWrite }; }
  const policy = text("resourcePolicy"); if (policy) { try { JSON.parse(policy); } catch { throw new Error("Resource-based policy must be valid JSON"); } request.ResourcePolicy = policy; }
  const tags = []; const tagKeys = new Set();
  for (const row of tagRoot.querySelectorAll(".create-tag-row")) { const Key = String(row.querySelector("[data-tag-key]").value ?? "").trim(); const Value = String(row.querySelector("[data-tag-value]").value ?? "").trim(); if (!Key) throw new Error("Every tag needs a key"); if (tagKeys.has(Key)) throw new Error(`Duplicate tag key: ${Key}`); tagKeys.add(Key); tags.push({ Key, Value }); }
  if (tags.length) request.Tags = tags;
  return { request, autoScaling };
}

function tagRowMarkup() {
  const id = `create-tag-${++tagRowId}`;
  return `<div class="create-tag-row field-row"><div class="field"><label for="${id}-key">Key</label><input id="${id}-key" data-tag-key maxlength="128" required placeholder="environment"></div><div class="field"><label for="${id}-value">Value <span class="muted small">– optional</span></label><input id="${id}-value" data-tag-value maxlength="256" placeholder="development"></div><div class="field field-action"><button class="button" type="button" data-remove-tag>Remove</button></div></div>`;
}

function indexRowMarkup(kind = "GSI") {
  const id = `create-secondary-index-${++indexRowId}`;
  return `<section class="secondary-index-row" data-index-row><div class="card-header"><h4>${kind === "LSI" ? "Local secondary index" : "Global secondary index"}</h4><button class="button link danger" type="button" data-remove-index>Remove</button></div><div class="card-body compact-card-body"><div class="field-row"><div class="field"><label for="${id}-name">Index name</label><input id="${id}-name" data-index-name required pattern="[A-Za-z0-9_.\\-]{3,255}"></div><div class="field"><label for="${id}-kind">Index type</label><select id="${id}-kind" data-index-kind><option value="GSI" ${kind === "GSI" ? "selected" : ""}>Global secondary index</option><option value="LSI" ${kind === "LSI" ? "selected" : ""}>Local secondary index</option></select></div></div><div class="field-row"><div class="field"><label for="${id}-partition">Partition key</label><input id="${id}-partition" data-index-partition required></div><div class="field"><label for="${id}-partition-type">Data type</label><select id="${id}-partition-type" data-index-partition-type>${keyTypeOptions()}</select></div></div><div class="field-row"><div class="field"><label for="${id}-sort">Sort key <span class="muted small">– optional for global indexes</span></label><input id="${id}-sort" data-index-sort></div><div class="field"><label for="${id}-sort-type">Data type</label><select id="${id}-sort-type" data-index-sort-type>${keyTypeOptions()}</select></div></div><div class="field-row"><div class="field"><label for="${id}-projection">Attribute projections</label><select id="${id}-projection" data-index-projection><option value="ALL">All</option><option value="KEYS_ONLY">Only keys</option><option value="INCLUDE">Include</option></select></div><div class="field"><label for="${id}-nonkeys">Non-key attributes</label><input id="${id}-nonkeys" data-index-nonkeys placeholder="title, status" disabled></div></div></div></section>`;
}

function bindIndexRows(root, tablePartition, tablePartitionType, onChange = () => setDirty(true, "modal")) {
  const syncLocalKeys = () => root.querySelectorAll("[data-index-row]").forEach(row => { if (row.querySelector("[data-index-kind]").value !== "LSI") return; row.querySelector("[data-index-partition]").value = tablePartition(); row.querySelector("[data-index-partition-type]").value = tablePartitionType(); });
  if (!root.dataset.tableKeyWatch) { root.dataset.tableKeyWatch = "true"; document.querySelector('input[name="partition"]')?.addEventListener("input", syncLocalKeys); document.querySelector('select[name="partitionType"]')?.addEventListener("change", syncLocalKeys); }
  root.querySelectorAll("[data-index-row]").forEach(row => {
    if (row.dataset.bound) return; row.dataset.bound = "true";
    const kind = row.querySelector("[data-index-kind]"); const partition = row.querySelector("[data-index-partition]"); const partitionType = row.querySelector("[data-index-partition-type]"); const projection = row.querySelector("[data-index-projection]"); const nonKeys = row.querySelector("[data-index-nonkeys]"); const heading = row.querySelector("h4");
    const updateKind = () => { const local = kind.value === "LSI"; if (local) { partition.value = tablePartition(); partitionType.value = tablePartitionType(); } partition.readOnly = local; partitionType.disabled = local; heading.textContent = local ? "Local secondary index" : "Global secondary index"; };
    row.querySelectorAll("input, select").forEach(control => { control.addEventListener("input", onChange); control.addEventListener("change", onChange); });
    kind.addEventListener("change", updateKind); projection.addEventListener("change", () => { nonKeys.disabled = projection.value !== "INCLUDE"; if (nonKeys.disabled) nonKeys.value = ""; }); row.querySelector("[data-remove-index]").addEventListener("click", () => { row.remove(); onChange(); if (!root.querySelector("[data-index-row]")) root.innerHTML = '<p class="muted" id="no-create-indexes">No secondary indexes configured.</p>'; });
    updateKind();
  });
}
