import type { IamPolicyState, IamState, PolicyDocument } from "../types.js";
import { canonicalPolicyDocument } from "./policy-storage.js";

const managed: Array<{ name: string; path: string; id: string; document: PolicyDocument }> = [
  { name: "AWSLambdaBasicExecutionRole", path: "/service-role/", id: "ANPAILAMBDAEXEC0001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] } },
  { name: "AWSLambdaDynamoDBExecutionRole", path: "/service-role/", id: "ANPAILAMBDADDB00001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] } },
  { name: "AWSLambdaSQSQueueExecutionRole", path: "/service-role/", id: "ANPAILAMBDASQS00001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] } },
  { name: "AWSLambdaBasicDurableExecutionRolePolicy", path: "/service-role/", id: "ANPAILAMBDADURABLE1", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "lambda:CheckpointDurableExecution", "lambda:GetDurableExecutionState"], Resource: "*" }] } },
  { name: "AmazonAPIGatewayPushToCloudWatchLogs", path: "/service-role/", id: "ANPAIAPIGATEWAYLOG1", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:PutLogEvents", "logs:GetLogEvents", "logs:FilterLogEvents"], Resource: "*" }] } },
  { name: "AmazonAPIGatewayServiceRolePolicy", path: "/aws-service-role/", id: "ANPAIAPIGATEWAYSLR1", document: { Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["elasticloadbalancing:AddListenerCertificates", "elasticloadbalancing:RemoveListenerCertificates", "elasticloadbalancing:ModifyListener", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeLoadBalancers", "xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingTargets", "xray:GetSamplingRules", "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "servicediscovery:DiscoverInstances"], Resource: "*" },
    { Effect: "Allow", Action: ["firehose:DescribeDeliveryStream", "firehose:PutRecord", "firehose:PutRecordBatch"], Resource: "arn:aws:firehose:*:*:deliverystream/amazon-apigateway-*" },
    { Effect: "Allow", Action: ["acm:DescribeCertificate", "acm:GetCertificate"], Resource: "arn:aws:acm:*:*:certificate/*" },
    { Effect: "Allow", Action: "ec2:CreateNetworkInterfacePermission", Resource: "arn:aws:ec2:*:*:network-interface/*" },
    { Effect: "Allow", Action: "ec2:CreateTags", Resource: "arn:aws:ec2:*:*:network-interface/*", Condition: { "ForAllValues:StringEquals": { "aws:TagKeys": ["Owner", "VpcLinkId"] } } },
    { Effect: "Allow", Action: ["ec2:ModifyNetworkInterfaceAttribute", "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterfacePermission", "ec2:DescribeNetworkInterfaces", "ec2:DescribeAvailabilityZones", "ec2:DescribeNetworkInterfaceAttribute", "ec2:DescribeVpcs", "ec2:DescribeNetworkInterfacePermissions", "ec2:UnassignPrivateIpAddresses", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "ec2:DescribeSecurityGroups"], Resource: "*" },
    { Effect: "Allow", Action: "servicediscovery:GetNamespace", Resource: "arn:aws:servicediscovery:*:*:namespace/*" },
    { Effect: "Allow", Action: "servicediscovery:GetService", Resource: "arn:aws:servicediscovery:*:*:service/*" },
  ] } },
  { name: "AmazonDynamoDBFullAccess", path: "/", id: "ANPAIDDBFULLACCESS01", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:*", Resource: "*" }] } },
  { name: "AdministratorAccess", path: "/", id: "ANPAIADMINACCESS001", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] } },
];
const MANAGED_POLICY_V1_DATE = Date.UTC(2026, 6, 14);

