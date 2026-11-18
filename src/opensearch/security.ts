import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { compileQuery, fail, keys, record, wildcard, type Candidate, type Json } from "./query.js";
import { defaultAudit, patchAudit, validateAudit } from "./audit.js";

export interface PasswordVerifier { salt: string; hash: string }
export interface SearchIdentity { name: string; backendRoles: string[]; internal?: boolean }
export interface SecurityMaster { arn?: string; username?: string; verifier?: PasswordVerifier }
interface IndexPermission { index_patterns: string[]; allowed_actions: string[]; dls?: string; fls?: string[] }
interface Role { cluster_permissions: string[]; index_permissions: IndexPermission[] }
const GROUPS: Record<string, string[]> = {
  cluster_manage_pipelines: ["cluster:admin/ingest/pipeline/*", "cluster:admin/search/pipeline/*"],
  index_management_full_access: ["cluster:admin/opendistro/ism/*", "indices:admin/opensearch/ism/*"],
  all_access: ["*"], unlimited: ["*"], cluster_all: ["cluster:*"], cluster_composite_ops: ["cluster:monitor/*"],
  cluster_composite_ops_ro: ["cluster:monitor/*"], cluster_monitor: ["cluster:monitor/*"],
  read: ["indices:data/read/*", "indices:admin/mappings/get", "indices:admin/get", "indices:admin/aliases/get", "indices:admin/settings/get", "indices:admin/resolve/index"],
  search: ["indices:data/read/search*", "indices:data/read/msearch*", "indices:data/read/count*"],
  get: ["indices:data/read/get*", "indices:data/read/mget*"],
  write: ["indices:data/write/*"], index: ["indices:data/write/index*", "indices:data/write/update*"], delete: ["indices:data/write/delete*"],
  create_index: ["indices:admin/create", "indices:admin/mapping/put"], manage: ["indices:admin/*"],
  crud: ["indices:data/read/*", "indices:data/write/*"], indices_all: ["indices:*"],
};
const allowed = (actions: string[], action: string) => actions.some(value => (GROUPS[value] ?? [value]).some(pattern => wildcard(pattern, action)));
const strings = (value: unknown, label: string, max = 100): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.length || item.length > 1024)) fail(`${label} must contain at most ${max} nonempty strings`);
  return value as string[];
};
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 8 || password.length > 256 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^a-zA-Z0-9]/.test(password)) fail("Passwords require 8–256 characters including uppercase, lowercase, a digit and a symbol");
}
export function passwordVerifier(password: unknown): PasswordVerifier {
  validatePassword(password);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  try { return { salt: salt.toString("base64"), hash: hash.toString("base64") }; } finally { hash.fill(0); salt.fill(0); }
}
function verify(password: string, verifier: PasswordVerifier): boolean {
  if (password.length > 256) return false;
  const actual = scryptSync(password, Buffer.from(verifier.salt, "base64"), 32);
  const expected = Buffer.from(verifier.hash, "base64");
  try { return expected.length === actual.length && timingSafeEqual(expected, actual); } finally { actual.fill(0); expected.fill(0); }
}

