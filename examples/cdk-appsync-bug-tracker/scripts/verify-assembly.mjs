import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./common.mjs";

const templatePath = join(projectRoot, "cdk.out", "AppSyncBugTrackerStack.template.json");
const template = JSON.parse(await readFile(templatePath, "utf8"));
const resources = Object.entries(template.Resources || {});
const counts = resources.reduce((result, [, resource]) => {
  result[resource.Type] = (result[resource.Type] || 0) + 1;
  return result;
}, {});
const expected = {
  "AWS::AppSync::GraphQLApi": 1,
  "AWS::AppSync::GraphQLSchema": 1,
  "AWS::AppSync::ApiKey": 1,
  "AWS::AppSync::DataSource": 2,
  "AWS::AppSync::Resolver": 9,
  "AWS::DynamoDB::Table": 2,
  "AWS::IAM::Role": 2,
  "AWS::S3::Bucket": 1,
};
for (const [type, minimum] of Object.entries(expected)) {
  if ((counts[type] || 0) < minimum) throw new Error(`Expected at least ${minimum} ${type} resources; found ${counts[type] || 0}.`);
}

const forbiddenProperties = new Set([
  "LogConfig", "AdditionalAuthenticationProviders", "UserPoolConfig", "OpenIDConnectConfig",
  "LambdaAuthorizerConfig", "EnhancedMetricsConfig", "MergedApiExecutionRoleArn",
  "Runtime", "Code", "PipelineConfig", "CachingConfig", "SyncConfig",
]);
for (const [logicalId, resource] of resources.filter(([, value]) => value.Type.startsWith("AWS::AppSync::"))) {
  const found = Object.keys(resource.Properties || {}).filter(key => forbiddenProperties.has(key));
  if (found.length) throw new Error(`${logicalId} contains unsupported AppSync properties: ${found.join(", ")}`);
}

const ticket = resources.find(([, resource]) => resource.Type === "AWS::DynamoDB::Table" && (resource.Properties?.GlobalSecondaryIndexes?.length || 0) === 2)?.[1];
const indexNames = (ticket?.Properties?.GlobalSecondaryIndexes || []).map(index => index.IndexName).sort();
if (JSON.stringify(indexNames) !== JSON.stringify(["by-assignee", "by-status"])) throw new Error(`BugTickets GSI inventory drifted: ${indexNames.join(", ")}`);

const inventory = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
console.log(`[bug-tracker] verified ${resources.length} synthesized resources and the bounded AppSync contract`);
for (const [type, count] of inventory) console.log(`  ${String(count).padStart(2)}  ${type}`);
