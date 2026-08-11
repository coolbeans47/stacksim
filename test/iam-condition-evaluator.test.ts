import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRoleAuthorization } from "../src/iam/evaluator.js";
import { createIamState } from "../src/iam/model.js";
import type { PolicyStatement } from "../src/types.js";

const roleArn = "arn:aws:iam::000000000000:role/condition-role";

function decision(statements: PolicyStatement[], context: Record<string, unknown> = {}) {
  const iam = createIamState(1);
  iam.roles.conditionRole = {
    roleName: "conditionRole",
    roleId: "AROACONDITIONROLE01",
    arn: roleArn,
    path: "/",
    createDate: 1,
    maxSessionDuration: 3600,
    assumeRolePolicyDocument: { Statement: [{ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" }] },
    tags: {},
    attachedPolicyArns: [],
    inlinePolicies: { test: { Version: "2012-10-17", Statement: statements } },
  };
  return evaluateRoleAuthorization(iam, roleArn, "s3:GetObject", "arn:aws:s3:::example/key", context).decision;
}

const allow = (operator: string, expected: unknown): PolicyStatement => ({
  Effect: "Allow",
  Action: "s3:GetObject",
  Resource: "*",
  Condition: { [operator]: { "aws:TagKeys": expected } },
});

test("IAMGAP-07 missing condition keys use AWS set, negation, Null, and IfExists semantics", () => {
  assert.equal(decision([allow("ForAllValues:StringEquals", ["team"])]), "allowed");
  assert.equal(decision([allow("ForAnyValue:StringEquals", ["team"])]), "implicitDeny");
  assert.equal(decision([allow("StringEquals", "team")]), "implicitDeny");
  assert.equal(decision([allow("StringNotEquals", "team")]), "allowed");
  assert.equal(decision([allow("Null", "true")]), "allowed");
  assert.equal(decision([allow("Null", "false")]), "implicitDeny");
  assert.equal(decision([allow("StringEqualsIfExists", "team")]), "allowed");
  assert.equal(decision([
    { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
    { Effect: "Deny", Action: "s3:GetObject", Resource: "*", Condition: { StringNotEqualsIfExists: { "aws:TagKeys": "team" } } },
  ]), "explicitDeny");
});

test("IAMGAP-08 BinaryEquals compares strictly decoded Base64 bytes", () => {
  assert.equal(decision([allow("BinaryEquals", "AQI=")], { "aws:TagKeys": Buffer.from([1, 2]) }), "allowed");
  assert.equal(decision([allow("BinaryEquals", "AQI")], { "aws:TagKeys": "AQI=" }), "allowed");
  assert.equal(decision([allow("BinaryEquals", "YQ==")], { "aws:TagKeys": "a" }), "implicitDeny");
  assert.equal(decision([allow("BinaryEquals", "AR==")], { "aws:TagKeys": "AQ==" }), "implicitDeny");
});

test("IAMGAP-09 IpAddress and NotIpAddress support IPv4 and compressed IPv6 CIDRs", () => {
  assert.equal(decision([allow("IpAddress", "2001:db8::/64")], { "aws:TagKeys": "2001:db8::1234" }), "allowed");
  assert.equal(decision([allow("IpAddress", "2001:db8::/64")], { "aws:TagKeys": "2001:db9::1" }), "implicitDeny");
  assert.equal(decision([allow("NotIpAddress", "2001:db8::/64")], { "aws:TagKeys": "2001:db9::1" }), "allowed");
  assert.equal(decision([allow("IpAddress", "192.0.2.0/24")], { "aws:TagKeys": "192.0.2.42" }), "allowed");
  assert.equal(decision([allow("IpAddress", "192.0.2.0/24")], { "aws:TagKeys": "2001:db8::1" }), "implicitDeny");
  assert.equal(decision([allow("IpAddress", "2001:db8::/129")], { "aws:TagKeys": "2001:db8::1" }), "implicitDeny");
});
