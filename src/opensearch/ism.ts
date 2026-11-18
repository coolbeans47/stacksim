import { fail, integer, keys, record, SearchError, wildcard, type Json } from "./query.js";
import type { SearchAccess, SearchIdentity } from "./security.js";

export const ISM_INTERVAL = 5000;
interface ManagedIndex { name: string; uuid?: string; createdAt?: number; settings: Json }
interface Policy { name: string; policy: Json; seq: number; version: number; identity?: SearchIdentity }
interface Job { name: string; uuid?: string; createdAt: number; policy: Policy; identity?: SearchIdentity; state: string; started: number; action: number; actionStarted: number; retries: number; next: number; failed?: boolean; message?: string; complete?: boolean; rolledAt?: number; pending?: { policy: Policy; state: string; identity?: SearchIdentity } }
interface Port {
  get(kind: string, name: string): any; entries(kind: string): any[]; put(kind: string, name: string, value: any): void; remove(kind: string, name: string): void;
  indexes(): ManagedIndex[]; transaction<T>(work: () => T): T; access(identity?: SearchIdentity): SearchAccess | undefined;
  stats(name: string): { count: number; bytes: number }; block(name: string, value: boolean): void; delete(name: string): void;
  rollover(name: string, access?: SearchAccess): void;
}
function name(value: unknown, label = "Policy ID"): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) fail(`${label} must contain 1–255 letters, digits, dots, underscores or hyphens`); return value as string; }
function duration(value: unknown): number {
  const match = typeof value === "string" && /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) return fail("ISM durations require nonnegative integers with ms, s, m, h or d units");
  const result = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!);
  if (!Number.isSafeInteger(result) || result > 36500 * 86400000) fail("ISM duration exceeds 100 years"); return result;
}
function bytes(value: unknown): number {
  const match = typeof value === "string" && /^(\d+)(b|kb|mb|gb|tb)$/.exec(value);
  if (!match) return fail("ISM min_size requires integer b, kb, mb, gb or tb units");
  const result = Number(match[1]) * 1024 ** ["b", "kb", "mb", "gb", "tb"].indexOf(match[2]);
  if (!Number.isSafeInteger(result)) fail("ISM min_size is too large"); return result;
}
function conditions(input: any, rollover = false): Json {
  const value = record(input, "ISM conditions"); keys(value, ["min_index_age", "min_doc_count", "min_size", ...(rollover ? [] : ["min_rollover_age"])], "ISM conditions");
  for (const [key, item] of Object.entries(value)) {
    if (key === "min_doc_count") { if (typeof item !== "number") fail("min_doc_count must be an integer"); integer(item, 0, 0, Number.MAX_SAFE_INTEGER); }
    else if (key === "min_size") bytes(item); else duration(item);
  }
  return value;
}
export function validateIsmPolicy(input: Json): Json {
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) fail("ISM policies are limited to 64 KiB");
  keys(input, ["description", "default_state", "states", "ism_template", "schema_version", "error_notification", "policy_id", "last_updated_time"], "ISM policy");
  if (typeof input.description !== "string" || input.description.length > 4096) fail("ISM description must be a string of at most 4096 characters");
  name(input.default_state, "Default state");
  if (input.schema_version !== undefined) { if (typeof input.schema_version !== "number") fail("schema_version must be an integer"); integer(input.schema_version, 1, 1, Number.MAX_SAFE_INTEGER); }
  if (input.policy_id !== undefined) name(input.policy_id);
  if (input.last_updated_time !== undefined && (!Number.isSafeInteger(input.last_updated_time) || input.last_updated_time < 0)) fail("Invalid policy update time");
  if (input.error_notification != null) fail("ISM error notifications are not supported");
  if (!Array.isArray(input.states) || !input.states.length || input.states.length > 32) fail("ISM requires 1–32 states");
  const states = new Set<string>(); let steps = 0;
  for (const state of input.states) {
    keys(record(state, "ISM state"), ["name", "actions", "transitions"], "ISM state"); name(state.name, "State name");
    if (states.has(state.name)) fail("Duplicate ISM state"); states.add(state.name);
    if (!Array.isArray(state.actions) || !Array.isArray(state.transitions) || (steps += state.actions.length + state.transitions.length) > 128) fail("ISM policies allow at most 128 actions and transitions");
    for (const action of state.actions) {
      keys(record(action, "ISM action"), ["read_only", "read_write", "delete", "rollover", "retry", "timeout"], "ISM action");
      const operations = Object.keys(action).filter(key => !["retry", "timeout"].includes(key)); if (operations.length !== 1) fail("Each ISM action requires exactly one operation");
      if (operations[0] === "rollover") conditions(action.rollover, true); else keys(record(action[operations[0]], "ISM action options"), [], "ISM action options");
      if (action.timeout !== undefined && duration(action.timeout) < 1) fail("ISM timeout must be positive");
      if (action.retry !== undefined) {
        const retry = record(action.retry, "ISM retry"); keys(retry, ["count", "backoff", "delay"], "ISM retry");
        if (typeof retry.count !== "number") fail("ISM retry.count is required"); integer(retry.count, 0, 0, 10);
        if (retry.backoff !== undefined && !["constant", "linear", "exponential"].includes(retry.backoff)) fail("Unsupported ISM retry backoff");
        if (retry.delay !== undefined && duration(retry.delay) < ISM_INTERVAL) fail("ISM retry delay must be at least 5s");
      }
    }
    for (const transition of state.transitions) { keys(record(transition, "ISM transition"), ["state_name", "conditions"], "ISM transition"); name(transition.state_name, "Transition state"); if (transition.conditions !== undefined) conditions(transition.conditions); }
  }
  if (!states.has(input.default_state) || input.states.some((state: Json) => state.transitions.some((transition: Json) => !states.has(transition.state_name)))) fail("ISM references an undefined state");
  if (input.ism_template !== undefined && input.ism_template !== null) {
    const templates = Array.isArray(input.ism_template) ? input.ism_template : [input.ism_template];
    if (!templates.length || templates.length > 10) fail("ISM allows 1–10 templates");
    for (const template of templates) {
      keys(record(template, "ISM template"), ["index_patterns", "priority"], "ISM template");
      if (!Array.isArray(template.index_patterns) || !template.index_patterns.length || template.index_patterns.length > 20 || template.index_patterns.some((pattern: any) => typeof pattern !== "string" || !/^[a-z0-9*?][a-z0-9._*?-]{0,254}$/.test(pattern))) fail("Invalid ISM index patterns");
      if (template.priority !== undefined && typeof template.priority !== "number") fail("ISM template priority must be an integer"); integer(template.priority, 0, 0, 1000000);
    }
    input = { ...input, ism_template: templates };
  }
  const { policy_id, last_updated_time, ...definition } = input; return structuredClone(definition);
}
const operation = (action: Json) => Object.keys(action).find(key => !["retry", "timeout"].includes(key))!;
const permission = (action: string) => action === "delete" ? "indices:admin/delete" : action === "rollover" ? "indices:admin/aliases" : "indices:admin/settings/update";

