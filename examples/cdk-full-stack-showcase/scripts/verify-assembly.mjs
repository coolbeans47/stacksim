import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const requestedAssembly = process.argv[2] || process.env.CDK_OUTDIR || "cdk.out";
const assemblyRoot = isAbsolute(requestedAssembly) ? requestedAssembly : resolve(projectRoot, requestedAssembly);

const expectedTypes = new Set([
  "AWS::ApiGateway::ApiKey",
  "AWS::ApiGateway::Authorizer",
  "AWS::ApiGateway::Deployment",
  "AWS::ApiGateway::GatewayResponse",
  "AWS::ApiGateway::Method",
  "AWS::ApiGateway::Model",
  "AWS::ApiGateway::RequestValidator",
  "AWS::ApiGateway::Resource",
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGateway::Stage",
  "AWS::ApiGateway::UsagePlan",
  "AWS::ApiGateway::UsagePlanKey",
  "AWS::CDK::Metadata",
  "AWS::DynamoDB::Table",
  "AWS::Events::EventBus",
  "AWS::Events::Rule",
  "AWS::IAM::ManagedPolicy",
  "AWS::IAM::Policy",
  "AWS::IAM::Role",
  "AWS::Lambda::Alias",
  "AWS::Lambda::EventSourceMapping",
  "AWS::Lambda::Function",
  "AWS::Lambda::LayerVersion",
  "AWS::Lambda::Permission",
  "AWS::Lambda::Version",
  "AWS::Logs::LogGroup",
  "AWS::S3::Bucket",
  "AWS::S3::BucketPolicy",
  "AWS::SQS::Queue",
  "Custom::CDKBucketDeployment",
]);

const stackNames = ["AuroraAtlasDataStack", "AuroraAtlasApiStack", "AuroraAtlasWebStack"];

async function templateFor(stackName) {
  const path = resolve(assemblyRoot, `${stackName}.template.json`);
  let template;
  try {
    template = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read synthesized template ${path}: ${error.message}`);
  }
  if (!template.Resources || typeof template.Resources !== "object" || Array.isArray(template.Resources)) {
    throw new Error(`${path} does not contain a CloudFormation Resources object`);
  }
  return { path, template };
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function main() {
  const resources = [];
  for (const stackName of stackNames) {
    const { path, template } = await templateFor(stackName);
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const type = resource?.Type;
      if (typeof type !== "string" || !type) throw new Error(`${path} resource ${logicalId} has no Type`);
      resources.push({ stackName, logicalId, type });
    }
  }

  const actualTypes = new Set(resources.map(resource => resource.type));
  const missing = sorted([...expectedTypes].filter(type => !actualTypes.has(type)));
  const unsupported = sorted([...actualTypes].filter(type => !expectedTypes.has(type)));

  if (expectedTypes.size !== 30) throw new Error(`The showcase verifier contract itself drifted to ${expectedTypes.size} resource types`);
  if (missing.length || unsupported.length || actualTypes.size !== expectedTypes.size) {
    const details = [
      `Expected exactly 30 showcase resource types but found ${actualTypes.size}.`,
      missing.length ? `Missing: ${missing.join(", ")}` : undefined,
      unsupported.length ? `Unsupported/unexpected: ${unsupported.join(", ")}` : undefined,
    ].filter(Boolean).join("\n");
    throw new Error(details);
  }

  if (resources.some(resource => resource.type === "AWS::ApiGateway::Account")) {
    throw new Error("Aurora Atlas must not claim the regional API Gateway CloudWatch-role singleton");
  }

  const counts = new Map();
  for (const resource of resources) counts.set(resource.type, (counts.get(resource.type) || 0) + 1);
  console.log(`[aurora-atlas] verified ${resources.length} resources across ${stackNames.length} templates and exactly 30 showcased resource types`);
  for (const type of sorted(actualTypes)) {
    console.log(`  ${String(counts.get(type)).padStart(2, " ")}  ${type}`);
  }
}

main().catch(error => {
  console.error(`[aurora-atlas] assembly verification failed: ${error.message}`);
  process.exitCode = 1;
});
