import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const requestedAssembly = process.argv[2] || process.env.CDK_OUTDIR || "cdk.out";
const assemblyRoot = isAbsolute(requestedAssembly) ? requestedAssembly : resolve(projectRoot, requestedAssembly);
const stackNames = ["SnsRoutingDataStack", "SnsRoutingAppStack", "SnsRoutingWebStack"];

const expectedTypes = new Set([
  "AWS::ApiGateway::Deployment",
  "AWS::ApiGateway::Method",
  "AWS::ApiGateway::Model",
  "AWS::ApiGateway::RequestValidator",
  "AWS::ApiGateway::Resource",
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGateway::Stage",
  "AWS::CDK::Metadata",
  "AWS::DynamoDB::Table",
  "AWS::IAM::Policy",
  "AWS::IAM::Role",
  "AWS::Lambda::EventSourceMapping",
  "AWS::Lambda::Function",
  "AWS::Lambda::LayerVersion",
  "AWS::Lambda::Permission",
  "AWS::Logs::LogGroup",
  "AWS::S3::Bucket",
  "AWS::S3::BucketPolicy",
  "AWS::SNS::Subscription",
  "AWS::SNS::Topic",
  "AWS::SNS::TopicPolicy",
  "AWS::SQS::Queue",
  "AWS::SQS::QueuePolicy",
  "Custom::CDKBucketDeployment",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function templateFor(stackName) {
  const path = resolve(assemblyRoot, `${stackName}.template.json`);
  let template;
  try {
    template = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read synthesized template ${path}: ${error.message}`);
  }
  assert(template.Resources && typeof template.Resources === "object" && !Array.isArray(template.Resources), `${path} has no Resources object`);
  return template;
}

async function main() {
  const resources = [];
  for (const stackName of stackNames) {
    const template = await templateFor(stackName);
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      assert(typeof resource?.Type === "string" && resource.Type, `${stackName}.${logicalId} has no Type`);
      resources.push({ stackName, logicalId, ...resource });
    }
  }

  const actualTypes = new Set(resources.map((resource) => resource.Type));
  const missing = sorted([...expectedTypes].filter((type) => !actualTypes.has(type)));
  const unexpected = sorted([...actualTypes].filter((type) => !expectedTypes.has(type)));
  assert(expectedTypes.size === 24, `Verifier contract drifted to ${expectedTypes.size} resource types`);
  assert(!missing.length && !unexpected.length && actualTypes.size === expectedTypes.size, [
    `Expected exactly 24 resource types but found ${actualTypes.size}.`,
    missing.length ? `Missing: ${missing.join(", ")}` : "",
    unexpected.length ? `Unexpected: ${unexpected.join(", ")}` : "",
  ].filter(Boolean).join("\n"));

  const topics = resources.filter((resource) => resource.Type === "AWS::SNS::Topic");
  const subscriptions = resources.filter((resource) => resource.Type === "AWS::SNS::Subscription");
  const topicPolicies = resources.filter((resource) => resource.Type === "AWS::SNS::TopicPolicy");
  const apiGatewayAccounts = resources.filter((resource) => resource.Type === "AWS::ApiGateway::Account");
  assert(apiGatewayAccounts.length === 0, "Signal Relay must not claim the regional API Gateway CloudWatch-role singleton");
  assert(topics.length === 1, `Expected one SNS topic but found ${topics.length}`);
  assert(subscriptions.length === 4, `Expected four SNS subscriptions but found ${subscriptions.length}`);
  assert(topicPolicies.length === 1, `Expected one SNS topic policy but found ${topicPolicies.length}`);
  assert(topics[0].Properties?.TopicName === "sns-routing-lab-incidents", "Tutorial topic name changed");
  assert(topics[0].Properties?.FifoTopic === undefined, "Tutorial must use a Standard SNS topic");

  const lambdaSubscriptions = subscriptions.filter((resource) => resource.Properties?.Protocol === "lambda");
  const sqsSubscriptions = subscriptions.filter((resource) => resource.Properties?.Protocol === "sqs");
  assert(lambdaSubscriptions.length === 3, `Expected three Lambda subscriptions but found ${lambdaSubscriptions.length}`);
  assert(sqsSubscriptions.length === 1, `Expected one SQS subscription but found ${sqsSubscriptions.length}`);
  assert(sqsSubscriptions[0].Properties?.RawMessageDelivery === true, "Audit subscription must use raw SNS delivery");
  assert(subscriptions.every((resource) => resource.Properties?.RedrivePolicy), "Every SNS subscription must have a redrive policy");

  const filterPolicies = lambdaSubscriptions.map((resource) => resource.Properties?.FilterPolicy);
  assert(filterPolicies.every(Boolean), "Every Lambda subscription must have a filter policy");
  assert(lambdaSubscriptions.some((resource) => resource.Properties?.FilterPolicyScope === "MessageBody"), "Nested message-body filter subscription is missing");
  assert(lambdaSubscriptions.filter((resource) => resource.Properties?.FilterPolicyScope !== "MessageBody").length === 2, "Expected two message-attribute filters");

  const counts = new Map();
  for (const resource of resources) counts.set(resource.Type, (counts.get(resource.Type) || 0) + 1);
  console.log(`[signal-relay] verified ${resources.length} resources across three templates and exactly 24 resource types`);
  console.log("  SNS          1 Standard topic, 4 subscriptions, 1 topic policy");
  console.log("  filters      2 message-attribute policies, 1 nested message-body policy");
  console.log("  delivery     3 Lambda envelopes, 1 raw SQS delivery, redrive on every subscription");
  for (const type of sorted(actualTypes)) console.log(`  ${String(counts.get(type)).padStart(2, " ")}  ${type}`);
}

main().catch((error) => {
  console.error(`[signal-relay] assembly verification failed: ${error.message}`);
  process.exitCode = 1;
});
