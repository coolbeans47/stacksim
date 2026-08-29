# Building AWS-first CDK applications that can run on StackSim

This guide explains how to build a normal AWS CDK v2 application that remains
safe and deployable on AWS, while offering an explicit local mode for temporary
testing with StackSim.

The examples use TypeScript, but the design applies to every CDK language:

1. keep AWS behavior as the default;
2. send CDK and AWS SDK control-plane traffic to StackSim through standard AWS
   configuration;
3. add one explicit application-level local-mode switch only where deployed
   URLs, browser behavior, or HTTP transport differ; and
4. test both synthesized profiles so local compatibility cannot silently weaken
   the AWS deployment.

StackSim implements a deliberately bounded set of AWS services, CloudFormation
resource types, properties, and generated CDK helper profiles. It is useful for
fast local development and integration testing, but it is not a substitute for
testing important workloads in AWS. Check the current
[StackSim support reference](reference.md)
before selecting constructs or upgrading CDK.

## 1. The two layers of local enablement

There are two separate concerns. Many projects need only the first one.

### Layer 1: point AWS tools at StackSim

The AWS CLI, CDK CLI, and supported AWS SDKs understand the standard
`AWS_ENDPOINT_URL` setting. Pointing it at StackSim redirects deployment and
control-plane calls without changing the CDK application.

This is often sufficient for backend-only applications whose callers use the
AWS SDK or the StackSim console.

### Layer 2: adapt values consumed by the deployed application

`AWS_ENDPOINT_URL` exists in the terminal running CDK. It does not rewrite:

- an AWS-shaped API Gateway URL emitted into CloudFormation outputs;
- URLs placed in a browser application's runtime configuration;
- browser CORS origins;
- a browser Cognito SDK client's endpoint;
- an S3 bucket policy that denies plain HTTP; or
- an HTTPS-only runtime URL validator.

A browser-facing application therefore usually needs one explicit local-mode
switch threaded through its CDK composition root. That switch selects a
coherent set of local URLs and narrowly omits policies that are incompatible
with StackSim's loopback HTTP endpoints.

The switch must default to off. Do not infer it from account ID
`000000000000`, placeholder credentials, or the presence of
`AWS_ENDPOINT_URL`; an accidental environment variable must never weaken an AWS
template.

## 2. Target behavior at a glance

| Concern                           | AWS default                               | Explicit StackSim local mode                                     |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| CDK and SDK control plane         | Normal AWS endpoints                      | `http://127.0.0.1:4566`                                          |
| API Gateway invocation            | Regional HTTPS URL                        | `http://127.0.0.1:4567/{apiId}/{stage}/{path}`                   |
| Direct S3 REST application origin | Regional HTTPS hostname                   | `http://{bucket}.localhost:4566`                                 |
| Browser Cognito SDK               | Regional AWS endpoint                     | `http://127.0.0.1:4566/_stacksim/cognito-idp/{region}/sdk`       |
| S3 secure-transport policy        | Enabled                                   | Omitted only where local HTTP access is required                 |
| CORS                              | Exact AWS web origin                      | Exact local web origin                                           |
| CDK bootstrap                     | Bootstrap each AWS account and Region     | Do not run `cdk bootstrap`; StackSim manages a reduced bootstrap |
| Data                              | Governed according to the AWS environment | Synthetic local data only                                        |

StackSim's port `4566` is for control-plane requests, S3, the console, and CDK
assets. Port `4567` is the default invocation data plane for deployed API
Gateway APIs. Sending API invocations to `4566` is a common mistake.

