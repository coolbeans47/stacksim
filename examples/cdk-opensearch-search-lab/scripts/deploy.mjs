import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  account,
  region,
  controlPlaneEndpoint,
  invokeEndpoint,
  projectRoot,
  runtimeRoot,
  manifestFile,
  requireSimulator,
  run,
  runCdk,
  apiRequest,
} from "./common.mjs";

const applicationFile = join(runtimeRoot, "application-outputs.json");
const webFile = join(runtimeRoot, "web-outputs.json");
const required = (outputs, key) => {
  if (typeof outputs?.[key] !== "string" || !outputs[key])
    throw new Error(`Missing CDK output ${key}.`);
  return outputs[key];
};
try {
  await requireSimulator();
  await mkdir(runtimeRoot, { recursive: true });
  const caResponse = await fetch(`${controlPlaneEndpoint}/_stacksim/ca.pem`, {
    signal: AbortSignal.timeout(5000),
  });
  const ca = await caResponse.text();
  if (!caResponse.ok || !ca.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error("Unable to obtain the StackSim public CA certificate.");
  await writeFile(join(runtimeRoot, "ca.pem"), ca);
  await run("bundle the Lambda and official OpenSearch client", [
    join(projectRoot, "scripts", "build-lambda.mjs"),
  ]);
  await run("build the React asset", [
    join(projectRoot, "frontend", "build.mjs"),
  ]);
  await runCdk("synthesize the two CDK stacks", ["synth", "--quiet"]);
  await run("verify the assembly", [
    join(projectRoot, "scripts", "verify-assembly.mjs"),
  ]);
  await runCdk("deploy OpenSearch and the REST API", [
    "deploy",
    "SearchLabApplicationStack",
    "--exclusively",
    "--require-approval",
    "never",
    "--outputs-file",
    applicationFile,
  ]);
  const application = JSON.parse(
    await readFile(applicationFile, "utf8"),
  ).SearchLabApplicationStack;
  const apiId = required(application, "ApiId"),
    stageName = required(application, "StageName");
  const apiBaseUrl = `${invokeEndpoint}/${encodeURIComponent(apiId)}/${encodeURIComponent(stageName)}`;
  const seeded = await apiRequest({ apiBaseUrl }, "/seed", { method: "POST" });
  console.log(
    `[search-lab] samples: ${seeded.created} added; ${seeded.skipped} existing products preserved`,
  );
  await run(
    "build React with the deployed API identity",
    [join(projectRoot, "frontend", "build.mjs")],
    { STACKSIM_API_BASE_URL: apiBaseUrl },
  );
  await runCdk("deploy the S3 website", [
    "deploy",
    "SearchLabWebStack",
    "--exclusively",
    "--require-approval",
    "never",
    "--outputs-file",
    webFile,
  ]);
  const web = JSON.parse(await readFile(webFile, "utf8")).SearchLabWebStack;
  const manifest = {
    schemaVersion: 1,
    deployedAt: new Date().toISOString(),
    account,
    region,
    controlPlaneEndpoint,
    invokeEndpoint,
    apiId,
    stageName,
    apiBaseUrl,
    domainName: required(application, "DomainName"),
    searchEndpoint: required(application, "SearchEndpoint"),
    apiFunctionName: required(application, "ApiFunctionName"),
    websiteUrl: required(web, "WebsiteUrl"),
    websiteBucketName: required(web, "WebsiteBucketName"),
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await run("smoke test the deployed app", [
    join(projectRoot, "scripts", "smoke.mjs"),
  ]);
  console.log(`\n[search-lab] Open ${manifest.websiteUrl}`);
  console.log(
    `[search-lab] Console: ${controlPlaneEndpoint}/#/opensearch/domains`,
  );
} catch (error) {
  console.error(
    `[search-lab] ${error.stack || error.message}\nCreated stacks remain available for inspection; rerun deploy after fixing the error.`,
  );
  process.exitCode = 1;
}
