import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaults = {
  AMPLIFY_DISABLE_TELEMETRY: "1",
  AWS_ACCESS_KEY_ID: "admin",
  AWS_SECRET_ACCESS_KEY: "password",
  AWS_REGION: "eu-west-1",
  AWS_DEFAULT_REGION: "eu-west-1",
  AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
  AWS_EC2_METADATA_DISABLED: "true",
  CDK_DEFAULT_ACCOUNT: "000000000000",
  CDK_DEFAULT_REGION: "eu-west-1",
};

const cli = fileURLToPath(
  new URL("../node_modules/@aws-amplify/backend-cli/lib/ampx.js", import.meta.url),
);
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  env: { ...process.env, ...defaults },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Unable to start the Amplify CLI: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