If a tutorial tells you to run `cdk bootstrap`, read
[the bootstrap explanation](#5-understand-cdk-bootstrap-before-following-a-tutorial)
before continuing. The command is required in many real AWS environments but
must be skipped for StackSim.

## 3. Start with an ordinary AWS CDK project

Create and design the project as an AWS application:

```bash
mkdir my-cdk-app
cd my-cdk-app
npx cdk init app --language typescript
```

Use ordinary AWS CDK v2 constructs, official AWS SDKs, least-privilege IAM,
encryption, explicit environment configuration, and normal removal policies.
Pin CDK dependencies and commit the lockfile because different CDK versions can
synthesize different resources, properties, and helper graphs.

Before attempting a local deployment:

1. build the project;
2. synthesize its CloudFormation templates;
3. inspect every generated resource type, property, bucket policy, and custom
   resource; and
4. compare them with StackSim's current supported surface.

Support is determined by the synthesized template, not merely by the L2
construct name. An L2 construct can add generated policies, custom resources,
log-retention helpers, or properties that have a narrower StackSim profile.
StackSim intentionally rejects unsupported shapes instead of pretending they
were deployed.

Keep simulator-specific decisions at the application boundary. Lambda business
logic should normally continue to use ordinary clients such as:

```ts
const dynamodb = new DynamoDBClient({});
```

Do not hard-code a StackSim endpoint into production Lambda code. The deployed
runtime and AWS SDK environment should resolve service access for the selected
target.

## 4. Configure the StackSim terminal

Run StackSim in one terminal and the CDK project in another. The project
terminal can use either environment variables or a dedicated AWS profile. A
dedicated profile is safest for developers who also use real AWS.

### Environment-variable configuration

For Bash or Zsh:

```bash
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=eu-west-1
```

For PowerShell:

```powershell
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
$env:AWS_REGION = "eu-west-1"
$env:AWS_DEFAULT_REGION = "eu-west-1"
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:CDK_DEFAULT_ACCOUNT = "000000000000"
$env:CDK_DEFAULT_REGION = "eu-west-1"
```

The `admin` and `password` values are StackSim's local credentials. They are not
example credentials for AWS and must not be committed or reused outside the
local simulator.

If the application already requires stage-specific account and Region
variables, continue using them. For example:

```bash
export MYAPP_DEV_ACCOUNT_ID=000000000000
export MYAPP_DEV_REGION=eu-west-1
```

`CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` are unnecessary when the CDK app
always supplies its `env` from those project-specific values, but setting them
is harmless and helps tools or auxiliary stacks that use the standard CDK
variables.

Verify an environment-variable setup with:

```bash
aws sts get-caller-identity
```

The response should identify local account `000000000000`, not a real AWS
account.

### Dedicated profile configuration

Create a named profile once:

```bash
aws configure set aws_access_key_id admin --profile stacksim
aws configure set aws_secret_access_key password --profile stacksim
aws configure set region eu-west-1 --profile stacksim
aws configure set endpoint_url http://127.0.0.1:4566 --profile stacksim
```

Then pass `--profile stacksim` to AWS CLI and CDK commands. Do not combine a
profile with stale credential or endpoint environment variables: environment
variables take precedence. Use `aws configure list --profile stacksim` when the
resolved target is unclear.

Verify the simulator before deploying:

```bash
aws sts get-caller-identity --profile stacksim
```

The response should identify local account `000000000000`, not a real AWS
account.

## 5. Understand CDK bootstrap before following a tutorial

Many CDK tutorials include this command shortly before the first deployment:

```bash
npx cdk bootstrap
```

Run that command for a real AWS environment when required. Skip it when the
target is StackSim.

That difference makes more sense once the role of bootstrap is clear.

### What `cdk bootstrap` does in AWS

A CDK application often needs supporting infrastructure before it can deploy
the application's own stacks. `cdk bootstrap` deploys that shared supporting
infrastructure into one AWS account and Region. With the modern default CDK
synthesizer, it is normally represented by a CloudFormation stack named
`CDKToolkit`.

The modern AWS bootstrap environment normally includes:

- an S3 bucket used to stage file assets, such as bundled Lambda ZIP files,
  local directories used by `s3-deployment`, and large CloudFormation
  templates;
- an ECR repository used to stage container image assets;
- a file-publishing role and an image-publishing role;
- a deployment role used by the CDK CLI;
- a CloudFormation execution role used while CloudFormation creates or updates
  application resources;
- a lookup role used for supported environment lookups; and
- an SSM parameter that records the bootstrap template version expected by the
  CDK CLI and synthesized template.

These are deployment tools, not the application's business resources. For
example, a Lambda function and DynamoDB table belong to the application's
stack; the bucket temporarily holding the Lambda ZIP belongs to the bootstrap
environment.

The normal deployment sequence is approximately:

1. `cdk synth` creates a cloud assembly containing CloudFormation templates,
   asset manifests, and metadata.
2. `cdk deploy` reads the assembly and checks that the target environment has a
   sufficiently recent bootstrap version.
3. The CLI publishes file assets to the bootstrap S3 bucket and image assets to
   the bootstrap ECR repository, using the publishing roles.
4. The CLI submits the resolved template through the deployment role.
5. CloudFormation assumes its execution role and creates or updates the
   application's resources.

This explains why `cdk synth` can succeed while the first AWS deployment later
reports a missing or outdated bootstrap environment: synthesis is primarily a
local operation, whereas asset publication and deployment need the account's
supporting infrastructure.

### Bootstrap scope and lifecycle in AWS

Bootstrap is normally performed once for each target account and Region, not
once per application stack:

```bash
npx cdk bootstrap aws://123456789012/eu-west-1 --profile my-aws-profile
```

Several CDK applications can share that environment. Destroying an application
stack does not normally delete `CDKToolkit`, because other stacks may still use
its roles and asset stores. Organizations can customize bootstrap qualifiers,
permissions, trust relationships, execution policies, and boundaries, so use
the organization's approved bootstrap process rather than copying an
unreviewed tutorial command into a production account.

Re-run or upgrade bootstrap in AWS when the CDK CLI or synthesized application
requires a newer bootstrap contract. Review bootstrap changes carefully: the
stack creates IAM roles and shared deployment infrastructure with meaningful
permissions.

### What StackSim supplies automatically

StackSim automatically and idempotently creates a reduced bootstrap environment
for its configured account and Region. It uses the standard default qualifier
`hnb659fds`, allowing an ordinary CDK v2 application using the default
synthesizer to find the expected names without a wrapper or custom root flag.
Here, "idempotently" means StackSim can check and reconcile the environment
again on startup without creating a second set of bootstrap resources.

The reduced environment contains:

- an S3 file-asset bucket;
- file-publishing, deployment, lookup, image-publishing, and CloudFormation
  execution roles with bounded local policies; and
- the standard `/cdk-bootstrap/hnb659fds/version` SSM parameter.

StackSim advertises bootstrap compatibility version `23`, including the
deployment permissions required by its supported rollback flows. The
image-publishing role exists so the expected role topology is coherent, but its
policy denies ECR publication because CDK container image assets are not part
of the reduced local contract.

StackSim manages these resources directly as simulator-owned installation
state. It does not create a hidden `CDKToolkit` CloudFormation stack. The file
bucket and roles persist across StackSim restarts and application-stack
deletion. Unreferenced file assets are reclaimed according to StackSim's local
asset-retention setting; resetting the StackSim data directory resets the
bootstrap environment along with the rest of the simulator.

### Why you must not bootstrap StackSim yourself

Running `cdk bootstrap` against `AWS_ENDPOINT_URL=http://127.0.0.1:4566` is both
unnecessary and the wrong way to fix a local deployment problem:

1. StackSim has already created the file bucket, roles, names, and version
   marker that its supported CDK deployment path needs.
2. The full AWS bootstrap template includes broader infrastructure, notably ECR
   image-asset support, that StackSim deliberately does not implement.
3. A user-deployed bootstrap template could conflict with simulator-owned
   resources or fail on unsupported resource and policy shapes.
4. A successful custom bootstrap would not expand StackSim's service or
   CloudFormation support. Unsupported constructs remain unsupported.

When adapting a tutorial, translate this:

```bash
npx cdk bootstrap
npx cdk deploy
```

into this for StackSim:

```bash
# StackSim supplies its reduced bootstrap automatically; skip cdk bootstrap.
npx cdk deploy --require-approval never
```

Continue to run the tutorial's install, build, test, `cdk synth`, `cdk diff`,
and deployment steps unless another documented StackSim compatibility boundary
requires a change.

### What the reduced bootstrap does not promise

Automatic bootstrap support does not mean every CDK asset or synthesizer is
supported. In particular:

- ECR and Docker image assets are not supported by the reduced bootstrap;
- the complete upstream AWS bootstrap template is not supported;
- custom bootstrap qualifiers, custom bootstrap stacks, and arbitrary custom
  synthesizer contracts should not be assumed to work; and
- generated CDK helpers remain limited to the profiles documented by StackSim.

Prefer the ordinary CDK `DefaultStackSynthesizer`, file-based Lambda assets,
and the currently documented construct profiles for local tests. Keep the
production architecture intact when a feature cannot be exercised locally;
test that feature in AWS instead of weakening or redesigning it globally.

### Verify or troubleshoot the automatic bootstrap

You normally do not need to inspect the bootstrap. If CDK reports a missing
bootstrap version, first confirm that the StackSim server was not started with
automatic bootstrap disabled. `STACKSIM_CDK_BOOTSTRAP=false` is intended for
negative and custom-bootstrap tests, not ordinary application development.

Stop StackSim, remove that override, and restart the same local environment:

```bash
unset STACKSIM_CDK_BOOTSTRAP
npm start
```

PowerShell:

```powershell
Remove-Item Env:STACKSIM_CDK_BOOTSTRAP -ErrorAction SilentlyContinue
npm start
```

With the project terminal still pointing at StackSim, the compatibility marker
can be inspected with:

```bash
aws ssm get-parameter \
  --name /cdk-bootstrap/hnb659fds/version \
  --query 'Parameter.Value' \
  --output text
```

The expected value for the current reduced contract is `23`. The StackSim
console's CloudFormation environment view also shows the bootstrap owner,
qualifier, version, file bucket, roles, and asset usage.

If the marker is still unavailable, verify `AWS_ENDPOINT_URL`, credentials,
account, Region, and StackSim health. Restart or repair the local simulator
rather than deploying the AWS bootstrap template.

### Bootstrap again when the target is real AWS

Skipping bootstrap is a StackSim-only instruction. When the same project is
pointed back at AWS:

1. remove `AWS_ENDPOINT_URL` and all local credentials;
2. select and verify the intended real AWS account and Region;
3. use the organization's approved bootstrap process for that account and
   Region if it has not been bootstrapped, or upgrade it if CDK requires a newer
   version;
4. review the resulting IAM and shared-infrastructure changes; and
5. continue with `cdk diff` and `cdk deploy` using local mode off.

The application remains AWS-compatible because only the target's deployment
support differs: AWS receives its normal `CDKToolkit` environment, while
StackSim supplies the bounded equivalent it knows how to simulate.

## 6. Add one fail-safe application target

Use a project-specific name such as `MYAPP_STACKSIM_LOCAL_MODE`. Parse it
strictly, default it to `false`, and reject unexpected values. The following is
a reusable configuration module:

```ts
export type DeploymentTarget =
  | {
      readonly account: string;
      readonly region: string;
      readonly stackSim: false;
    }
  | {
      readonly account: string;
      readonly region: string;
      readonly stackSim: true;
      readonly controlPlaneUrl: string;
      readonly apiGatewayInvokeUrl: string;
      readonly browserCognitoIdpUrl: string;
    };

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveDeploymentTarget(
  stage: string,
  environment: Environment = process.env,
): DeploymentTarget {
  const stackSim = optionalBoolean("MYAPP_STACKSIM_LOCAL_MODE", environment);

  if (stackSim && stage === "prod") {
    throw new Error("StackSim local mode is not permitted for prod");
  }

  const account = required(
    environment.MYAPP_ACCOUNT_ID ?? environment.CDK_DEFAULT_ACCOUNT,
    "MYAPP_ACCOUNT_ID or CDK_DEFAULT_ACCOUNT",
  );
  const region = required(
    environment.MYAPP_REGION ?? environment.CDK_DEFAULT_REGION,
    "MYAPP_REGION or CDK_DEFAULT_REGION",
  );

  if (!stackSim) return { account, region, stackSim };

  const controlPlaneUrl = "http://127.0.0.1:4566";
  return {
    account,
    region,
    stackSim,
    controlPlaneUrl,
    apiGatewayInvokeUrl: "http://127.0.0.1:4567",
    browserCognitoIdpUrl:
      `${controlPlaneUrl}/_stacksim/cognito-idp/` +
      `${encodeURIComponent(region)}/sdk`,
  };
}

function optionalBoolean(name: string, environment: Environment): boolean {
  const value = environment[name]?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function required(value: string | undefined, description: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${description} is required`);
  return normalized;
}
```

If StackSim is deliberately configured on non-default ports, make the two local
base URLs explicit project settings and validate them as loopback HTTP URLs.
Do not accept arbitrary remote HTTP endpoints under a switch that removes
transport protections.

Resolve the target once in the CDK entry point and pass it into the affected
stacks:

```ts
const target = resolveDeploymentTarget(stage);
const env = { account: target.account, region: target.region };

