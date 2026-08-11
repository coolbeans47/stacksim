import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyDocument, PolicyStatement } from "../src/types.js";
import {
  evaluateSqsQueuePolicy,
  normalizeSqsQueuePolicy,
  parseSqsQueuePolicy,
  removeSqsPermission,
  SQS_POLICY_ACTIONS,
  SqsPolicyValidationError,
  sqsAuthorizationAction,
  upsertSqsPermission,
} from "../src/sqs/policy.js";

const queueArn = "arn:aws:sqs:eu-west-1:111122223333:orders";

function statement(overrides: Partial<PolicyStatement> = {}): PolicyStatement {
  return { Effect: "Allow", Principal: "*", Action: "sqs:SendMessage", Resource: queueArn, ...overrides };
}

function document(statements: PolicyStatement | PolicyStatement[]): PolicyDocument {
  return { Version: "2012-10-17", Statement: statements };
}

function expectPolicyError(callback: () => unknown, kind: "validation" | "limit" = "validation"): void {
  assert.throws(callback, error => error instanceof SqsPolicyValidationError && error.kind === kind);
}

test("queue policies parse, canonicalize, and use the empty attribute value for removal", () => {
  assert.equal(parseSqsQueuePolicy(""), undefined);
  const input = JSON.stringify({
    Statement: { Resource: queueArn, Action: "sqs:SendMessage", Principal: { Service: "events.amazonaws.com", AWS: "111122223333" }, Effect: "Allow", Sid: "Publisher" },
    Version: "2012-10-17",
  }, null, 2);
  const parsed = parseSqsQueuePolicy(input)!;
  assert.equal(parsed.normalized, `{"Version":"2012-10-17","Statement":[{"Sid":"Publisher","Effect":"Allow","Principal":{"AWS":"111122223333","Service":"events.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"${queueArn}"}]}`);
  assert.deepEqual(normalizeSqsQueuePolicy(parsed.document), parsed);
  expectPolicyError(() => parseSqsQueuePolicy(" "));
  expectPolicyError(() => parseSqsQueuePolicy("{"));
  expectPolicyError(() => parseSqsQueuePolicy(42));
});

test("policy grammar validates versions, effects, mutually exclusive elements, and known fields", () => {
  for (const value of [
    [],
    { Version: "2015-01-01", Statement: statement() },
    { Version: "2012-10-17", Statement: [] },
    document({ ...statement(), Effect: "Permit" as "Allow" }),
    document({ ...statement(), NotAction: "sqs:ReceiveMessage" }),
    document({ ...statement(), Resource: undefined, NotResource: undefined }),
    document({ ...statement(), Principal: undefined, NotPrincipal: undefined }),
    document({ ...statement(), Unknown: true } as PolicyStatement),
    { ...document(statement()), Unknown: true },
  ]) expectPolicyError(() => normalizeSqsQueuePolicy(value as PolicyDocument));
  expectPolicyError(() => normalizeSqsQueuePolicy(document([statement({ Sid: "same" }), statement({ Sid: "same", Action: "sqs:ReceiveMessage" })])));
});

test("principal validation accepts account, root, IAM, STS, and service principals but rejects ambiguous forms", () => {
  const principals: PolicyStatement["Principal"][] = [
    "111122223333",
    "arn:aws:iam::111122223333:root",
    { AWS: ["arn:aws:iam::111122223333:user/Alice", "arn:aws-us-gov:iam::111122223333:role/team/Publisher", "arn:aws:sts::111122223333:assumed-role/Publisher/session"] },
    { Service: ["s3.amazonaws.com", "logs.eu-west-1.amazonaws.com"] },
    "*",
  ];
  for (const Principal of principals) assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Principal }))));
  for (const Principal of [
    { Federated: "accounts.google.com" },
    { AWS: "not-an-account" },
    { Service: "events.example.com" },
    [],
    {},
  ]) expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Principal: Principal as PolicyStatement["Principal"] }))));
});

test("only meaningful SQS actions and queue resources are accepted", () => {
  for (const Action of ["*", "sqs:*", "sqs:Send*", "SQS:ReceiveMessage", ...SQS_POLICY_ACTIONS.map(action => `sqs:${action}`)]) {
    assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Action }))));
  }
  for (const Action of ["s3:GetObject", "sqs:NotARealAction", "sqs:SendMessageBatch", "SendMessage"]) {
    expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Action }))));
  }
  for (const Resource of ["arn:aws-cn:sqs:cn-north-1:111122223333:orders", "arn:aws:sqs:*:111122223333:orders-*", "*"]) {
    assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Resource }))));
  }
  for (const Resource of ["arn:aws:s3:::orders", "arn:aws:sqs:eu-west-1:bad:orders", "https://sqs.eu-west-1.amazonaws.com/111122223333/orders"]) {
    expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Resource }))));
  }
});