/** Durable local ISM interpreter. Each action and its checkpoint commit together. */
export class IndexStateManagement {
  constructor(private readonly port: Port, private readonly now: () => number) {}
  private policy(id: string): Policy { return this.port.get("ism-policy", id) ?? fail(`ISM policy [${id}] not found`, "resource_not_found_exception", 404); }
  private view(policy: Policy): Json { return { _id: policy.name, _version: policy.version, _seq_no: policy.seq, _primary_term: 1, policy: { ...policy.policy, policy_id: policy.name } }; }
  private check(index: string, policy: Policy, access?: SearchAccess): void {
    access?.index(index, "indices:admin/opensearch/ism/managedindex");
    for (const state of policy.policy.states) for (const action of state.actions) access?.index(index, permission(operation(action)));
  }
  private attach(index: ManagedIndex, policy: Policy, identity?: SearchIdentity): void {
    const now = this.now(); this.port.put("ism-job", index.name, { name: index.name, uuid: index.uuid, createdAt: index.createdAt ?? now, policy, identity, state: policy.policy.default_state, started: now, action: 0, actionStarted: now, retries: 0, next: now + ISM_INTERVAL } satisfies Job);
  }
  created(index: ManagedIndex): void {
    const matches = this.port.entries("ism-policy").flatMap((policy: Policy) => (policy.policy.ism_template ?? []).filter((template: Json) => template.index_patterns.some((pattern: string) => wildcard(pattern, index.name))).map((template: Json) => ({ policy, priority: template.priority ?? 0 }))).sort((a, b) => b.priority - a.priority);
    if (!matches.length) return;
    if (matches.some(match => match.priority === matches[0].priority && match.policy.name !== matches[0].policy.name)) fail("Index matches ISM policies with equal priority");
    const policy = matches[0].policy;
    // Template attachment persists first; any revoked permissions produce a visible
    // failed job when the scheduler runs, without preventing ordinary index creation.
    this.attach(index, policy, policy.identity);
  }
  request(method: string, parts: string[], body: Json, query: URLSearchParams, access?: SearchAccess): { status: number; body: Json } {
    const [route, id] = parts;
    if (parts.length > 2 || !route) fail("Unsupported ISM path");
    access?.cluster(`cluster:admin/opendistro/ism/${route}/${method.toLowerCase()}`);
    if (route === "policies") {
      const permitted = method === "GET" && !id ? ["from", "size"] : method === "PUT" ? ["if_seq_no", "if_primary_term"] : [];
      for (const key of query.keys()) if (!permitted.includes(key) || query.getAll(key).length !== 1) fail("Unsupported ISM policy query parameter");
      if (!id) {
        if (method !== "GET") fail("ISM policy ID is required"); keys(body, [], "ISM policy list");
        const from = integer(query.get("from") ?? undefined, 0, 0, 100), size = integer(query.get("size") ?? undefined, 100, 1, 100), policies = this.port.entries("ism-policy");
        return { status: 200, body: { policies: policies.slice(from, from + size).map(policy => this.view(policy)), total_policies: policies.length } };
      }
      name(id);
      if (method === "GET") { keys(body, [], "ISM get"); return { status: 200, body: this.view(this.policy(id)) }; }
      if (method === "DELETE") { keys(body, [], "ISM delete"); const policy = this.policy(id); this.port.remove("ism-policy", id); return { status: 200, body: { _id: id, _version: policy.version + 1, _seq_no: policy.seq + 1, _primary_term: 1, result: "deleted" } }; }
      if (method !== "PUT") fail("Unsupported ISM policy method");
      keys(body, ["policy"], "ISM policy request"); const definition = validateIsmPolicy(record(body.policy, "policy")), old = this.port.get("ism-policy", id) as Policy | undefined;
      if (body.policy.policy_id !== undefined && body.policy.policy_id !== id) fail("Body policy_id must match the path");
      if (old || query.size) {
        if (!old || !query.has("if_seq_no") || !query.has("if_primary_term") || integer(query.get("if_seq_no"), 0, 0, Number.MAX_SAFE_INTEGER) !== old.seq || integer(query.get("if_primary_term"), 1, 1, Number.MAX_SAFE_INTEGER) !== 1) fail("ISM policy version conflict; supply its current if_seq_no and if_primary_term", "version_conflict_engine_exception", 409);
      }
      if (!old && this.port.entries("ism-policy").length >= 100) fail("The local limit of 100 ISM policies was reached", "limit_exceeded_exception", 429);
      const policy: Policy = { name: id, policy: { ...definition, last_updated_time: this.now() }, seq: (old?.seq ?? -1) + 1, version: (old?.version ?? 0) + 1, identity: access?.identity };
      this.port.put("ism-policy", id, policy); return { status: old ? 200 : 201, body: this.view(policy) };
    }
    if (!id || !["add", "remove", "change_policy", "retry", "explain"].includes(route) || method !== (route === "explain" ? "GET" : "POST")) fail("Unsupported ISM index operation");
    for (const key of query.keys()) if (route !== "explain" || key !== "show_policy" || query.getAll(key).length !== 1 || !["true", "false"].includes(query.get(key)!)) fail("Unsupported ISM query parameter");
    keys(body, route === "add" ? ["policy_id"] : route === "change_policy" ? ["policy_id", "state", "include"] : route === "retry" ? ["state"] : [], "ISM index request");
    const indexes = this.port.indexes().filter(index => id.split(",").some(pattern => wildcard(pattern, index.name)));
    if (!indexes.length) fail(`No indexes match [${id}]`, "index_not_found_exception", 404);
    // Resolve only concrete user indexes; aliases and internal metadata are not targets.
    for (const index of indexes) access?.index(index.name, route === "explain" ? "indices:admin/opensearch/ism/get" : "indices:admin/opensearch/ism/managedindex");
    if (route === "explain") {
      const entries = indexes.map(index => { const job = this.port.get("ism-job", index.name) as Job | undefined;
        return [index.name, job ? { index: index.name, index_uuid: index.uuid, policy_id: job.policy.name, "index.plugins.index_state_management.policy_id": job.policy.name, policy_seq_no: job.policy.seq, policy_primary_term: 1, index_creation_date: job.createdAt, state: { name: job.state, start_time: job.started }, action: { name: job.policy.policy.states.find((state: Json) => state.name === job.state)?.actions[job.action] ? operation(job.policy.policy.states.find((state: Json) => state.name === job.state).actions[job.action]) : "transition", index: job.action, start_time: job.actionStarted, failed: !!job.failed, consumed_retries: job.retries }, retry_info: { failed: !!job.failed, consumed_retries: job.retries }, enabled: !job.failed && !job.complete, rolled_over: job.rolledAt !== undefined, info: { message: job.message ?? (job.complete ? "Policy completed" : "Waiting for the next ISM interval") }, ...(job.pending ? { change_policy: { policy_id: job.pending.policy.name, state: job.pending.state } } : {}), ...(query.get("show_policy") === "true" ? { policy: this.view(job.policy).policy } : {}) } : { "index.plugins.index_state_management.policy_id": null }]; });
      return { status: 200, body: { ...Object.fromEntries(entries), total_managed_indices: indexes.filter(index => this.port.get("ism-job", index.name)).length } };
    }
    const policy = ["add", "change_policy"].includes(route) ? this.policy(name(body.policy_id)) : undefined;
    if (body.state !== undefined) name(body.state, "State");
    if (policy && body.state !== undefined && !policy.policy.states.some((state: Json) => state.name === body.state)) fail("Requested ISM state does not exist");
    if (body.include !== undefined && (!Array.isArray(body.include) || body.include.length > 32)) fail("ISM include must be an array of at most 32 states");
    for (const item of body.include ?? []) { keys(record(item, "ISM include"), ["state"], "ISM include"); name(item.state, "Included state"); }
    if (policy) for (const index of indexes) this.check(index.name, policy, access);
    let updated = 0; const failures: Json[] = [];
    for (const index of indexes) {
      const job = this.port.get("ism-job", index.name) as Job | undefined;
      if (route === "remove") { if (job) { this.port.remove("ism-job", index.name); updated++; } continue; }
      if (route === "add" && !job) { this.attach(index, policy!, access?.identity); updated++; continue; }
      if (!job || route === "add" || route === "retry" && !job.failed) { failures.push({ index_name: index.name, index_uuid: index.uuid, reason: !job ? "Index is not managed" : route === "add" ? "Index already has a policy" : "Index is not failed" }); continue; }
      if (route === "change_policy") {
        if (body.include?.length && !body.include.some((item: Json) => item.state === job.state)) continue;
        job.pending = { policy: policy!, state: body.state ?? policy!.policy.default_state, identity: access?.identity }; job.next = this.now() + ISM_INTERVAL;
      } else {
        this.check(index.name, job.policy, access);
        if (body.state !== undefined) { if (!job.policy.policy.states.some((state: Json) => state.name === body.state)) fail("Requested ISM retry state does not exist"); job.state = body.state; job.started = this.now(); job.action = 0; }
        job.identity = access?.identity; job.failed = false; job.complete = false; job.message = undefined; job.retries = 0; job.actionStarted = this.now(); job.next = this.now() + ISM_INTERVAL;
      }
      this.port.put("ism-job", index.name, job); updated++;
    }
    return { status: 200, body: { updated_indices: updated, failures: failures.length > 0, failed_indices: failures } };
  }
  private matches(conditions: Json, job: Job): boolean {
    const stats = this.port.stats(job.name);
    return Object.entries(conditions).every(([key, value]) => key === "min_doc_count" ? stats.count >= Number(value) : key === "min_size" ? stats.bytes >= bytes(value) : key === "min_rollover_age" ? job.rolledAt !== undefined && this.now() - job.rolledAt >= duration(value) : this.now() - job.createdAt >= duration(value));
  }
  tick(): void {
    for (const saved of this.port.entries("ism-job") as Job[]) {
      if (saved.next > this.now() || !saved.pending && (saved.failed || saved.complete)) continue;
      const job = structuredClone(saved); let action: Json | undefined, checkpoint = saved;
      try {
        this.port.transaction(() => {
          const index = this.port.indexes().find(index => index.name === job.name && index.uuid === job.uuid);
          if (!index) { this.port.remove("ism-job", job.name); return; }
          if (job.pending) { const pending = job.pending; job.policy = pending.policy; job.identity = pending.identity; job.state = pending.state; job.started = job.actionStarted = this.now(); job.action = 0; job.retries = 0; job.failed = job.complete = false; delete job.pending; delete job.message; }
          checkpoint = structuredClone(job);
          const access = this.port.access(job.identity); access?.index(job.name, "indices:admin/opensearch/ism/managedindex");
          const state = job.policy.policy.states.find((state: Json) => state.name === job.state); action = state.actions[job.action]; job.next = this.now() + ISM_INTERVAL;
          if (action) {
            const op = operation(action); access?.index(job.name, permission(op));
            if (action.timeout !== undefined && this.now() - job.actionStarted >= duration(action.timeout)) fail("ISM action timed out", "timeout_exception", 408);
            if (op === "rollover" && !this.matches(action.rollover, job)) { job.message = "Waiting for rollover conditions"; this.port.put("ism-job", job.name, job); return; }
            if (op === "delete") { this.port.delete(job.name); this.port.remove("ism-job", job.name); return; }
            if (op === "rollover") { this.port.rollover(job.name, access); job.rolledAt = this.now(); }
            else this.port.block(job.name, op === "read_only");
            job.action++; job.actionStarted = this.now(); job.retries = 0; job.message = `${op} completed`;
          } else {
            const transition = state.transitions.find((transition: Json) => this.matches(transition.conditions ?? {}, job));
            if (transition) { job.state = transition.state_name; job.started = job.actionStarted = this.now(); job.action = 0; job.retries = 0; job.message = `Entered state ${job.state}`; }
            else if (!state.transitions.length) { job.complete = true; job.message = "Policy completed"; }
            else job.message = "Waiting for transition conditions";
          }
          this.port.put("ism-job", job.name, job);
        });
      } catch (error) {
        // The action transaction rolled back. Persist failure/retry against the
        // checkpoint before the action, retaining a requested policy change but
        // never publishing speculative action mutations or an advanced cursor.
        const retry = action?.retry, retries = checkpoint.retries;
        checkpoint.message = error instanceof SearchError ? error.message.slice(0, 1024) : "ISM action failed";
        if (retry && retries < retry.count && !(error instanceof SearchError && error.status === 408)) { checkpoint.retries++; checkpoint.next = this.now() + duration(retry.delay ?? "1m") * (retry.backoff === "constant" ? 1 : retry.backoff === "linear" ? checkpoint.retries : 2 ** retries); }
        else { checkpoint.failed = true; delete checkpoint.pending; }
        this.port.put("ism-job", checkpoint.name, checkpoint);
      }
    }
  }
}