const data = new DataStack(app, `Data-${stage}`, {
  env,
  stage,
  enforceSsl: !target.stackSim,
});

new ApplicationStack(app, `Application-${stage}`, {
  env,
  stage,
  target,
  dataTable: data.table,
});
```

One coordinated target is easier to reason about than independent flags for
S3, API Gateway, Cognito, and CORS.

## 7. Adapt S3 transport without changing access control

CDK's `enforceSSL: true` adds a bucket-policy statement denying requests whose
`aws:SecureTransport` value is false. This is appropriate for AWS. It also
truthfully denies StackSim's local HTTP S3 traffic.

Make only that behavior conditional:

```ts
interface FilesBucketProps {
  readonly enforceSsl?: boolean;
}

const filesBucket = new s3.Bucket(this, "FilesBucket", {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: props.enforceSsl ?? true,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  versioned: true,
});
```

For a deliberately public test frontend:

```ts
const webBucket = new s3.Bucket(this, "WebBucket", {
  blockPublicAccess: new s3.BlockPublicAccess({
    blockPublicAcls: true,
    ignorePublicAcls: true,
    blockPublicPolicy: false,
    restrictPublicBuckets: false,
  }),
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: !props.target.stackSim,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
});

webBucket.addToResourcePolicy(
  new iam.PolicyStatement({
    sid: "AllowPublicReadOfWebAssets",
    effect: iam.Effect.ALLOW,
    principals: [new iam.AnyPrincipal()],
    actions: ["s3:GetObject"],
    resources: [webBucket.arnForObjects("*")],
  }),
);
```

Disabling `enforceSSL` does not make a bucket public. Conversely, making a web
bucket public must never make a private document bucket public. Keep public
access, IAM, object ownership, encryption, versioning, and lifecycle behavior
independent from the transport-policy toggle.

Do not delete or broadly rewrite bucket policies just to make synthesis pass.
StackSim admits specific generated policy profiles. If a policy fails with an
"exact supported generated profile" message, inspect the synthesized policy,
identify the one local incompatibility, and keep the AWS policy unchanged when
local mode is off.

## 8. Emit browser-usable S3 URLs

For direct S3 REST object delivery, the normal AWS origin is regional HTTPS. A
StackSim-compatible local origin can use virtual-hosted addressing:

```ts
const webOrigin = props.target.stackSim
  ? `http://${webBucket.bucketName}.localhost:4566`
  : `https://${webBucket.bucketRegionalDomainName}`;

