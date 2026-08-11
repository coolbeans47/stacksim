import { rest, s3Request } from "../api-client.js";
import { emptyState, escapeHtml, pageHeader, panelHeading, tabs } from "../components.js";
import { session } from "../state.js";

export const metadata = {
  key: "s3",
  name: "S3",
  icon: "S3",
  cls: "s3",
  links: [["Overview", "#/s3"], ["General purpose buckets", "#/s3/buckets"]],
  search: ["s3", "bucket", "object", "upload", "download", "multipart", "version", "delete marker", "storage", "static website hosting", "website endpoint"],
};

const xmlEscape = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[character]);
const first = (root, name) => root?.getElementsByTagName(name)?.[0]?.textContent ?? "";
const direct = (root, name) => [...(root?.children ?? [])].filter(element => element.localName === name);
const objectPath = (bucket, key = "") => `/${encodeURIComponent(bucket)}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`;
const copySource = (bucket, key, versionId) => `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`;
const objectPageHref = (bucket, key, tab = "properties", versionId) => `#/s3/buckets/${encodeURIComponent(bucket)}/object/${encodeURIComponent(key)}/${tab}${versionId !== undefined ? `/${encodeURIComponent(versionId)}` : ""}`;
const objectRequestPath = (bucket, key, query = "", versionId) => {
  const values = [query, versionId !== undefined ? `versionId=${encodeURIComponent(versionId)}` : ""].filter(Boolean);
  return `${objectPath(bucket, key)}${values.length ? `?${values.join("&")}` : ""}`;
};
const sha256Base64 = async value => { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); return btoa(String.fromCharCode(...digest)); };
const humanBytes = value => { const bytes = Number(value ?? 0); if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; };
const humanAge = value => { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000)); if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`; };

const s3PanelHelp = {
  buckets: {
    level: "Supported locally",
    description: "A bucket is the top-level container for S3 objects. Its name identifies the object namespace, while its Region controls where AWS would store and serve the data. Create a bucket before uploading files, and select one here when you need to empty or delete it.",
    support: "Bucket creation, listing, regional endpoints, emptying, and deletion are active and persist locally. Names are unique within this StackSim installation rather than across all AWS accounts worldwide.",
  },
  objects: {
    level: "Supported locally",
    description: "An object combines file data with a key, which is the full name used to retrieve it. Prefixes and slash-separated keys make objects look like folders in the console, although S3 itself uses a flat namespace. Use this panel to upload, organize, copy, download, or delete bucket contents.",
    support: "Object bytes, metadata, checksums, multipart uploads, versions, and delete markers are active and persist locally. Console-created folders are zero-byte marker objects, matching the familiar S3 console convention.",
  },
  bucketVersioning: {
    level: "Supported locally",
    description: "Versioning preserves earlier copies of an object when the same key is overwritten or deleted. Enable it when you need recovery from accidental changes, version-specific links, retention controls, or Object Lock. Once enabled, versioning can be suspended but the bucket cannot return to an unversioned state.",
    support: "Version IDs, delete markers, listing, restoration, and suspended-versioning behavior are active. Existing objects remain unversioned until they are written again.",
  },
  staticWebsite: {
    level: "Supported locally",
    description: "Static website hosting serves bucket objects as web pages. The index document is used for directory-style requests, and the optional error document is returned when a requested page is missing. Public visitors still need permission to read the underlying objects.",
    support: "Website configuration, index and error resolution, redirects, and policy-based public access are active on a local endpoint. StackSim does not provide AWS DNS names, TLS certificates, CloudFront, or internet hosting.",
  },
  dataGovernance: {
    level: "Partial",
    description: "Data governance groups settings that protect and classify bucket data. Default encryption determines how new objects are described as protected, Object Lock can prevent version deletion for a retention period, and bucket tags provide labels for organization and access-control conditions.",
    support: "SSE-S3 storage protection, tags, Object Lock retention, and legal enforcement are active. KMS and dual-layer KMS settings are stored as dependency descriptors, but KMS-backed writes remain unavailable because StackSim does not provide KMS.",
  },
  eventNotifications: {
    level: "Supported integrations",
    description: "Event notifications send a message or invoke a function when matching bucket activity occurs, such as an object upload or deletion. Choose event types and optional key-prefix or suffix filters when another part of your application should react automatically.",
    support: "Durable, at-least-once delivery to local Lambda functions and same-Region SQS queues is active, including destination-policy validation and retry diagnostics; SNS destinations are not available. The end-to-end example at examples/cdk-s3-lambda-notification-audit deploys a versioned bucket, an audit Lambda, and a DynamoDB table. Any audit Lambda shown here comes from that deployed example, not from StackSim itself.",
  },
  eventBridge: {
    level: "Supported locally",
    description: "Enabling EventBridge publishes supported events from this bucket to the default event bus. Use EventBridge when several consumers need the same events or when routing should use rule patterns instead of one notification's prefix and suffix filters.",
    support: "Bucket-wide publishing, default-bus rule matching, retry handling, and supported local rule targets are active. Events stay inside this StackSim installation and unsupported AWS target services are not contacted.",
  },
  lifecycle: {
    level: "Supported locally",
    description: "Lifecycle rules automatically manage objects as they age. A rule can transition current or previous versions to another storage class, expire data or delete markers, and abort incomplete multipart uploads. Filters limit the rule to particular keys, tags, or object sizes.",
    support: "Rule scheduling, filters, transitions, expiration, NewerNoncurrentVersions, noncurrent versions, and multipart cleanup are active. Day-0 STANDARD_IA/ONEZONE_IA transitions are allowed; chained transitions enforce each class minimum storage duration. Archive access restrictions are modeled, but physical blobs remain in the local encrypted store and no AWS storage cost or external archive service is simulated.",
  },
  publicAccess: {
    level: "Supported locally",
    description: "Block Public Access is a safety layer that can reject new public policies or ACLs and ignore public grants that already exist. Bucket and account settings are combined using the most restrictive value, so changing a bucket switch may not change the effective result.",
    support: "The four bucket controls, account-level controls, policy validation, and authorization effects are active. They protect the local S3 API; StackSim does not expose the bucket directly to the public internet.",
  },
  bucketPolicy: {
    level: "Supported locally",
    description: "A bucket policy is a resource-based JSON policy that grants or denies S3 actions for principals and resources. Use it for cross-account access, service integrations, or tightly scoped public reads, and prefer explicit conditions when access should be limited.",
    support: "Policy storage, validation, explicit denies, principals, resources, and supported IAM condition evaluation are active for local requests and integrations. The findings shown here are simulator guidance, not AWS IAM Access Analyzer results.",
  },
  objectOwnership: {
    level: "Supported locally",
    description: "Object Ownership decides whether ACLs participate in authorization and which account owns newly written objects. Bucket owner enforced is the modern default: it disables ACLs and makes the bucket owner own every object. Other modes are useful when testing legacy ACL-based workflows.",
    support: "All three ownership modes, ACL enablement, ownership headers, and authorization consequences are active for local object requests.",
  },
  bucketAcl: {
    level: "Supported locally",
    description: "A bucket access control list is a legacy set of grants for predefined groups or specific accounts. Most new applications should use Bucket owner enforced with IAM and bucket policies; edit an ACL only when reproducing an older S3 integration.",
    support: "Canned ACLs, grant evaluation, ownership controls, and Block Public Access interactions are active. ACL editing is unavailable while Bucket owner enforced is selected, as it is in AWS.",
  },
  requesterPays: {
    level: "Partial",
    description: "Requester Pays makes the caller acknowledge that they, rather than the bucket owner, would pay request and data-transfer charges. It is mainly used for large shared datasets where consumers should accept the access cost.",
    support: "The request-payer header and authorization context are enforced locally. StackSim does not calculate charges, transfer fees, or create billing records.",
  },
  abac: {
    level: "Supported locally",
    description: "Attribute-based access control uses tags as policy attributes. Enable bucket ABAC when IAM policies should compare bucket tags with principal or request tags, reducing the need to name every bucket directly in a policy.",
    support: "Bucket tags are exposed as resource tags to supported local IAM condition operators and participate in authorization. This covers StackSim's implemented IAM policy surface rather than every AWS identity feature.",
  },
  objectTags: {
    level: "Supported locally",
    description: "Object tags are up to ten key-value labels stored separately from ordinary object metadata. Use them to classify an object for lifecycle rules, automation, or tag-aware access policies without changing the object's content.",
    support: "Version-specific tag reads, writes, deletion, lifecycle filters, notifications, and supported authorization checks are active locally.",
  },
  retention: {
    level: "Supported locally",
    description: "Object Lock retention prevents a particular object version from being deleted or replaced until a date. Governance mode can be bypassed by an authorized request; Compliance mode cannot be shortened or removed during its retention period.",
    support: "Retention dates, Governance and Compliance rules, bypass permission checks, default bucket retention, and protected mutations are actively enforced for local versions.",
  },
  legalHold: {
    level: "Supported locally",
    description: "A legal hold protects an object version indefinitely until an authorized user removes the hold. Unlike retention, it has no expiry date, so use it when a business or legal process—not elapsed time—should decide when deletion is allowed.",
    support: "Per-version legal-hold state and deletion protection are actively enforced and persist locally.",
  },
  annotations: {
    level: "StackSim extension",
    description: "Annotations attach named structured or text payloads to an object version without replacing its content. They are useful for local workflows that need review notes, extracted results, or application-specific records alongside an object.",
    support: "Version-scoped annotation creation, replacement, checksums, ETags, listing, and Object Lock protection are active. Object annotations are a StackSim extension and are not part of the standard AWS S3 API.",
  },
  archiveRestore: {
    level: "Partial",
    description: "Objects in archival storage classes must be restored before their bytes can be read. A restore request selects how long the temporary readable copy remains available and, in AWS, the retrieval tier controls speed and cost.",
    support: "Archive access restrictions, restore state, expiry, and lifecycle transitions are modeled locally. StackSim does not move bytes to Glacier infrastructure, charge for retrieval, or reproduce AWS retrieval delays.",
  },
  objectAcl: {
    level: "Supported locally",
    description: "An object ACL is a legacy list of read or control grants for predefined groups or accounts. Use it only when testing an ACL-based application; new designs generally use bucket-owner-enforced ownership together with IAM and bucket policies.",
    support: "Object grants, canned ACLs, ownership modes, bucket policy, and Block Public Access interactions are evaluated for local requests. This editor is hidden when Bucket owner enforced disables ACLs.",
  },
};

const s3PanelHelpTargets = [
  [".card", "Buckets", "buckets"],
  [".card", "Objects", "objects"],
  ['.card:has([data-versioning])', "Bucket Versioning", "bucketVersioning"],
  [".s3-static-website-hosting", "Static website hosting", "staticWebsite"],
  [".s3-governance", "Data governance", "dataGovernance"],
  [".s3-event-notifications", "Event notifications", "eventNotifications"],
  [".s3-eventbridge-notifications", "Amazon EventBridge", "eventBridge"],
  [".s3-lifecycle-rules", "Lifecycle rules", "lifecycle"],
  ['.card:has([data-edit-public-block])', "Block public access (bucket settings)", "publicAccess"],
  ['.card:has([data-edit-policy])', "Bucket policy", "bucketPolicy"],
  ['.card:has([data-edit-ownership])', "Object Ownership", "objectOwnership"],
  ['.card:has([data-edit-acl])', "Access control list (ACL)", "bucketAcl"],
  ['.card:has([data-edit-requester-pays])', "Requester Pays", "requesterPays"],
  ['.card:has([data-edit-abac])', "Attribute-based access control (ABAC)", "abac"],
  ['.card:has([data-edit-object-tags])', "Tags", "objectTags"],
  ['.card:has([data-edit-object-retention])', "Object Lock retention", "retention"],
  ['.card:has([data-edit-object-legal-hold])', "Legal hold", "legalHold"],
  ['.card:has([data-create-object-annotation])', "Annotations", "annotations"],
  ['.card:has([data-object-restore])', "Archive restore", "archiveRestore"],
  ['.card:has([data-edit-object-acl])', "Object access control list (ACL)", "objectAcl"],
];

function decorateS3PanelHelp(root = document) {
  for (const [selector, title, helpKey] of s3PanelHelpTargets) {
    const heading = [...root.querySelectorAll(`${selector} > .card-header h2`)].find(candidate => {
      const text = candidate.textContent.trim();
      return text === title || text.startsWith(`${title} (`);
    });
    if (!heading) continue;
    const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
    heading.outerHTML = panelHeading(title, s3PanelHelp[helpKey], meta);
  }
}

function objectTabs(bucket, key, active, versionId) {
  return tabs(["properties", "permissions", "versions"].map(tab => ({ label: tab[0].toUpperCase() + tab.slice(1), href: objectPageHref(bucket, key, tab, versionId), active: tab === active })));
}

function objectBreadcrumbs(bucket, key) {
  const slash = key.lastIndexOf("/"); const prefix = slash >= 0 ? key.slice(0, slash + 1) : ""; const name = slash >= 0 ? key.slice(slash + 1) || key : key;
  return ["S3", { label: "General purpose buckets", href: "#/s3/buckets" }, { label: bucket, href: `#/s3/buckets/${encodeURIComponent(bucket)}/objects` }, ...(prefix ? [{ label: prefix, href: `#/s3/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(prefix)}` }] : []), name];
}

async function optionalS3(path, absentCodes = []) {
  try { return await s3Request(path); }
  catch (error) { if (absentCodes.includes(error?.code)) return undefined; throw error; }
}

async function inlineAction(context, action) {
  try { await action(); }
  catch (error) { context.toast(error instanceof Error ? error.message : String(error), "error"); }
}

export const S3_NOTIFICATION_EVENTS = [
  "s3:ObjectCreated:*", "s3:ObjectCreated:Put", "s3:ObjectCreated:Copy", "s3:ObjectCreated:CompleteMultipartUpload",
  "s3:ObjectRemoved:*", "s3:ObjectRemoved:Delete", "s3:ObjectRemoved:DeleteMarkerCreated",
  "s3:ObjectRestore:*", "s3:ObjectRestore:Post", "s3:ObjectRestore:Completed", "s3:ObjectRestore:Delete",
  "s3:ObjectTagging:*", "s3:ObjectTagging:Put", "s3:ObjectTagging:Delete", "s3:ObjectAcl:Put",
  "s3:ObjectAnnotation:*", "s3:ObjectAnnotation:Put", "s3:ObjectAnnotation:Delete",
  "s3:LifecycleExpiration:*", "s3:LifecycleExpiration:Delete", "s3:LifecycleExpiration:DeleteMarkerCreated", "s3:LifecycleExpiration:DeleteMarkerDeleted", "s3:LifecycleTransition",
];