/** An immutable per-request authority, applied before query/aggregation evaluation. */
export class SearchAccess {
  readonly fingerprint: string;
  constructor(readonly identity: SearchIdentity, readonly master: boolean, private readonly roles: Role[], revision: string) {
    this.fingerprint = createHash("sha256").update(JSON.stringify([identity, master, roles, revision])).digest("hex");
  }
  private permissions(index: string, action: string): IndexPermission[] {
    return this.roles.flatMap(role => role.index_permissions).filter(permission => permission.index_patterns.some(pattern => wildcard(pattern, index)) && allowed(permission.allowed_actions, action));
  }
  index(index: string, action: string): void {
    if (this.master) return;
    const permissions = this.permissions(index, action);
    if (action.startsWith("indices:data/write/") && this.roles.some(role => role.index_permissions.some(permission => permission.index_patterns.some(pattern => wildcard(pattern, index)) && (permission.dls || permission.fls?.length)))) fail("Document/field-restricted roles are read-only", "security_exception", 403);
    if (!permissions.length || !action.startsWith("indices:data/read/") && !action.startsWith("indices:admin/") && !permissions.some(permission => !permission.dls && !permission.fls?.length)) fail(`No permissions for [${action}] on [${index}]`, "security_exception", 403);
    if (action.startsWith("indices:admin/") && !action.endsWith("/get") && action !== "indices:admin/get" && action !== "indices:admin/shards/search_shards" && permissions.every(permission => permission.dls || permission.fls?.length)) fail("Restricted document/field roles cannot administer indexes", "security_exception", 403);
  }
  cluster(action: string): void { if (!this.master && !this.roles.some(role => allowed(role.cluster_permissions, action))) fail(`No permissions for [${action}]`, "security_exception", 403); }
  private restrictions(index: string, action: string): IndexPermission[] { return this.permissions(index, action); }
  unrestrictedMetadata(index: string, action: string): boolean { return this.master || this.permissions(index, action).some(permission => !permission.dls && !permission.fls?.length); }
  private fieldAllowed(index: string, path: string, action: string): boolean {
    if (this.master) return true;
    return this.restrictions(index, action).some(permission => {
      const fields = permission.fls ?? [];
      const includes = fields.filter(field => !field.startsWith("~")), excludes = fields.filter(field => field.startsWith("~")).map(field => field.slice(1));
      return (!includes.length || includes.some(pattern => wildcard(pattern, path) || path.startsWith(`${pattern}.`))) && !excludes.some(pattern => wildcard(pattern, path) || path.startsWith(`${pattern}.`));
    });
  }
  mappings(index: string, mappings: Json, action: string): Json {
    if (this.master) return mappings;
    const walk = (properties: Json, prefix = ""): Json => Object.fromEntries(Object.entries<any>(properties).flatMap(([name, field]) => {
      const path = prefix ? `${prefix}.${name}` : name;
      const properties = field.properties ? walk(field.properties, path) : undefined;
      const fields = field.fields ? walk(field.fields, path) : undefined;
      if (!this.fieldAllowed(index, path, action) && !Object.keys(properties ?? {}).length && !Object.keys(fields ?? {}).length) return [];
      return [[name, { ...field, ...(properties ? { properties } : {}), ...(fields ? { fields } : {}) }]];
    }));
    return { ...mappings, properties: walk(mappings.properties ?? {}) };
  }
  candidate(doc: Candidate, action: string): Candidate | undefined {
    if (this.master) return doc;
    const permissions = this.restrictions(doc._index, action);
    if (!permissions.some(permission => !permission.dls || compileQuery(JSON.parse(permission.dls))(doc) !== null)) return undefined;
    const project = (value: any, prefix: string): any => {
      if (Array.isArray(value)) { const selected = value.map(item => project(item, prefix)).filter(item => item !== undefined); return selected.length || this.fieldAllowed(doc._index, prefix, action) ? selected : undefined; }
      if (value && typeof value === "object") {
        const entries = Object.entries(value).flatMap(([key, child]) => { const selected = project(child, prefix ? `${prefix}.${key}` : key); return selected === undefined ? [] : [[key, selected]]; });
        return entries.length || !prefix ? Object.fromEntries(entries) : undefined;
      }
      return this.fieldAllowed(doc._index, prefix, action) ? value : undefined;
    };
    return { ...doc, _source: project(doc._source, ""), mappings: this.mappings(doc._index, doc.mappings, action) };
  }
}