const webUrl = `${webOrigin}/index.html`;
```

The virtual-hosted local form is useful for SPAs whose HTML requests absolute
paths such as `/assets/app.js` or `/runtime-config.json`: those requests remain
under the bucket's host. With a path-style entry URL such as
`http://127.0.0.1:4566/{bucket}/index.html`, an absolute `/assets/...` request
would lose the bucket path.

Always output the complete application entry point instead of asking users to
construct it:

```ts
new CfnOutput(this, "WebOrigin", { value: webOrigin });
new CfnOutput(this, "WebUrl", { value: webUrl });
```

If the AWS design genuinely uses S3 static website hosting, CDK's
`bucket.bucketWebsiteUrl` can resolve to StackSim's bounded local website route:

```text
http://127.0.0.1:4566/_stacksim/s3-website/{bucket}/
```

Do not redesign a secure AWS HTTPS origin as an S3 website merely to avoid a
local conditional. Keep the AWS hosting design and select the equivalent local
URL at the boundary.

## 9. Emit a usable API Gateway URL

Some CDK API outputs remain intentionally AWS-shaped when deployed to StackSim.
Use the API ID and stage name to construct an application-owned local output:

```ts
const apiStageName = "v1-live";

const api = new apigateway.RestApi(this, "RestApi", {
  deployOptions: { stageName: apiStageName },
});

const apiBaseUrl = props.target.stackSim
  ? `${props.target.apiGatewayInvokeUrl}/${api.restApiId}/${apiStageName}/v1`
  : api.urlForPath("/v1");

new CfnOutput(this, "ApiBaseUrl", { value: apiBaseUrl });
```

