import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "./errors.js";
import { PaginationTokens } from "./core/pagination.js";
import { awsQueryErrorXml, parseAwsQuery, sendAwsQueryXml } from "./protocols/query-xml.js";
import type { StateStore } from "./state.js";
import type { IamAccessKeyState, IamGroupState, IamPolicyState, IamPolicyVersionState, IamRoleState, IamUserState, PolicyDocument, PolicyStatement } from "./types.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import { readBody } from "./util.js";

const NAMESPACE = "https://iam.amazonaws.com/doc/2010-05-08/";
const NAME = /^[\w+=,.@-]{1,128}$/;
const PATH = /^\/(?:[\x21-\x7E]+\/)?$/;

function identifier(prefix: string, length = 16): string { return prefix + randomBytes(length).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, length); }
function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function encodeDocument(document: PolicyDocument): string { return encodeURIComponent(JSON.stringify(document)); }

export function validatePolicyDocument(input: unknown, kind: "identity" | "trust" | "role-inline" = "identity"): PolicyDocument {
  let document: any = input;
  if (typeof document === "string") { try { document = JSON.parse(document); } catch { throw new AwsError("MalformedPolicyDocument", "Syntax errors in policy", 400); } }
  if (!document || typeof document !== "object" || !document.Statement || (document.Version && !["2008-10-17", "2012-10-17"].includes(document.Version))) throw new AwsError("MalformedPolicyDocument", "Policy document must contain a valid Version and Statement", 400);
  const statements = list<PolicyStatement>(document.Statement);
  if (!statements.length) throw new AwsError("MalformedPolicyDocument", "Policy must contain at least one statement", 400);
  for (const statement of statements) {
    if (!statement || !["Allow", "Deny"].includes(statement.Effect) || Boolean(statement.Action) === Boolean(statement.NotAction)) throw new AwsError("MalformedPolicyDocument", "Each statement needs Effect and exactly one of Action or NotAction", 400);
    for (const action of [...list(statement.Action), ...list(statement.NotAction)]) if (typeof action !== "string") throw new AwsError("MalformedPolicyDocument", "Actions must be strings", 400);
    if (kind !== "trust" && statement.Principal !== undefined) throw new AwsError("MalformedPolicyDocument", "Identity policies cannot contain Principal", 400);
    if (kind === "trust" && statement.Principal === undefined && statement.NotPrincipal === undefined) throw new AwsError("MalformedPolicyDocument", "Trust policy statements require Principal or NotPrincipal", 400);
    if (statement.Condition !== undefined && (!statement.Condition || typeof statement.Condition !== "object" || Array.isArray(statement.Condition))) throw new AwsError("MalformedPolicyDocument", "Condition must be an object", 400);
  }
  const maximumBytes = kind === "trust" ? 131_072 : kind === "role-inline" ? 10_240 : 6_144;
  if (Buffer.byteLength(JSON.stringify(document)) > maximumBytes) throw new AwsError("LimitExceeded", "Policy document exceeds the maximum size", 409);
  return structuredClone(document) as PolicyDocument;
}

function roleView(role: IamRoleState): any {
  return { Path: role.path, RoleName: role.roleName, RoleId: role.roleId, Arn: role.arn, CreateDate: new Date(role.createDate), AssumeRolePolicyDocument: encodeDocument(role.assumeRolePolicyDocument), Description: role.description, MaxSessionDuration: role.maxSessionDuration, Tags: Object.entries(role.tags).map(([Key, Value]) => ({ Key, Value })), ...(role.permissionsBoundaryArn ? { PermissionsBoundary: { PermissionsBoundaryType: "Policy", PermissionsBoundaryArn: role.permissionsBoundaryArn } } : {}) };
}

function policyView(policy: IamPolicyState, iam: StateStore["state"]["accounts"][string]["iam"]): any {
  const attachmentCount = [...Object.values(iam.roles), ...Object.values(iam.users), ...Object.values(iam.groups)].filter(entity => entity.attachedPolicyArns.includes(policy.arn)).length;
  return { PolicyName: policy.policyName, PolicyId: policy.policyId, Arn: policy.arn, Path: policy.path, DefaultVersionId: policy.defaultVersionId, AttachmentCount: attachmentCount, PermissionsBoundaryUsageCount: 0, IsAttachable: true, Description: policy.description, CreateDate: new Date(policy.createDate), UpdateDate: new Date(policy.updateDate), Tags: Object.entries(policy.tags).map(([Key, Value]) => ({ Key, Value })) };
}

function versionView(version: IamPolicyVersionState, includeDocument = false): any { return { VersionId: version.versionId, IsDefaultVersion: version.isDefaultVersion, CreateDate: new Date(version.createDate), ...(includeDocument ? { Document: encodeDocument(version.document) } : {}) }; }
function userView(user: IamUserState): any { return { Path: user.path, UserName: user.userName, UserId: user.userId, Arn: user.arn, CreateDate: new Date(user.createDate), Tags: Object.entries(user.tags).map(([Key, Value]) => ({ Key, Value })), ...(user.permissionsBoundaryArn ? { PermissionsBoundary: { PermissionsBoundaryType: "Policy", PermissionsBoundaryArn: user.permissionsBoundaryArn } } : {}) }; }
function groupView(group: IamGroupState): any { return { Path: group.path, GroupName: group.groupName, GroupId: group.groupId, Arn: group.arn, CreateDate: new Date(group.createDate) }; }
function keyView(key: IamAccessKeyState): any { return { UserName: key.userName, AccessKeyId: key.accessKeyId, Status: key.status, CreateDate: new Date(key.createDate) }; }

