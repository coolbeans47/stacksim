import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(example, "../..");
const [action = "deploy", selection = "all"] = process.argv.slice(2);
if (!["install", "deploy", "delete"].includes(action) || !["all", "owner", "iam"].includes(selection)) {
  throw new Error("Use install, deploy or delete, followed by all, owner or iam.");
}
const selected = selection === "all" ? ["owner", "iam"] : [selection];
const endpoint = new URL(process.env.STACKSIM_ENDPOINT || "http://127.0.0.1:4566");
if (!["http:", "https:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
  || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
  throw new Error("STACKSIM_ENDPOINT must be the loopback StackSim control origin.");
}
function child(command, arguments_, options, capture = false) {
  return new Promise((done, fail) => {
    const process_ = spawn(command, arguments_, { ...options, shell: false, windowsHide: true, stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (capture) {
      process_.stdout.on("data", chunk => { process.stdout.write(chunk); output = (output + chunk).slice(-100_000); });
      process_.stderr.on("data", chunk => { process.stderr.write(chunk); output = (output + chunk).slice(-100_000); });
    }
    process_.once("error", fail);
    process_.once("close", code => code === 0 ? done(output) : fail(new Error(`Command exited with status ${code}.`)));
  });
}
const fixture = mode => join(repository, "test", "fixtures", `amplify-gen2-auth-data-${mode}`);
if (action === "install") {
  if (!process.env.npm_execpath) throw new Error("Run npm run backend:install so the current npm CLI is available.");
  for (const mode of selected) await child(process.execPath, [process.env.npm_execpath, "ci", "--no-audit", "--no-fund"], { cwd: fixture(mode), env: process.env });
} else {
  const local = join(example, ".local-cli");
  await mkdir(local, { recursive: true });
  const emptyConfig = join(local, "empty-aws-config");
  await writeFile(emptyConfig, "", { mode: 0o600 });
  const notices = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"notices":[]}');
  });
  await new Promise(done => notices.listen(0, "127.0.0.1", done));
  const noticesPort = notices.address().port;
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (/^AWS_/i.test(key) || /^(?:http|https|all)_proxy$/i.test(key)) delete inherited[key];
  const pathKeys = Object.keys(inherited).filter(key => key.toLowerCase() === "path");
  const inheritedPath = inherited[pathKeys[0]] || "";
  for (const key of pathKeys) delete inherited[key];
  const env = {
    ...inherited,
    PATH: `${dirname(process.execPath)}${delimiter}${inheritedPath}`,
    AWS_ACCESS_KEY_ID: "admin", AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1",
    AWS_ENDPOINT_URL: endpoint.origin, AWS_EC2_METADATA_DISABLED: "true", AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: emptyConfig, AWS_SHARED_CREDENTIALS_FILE: emptyConfig,
    CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: "eu-west-1",
    CDK_DISABLE_CLI_TELEMETRY: "true", CDK_DISABLE_VERSION_CHECK: "true",
    AMPLIFY_DISABLE_TELEMETRY: "1", AMPLIFY_BACKEND_NOTICES_ENDPOINT: `http://127.0.0.1:${noticesPort}/notices.json`,
    APPDATA: join(local, "appdata"), npm_config_update_notifier: "false", npm_config_user_agent: "npm/11.9.0",
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `--require=${JSON.stringify(join(repository, "test", "fixtures", "cdk", "network-tripwire.cjs"))}`,
    STACKSIM_NETWORK_ALLOW_PORT: [endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"), noticesPort].join(","),
  };
  try {
    for (const mode of selected) {
      const directory = fixture(mode);
      const cli = join(directory, "node_modules", "@aws-amplify", "backend-cli", "lib", "ampx.js");
      try { await access(cli); } catch { throw new Error(`Install the pinned backends first: npm run backend:install (${mode} is missing).`); }
      const outputs = join(example, "outputs", mode);
      const args = action === "deploy"
        ? ["sandbox", "--once", "--identifier", "authnotes", "--outputs-out-dir", outputs]
        : ["sandbox", "delete", "--identifier", "authnotes"];
      if (action === "deploy") await mkdir(outputs, { recursive: true });
      console.log(`${action === "deploy" ? "Deploying" : "Deleting"} the ${mode} fixture at ${endpoint.origin}.`);
      const output = await child(process.execPath, [cli, ...args], { cwd: directory, env }, true);
      // This pinned CLI can exit zero after a handled deployment failure.
      // Require its actual output-write evidence before reporting readiness.
      if (action === "deploy") {
        if (!/File written:[^\n]*amplify_outputs\.json/.test(output)) throw new Error(`The ${mode} CLI did not write outputs. Resolve the reported deployment error and retry.`);
        const generated = JSON.parse(await readFile(join(outputs, "amplify_outputs.json"), "utf8"));
        if (!generated.auth?.user_pool_id || !generated.data?.url) throw new Error(`The ${mode} CLI output is incomplete.`);
      } else if (output.includes("[Sandbox] Finished deleting.")) {
        await rm(outputs, { recursive: true, force: true });
      } else if (output.includes("[ERROR]")) {
        throw new Error(`The ${mode} sandbox was not deleted. Its existing outputs were kept.`);
      } else {
        console.log(`Deletion of ${mode} was not confirmed; its outputs were kept.`);
      }
    }
  } finally {
    await new Promise(done => notices.close(done));
  }
}
