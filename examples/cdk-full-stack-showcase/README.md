# Aurora Atlas — full-stack CDK showcase

Aurora Atlas demonstrates several StackSim services working together in a full-stack application provisioned with standard AWS CDK constructs. A responsive React application is published as a real anonymous S3 website. Its REST API stores signals in DynamoDB, then the **Signal Journey** follows each change through a DynamoDB stream, EventBridge, a relay Lambda, an SQS queue with redrive, a worker Lambda, and a second DynamoDB activity table.

The result is a real end-to-end local application rather than a collection of disconnected resources:

```text
Browser
  │
  ├── GET website/assets ──> S3 website + public-read bucket policy
  │
  └── REST/CORS ──────────> API Gateway stage
                                │
                    API key + model/validator + token authorizer
                                │
                                v
                         versioned Lambda alias
                           │               │
                           v               v
                    DynamoDB signals  CloudWatch Logs
                           │
                    DynamoDB stream
                           v
                    publisher Lambda ──> EventBridge bus/rule
                                              │
                                         relay Lambda
                                              │
                                  SQS queue ──┴──> redrive DLQ
                                      │
                                 worker Lambda
                                      │
                                      v
                              DynamoDB journey activity
```

The public demo key and token are intentionally embedded in the local browser build. They demonstrate API Gateway behavior; they are not production authentication or secrets.

The REST API does not enable API Gateway access or execution logging, so it
sets `cloudWatchRole: false`. This keeps the stack from owning the regional
`AWS::ApiGateway::Account` CloudWatch-role singleton, allowing all examples to
be deployed in any order. CloudWatch log groups for the application Lambdas
remain part of the stack.

## Three-stack architecture

| Stack | Responsibility | Important outputs |
| --- | --- | --- |
| `AuroraAtlasDataStack` | Signals and journey-activity DynamoDB tables, TTL, `byCategory` GSI, stream, tags | `SignalsTableName`, `SignalsStreamArn`, `JourneyTableName` |
| `AuroraAtlasApiStack` | API Gateway, IAM, Logs, application/authorizer/publisher/relay/worker Lambdas, EventBridge bus/rule, SQS work queue and DLQ | API identity plus journey bus, queue, DLQ, function and log identities |
| `AuroraAtlasWebStack` | Versioned SSE-S3 website bucket, exact public policy and bounded CDK `BucketDeployment` | `WebsiteUrl`, `WebsiteBucketName` |

The stacks are deliberately split because the simulator generates the REST API ID during deployment. The deployment orchestrator creates the data and API stacks first, derives the callable local URL, seeds through the deployed protected API, rebuilds React with that URL, and then deploys only the web stack.

## Project assumptions

- Use the pinned versions in `package.json`: CDK CLI `2.1132.0`, `aws-cdk-lib` `2.261.0`, and `constructs` `10.7.1`. A different CDK release can emit a different deployment-helper graph.
- Do **not** run `cdk bootstrap`. StackSim automatically manages its local file-asset bootstrap contract in the configured Region.
- Atlas uses a small relay Lambda between EventBridge and SQS to keep that part of the event journey explicit.
- The queues use SSE-SQS, Standard delivery, visibility retries, and a source-queue redrive policy. KMS-backed queues and EventBridge target DLQs are not implied.
- The S3 site uses relative asset paths and no history-based router because its URL is path based.
- Browser code receives only the derived API invocation URL and fixed application demo credentials. It never receives IAM access keys or the control-plane endpoint.
- DynamoDB items are runtime data rather than CloudFormation resources. The deployment therefore seeds through the already-deployed, protected `/demo/seed` API instead of coupling demo records to stack lifecycle.

## Install and deploy from a fresh checkout

The S3 bucket and the other showcase resources are deployed simulator state; they are not checked into Git. A fresh checkout therefore starts empty until `npm run deploy` completes.

Prerequisites:

- Git.
- Node.js 22.13 or newer.
- npm.
- Google Chrome only for the optional screenshot workflow. Playwright can instead use its bundled Chromium when installed.

Open two terminals and keep the simulator running in the first while deploying from the second. The Windows environment examples below use PowerShell syntax.

### Terminal 1: install and start StackSim

Clone or download StackSim, then run these commands from the repository root:

```console
npm ci
npm run build
```

Set the simulator environment in this terminal before starting it. These are the tested Aurora Atlas settings, not general requirements for starting stacksim:

| Setting | Why Aurora Atlas uses it |
| --- | --- |
| No extra bootstrap setting | The reduced local CDK bootstrap is automatic, and the default `user/admin` is authorized through `AdministratorAccess`. |

On macOS:

```bash
npm start
```

On Windows:

```powershell
npm start
```

These commands intentionally leave `STACKSIM_DATA_DIR` unset, so StackSim uses its default persistent `.stacksim` directory. After deployment, starting this checkout again with ordinary `npm start` will reopen the same resources.

Set `STACKSIM_CDK_BOOTSTRAP=false` only to reproduce an intentionally unbootstrapped environment; changing it requires restarting stacksim.

To keep Aurora Atlas isolated from other local resources, set the following before **every** `npm start` for this installation:

On macOS:

```bash
export STACKSIM_DATA_DIR=.stacksim/aurora-atlas
```

On Windows:

```powershell
$env:STACKSIM_DATA_DIR = ".stacksim/aurora-atlas"
```