export class IamService {
  constructor(private readonly store: StateStore, private readonly clock: { now(): number }) {}
  private get iam() { return this.store.ensureAccount().iam; }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private role(name: string): IamRoleState { const role = this.iam.roles[name]; if (!role) throw new AwsError("NoSuchEntity", `The role with name ${name} cannot be found.`, 404); return role; }
  private user(name: string): IamUserState { const user = this.iam.users[name]; if (!user) throw new AwsError("NoSuchEntity", `The user with name ${name} cannot be found.`, 404); return user; }
  private group(name: string): IamGroupState { const group = this.iam.groups[name]; if (!group) throw new AwsError("NoSuchEntity", `The group with name ${name} cannot be found.`, 404); return group; }
  private policy(arn: string): IamPolicyState { const policy = this.iam.policies[arn]; if (!policy) throw new AwsError("NoSuchEntity", `Policy ${arn} was not found.`, 404); return policy; }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string, principal?: PrincipalContext): Promise<void> {
    try {
      const input = parseAwsQuery((await readBody(req)).toString("utf8")) as any; const action = String(input.Action ?? ""); if (!action || typeof (this as any)[action] !== "function") throw new AwsError("InvalidAction", `The action ${action} is not valid for this service`, 400);
      if (action === "CreateAccessKey") res.setHeader("cache-control", "no-store");
      delete input.Action; delete input.Version; const result = await (this as any)[action](input, principal); sendAwsQueryXml(res, `${action}Response`, { [`${action}Result`]: result, ResponseMetadata: { RequestId: requestId } }, NAMESPACE);
    } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("ServiceFailure", error instanceof Error ? error.message : String(error), 500); res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code, aws.message, requestId)); }
  }

  private tags(input: any): Record<string, string> {
    const tags: Record<string, string> = {}; for (const tag of list<any>(input.Tags)) { if (!tag.Key || tag.Value === undefined || tag.Key.length > 128 || String(tag.Value).length > 256) throw new AwsError("InvalidInput", "Invalid tag", 400); if (tags[tag.Key] !== undefined) throw new AwsError("InvalidInput", "Duplicate tag key", 400); tags[tag.Key] = String(tag.Value); } if (Object.keys(tags).length > 50) throw new AwsError("LimitExceeded", "Too many tags", 409); return tags;
  }

  private page<T>(operation: string, input: any, values: T[]): { values: T[]; marker?: string; truncated: boolean } {
    let index = 0; if (input.Marker) { try { index = this.tokens.decode<{ index: number }>(operation, input.Marker).index; } catch { throw new AwsError("InvalidInput", "Invalid marker", 400); } } const max = Math.min(1_000, Math.max(1, Number(input.MaxItems ?? 100))); const page = values.slice(index, index + max); const next = index + page.length; return { values: page, truncated: next < values.length, ...(next < values.length ? { marker: this.tokens.encode(operation, { index: next }) } : {}) };
  }

  async CreateRole(input: any): Promise<any> {
    if (!NAME.test(input.RoleName ?? "") || !PATH.test(input.Path ?? "/")) throw new AwsError("ValidationError", "Invalid role name or path", 400); if (this.iam.roles[input.RoleName]) throw new AwsError("EntityAlreadyExists", `Role ${input.RoleName} already exists.`, 409);
    if (input.PermissionsBoundary !== undefined) this.policy(input.PermissionsBoundary);
    const path = input.Path ?? "/"; const role: IamRoleState = { roleName: input.RoleName, roleId: identifier("AROA"), arn: `arn:aws:iam::${this.store.accountId}:role${path}${input.RoleName}`.replace("role//", "role/"), path, createDate: this.clock.now(), description: input.Description, maxSessionDuration: Number(input.MaxSessionDuration ?? 3600), assumeRolePolicyDocument: validatePolicyDocument(input.AssumeRolePolicyDocument, "trust"), tags: this.tags(input), attachedPolicyArns: [], inlinePolicies: {}, ...(input.PermissionsBoundary === undefined ? {} : { permissionsBoundaryArn: input.PermissionsBoundary }) };
    if (role.maxSessionDuration < 3600 || role.maxSessionDuration > 43_200) throw new AwsError("ValidationError", "MaxSessionDuration must be between 3600 and 43200", 400); this.iam.roles[role.roleName] = role; await this.store.save(); return { Role: roleView(role) };
  }
  async GetRole(input: any): Promise<any> { return { Role: roleView(this.role(input.RoleName)) }; }
  async ListRoles(input: any): Promise<any> { let roles = Object.values(this.iam.roles).filter(role => role.path.startsWith(input.PathPrefix ?? "/")).sort((a, b) => a.roleName.localeCompare(b.roleName)); const page = this.page("ListRoles", input, roles); return { Roles: page.values.map(roleView), IsTruncated: page.truncated, Marker: page.marker }; }
  async UpdateRole(input: any): Promise<any> { const role = this.role(input.RoleName); if (input.Description !== undefined) role.description = input.Description; if (input.MaxSessionDuration !== undefined) { const duration = Number(input.MaxSessionDuration); if (duration < 3600 || duration > 43_200) throw new AwsError("ValidationError", "Invalid MaxSessionDuration", 400); role.maxSessionDuration = duration; } await this.store.save(); return {}; }
  async UpdateAssumeRolePolicy(input: any): Promise<any> { const role = this.role(input.RoleName); role.assumeRolePolicyDocument = validatePolicyDocument(input.PolicyDocument, "trust"); await this.store.save(); return {}; }
  async DeleteRole(input: any): Promise<any> {
    const role = this.role(input.RoleName);
    if (role.attachedPolicyArns.length || Object.keys(role.inlinePolicies).length) throw new AwsError("DeleteConflict", "Cannot delete a role with policies attached.", 409);
    const referenced = Object.entries(this.store.ensureAccount().regions).flatMap(([region, state]) =>
      Object.values(state.functions).filter(fn => fn.role === role.arn).map(fn => `${region}:${fn.functionName}`),
    );
    if (referenced.length) throw new AwsError("DeleteConflict", `Cannot delete role ${role.roleName}; it is referenced by Lambda function ${referenced[0]}.`, 409);
    delete this.iam.roles[role.roleName]; await this.store.save(); return {};
  }

  async TagRole(input: any): Promise<any> { Object.assign(this.role(input.RoleName).tags, this.tags(input)); await this.store.save(); return {}; }
  async UntagRole(input: any): Promise<any> { const role = this.role(input.RoleName); for (const key of list<string>(input.TagKeys)) delete role.tags[key]; await this.store.save(); return {}; }
  async ListRoleTags(input: any): Promise<any> { const role = this.role(input.RoleName); return { Tags: Object.entries(role.tags).map(([Key, Value]) => ({ Key, Value })), IsTruncated: false }; }

  async CreatePolicy(input: any): Promise<any> {
    if (!NAME.test(input.PolicyName ?? "") || !PATH.test(input.Path ?? "/")) throw new AwsError("ValidationError", "Invalid policy name or path", 400); const path = input.Path ?? "/"; const arn = `arn:aws:iam::${this.store.accountId}:policy${path}${input.PolicyName}`.replace("policy//", "policy/"); if (Object.values(this.iam.policies).some(policy => !policy.awsManaged && policy.policyName === input.PolicyName)) throw new AwsError("EntityAlreadyExists", `Policy ${input.PolicyName} already exists.`, 409); const document = validatePolicyDocument(input.PolicyDocument); const now = this.clock.now(); const policy: IamPolicyState = { policyName: input.PolicyName, policyId: identifier("ANPA"), arn, path, description: input.Description, createDate: now, updateDate: now, tags: this.tags(input), versions: { v1: { versionId: "v1", document, createDate: now, isDefaultVersion: true } }, defaultVersionId: "v1", awsManaged: false }; this.iam.policies[arn] = policy; await this.store.save(); return { Policy: policyView(policy, this.iam) };
  }
  async GetPolicy(input: any): Promise<any> { return { Policy: policyView(this.policy(input.PolicyArn), this.iam) }; }
  async ListPolicies(input: any): Promise<any> { let policies = Object.values(this.iam.policies).filter(policy => (input.Scope === "Local" ? !policy.awsManaged : input.Scope === "AWS" ? policy.awsManaged : true) && policy.path.startsWith(input.PathPrefix ?? "/")); if (input.OnlyAttached) policies = policies.filter(policy => [...Object.values(this.iam.roles), ...Object.values(this.iam.users), ...Object.values(this.iam.groups)].some(entity => entity.attachedPolicyArns.includes(policy.arn))); policies.sort((a, b) => a.policyName.localeCompare(b.policyName)); const page = this.page("ListPolicies", input, policies); return { Policies: page.values.map(policy => policyView(policy, this.iam)), IsTruncated: page.truncated, Marker: page.marker }; }
  async DeletePolicy(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); if (policy.awsManaged) throw new AwsError("AccessDenied", "AWS managed policies are immutable", 403); if ([...Object.values(this.iam.roles), ...Object.values(this.iam.users), ...Object.values(this.iam.groups)].some(entity => entity.attachedPolicyArns.includes(policy.arn))) throw new AwsError("DeleteConflict", "Policy is attached to entities", 409); delete this.iam.policies[policy.arn]; await this.store.save(); return {}; }
  async CreatePolicyVersion(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); if (policy.awsManaged) throw new AwsError("AccessDenied", "AWS managed policies are immutable", 403); if (Object.keys(policy.versions).length >= 5) throw new AwsError("LimitExceeded", "Policy version limit exceeded", 409); const number = Math.max(0, ...Object.keys(policy.versions).map(key => Number(key.slice(1)))) + 1; const versionId = `v${number}`; if (input.SetAsDefault) { for (const version of Object.values(policy.versions)) version.isDefaultVersion = false; policy.defaultVersionId = versionId; } const version = policy.versions[versionId] = { versionId, document: validatePolicyDocument(input.PolicyDocument), createDate: this.clock.now(), isDefaultVersion: Boolean(input.SetAsDefault) }; policy.updateDate = this.clock.now(); await this.store.save(); return { PolicyVersion: versionView(version, true) }; }
  async GetPolicyVersion(input: any): Promise<any> { const version = this.policy(input.PolicyArn).versions[input.VersionId]; if (!version) throw new AwsError("NoSuchEntity", "Policy version was not found", 404); return { PolicyVersion: versionView(version, true) }; }
  async ListPolicyVersions(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); return { Versions: Object.values(policy.versions).sort((a, b) => b.createDate - a.createDate).map(version => versionView(version)), IsTruncated: false }; }
  async SetDefaultPolicyVersion(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); if (policy.awsManaged) throw new AwsError("AccessDenied", "AWS managed policies are immutable", 403); const version = policy.versions[input.VersionId]; if (!version) throw new AwsError("NoSuchEntity", "Policy version was not found", 404); for (const item of Object.values(policy.versions)) item.isDefaultVersion = false; version.isDefaultVersion = true; policy.defaultVersionId = version.versionId; policy.updateDate = this.clock.now(); await this.store.save(); return {}; }
  async DeletePolicyVersion(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); if (policy.awsManaged) throw new AwsError("AccessDenied", "AWS managed policies are immutable", 403); const version = policy.versions[input.VersionId]; if (!version) throw new AwsError("NoSuchEntity", "Policy version was not found", 404); if (version.isDefaultVersion) throw new AwsError("DeleteConflict", "Cannot delete the default policy version", 409); delete policy.versions[version.versionId]; await this.store.save(); return {}; }

  async AttachRolePolicy(input: any): Promise<any> { const role = this.role(input.RoleName); this.policy(input.PolicyArn); if (!role.attachedPolicyArns.includes(input.PolicyArn)) role.attachedPolicyArns.push(input.PolicyArn); await this.store.save(); return {}; }
  async DetachRolePolicy(input: any): Promise<any> { const role = this.role(input.RoleName); role.attachedPolicyArns = role.attachedPolicyArns.filter(arn => arn !== input.PolicyArn); await this.store.save(); return {}; }
  async ListAttachedRolePolicies(input: any): Promise<any> { const role = this.role(input.RoleName); const values = role.attachedPolicyArns.map(arn => this.policy(arn)).sort((a, b) => a.policyName.localeCompare(b.policyName)); const page = this.page("ListAttachedRolePolicies", input, values); return { AttachedPolicies: page.values.map(policy => ({ PolicyName: policy.policyName, PolicyArn: policy.arn })), IsTruncated: page.truncated, Marker: page.marker }; }
  async PutRolePolicy(input: any): Promise<any> {
    if (!NAME.test(input.PolicyName ?? "")) throw new AwsError("ValidationError", "Invalid policy name", 400);
    const role = this.role(input.RoleName);
    const document = validatePolicyDocument(input.PolicyDocument, "role-inline");
    const aggregateBytes = Object.entries(role.inlinePolicies)
      .filter(([name]) => name !== input.PolicyName)
      .reduce((total, [, current]) => total + Buffer.byteLength(JSON.stringify(current)), Buffer.byteLength(JSON.stringify(document)));
    if (aggregateBytes > 10_240) throw new AwsError("LimitExceeded", "Role inline policies exceed the aggregate maximum size", 409);
    role.inlinePolicies[input.PolicyName] = document;
    await this.store.save();
    return {};
  }
  async GetRolePolicy(input: any): Promise<any> { const document = this.role(input.RoleName).inlinePolicies[input.PolicyName]; if (!document) throw new AwsError("NoSuchEntity", "Inline policy was not found", 404); return { RoleName: input.RoleName, PolicyName: input.PolicyName, PolicyDocument: encodeDocument(document) }; }
  async ListRolePolicies(input: any): Promise<any> { const names = Object.keys(this.role(input.RoleName).inlinePolicies).sort(); const page = this.page("ListRolePolicies", input, names); return { PolicyNames: page.values, IsTruncated: page.truncated, Marker: page.marker }; }
  async DeleteRolePolicy(input: any): Promise<any> { const role = this.role(input.RoleName); if (!role.inlinePolicies[input.PolicyName]) throw new AwsError("NoSuchEntity", "Inline policy was not found", 404); delete role.inlinePolicies[input.PolicyName]; await this.store.save(); return {}; }
  async ListEntitiesForPolicy(input: any): Promise<any> {
    const policy = this.policy(input.PolicyArn); const prefix = input.PathPrefix ?? "/"; const filter = input.EntityFilter;
    const entities = [
      ...Object.values(this.iam.groups).filter(group => group.path.startsWith(prefix) && group.attachedPolicyArns.includes(policy.arn) && (!filter || filter === "Group")).map(value => ({ kind: "group" as const, value })),
      ...Object.values(this.iam.users).filter(user => user.path.startsWith(prefix) && user.attachedPolicyArns.includes(policy.arn) && (!filter || filter === "User")).map(value => ({ kind: "user" as const, value })),
      ...Object.values(this.iam.roles).filter(role => role.path.startsWith(prefix) && role.attachedPolicyArns.includes(policy.arn) && (!filter || filter === "Role")).map(value => ({ kind: "role" as const, value })),
    ].sort((left, right) => left.value.arn.localeCompare(right.value.arn));
    const page = this.page("ListEntitiesForPolicy", input, entities);
    return {
      PolicyGroups: page.values.filter(item => item.kind === "group").map(item => ({ GroupName: (item.value as IamGroupState).groupName, GroupId: (item.value as IamGroupState).groupId })),
      PolicyUsers: page.values.filter(item => item.kind === "user").map(item => ({ UserName: (item.value as IamUserState).userName, UserId: (item.value as IamUserState).userId })),
      PolicyRoles: page.values.filter(item => item.kind === "role").map(item => ({ RoleName: (item.value as IamRoleState).roleName, RoleId: (item.value as IamRoleState).roleId })),
      IsTruncated: page.truncated,
      Marker: page.marker,
    };
  }
  async TagPolicy(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); if (policy.awsManaged) throw new AwsError("AccessDenied", "AWS managed policies are immutable", 403); Object.assign(policy.tags, this.tags(input)); await this.store.save(); return {}; }
  async UntagPolicy(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); for (const key of list<string>(input.TagKeys)) delete policy.tags[key]; await this.store.save(); return {}; }
  async ListPolicyTags(input: any): Promise<any> { const policy = this.policy(input.PolicyArn); return { Tags: Object.entries(policy.tags).map(([Key, Value]) => ({ Key, Value })), IsTruncated: false }; }

  async CreateUser(input: any): Promise<any> {
    if (!NAME.test(input.UserName ?? "") || !PATH.test(input.Path ?? "/")) throw new AwsError("ValidationError", "Invalid user name or path", 400);
    if (this.iam.users[input.UserName]) throw new AwsError("EntityAlreadyExists", `User ${input.UserName} already exists.`, 409);
    if (Object.keys(this.iam.users).length >= 5_000) throw new AwsError("LimitExceeded", "Cannot exceed quota for Users: 5000", 409);
    if (input.PermissionsBoundary !== undefined) this.policy(input.PermissionsBoundary);
    const path = input.Path ?? "/";
    const user: IamUserState = { userName: input.UserName, userId: identifier("AIDA", 17), arn: `arn:aws:iam::${this.store.accountId}:user${path}${input.UserName}`.replace("user//", "user/"), path, createDate: this.clock.now(), tags: this.tags(input), attachedPolicyArns: [], inlinePolicies: {}, ...(input.PermissionsBoundary === undefined ? {} : { permissionsBoundaryArn: input.PermissionsBoundary }) };
    this.iam.users[user.userName] = user; await this.store.save(); return { User: userView(user) };
  }
  async GetUser(input: any, principal?: PrincipalContext): Promise<any> { const name = input.UserName ?? (principal?.principalType === "user" ? principal.userName : undefined); if (!name) throw new AwsError("ValidationError", "UserName is required for this principal", 400); return { User: userView(this.user(name)) }; }
  async ListUsers(input: any): Promise<any> { const values = Object.values(this.iam.users).filter(user => user.path.startsWith(input.PathPrefix ?? "/")).sort((a, b) => a.userName.localeCompare(b.userName)); const page = this.page("ListUsers", input, values); return { Users: page.values.map(userView), IsTruncated: page.truncated, Marker: page.marker }; }
  async UpdateUser(input: any): Promise<any> {
    const user = this.user(input.UserName); const nextName = input.NewUserName ?? user.userName; const nextPath = input.NewPath ?? user.path;
    if (!NAME.test(nextName) || !PATH.test(nextPath)) throw new AwsError("ValidationError", "Invalid user name or path", 400);
    if (nextName !== user.userName && this.iam.users[nextName]) throw new AwsError("EntityAlreadyExists", `User ${nextName} already exists.`, 409);
    const oldName = user.userName; user.userName = nextName; user.path = nextPath; user.arn = `arn:aws:iam::${this.store.accountId}:user${nextPath}${nextName}`.replace("user//", "user/");
    if (nextName !== oldName) { delete this.iam.users[oldName]; this.iam.users[nextName] = user; for (const group of Object.values(this.iam.groups)) group.userNames = group.userNames.map(value => value === oldName ? nextName : value); for (const key of Object.values(this.iam.accessKeys)) if (key.userName === oldName) key.userName = nextName; const initialization = this.store.state.installation.defaultAdministrators[this.store.accountId]; if (initialization?.originalUserId === user.userId) initialization.currentUserName = nextName; }
    await this.store.save(); return {};
  }
  async DeleteUser(input: any): Promise<any> {
    const user = this.user(input.UserName);
    if (Object.values(this.iam.accessKeys).some(key => key.userName === user.userName) || Object.values(this.iam.groups).some(group => group.userNames.includes(user.userName)) || user.attachedPolicyArns.length || Object.keys(user.inlinePolicies).length) throw new AwsError("DeleteConflict", "Cannot delete entity, must remove users from group, policies, and access keys first.", 409);
    delete this.iam.users[user.userName]; await this.store.save(); return {};
  }
  async TagUser(input: any): Promise<any> { const user = this.user(input.UserName); const tags = this.tags(input); if (Object.keys({ ...user.tags, ...tags }).length > 50) throw new AwsError("LimitExceeded", "Cannot exceed quota for TagsPerUser: 50", 409); Object.assign(user.tags, tags); await this.store.save(); return {}; }
  async UntagUser(input: any): Promise<any> { const user = this.user(input.UserName); for (const key of list<string>(input.TagKeys)) delete user.tags[key]; await this.store.save(); return {}; }
  async ListUserTags(input: any): Promise<any> { const values = Object.entries(this.user(input.UserName).tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })); const page = this.page("ListUserTags", input, values); return { Tags: page.values, IsTruncated: page.truncated, Marker: page.marker }; }
  async AttachUserPolicy(input: any): Promise<any> { const user = this.user(input.UserName); this.policy(input.PolicyArn); if (!user.attachedPolicyArns.includes(input.PolicyArn)) { if (user.attachedPolicyArns.length >= 10) throw new AwsError("LimitExceeded", "Cannot exceed quota for AttachedPoliciesPerUser: 10", 409); user.attachedPolicyArns.push(input.PolicyArn); } await this.store.save(); return {}; }
  async DetachUserPolicy(input: any): Promise<any> { const user = this.user(input.UserName); user.attachedPolicyArns = user.attachedPolicyArns.filter(arn => arn !== input.PolicyArn); await this.store.save(); return {}; }
  async ListAttachedUserPolicies(input: any): Promise<any> { const values = this.user(input.UserName).attachedPolicyArns.map(arn => this.policy(arn)).sort((a, b) => a.policyName.localeCompare(b.policyName)); const page = this.page("ListAttachedUserPolicies", input, values); return { AttachedPolicies: page.values.map(policy => ({ PolicyName: policy.policyName, PolicyArn: policy.arn })), IsTruncated: page.truncated, Marker: page.marker }; }
  async PutUserPolicy(input: any): Promise<any> { if (!NAME.test(input.PolicyName ?? "")) throw new AwsError("ValidationError", "Invalid policy name", 400); const user = this.user(input.UserName); const document = validatePolicyDocument(input.PolicyDocument); const aggregate = Object.entries(user.inlinePolicies).filter(([name]) => name !== input.PolicyName).reduce((total, [, value]) => total + Buffer.byteLength(JSON.stringify(value)), Buffer.byteLength(JSON.stringify(document))); if (aggregate > 2_048) throw new AwsError("LimitExceeded", "User inline policies exceed the aggregate maximum size", 409); user.inlinePolicies[input.PolicyName] = document; await this.store.save(); return {}; }
  async GetUserPolicy(input: any): Promise<any> { const document = this.user(input.UserName).inlinePolicies[input.PolicyName]; if (!document) throw new AwsError("NoSuchEntity", "Inline policy was not found", 404); return { UserName: input.UserName, PolicyName: input.PolicyName, PolicyDocument: encodeDocument(document) }; }
  async ListUserPolicies(input: any): Promise<any> { const values = Object.keys(this.user(input.UserName).inlinePolicies).sort(); const page = this.page("ListUserPolicies", input, values); return { PolicyNames: page.values, IsTruncated: page.truncated, Marker: page.marker }; }
  async DeleteUserPolicy(input: any): Promise<any> { const user = this.user(input.UserName); if (!user.inlinePolicies[input.PolicyName]) throw new AwsError("NoSuchEntity", "Inline policy was not found", 404); delete user.inlinePolicies[input.PolicyName]; await this.store.save(); return {}; }

  async CreateGroup(input: any): Promise<any> {
    if (!NAME.test(input.GroupName ?? "") || !PATH.test(input.Path ?? "/")) throw new AwsError("ValidationError", "Invalid group name or path", 400); if (this.iam.groups[input.GroupName]) throw new AwsError("EntityAlreadyExists", `Group ${input.GroupName} already exists.`, 409);
    if (Object.keys(this.iam.groups).length >= 300) throw new AwsError("LimitExceeded", "Cannot exceed quota for Groups: 300", 409);
    const path = input.Path ?? "/"; const group: IamGroupState = { groupName: input.GroupName, groupId: identifier("AGPA", 17), arn: `arn:aws:iam::${this.store.accountId}:group${path}${input.GroupName}`.replace("group//", "group/"), path, createDate: this.clock.now(), userNames: [], attachedPolicyArns: [], inlinePolicies: {} };
    this.iam.groups[group.groupName] = group; await this.store.save(); return { Group: groupView(group) };
  }
  async GetGroup(input: any): Promise<any> { const group = this.group(input.GroupName); const users = group.userNames.map(name => this.user(name)).sort((a, b) => a.userName.localeCompare(b.userName)); const page = this.page("GetGroup", input, users); return { Group: groupView(group), Users: page.values.map(userView), IsTruncated: page.truncated, Marker: page.marker }; }
  async ListGroups(input: any): Promise<any> { const values = Object.values(this.iam.groups).filter(group => group.path.startsWith(input.PathPrefix ?? "/")).sort((a, b) => a.groupName.localeCompare(b.groupName)); const page = this.page("ListGroups", input, values); return { Groups: page.values.map(groupView), IsTruncated: page.truncated, Marker: page.marker }; }
  async UpdateGroup(input: any): Promise<any> { const group = this.group(input.GroupName); const name = input.NewGroupName ?? group.groupName; const path = input.NewPath ?? group.path; if (!NAME.test(name) || !PATH.test(path)) throw new AwsError("ValidationError", "Invalid group name or path", 400); if (name !== group.groupName && this.iam.groups[name]) throw new AwsError("EntityAlreadyExists", `Group ${name} already exists.`, 409); const old = group.groupName; group.groupName = name; group.path = path; group.arn = `arn:aws:iam::${this.store.accountId}:group${path}${name}`.replace("group//", "group/"); if (name !== old) { delete this.iam.groups[old]; this.iam.groups[name] = group; } await this.store.save(); return {}; }
  async DeleteGroup(input: any): Promise<any> { const group = this.group(input.GroupName); if (group.userNames.length || group.attachedPolicyArns.length || Object.keys(group.inlinePolicies).length) throw new AwsError("DeleteConflict", "Cannot delete a group with members or policies.", 409); delete this.iam.groups[group.groupName]; await this.store.save(); return {}; }
  async AddUserToGroup(input: any): Promise<any> { const group = this.group(input.GroupName); this.user(input.UserName); if (!group.userNames.includes(input.UserName)) { if (group.userNames.length >= 500 || Object.values(this.iam.groups).filter(value => value.userNames.includes(input.UserName)).length >= 10) throw new AwsError("LimitExceeded", "IAM group membership quota exceeded", 409); group.userNames.push(input.UserName); } await this.store.save(); return {}; }
  async RemoveUserFromGroup(input: any): Promise<any> { const group = this.group(input.GroupName); this.user(input.UserName); if (!group.userNames.includes(input.UserName)) throw new AwsError("NoSuchEntity", "The user is not in the group.", 404); group.userNames = group.userNames.filter(name => name !== input.UserName); await this.store.save(); return {}; }
  async ListGroupsForUser(input: any): Promise<any> { this.user(input.UserName); const values = Object.values(this.iam.groups).filter(group => group.userNames.includes(input.UserName)).sort((a, b) => a.groupName.localeCompare(b.groupName)); const page = this.page("ListGroupsForUser", input, values); return { Groups: page.values.map(groupView), IsTruncated: page.truncated, Marker: page.marker }; }
  async AttachGroupPolicy(input: any): Promise<any> { const group = this.group(input.GroupName); this.policy(input.PolicyArn); if (!group.attachedPolicyArns.includes(input.PolicyArn)) { if (group.attachedPolicyArns.length >= 10) throw new AwsError("LimitExceeded", "Cannot exceed quota for AttachedPoliciesPerGroup: 10", 409); group.attachedPolicyArns.push(input.PolicyArn); } await this.store.save(); return {}; }
  async DetachGroupPolicy(input: any): Promise<any> { const group = this.group(input.GroupName); group.attachedPolicyArns = group.attachedPolicyArns.filter(arn => arn !== input.PolicyArn); await this.store.save(); return {}; }
  async ListAttachedGroupPolicies(input: any): Promise<any> { const values = this.group(input.GroupName).attachedPolicyArns.map(arn => this.policy(arn)).sort((a, b) => a.policyName.localeCompare(b.policyName)); const page = this.page("ListAttachedGroupPolicies", input, values); return { AttachedPolicies: page.values.map(policy => ({ PolicyName: policy.policyName, PolicyArn: policy.arn })), IsTruncated: page.truncated, Marker: page.marker }; }
  async PutGroupPolicy(input: any): Promise<any> { if (!NAME.test(input.PolicyName ?? "")) throw new AwsError("ValidationError", "Invalid policy name", 400); const group = this.group(input.GroupName); const document = validatePolicyDocument(input.PolicyDocument); const aggregate = Object.entries(group.inlinePolicies).filter(([name]) => name !== input.PolicyName).reduce((total, [, value]) => total + Buffer.byteLength(JSON.stringify(value)), Buffer.byteLength(JSON.stringify(document))); if (aggregate > 5_120) throw new AwsError("LimitExceeded", "Group inline policies exceed the aggregate maximum size", 409); group.inlinePolicies[input.PolicyName] = document; await this.store.save(); return {}; }
  async GetGroupPolicy(input: any): Promise<any> { const document = this.group(input.GroupName).inlinePolicies[input.PolicyName]; if (!document) throw new AwsError("NoSuchEntity", "Inline policy was not found", 404); return { GroupName: input.GroupName, PolicyName: input.PolicyName, PolicyDocument: encodeDocument(document) }; }
  async ListGroupPolicies(input: any): Promise<any> { const values = Object.keys(this.group(input.GroupName).inlinePolicies).sort(); const page = this.page("ListGroupPolicies", input, values); return { PolicyNames: page.values, IsTruncated: page.truncated, Marker: page.marker }; }
  async DeleteGroupPolicy(input: any): Promise<any> { const group = this.group(input.GroupName); if (!group.inlinePolicies[input.PolicyName]) throw new AwsError("NoSuchEntity", "Inline policy was not found", 404); delete group.inlinePolicies[input.PolicyName]; await this.store.save(); return {}; }

  private targetUserName(input: any, principal?: PrincipalContext): string { const name = input.UserName ?? (principal?.principalType === "user" ? principal.userName : undefined); if (!name) throw new AwsError("ValidationError", "UserName is required for this principal", 400); return name; }
  async CreateAccessKey(input: any, principal?: PrincipalContext): Promise<any> {
    return this.store.withCredentialMutation(this.store.accountId, async () => {
      const user = this.user(this.targetUserName(input, principal)); const keys = Object.values(this.iam.accessKeys).filter(key => key.userName === user.userName); if (keys.length >= 2) throw new AwsError("LimitExceeded", "Cannot exceed quota for AccessKeysPerUser: 2", 409);
      let accessKeyId: string; do { accessKeyId = identifier("AKIA", 16); } while (Object.values(this.store.state.accounts).some(account => account.iam.accessKeys[accessKeyId] || account.iam.sessions[accessKeyId]));
      const secretAccessKey = randomBytes(30).toString("base64url").slice(0, 40); const credentialId = randomUUID(); const key: IamAccessKeyState = { accessKeyId, userName: user.userName, status: "Active", createDate: this.clock.now(), origin: "generated", credentialId };
      if (!this.store.credentialStore) throw new AwsError("ServiceFailure", "The IAM credential store is unavailable", 500);
      await this.store.credentialStore.put({ credentialId, type: "iam-user", accountId: this.store.accountId, ownerId: user.userId, accessKeyId }, { secretAccessKey });
      this.iam.accessKeys[accessKeyId] = key;
      try {
        await this.store.save();
      } catch (error) {
        delete this.iam.accessKeys[accessKeyId];
        await this.store.credentialStore.delete(credentialId).catch(() => undefined);
        throw error;
      }
      return { AccessKey: { ...keyView(key), SecretAccessKey: secretAccessKey } };
    });
  }
  async ListAccessKeys(input: any, principal?: PrincipalContext): Promise<any> { const name = this.targetUserName(input, principal); this.user(name); const values = Object.values(this.iam.accessKeys).filter(key => key.userName === name).sort((a, b) => a.createDate - b.createDate); const page = this.page("ListAccessKeys", input, values); return { AccessKeyMetadata: page.values.map(keyView), IsTruncated: page.truncated, Marker: page.marker }; }
  async UpdateAccessKey(input: any, principal?: PrincipalContext): Promise<any> { return this.store.withAccountMutation(this.store.accountId, async () => { const name = this.targetUserName(input, principal); const key = this.iam.accessKeys[input.AccessKeyId]; if (!key || key.userName !== name) throw new AwsError("NoSuchEntity", "The Access Key with id cannot be found", 404); if (!["Active", "Inactive"].includes(input.Status)) throw new AwsError("ValidationError", "Status must be Active or Inactive", 400); const previous = key.status; key.status = input.Status; try { await this.store.save(); } catch (error) { key.status = previous; throw error; } return {}; }); }
  async DeleteAccessKey(input: any, principal?: PrincipalContext): Promise<any> { return this.store.withCredentialMutation(this.store.accountId, async () => { const name = this.targetUserName(input, principal); const key = this.iam.accessKeys[input.AccessKeyId]; if (!key || key.userName !== name) throw new AwsError("NoSuchEntity", "The Access Key with id cannot be found", 404); const initialization = this.store.state.installation.defaultAdministrators[this.store.accountId]; const previousTombstone = initialization?.deletedConfiguredKeyFingerprint; delete this.iam.accessKeys[key.accessKeyId]; if (initialization?.configuredAccessKeyId === key.accessKeyId) initialization.deletedConfiguredKeyFingerprint = initialization.configurationFingerprint; try { await this.store.save(); } catch (error) { this.iam.accessKeys[key.accessKeyId] = key; if (initialization) initialization.deletedConfiguredKeyFingerprint = previousTombstone; throw error; } await this.store.credentialStore?.delete(key.credentialId); return {}; }); }
  async GetAccessKeyLastUsed(input: any): Promise<any> { const key = this.iam.accessKeys[input.AccessKeyId]; if (!key) throw new AwsError("NoSuchEntity", "The Access Key with id cannot be found", 404); return { UserName: key.userName, AccessKeyLastUsed: key.lastUsed ? { LastUsedDate: new Date(key.lastUsed.date), ServiceName: key.lastUsed.serviceName, Region: key.lastUsed.region } : { ServiceName: "N/A", Region: "N/A" } }; }
}