const childText = (root, name) => [...(root?.children ?? [])].find(element => element.localName === name)?.textContent ?? "";

export function parseS3NotificationConfiguration(xml) {
  const root = xml?.documentElement;
  if (!root || root.localName === "parsererror") throw new Error("The current notification configuration could not be read");
  const configurations = [...root.children].filter(node => ["CloudFunctionConfiguration", "LambdaFunctionConfiguration", "QueueConfiguration"].includes(node.localName)).map(node => {
    const type = node.localName === "QueueConfiguration" ? "queue" : "lambda";
    const rules = [...node.getElementsByTagName("FilterRule")].map(rule => ({ name: first(rule, "Name").toLowerCase(), value: first(rule, "Value") }));
    return {
      type,
      id: childText(node, "Id"),
      arn: childText(node, type === "queue" ? "Queue" : "CloudFunction") || childText(node, "LambdaFunctionArn"),
      events: direct(node, "Event").map(event => event.textContent ?? ""),
      prefix: rules.find(rule => rule.name === "prefix")?.value ?? "",
      suffix: rules.find(rule => rule.name === "suffix")?.value ?? "",
    };
  });
  return { configurations, eventBridge: [...root.children].some(node => node.localName === "EventBridgeConfiguration") };
}

export function serializeS3NotificationConfiguration(model) {
  const configurations = model.configurations.map(configuration => {
    const queue = configuration.type === "queue";
    const tag = queue ? "QueueConfiguration" : "CloudFunctionConfiguration";
    const arnTag = queue ? "Queue" : "CloudFunction";
    const filter = configuration.prefix || configuration.suffix ? `<Filter><S3Key>${configuration.prefix ? `<FilterRule><Name>prefix</Name><Value>${xmlEscape(configuration.prefix)}</Value></FilterRule>` : ""}${configuration.suffix ? `<FilterRule><Name>suffix</Name><Value>${xmlEscape(configuration.suffix)}</Value></FilterRule>` : ""}</S3Key></Filter>` : "";
    return `<${tag}><Id>${xmlEscape(configuration.id)}</Id><${arnTag}>${xmlEscape(configuration.arn)}</${arnTag}>${configuration.events.map(event => `<Event>${xmlEscape(event)}</Event>`).join("")}${filter}</${tag}>`;
  }).join("");
  return `<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${configurations}${model.eventBridge ? "<EventBridgeConfiguration/>" : ""}</NotificationConfiguration>`;
}

function bucketTabs(bucket, active) {
  const root = `#/s3/buckets/${encodeURIComponent(bucket)}`; return tabs(["objects", "properties", "permissions", "metrics", "management"].map(key => ({ label: key[0].toUpperCase() + key.slice(1), href: `${root}/${key}`, active: key === active })));
}

async function listBuckets() {
  const result = await s3Request("/"); return [...result.xml.getElementsByTagName("Bucket")].map(node => ({ name: first(node, "Name"), createdAt: first(node, "CreationDate"), region: first(node, "BucketRegion") || session.region, arn: first(node, "BucketArn"), objectLockEnabled: first(node, "ObjectLockEnabled") === "Enabled", lifecycleConfigured: first(node, "LifecycleConfigured") === "true", tags: [...(direct(node, "BucketTags")[0]?.getElementsByTagName("Tag") ?? [])].map(tag => [first(tag, "Key"), first(tag, "Value")]) }));
}

