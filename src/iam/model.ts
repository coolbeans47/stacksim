import type { IamPolicyState, IamState, PolicyDocument } from "../types.js";

const managed: Array<{ name: string; path: string; id: string; document: PolicyDocument }> = [
  { name: "AWSLambdaBasicExecutionRole", path: "/service-role/", id: "ANPAILAMBDAEXEC0001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] } },
  { name: "AWSLambdaDynamoDBExecutionRole", path: "/service-role/", id: "ANPAILAMBDADDB00001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] } },
  { name: "AWSLambdaSQSQueueExecutionRole", path: "/service-role/", id: "ANPAILAMBDASQS00001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] } },
  { name: "AWSLambdaBasicDurableExecutionRolePolicy", path: "/service-role/", id: "ANPAILAMBDADURABLE1", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "lambda:CheckpointDurableExecution", "lambda:GetDurableExecutionState"], Resource: "*" }] } },
  { name: "AmazonAPIGatewayPushToCloudWatchLogs", path: "/service-role/", id: "ANPAIAPIGATEWAYLOG1", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:PutLogEvents", "logs:GetLogEvents", "logs:FilterLogEvents"], Resource: "*" }] } },
  { name: "AmazonDynamoDBFullAccess", path: "/", id: "ANPAIDDBFULLACCESS01", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:*", Resource: "*" }] } },
  { name: "AdministratorAccess", path: "/", id: "ANPAIADMINACCESS001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] } },
];

export function createIamState(now = Date.now(), accountId = "000000000000"): IamState {
  const policies: Record<string, IamPolicyState> = {};
  for (const item of managed) {
    const arn = `arn:aws:iam::aws:policy${item.path === "/" ? "" : item.path.slice(0, -1)}${item.path === "/" ? "/" : "/"}${item.name}`.replace("policy//", "policy/");
    policies[arn] = { policyName: item.name, policyId: item.id, arn, path: item.path, createDate: now, updateDate: now, tags: {}, versions: { v1: { versionId: "v1", document: item.document, createDate: now, isDefaultVersion: true } }, defaultVersionId: "v1", awsManaged: true };
  }
  const administratorArn = "arn:aws:iam::aws:policy/AdministratorAccess";
  return { users: {}, groups: {}, accessKeys: {}, roles: { test: { roleName: "test", roleId: "AROALOCALTESTROLE001", arn: `arn:aws:iam::${accountId}:role/test`, path: "/", createDate: now, description: "Pre-created compatibility role for local Lambda examples", maxSessionDuration: 3600, assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, tags: { "stacksim:managed": "true" }, attachedPolicyArns: [administratorArn], inlinePolicies: {} } }, policies, sessions: {}, authorizationDecisions: [] };
}

export function normalizeIamState(value: any, now = Date.now(), accountId = "000000000000"): IamState {
  const seeded = createIamState(now, accountId);
  return {
    users: value?.users ?? {},
    groups: value?.groups ?? {},
    accessKeys: value?.accessKeys ?? {},
    roles: { ...seeded.roles, ...(value?.roles ?? {}) },
    policies: { ...seeded.policies, ...(value?.policies ?? {}) },
    sessions: value?.sessions ?? {},
    authorizationDecisions: value?.authorizationDecisions ?? [],
  };
}