export function createIamState(now = Date.now(), accountId = "000000000000"): IamState {
  const policies: Record<string, IamPolicyState> = {};
  for (const item of managed) {
    const arn = `arn:aws:iam::aws:policy${item.path === "/" ? "" : item.path.slice(0, -1)}${item.path === "/" ? "/" : "/"}${item.name}`.replace("policy//", "policy/");
    const document = structuredClone(item.document);
    policies[arn] = { policyName: item.name, policyId: item.id, arn, path: item.path, createDate: now, updateDate: now, tags: {}, versions: { v1: { versionId: "v1", document, canonicalDocument: canonicalPolicyDocument(document), createDate: MANAGED_POLICY_V1_DATE, isDefaultVersion: true } }, defaultVersionId: "v1", awsManaged: true };
  }
  const administratorArn = "arn:aws:iam::aws:policy/AdministratorAccess";
  const testTrust: PolicyDocument = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  return { users: {}, groups: {}, accessKeys: {}, roles: { test: { roleName: "test", roleId: "AROALOCALTESTROLE001", arn: `arn:aws:iam::${accountId}:role/test`, path: "/", createDate: now, description: "Pre-created compatibility role for local Lambda examples", maxSessionDuration: 3600, assumeRolePolicyDocument: testTrust, assumeRolePolicyCanonical: canonicalPolicyDocument(testTrust), tags: { "stacksim:managed": "true" }, attachedPolicyArns: [administratorArn], inlinePolicies: {}, inlinePolicyCanonicalDocuments: {} } }, policies, sessions: {}, authorizationDecisions: [] };
}

export function normalizeIamState(value: any, now = Date.now(), accountId = "000000000000"): IamState {
  const seeded = createIamState(now, accountId);
  const validDate = (candidate: unknown, fallback: number) => typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
  const policies = { ...(value?.policies ?? {}) };
  for (const [arn, seed] of Object.entries(seeded.policies)) {
    const persisted = value?.policies?.[arn];
    const versions = structuredClone(seed.versions);
    for (const [versionId, version] of Object.entries(versions)) { version.createDate = validDate(persisted?.versions?.[versionId]?.createDate, version.createDate); version.canonicalDocument = canonicalPolicyDocument(version.document); }
    policies[arn] = {
      ...structuredClone(seed),
      createDate: validDate(persisted?.createDate, seed.createDate),
      updateDate: validDate(persisted?.updateDate, seed.updateDate),
      versions,
    };
  }
  const sessions = Object.fromEntries(Object.entries(value?.sessions ?? {}).map(([accessKeyId, raw]) => {
    const session = raw as any;
    return [accessKeyId, { ...session, ...(session.sessionPolicy ? { sessionPolicyCanonical: canonicalPolicyDocument(session.sessionPolicy) } : {}), sessionTags: session.sessionTags ?? {}, transitiveTagKeys: Array.isArray(session.transitiveTagKeys) ? session.transitiveTagKeys.map(String) : [] }];
  }));
  const normalizeEntity = (entity: any, trust = false) => ({ ...entity, ...(trust ? { assumeRolePolicyCanonical: canonicalPolicyDocument(entity.assumeRolePolicyDocument) } : {}), inlinePolicyCanonicalDocuments: Object.fromEntries(Object.entries(entity.inlinePolicies ?? {}).map(([name, document]) => [name, canonicalPolicyDocument(document as PolicyDocument)])) });
  const customerPolicies = Object.fromEntries(Object.entries(policies).map(([arn, rawPolicy]) => { const policy = rawPolicy as IamPolicyState; return [arn, { ...policy, versions: Object.fromEntries(Object.entries(policy.versions).map(([versionId, rawVersion]) => { const version = rawVersion as IamPolicyState["versions"][string]; return [versionId, { ...version, canonicalDocument: canonicalPolicyDocument(version.document) }]; })) }]; }));
  return {
    users: Object.fromEntries(Object.entries(value?.users ?? {}).map(([name, entity]) => [name, normalizeEntity(entity)])),
    groups: Object.fromEntries(Object.entries(value?.groups ?? {}).map(([name, entity]) => [name, normalizeEntity(entity)])),
    accessKeys: value?.accessKeys ?? {},
    roles: Object.fromEntries(Object.entries({ ...seeded.roles, ...(value?.roles ?? {}) }).map(([name, entity]) => [name, normalizeEntity(entity, true)])),
    policies: customerPolicies,
    sessions,
    authorizationDecisions: value?.authorizationDecisions ?? [],
  };
}
