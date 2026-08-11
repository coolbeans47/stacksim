import type { PrincipalContext } from "./sigv4.js";
import type { IamState } from "../types.js";

export type IamAuthorizationResourceKind = "*" | "user" | "group" | "role" | "policy" | "access-key-user";

/**
 * Frozen resource contract for every IAM action implemented by IamService.
 * Keep this explicit: choosing a resource from whichever request field happens
 * to be populated can authorize the wrong entity when an operation has more
 * than one named input (for example AttachRolePolicy or AddUserToGroup).
 */
export const IAM_AUTHORIZATION_RESOURCE_MAP = Object.freeze({
  CreateRole: "role",
  GetRole: "role",
  ListRoles: "*",
  ListInstanceProfilesForRole: "role",
  UpdateRole: "role",
  UpdateAssumeRolePolicy: "role",
  DeleteRole: "role",
  TagRole: "role",
  UntagRole: "role",
  ListRoleTags: "role",

  CreatePolicy: "policy",
  GetPolicy: "policy",
  ListPolicies: "*",
  DeletePolicy: "policy",
  CreatePolicyVersion: "policy",
  GetPolicyVersion: "policy",
  ListPolicyVersions: "policy",
  SetDefaultPolicyVersion: "policy",
  DeletePolicyVersion: "policy",
  ListEntitiesForPolicy: "policy",
  TagPolicy: "policy",
  UntagPolicy: "policy",
  ListPolicyTags: "policy",

  AttachRolePolicy: "role",
  DetachRolePolicy: "role",
  ListAttachedRolePolicies: "role",
  PutRolePolicy: "role",
  GetRolePolicy: "role",
  ListRolePolicies: "role",
  DeleteRolePolicy: "role",

  CreateUser: "user",
  GetUser: "user",
  ListUsers: "*",
  UpdateUser: "user",
  DeleteUser: "user",
  TagUser: "user",
  UntagUser: "user",
  ListUserTags: "user",
  AttachUserPolicy: "user",
  DetachUserPolicy: "user",
  ListAttachedUserPolicies: "user",
  PutUserPolicy: "user",
  GetUserPolicy: "user",
  ListUserPolicies: "user",
  DeleteUserPolicy: "user",

  CreateGroup: "group",
  GetGroup: "group",
  ListGroups: "*",
  UpdateGroup: "group",
  DeleteGroup: "group",
  AddUserToGroup: "group",
  RemoveUserFromGroup: "group",
  ListGroupsForUser: "user",
  AttachGroupPolicy: "group",
  DetachGroupPolicy: "group",
  ListAttachedGroupPolicies: "group",
  PutGroupPolicy: "group",
  GetGroupPolicy: "group",
  ListGroupPolicies: "group",
  DeleteGroupPolicy: "group",

  CreateAccessKey: "access-key-user",
  ListAccessKeys: "access-key-user",
  UpdateAccessKey: "access-key-user",
  DeleteAccessKey: "access-key-user",
  GetAccessKeyLastUsed: "access-key-user",
} satisfies Record<string, IamAuthorizationResourceKind>);

export interface IamAuthorizationResolution {
  resource: string;
  context: Record<string, unknown>;
}

function requestedPath(value: unknown): string {
  return typeof value === "string" && value ? value : "/";
}

function requestedArn(accountId: string, kind: "user" | "group" | "role" | "policy", name: unknown, path: unknown = "/"): string {
  const resourcePath = requestedPath(path);
  return `arn:aws:iam::${accountId}:${kind}${resourcePath}${String(name ?? "*")}`.replace(`${kind}//`, `${kind}/`);
}

function userName(operation: string, input: any, principal: PrincipalContext, iam?: IamState): string | undefined {
  if (typeof input.UserName === "string" && input.UserName) return input.UserName;
  if (typeof input.AccessKeyId === "string" && input.AccessKeyId) return iam?.accessKeys[input.AccessKeyId]?.userName;
  if (operation === "GetAccessKeyLastUsed") return undefined;
  return principal.principalType === "user" ? principal.userName : undefined;
}

/** Resolve the primary IAM authorization resource without performing service validation. */
export function resolveIamAuthorizationTarget(
  operation: string,
  input: any,
  accountId: string,
  principal: PrincipalContext,
  iam?: IamState,
): IamAuthorizationResolution {
  const kind = IAM_AUTHORIZATION_RESOURCE_MAP[operation as keyof typeof IAM_AUTHORIZATION_RESOURCE_MAP];
  const context: Record<string, unknown> = {};
  if (typeof input.PolicyArn === "string" && new Set([
    "AttachRolePolicy", "DetachRolePolicy", "AttachUserPolicy", "DetachUserPolicy", "AttachGroupPolicy", "DetachGroupPolicy",
  ]).has(operation)) context["iam:PolicyARN"] = input.PolicyArn;

  if (!kind || kind === "*") return { resource: "*", context };
  if (kind === "policy") {
    if (operation === "CreatePolicy") return { resource: requestedArn(accountId, "policy", input.PolicyName, input.Path), context };
    return { resource: typeof input.PolicyArn === "string" && input.PolicyArn ? input.PolicyArn : requestedArn(accountId, "policy", input.PolicyName), context };
  }
  if (kind === "role") {
    if (operation === "CreateRole") return { resource: requestedArn(accountId, "role", input.RoleName, input.Path), context };
    const role = typeof input.RoleName === "string" ? iam?.roles[input.RoleName] : undefined;
    return { resource: role?.arn ?? requestedArn(accountId, "role", input.RoleName), context };
  }
  if (kind === "group") {
    if (operation === "CreateGroup") return { resource: requestedArn(accountId, "group", input.GroupName, input.Path), context };
    const group = typeof input.GroupName === "string" ? iam?.groups[input.GroupName] : undefined;
    return { resource: group?.arn ?? requestedArn(accountId, "group", input.GroupName), context };
  }

  const name = userName(operation, input, principal, iam);
  if (operation === "CreateUser") return { resource: requestedArn(accountId, "user", input.UserName, input.Path), context };
  const user = name ? iam?.users[name] : undefined;
  return { resource: user?.arn ?? requestedArn(accountId, "user", name), context };
}