Deploying with one data directory and later starting stacksim with another opens a different simulator installation, so the console will appear to be missing the stacks and S3 bucket. After changing the data directory, deploy again before using `npm run smoke` or `npm run capture` because `.runtime/deployment.json` describes the previous deployment. Do **not** run `cdk bootstrap`; the simulator provides its reduced bootstrap automatically.

### Terminal 2: install and deploy Aurora Atlas

With stacksim still running in Terminal 1:

From the repository root, open the showcase directory and install its dependencies:

```console
cd examples/cdk-full-stack-showcase
npm ci
```

Set the deployment environment in Terminal 2.

On macOS:

```bash
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export STACKSIM_INVOKE_ENDPOINT=http://127.0.0.1:4567
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=eu-west-1
```

On Windows:

```powershell
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
$env:AWS_REGION = "eu-west-1"
$env:AWS_DEFAULT_REGION = "eu-west-1"
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:STACKSIM_INVOKE_ENDPOINT = "http://127.0.0.1:4567"
$env:CDK_DEFAULT_ACCOUNT = "000000000000"
$env:CDK_DEFAULT_REGION = "eu-west-1"
```

Deploy from the same terminal:

```console
npm run deploy
```

These environment settings apply to the current terminal session. Set them again before deploying from a newly opened Terminal 2.

Before deploying, you can inspect `http://127.0.0.1:4566/_stacksim/api/environment` and confirm that `authMode` is `enforce`, `cdkBootstrap.status` is `ready`, `defaultPrincipalArn` ends with `user/admin` (or your initialized user), and `statePath` names the intended data directory.

`npm run deploy` performs the build, synthesis, deployment, demo-data seeding, and smoke test. Its final line prints the deployed website URL. The deployed resources are also visible in the stacksim console at `http://127.0.0.1:4566/_stacksim/console`.

`STACKSIM_INVOKE_ENDPOINT` is optional and defaults to `http://127.0.0.1:4567`. It is kept separate from the SDK/control-plane endpoint because deployed API Gateway requests use the simulator's invocation listener.

## Optional: build and inspect the assembly

```console
npm run build
```

This command builds a placeholder frontend, synthesizes all stacks, and verifies the showcase assembly. For individual steps:

```console
npm run build:frontend
npm run synth
npm run verify:assembly
```

You can also inspect a template-only diff without mutating the simulator:

```console
npx --no-install cdk diff AuroraAtlasDataStack AuroraAtlasApiStack AuroraAtlasWebStack --method template
```

## What `npm run deploy` does

```console
npm run deploy
```

`scripts/deploy.mjs` performs the complete repeatable lifecycle:

1. Checks that the configured endpoint is a healthy CloudFormation-capable StackSim instance.
2. Builds a placeholder static asset and verifies the synthesized assembly.
3. Deploys `AuroraAtlasDataStack` and `AuroraAtlasApiStack` through ordinary CDK change sets.
4. Derives `http://127.0.0.1:4567/{ApiId}/{StageName}` from real outputs.
5. Calls protected `POST /demo/seed` with the fixed local key and token. Twelve deterministic records are inserted or migrated to the current journey envelope; user-created records are preserved on repeat deployment.
6. Rebuilds React with the real API URL and deploys `AuroraAtlasWebStack --exclusively` through the bounded bucket-deployment provider.
7. Writes `.runtime/deployment.json` and runs the deployed smoke test.

The final line prints the real simulator-backed S3 website URL. The deployment command has no teardown path: successful stacks and a partially successful diagnostic deployment are left in place for inspection.

## Verify the deployed application

Run the smoke test again at any time:

```console
npm run smoke
```

It reads `.runtime/deployment.json` and verifies:

- the public website HTML and JavaScript MIME type;
- `GET /signals`, all twelve deterministic demo IDs, and count metadata;
- eventual processing of all twelve seed changes through EventBridge and SQS, including queue-depth metadata;
- protected `GET /system/proof` through both API key and token authorizer;
- the reported service fabric and current Lambda release;
- a real browser-style CORS preflight.

Use the app to create, boost, inspect, archive, and restore signals, then watch their correlated journey. **Inject relay fault** writes a deliberate poison signal: the SQS worker records retry attempts, the queue redrives it after three receives, and the UI exposes the quarantined outcome and DLQ depth. Re-running `npm run deploy` is safe: CDK follows its no-op/update path, the versioned seed migrates deterministic records without deleting user-created records, and `BucketDeployment` prunes stale build assets.

## Capture desktop and mobile screenshots

```console
npm run capture
```

The capture script opens the deployed S3 website from `.runtime/deployment.json`, waits for API-backed signals, checks browser console errors, page errors, failed requests, and document-level horizontal overflow, then writes:

- `screenshots/desktop-1440x900.png`
- `screenshots/mobile-390x844.png`

When handing off results in ChatGPT, attach these PNGs as image artifacts with the image-view tool. Do not provide Windows filesystem links as the only way to see them.

## Growing the showcase

The project is intentionally organized so new services and features can be added without rewriting the app:

1. Add the new CDK resources to the most appropriate stack, or add a fourth focused stack.
2. Connect the backing service through the existing Lambda/API boundary or add a dedicated feature endpoint.
3. Add a topology card and an interactive feature to React.
4. Extend the assembly checks in `scripts/verify-assembly.mjs`.
5. Extend `smoke-test.mjs` with an authoritative service interaction and keep both responsive captures green.
6. Preserve the two-phase runtime-identity pattern whenever a static asset needs a deployment-generated physical ID.

For the final tested showcase, keep StackSim running and keep all three stacks deployed. Do not run the full AWS bootstrap command, and do not run a stack teardown after the final verification or capture.