test("an attached policy statement must be capable of applying to its exact queue", () => {
  const otherQueue = "arn:aws:sqs:eu-west-1:111122223333:other";
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Resource: "arn:aws:sqs:eu-west-1:111122223333:ord*" })), { queueArn }));
  expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Resource: otherQueue })), { queueArn }));
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Resource: undefined, NotResource: otherQueue })), { queueArn }));
  expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Resource: undefined, NotResource: queueArn })), { queueArn }));
});

test("current policy quotas are enforced at their boundaries", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => statement({ Sid: `s${index}` }));
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(twenty)));
  expectPolicyError(() => normalizeSqsQueuePolicy(document([...twenty, statement({ Sid: "s20" })])), "limit");
  const accounts = Array.from({ length: 50 }, (_, index) => String(100_000_000_000 + index));
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Principal: { AWS: accounts } }))));
  expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Principal: { AWS: [...accounts, "200000000000"] } }))), "limit");
  const sevenActions = SQS_POLICY_ACTIONS.slice(0, 7).map(action => `sqs:${action}`);
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Action: sevenActions }))));
  expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Action: [...sevenActions, `sqs:${SQS_POLICY_ACTIONS[7]}`] }))), "limit");
  const tenConditions = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`aws:PrincipalTag/key${index}`, `value${index}`]));
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Condition: { StringEquals: tenConditions } }))));
  expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Condition: { StringEquals: { ...tenConditions, "aws:PrincipalTag/key10": "value10" } } }))), "limit");
  expectPolicyError(() => parseSqsQueuePolicy(JSON.stringify({ Version: "2012-10-17", Id: "x".repeat(8_192), Statement: statement() })), "limit");
});

test("condition validation rejects unsupported operators, keys, and value forms", () => {
  assert.doesNotThrow(() => normalizeSqsQueuePolicy(document(statement({ Condition: {
    ArnLike: { "aws:SourceArn": "arn:aws:s3:::orders-*" },
    StringEquals: { "aws:SourceAccount": "111122223333" },
    Bool: { "aws:SecureTransport": "true" },
  } }))));
  for (const Condition of [
    { MadeUpEquals: { "aws:SourceAccount": "111122223333" } },
    { StringEquals: { "sqs:Unknown": "value" } },
    { StringEquals: { "aws:SourceAccount": { nested: true } } },
    { "ForAllValues:Null": { "aws:SourceAccount": "true" } },
    { ArnLike: { "aws:SourceArn": "not-an-arn" } },
    { IpAddress: { "aws:SourceIp": "10.0.0.0/99" } },
  ]) expectPolicyError(() => normalizeSqsQueuePolicy(document(statement({ Condition: Condition as unknown as PolicyStatement["Condition"] }))));
});

test("labeled permissions are generated, replaced, and removed without disturbing other statements", () => {
  const base = document(statement({ Sid: "Existing", Action: "sqs:ReceiveMessage" }));
  const added = upsertSqsPermission(base, { queueArn, label: "publisher-1", accountIds: ["444455556666", "444455556666"], actions: ["SendMessage"] });
  assert.equal((added.document.Statement as PolicyStatement[]).length, 2);
  assert.deepEqual((added.document.Statement as PolicyStatement[])[1], { Sid: "publisher-1", Effect: "Allow", Principal: { AWS: "444455556666" }, Action: "sqs:SendMessage", Resource: queueArn });
  const replaced = upsertSqsPermission(added.normalized, { queueArn, label: "publisher-1", accountIds: ["777788889999"], actions: ["ReceiveMessage", "GetQueueAttributes"] });
  assert.equal((replaced.document.Statement as PolicyStatement[]).length, 2);
  assert.deepEqual((replaced.document.Statement as PolicyStatement[])[1].Action, ["sqs:ReceiveMessage", "sqs:GetQueueAttributes"]);
  assert.equal(removeSqsPermission(replaced.normalized, "missing")?.normalized, replaced.normalized);
  const remaining = removeSqsPermission(replaced.normalized, "publisher-1")!;
  assert.deepEqual((remaining.document.Statement as PolicyStatement[]).map(item => item.Sid), ["Existing"]);
  assert.equal(removeSqsPermission(upsertSqsPermission(undefined, { queueArn, label: "only", accountIds: ["111122223333"], actions: ["*"] }).normalized, "only"), undefined);
  expectPolicyError(() => upsertSqsPermission(undefined, { queueArn, label: "bad label", accountIds: ["111122223333"], actions: ["SendMessage"] }));
  expectPolicyError(() => upsertSqsPermission(undefined, { queueArn, label: "batch", accountIds: ["111122223333"], actions: ["SendMessageBatch"] }));
});