function bindCreateBucket(context) {
  document.querySelectorAll('[data-action="create-s3-bucket"]').forEach(button => button.addEventListener("click", () => context.showModal("Create bucket", `<div class="field"><label>Bucket name</label><input name="name" required pattern="[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]" placeholder="learning-assets"><span class="hint">Bucket names are installation-wide and use current general-purpose naming rules.</span></div><div class="field"><label>Region</label><input value="${escapeHtml(session.region)}" disabled></div><div class="alert info"><strong>Object Ownership and encryption</strong><br>Objects are locally owned by this account and encrypted at rest with simulator-managed SSE-S3.</div>`, "Create bucket", async data => {
    const name = String(data.get("name")); const body = `<?xml version="1.0" encoding="UTF-8"?><CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${xmlEscape(session.region)}</LocationConstraint></CreateBucketConfiguration>`; await s3Request(`/${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Bucket created"); location.hash = `#/s3/buckets/${encodeURIComponent(name)}/objects`;
  })));
}

async function overview(context) {
  const buckets = await listBuckets(); context.setChrome("s3", ["S3", "Overview"]); context.main.innerHTML = `<div class="page-width">${pageHeader("S3", "Object storage for local SDK and browser workflows.", `<button class="button primary" data-action="create-s3-bucket">Create bucket</button>`)}<div class="dashboard-grid"><section class="card"><div class="card-header"><h2>General purpose buckets</h2></div><div class="card-body"><div class="metric">${buckets.length}</div><p class="muted">Buckets in this local account</p><a href="#/s3/buckets">View buckets</a></div></section><section class="card"><div class="card-header"><h2>Data protection</h2></div><div class="card-body"><p>Strong read-after-write consistency, checksums, multipart uploads, and version history are available.</p><p class="muted">Object bytes are encrypted outside the control-state file.</p></div></section></div></div>`; bindCreateBucket(context);
}

async function bucketsPage(context) {
  const buckets = await listBuckets(); context.setChrome("s3", ["S3", "General purpose buckets"]); context.main.innerHTML = `<div class="page-width">${pageHeader("General purpose buckets", "Create and manage regional object namespaces.", `<button class="button refresh" data-action="refresh">↻</button><button class="button danger" data-action="empty-bucket" disabled>Empty</button><button class="button danger" data-action="delete-bucket" disabled>Delete</button><button class="button primary" data-action="create-s3-bucket">Create bucket</button>`)}<section class="card"><div class="card-header"><h2>Buckets <span class="muted">(${buckets.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find buckets"></label><span class="muted" data-bucket-selection-status>Select a bucket</span></div><div class="table-wrap">${buckets.length ? `<table><thead><tr><th class="checkbox-cell"><span class="sr-only">Select</span></th><th>Bucket name</th><th>Region</th><th>Created</th><th>ARN</th></tr></thead><tbody>${buckets.map(bucket => `<tr data-search-row="${escapeHtml(bucket.name.toLowerCase())}"><td><input type="radio" name="selected-bucket" value="${escapeHtml(bucket.name)}" aria-label="Select ${escapeHtml(bucket.name)}"></td><td><a href="#/s3/buckets/${encodeURIComponent(bucket.name)}/objects">${escapeHtml(bucket.name)}</a></td><td>${escapeHtml(bucket.region)}</td><td>${escapeHtml(new Date(bucket.createdAt).toLocaleString())}</td><td class="mono">${escapeHtml(bucket.arn)}</td></tr>`).join("")}</tbody></table>` : emptyState("S3", "No buckets", "Create a bucket to upload and organize objects.", '<button class="button primary" data-action="create-s3-bucket">Create bucket</button>')}</div></section></div>`;
  const selectedBucket = () => document.querySelector('[name="selected-bucket"]:checked')?.value;
  const updateSelection = () => {
    const bucket = selectedBucket();
    document.querySelectorAll('[data-action="empty-bucket"], [data-action="delete-bucket"]').forEach(button => { button.disabled = !bucket; });
    const status = document.querySelector("[data-bucket-selection-status]");
    if (status) status.textContent = bucket ? `1 bucket selected: ${bucket}` : "Select a bucket";
  };
  document.querySelectorAll('[name="selected-bucket"]').forEach(input => input.addEventListener("change", updateSelection));
  document.querySelector('[data-action="empty-bucket"]')?.addEventListener("click", () => emptyBucketAction(context, selectedBucket()));
  document.querySelector('[data-action="delete-bucket"]')?.addEventListener("click", () => deleteBucketAction(context, selectedBucket()));
  context.bindTableFilter(); bindCreateBucket(context); document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function emptyBucket(bucket) {
  let deleted = 0;
  let uploadsAborted = 0;
  while (true) {
    const result = await s3Request(`${objectPath(bucket)}?versions&max-keys=1000`);
    const versions = [...result.xml.documentElement.children]
      .filter(node => node.localName === "Version" || node.localName === "DeleteMarker")
      .map(node => ({ key: first(node, "Key"), versionId: first(node, "VersionId") }));
    if (!versions.length) break;
    const body = `<Delete>${versions.map(version => `<Object><Key>${xmlEscape(version.key)}</Key><VersionId>${xmlEscape(version.versionId)}</VersionId></Object>`).join("")}<Quiet>false</Quiet></Delete>`;
    const checksum = await sha256Base64(body);
    const removed = await s3Request(`${objectPath(bucket)}?delete`, { method: "POST", headers: { "content-type": "application/xml", "x-amz-checksum-sha256": checksum }, body });
    const errors = [...removed.xml.getElementsByTagName("Error")];
    if (errors.length) throw new Error(`${errors.length} object version${errors.length === 1 ? "" : "s"} could not be deleted: ${first(errors[0], "Message") || first(errors[0], "Code")}`);
    deleted += removed.xml.getElementsByTagName("Deleted").length;
  }
  while (true) {
    const result = await s3Request(`${objectPath(bucket)}?uploads&max-uploads=1000`);
    const uploads = [...result.xml.documentElement.children].filter(node => node.localName === "Upload").map(node => ({ key: first(node, "Key"), uploadId: first(node, "UploadId") }));
    if (!uploads.length) break;
    for (const upload of uploads) {
      await s3Request(`${objectPath(bucket, upload.key)}?uploadId=${encodeURIComponent(upload.uploadId)}`, { method: "DELETE" });
      uploadsAborted++;
    }
  }
  return { deleted, uploadsAborted };
}

function emptyBucketAction(context, bucket) {
  if (!bucket) return;
  context.showModal("Empty bucket", `<div class="alert warning"><strong>Emptying this bucket is permanent.</strong><br>All objects, object versions, and delete markers in <strong>${escapeHtml(bucket)}</strong> will be permanently deleted. Incomplete multipart uploads will be aborted. This action cannot be undone.</div><p>The bucket and its configuration will remain.</p><div class="field"><label>To confirm emptying the bucket, enter <strong>permanently delete</strong></label><input name="confirmation" required autocomplete="off"></div>`, "Empty", async data => {
    if (data.get("confirmation") !== "permanently delete") throw new Error('Enter "permanently delete" to confirm');
    const result = await emptyBucket(bucket);
    context.toast(`Bucket emptied: ${result.deleted} object version${result.deleted === 1 ? "" : "s"} deleted${result.uploadsAborted ? `; ${result.uploadsAborted} multipart upload${result.uploadsAborted === 1 ? "" : "s"} aborted` : ""}`);
  }, false, { danger: true });
}

async function uploadObject(bucket, key, file, context, signal) {
  const progress = document.querySelector("#s3-upload-progress"); const update = (done, total, message) => { if (progress) { progress.hidden = false; progress.textContent = message ?? `Uploading ${file.name}: ${Math.floor(done / Math.max(1, total) * 100)}%`; } };
  if (file.size <= 5 * 1024 * 1024) { update(0, file.size); await s3Request(objectPath(bucket, key), { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file, signal }); update(file.size, file.size); return; }
  const initiated = await s3Request(`${objectPath(bucket, key)}?uploads`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, signal }); const uploadId = first(initiated.xml, "UploadId"); const parts = []; const partSize = 5 * 1024 * 1024;
  try { for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber++) { const slice = file.slice(offset, Math.min(file.size, offset + partSize)); let result; for (let attempt = 0; attempt < 2; attempt++) { try { result = await s3Request(`${objectPath(bucket, key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT", body: slice, signal }); break; } catch (error) { if (signal?.aborted || attempt) throw error; update(offset, file.size, `Part ${partNumber} failed; retrying once…`); } } parts.push({ partNumber, etag: result.response.headers.get("etag") }); update(Math.min(file.size, offset + slice.size), file.size); }
    const complete = `<CompleteMultipartUpload>${parts.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`; await s3Request(`${objectPath(bucket, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", headers: { "content-type": "application/xml" }, body: complete });
  } catch (error) { update(0, file.size, signal?.aborted ? "Upload cancelled; removing uploaded parts…" : "Upload failed; removing uploaded parts…"); await s3Request(`${objectPath(bucket, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => undefined); if (signal?.aborted) throw new Error("Upload cancelled"); throw error; }
  context.toast("Multipart upload completed");
}

async function downloadObject(bucket, key, versionId) {
  const output = await s3Request(objectRequestPath(bucket, key, "", versionId)); const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([output.body], { type: output.response.headers.get("content-type") || "application/octet-stream" })); link.download = key.split("/").at(-1) || "object"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
}

function copyObjectAction(context, bucket, source, versionId) {
  context.showModal("Copy object", `<div class="field"><label>Source</label><input value="s3://${escapeHtml(bucket)}/${escapeHtml(source)}${versionId !== undefined ? `?versionId=${escapeHtml(versionId)}` : ""}" disabled></div><div class="field"><label>Destination key</label><input name="key" required value="${escapeHtml(source)}-copy"></div><div class="field"><label>Metadata</label><select name="metadataDirective"><option value="COPY">Copy source metadata</option><option value="REPLACE">Replace metadata</option></select></div><div class="field"><label>Replacement metadata (JSON)</label><textarea name="metadata">{}</textarea></div><div class="field"><label>Replacement content type</label><input name="contentType" placeholder="text/plain"></div><div class="alert info"><strong>Rename workflow</strong><br>To rename an object, copy it to the new key, verify the copy, and then delete the source.</div>`, "Copy", async data => {
    const destination = String(data.get("key")); const directive = String(data.get("metadataDirective")); const headers = { "x-amz-copy-source": copySource(bucket, source, versionId), "x-amz-metadata-directive": directive };
    if (directive === "REPLACE") { const metadata = JSON.parse(String(data.get("metadata") || "{}")); for (const [name, value] of Object.entries(metadata)) headers[`x-amz-meta-${name}`] = String(value); const contentType = String(data.get("contentType") ?? "").trim(); if (contentType) headers["content-type"] = contentType; }
    await s3Request(objectPath(bucket, destination), { method: "PUT", headers }); context.toast("Object copied");
  });
}

function bindObjectPageActions(context, bucket, key, versionId) {
  document.querySelector("[data-object-page-download]")?.addEventListener("click", () => inlineAction(context, () => downloadObject(bucket, key, versionId)));
  document.querySelector("[data-object-page-copy]")?.addEventListener("click", () => copyObjectAction(context, bucket, key, versionId));
  document.querySelector("[data-object-page-delete]")?.addEventListener("click", () => {
    const label = versionId !== undefined ? "Delete version permanently" : "Delete object";
    context.confirmDeletion(versionId ?? key, `${label} ${versionId !== undefined ? versionId : key}?${versionId === undefined ? " In a versioned bucket this creates a delete marker." : " This cannot be undone."}`, async () => {
      await s3Request(objectRequestPath(bucket, key, "", versionId), { method: "DELETE" }); context.toast(versionId !== undefined ? "Object version permanently deleted" : "Object deleted"); location.hash = objectPageHref(bucket, key, "versions");
    });
  });
}

function objectPageHeader(bucket, key, versionId, { downloadable = true } = {}) {
  const version = versionId !== undefined ? `<span class="status-badge">Version ${escapeHtml(versionId)}</span>` : "";
  return pageHeader(key.split("/").at(-1) || key, `<span class="mono s3-object-full-key">${escapeHtml(key)}</span>${version}`, `${downloadable ? '<button class="button" data-object-page-download>Download</button><button class="button" data-object-page-copy>Copy</button>' : ""}<button class="button danger" data-object-page-delete>${versionId !== undefined ? "Delete version permanently" : "Delete object"}</button>`);
}

async function objectsPage(context, bucket, prefix = "") {
  const result = await s3Request(`${objectPath(bucket)}?list-type=2&delimiter=%2F&prefix=${encodeURIComponent(prefix)}&fetch-owner=true`); const root = result.xml.documentElement; const objects = direct(root, "Contents").map(node => ({ key: first(node, "Key"), size: Number(first(node, "Size")), modified: first(node, "LastModified"), etag: first(node, "ETag"), storageClass: first(node, "StorageClass") || "STANDARD" })); const prefixes = direct(root, "CommonPrefixes").map(node => first(node, "Prefix")); context.setChrome("s3", ["S3", "General purpose buckets", bucket]);
  const parent = prefix ? prefix.replace(/[^/]+\/$/, "") : ""; context.main.innerHTML = `<div class="page-width">${pageHeader(bucket, `s3://${escapeHtml(bucket)}/${escapeHtml(prefix)}`, `<button class="button" data-action="create-folder">Create folder</button><button class="button primary" data-action="upload-object">Upload</button>`)}${bucketTabs(bucket, "objects")}<div class="toolbar"><div class="actions">${prefix ? `<a class="button" href="#/s3/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(parent)}">← Parent</a>` : ""}<a class="button" href="#/s3/buckets/${encodeURIComponent(bucket)}/versions">Show versions</a><button class="button danger" data-action="delete-selected" disabled>Delete selected</button></div><span id="s3-upload-progress" class="muted" hidden></span></div><section class="card"><div class="card-header"><h2>Objects <span class="muted">(${objects.length + prefixes.length})</span></h2></div><div class="table-wrap">${objects.length || prefixes.length ? `<table><thead><tr><th><input type="checkbox" data-select-all aria-label="Select all objects"></th><th>Name</th><th>Type</th><th>Last modified</th><th>Size</th><th>Actions</th></tr></thead><tbody>${prefixes.map(value => `<tr><td></td><td><a href="#/s3/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(value)}">📁 ${escapeHtml(value.slice(prefix.length))}</a></td><td>Folder</td><td>–</td><td>–</td><td></td></tr>`).join("")}${objects.map(object => `<tr><td><input type="checkbox" data-object-select value="${escapeHtml(object.key)}" aria-label="Select ${escapeHtml(object.key)}"></td><td><a href="${objectPageHref(bucket, object.key)}">${escapeHtml(object.key.slice(prefix.length))}</a></td><td>Object</td><td>${escapeHtml(new Date(object.modified).toLocaleString())}</td><td>${humanBytes(object.size)}</td><td class="no-wrap"><button class="button link" data-object-preview="${escapeHtml(object.key)}">Preview</button><button class="button link" data-object-copy="${escapeHtml(object.key)}">Copy</button><button class="button link" data-object-download="${escapeHtml(object.key)}">Download</button></td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No objects", prefix ? "This prefix is empty." : "Upload an object or create a folder marker.", '<button class="button primary" data-action="upload-object">Upload</button>')}</div></section></div>`;
  context.main.querySelector("thead th:last-child")?.insertAdjacentHTML("beforebegin", "<th>Storage class</th>");
  for (const row of context.main.querySelectorAll("tbody tr")) {
    const objectLink = row.querySelector(`a[href*="/object/"]`); const key = objectLink ? objects.find(object => objectPageHref(bucket, object.key) === objectLink.getAttribute("href"))?.key : undefined;
    row.lastElementChild?.insertAdjacentHTML("beforebegin", `<td>${key ? escapeHtml(objects.find(object => object.key === key)?.storageClass || "STANDARD") : "–"}</td>`);
  }
  const selected = () => [...document.querySelectorAll("[data-object-select]:checked")].map(input => input.value); const updateDelete = () => { document.querySelector('[data-action="delete-selected"]').disabled = selected().length === 0; }; document.querySelectorAll("[data-object-select]").forEach(input => input.addEventListener("change", updateDelete)); document.querySelector("[data-select-all]")?.addEventListener("change", event => { document.querySelectorAll("[data-object-select]").forEach(input => { input.checked = event.target.checked; }); updateDelete(); });
  document.querySelectorAll('[data-action="upload-object"]').forEach(button => button.addEventListener("click", () => { let controller; context.showModal("Upload object", `<div class="field"><label>File</label><input type="file" name="file" required></div><div class="field"><label>Destination key</label><input name="key" value="${escapeHtml(prefix)}"><span class="hint">Leave this as a folder prefix to use the file name. Files larger than 5 MiB use restart-safe multipart upload with one retry per part.</span></div><button class="button danger" type="button" data-cancel-s3-upload hidden>Abort transfer</button>`, "Upload", async data => { const file = data.get("file"); if (!(file instanceof File) || !file.name) throw new Error("Choose a file"); let key = String(data.get("key")); if (!key || key.endsWith("/")) key += file.name; controller = new AbortController(); const cancel = document.querySelector("[data-cancel-s3-upload]"); cancel.hidden = false; cancel.onclick = () => controller.abort(); try { await uploadObject(bucket, key, file, context, controller.signal); context.toast("Object uploaded"); } finally { cancel.hidden = true; } }); }));
  document.querySelector('[data-action="create-folder"]')?.addEventListener("click", () => context.showModal("Create folder", `<div class="field"><label>Folder name</label><input name="name" required pattern="[^/]+" placeholder="images"></div>`, "Create folder", async data => { const key = `${prefix}${data.get("name")}/`; await s3Request(objectPath(bucket, key), { method: "PUT", body: new Uint8Array() }); context.toast("Folder created"); }));
  document.querySelector('[data-action="delete-selected"]')?.addEventListener("click", () => { const keys = selected(); context.showModal("Delete objects", `<div class="alert warning"><strong>Permanent request</strong><br>${keys.length} selected object${keys.length === 1 ? "" : "s"} will be deleted. In a versioned bucket this creates delete markers.</div><p>${keys.map(escapeHtml).join("<br>")}</p>`, "Delete", async () => { const body = `<Delete>${keys.map(key => `<Object><Key>${xmlEscape(key)}</Key></Object>`).join("")}<Quiet>false</Quiet></Delete>`; const checksum = await sha256Base64(body); const result = await s3Request(`${objectPath(bucket)}?delete`, { method: "POST", headers: { "content-type": "application/xml", "x-amz-checksum-sha256": checksum }, body }); const deleted = result.xml?.getElementsByTagName("Deleted").length ?? 0; const errors = result.xml?.getElementsByTagName("Error").length ?? 0; context.toast(`${deleted} deleted${errors ? `, ${errors} failed` : ""}`, errors ? "error" : "success"); }, false, { danger: true }); });
  document.querySelectorAll("[data-object-download]").forEach(button => button.addEventListener("click", () => inlineAction(context, () => downloadObject(bucket, button.dataset.objectDownload))));
  document.querySelectorAll("[data-object-preview]").forEach(button => button.addEventListener("click", async () => { const key = button.dataset.objectPreview; const output = await s3Request(objectPath(bucket, key), { headers: { range: "bytes=0-4095" } }); context.showModal("Object preview", `<p class="muted">First ${output.body.length.toLocaleString()} bytes of ${escapeHtml(key)}</p><pre class="code-box">${escapeHtml(output.text)}</pre>`, "Close", async () => undefined, true, { refreshAfterSubmit: false }); }));
  document.querySelectorAll("[data-object-copy]").forEach(button => button.addEventListener("click", () => copyObjectAction(context, bucket, button.dataset.objectCopy)));
}

const objectSystemMetadata = [
  ["Content type", "content-type"], ["Content encoding", "content-encoding"], ["Content disposition", "content-disposition"], ["Content language", "content-language"],
  ["Cache control", "cache-control"], ["Expires", "expires"], ["Website redirect location", "x-amz-website-redirect-location"],
];

function objectAddressRows(bucket, key, versionId) {
  const localUrl = `${location.origin}${objectRequestPath(bucket, key, "", versionId)}`;
  return `<dt>S3 URI</dt><dd class="mono">s3://${escapeHtml(bucket)}/${escapeHtml(key)}</dd><dt>ARN</dt><dd class="mono">arn:aws:s3:::${escapeHtml(bucket)}/${escapeHtml(key)}</dd><dt>Local object URL</dt><dd class="mono">${escapeHtml(localUrl)}</dd>`;
}

function tagsTable(tags) {
  return tags.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(([name, value]) => `<tr><td class="mono">${escapeHtml(name)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No object tags.</p>';
}

function tagInputRow(name = "", value = "") {
  return `<div class="s3-object-tag-row"><input name="tagKey" aria-label="Tag key" value="${escapeHtml(name)}" placeholder="Key"><input name="tagValue" aria-label="Tag value" value="${escapeHtml(value)}" placeholder="Value"><button class="button link danger" type="button" data-remove-object-tag>Remove</button></div>`;
}

function parseRestoreHeader(value) {
  if (!value) return { state: "Not requested" };
  if (/ongoing-request="true"/.test(value)) return { state: "In progress" };
  const expiry = value.match(/expiry-date="([^"]+)"/)?.[1]; return { state: "Temporarily restored", expiry };
}

async function objectPropertiesPage(context, bucket, key, versionId) {
  const [head, tagging, annotations, acl, bucketSummary] = await Promise.all([
    s3Request(objectRequestPath(bucket, key, "", versionId), { method: "HEAD", headers: { "x-amz-checksum-mode": "ENABLED" } }),
    s3Request(objectRequestPath(bucket, key, "tagging", versionId)),
    s3Request(objectRequestPath(bucket, key, "annotation", versionId)),
    s3Request(objectRequestPath(bucket, key, "acl", versionId)),
    listBuckets().then(values => values.find(value => value.name === bucket)),
  ]);
  const headers = Object.fromEntries(head.response.headers); const storageClass = headers["x-amz-storage-class"] || "STANDARD"; const restore = parseRestoreHeader(headers["x-amz-restore"]); const archived = ["GLACIER", "DEEP_ARCHIVE"].includes(storageClass); const downloadable = !archived || restore.state === "Temporarily restored";
  const checksum = Object.entries(headers).find(([name]) => name.startsWith("x-amz-checksum-") && name !== "x-amz-checksum-type");
  const owner = acl.xml?.getElementsByTagName("Owner")?.[0]; const tags = [...tagging.xml.getElementsByTagName("Tag")].map(node => [first(node, "Key"), first(node, "Value")]);
  const annotationRows = [...annotations.xml.getElementsByTagName("AnnotationEntry")].map(node => ({ name: first(node, "AnnotationName"), modified: first(node, "LastModified"), etag: first(node, "ETag"), algorithm: first(node, "ChecksumAlgorithm"), size: first(node, "Size") }));
  const retentionMode = headers["x-amz-object-lock-mode"]; const retainUntil = headers["x-amz-object-lock-retain-until-date"]; const legalHold = headers["x-amz-object-lock-legal-hold"] || "OFF"; const lockConfigured = Boolean(bucketSummary?.objectLockEnabled || retentionMode || headers["x-amz-object-lock-legal-hold"]); const annotationsLocked = legalHold === "ON" || Boolean(retainUntil && new Date(retainUntil).getTime() > Date.now());
  const systemMetadata = objectSystemMetadata.filter(([, name]) => headers[name]); const userMetadata = Object.entries(headers).filter(([name]) => name.startsWith("x-amz-meta-")).map(([name, value]) => [name.slice(11), value]);
  const encryptionRows = headers["x-amz-server-side-encryption-customer-algorithm"]
    ? `<dt>Encryption</dt><dd>${escapeHtml(headers["x-amz-server-side-encryption-customer-algorithm"])}</dd><dt>Customer key MD5</dt><dd class="mono">${escapeHtml(headers["x-amz-server-side-encryption-customer-key-md5"] || "–")}</dd>`
    : `<dt>Encryption</dt><dd>${escapeHtml(headers["x-amz-server-side-encryption"] || "AES256")}</dd>${headers["x-amz-server-side-encryption-aws-kms-key-id"] ? `<dt>KMS key descriptor</dt><dd class="mono">${escapeHtml(headers["x-amz-server-side-encryption-aws-kms-key-id"])}</dd>` : ""}${headers["x-amz-server-side-encryption-bucket-key-enabled"] !== undefined ? `<dt>Bucket key</dt><dd>${headers["x-amz-server-side-encryption-bucket-key-enabled"] === "true" ? "Enabled" : "Disabled"}</dd>` : ""}`;
  const metadataCard = systemMetadata.length || userMetadata.length ? `<section class="card"><div class="card-header"><h2>Metadata</h2></div><div class="card-body"><dl class="key-value">${systemMetadata.map(([label, name]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(headers[name])}</dd>`).join("")}</dl>${userMetadata.length ? `<h3>User metadata</h3><div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${userMetadata.map(([name, value]) => `<tr><td class="mono">${escapeHtml(name)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div>` : ""}</div></section>` : "";
  const annotationTable = annotationRows.length ? `<div class="table-wrap"><table class="s3-object-annotations"><thead><tr><th>Name</th><th>Last modified</th><th>Size</th><th>ETag</th><th>Checksum</th><th>Actions</th></tr></thead><tbody>${annotationRows.map(row => `<tr><td class="mono">${escapeHtml(row.name)}</td><td>${escapeHtml(new Date(row.modified).toLocaleString())}</td><td>${humanBytes(row.size)}</td><td class="mono">${escapeHtml(row.etag)}</td><td>${escapeHtml(row.algorithm)}</td><td class="no-wrap"><button class="button link" data-view-object-annotation="${escapeHtml(row.name)}">View</button><button class="button link danger" data-delete-object-annotation="${escapeHtml(row.name)}" ${annotationsLocked ? "disabled" : ""}>Delete</button></td></tr>`).join("")}</tbody></table></div>` : '<div class="s3-object-annotations-empty"><p class="muted">No annotations.</p></div>';
  context.setChrome("s3", objectBreadcrumbs(bucket, key));
  context.main.innerHTML = `<div class="page-width s3-object-detail">${objectPageHeader(bucket, key, versionId, { downloadable })}${objectTabs(bucket, key, "properties", versionId)}
    <section class="card"><div class="card-header"><h2>Object overview</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Key</dt><dd class="mono">${escapeHtml(key)}</dd><dt>Version ID</dt><dd class="mono">${escapeHtml(headers["x-amz-version-id"] || versionId || "null")}</dd><dt>Owner</dt><dd>${escapeHtml(first(owner, "DisplayName") || "Local AWS account")}<br><span class="mono">${escapeHtml(first(owner, "ID") || "–")}</span></dd></dl><dl class="key-value"><dt>Last modified</dt><dd>${escapeHtml(new Date(headers["last-modified"]).toLocaleString())}</dd><dt>Size</dt><dd>${humanBytes(headers["content-length"])}</dd><dt>ETag</dt><dd class="mono">${escapeHtml(headers.etag)}</dd><dt>Content type</dt><dd>${escapeHtml(headers["content-type"] || "–")}</dd><dt>Storage class</dt><dd>${escapeHtml(storageClass)}</dd></dl><dl class="key-value">${objectAddressRows(bucket, key, versionId)}</dl></div><div class="card-body s3-object-guidance"><details><summary>Presigned URL guidance</summary><div class="alert info"><strong>Local learning workflow</strong><br>Generate the URL in your application with temporary credentials. Secret keys are used to sign locally and never appear in the URL.</div><pre class="code-box">import { getSignedUrl } from &quot;@aws-sdk/s3-request-presigner&quot;;\n\nconst url = await getSignedUrl(s3, new GetObjectCommand({\n  Bucket: &quot;${escapeHtml(bucket)}&quot;,\n  Key: &quot;${escapeHtml(key)}&quot;${versionId !== undefined ? `,\n  VersionId: &quot;${escapeHtml(versionId)}&quot;` : ""}\n}), { expiresIn: 900 });</pre></details></div></section>
    <section class="card"><div class="card-header"><h2>Server-side encryption</h2></div><div class="card-body"><dl class="key-value">${encryptionRows}</dl>${headers["x-amz-server-side-encryption-aws-kms-key-id"] ? '<p class="muted">KMS values are dependency descriptors; StackSim does not provide KMS key management.</p>' : ""}</div></section>
    ${checksum ? `<section class="card"><div class="card-header"><h2>Checksums</h2></div><div class="card-body"><dl class="key-value"><dt>Algorithm</dt><dd>${escapeHtml(checksum[0].slice("x-amz-checksum-".length).toUpperCase())}</dd><dt>Value</dt><dd class="mono">${escapeHtml(checksum[1])}</dd><dt>Type</dt><dd>${escapeHtml(headers["x-amz-checksum-type"] || "FULL_OBJECT")}</dd></dl></div></section>` : ""}
    ${metadataCard}
    <section class="card"><div class="card-header"><h2>Tags</h2><button class="button" data-edit-object-tags>Edit</button></div><div class="card-body" data-object-tag-view>${tagsTable(tags)}</div><form class="card-body s3-object-inline-editor" data-object-tag-editor hidden><div data-object-tag-rows>${(tags.length ? tags : [["", ""]]).map(([name, value]) => tagInputRow(name, value)).join("")}</div><div class="actions"><button class="button" type="button" data-add-object-tag>Add tag</button><button class="button" type="button" data-cancel-object-tags>Cancel</button><button class="button primary" type="submit">Save tags</button></div></form></section>
    ${lockConfigured ? `<section class="card"><div class="card-header"><h2>Object Lock retention</h2><button class="button" data-edit-object-retention>${retentionMode ? "Edit" : "Add retention"}</button></div><div class="card-body" data-object-retention-view><dl class="key-value"><dt>Mode</dt><dd>${escapeHtml(retentionMode || "Not configured")}</dd><dt>Retain until</dt><dd>${retainUntil ? escapeHtml(new Date(retainUntil).toLocaleString()) : "–"}</dd></dl></div><form class="card-body s3-object-inline-editor" data-object-retention-editor hidden><div class="field-row"><div class="field"><label>Retention mode</label><select name="mode"><option ${retentionMode === "GOVERNANCE" ? "selected" : ""}>GOVERNANCE</option><option ${retentionMode === "COMPLIANCE" ? "selected" : ""}>COMPLIANCE</option></select></div><div class="field"><label>Retain until</label><input name="retainUntil" type="datetime-local" required value="${escapeHtml(retainUntil ? new Date(retainUntil).toISOString().slice(0, 16) : new Date(Date.now() + 86_400_000).toISOString().slice(0, 16))}"></div></div><label class="setting-option" data-retention-bypass hidden><input type="checkbox" name="bypass"><span><strong>Bypass governance retention</strong><small>Requires permission and is shown only when shortening an existing GOVERNANCE retention period.</small></span></label><div class="actions s3-object-form-actions"><button class="button" type="button" data-cancel-object-retention>Cancel</button><button class="button primary" type="submit">Save retention</button></div></form></section>
    <section class="card"><div class="card-header"><h2>Legal hold</h2><button class="button" data-edit-object-legal-hold>Edit</button></div><div class="card-body" data-object-legal-hold-view><span class="status ${legalHold === "ON" ? "warning" : "inactive"}">${legalHold === "ON" ? "On" : "Off"}</span></div><form class="card-body s3-object-inline-editor" data-object-legal-hold-editor hidden><div class="field"><label>Legal hold</label><select name="legalHold"><option value="OFF" ${legalHold !== "ON" ? "selected" : ""}>Off</option><option value="ON" ${legalHold === "ON" ? "selected" : ""}>On</option></select></div><div class="actions s3-object-form-actions"><button class="button" type="button" data-cancel-object-legal-hold>Cancel</button><button class="button primary" type="submit">Save legal hold</button></div></form></section>` : ""}
    <section class="card"><div class="card-header"><div><h2>Annotations <span class="muted">(${annotationRows.length})</span></h2><p class="muted small">Version-scoped UTF-8 object annotations</p></div><button class="button" data-create-object-annotation ${annotationsLocked ? "disabled" : ""}>Create annotation</button></div>${annotationsLocked ? '<div class="card-body"><div class="alert info"><strong>Annotations are read-only</strong><br>Annotations cannot be changed while this version is retained or under legal hold.</div></div>' : ""}${annotationTable}<div class="card-body" data-object-annotation-view hidden></div><form class="card-body s3-object-inline-editor" data-object-annotation-editor hidden><div class="field"><label>Annotation name</label><input name="annotationName" required maxlength="512"></div><div class="field"><label>UTF-8 annotation payload</label><textarea name="annotationPayload" required></textarea></div><div class="actions s3-object-form-actions"><button class="button" type="button" data-cancel-object-annotation>Cancel</button><button class="button primary" type="submit">Save annotation</button></div></form></section>
    ${archived ? `<section class="card"><div class="card-header"><h2>Archive restore</h2>${restore.state === "In progress" ? '<span class="status pending">In progress</span>' : ""}</div><div class="card-body"><dl class="key-value"><dt>Storage class</dt><dd>${escapeHtml(storageClass)}</dd><dt>Restore status</dt><dd>${escapeHtml(restore.state)}</dd>${restore.expiry ? `<dt>Available until</dt><dd>${escapeHtml(new Date(restore.expiry).toLocaleString())}</dd>` : ""}</dl>${restore.state !== "In progress" ? `<form data-object-restore><div class="field-row"><div class="field"><label>Restore tier</label><select name="tier"><option>Standard</option><option>Expedited</option><option>Bulk</option></select></div><div class="field"><label>Available for days</label><input type="number" min="1" name="days" value="1" required></div></div><button class="button primary" type="submit">${restore.state === "Temporarily restored" ? "Extend restore" : "Request restore"}</button></form>` : ""}</div></section>` : ""}
  </div>`;
  bindObjectPageActions(context, bucket, key, versionId);
  const toggle = (buttonSelector, viewSelector, editorSelector, cancelSelector) => { const view = document.querySelector(viewSelector); const editor = document.querySelector(editorSelector); const show = () => { view.hidden = true; editor.hidden = false; editor.querySelector("input, select, textarea")?.focus(); }; const hide = () => { editor.hidden = true; view.hidden = false; }; document.querySelector(buttonSelector)?.addEventListener("click", show); document.querySelector(cancelSelector)?.addEventListener("click", hide); };
  toggle("[data-edit-object-tags]", "[data-object-tag-view]", "[data-object-tag-editor]", "[data-cancel-object-tags]");
  document.querySelector("[data-add-object-tag]")?.addEventListener("click", () => document.querySelector("[data-object-tag-rows]")?.insertAdjacentHTML("beforeend", tagInputRow()));
  document.querySelector("[data-object-tag-rows]")?.addEventListener("click", event => { if (event.target.closest("[data-remove-object-tag]")) event.target.closest(".s3-object-tag-row")?.remove(); });
  document.querySelector("[data-object-tag-editor]")?.addEventListener("submit", event => { event.preventDefault(); inlineAction(context, async () => { const data = new FormData(event.currentTarget); const keys = data.getAll("tagKey").map(value => String(value).trim()); const values = data.getAll("tagValue").map(String); const rows = keys.map((name, index) => [name, values[index]]).filter(([name, value]) => name || value); if (rows.some(([name]) => !name)) throw new Error("Every tag value requires a key"); if (new Set(rows.map(([name]) => name)).size !== rows.length) throw new Error("Tag keys must be unique"); if (rows.length > 10) throw new Error("An object can have at most 10 tags"); const body = `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${rows.map(([name, value]) => `<Tag><Key>${xmlEscape(name)}</Key><Value>${xmlEscape(value)}</Value></Tag>`).join("")}</TagSet></Tagging>`; await s3Request(objectRequestPath(bucket, key, "tagging", versionId), { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Object tags updated"); await context.route(false); }); });
  if (lockConfigured) {
    toggle("[data-edit-object-retention]", "[data-object-retention-view]", "[data-object-retention-editor]", "[data-cancel-object-retention]"); toggle("[data-edit-object-legal-hold]", "[data-object-legal-hold-view]", "[data-object-legal-hold-editor]", "[data-cancel-object-legal-hold]");
    const retentionForm = document.querySelector("[data-object-retention-editor]"); const updateBypass = () => { const requested = new Date(retentionForm.elements.retainUntil.value).getTime(); const bypass = retentionForm.querySelector("[data-retention-bypass]"); bypass.hidden = !(retentionMode === "GOVERNANCE" && retainUntil && requested < new Date(retainUntil).getTime()); }; retentionForm?.elements.retainUntil.addEventListener("change", updateBypass); updateBypass();
    retentionForm?.addEventListener("submit", event => { event.preventDefault(); inlineAction(context, async () => { const data = new FormData(event.currentTarget); const date = new Date(String(data.get("retainUntil"))); if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Retain until must be a future date"); const body = `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${xmlEscape(String(data.get("mode")))}</Mode><RetainUntilDate>${date.toISOString()}</RetainUntilDate></Retention>`; await s3Request(objectRequestPath(bucket, key, "retention", versionId), { method: "PUT", headers: { "content-type": "application/xml", ...(data.get("bypass") === "on" ? { "x-amz-bypass-governance-retention": "true" } : {}) }, body }); context.toast("Object retention updated"); await context.route(false); }); });
    document.querySelector("[data-object-legal-hold-editor]")?.addEventListener("submit", event => { event.preventDefault(); inlineAction(context, async () => { const data = new FormData(event.currentTarget); const body = `<LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${xmlEscape(String(data.get("legalHold")))}</Status></LegalHold>`; await s3Request(objectRequestPath(bucket, key, "legal-hold", versionId), { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Legal hold updated"); await context.route(false); }); });
  }
  const annotationEditor = document.querySelector("[data-object-annotation-editor]"); document.querySelector("[data-create-object-annotation]")?.addEventListener("click", () => { annotationEditor.hidden = false; annotationEditor.querySelector("input")?.focus(); }); document.querySelector("[data-cancel-object-annotation]")?.addEventListener("click", () => { annotationEditor.hidden = true; });
  annotationEditor?.addEventListener("submit", event => { event.preventDefault(); inlineAction(context, async () => { const data = new FormData(event.currentTarget); await s3Request(objectRequestPath(bucket, key, `annotation&annotationName=${encodeURIComponent(String(data.get("annotationName")))}`, versionId), { method: "PUT", headers: { "content-type": "text/plain; charset=utf-8" }, body: String(data.get("annotationPayload")) }); context.toast("Annotation saved"); await context.route(false); }); });
  document.querySelectorAll("[data-view-object-annotation]").forEach(button => button.addEventListener("click", () => inlineAction(context, async () => { const result = await s3Request(objectRequestPath(bucket, key, `annotation&annotationName=${encodeURIComponent(button.dataset.viewObjectAnnotation)}`, versionId)); const target = document.querySelector("[data-object-annotation-view]"); target.hidden = false; target.innerHTML = `<h3>${escapeHtml(button.dataset.viewObjectAnnotation)}</h3><pre class="code-box">${escapeHtml(result.text)}</pre>`; target.scrollIntoView({ block: "nearest" }); })));
  document.querySelectorAll("[data-delete-object-annotation]").forEach(button => button.addEventListener("click", () => inlineAction(context, async () => { await s3Request(objectRequestPath(bucket, key, `annotation&annotationName=${encodeURIComponent(button.dataset.deleteObjectAnnotation)}`, versionId), { method: "DELETE" }); context.toast("Annotation deleted"); await context.route(false); })));
  document.querySelector("[data-object-restore]")?.addEventListener("submit", event => { event.preventDefault(); inlineAction(context, async () => { const data = new FormData(event.currentTarget); const body = `<RestoreRequest xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Days>${Number(data.get("days"))}</Days><GlacierJobParameters><Tier>${xmlEscape(String(data.get("tier")))}</Tier></GlacierJobParameters></RestoreRequest>`; await s3Request(objectRequestPath(bucket, key, "restore", versionId), { method: "POST", headers: { "content-type": "application/xml" }, body }); context.toast("Archive restore requested"); await context.route(false); }); });
}

function aclGranteeLabel(value) {
  if (value.endsWith("/AllUsers")) return "Everyone (public access)"; if (value.endsWith("/AuthenticatedUsers")) return "Authenticated users group"; if (value.endsWith("/LogDelivery")) return "S3 Log Delivery group"; return "Canonical user";
}

async function objectPermissionsPage(context, bucket, key, versionId) {
  const [acl, ownershipResult, head] = await Promise.all([s3Request(objectRequestPath(bucket, key, "acl", versionId)), optionalBucketConfiguration(bucket, "ownershipControls", ["OwnershipControlsNotFoundError"]), s3Request(objectRequestPath(bucket, key, "", versionId), { method: "HEAD" })]);
  const ownership = first(ownershipResult?.xml, "ObjectOwnership") || "ObjectWriter"; const owner = acl.xml.getElementsByTagName("Owner")[0]; const grants = [...acl.xml.getElementsByTagName("Grant")].map(node => ({ permission: first(node, "Permission"), value: first(node, "ID") || first(node, "URI"), group: Boolean(first(node, "URI")) })); const permissionHeaders = Object.fromEntries(head.response.headers); const storageClass = permissionHeaders["x-amz-storage-class"] || "STANDARD"; const restore = parseRestoreHeader(permissionHeaders["x-amz-restore"]); const downloadable = !["GLACIER", "DEEP_ARCHIVE"].includes(storageClass) || restore.state === "Temporarily restored";
  context.setChrome("s3", objectBreadcrumbs(bucket, key)); context.main.innerHTML = `<div class="page-width s3-object-detail">${objectPageHeader(bucket, key, versionId, { downloadable })}${objectTabs(bucket, key, "permissions", versionId)}
    <section class="card"><div class="card-header"><h2>Object owner</h2></div><div class="card-body"><dl class="key-value"><dt>Display name</dt><dd>${escapeHtml(first(owner, "DisplayName") || "Local AWS account")}</dd><dt>Canonical ID</dt><dd class="mono">${escapeHtml(first(owner, "ID"))}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Object Ownership</h2><span class="status ${ownership === "BucketOwnerEnforced" ? "inactive" : ""}">${ownership === "BucketOwnerEnforced" ? "ACLs disabled" : "ACLs enabled"}</span></div><div class="card-body"><p><strong>${escapeHtml(ownership)}</strong></p><p class="muted">${ownership === "BucketOwnerEnforced" ? "The bucket owner owns objects and ACL grants do not participate in authorization." : "The selected object's ACL grants participate in authorization."}</p><a href="#/s3/buckets/${encodeURIComponent(bucket)}/permissions">Open bucket permissions</a></div></section>
    <section class="card"><div class="card-header"><h2>Object access control list (ACL)</h2>${ownership === "BucketOwnerEnforced" ? '<span class="status inactive">Disabled</span>' : '<button class="button" data-edit-object-acl>Edit</button>'}</div><div class="table-wrap"><table><thead><tr><th>Grantee</th><th>ID or group URI</th><th>Permission</th></tr></thead><tbody>${grants.map(grant => `<tr><td>${escapeHtml(grant.group ? aclGranteeLabel(grant.value) : first(owner, "ID") === grant.value ? "Object owner" : "Canonical user")}</td><td class="mono">${escapeHtml(grant.value)}</td><td>${escapeHtml(grant.permission)}</td></tr>`).join("")}</tbody></table></div>${ownership !== "BucketOwnerEnforced" ? `<form class="card-body s3-object-inline-editor" data-object-acl-editor hidden><div class="field"><label>Canned object ACL</label><select name="acl"><option value="private">Private</option><option value="public-read">Public read</option><option value="authenticated-read">Authenticated users read</option><option value="bucket-owner-read">Bucket owner read</option><option value="bucket-owner-full-control">Bucket owner full control</option></select></div><div data-public-object-acl-confirmation hidden><label class="setting-option"><input type="checkbox" name="ack"><span><strong>I acknowledge that this ACL can expose object data.</strong></span></label><div class="field"><label>Type the bucket name to confirm</label><input name="confirm" autocomplete="off"></div></div><div class="actions s3-object-form-actions"><button class="button" type="button" data-cancel-object-acl>Cancel</button><button class="button primary" type="submit">Save ACL</button></div></form>` : ""}</section>
    <div class="alert info"><strong>Effective access uses more than this ACL.</strong><br>Identity policies, the bucket policy, Block Public Access, session policy, permissions boundaries, and explicit denies are evaluated separately. StackSim does not present IAM Access Analyzer findings here.</div>
  </div>`; bindObjectPageActions(context, bucket, key, versionId);
  if (ownership !== "BucketOwnerEnforced") { const form = document.querySelector("[data-object-acl-editor]"); const viewConfirmation = () => { const publicAcl = ["public-read", "authenticated-read"].includes(form.elements.acl.value); const region = form.querySelector("[data-public-object-acl-confirmation]"); region.hidden = !publicAcl; region.querySelector('[name="ack"]').required = publicAcl; region.querySelector('[name="confirm"]').required = publicAcl; }; document.querySelector("[data-edit-object-acl]")?.addEventListener("click", () => { form.hidden = false; form.elements.acl.focus(); }); document.querySelector("[data-cancel-object-acl]")?.addEventListener("click", () => { form.hidden = true; }); form.elements.acl.addEventListener("change", viewConfirmation); viewConfirmation(); form.addEventListener("submit", event => { event.preventDefault(); inlineAction(context, async () => { const data = new FormData(event.currentTarget); const publicAcl = ["public-read", "authenticated-read"].includes(String(data.get("acl"))); if (publicAcl && (data.get("ack") !== "on" || data.get("confirm") !== bucket)) throw new Error("Acknowledge public access and enter the bucket name"); await s3Request(objectRequestPath(bucket, key, "acl", versionId), { method: "PUT", headers: { "x-amz-acl": String(data.get("acl")) } }); context.toast("Object ACL updated"); await context.route(false); }); }); }
}

async function exactObjectVersions(bucket, key) {
  const rows = []; let keyMarker = ""; let versionMarker = "";
  do {
    const path = `${objectPath(bucket)}?versions&prefix=${encodeURIComponent(key)}&max-keys=1000${keyMarker ? `&key-marker=${encodeURIComponent(keyMarker)}` : ""}${versionMarker ? `&version-id-marker=${encodeURIComponent(versionMarker)}` : ""}`; const output = await s3Request(path); const root = output.xml.documentElement;
    rows.push(...[...root.children].filter(node => ["Version", "DeleteMarker"].includes(node.localName) && first(node, "Key") === key).map(node => ({ marker: node.localName === "DeleteMarker", versionId: first(node, "VersionId"), latest: first(node, "IsLatest") === "true", modified: first(node, "LastModified"), etag: first(node, "ETag"), size: first(node, "Size"), storageClass: first(node, "StorageClass"), checksumAlgorithm: first(node, "ChecksumAlgorithm"), checksumType: first(node, "ChecksumType") })));
    if (first(root, "IsTruncated") !== "true") break; keyMarker = first(root, "NextKeyMarker"); versionMarker = first(root, "NextVersionIdMarker");
  } while (keyMarker || versionMarker);
  return rows;
}

async function objectVersionsPage(context, bucket, key, selectedVersionId) {
  const rows = await exactObjectVersions(bucket, key); context.setChrome("s3", objectBreadcrumbs(bucket, key));
  context.main.innerHTML = `<div class="page-width s3-object-detail">${pageHeader(key.split("/").at(-1) || key, `<span class="mono s3-object-full-key">${escapeHtml(key)}</span>`)}${objectTabs(bucket, key, "versions", selectedVersionId)}<section class="card"><div class="card-header"><h2>Versions <span class="muted">(${rows.length})</span></h2></div><div class="table-wrap">${rows.length ? `<table class="s3-object-version-table"><thead><tr><th>Version ID</th><th>Type</th><th>Latest</th><th>Last modified</th><th>Size</th><th>Storage class</th><th>Checksum</th><th>Actions</th></tr></thead><tbody>${rows.map(row => `<tr ${row.versionId === selectedVersionId ? 'class="s3-selected-version"' : ""}><td class="mono">${escapeHtml(row.versionId)}</td><td>${row.marker ? "Delete marker" : "Object version"}</td><td>${row.latest ? "Yes" : "No"}</td><td>${escapeHtml(new Date(row.modified).toLocaleString())}</td><td>${row.marker ? "–" : humanBytes(row.size)}</td><td>${escapeHtml(row.storageClass || "–")}</td><td>${row.checksumAlgorithm ? `${escapeHtml(row.checksumAlgorithm)}${row.checksumType ? `<br><span class="muted small">${escapeHtml(row.checksumType)}</span>` : ""}` : "–"}</td><td><div class="actions">${row.marker ? "" : `<a class="button" href="${objectPageHref(bucket, key, "properties", row.versionId)}">Properties</a><a class="button" href="${objectPageHref(bucket, key, "permissions", row.versionId)}">Permissions</a><button class="button" data-download-object-version="${escapeHtml(row.versionId)}">Download version</button>${row.latest ? "" : `<button class="button" data-restore-object-version="${escapeHtml(row.versionId)}">Restore this version</button>`}`}<button class="button danger" data-delete-object-version="${escapeHtml(row.versionId)}">Delete permanently</button></div></td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No versions", "No version history exists for this object.")}</div></section></div>`;
  document.querySelectorAll("[data-download-object-version]").forEach(button => button.addEventListener("click", () => inlineAction(context, () => downloadObject(bucket, key, button.dataset.downloadObjectVersion))));
  document.querySelectorAll("[data-restore-object-version]").forEach(button => button.addEventListener("click", () => context.showModal("Restore object version", `<p>Copy version <span class="mono">${escapeHtml(button.dataset.restoreObjectVersion)}</span> to the same key and make the copy current?</p><p class="mono">${escapeHtml(key)}</p>`, "Restore", async () => { await s3Request(objectPath(bucket, key), { method: "PUT", headers: { "x-amz-copy-source": copySource(bucket, key, button.dataset.restoreObjectVersion) } }); context.toast("Object version restored"); location.hash = objectPageHref(bucket, key, "versions"); })));
  document.querySelectorAll("[data-delete-object-version]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deleteObjectVersion, `Permanently delete version ${button.dataset.deleteObjectVersion}? This cannot be undone.`, async () => { await s3Request(objectRequestPath(bucket, key, "", button.dataset.deleteObjectVersion), { method: "DELETE" }); context.toast("Object version permanently deleted"); await context.route(false); })));
}

async function getWebsite(bucket) {
  try {
    const result = await s3Request(`${objectPath(bucket)}?website`);
    return { indexDocument: first(result.xml, "Suffix"), errorDocument: first(result.xml, "Key") };
  } catch (error) {
    if (error?.code === "NoSuchWebsiteConfiguration") return undefined;
    throw error;
  }
}

function websiteEndpoint(bucket, controlPlaneEndpoint) {
  return `${controlPlaneEndpoint.replace(/\/+$/, "")}/_stacksim/s3-website/${encodeURIComponent(bucket)}/`;
}

function editWebsite(context, bucket, website) {
  const enabled = Boolean(website);
  context.showModal("Edit static website hosting", `<fieldset class="setting-options"><legend class="field-label">Static website hosting</legend><label class="setting-option"><input type="radio" name="websiteStatus" value="enabled" ${enabled ? "checked" : ""}><span><strong>Enable</strong><small>Use this bucket to host a website.</small></span></label><label class="setting-option"><input type="radio" name="websiteStatus" value="disabled" ${enabled ? "" : "checked"}><span><strong>Disable</strong><small>Turn off the bucket website endpoint.</small></span></label></fieldset><div data-website-fields ${enabled ? "" : "hidden"}><div class="field"><label>Hosting type</label><input value="Host a static website" disabled></div><div class="field"><label>Index document</label><input name="indexDocument" required maxlength="1024" value="${escapeHtml(website?.indexDocument ?? "index.html")}" placeholder="index.html"><span class="hint">The object returned for requests to the website root and folder paths.</span></div><div class="field"><label>Error document <span class="muted small">– optional</span></label><input name="errorDocument" maxlength="1024" value="${escapeHtml(website?.errorDocument ?? "")}" placeholder="error.html"></div></div>`, "Save changes", async data => {
    if (data.get("websiteStatus") === "disabled") {
      await s3Request(`${objectPath(bucket)}?website`, { method: "DELETE" });
      context.toast("Static website hosting disabled");
      return;
    }
    const indexDocument = String(data.get("indexDocument") ?? "").trim();
    const errorDocument = String(data.get("errorDocument") ?? "").trim();
    if (!indexDocument) throw new Error("Index document is required when static website hosting is enabled");
    const body = `<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IndexDocument><Suffix>${xmlEscape(indexDocument)}</Suffix></IndexDocument>${errorDocument ? `<ErrorDocument><Key>${xmlEscape(errorDocument)}</Key></ErrorDocument>` : ""}</WebsiteConfiguration>`;
    await s3Request(`${objectPath(bucket)}?website`, { method: "PUT", headers: { "content-type": "application/xml" }, body });
    context.toast("Static website hosting enabled");
  });
  const fields = document.querySelector("[data-website-fields]");
  const index = fields?.querySelector('[name="indexDocument"]');
  const update = () => {
    const active = document.querySelector('[name="websiteStatus"]:checked')?.value === "enabled";
    if (fields) fields.hidden = !active;
    if (index) index.required = active;
  };
  document.querySelectorAll('[name="websiteStatus"]').forEach(input => input.addEventListener("change", update));
  update();
}

function notificationForm(configuration = {}) {
  const selectedEvents = configuration.events ?? [];
  const events = [...new Set([...S3_NOTIFICATION_EVENTS, ...selectedEvents])];
  return `<div class="field"><label>Configuration ID</label><input name="id" required maxlength="255" value="${escapeHtml(configuration.id ?? "")}" placeholder="images-created"><span class="hint">IDs must be unique within this bucket notification configuration.</span></div><div class="field"><label>Destination type</label><select name="type" required><option value="">Choose a destination</option><option value="queue" ${configuration.type === "queue" ? "selected" : ""}>SQS</option><option value="lambda" ${configuration.type === "lambda" ? "selected" : ""}>Lambda</option></select></div><div class="field"><label>Destination ARN</label><input name="arn" class="mono" required value="${escapeHtml(configuration.arn ?? "")}" placeholder="arn:aws:sqs:eu-west-1:000000000000:uploads"><span class="hint">Use a destination in the bucket Region. Lambda destinations must also be in this account.</span></div><fieldset class="s3-notification-events"><legend>Events</legend><p class="hint">Select one or more event types. Wildcards and specific operations cannot overlap with another configuration using overlapping key filters.</p><div class="s3-notification-event-options">${events.map(event => `<label class="checkbox-label"><input type="checkbox" name="events" value="${escapeHtml(event)}" ${selectedEvents.includes(event) ? "checked" : ""}> <span class="mono">${escapeHtml(event)}</span></label>`).join("")}</div></fieldset><div class="field-row"><div class="field"><label>Prefix <span class="muted small">– optional</span></label><input name="prefix" value="${escapeHtml(configuration.prefix ?? "")}" placeholder="incoming/"></div><div class="field"><label>Suffix <span class="muted small">– optional</span></label><input name="suffix" value="${escapeHtml(configuration.suffix ?? "")}" placeholder=".json"></div></div><div class="alert info"><strong>Destination permission required</strong><br>Lambda needs a resource permission for <span class="mono">s3.amazonaws.com</span>. SQS needs a queue policy allowing this bucket ARN and account. Validation failures leave this form open so you can correct the destination or filters.</div>`;
}

function notificationFromForm(data) {
  const type = String(data.get("type") ?? "");
  const id = String(data.get("id") ?? "").trim();
  const arn = String(data.get("arn") ?? "").trim();
  const events = data.getAll("events").map(String);
  if (!id) throw new Error("Configuration ID is required");
  if (!type || !["queue", "lambda"].includes(type)) throw new Error("Choose an SQS or Lambda destination");
  if (!arn) throw new Error("Destination ARN is required");
  if (!events.length) throw new Error("Select at least one event type");
  return { type, id, arn, events, prefix: String(data.get("prefix") ?? ""), suffix: String(data.get("suffix") ?? "") };
}

async function saveS3NotificationConfiguration(bucket, model) {
  await s3Request(`${objectPath(bucket)}?notification`, { method: "PUT", headers: { "content-type": "application/xml" }, body: serializeS3NotificationConfiguration(model) });
}

function editNotification(context, bucket, model, index) {
  const current = index === undefined ? undefined : model.configurations[index];
  context.showModal(current ? `Edit event notification ${current.id}` : "Create event notification", notificationForm(current), current ? "Save changes" : "Create event notification", async data => {
    const updated = notificationFromForm(data);
    if (model.configurations.some((configuration, candidate) => candidate !== index && configuration.id === updated.id)) throw new Error(`Configuration ID ${updated.id} already exists`);
    const configurations = [...model.configurations];
    if (index === undefined) configurations.push(updated);
    else configurations[index] = updated;
    await saveS3NotificationConfiguration(bucket, { configurations, eventBridge: model.eventBridge });
    context.toast(current ? `Event notification ${updated.id} updated` : `Event notification ${updated.id} created`);
  }, true);
}

function notificationInventory(model) {
  if (!model.configurations.length) return emptyState("◇", "No event notifications", "Create a Lambda or SQS notification for one or more S3 event types.");
  return `<table class="s3-notification-table"><thead><tr><th>Configuration</th><th>Destination</th><th>Events</th><th>Prefix</th><th>Suffix</th><th>Actions</th></tr></thead><tbody>${model.configurations.map((configuration, index) => `<tr><td><strong>${escapeHtml(configuration.id)}</strong></td><td><span class="status-badge">${configuration.type === "queue" ? "SQS" : "Lambda"}</span><span class="mono s3-notification-arn">${escapeHtml(configuration.arn)}</span></td><td><ul class="s3-notification-event-list">${configuration.events.map(event => `<li class="mono">${escapeHtml(event)}</li>`).join("")}</ul></td><td class="mono">${escapeHtml(configuration.prefix || "–")}</td><td class="mono">${escapeHtml(configuration.suffix || "–")}</td><td><div class="actions"><button class="button" data-edit-s3-notification="${index}" aria-label="Edit ${escapeHtml(configuration.id)}">Edit</button><button class="button danger" data-delete-s3-notification="${index}" aria-label="Delete ${escapeHtml(configuration.id)}">Delete</button></div></td></tr>`).join("")}</tbody></table>`;
}

function bindNotificationActions(context, bucket, model) {
  document.querySelectorAll("[data-create-s3-notification]").forEach(button => button.addEventListener("click", () => editNotification(context, bucket, model)));
  document.querySelectorAll("[data-edit-s3-notification]").forEach(button => button.addEventListener("click", () => editNotification(context, bucket, model, Number(button.dataset.editS3Notification))));
  document.querySelectorAll("[data-delete-s3-notification]").forEach(button => button.addEventListener("click", () => {
    const index = Number(button.dataset.deleteS3Notification);
    const configuration = model.configurations[index];
    context.confirmDeletion(configuration.id, `Delete event notification ${configuration.id}? Every other notification and the Amazon EventBridge setting will be preserved.`, async () => {
      await saveS3NotificationConfiguration(bucket, { configurations: model.configurations.filter((_, candidate) => candidate !== index), eventBridge: model.eventBridge });
      context.toast(`Event notification ${configuration.id} deleted`);
    });
  }));
  document.querySelector("[data-edit-s3-eventbridge]")?.addEventListener("click", () => context.showModal("Edit Amazon EventBridge", `<p>Amazon S3 publishes all supported events from this bucket to the default event bus. Configure filtering in EventBridge rules; this bucket-wide setting has no prefix or suffix filters.</p><label class="setting-option"><input type="checkbox" name="eventBridge" ${model.eventBridge ? "checked" : ""}><span><strong>Publish events to Amazon EventBridge</strong><small>Preserves every direct Lambda and SQS notification when saved.</small></span></label><p><a href="#/eventbridge/event-buses/default/rules">View rules on the default event bus</a></p>`, "Save changes", async data => {
    const enabled = data.get("eventBridge") === "on";
    await saveS3NotificationConfiguration(bucket, { configurations: model.configurations, eventBridge: enabled });
    context.toast(`Amazon EventBridge publishing ${enabled ? "enabled" : "disabled"}`);
  }));
}

async function propertiesPage(context, bucket) {
  const [locationResult, versionResult, website, environment, bucketSummary] = await Promise.all([s3Request(`${objectPath(bucket)}?location`), s3Request(`${objectPath(bucket)}?versioning`), getWebsite(bucket), rest("/_stacksim/api/summary"), listBuckets().then(values => values.find(value => value.name === bucket))]); const region = first(locationResult.xml, "LocationConstraint") || "us-east-1"; const status = first(versionResult.xml, "Status") || "Not enabled"; const endpoint = websiteEndpoint(bucket, environment.endpoint); context.setChrome("s3", ["S3", "General purpose buckets", bucket]); context.main.innerHTML = `<div class="page-width">${pageHeader(bucket, `Bucket properties in ${escapeHtml(region)}`, `<button class="button danger" data-delete-bucket>Delete bucket</button>`)}${bucketTabs(bucket, "properties")}<section class="card"><div class="card-header"><h2>Bucket Versioning</h2><span class="status">${escapeHtml(status)}</span></div><div class="card-body"><p>Preserve every object version and use delete markers for recoverable deletion.</p><div class="actions"><button class="button primary" data-versioning="Enabled">Enable</button><button class="button" data-versioning="Suspended">Suspend</button></div></div></section><section class="card"><div class="card-header"><h2>Default encryption</h2></div><div class="card-body"><p><strong>Server-side encryption with S3 managed keys (SSE-S3)</strong></p><p class="muted">Object payloads are encrypted in the private local blob store.</p></div></section><section class="card s3-static-website-hosting"><div class="card-header"><h2>Static website hosting</h2><button class="button" data-edit-website>Edit</button></div><div class="card-body"><dl class="key-value"><dt>Static website hosting</dt><dd><span class="status ${website ? "" : "inactive"}">${website ? "Enabled" : "Disabled"}</span></dd>${website ? `<dt>Hosting type</dt><dd>Bucket hosting</dd><dt>Bucket website endpoint</dt><dd><a class="mono s3-website-endpoint" href="${escapeHtml(endpoint)}" target="_blank" rel="noopener noreferrer">${escapeHtml(endpoint)}</a></dd><dt>Index document</dt><dd class="mono">${escapeHtml(website.indexDocument)}</dd><dt>Error document</dt><dd class="mono">${escapeHtml(website.errorDocument || "–")}</dd>` : `<dt>Website endpoint</dt><dd class="muted">Enable static website hosting to create a bucket website endpoint.</dd>`}</dl></div></section></div>`; document.querySelectorAll("[data-versioning]").forEach(button => button.addEventListener("click", async () => { const body = `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${button.dataset.versioning}</Status></VersioningConfiguration>`; await s3Request(`${objectPath(bucket)}?versioning`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast(`Versioning ${button.dataset.versioning.toLowerCase()}`); await context.route(); })); document.querySelector("[data-delete-bucket]")?.addEventListener("click", () => deleteBucketAction(context, bucket)); document.querySelector("[data-edit-website]")?.addEventListener("click", () => editWebsite(context, bucket, website));
  const [encryptionResult, notificationResult] = await Promise.all([
    s3Request(`${objectPath(bucket)}?encryption`),
    s3Request(`${objectPath(bucket)}?notification`),
  ]);
  const algorithm = first(encryptionResult.xml, "SSEAlgorithm") || "AES256";
  const lockEnabled = Boolean(bucketSummary?.objectLockEnabled);
  const notifications = parseS3NotificationConfiguration(notificationResult.xml);
  const tags = (bucketSummary?.tags ?? []).map(([key, value]) => `${key}=${value}`);
  context.main.querySelector(".page-width")?.insertAdjacentHTML("beforeend", `<section class="card s3-governance"><div class="card-header"><h2>Data governance</h2><div class="actions"><button class="button" data-edit-s3-encryption>Edit encryption</button><button class="button" data-edit-s3-lock>${lockEnabled ? "Edit Object Lock" : "Configure Object Lock"}</button><button class="button" data-edit-s3-tags>Edit tags</button></div></div><div class="card-body"><dl class="key-value"><dt>Default encryption</dt><dd>${escapeHtml(algorithm)}</dd><dt>Object Lock</dt><dd><span class="status ${lockEnabled ? "" : "inactive"}">${lockEnabled ? "Enabled" : "Disabled"}</span></dd><dt>Bucket tags</dt><dd>${tags.length ? tags.map(escapeHtml).join("<br>") : "–"}</dd></dl><p class="muted">KMS settings are dependency descriptors; object data remains protected by the authenticated local blob tier.</p></div></section><section class="card s3-event-notifications"><div class="card-header"><div><h2>Event notifications <span class="muted">(${notifications.configurations.length})</span></h2><p class="muted small">Direct Lambda and SQS destinations</p></div><button class="button primary" data-create-s3-notification>Create event notification</button></div><div class="table-wrap">${notificationInventory(notifications)}</div><div class="card-body s3-notification-guidance"><p class="muted">Delivery is durable and at least once. Destination failures never roll back object mutations. Saving validates the complete configuration and sends the S3 test event to each destination. Destination policies must allow <span class="mono">s3.amazonaws.com</span> for this bucket.</p><div class="actions"><a href="#/lambda/functions">View Lambda functions</a><a href="#/sqs/queues">View SQS queues</a><a href="#/s3/buckets/${encodeURIComponent(bucket)}/metrics">View delivery health</a></div></div></section><section class="card s3-eventbridge-notifications"><div class="card-header"><h2>Amazon EventBridge</h2><button class="button" data-edit-s3-eventbridge>Edit</button></div><div class="card-body"><dl class="key-value"><dt>Publishing</dt><dd><span class="status ${notifications.eventBridge ? "" : "inactive"}">${notifications.eventBridge ? "Enabled" : "Disabled"}</span></dd><dt>Event selection</dt><dd>All supported S3 events</dd><dt>Filtering</dt><dd>EventBridge rules on the default event bus</dd></dl><p class="muted">This is one bucket-wide opt-in. Prefix and suffix filters apply only to direct notification configurations.</p><a href="#/eventbridge/event-buses/default/rules">View rules on the default event bus</a></div></section>`);
  document.querySelector("[data-edit-s3-encryption]")?.addEventListener("click", () => context.showModal("Default encryption", `<div class="field"><label>Algorithm</label><select name="algorithm"><option value="AES256">SSE-S3</option><option value="aws:kms">SSE-KMS descriptor</option><option value="aws:kms:dsse">DSSE-KMS descriptor</option></select></div><div class="field"><label>KMS key ID or alias</label><input name="key" placeholder="alias/example"></div><label class="setting-option"><input type="checkbox" name="bucketKey"><span>Enable S3 Bucket Key</span></label><div class="alert info">KMS object writes remain explicitly blocked until the KMS dependency exists.</div>`, "Save", async data => { const selected = String(data.get("algorithm")); const key = String(data.get("key") || ""); const body = `<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${xmlEscape(selected)}</SSEAlgorithm>${key ? `<KMSMasterKeyID>${xmlEscape(key)}</KMSMasterKeyID>` : ""}</ApplyServerSideEncryptionByDefault><BucketKeyEnabled>${data.get("bucketKey") === "on"}</BucketKeyEnabled></Rule></ServerSideEncryptionConfiguration>`; await s3Request(`${objectPath(bucket)}?encryption`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Default encryption updated"); }));
  document.querySelector("[data-edit-s3-lock]")?.addEventListener("click", () => context.showModal("Object Lock", `<div class="alert warning"><strong>Object Lock cannot be disabled after it is enabled.</strong><br>Versioning must be enabled.</div><div class="field"><label>Default mode</label><select name="mode"><option value="">No default retention</option><option>GOVERNANCE</option><option>COMPLIANCE</option></select></div><div class="field"><label>Days</label><input name="days" type="number" min="1"></div>`, lockEnabled ? "Save" : "Enable", async data => { const mode = String(data.get("mode") || ""); const days = String(data.get("days") || ""); const body = `<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled>${mode ? `<Rule><DefaultRetention><Mode>${mode}</Mode><Days>${xmlEscape(days)}</Days></DefaultRetention></Rule>` : ""}</ObjectLockConfiguration>`; await s3Request(`${objectPath(bucket)}?object-lock`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Object Lock updated"); }, false, { danger: !lockEnabled }));
  document.querySelector("[data-edit-s3-tags]")?.addEventListener("click", () => context.showModal("Bucket tags", `<div class="field"><label>One key=value per line</label><textarea name="tags" rows="8">${escapeHtml(tags.join("\n"))}</textarea></div>`, "Save", async data => { const rows = String(data.get("tags") || "").split(/\r?\n/).filter(Boolean).map(line => { const split = line.indexOf("="); if (split < 1) throw new Error(`Invalid tag: ${line}`); return [line.slice(0, split), line.slice(split + 1)]; }); const body = `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${rows.map(([key, value]) => `<Tag><Key>${xmlEscape(key)}</Key><Value>${xmlEscape(value)}</Value></Tag>`).join("")}</TagSet></Tagging>`; await s3Request(`${objectPath(bucket)}?tagging`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Bucket tags updated"); }));
  bindNotificationActions(context, bucket, notifications);
}

async function versionsPage(context, bucket) {
  const output = await s3Request(`${objectPath(bucket)}?versions`); const root = output.xml.documentElement; const rows = [...root.children].filter(node => ["Version", "DeleteMarker"].includes(node.localName)).map(node => ({ marker: node.localName === "DeleteMarker", key: first(node, "Key"), versionId: first(node, "VersionId"), latest: first(node, "IsLatest") === "true", modified: first(node, "LastModified"), size: first(node, "Size") })); context.setChrome("s3", ["S3", "General purpose buckets", bucket, "Versions"]); context.main.innerHTML = `<div class="page-width">${pageHeader("Object versions", `Version history and delete markers for ${escapeHtml(bucket)}.`, `<a class="button" href="#/s3/buckets/${encodeURIComponent(bucket)}/objects">Hide versions</a>`)}${bucketTabs(bucket, "objects")}<section class="card"><div class="table-wrap">${rows.length ? `<table><thead><tr><th>Key</th><th>Version ID</th><th>Type</th><th>Latest</th><th>Modified</th><th>Size</th><th>Actions</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.key)}</td><td class="mono">${escapeHtml(row.versionId)}</td><td>${row.marker ? "Delete marker" : "Version"}</td><td>${row.latest ? "Yes" : "No"}</td><td>${escapeHtml(new Date(row.modified).toLocaleString())}</td><td>${row.marker ? "–" : humanBytes(row.size)}</td><td><button class="button link" data-version-delete="${escapeHtml(row.versionId)}" data-key="${escapeHtml(row.key)}">Delete permanently</button>${row.marker ? "" : `<button class="button link" data-version-download="${escapeHtml(row.versionId)}" data-key="${escapeHtml(row.key)}">Download</button><button class="button link" data-version-restore="${escapeHtml(row.versionId)}" data-key="${escapeHtml(row.key)}">Restore</button>`}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No versions", "Upload an object after enabling versioning.")}</div></section></div>`;
  document.querySelectorAll("[data-version-delete]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.versionDelete, `Permanently delete version ${button.dataset.versionDelete}?`, async () => { await s3Request(`${objectPath(bucket, button.dataset.key)}?versionId=${encodeURIComponent(button.dataset.versionDelete)}`, { method: "DELETE" }); context.toast("Version permanently deleted"); await context.route(); })));
  document.querySelectorAll("[data-version-download]").forEach(button => button.addEventListener("click", async () => { const result = await s3Request(`${objectPath(bucket, button.dataset.key)}?versionId=${encodeURIComponent(button.dataset.versionDownload)}`); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([result.body])); link.download = button.dataset.key.split("/").at(-1); link.click(); }));
  document.querySelectorAll("[data-version-restore]").forEach(button => button.addEventListener("click", () => context.showModal("Restore object version", `<div class="field"><label>Source version</label><input value="${escapeHtml(button.dataset.versionRestore)}" disabled></div><div class="field"><label>Destination key</label><input name="key" required value="${escapeHtml(button.dataset.key)}"></div><p class="hint">Restore creates a new current version by copying this historical version.</p>`, "Restore", async data => { const destination = String(data.get("key")); await s3Request(objectPath(bucket, destination), { method: "PUT", headers: { "x-amz-copy-source": copySource(bucket, button.dataset.key, button.dataset.versionRestore), "x-amz-metadata-directive": "COPY" } }); context.toast("Version restored as the current object"); })));
}

async function managementPage(context, bucket) {
  const output = await s3Request(`${objectPath(bucket)}?uploads`); const pending = [...output.xml.getElementsByTagName("Upload")].map(node => ({ key: first(node, "Key"), uploadId: first(node, "UploadId"), initiated: first(node, "Initiated") })); const uploads = await Promise.all(pending.map(async upload => { const listed = await s3Request(`${objectPath(bucket, upload.key)}?uploadId=${encodeURIComponent(upload.uploadId)}`); const parts = [...listed.xml.getElementsByTagName("Part")]; return { ...upload, parts: parts.length, bytes: parts.reduce((sum, part) => sum + Number(first(part, "Size")), 0) }; })); context.setChrome("s3", ["S3", "General purpose buckets", bucket]); context.main.innerHTML = `<div class="page-width">${pageHeader(bucket, "Storage management and incomplete upload state.")}${bucketTabs(bucket, "management")}<section class="card"><div class="card-header"><h2>Incomplete multipart uploads <span class="muted">(${uploads.length})</span></h2></div><div class="table-wrap">${uploads.length ? `<table><thead><tr><th>Key</th><th>Upload ID</th><th>Age</th><th>Parts</th><th>Uploaded</th><th>Action</th></tr></thead><tbody>${uploads.map(upload => `<tr><td>${escapeHtml(upload.key)}</td><td class="mono">${escapeHtml(upload.uploadId)}</td><td>${humanAge(upload.initiated)}</td><td>${upload.parts}</td><td>${humanBytes(upload.bytes)}</td><td><button class="button link" data-abort-upload="${escapeHtml(upload.uploadId)}" data-key="${escapeHtml(upload.key)}">Abort</button></td></tr>`).join("")}</tbody></table>` : emptyState("✓", "No incomplete uploads", "Multipart uploads will appear here until completed or aborted.")}</div></section></div>`; document.querySelectorAll("[data-abort-upload]").forEach(button => button.addEventListener("click", async () => { await s3Request(`${objectPath(bucket, button.dataset.key)}?uploadId=${encodeURIComponent(button.dataset.abortUpload)}`, { method: "DELETE" }); context.toast("Multipart upload aborted"); await context.route(); }));
}

async function lifecycleManagement(context, bucket) {
  const summary = (await listBuckets()).find(value => value.name === bucket);
  const lifecycle = summary?.lifecycleConfigured ? await s3Request(`${objectPath(bucket)}?lifecycle`) : undefined;
  const rules = lifecycle ? [...lifecycle.xml.getElementsByTagName("Rule")] : [];
  context.main.querySelector(".page-width")?.insertAdjacentHTML("afterbegin", `<section class="card s3-lifecycle-rules"><div class="card-header"><h2>Lifecycle rules <span class="muted">(${rules.length})</span></h2><div class="actions">${lifecycle ? '<button class="button danger" data-delete-lifecycle>Delete all</button>' : ""}<button class="button" data-edit-lifecycle>${lifecycle ? "Edit XML" : "Create rule"}</button></div></div><div class="card-body">${rules.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Prefix</th><th>Actions</th></tr></thead><tbody>${rules.map(rule => `<tr><td>${escapeHtml(first(rule, "ID") || "–")}</td><td>${escapeHtml(first(rule, "Status"))}</td><td class="mono">${escapeHtml(first(rule, "Prefix") || "(all objects)")}</td><td>${[...rule.children].filter(node => ["Expiration", "Transition", "NoncurrentVersionExpiration", "NoncurrentVersionTransition", "AbortIncompleteMultipartUpload"].includes(node.localName)).map(node => escapeHtml(node.localName)).join(", ")}</td></tr>`).join("")}</tbody></table></div>` : "<p class=\"muted\">No lifecycle rules. Rules can expire versions, transition storage classes, clean delete markers, and abort incomplete multipart uploads.</p>"}<div class="alert info"><strong>Local storage model</strong><br>Storage-class metadata and archive access restrictions are real. Physical blobs stay in the local encrypted tier; no billing savings or external archive infrastructure are claimed.</div></div></section>`);
  document.querySelector("[data-edit-lifecycle]")?.addEventListener("click", () => context.showModal("Lifecycle configuration", `<div class="field"><label>Lifecycle XML</label><textarea name="xml" rows="18">${escapeHtml(lifecycle?.text || `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n  <Rule><ID>archive</ID><Filter><Prefix>archive/</Prefix></Filter><Status>Enabled</Status><Transition><Days>30</Days><StorageClass>GLACIER</StorageClass></Transition></Rule>\n</LifecycleConfiguration>`)}</textarea></div><p class="hint">Supports prefix/tag/size/AND filters, current/noncurrent transitions and expiration, NewerNoncurrentVersions, expired delete markers, and incomplete multipart abort. Day-0 transitions into STANDARD_IA and ONEZONE_IA are allowed; chained transitions must still respect each class minimum storage duration. Local transitions update metadata only and do not charge early-deletion fees.</p>`, "Save rules", async data => { await s3Request(`${objectPath(bucket)}?lifecycle`, { method: "PUT", headers: { "content-type": "application/xml" }, body: String(data.get("xml")) }); context.toast("Lifecycle rules saved"); }));
  document.querySelector("[data-delete-lifecycle]")?.addEventListener("click", () => context.confirmDeletion(bucket, `Delete every lifecycle rule from ${bucket}?`, async () => { await s3Request(`${objectPath(bucket)}?lifecycle`, { method: "DELETE" }); context.toast("Lifecycle rules deleted"); }));
}

async function metricsPage(context, bucket) {
  const output = await s3Request(`${objectPath(bucket)}?notification-diagnostics`);
  const pending = Number(first(output.xml, "Pending") || 0);
  const age = Number(first(output.xml, "OldestPendingAgeMilliseconds") || 0);
  const deliveries = [...output.xml.getElementsByTagName("Delivery")].map(node => ({ time: first(node, "Time"), destination: first(node, "Destination"), event: first(node, "EventName"), status: first(node, "Status"), attempts: first(node, "Attempts"), error: first(node, "Error") }));
  context.setChrome("s3", ["S3", "General purpose buckets", bucket]);
  context.main.innerHTML = `<div class="page-width">${pageHeader(bucket, "Request telemetry and notification delivery health.")}${bucketTabs(bucket, "metrics")}<div class="dashboard-grid"><section class="card"><div class="card-header"><h2>Pending notifications</h2></div><div class="card-body"><div class="metric">${pending}</div><p class="muted">Oldest age ${Math.round(age / 1000)} seconds</p></div></section><section class="card"><div class="card-header"><h2>CloudWatch metrics</h2></div><div class="card-body"><p>S3 request count, bytes, errors, latency, and notification success/failure use BucketName and FilterId dimensions.</p><a href="#/cloudwatch/metrics">Open CloudWatch metrics</a></div></section></div><section class="card"><div class="card-header"><h2>Recent delivery diagnostics</h2><span class="muted">Payloads are never shown</span></div><div class="table-wrap">${deliveries.length ? `<table><thead><tr><th>Time</th><th>Status</th><th>Event</th><th>Destination</th><th>Attempts</th><th>Error</th></tr></thead><tbody>${deliveries.map(item => `<tr><td>${escapeHtml(new Date(item.time).toLocaleString())}</td><td><span class="status ${item.status === "SUCCESS" ? "" : "warning"}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.event)}</td><td class="mono">${escapeHtml(item.destination)}</td><td>${escapeHtml(item.attempts)}</td><td>${escapeHtml(item.error || "–")}</td></tr>`).join("")}</tbody></table>` : emptyState("✓", "No delivery attempts", "Notification delivery outcomes appear here after events are published.")}</div></section></div>`;
}

async function optionalBucketConfiguration(bucket, query, absentCodes = []) {
  try { return await s3Request(`${objectPath(bucket)}?${query}`); }
  catch (error) { if (absentCodes.includes(error?.code)) return undefined; throw error; }
}

const xmlBool = (xml, name) => first(xml, name) === "true";

async function permissionsPage(context, bucket) {
  const accountId = session.summary?.accountId ?? "000000000000";
  const [blockResult, accountBlockResult, policyResult, policyStatusResult, ownershipResult, aclResult, payerResult, abacResult] = await Promise.all([
    optionalBucketConfiguration(bucket, "publicAccessBlock", ["NoSuchPublicAccessBlockConfiguration"]),
    s3Request("/v20180820/configuration/publicAccessBlock", { headers: { "x-amz-account-id": accountId } }).catch(error => error?.code === "NoSuchPublicAccessBlockConfiguration" ? undefined : Promise.reject(error)),
    optionalBucketConfiguration(bucket, "policy", ["NoSuchBucketPolicy"]),
    optionalBucketConfiguration(bucket, "policyStatus"),
    optionalBucketConfiguration(bucket, "ownershipControls", ["OwnershipControlsNotFoundError"]),
    optionalBucketConfiguration(bucket, "acl"),
    optionalBucketConfiguration(bucket, "requestPayment"),
    optionalBucketConfiguration(bucket, "abac"),
  ]);
  const block = Object.fromEntries(["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].map(name => [name, xmlBool(blockResult?.xml, name)]));
  const accountBlock = Object.fromEntries(Object.keys(block).map(name => [name, xmlBool(accountBlockResult?.xml, name)]));
  const effectiveBlock = Object.fromEntries(Object.keys(block).map(name => [name, block[name] || accountBlock[name]]));
  const policy = policyResult?.text ? JSON.stringify(JSON.parse(policyResult.text), null, 2) : "";
  const isPublic = xmlBool(policyStatusResult?.xml, "IsPublic");
  const ownership = first(ownershipResult?.xml, "ObjectOwnership") || "ObjectWriter (controls deleted)";
  const payer = first(payerResult?.xml, "Payer") || "BucketOwner";
  const abac = first(abacResult?.xml, "Status") || "Disabled";
  const grants = [...(aclResult?.xml?.getElementsByTagName("Grant") ?? [])].map(node => ({ permission: first(node, "Permission"), grantee: first(node, "ID") || first(node, "URI") }));
  const effectivePublicBlock = Object.values(effectiveBlock).every(Boolean);
  const aclPublic = ownership !== "BucketOwnerEnforced" && grants.some(grant => /\/(?:AllUsers|AuthenticatedUsers)$/.test(grant.grantee));
  const findings = [
    ...(isPublic ? ["The bucket policy is classified as public."] : []),
    ...(aclPublic ? ["An enabled bucket ACL grants a public or authenticated-users group."] : []),
    ...(payer === "Requester" ? ["Requester Pays requires the requester acknowledgement header for delegated data access."] : []),
    ...(!isPublic && !aclPublic ? ["No public bucket-policy or enabled public ACL finding was detected."] : []),
  ];
  context.setChrome("s3", ["S3", "General purpose buckets", bucket]);
  context.main.innerHTML = `<div class="page-width">${pageHeader(bucket, "Bucket permissions and effective access controls.")}${bucketTabs(bucket, "permissions")}
    <section class="card"><div class="card-header"><h2>Block public access (bucket settings)</h2><button class="button" data-edit-public-block>Edit</button></div><div class="card-body"><div class="alert ${effectivePublicBlock ? "info" : "warning"}"><strong>${effectivePublicBlock ? "All effective protections are enabled" : "Some effective protections are disabled"}</strong><br>Bucket and account settings are combined using the most restrictive value.</div><div class="table-wrap"><table><thead><tr><th>Setting</th><th>Bucket</th><th>Account</th><th>Effective</th><th>Effective source</th></tr></thead><tbody>${Object.keys(block).map(name => `<tr><td>${escapeHtml(name)}</td><td>${block[name] ? "On" : "Off"}</td><td>${accountBlock[name] ? "On" : "Off"}</td><td><strong>${effectiveBlock[name] ? "On" : "Off"}</strong></td><td>${block[name] && accountBlock[name] ? "Bucket and account" : block[name] ? "Bucket" : accountBlock[name] ? "Account" : "Neither"}</td></tr>`).join("")}</tbody></table></div></div></section>
    <section class="card"><div class="card-header"><h2>Bucket policy</h2><div class="actions"><span class="status ${isPublic ? "warning" : ""}">${isPublic ? "Public" : policy ? "Not public" : "No policy"}</span>${policy ? '<button class="button danger" data-delete-policy>Delete</button>' : ""}<button class="button" data-edit-policy>Edit</button></div></div><div class="card-body">${policy ? `<pre class="code-box">${escapeHtml(policy)}</pre>` : `<p class="muted">No bucket policy is configured.</p>`}</div></section>
    <section class="card"><div class="card-header"><h2>Access findings</h2><span class="status ${isPublic || aclPublic ? "warning" : ""}">${isPublic || aclPublic ? "Review" : "No public finding"}</span></div><div class="card-body"><ul>${findings.map(finding => `<li>${escapeHtml(finding)}</li>`).join("")}</ul><div class="alert info"><strong>Effective access explanation</strong><br>Identity policies, this bucket policy, enabled ACLs, session policy, permissions boundary, and explicit denies are evaluated together. Block Public Access may reject or suppress otherwise-public grants. These are simulator findings, not IAM Access Analyzer results.</div></div></section>
    <section class="card"><div class="card-header"><h2>Object Ownership</h2><button class="button" data-edit-ownership>Edit</button></div><div class="card-body"><p><strong>${escapeHtml(ownership)}</strong></p><p class="muted">${ownership === "BucketOwnerEnforced" ? "ACLs are disabled and the bucket owner owns every new object." : "ACL grants participate in authorization and object ownership follows the selected mode."}</p></div></section>
    <section class="card"><div class="card-header"><h2>Access control list (ACL)</h2>${ownership === "BucketOwnerEnforced" ? '<span class="status inactive">Disabled</span>' : '<button class="button" data-edit-acl>Edit</button>'}</div><div class="card-body"><div class="table-wrap"><table><thead><tr><th>Grantee</th><th>Permission</th></tr></thead><tbody>${grants.map(grant => `<tr><td class="mono">${escapeHtml(grant.grantee)}</td><td>${escapeHtml(grant.permission)}</td></tr>`).join("")}</tbody></table></div></div></section>
    <section class="card"><div class="card-header"><h2>Requester Pays</h2><button class="button" data-edit-requester-pays>Edit</button></div><div class="card-body"><p><strong>${escapeHtml(payer)}</strong></p><p class="muted">Requester mode enforces the request-payer header and authorization context locally; no billing is simulated.</p></div></section>
    <section class="card"><div class="card-header"><h2>Attribute-based access control (ABAC)</h2><button class="button" data-edit-abac>Edit</button></div><div class="card-body"><p><strong>${escapeHtml(abac)}</strong></p><p class="muted">When enabled, bucket tags are exposed to IAM conditions as resource tags.</p></div></section>
  </div>`;
  document.querySelector("[data-edit-public-block]")?.addEventListener("click", () => context.showModal("Edit Block Public Access", `<div class="alert warning"><strong>Public access can expose object data.</strong><br>Account settings may still keep a disabled bucket setting effectively enabled.</div>${Object.entries(block).map(([name, enabled]) => `<label class="setting-option"><input type="checkbox" name="${name}" ${enabled ? "checked" : ""}><span><strong>${escapeHtml(name)}</strong></span></label>`).join("")}<label class="setting-option"><input type="checkbox" name="ack" required><span>I acknowledge that disabling protections can make data public.</span></label><div class="field"><label>Type the bucket name to confirm</label><input name="confirm" required></div>`, "Save changes", async data => {
    if (data.get("confirm") !== bucket) throw new Error("Bucket name confirmation did not match");
    const body = `<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${Object.keys(block).map(name => `<${name}>${data.get(name) === "on"}</${name}>`).join("")}</PublicAccessBlockConfiguration>`;
    await s3Request(`${objectPath(bucket)}?publicAccessBlock`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Block Public Access updated");
  }));
  document.querySelector("[data-edit-policy]")?.addEventListener("click", () => context.showModal("Edit bucket policy", `<div class="field"><label>Policy JSON</label><textarea name="policy" rows="16" required>${escapeHtml(policy || JSON.stringify({ Version: "2012-10-17", Statement: [] }, null, 2))}</textarea></div><label class="setting-option"><input type="checkbox" name="ack" required><span>I acknowledge that this policy can grant public or cross-account access.</span></label><div class="field"><label>Type the bucket name to confirm</label><input name="confirm" required></div>`, "Save policy", async data => {
    if (data.get("confirm") !== bucket) throw new Error("Bucket name confirmation did not match");
    const parsed = JSON.parse(String(data.get("policy"))); await s3Request(`${objectPath(bucket)}?policy`, { method: "PUT", headers: { "content-type": "application/json", "x-amz-confirm-remove-self-bucket-access": "true" }, body: JSON.stringify(parsed) }); context.toast("Bucket policy saved");
  }));
  document.querySelector("[data-delete-policy]")?.addEventListener("click", () => context.confirmDeletion(bucket, `Delete the bucket policy from ${bucket}?`, async () => {
    await s3Request(`${objectPath(bucket)}?policy`, { method: "DELETE" }); context.toast("Bucket policy deleted");
  }));
  document.querySelector("[data-edit-ownership]")?.addEventListener("click", () => context.showModal("Edit Object Ownership", `<div class="field"><label>Object Ownership</label><select name="ownership"><option ${ownership === "BucketOwnerEnforced" ? "selected" : ""}>BucketOwnerEnforced</option><option ${ownership === "BucketOwnerPreferred" ? "selected" : ""}>BucketOwnerPreferred</option><option ${ownership.startsWith("ObjectWriter") ? "selected" : ""}>ObjectWriter</option></select></div><div class="alert info">BucketOwnerEnforced disables ACLs. Enabling it requires an owner-only bucket ACL.</div>`, "Save changes", async data => {
    const body = `<OwnershipControls xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ObjectOwnership>${xmlEscape(data.get("ownership"))}</ObjectOwnership></Rule></OwnershipControls>`; await s3Request(`${objectPath(bucket)}?ownershipControls`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Object Ownership updated");
  }));
  document.querySelector("[data-edit-acl]")?.addEventListener("click", () => context.showModal("Edit bucket ACL", `<div class="field"><label>Canned ACL</label><select name="acl"><option value="private">Private</option><option value="public-read">Public read</option><option value="public-read-write">Public read/write</option><option value="authenticated-read">Authenticated users read</option><option value="log-delivery-write">Log delivery write</option></select></div><label class="setting-option"><input type="checkbox" name="ack" required><span>I acknowledge that a public ACL can expose data.</span></label><div class="field"><label>Type the bucket name to confirm public-capable changes</label><input name="confirm" required></div>`, "Save ACL", async data => {
    if (data.get("confirm") !== bucket) throw new Error("Bucket name confirmation did not match");
    await s3Request(`${objectPath(bucket)}?acl`, { method: "PUT", headers: { "x-amz-acl": String(data.get("acl")) } }); context.toast("Bucket ACL updated");
  }));
  document.querySelector("[data-edit-requester-pays]")?.addEventListener("click", () => context.showModal("Edit Requester Pays", `<div class="field"><label>Payer</label><select name="payer"><option ${payer === "BucketOwner" ? "selected" : ""}>BucketOwner</option><option ${payer === "Requester" ? "selected" : ""}>Requester</option></select></div>`, "Save changes", async data => {
    const body = `<RequestPaymentConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Payer>${xmlEscape(data.get("payer"))}</Payer></RequestPaymentConfiguration>`; await s3Request(`${objectPath(bucket)}?requestPayment`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Requester Pays updated");
  }));
  document.querySelector("[data-edit-abac]")?.addEventListener("click", () => context.showModal("Edit bucket ABAC", `<div class="field"><label>Status</label><select name="status"><option ${abac === "Disabled" ? "selected" : ""}>Disabled</option><option ${abac === "Enabled" ? "selected" : ""}>Enabled</option></select></div>`, "Save changes", async data => {
    const body = `<AbacStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${xmlEscape(data.get("status"))}</Status></AbacStatus>`; await s3Request(`${objectPath(bucket)}?abac`, { method: "PUT", headers: { "content-type": "application/xml" }, body }); context.toast("Bucket ABAC updated");
  }));
}

async function placeholderTab(context, bucket, active) {
  context.setChrome("s3", ["S3", "General purpose buckets", bucket]); const content = active === "permissions" ? "Bucket policies, Object Ownership, ACLs, and Block Public Access are not currently available." : "S3 request and storage metrics are not currently available."; context.main.innerHTML = `<div class="page-width">${pageHeader(bucket, `Bucket ${escapeHtml(active)}.`)}${bucketTabs(bucket, active)}<section class="card">${emptyState("◇", `${active[0].toUpperCase() + active.slice(1)} are not configured`, content)}</section></div>`;
}

function deleteBucketAction(context, bucket) {
  if (!bucket) return;
  context.showModal("Delete bucket", `<div class="alert warning"><strong>Deleting a bucket is permanent.</strong><br>The bucket must be empty, including all object versions, delete markers, and incomplete multipart uploads. After deletion, the bucket name might become available for reuse.</div><p>Bucket: <strong>${escapeHtml(bucket)}</strong></p><div class="field"><label>To confirm deletion, enter <strong>${escapeHtml(bucket)}</strong></label><input name="confirmation" required autocomplete="off"></div>`, "Delete bucket", async data => {
    if (data.get("confirmation") !== bucket) throw new Error(`Enter ${bucket} to confirm`);
    try {
      await s3Request(objectPath(bucket), { method: "DELETE" });
    } catch (error) {
      if (error?.code === "BucketNotEmpty") throw new Error("This bucket is not empty. It may contain hidden object versions, delete markers, or incomplete multipart uploads. Return to the bucket list and choose Empty first.");
      throw error;
    }
    context.toast("Bucket deleted"); location.hash = "#/s3/buckets";
  }, false, { danger: true });
}

export async function routeS3(parts, context) {
  const withPanelHelp = async render => {
    const result = await render();
    decorateS3PanelHelp(context.main);
    return result;
  };
  if (parts.length === 1) return withPanelHelp(() => overview(context));
  if (parts[1] === "buckets" && parts.length === 2) return withPanelHelp(() => bucketsPage(context));
  if (parts[1] !== "buckets" || !parts[2]) return context.notFound(parts);
  const bucket = parts[2];
  const tab = parts[3] ?? "objects";
  if (tab === "object" && parts[4]) {
    const key = parts[4];
    const objectTab = parts[5] ?? "properties";
    const versionId = parts[6];
    if (objectTab === "properties") return withPanelHelp(() => objectPropertiesPage(context, bucket, key, versionId));
    if (objectTab === "permissions") return withPanelHelp(() => objectPermissionsPage(context, bucket, key, versionId));
    if (objectTab === "versions") return withPanelHelp(() => objectVersionsPage(context, bucket, key, versionId));
    return context.notFound(parts);
  }
  if (tab === "objects") return withPanelHelp(() => objectsPage(context, bucket, parts[4] ?? ""));
  if (tab === "versions") return withPanelHelp(() => versionsPage(context, bucket));
  if (tab === "properties") return withPanelHelp(() => propertiesPage(context, bucket));
  if (tab === "permissions") return withPanelHelp(() => permissionsPage(context, bucket));
  if (tab === "management") return withPanelHelp(async () => { await managementPage(context, bucket); return lifecycleManagement(context, bucket); });
  if (tab === "metrics") return withPanelHelp(() => metricsPage(context, bucket));
  if (tab === "delete") return deleteBucketAction(context, bucket);
  return context.notFound(parts);
}
