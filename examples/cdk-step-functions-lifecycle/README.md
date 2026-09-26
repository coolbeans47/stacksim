# Step Functions deployment lifecycle

This companion to [OrderFlow Observatory](../cdk-orderflow-observatory/README.md) teaches deployment ownership and recovery. It uses the repository's unmodified pinned CDK CLI `2.1132.0`, `aws-cdk-lib` `2.265.0`, and SDK `@aws-sdk/client-sfn` `3.1090.0`. Run it from the repository after `npm ci`, on Node.js 22.13 or later. No separate install is needed.

Start StackSim in another terminal with `npm run dev`. Its reduced CDK bootstrap and local admin credentials are enabled by default. The example defaults to `http://127.0.0.1:4566`, `eu-west-1`, and account `000000000000`; it accepts the standard `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` environment settings. Only a loopback endpoint is admitted. CDK subprocesses use the acceptance tests' network tripwire, so they cannot contact public AWS.

Run these commands from the repository root:

```text
node examples/cdk-step-functions-lifecycle/run.mjs synth v1
node examples/cdk-step-functions-lifecycle/run.mjs deploy v1
node examples/cdk-step-functions-lifecycle/run.mjs execute
node examples/cdk-step-functions-lifecycle/run.mjs inspect
node examples/cdk-step-functions-lifecycle/run.mjs deploy v2
node examples/cdk-step-functions-lifecycle/run.mjs execute
node examples/cdk-step-functions-lifecycle/run.mjs deploy v2
node examples/cdk-step-functions-lifecycle/run.mjs fail
node examples/cdk-step-functions-lifecycle/run.mjs execute
```

The helper supplies local environment settings and invokes the ordinary CDK CLI with its default change-set deployment path. It does not rewrite the assembly, patch CDK, or use a custom synthesizer. The exact same application is exercised by `test/cloudformation-step-functions-cdk.test.ts`.

The `CommonWorkflow` runs CDK's `DynamoPutItem`, `SqsSendMessage`, `SnsPublish`, and `EventBridgePutEvents` constructs. The message bodies and event detail use CDK's `JsonPath.jsonToString` intrinsic to supply the supported JSON-text service fields. Verify the stored item, work-queue message, notification subscription message, and EventBridge Lambda receipt in its CloudWatch log group. CDK generates the execution role with one permission per integration on the actual target ARN. The deploy role and CloudFormation execution role are separate from this task role.

`AssetWorkflow` uses `DefinitionBody.fromFile`, which publishes `definition.asl.json` through the ordinary S3 file-asset pipeline. `DefinitionSubstitutions` produces the effective definition, including the multi-key `${Greeting,Audience}` substitution. The accepted object version and content are pinned; editing or replacing an S3 object does not change an accepted deployment or an execution snapshot. The v2 deployment changes the substituted release and workflow/Activity tags. The second identical v2 deployment is a no-op.

`ReviewWorkflow` invokes a CloudFormation-owned `Activity`. The `execute` command runs an ordinary SDK worker that polls, heartbeats and completes one review. Its task token remains inside the worker process and is not printed. To explore restart, stop StackSim and start it with the same data directory, then run `inspect` and `execute` again. The focused acceptance test additionally restarts with an already claimed Activity task and completes it with the original token.

`fail` creates an independently owned Activity, then tries to deploy a conflicting CDK Activity after updating the asset workflow. The expected deployment failure is followed by `UPDATE_ROLLBACK_COMPLETE`. The command executes the restored asset definition and prints the previous release. The independent Activity is not adopted or deleted by rollback. Missing/malformed S3 definitions and invalid ASL fail admission, before a successful deployment can replace the old definition.

Open `http://127.0.0.1:4566/_stacksim/console`, select CloudFormation → `StepFunctionsLifecycle` → Resources, and follow the state-machine and Activity links. State-machine details link to its execution role, related resources, and executions. Execution history preserves the definition used for that run. Event delivery logs are the Lambda target's logs; this phase does not enable Step Functions execution logging or X-Ray.

```text
node examples/cdk-step-functions-lifecycle/run.mjs destroy
node examples/cdk-step-functions-lifecycle/run.mjs cleanup
node examples/cdk-step-functions-lifecycle/run.mjs deploy v1
node examples/cdk-step-functions-lifecycle/run.mjs execute
node examples/cdk-step-functions-lifecycle/run.mjs destroy
node examples/cdk-step-functions-lifecycle/run.mjs cleanup
```

Destroy removes the normal workflows, Activity, table, queues, topic, event bus/rule and receipt Lambda/log group. The deliberately retained workflow and its retained role survive and can still execute. `cleanup` explicitly deletes those resources and the independent conflict Activity after stack deletion. Retained executions and history survive resource deletion until the service retention limit; the reduced bootstrap bucket and its versioned deployment assets belong to the environment and also remain. Resource import is outside the platform's supported boundary, so cleanup is required before repeating this example's deterministic generated Activity name.

The local supported profile is Standard JSONPath with the existing SFN-03 integrations. Express, JSONata, enabled Step Functions logging, X-Ray, KMS, versions/aliases, redrive, Distributed Map and arbitrary AWS SDK/HTTP integrations remain modeled errors. Retaining a workflow does not automatically retain its dependencies; this example deliberately retains the role of its dependency-free Pass workflow.
