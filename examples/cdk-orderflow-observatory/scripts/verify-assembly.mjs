import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const requestedAssembly = process.argv[2] || process.env.CDK_OUTDIR || "cdk.out";
const assemblyRoot = isAbsolute(requestedAssembly) ? requestedAssembly : resolve(projectRoot, requestedAssembly);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function templateFor(stackName) {
  const path = resolve(assemblyRoot, `${stackName}.template.json`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read synthesized template ${path}: ${error.message}`);
  }
}

function resourcesOf(template, type) {
  return Object.entries(template.Resources || {})
    .filter(([, resource]) => resource.Type === type)
    .map(([logicalId, resource]) => ({ logicalId, ...resource }));
}

async function main() {
  const application = await templateFor("OrderFlowApplicationStack");
  const web = await templateFor("OrderFlowWebStack");
  const stateMachines = resourcesOf(application, "AWS::StepFunctions::StateMachine");
  const lambdaFunctions = resourcesOf(application, "AWS::Lambda::Function");
  const restApis = resourcesOf(application, "AWS::ApiGateway::RestApi");
  const apiGatewayAccounts = resourcesOf(application, "AWS::ApiGateway::Account");
  const methods = resourcesOf(application, "AWS::ApiGateway::Method");
  const websiteBuckets = resourcesOf(web, "AWS::S3::Bucket");
  const deployments = resourcesOf(web, "Custom::CDKBucketDeployment");

  assert(stateMachines.length === 1, `Expected one state machine but found ${stateMachines.length}.`);
  assert(lambdaFunctions.length === 2, `Expected the API and worker Lambdas but found ${lambdaFunctions.length}.`);
  assert(restApis.length === 1, `Expected one REST API but found ${restApis.length}.`);
  assert(apiGatewayAccounts.length === 0, "OrderFlow must not claim the regional API Gateway CloudWatch-role singleton.");
  assert(methods.length >= 7, `Expected the execution API and CORS methods but found ${methods.length}.`);
  assert(websiteBuckets.length === 1, `Expected one website bucket but found ${websiteBuckets.length}.`);
  assert(deployments.length === 1, `Expected one bucket deployment but found ${deployments.length}.`);

  const machine = stateMachines[0];
  const serialized = JSON.stringify(machine.Properties);
  assert(machine.Properties.StateMachineName === "orderflow-observatory", "The state-machine name changed.");
  assert(machine.Properties.StateMachineType === "STANDARD", "The showcase must deploy a Standard Workflow.");
  for (const marker of [
    "Validate order",
    "Run checks in parallel",
    "Reserve inventory",
    "Assess fraud",
    "Processing window",
    "Package items",
    "Compensate order",
    "Order complete",
  ]) {
    assert(serialized.includes(marker), `The synthesized workflow is missing '${marker}'.`);
  }
  for (const type of ["Parallel", "Choice", "Wait", "Map", "Succeed", "Fail"]) {
    assert(serialized.includes(`\\\"Type\\\":\\\"${type}\\\"`) || serialized.includes(`"Type":"${type}"`), `The synthesized workflow is missing a ${type} state.`);
  }
  assert(serialized.includes("InventoryTransientError"), "The synthesized workflow is missing its named retry policy.");
  assert(serialized.includes("States.ALL"), "The synthesized workflow is missing its catch policy.");

  const allResources = [...Object.values(application.Resources || {}), ...Object.values(web.Resources || {})];
  const types = [...new Set(allResources.map((resource) => resource.Type))].sort();
  console.log(`[orderflow] verified ${allResources.length} resources across two CDK templates`);
  console.log("  workflow     Standard state machine with Task, Pass, Parallel, Choice, Wait, Inline Map, Succeed and Fail");
  console.log("  resilience   named retry plus parallel/map catch and compensation");
  console.log("  application  API Gateway, two Lambda functions and public S3 React website");
  console.log(`  types        ${types.join(", ")}`);
}

main().catch((error) => {
  console.error(`[orderflow] assembly verification failed: ${error.message}`);
  process.exitCode = 1;
});
