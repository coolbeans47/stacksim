# Deploying AWS SAM applications to StackSim

StackSim's CloudFormation expands the `AWS::Serverless-2016-10-31` transform itself, as AWS does server-side. You can deploy SAM templates with the unmodified SAM CLI, the AWS CLI, an SDK, or the console. The supported subset is listed in [SAM coverage](sam-coverage.md). Anything outside it fails the whole deployment with an explicit error, so a template that deploys behaves as written.

## What works

- `AWS::Serverless::Function` with zip packages: `CodeUri` or `InlineCode`, the generated `<Function>Role`, `Policies` (AWS managed policy names, ARNs, inline statements, and the [policy templates](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-policy-templates.html) for services StackSim implements), `Tracing`, `DeadLetterQueue`, and the other properties in the coverage table.
- `Api` events, with the implicit `ServerlessRestApi` (`Prod` stage, plus the `Stage` stage SAM's deployment creates) or an explicit `AWS::Serverless::Api`.
- `HttpApi` events, with the implicit `ServerlessHttpApi` (`$default` stage with auto-deploy) or an explicit `AWS::Serverless::HttpApi`.
- `AWS::Serverless::SimpleTable`.
- `Globals` for `Function`, `Api`, `HttpApi`, and `SimpleTable`.
- SAM references such as `!Ref MyApi.Stage` and `!Ref MyApi.Deployment`.

Event sources such as SQS and S3, function URLs, aliases, layers, state machines, and API authorizers come in later phases. A template that uses them fails with a message that names the owning phase.

## Point the SAM CLI at StackSim

Use SAM CLI 1.91 or later; earlier releases bundle a botocore that ignores `AWS_ENDPOINT_URL`.

```bash
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ACCESS_KEY_ID=admin AWS_SECRET_ACCESS_KEY=password AWS_REGION=eu-west-1
```

In PowerShell:

```powershell
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:AWS_ACCESS_KEY_ID = "admin"; $env:AWS_SECRET_ACCESS_KEY = "password"; $env:AWS_REGION = "eu-west-1"
```

## Create the artifact bucket

Until the SAM CLI's managed bucket is supported (SAM-05), give `sam deploy` a bucket you create yourself. The managed bucket uses SSE-KMS and a TLS-only bucket policy that StackSim cannot satisfy yet, so `--resolve-s3` and the `sam deploy --guided` default fail.

```bash
aws s3 mb s3://sam-artifacts
```

## Deploy the Hello World quick start

```bash
sam init --runtime nodejs22.x --dependency-manager npm --app-template hello-world --name sam-app --no-interactive
cd sam-app
sam build
sam deploy --stack-name hello --s3-bucket sam-artifacts --capabilities CAPABILITY_IAM
```

`--capabilities CAPABILITY_IAM` is required because SAM generates an IAM role for the function. Without it, the deployment fails with `Requires capabilities : [CAPABILITY_IAM]`, as on AWS. In `samconfig.toml`, set `resolve_s3 = false` and `s3_bucket = "sam-artifacts"` to avoid typing the flags.

Only Node.js runtimes (`nodejs18.x` through `nodejs24.x`) run locally, so use the Node.js `sam init` templates.

## Call the API

The quick start's `HelloWorldApi` output is the AWS-shaped URL, `https://<api-id>.execute-api.eu-west-1.amazonaws.com/Prod/hello/`. Locally, call the same API ID on StackSim's invoke port:

```bash
curl http://<api-id>.execute-api.localhost:4567/Prod/hello/
curl http://127.0.0.1:4567/<api-id>/Prod/hello/
```

For an HTTP API, the `$default` stage has no stage segment: `http://<api-id>.execute-api.localhost:4567/hello`.

## Update and delete

Running `sam deploy` again with no changes prints `No changes to deploy`. A code change updates only the function. `sam delete --stack-name hello` removes everything the stack created, including the generated role.

## Inspect the expansion

```bash
aws cloudformation get-template --stack-name hello --template-stage Processed
```

The **Template** tab in the StackSim console has the same **View processed template** toggle as the AWS console.

## Local differences

- REST API deployment logical IDs (`ServerlessRestApiDeployment<hash>`) change exactly when AWS's would, but the hash itself differs: AWS hashes a Python `repr()` of the API definition, and StackSim hashes its canonical JSON.
- `AlwaysDeploy: true` uses StackSim's clock to force a new deployment on each update, so it is the one input that makes an expansion differ between runs.