Use this custom `ApiBaseUrl` in local smoke tests and browser runtime
configuration. Do not use the automatically generated
`RestApiEndpoint...` output locally, and do not invoke an API through port
`4566`.

Apply the same principle to HTTP APIs, WebSocket APIs, Lambda function URLs,
CloudFront viewers, and other resources whose canonical AWS hostname is useful
as descriptive control-plane data but cannot route on the local machine. Check
the current StackSim endpoint table for the correct data-plane form.

## 10. Generate target-specific browser runtime configuration

Build the frontend once, then publish non-secret target values at deployment
time. Do not bake AWS or StackSim endpoints into the JavaScript bundle.

For an S3 deployment, a generated file can look like:

```ts
new s3deploy.BucketDeployment(this, "DeployWeb", {
  destinationBucket: webBucket,
  sources: [
    s3deploy.Source.asset(webDistPath, {
      exclude: ["runtime-config.json"],
    }),
    s3deploy.Source.jsonData("runtime-config.json", {
      target: props.target.stackSim ? "stacksim" : "aws",
      stage: props.stage,
      region: this.region,
      apiBaseUrl,
      ...(props.target.browserCognitoIdpUrl
        ? { cognitoIdpUrl: props.target.browserCognitoIdpUrl }
        : {}),
    }),
  ],
  prune: true,
});
```

Runtime configuration may contain public identifiers and URLs. It must never
contain credentials, client secrets, tokens, private table names, or private
application data.

Validate configuration before the application starts. Permit HTTP only for an
explicit StackSim target and only for loopback or `.localhost` endpoints. For
example:

