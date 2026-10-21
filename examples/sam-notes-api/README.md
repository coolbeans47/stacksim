# AWS SAM notes API

This example is a small [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/) application that deploys to StackSim unchanged:

- an HTTP API with `GET /notes` and `POST /notes` routes;
- a Node.js 22 Lambda function, published as a version behind a `live` alias;
- a DynamoDB table (`AWS::Serverless::SimpleTable`); and
- an execution role whose DynamoDB access comes from the `DynamoDBCrudPolicy` policy template.

`template.yaml` is about 50 lines. StackSim's CloudFormation expands the `AWS::Serverless-2016-10-31` transform into the IAM role, the Lambda function, version, alias, and permissions, the API and its stage, and the table, as AWS does server-side. See the [SAM guide](../../docs/sam-guide.md) for everything StackSim supports.

## Prerequisites

- StackSim running at `http://127.0.0.1:4566`, with its invoke port at `4567`;
- the AWS CLI v2, configured for StackSim as in recipe 2 of the [AWS CLI cookbook](../../docs/aws-cli-cookbook.md#recipe-2-configure-the-default-stacksim-profile); and
- optionally, the AWS SAM CLI 1.91 or later.

The function needs no `npm install`: the AWS SDK for JavaScript v3 is part of the Node.js Lambda runtime.

## Deploy with the AWS CLI

Run these commands from this directory. `package` zips `src/`, uploads it, and writes a template that points `CodeUri` at the upload.

```console
aws s3 mb s3://sam-artifacts
aws cloudformation package --template-file template.yaml --s3-bucket sam-artifacts --output-template-file packaged.yaml
aws cloudformation deploy --template-file packaged.yaml --stack-name notes --capabilities CAPABILITY_IAM
```

`CAPABILITY_IAM` is required because SAM generates an IAM role, as on AWS. `deploy` uses a change set, so it does not need `CAPABILITY_AUTO_EXPAND`.

## Deploy with the SAM CLI

Point the SAM CLI at StackSim first, as the [SAM guide](../../docs/sam-guide.md#point-the-sam-cli-at-stacksim) shows. S3 must use StackSim's HTTPS endpoint, because the SAM CLI's managed bucket denies plain HTTP:

```console
curl -o ~/stacksim-ca.pem http://127.0.0.1:4566/_stacksim/ca.pem
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ENDPOINT_URL_S3=https://127.0.0.1:4569
export AWS_CA_BUNDLE=~/stacksim-ca.pem
```

Then build and deploy. No bucket is needed: the SAM CLI creates its managed stack, `aws-sam-cli-managed-default`, the first time, and uploads the code there.

```console
sam build
sam deploy --guided
```

Name the stack `notes` and answer `Y` to allow IAM role creation. The SAM CLI then asks `NotesFunction has no authentication. Is this okay?` once for each of the two routes; answer `y` both times. Without prompts, run `sam deploy --stack-name notes --resolve-s3 --capabilities CAPABILITY_IAM`. To use your own bucket instead, pass `--s3-bucket sam-artifacts`.

## Try it

Read the local URL from the stack outputs:

```console
aws cloudformation describe-stacks --stack-name notes --query "Stacks[0].Outputs[?OutputKey=='LocalNotesUrl'].OutputValue" --output text
```

Then create and list notes, replacing `API_ID`. The request body is in `note.json`, which avoids shell-specific JSON quoting. On Windows, type `curl.exe` in PowerShell so that the built-in `curl` alias is not used.

```console
curl -X POST -H "content-type: application/json" --data @note.json http://API_ID.execute-api.localhost:4567/notes
curl http://API_ID.execute-api.localhost:4567/notes
```

`POST` returns `201` with the new note, and `GET` returns every note in creation order.

## See what SAM generated

```console
aws cloudformation get-template --stack-name notes --template-stage Processed
```

The processed template lists `NotesFunctionRole`, `NotesFunctionVersion<hash>`, `NotesFunctionAliaslive`, the two route permissions, `ServerlessHttpApi`, its `$default` stage, and `NotesTable`. The StackSim console's **Template** tab has the same **View processed template** toggle as the AWS console.

## Publish a new version

Change the code in `src/app.mjs`, then package and deploy again. The new code hashes to a new `NotesFunctionVersion<hash>` logical ID, so CloudFormation publishes version 2 and moves the `live` alias, which the routes invoke. The old version stays, because SAM sets `DeletionPolicy: Retain` on it:

```console
aws lambda list-versions-by-function --function-name FUNCTION_NAME --query "Versions[].Version"
```

## Clean up

```console
aws cloudformation delete-stack --stack-name notes
aws cloudformation wait stack-delete-complete --stack-name notes
```

Deleting the stack removes the API, the role, the table, and the function with all of its versions. The artifact bucket is yours to keep or remove.

If you deployed with the SAM CLI, `sam delete --stack-name notes` deletes the stack and its artifacts in the managed bucket, and keeps `aws-sam-cli-managed-default` for your next application, as on AWS.
