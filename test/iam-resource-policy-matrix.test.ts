import assert from "node:assert/strict";
import test from "node:test";
import { combineIdentityAndResourceAuthorization, evaluateResourcePolicy, type AuthorizationResult } from "../src/iam/evaluator.js";

const allow = (principal: string) => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow" as const, Principal: { AWS: principal }, Action: "s3:GetObject", Resource: "*" }] });
const principal = {
  principalArn: "arn:aws:sts::123456789012:assumed-role/build/deploy/ci-run",
  roleArn: "arn:aws:iam::123456789012:role/build/deploy",
};

test("resource policies classify the principal that supplied an Allow", () => {
  assert.equal(evaluateResourcePolicy(allow(principal.principalArn), principal, "s3:GetObject", "arn:aws:s3:::bucket/key").grantBasis, "directSession");
  assert.equal(evaluateResourcePolicy(allow(principal.roleArn), principal, "s3:GetObject", "arn:aws:s3:::bucket/key").grantBasis, "role");
  assert.equal(evaluateResourcePolicy(allow("arn:aws:iam::123456789012:root"), principal, "s3:GetObject", "arn:aws:s3:::bucket/key").grantBasis, "account");
  assert.equal(evaluateResourcePolicy(allow("123456789012"), principal, "s3:GetObject", "arn:aws:s3:::bucket/key").grantBasis, "account");
  assert.equal(evaluateResourcePolicy(allow("*"), principal, "s3:GetObject", "arn:aws:s3:::bucket/key").grantBasis, "wildcard");
  const user = { principalArn: "arn:aws:iam::123456789012:user/alice" };
  assert.equal(evaluateResourcePolicy(allow(user.principalArn), user, "s3:GetObject", "arn:aws:s3:::bucket/key").grantBasis, "directUser");
});

test("same-account composition applies the principal-aware session and boundary matrix", () => {
  const limitedRole: AuthorizationResult = {
    decision: "implicitDeny",
    reason: "Session policy: No applicable Allow statement was found",
    matchedStatements: [],
    layers: {
      identity: { decision: "allowed", matchedStatements: ["role"] },
      session: { decision: "implicitDeny", matchedStatements: [] },
      boundary: { decision: "allowed", matchedStatements: ["boundary"] },
    },
  };
  const resource = (grantBasis: AuthorizationResult["grantBasis"]): AuthorizationResult => ({ decision: "allowed", reason: "resource", matchedStatements: ["resource"], grantBasis });

  assert.equal(combineIdentityAndResourceAuthorization(limitedRole, resource("role"), "sameAccount").decision, "implicitDeny");
  assert.equal(combineIdentityAndResourceAuthorization(limitedRole, resource("directSession"), "sameAccount").decision, "allowed");
  assert.equal(combineIdentityAndResourceAuthorization(limitedRole, resource("account"), "sameAccount").decision, "implicitDeny");
  assert.equal(combineIdentityAndResourceAuthorization(limitedRole, resource("wildcard"), "sameAccount").decision, "implicitDeny");

  const boundedUser: AuthorizationResult = {
    decision: "implicitDeny", reason: "Permissions boundary", matchedStatements: [],
    layers: { identity: { decision: "implicitDeny", matchedStatements: [] }, boundary: { decision: "implicitDeny", matchedStatements: [] } },
  };
  assert.equal(combineIdentityAndResourceAuthorization(boundedUser, resource("directUser"), "sameAccount").decision, "allowed");
  assert.equal(combineIdentityAndResourceAuthorization(boundedUser, resource("account"), "sameAccount").decision, "implicitDeny");
});

test("explicit denies always win and cross-account grants require identity permission", () => {
  const explicit: AuthorizationResult = { decision: "explicitDeny", reason: "deny", matchedStatements: ["deny"] };
  const permitted: AuthorizationResult = { decision: "allowed", reason: "allow", matchedStatements: ["allow"], grantBasis: "directSession" };
  const implicit: AuthorizationResult = { decision: "implicitDeny", reason: "implicit", matchedStatements: [] };
  assert.equal(combineIdentityAndResourceAuthorization(explicit, permitted, "sameAccount").decision, "explicitDeny");
  assert.equal(combineIdentityAndResourceAuthorization(permitted, explicit, "sameAccount").decision, "explicitDeny");
  assert.equal(combineIdentityAndResourceAuthorization(implicit, permitted, "crossAccount").decision, "implicitDeny");
  assert.equal(combineIdentityAndResourceAuthorization(permitted, permitted, "crossAccount").decision, "allowed");
});