```ts
function validateServiceUrl(value: string, target: "aws" | "stacksim") {
  const url = new URL(value);

  if (target === "aws" && url.protocol !== "https:") {
    throw new Error("AWS service URLs must use HTTPS");
  }

  const localHost =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost");

  if (target === "stacksim" && (url.protocol !== "http:" || !localHost)) {
    throw new Error("StackSim service URLs must use loopback HTTP");
  }
}
```

This is safer than changing an HTTPS-only schema into an unrestricted URL
schema.

## 11. Configure browser Cognito separately

Browser JavaScript does not inherit `AWS_ENDPOINT_URL` from the shell. Pass the
regional StackSim Cognito SDK alias to the browser client only in local mode:

```ts
const cognito = new CognitoIdentityProviderClient({
  region: runtimeConfig.region,
  ...(runtimeConfig.cognitoIdpUrl
    ? { endpoint: runtimeConfig.cognitoIdpUrl }
    : {}),
});
```

The default alias is:

```text
http://127.0.0.1:4566/_stacksim/cognito-idp/{region}/sdk
```

### Add the exact web origin to StackSim's Cognito CORS allowlist

StackSim permits exact loopback browser origins by default. It does not treat
`*.localhost` as equivalent to `localhost`. If the application origin is:

```text
http://my-generated-bucket.localhost:4566
```

start or restart the StackSim server with that exact origin in its JSON
allowlist.

`STACKSIM_COGNITO_SDK_CORS_ORIGINS` configures the StackSim server. Set it in
the terminal that starts StackSim, not in the CDK deployment terminal and not
in the browser's `runtime-config.json`. Each entry must be an origin containing
only scheme, hostname, and port—do not append `/index.html`, a route, a trailing
path, or a URL fragment.

Bash or Zsh, in the terminal that starts StackSim:

```bash
export STACKSIM_COGNITO_SDK_CORS_ORIGINS='["http://my-generated-bucket.localhost:4566"]'
npm start
```

PowerShell:

```powershell
$env:STACKSIM_COGNITO_SDK_CORS_ORIGINS = '["http://my-generated-bucket.localhost:4566"]'
npm start
```

When CDK generates the bucket name, use this two-step setup:

1. deploy once and copy the custom `WebOrigin` output;
2. stop StackSim without deleting its data directory;
3. set `STACKSIM_COGNITO_SDK_CORS_ORIGINS` to a JSON array containing that
   exact output;
4. restart StackSim; and
5. open the emitted `WebUrl`.

Restarting StackSim with the same data directory preserves the deployed stacks
and resources. Changing this server allowlist does not require rebuilding or
redeploying the CDK application.

To allow more than one development frontend, put every exact origin in the
same JSON array:

```bash
export STACKSIM_COGNITO_SDK_CORS_ORIGINS='["http://my-generated-bucket.localhost:4566","http://localhost:5173"]'
```

Alternatively, give only the local profile a deterministic bucket name so the
origin is known before startup. Keep the AWS bucket name generated unless a
stable physical name is an intentional part of the AWS design.

An HTTPS page cannot call StackSim's HTTP Cognito endpoint because browsers
block mixed content. The coherent local profile must therefore select an HTTP
web origin as well as HTTP API and Cognito endpoints. Do not disable browser TLS
or certificate validation globally.

## 12. Keep CORS exact and coordinated

When the selected web origin changes, update every response layer:

- API Gateway preflight `OPTIONS` methods;
- Lambda proxy success and error responses;
- API Gateway-generated authorizer, throttling, validation, and `5xx`
  responses; and
- any browser-accessed service with its own CORS configuration.

Pass the selected origin to Lambda as an environment variable:

```ts
const commonEnvironment = {
  CORS_ORIGINS: webOrigin,
};
```

Then compare the request's `Origin` with the allowlist before returning
`Access-Control-Allow-Origin`. Do not replace exact CORS with `*`, and do not
enable credentialed CORS unless the application's authentication design really
uses cookies. Bearer tokens in the `Authorization` header do not require
credentialed CORS.

## 13. Build, synthesize, and deploy locally

As explained in the bootstrap section, skip any tutorial step that runs
`cdk bootstrap` against StackSim. The simulator has already reconciled the
reduced bootstrap needed for its supported file-asset deployment path.

With StackSim running and the project terminal configured:

```bash
export MYAPP_STACKSIM_LOCAL_MODE=true

npm run build
npx cdk synth -c stage=dev
npx cdk diff -c stage=dev
npx cdk deploy -c stage=dev --require-approval never --outputs-file cdk-outputs.json
```

If the app has several stacks, name them explicitly in dependency order:

