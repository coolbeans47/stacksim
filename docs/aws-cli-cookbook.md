# StackSim AWS CLI cookbook

This cookbook shows how to use the standard AWS CLI v2 with StackSim. StackSim implements a bounded learning surface rather than the complete AWS API, so the recipes below deliberately use operations that StackSim supports.

The examples assume that:

- StackSim is running at `http://127.0.0.1:4566`;
- the default local credentials are still `admin` and `password`;
- the Region is `eu-west-1`;
- you configured the default profile in recipe 2; and
- commands are run from a terminal separate from the one running StackSim.

Uppercase values such as `STACK_NAME`, `QUEUE_URL`, and `TOPIC_ARN` are placeholders. Replace them with values returned by the discovery command immediately above them. Commands that create, modify, or delete local resources are labelled accordingly.

JSON examples use quoting accepted by Bash, zsh, and PowerShell. Windows Command Prompt (`cmd.exe`) has different JSON escaping rules; use PowerShell for those recipes.

## Contents

1. [Install the AWS CLI on macOS or Windows](#recipe-1-install-the-aws-cli-on-macos-or-windows)
2. [Configure the default StackSim profile](#recipe-2-configure-the-default-stacksim-profile)
3. [CloudFormation](#cloudformation)
4. [DynamoDB and DynamoDB Streams](#dynamodb-and-dynamodb-streams)
5. [Lambda](#lambda)
6. [Step Functions](#step-functions)
7. [API Gateway](#api-gateway)
8. [AppSync](#appsync)
9. [S3](#s3)
10. [SQS](#sqs)
11. [SNS](#sns)
12. [EventBridge and Scheduler](#eventbridge-and-scheduler)
13. [CloudWatch Logs, metrics, alarms, and dashboards](#cloudwatch-logs-metrics-alarms-and-dashboards)
14. [IAM and STS](#iam-and-sts)
15. [Cognito user pools](#cognito-user-pools)
16. [SES](#ses)
17. [Systems Manager Parameter Store](#systems-manager-parameter-store)
18. [Secrets Manager](#secrets-manager)
19. [RDS](#rds)
20. [Troubleshooting](#troubleshooting)

## Recipe 1: Install the AWS CLI on macOS or Windows

StackSim works with the standard AWS CLI v2. An AWS account is not required for these local recipes.

### macOS

Download and install the current official package for all users:

```bash
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg ./AWSCLIV2.pkg -target /
```

Open a new terminal if necessary, then verify the installation:

```bash
which aws
aws --version
```

AWS CLI v2 currently supports macOS 11 and later. The installer places the CLI under `/usr/local/aws-cli` and normally creates `/usr/local/bin/aws`.

### Windows

For a current-user installation that does not require administrator rights, run this from PowerShell or Command Prompt:

```powershell
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2-User.msi
```

For an all-users installation from an administrator terminal, use:

```powershell
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi
```

Close and reopen the terminal if necessary, then verify the installation:

```powershell
Get-Command aws
aws --version
```

See the official [AWS CLI v2 installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) for GUI installation, update, uninstall, signature verification, and troubleshooting instructions.

## Recipe 2: Configure the default StackSim profile

The AWS CLI stores credentials separately from other profile settings. The default credentials belong in `~/.aws/credentials` on macOS and `%USERPROFILE%\.aws\credentials` on Windows. The Region and StackSim endpoint belong in the adjacent `config` file.

### Configure it with AWS CLI commands

Run these commands once:

```console
aws configure set aws_access_key_id admin
aws configure set aws_secret_access_key password
aws configure set region eu-west-1
aws configure set endpoint_url http://127.0.0.1:4566
aws configure set output json
aws configure set cli_pager ""
```

If you rotated the starter access key in the StackSim console, substitute the current access key ID and its saved secret for `admin` and `password`.

They create the default profile without requiring environment variables. The files are equivalent to the following.

macOS: `~/.aws/credentials`<br>
Windows: `%USERPROFILE%\.aws\credentials`

```ini
[default]
aws_access_key_id = admin
aws_secret_access_key = password
```

macOS: `~/.aws/config`<br>
Windows: `%USERPROFILE%\.aws\config`

```ini
[default]
region = eu-west-1
endpoint_url = http://127.0.0.1:4566
output = json
cli_pager =
```

Verify both the profile and StackSim connectivity:

```console
aws configure list
aws sts get-caller-identity
```

The caller identity should use account `000000000000` and the local `admin` user. Environment variables take precedence over profile files, so unset old `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_DEFAULT_REGION`, or `AWS_ENDPOINT_URL` values if the CLI reports an unexpected source in `aws configure list`.

> [!CAUTION]
> The default profile now targets StackSim. If you also use real AWS, a named `stacksim` profile is safer. Use `[stacksim]` in `credentials`, `[profile stacksim]` in `config`, and add `--profile stacksim` to every command.

For the file format and setting precedence, see the AWS documentation for [configuration and credential files](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html) and [custom endpoints](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-endpoints.html).

## CloudFormation

StackSim supports the CloudFormation lifecycle used by its registered resource types, including stack creation, updates, change sets, events, outputs, rollback, and deletion. CDK deployments appear as ordinary CloudFormation stacks.

### How to list stacks

```console
aws cloudformation list-stacks --query 'StackSummaries[].{Name:StackName,Status:StackStatus,Updated:LastUpdatedTime}' --output table
```

To show only active stacks:

```console
aws cloudformation describe-stacks --query 'Stacks[].{Name:StackName,Status:StackStatus}' --output table
```

### How to inspect stack outputs

First choose a stack from `list-stacks`, then run:

```console
aws cloudformation describe-stacks --stack-name STACK_NAME --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' --output table
```

### How to inspect deployment events

```console
aws cloudformation describe-stack-events --stack-name STACK_NAME --query 'StackEvents[].{Time:Timestamp,Status:ResourceStatus,Type:ResourceType,LogicalId:LogicalResourceId,Reason:ResourceStatusReason}' --output table
```

This is usually the fastest way to diagnose a failed CDK or CloudFormation deployment.

### How to validate a local template

Given a JSON or YAML template named `template.yaml`:

```console
aws cloudformation validate-template --template-body file://template.yaml
```

Validation confirms the bounded StackSim template contract; it does not imply support for every AWS CloudFormation resource type.

## DynamoDB and DynamoDB Streams

The seeded learning environment includes a `LearningNotes` table whose partition key is the string attribute `id`.

### How to list and describe tables

```console
aws dynamodb list-tables
aws dynamodb describe-table --table-name LearningNotes
```

### How to add and retrieve an item

This recipe modifies local data:

```console
aws dynamodb put-item --table-name LearningNotes --item '{"id":{"S":"cli-note-1"},"title":{"S":"Created with the AWS CLI"},"completed":{"BOOL":false}}'
aws dynamodb get-item --table-name LearningNotes --key '{"id":{"S":"cli-note-1"}}' --consistent-read
```

### How to scan a table

```console
aws dynamodb scan --table-name LearningNotes --projection-expression 'id, title, completed'
```

For a large table, prefer `query` with a key condition. This example queries the seeded table by its partition key:

```console
aws dynamodb query --table-name LearningNotes --key-condition-expression 'id = :id' --expression-attribute-values '{":id":{"S":"cli-note-1"}}'
```

### How to update and delete an item

These commands modify local data:

```console
aws dynamodb update-item --table-name LearningNotes --key '{"id":{"S":"cli-note-1"}}' --update-expression 'SET completed = :done' --expression-attribute-values '{":done":{"BOOL":true}}' --return-values ALL_NEW
aws dynamodb delete-item --table-name LearningNotes --key '{"id":{"S":"cli-note-1"}}' --return-values ALL_OLD
```

### How to list DynamoDB streams

```console
aws dynamodbstreams list-streams
```

After selecting a `StreamArn`, inspect its shards with:

```console
aws dynamodbstreams describe-stream --stream-arn STREAM_ARN
```

## Lambda

### How to list functions

```console
aws lambda list-functions --query 'Functions[].{Name:FunctionName,Runtime:Runtime,State:State,Modified:LastModified}' --output table
```

### How to inspect a function configuration

The seed creates a function named `notes-api`:

```console
aws lambda get-function-configuration --function-name notes-api
```

To show just its environment and execution settings:

```console
aws lambda get-function-configuration --function-name notes-api --query '{Runtime:Runtime,Handler:Handler,Role:Role,Timeout:Timeout,Memory:MemorySize,Environment:Environment.Variables}'
```

### How to invoke a function synchronously

The following invokes the seeded notes function as a `GET` request and writes its response payload to `lambda-response.json`:

```console
aws lambda invoke --function-name notes-api --cli-binary-format raw-in-base64-out --payload '{"httpMethod":"GET"}' lambda-response.json
```

Open `lambda-response.json` to inspect the function result. The command output itself contains invocation metadata such as `StatusCode` and `FunctionError`.

### How to list event source mappings

```console
aws lambda list-event-source-mappings --query 'EventSourceMappings[].{UUID:UUID,Function:FunctionArn,Source:EventSourceArn,State:State}' --output table
```

## Step Functions

### How to list state machines

```console
aws stepfunctions list-state-machines --query 'stateMachines[].{Name:name,Arn:stateMachineArn,Type:type}' --output table
```

### How to start an execution

This recipe creates an execution:

```console
aws stepfunctions start-execution --state-machine-arn STATE_MACHINE_ARN --name cookbook-run-001 --input '{"orderId":"demo-001"}'
```

Execution names must be unique for a given state machine. Change the name when repeating the recipe.

### How to list and inspect executions

```console
aws stepfunctions list-executions --state-machine-arn STATE_MACHINE_ARN --query 'executions[].{Name:name,Status:status,Started:startDate,Arn:executionArn}' --output table
aws stepfunctions describe-execution --execution-arn EXECUTION_ARN
```

### How to inspect execution history

```console
aws stepfunctions get-execution-history --execution-arn EXECUTION_ARN --reverse-order --query 'events[].{Id:id,Time:timestamp,Type:type}' --output table
```

## API Gateway

StackSim supports REST APIs through `apigateway` and HTTP/WebSocket APIs through `apigatewayv2`.

### How to list REST APIs

```console
aws apigateway get-rest-apis --query 'items[].{Name:name,Id:id,Created:createdDate}' --output table
```

### How to list the resources and methods in a REST API

```console
aws apigateway get-resources --rest-api-id REST_API_ID --embed methods
```

To inspect a specific method:

```console
aws apigateway get-method --rest-api-id REST_API_ID --resource-id RESOURCE_ID --http-method GET
```

### How to list HTTP and WebSocket APIs

```console
aws apigatewayv2 get-apis --query 'Items[].{Name:Name,Id:ApiId,Protocol:ProtocolType,Endpoint:ApiEndpoint}' --output table
```

### How to list routes and stages

```console
aws apigatewayv2 get-routes --api-id API_ID --query 'Items[].{Route:RouteKey,Target:Target,Authorization:AuthorizationType}' --output table
aws apigatewayv2 get-stages --api-id API_ID --query 'Items[].{Stage:StageName,AutoDeploy:AutoDeploy,Deployment:DeploymentId}' --output table
```

The AWS-shaped `ApiEndpoint` returned by the control plane is descriptive. Use the local invocation URL printed by the deployment or shown in the StackSim console when calling an API.

## AppSync

### How to list GraphQL APIs

```console
aws appsync list-graphql-apis --query 'graphqlApis[].{Name:name,Id:apiId,Authentication:authenticationType,GraphqlUrl:uris.GRAPHQL}' --output table
```

### How to list data sources

```console
aws appsync list-data-sources --api-id API_ID --query 'dataSources[].{Name:name,Type:type,Role:serviceRoleArn}' --output table
```

### How to list resolvers for a GraphQL type

For example, list the resolvers attached to the `Query` type:

```console
aws appsync list-resolvers --api-id API_ID --type-name Query --query 'resolvers[].{Field:fieldName,DataSource:dataSourceName,Kind:kind}' --output table
```

Repeat with `Mutation` to inspect mutation resolvers.

### How to download the introspection schema

```console
aws appsync get-introspection-schema --api-id API_ID --format JSON schema.json
```

The GraphQL data plane is invoked over HTTP using the GraphQL URL and either an API key or SigV4 authentication; it is not an `aws appsync` subcommand.

## S3

### How to list buckets and objects

```console
aws s3 ls
aws s3 ls s3://BUCKET_NAME/ --recursive
```

For API-shaped output instead of the high-level `s3` display:

```console
aws s3api list-buckets --query 'Buckets[].{Name:Name,Created:CreationDate}' --output table
aws s3api list-objects-v2 --bucket BUCKET_NAME
```

### How to upload and download a file

These commands modify local StackSim storage or the current working directory:

```console
aws s3 cp local-file.txt s3://BUCKET_NAME/cookbook/local-file.txt
aws s3 cp s3://BUCKET_NAME/cookbook/local-file.txt downloaded-file.txt
```

### How to copy a directory recursively

```console
aws s3 sync ./site s3://BUCKET_NAME/site/
```

Add `--delete` only when you intentionally want objects absent from `./site` removed from the destination prefix.

### How to inspect object metadata and versions

```console
aws s3api head-object --bucket BUCKET_NAME --key cookbook/local-file.txt
aws s3api list-object-versions --bucket BUCKET_NAME
```

## SQS

### How to list queues and obtain a queue URL

```console
aws sqs list-queues
aws sqs get-queue-url --queue-name QUEUE_NAME
```

Copy the returned `QueueUrl` for the following recipes.

### How to send a message

This command modifies the queue:

```console
aws sqs send-message --queue-url QUEUE_URL --message-body 'Hello from the StackSim cookbook' --message-attributes '{"source":{"DataType":"String","StringValue":"cookbook"}}'
```

For a FIFO queue, also provide `--message-group-id` and, unless content-based deduplication is enabled, `--message-deduplication-id`.

### How to receive messages

```console
aws sqs receive-message --queue-url QUEUE_URL --max-number-of-messages 10 --wait-time-seconds 2 --attribute-names All --message-attribute-names All
```

Receiving a message does not remove it. It hides the message for the visibility timeout and returns a `ReceiptHandle`.

### How to delete a received message

This command permanently removes the local message:

```console
aws sqs delete-message --queue-url QUEUE_URL --receipt-handle RECEIPT_HANDLE
```

## SNS

### How to list topics and subscriptions

```console
aws sns list-topics
aws sns list-subscriptions --query 'Subscriptions[].{Protocol:Protocol,Topic:TopicArn,Endpoint:Endpoint,Arn:SubscriptionArn}' --output table
```

### How to list subscriptions for one topic

```console
aws sns list-subscriptions-by-topic --topic-arn TOPIC_ARN
```

### How to publish a message

StackSim supports publishing to a topic and local delivery to supported SQS and Lambda subscriptions:

```console
aws sns publish --topic-arn TOPIC_ARN --subject 'Cookbook test' --message 'Hello from the StackSim cookbook'
```

To exercise subscription filters, include message attributes:

```console
aws sns publish --topic-arn TOPIC_ARN --message 'High-priority local event' --message-attributes '{"severity":{"DataType":"String","StringValue":"high"}}'
```

External SMS, mobile push, and email delivery are outside the supported local SNS surface.

## EventBridge and Scheduler

EventBridge uses the `events` namespace. EventBridge Scheduler uses the separate `scheduler` namespace.

### How to list event buses and rules

```console
aws events list-event-buses --query 'EventBuses[].{Name:Name,Arn:Arn}' --output table
aws events list-rules --event-bus-name default --query 'Rules[].{Name:Name,State:State,Pattern:EventPattern,Schedule:ScheduleExpression}' --output table
```

### How to list a rule's targets

```console
aws events list-targets-by-rule --event-bus-name default --rule RULE_NAME
```

### How to publish a custom event

This command creates a local event and may invoke matching targets:

```console
aws events put-events --entries '[{"Source":"cookbook","DetailType":"CookbookExample","Detail":"{\"message\":\"hello\"}","EventBusName":"default"}]'
```

### How to test an event pattern

```console
aws events test-event-pattern --event-pattern '{"source":["cookbook"]}' --event '{"id":"1","account":"000000000000","source":"cookbook","time":"2026-08-01T12:00:00Z","region":"eu-west-1","resources":[],"detail-type":"CookbookExample","detail":{}}'
```

### How to list schedules and schedule groups

```console
aws scheduler list-schedule-groups --query 'ScheduleGroups[].{Name:Name,State:State,Arn:Arn}' --output table
aws scheduler list-schedules --query 'Schedules[].{Name:Name,Group:GroupName,State:State,Target:Target.Arn}' --output table
```

### How to inspect a schedule

```console
aws scheduler get-schedule --name SCHEDULE_NAME --group-name SCHEDULE_GROUP
```

Use `default` as the group name for a schedule created without an explicit group.

## CloudWatch Logs, metrics, alarms, and dashboards

AWS calls log containers **log groups** and their individual sequences **log streams**. These are the closest equivalents to a list of log files.

### How to list all log groups

```console
aws logs describe-log-groups --query 'logGroups[].{Name:logGroupName,Bytes:storedBytes,RetentionDays:retentionInDays}' --output table
```

The seed creates `/stacksim/learning`, and invoked Lambda functions normally write under `/aws/lambda/FUNCTION_NAME`.

### How to list log streams in a group

```console
aws logs describe-log-streams --log-group-name /stacksim/learning --order-by LastEventTime --descending --query 'logStreams[].{Stream:logStreamName,LastEvent:lastEventTimestamp,Bytes:storedBytes}' --output table
```

### How to read one log stream

```console
aws logs get-log-events --log-group-name /stacksim/learning --log-stream-name LOG_STREAM_NAME --start-from-head
```

### How to search logs for specific text

Search a single group for an exact phrase:

```console
aws logs filter-log-events --log-group-name /stacksim/learning --filter-pattern '"stacksim sample resources seeded"' --query 'events[].{Time:timestamp,Stream:logStreamName,Message:message}' --output table
```

Search for a term such as `ERROR`:

```console
aws logs filter-log-events --log-group-name /aws/lambda/notes-api --filter-pattern 'ERROR'
```

Omit `--filter-pattern` to return all matching events in the group. Add `--start-time` and `--end-time` as Unix epoch milliseconds to bound a search.

### How to discover fields before writing a Logs Insights query

List the fields found in recent events and the percentage of events containing each field:

```console
aws logs get-log-group-fields --log-group-name /stacksim/learning --query 'logGroupFields[].{Field:name,PresentPercent:percent}' --output table
```

Add `--time EPOCH_SECONDS` to inspect the eight minutes before and after a particular time. Without it, StackSim examines the most recent 15 minutes. JSON objects and arrays are flattened into fields such as `request.id` and `items.0.sku`; Lambda, VPC Flow Log, Route 53, and CloudTrail-shaped events also expose their discovered service fields. Fields generated by CloudWatch Logs start with `@`.

### How to run and poll a Logs Insights query

Logs Insights time bounds use Unix epoch **seconds**, unlike the millisecond bounds used by `filter-log-events`. Replace the placeholders below with an inclusive interval containing your events:

```console
aws logs start-query --query-language CWLI --log-group-name /stacksim/learning --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'fields @timestamp, @message, @logStream | filter @message like /error/i | sort @timestamp desc | limit 20' --query queryId --output text
```

The command returns a `QUERY_ID`. Poll it until `status` is `Complete`:

```console
aws logs get-query-results --query-id QUERY_ID --query '{Status:status,Statistics:statistics,Results:results}' --output json
```

`Scheduled` and `Running` are nonterminal states; a `Running` response can contain partial results. Terminal states are `Complete`, `Cancelled`, `Failed`, and `Timeout`. Query results and history remain available locally for seven days.

To query multiple groups, replace `--log-group-name` with a space-separated list:

```console
aws logs start-query --query-language CWLI --log-group-names /aws/lambda/orders-api /aws/lambda/billing-api --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'fields @timestamp, @message, @log | sort @timestamp desc | limit 100'
```

Specify exactly one of `--log-group-name`, `--log-group-names`, or `--log-group-identifiers`. ARN identifiers must not end in `:*`.

### How to parse application text and aggregate it

This recipe uses an RE2-compatible named-capture expression, numeric aggregation, a percentile, grouping, and natural sorting:

```console
aws logs start-query --query-language CWLI --log-group-name /stacksim/learning --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'parse @message /status=(?<status>\w+) duration=(?<duration>\d+) service=(?<service>\w+)/ | filter status = "error" | stats count(*) as errors, pct(duration, 95) as p95Duration, avg(duration) as averageDuration by service | sort errors desc'
```

For a time series, group into UTC bins and give the bin an alias that later stages can reference:

```console
aws logs start-query --query-language CWLI --log-group-name /stacksim/learning --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'parse @message /duration=(?<duration>\d+)/ | stats count(*) as requests, avg(duration) as averageDuration by bin(5m) as window | sort window asc'
```

Multiple `stats` stages can summarize the first aggregation again:

```console
aws logs start-query --query-language CWLI --log-group-name /stacksim/learning --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'parse @message /service=(?<service>\w+)/ | stats count(*) as requests by service, bin(5m) as window | stats max(requests) as peakRequests, avg(requests) as averageRequests by service | sort peakRequests desc'
```

Standard log groups allow up to ten `stats` stages. Infrequent Access groups allow two and do not perform automatic field discovery.

### How to query structured JSON and network fields

`jsonParse` creates a structured map that supports dot and bracket access. This example also uses the JSON array functions:

```console
aws logs start-query --query-language CWLI --log-group-name /stacksim/learning --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'fields jsonParse(@message) as event | filter event.level = "error" and jsonArrayContains(event.tags, "checkout") | fields @timestamp, event.service as service, event.request.id as requestId, jsonArraySize(event.items) as itemCount | sort @timestamp desc'
```

For logs containing a discovered `sourceIp` field, filter with the IP helpers:

```console
aws logs start-query --query-language CWLI --log-group-name /stacksim/learning --start-time START_EPOCH_SECONDS --end-time END_EPOCH_SECONDS --query-string 'filter isValidIp(sourceIp) and isIpInSubnet(sourceIp, "10.0.0.0/8") | fields @timestamp, sourceIp, @message | sort @timestamp desc'
```

### How to retrieve the complete event behind a result

Non-aggregate results contain an `@ptr` value. Extract one from a completed query:

```console
aws logs get-query-results --query-id QUERY_ID --query 'results[0][?field==`@ptr`].value | [0]' --output text
```

Then pass the returned `LOG_RECORD_POINTER` to `get-log-record` to retrieve every discovered and system field, including the original `@message`:

```console
aws logs get-log-record --log-record-pointer LOG_RECORD_POINTER
```

Pointers expire with their query results after seven days.

### How to page, inspect, or cancel query jobs

Retrieve up to 1,000 rows and use the returned `nextToken` when more results exist:

```console
aws logs get-query-results --query-id QUERY_ID --max-items 1000
aws logs get-query-results --query-id QUERY_ID --max-items 1000 --next-token NEXT_TOKEN
```

List recent jobs and their scan cost:

```console
aws logs describe-queries --query-language CWLI --query 'queries[].{Id:queryId,Status:status,Group:logGroupName,DurationMs:queryDuration,BytesScanned:bytesScanned,Query:queryString}' --output table
```

Cancel a job only while it is `Scheduled` or `Running`:

```console
aws logs stop-query --query-id QUERY_ID
```

### How to save a parameterized query definition

This command creates durable CWLI query metadata. The `{{service}}` placeholder is substituted safely by the StackSim Logs Insights workbench; a CLI caller can retrieve the metadata and substitute its own value before calling `start-query`:

```console
aws logs put-query-definition --query-language CWLI --name Cookbook/ErrorsByService --log-group-names /stacksim/learning --query-string 'filter service = {{service}} | fields @timestamp, @message | sort @timestamp desc' --parameters 'name=service,defaultValue=orders,description=Service to inspect' --client-token 00000000-0000-4000-8000-000000000001
```

List saved definitions, including their language and parameter metadata:

```console
aws logs describe-query-definitions --query-definition-name-prefix Cookbook/ --query 'queryDefinitions[].{Id:queryDefinitionId,Name:name,Language:queryLanguage,Groups:logGroupNames,Parameters:parameters}' --output json
```

Update a definition by repeating `put-query-definition` with `--query-definition-id QUERY_DEFINITION_ID`. The update replaces the stored query text, groups, language, and parameters rather than merging omitted values. Delete it with:

```console
aws logs delete-query-definition --query-definition-id QUERY_DEFINITION_ID
```

PPL and SQL definitions can also be stored and listed, but StackSim currently executes CWLI only. See the generated [Logs Insights capability manifest](generated/cloudwatch-logs-insights-capabilities.json) for the exact command, function, API, log-class, and limit matrix.

### How to list metrics

```console
aws cloudwatch list-metrics --query 'Metrics[].{Namespace:Namespace,Metric:MetricName,Dimensions:Dimensions}' --output table
```

Limit the result to a namespace when you know it:

```console
aws cloudwatch list-metrics --namespace AWS/Lambda
```

### How to publish a custom metric

This command creates local metric data:

```console
aws cloudwatch put-metric-data --namespace StackSim/Cookbook --metric-data 'MetricName=RecipeRuns,Value=1,Unit=Count'
aws cloudwatch list-metrics --namespace StackSim/Cookbook
```

### How to list alarms and alarm history

```console
aws cloudwatch describe-alarms --query '{Metric:MetricAlarms[].{Name:AlarmName,State:StateValue},Composite:CompositeAlarms[].{Name:AlarmName,State:StateValue}}' --output json
aws cloudwatch describe-alarm-history --alarm-name ALARM_NAME --history-item-type StateUpdate
```

### How to list dashboards

```console
aws cloudwatch list-dashboards --query 'DashboardEntries[].{Name:DashboardName,Modified:LastModified,Size:Size}' --output table
```

Inspect one dashboard definition with:

```console
aws cloudwatch get-dashboard --dashboard-name DASHBOARD_NAME
```

## IAM and STS

StackSim starts with a durable `admin` IAM user. IAM policies and role trust are enforced for signed requests.

### How to show the current identity

```console
aws sts get-caller-identity
```

### How to list users, groups, and roles

```console
aws iam list-users --query 'Users[].{Name:UserName,Arn:Arn,Created:CreateDate}' --output table
aws iam list-groups --query 'Groups[].{Name:GroupName,Arn:Arn}' --output table
aws iam list-roles --query 'Roles[].{Name:RoleName,Arn:Arn,Description:Description}' --output table
```

### How to list local managed policies

```console
aws iam list-policies --scope Local --query 'Policies[].{Name:PolicyName,Arn:Arn,Attachments:AttachmentCount}' --output table
```

### How to inspect a user's permissions

```console
aws iam list-attached-user-policies --user-name USER_NAME
aws iam list-user-policies --user-name USER_NAME
```

### How to assume a role

The role must trust the current principal and the current principal must be allowed to call `sts:AssumeRole`:

```console
aws sts assume-role --role-arn ROLE_ARN --role-session-name cookbook-session
```

The returned credentials are temporary. Do not replace the durable default profile with them unless you deliberately want to test session behavior.

## Cognito user pools

StackSim supports Cognito user pools, not Cognito identity pools.

### How to list user pools

```console
aws cognito-idp list-user-pools --max-results 60 --query 'UserPools[].{Name:Name,Id:Id,Status:Status,Modified:LastModifiedDate}' --output table
```

### How to describe a user pool

```console
aws cognito-idp describe-user-pool --user-pool-id USER_POOL_ID
```

### How to list users

```console
aws cognito-idp list-users --user-pool-id USER_POOL_ID --query 'Users[].{Username:Username,Status:UserStatus,Enabled:Enabled,Created:UserCreateDate}' --output table
```

To find a particular user:

```console
aws cognito-idp admin-get-user --user-pool-id USER_POOL_ID --username USERNAME
```

### How to list groups and group membership

```console
aws cognito-idp list-groups --user-pool-id USER_POOL_ID --query 'Groups[].{Name:GroupName,Description:Description,Precedence:Precedence}' --output table
aws cognito-idp list-users-in-group --user-pool-id USER_POOL_ID --group-name GROUP_NAME
```

## SES

StackSim provides SES v1 and v2 control planes and captures sent messages in its durable local inbox. It does not deliver mail to the public internet.

### How to list verified identities

Classic SES:

```console
aws ses list-identities
```

SES v2:

```console
aws sesv2 list-email-identities --query 'EmailIdentities[].{Identity:IdentityName,Type:IdentityType,Verified:VerifiedForSendingStatus}' --output table
```

### How to verify a local email identity

This command creates or updates local SES state:

```console
aws ses verify-email-identity --email-address sender@example.test
```

StackSim completes verification locally; no external verification email is sent.

### How to send a simple email

Verify the sender first, then run:

```console
aws ses send-email --from sender@example.test --destination 'ToAddresses=recipient@example.test' --message 'Subject={Data=StackSim cookbook},Body={Text={Data=Hello from the local SES inbox}}'
```

Inspect the captured message in the StackSim console under SES. SNS email subscriptions are a separate unsupported external-delivery surface and should not be confused with the local SES inbox.

### How to list templates

```console
aws ses list-templates
aws sesv2 list-email-templates
```

## Systems Manager Parameter Store

Only the Parameter Store portion of Systems Manager is supported.

### How to create or update a parameter

This command modifies local parameter state:

```console
aws ssm put-parameter --name /cookbook/database/host --type String --value 127.0.0.1 --overwrite
```

For a list value:

```console
aws ssm put-parameter --name /cookbook/features --type StringList --value 'search,alerts,exports' --overwrite
```

### How to read a parameter

```console
aws ssm get-parameter --name /cookbook/database/host
```

Use `--with-decryption` when reading a locally protected `SecureString`:

```console
aws ssm get-parameter --name /cookbook/database/password --with-decryption
```

### How to list a hierarchy

```console
aws ssm get-parameters-by-path --path /cookbook --recursive --with-decryption --query 'Parameters[].{Name:Name,Type:Type,Version:Version,Value:Value}' --output table
```

### How to delete a parameter

This command permanently deletes the local parameter:

```console
aws ssm delete-parameter --name /cookbook/database/host
```

## Secrets Manager

### How to create a secret

This command creates encrypted local secret state:

```console
aws secretsmanager create-secret --name cookbook/database --description 'Local cookbook credentials' --secret-string '{"username":"app","password":"local-only"}'
```

### How to list secrets without revealing values

```console
aws secretsmanager list-secrets --query 'SecretList[].{Name:Name,Arn:ARN,Changed:LastChangedDate,Description:Description}' --output table
```

### How to retrieve a secret value

```console
aws secretsmanager get-secret-value --secret-id cookbook/database
```

The response includes `SecretString`, so take care when copying terminal output or logs.

### How to update a secret value

This command creates a new secret version and moves the `AWSCURRENT` stage:

```console
aws secretsmanager put-secret-value --secret-id cookbook/database --secret-string '{"username":"app","password":"changed-locally"}'
```

### How to schedule and cancel deletion

These commands modify local secret lifecycle state:

```console
aws secretsmanager delete-secret --secret-id cookbook/database --recovery-window-in-days 7
aws secretsmanager restore-secret --secret-id cookbook/database
```

## RDS

StackSim exposes one MySQL-compatible local RDS instance backed by SQLite. The AWS CLI manages its RDS-shaped lifecycle; use a MySQL client for SQL queries.

### How to list database instances

```console
aws rds describe-db-instances --query 'DBInstances[].{Identifier:DBInstanceIdentifier,Engine:Engine,Status:DBInstanceStatus,Database:DBName,Address:Endpoint.Address,Port:Endpoint.Port}' --output table
```

The standard seed creates the `learning-db` instance.

### How to retrieve connection details

```console
aws rds describe-db-instances --db-instance-identifier learning-db --query 'DBInstances[0].{Host:Endpoint.Address,Port:Endpoint.Port,Database:DBName,Username:MasterUsername,Status:DBInstanceStatus}'
```

The password is not returned by RDS. Use the password supplied when the instance was created; the standard seed defaults it through its local StackSim configuration.

### How to stop, start, or reboot an instance

These commands change the local database lifecycle state. Run only the operation you need and wait for that transition to finish before running another:

```console
# Stop an available instance.
aws rds stop-db-instance --db-instance-identifier learning-db

# Start a stopped instance.
aws rds start-db-instance --db-instance-identifier learning-db

# Reboot an available instance.
aws rds reboot-db-instance --db-instance-identifier learning-db
```

Wait for `DBInstanceStatus` to return to `available` before connecting.

### How to list database tags

First obtain `DBInstanceArn`:

```console
aws rds describe-db-instances --db-instance-identifier learning-db --query 'DBInstances[0].DBInstanceArn' --output text
```

Then run:

```console
aws rds list-tags-for-resource --resource-name DB_INSTANCE_ARN
```

## Troubleshooting

### Confirm which settings the CLI is using

```console
aws configure list
```

Credentials or endpoint environment variables override the default profile. Remove stale environment variables when `aws configure list` reports an unexpected source.

### Confirm StackSim is reachable

Open `http://127.0.0.1:4566/_stacksim/health` in a browser, or run:

```console
aws sts get-caller-identity
```

Connection failures usually mean StackSim is not running, is using another port, or the profile has the wrong `endpoint_url`.

### Bypass the profile for one command

```console
aws dynamodb list-tables --endpoint-url http://127.0.0.1:4566 --region eu-west-1
```

Credentials are still required, either from a profile or environment variables.

### Diagnose an unsupported operation

StackSim returns an AWS-style error for unsupported actions and feature variants. Check the [supported services table](../README.md#supported-services) and the detailed [implementation reference](reference.md) before assuming an AWS CLI syntax problem.

### Avoid accidentally contacting real AWS

Check `aws configure list` before destructive commands. A StackSim request should resolve to the local endpoint `http://127.0.0.1:4566`, Region `eu-west-1`, and local credentials. If you use both StackSim and AWS, prefer a named StackSim profile over changing your real default profile.