test("AWS principals match accounts, roots, IAM, STS, and service conditions honor exact source context", () => {
  const roleArn = "arn:aws-us-gov:iam::444455556666:role/team/Publisher";
  const rolePolicy = document([
    statement({ Sid: "Account", Principal: { AWS: "444455556666" }, Action: "sqs:GetQueueAttributes" }),
    statement({ Sid: "Root", Principal: { AWS: "arn:aws-us-gov:iam::444455556666:root" }, Action: "sqs:ReceiveMessage" }),
    statement({ Sid: "Role", Principal: { AWS: roleArn }, Action: "sqs:SendMessage" }),
  ]);
  const session = { type: "AWS" as const, arn: "arn:aws-us-gov:sts::444455556666:assumed-role/Publisher/session", accountId: "444455556666" };
  for (const action of ["GetQueueAttributes", "ReceiveMessage", "SendMessage"]) assert.equal(evaluateSqsQueuePolicy(rolePolicy, session, action, queueArn).decision, "allowed");
  assert.equal(evaluateSqsQueuePolicy(rolePolicy, { ...session, accountId: "000000000000", arn: "arn:aws-us-gov:sts::000000000000:assumed-role/Publisher/session" }, "SendMessage", queueArn).decision, "implicitDeny");

  const sourceArn = "arn:aws:s3:::source-bucket";
  const servicePolicy = document([
    statement({ Sid: "AllowS3", Principal: { Service: "s3.amazonaws.com" }, Condition: { ArnLike: { "aws:SourceArn": "arn:aws:s3:::source-*" }, StringEquals: { "aws:SourceAccount": "111122223333" } } }),
    statement({ Sid: "DenyOtherAccounts", Effect: "Deny", Principal: "*", Condition: { StringNotEquals: { "aws:SourceAccount": "111122223333" } } }),
  ]);
  const s3 = { type: "Service" as const, service: "s3.amazonaws.com" };
  assert.equal(evaluateSqsQueuePolicy(servicePolicy, s3, "SendMessage", queueArn, { "aws:SourceArn": sourceArn, "aws:SourceAccount": "111122223333" }).decision, "allowed");
  assert.equal(evaluateSqsQueuePolicy(servicePolicy, s3, "SendMessage", queueArn, { "aws:SourceArn": "arn:aws:s3:::other", "aws:SourceAccount": "111122223333" }).decision, "implicitDeny");
  assert.equal(evaluateSqsQueuePolicy(servicePolicy, s3, "SendMessage", queueArn, { "aws:SourceArn": sourceArn, "aws:SourceAccount": "999900001111" }).decision, "explicitDeny");
  assert.equal(evaluateSqsQueuePolicy(document(statement({ Principal: { AWS: "*" } })), s3, "SendMessage", queueArn).decision, "implicitDeny", "an AWS wildcard is not a simulator-wide service bypass");
});

test("explicit deny wins and batch APIs authorize against their parent actions", () => {
  const principal = { type: "AWS" as const, arn: "arn:aws:iam::111122223333:role/Producer", accountId: "111122223333" };
  const policy = document([statement({ Sid: "AllowSend" }), statement({ Sid: "DenyOneQueue", Effect: "Deny", Resource: queueArn })]);
  const result = evaluateSqsQueuePolicy(policy, principal, "SendMessageBatch", queueArn);
  assert.equal(result.decision, "explicitDeny");
  assert.deepEqual(result.matchedStatements, ["AllowSend", "DenyOneQueue"]);
  assert.equal(sqsAuthorizationAction("DeleteMessageBatch"), "sqs:DeleteMessage");
  assert.equal(sqsAuthorizationAction("sqs:ChangeMessageVisibilityBatch"), "sqs:ChangeMessageVisibility");
});