```bash
npx cdk deploy Data-dev Identity-dev Application-dev \
  -c stage=dev \
  --require-approval never \
  --outputs-file cdk-outputs.json
```

Using `--require-approval never` is convenient for a local simulator. Retain
normal security-change review for AWS and for controlled deployment pipelines.

Build browser assets before synthesis or deployment whenever CDK packages a
local build directory. Otherwise a successful infrastructure deployment can
publish a stale or missing application.

Use the application-owned local outputs for smoke tests:

- open `WebUrl`, including its `/index.html` object key when required;
- call `ApiBaseUrl`, which uses port `4567`; and
- use the StackSim console at
  `http://127.0.0.1:4566/_stacksim/console` to inspect resources and events.

## 14. Test both synthesis profiles

The AWS profile is the primary contract. Test it even if daily development uses
StackSim.

At minimum, cover this matrix:

| Assertion                    | AWS profile                       | StackSim profile                |
| ---------------------------- | --------------------------------- | ------------------------------- |
| Local-mode default           | `false`                           | Explicit `true`                 |
| Invalid flag such as `yes`   | Rejected                          | Rejected                        |
| S3 TLS deny                  | Present                           | Absent only on selected buckets |
| Private bucket public access | Blocked                           | Still blocked                   |
| Public web policy            | Narrow anonymous `GetObject` only | Same narrow policy              |
| Web origin                   | Regional HTTPS                    | Virtual-hosted loopback HTTP    |
| API base URL                 | Regional HTTPS                    | Port `4567` local URL           |
| CORS                         | Exact AWS origin                  | Exact local origin              |
| Runtime configuration        | AWS URLs, no endpoint override    | Local API and Cognito URLs      |

CDK assertion tests can synthesize both variants:

```ts
const awsTemplate = Template.fromStack(createStack({ stackSim: false }));
const localTemplate = Template.fromStack(createStack({ stackSim: true }));

expect(JSON.stringify(awsTemplate.toJSON())).toContain("aws:SecureTransport");
expect(JSON.stringify(localTemplate.toJSON())).not.toContain(
  "aws:SecureTransport",
);
expect(JSON.stringify(localTemplate.toJSON())).toContain(
  "http://127.0.0.1:4567/",
);
expect(JSON.stringify(localTemplate.toJSON())).toContain(".localhost:4566");
```

Also assert that local mode did not remove encryption, IAM, private Block Public
Access, versioning, deletion protection, or unrelated policy statements. A test
that merely proves the local template deploys is not enough.

Recommended verification sequence:

1. formatting and type checking;
2. focused configuration and CDK assertion tests;
3. a production frontend build;
4. AWS-default synthesis;
5. StackSim-local synthesis; and
6. a local deploy and small end-to-end smoke test.

## 15. Switch safely back to AWS

Use a new terminal or remove every local override before an AWS command.

Bash or Zsh:

```bash
unset MYAPP_STACKSIM_LOCAL_MODE
unset AWS_ENDPOINT_URL
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset CDK_DEFAULT_ACCOUNT
unset CDK_DEFAULT_REGION
```

PowerShell:

```powershell
Remove-Item Env:MYAPP_STACKSIM_LOCAL_MODE -ErrorAction SilentlyContinue
Remove-Item Env:AWS_ENDPOINT_URL -ErrorAction SilentlyContinue
Remove-Item Env:AWS_ACCESS_KEY_ID -ErrorAction SilentlyContinue
Remove-Item Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
Remove-Item Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CDK_DEFAULT_ACCOUNT -ErrorAction SilentlyContinue
Remove-Item Env:CDK_DEFAULT_REGION -ErrorAction SilentlyContinue
```

Then:

1. select the intended real AWS profile;
2. run `aws configure list --profile <aws-profile>`;
3. run `aws sts get-caller-identity --profile <aws-profile>` and verify the
   account;
4. bootstrap that real account and Region if this is its first CDK deployment;
5. rebuild the application;
6. synthesize and review `cdk diff` with local mode off; and
7. deploy with AWS security-change approval enabled.

When switching an existing stack between targets, redeploy every stack affected
by S3 policies, CORS, runtime configuration, or outputs. Do not assume changing
the shell variables updates already deployed resources.

## 16. Troubleshooting

### CloudFormation rejects a resource property

Inspect the synthesized resource and StackSim's current provider schema. An L2
construct may have emitted a property or helper that is not in the supported
profile. Simplify or conditionally omit only the local incompatibility. Do not
remove the AWS feature from the default template merely to make local testing
pass.

### A bucket policy does not form an exact supported profile