/** Security records live in the same encrypted transactional store as indexes. */
export class SearchSecurity {
  constructor(private readonly get: (name: string) => any, private readonly put: (name: string, value: any) => void, private readonly remove: (name: string) => void, private readonly entries: () => any[]) {}
  setMaster(master: SecurityMaster): void { this.put("master", master); this.bump(); }
  auditConfig(): Json { return this.get("audit:config") ?? defaultAudit(); }
  private bump(): void { this.put("revision", randomBytes(16).toString("hex")); }
  authenticate(header: string): SearchIdentity {
    if (!/^Basic [A-Za-z0-9+/]+=*$/.test(header)) fail("Invalid basic credentials", "security_exception", 401);
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"), at = decoded.indexOf(":");
    if (at < 1) fail("Invalid basic credentials", "security_exception", 401);
    const name = decoded.slice(0, at), password = decoded.slice(at + 1);
    const master: SecurityMaster | undefined = this.get("master");
    const user = this.get(`user:${name}`);
    const verifier = master?.username === name ? master.verifier : user?.verifier;
    // Do the same expensive operation for an unknown username.
    const valid = verify(password, verifier ?? { salt: Buffer.alloc(16).toString("base64"), hash: Buffer.alloc(32).toString("base64") });
    if (!valid || !verifier) fail("Invalid basic credentials", "security_exception", 401);
    return { name, backendRoles: user?.backend_roles ?? [], internal: true };
  }
  access(identity: SearchIdentity): SearchAccess {
    const master: SecurityMaster | undefined = this.get("master");
    const administrator = Boolean(identity.internal ? master?.username === identity.name : master?.arn === identity.name);
    const names = new Set<string>(identity.internal ? this.get(`user:${identity.name}`)?.opendistro_security_roles ?? [] : []);
    for (const entry of this.entries()) if (entry.kind === "mapping" && ((entry.users ?? []).includes(identity.name) || (entry.backend_roles ?? []).some((role: string) => identity.backendRoles.includes(role)))) names.add(entry.name);
    const roles = [...names].map(name => name === "all_access" ? { cluster_permissions: ["*"], index_permissions: [{ index_patterns: ["*"], allowed_actions: ["*"] }] } : name === "readall" ? { cluster_permissions: ["cluster_monitor"], index_permissions: [{ index_patterns: ["*"], allowed_actions: ["read"] }] } : name === "manage_snapshots" ? { cluster_permissions: ["cluster:admin/snapshot/*", "cluster:admin/repository/*", "cluster:admin/index_template/get", "cluster:admin/index_template/put", "cluster:admin/ingest/pipeline/get", "cluster:admin/ingest/pipeline/put", "cluster:admin/search/pipeline/get", "cluster:admin/search/pipeline/put"], index_permissions: [{ index_patterns: ["*"], allowed_actions: ["indices:admin/snapshot/*", "indices:admin/create"] }] } : this.get(`role:${name}`)).filter(Boolean);
    return new SearchAccess(identity, administrator, roles, this.get("revision") ?? "0");
  }
  jobAccess(identity?: SearchIdentity): SearchAccess | undefined {
    if (!this.get("master")) return undefined;
    if (!identity) return fail("ISM must be reattached by an authorized user after enabling fine-grained security", "security_exception", 403);
    if (identity.internal) {
      const user = this.get(`user:${identity.name}`);
      if (!user && this.get("master")?.username !== identity.name) fail("The ISM execution user no longer exists", "security_exception", 403);
      identity = { ...identity, backendRoles: user?.backend_roles ?? [] };
    }
    return this.access(identity);
  }
  request(method: string, path: string, body: Json, access: SearchAccess): Json {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "_plugins" || parts[1] !== "_security") fail("Invalid security API path");
    if (parts[2] === "authinfo" && parts.length === 3 && method === "GET") return { user: access.identity.name, user_name: access.identity.name, backend_roles: access.identity.backendRoles, roles: access.master ? ["all_access", "security_manager"] : [] };
    if (!access.master) fail("Security administration requires the master user", "security_exception", 403);
    if (parts[2] !== "api" || parts.length > 5) fail("Unsupported security API path");
    if (parts[3] === "audit") {
      if (parts[4] !== undefined && parts[4] !== "config") fail("The only supported audit configuration is config");
      if (method === "GET") return { config: structuredClone(this.auditConfig()) };
      if (method !== "PUT" && method !== "PATCH" || method === "PUT" && parts[4] !== "config") fail("Audit configuration supports GET, PUT /audit/config and PATCH");
      const config = method === "PATCH" ? patchAudit(this.auditConfig(), body) : validateAudit(body);
      this.put("audit:config", config); this.bump(); return { status: "OK", message: "Audit configuration updated" };
    }
    const kind = ({ roles: "role", rolesmapping: "mapping", internalusers: "user" } as Json)[parts[3]];
    if (!kind) fail("Supported security APIs are roles, rolesmapping and internalusers");
    const name = parts[4];
    if (name && (!/^[a-zA-Z0-9_.@:/-]{1,256}$/.test(name) || kind === "role" && ["all_access", "readall", "manage_snapshots"].includes(name))) fail("Invalid or reserved security resource name");
    const clean = (value: Json) => { const { verifier, kind, name, ...publicValue } = value; return publicValue; };
    if (method === "GET") {
      if (name) { const value = this.get(`${kind}:${name}`); if (!value) fail("Security resource does not exist", "resource_not_found_exception", 404); return { [name]: clean(value) }; }
      return Object.fromEntries(this.entries().filter(entry => entry.kind === kind).map(entry => [entry.name, clean(entry)]));
    }
    if (!name) fail("A security resource name is required");
    if (method === "DELETE") { if (!this.get(`${kind}:${name}`)) fail("Security resource does not exist", "resource_not_found_exception", 404); this.remove(`${kind}:${name}`); this.bump(); return { status: "OK", message: `Deleted ${name}` }; }
    if (method !== "PUT") fail("Supported security methods are GET, PUT and DELETE");
    const value: Json = { kind, name };
    if (kind === "role") {
      keys(body, ["cluster_permissions", "index_permissions", "tenant_permissions"], "role");
      if (body.tenant_permissions?.length) fail("Shared security tenants are not implemented; workspace state is private to each identity");
      value.cluster_permissions = strings(body.cluster_permissions ?? [], "cluster_permissions");
      if (!Array.isArray(body.index_permissions ?? []) || (body.index_permissions ?? []).length > 100) fail("index_permissions requires at most 100 entries");
      value.index_permissions = (body.index_permissions ?? []).map((input: any) => {
        keys(record(input, "index permission"), ["index_patterns", "allowed_actions", "dls", "fls"], "index permission");
        const permission: IndexPermission = { index_patterns: strings(input.index_patterns, "index_patterns"), allowed_actions: strings(input.allowed_actions, "allowed_actions") };
        if (input.dls !== undefined) { if (typeof input.dls !== "string" || input.dls.length > 32768) fail("dls must be a query JSON string of at most 32768 characters"); if (input.dls) { let query; try { query = JSON.parse(input.dls); } catch { fail("Invalid DLS query JSON"); } compileQuery(query); permission.dls = input.dls; } }
        if (input.fls !== undefined) permission.fls = strings(input.fls, "fls");
        return permission;
      });
    } else if (kind === "mapping") {
      keys(body, ["users", "backend_roles", "hosts", "and_backend_roles"], "role mapping");
      if (body.hosts?.length || body.and_backend_roles?.length) fail("Host and conjunctive backend-role mappings are not implemented");
      value.users = strings(body.users ?? [], "users"); value.backend_roles = strings(body.backend_roles ?? [], "backend_roles");
    } else {
      keys(body, ["password", "backend_roles", "opendistro_security_roles", "attributes"], "internal user");
      if (Object.keys(body.attributes ?? {}).length) fail("User attribute substitution is not implemented");
      value.verifier = body.password === undefined ? this.get(`user:${name}`)?.verifier : passwordVerifier(body.password);
      if (!value.verifier) fail("A new internal user requires a password");
      value.backend_roles = strings(body.backend_roles ?? [], "backend_roles"); value.opendistro_security_roles = strings(body.opendistro_security_roles ?? [], "opendistro_security_roles");
    }
    if (!this.get(`${kind}:${name}`) && this.entries().filter(entry => entry.kind === kind).length >= 100) fail("The local limit of 100 security resources per type was reached", "limit_exceeded_exception", 429);
    this.put(`${kind}:${name}`, value); this.bump(); return { status: "OK", message: `Updated ${name}` };
  }
}