CDK may have combined public read, TLS deny, auto-delete, or other generated
statements. Compare the synthesized statements with the supported StackSim
profiles. For local HTTP, disabling only `enforceSSL` is often the correct
adaptation; access-control statements should remain unchanged.

### The stack is in `ROLLBACK_COMPLETE`

Read the local stack events first:

```bash
aws cloudformation describe-stack-events --stack-name <stack-name>
```

After correcting the template, destroy or delete only the known disposable
local stack if CloudFormation requires recreation. Never apply that advice to a
retained or production AWS stack without a reviewed recovery plan.

### The generated API URL does not work

The CDK output is probably AWS-shaped. Use the custom local URL:

```text
http://127.0.0.1:4567/{apiId}/{stage}/{path}
```

### S3 returns `403 AccessDenied`

Check all of the following:

- the URL is a StackSim route rather than an AWS regional hostname;
- the object key, often `/index.html`, is present;
- local mode removed only the TLS-deny statement;
- a public web bucket has its intended `GetObject` allow statement; and
- a private bucket is being accessed with an authorized SDK request or
  presigned URL rather than anonymously.

Removing secure-transport enforcement does not grant object access.

### The page loads but assets or runtime configuration return `404`

An SPA using absolute paths was probably opened through a path-style bucket
URL. Use `http://{bucket}.localhost:4566/index.html`, or deliberately configure
the frontend build for a website subpath.

### Browser API requests fail CORS

Confirm that preflight responses, Lambda responses, and API Gateway-generated
errors all return the exact local `WebOrigin`. Changing only the `OPTIONS`
method is insufficient.

### Browser Cognito requests fail CORS

Confirm the browser client uses the regional StackSim SDK alias and that the
exact web origin is present in `STACKSIM_COGNITO_SDK_CORS_ORIGINS` in the
StackSim server process. A generated `*.localhost` bucket origin is not allowed
by the default `localhost` entry.

This often appears in the application as a generic signup, login, or network
error and can be mistaken for a Cognito or Lambda backend failure. The browser
first sends an `OPTIONS` preflight to the regional Cognito SDK alias. If that
response does not include an `Access-Control-Allow-Origin` header exactly
matching the page origin, the browser blocks the later `POST`. A `204` status by
itself is not sufficient; the CORS headers must also be present.

Test the deployed origin directly by replacing the example origin and Region:

```bash
curl -i -X OPTIONS \
  http://127.0.0.1:4566/_stacksim/cognito-idp/eu-west-1/sdk \
  -H 'Origin: http://my-generated-bucket.localhost:4566' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-amz-target,x-amz-user-agent'
```

A working response contains both:

```text
access-control-allow-origin: http://my-generated-bucket.localhost:4566
access-control-allow-methods: POST, OPTIONS
```

If those headers are absent, add the exact origin to the server variable and
restart StackSim against the same data directory. There is no reason to rebuild
or redeploy the application. Because a rejected preflight prevents the signup
request from being sent, that failed browser attempt does not create a Cognito
user or invoke a pre-signup Lambda.

### The browser reports mixed-content errors

An HTTPS page is calling an HTTP StackSim endpoint. Select the complete local
HTTP profile for the web origin, API, and Cognito together. Do not disable
browser security checks.

### CDK reports missing bootstrap resources

Do not run the full AWS bootstrap template against StackSim. Confirm StackSim is
running, `STACKSIM_CDK_BOOTSTRAP` is not `false`, the project uses the normal
default CDK synthesizer, and `AWS_ENDPOINT_URL=http://127.0.0.1:4566` is visible
to the CDK process. Restart StackSim so it reconciles the reduced bootstrap, then
inspect `/cdk-bootstrap/hnb659fds/version` as described in the bootstrap
section.

### CDK reaches the wrong account

Run `aws configure list` and `aws sts get-caller-identity`. Credential and
endpoint environment variables override profile settings, so remove stale
variables before retrying.

## 17. Practices to avoid

Do not:

- infer local mode from credentials, account ID, or endpoint presence;
- make local mode the default;
- commit local or AWS credentials;
- hard-code StackSim endpoints in production Lambda business logic;
- disable encryption, IAM, Block Public Access, or deletion protection as a
  general compatibility measure;
- replace exact CORS with `*`;
- allow arbitrary remote HTTP URLs under the local profile;
- disable TLS certificate verification globally;
- use the AWS-shaped API output for local invocation;
- run `cdk bootstrap` against StackSim;
- assume every AWS resource or every output of an L2 construct is supported; or
- treat a successful StackSim test as proof of complete AWS compatibility.
