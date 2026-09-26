# Step Functions CloudFormation contract — SFN-04

Frozen on 2026-09-25 against the official CloudFormation references, the public AWS resource-provider schemas, and repository-pinned `aws-cdk-lib` 2.265.0 / CDK CLI 2.1132.0. This is the local admission contract, not a claim that every property in AWS's schema executes locally.

## Source audit

The [StateMachine reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-stepfunctions-statemachine.html) establishes ARN `Ref`, backed `Arn`, `Name`, and `StateMachineRevisionId` attributes; a default `STANDARD` type; replacement on name/type changes; and mutable definition, role and tags. The [Activity reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-stepfunctions-activity.html) requires `Name`, replaces name/encryption changes, and permits tag updates. Activity `Ref`/`Arn` return its ARN and `Name` returns its actual name.

The public [StateMachine schema](https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-stepfunctions/blob/main/statemachine/aws-stepfunctions-statemachine.json) and [Activity schema](https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-stepfunctions/blob/main/activity/aws-stepfunctions-activity.json) confirm these identities, creation-only properties, tag handlers and per-handler permissions. These source schemas lag the current references: they omit `EncryptionConfiguration`. The newer documentation therefore controls encryption admission. The schema allows substitution values of string, integer or boolean; the prose reference describes only strings. StackSim admits the schema scalar types, with integers restricted to JavaScript's safe integer range.

The inspected UTF-8 schema bodies have SHA-256 digests `21cf6040dc1bb6a77f9b0fb090294462134856a2fc19ad4b0663ba1e249eeb2b` (StateMachine) and `722c0e73dc0edf4728aa51d43ffd2063228059bf9720309faf6e653e6eb345b0` (Activity). These identify the audit input even if the source branch changes.

AWS's [DefinitionProcessor](https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-stepfunctions/blob/main/statemachine/src/main/java/com/amazonaws/stepfunctions/cloudformation/statemachine/DefinitionProcessor.java) requires exactly one definition form and performs textual substitutions before submission to Step Functions. StackSim preserves that order and then uses its shared strict ASL parser, validator, compiler and integration registry.

## Admitted resources

| Property | SFN-04 behavior |
|---|---|
| StateMachine `Definition` | Inline object, serialized deterministically; mutable. |
| StateMachine `DefinitionString` | JSON string; mutable. |
| StateMachine `DefinitionS3Location` | Object with required nonempty `Bucket`/`Key`, optional `Version`, no other fields; mutable. Exactly one of the three definition forms must be supplied. |
| `DefinitionSubstitutions` | Optional nonempty scalar map. `${Key}` substitutes one value; `${First,Second}` concatenates values. The local bounded replacement is textual, nonrecursive and does not automatically JSON-escape values. When the map is supplied, missing referenced keys reject; malformed resulting JSON always rejects. Substitutions occur before strict ASL validation. |
| `RoleArn` | Required role in the stack account, trusted by `states.amazonaws.com`; mutable. Under enforced authorization, the existing platform PassRole gate requires a workload role owned by this stack and declared in its active processed template. |
| `StateMachineName` | Optional; generated stable physical name when omitted. Local admitted names contain 1–80 ASCII letters, digits, hyphens or underscores. A changed name requires create-before-delete replacement. |
| `StateMachineType` | Omitted or `STANDARD`. AWS declares type replacement; `EXPRESS` remains rejected. |
| StateMachine `LoggingConfiguration` | Omitted, `{}`, or disabled shape: optional `Level: OFF`, optional `IncludeExecutionData: false`, optional empty `Destinations`. Unknown fields, destinations and enabled logging reject. |
| StateMachine `TracingConfiguration` | Omitted, `{}`, or `Enabled: false`; unknown/enabled fields reject. |
| `EncryptionConfiguration` | Omitted or exactly `{ Type: AWS_OWNED_KEY }` for either resource. No KMS identifier/reuse-period fields. Activity encryption is immutable. Omission and explicit default are equivalent. |
| Activity `Name` | Required, 1–80 characters with the service's name exclusions; replacement on change. An unmodified CDK L2 `Activity` generates the required name when its `activityName` is omitted. |
| `Tags` | Optional `Key`/`Value` array, unique non-`aws:` keys; at most 47 user/merged stack tags after reserving three ownership tags. Keys are 1–128 characters, values up to 256. Mutable through `TagResource`/`UntagResource`. |

[Logging](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-stepfunctions-statemachine-loggingconfiguration.html) defaults to OFF in AWS. The accepted empty destinations/default shapes preserve StackSim's existing disabled service behavior. [Encryption](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-stepfunctions-statemachine-encryptionconfiguration.html) defaults to AWS-owned encryption. Locally that means private persistence protections, not an AWS KMS key or KMS call.

All unknown resource properties and unsupported ASL fields fail admission. Definition changes, role changes and user tag changes update the existing machine. Existing executions keep their captured effective definition and role; identical canonical updates do not create a new definition revision.

## Assets, authority and recovery

[S3Location](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-stepfunctions-statemachine-s3location.html) specifies an optional exact object version. AWS also accepts YAML; SFN-04 deliberately accepts only strict UTF-8 JSON to preserve the shared parser boundary. Invalid encoding, BOM, malformed JSON, oversized source/effective definitions (over 1 MiB), missing versions/objects, unsupported account/Region and denied access produce modeled deployment failures.

CloudFormation's normal immutable asset-reference pipeline authorizes the S3 object read with the stack execution role, records its version/identity and digest, and preserves accepted content for deployment, rollback and restart. It does not fetch a mutable definition inside the provider. A changed unversioned object cannot silently replace the planned content. Subsequent changes to S3 cannot alter a deployed definition or an execution snapshot.

Deployment and execution have distinct principals. Stack operations require the relevant `states:Create*`, `Describe*`, `List*`, `UpdateStateMachine`, `Delete*`, `TagResource` and `UntagResource` permissions; state-machine create/update additionally require `iam:PassRole`. S3 uses its normal identity/resource-policy checks, including the requested version. Tasks assume the captured state-machine role and perform normal downstream authorization. Activity workers use ordinary `GetActivityTask` and `SendTask*` APIs; there is no `UpdateActivity` API.

The [Step Functions authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_stepfunctions.html) includes `states:TagResource` for tagged create operations. CloudFormation always adds its three ownership tags, so a deployment role needs tag-on-create authority as well as create authority. The existing local CloudFormation PassRole gate requires workload roles declared and owned by the active stack; generated CDK execution roles satisfy this boundary.

Providers read the authoritative Step Functions service catalog. CloudFormation ownership tags and bounded generation/checkpoint references prevent accidental adoption or recovery against a same-name recreated resource. Checkpoints contain no execution database or task tokens. `Delete`, `Retain`, `RetainExceptOnCreate` and create-before-delete replacement use the shared CloudFormation lifecycle; `Snapshot` is unavailable. Deleting a state machine prevents new starts while existing executions and histories remain. Deleting an Activity preserves already issued task tokens under the existing worker contract. Retention does not adopt resources into a later stack. General CloudFormation import and drift APIs remain at the platform's existing unsupported boundary.

Private execution-store schema v5 snapshots the Activity generation when scheduling worker tasks. For legacy queued tasks, recovery binds a current Activity only if its creation predates the task; ambiguous or missing bindings fail closed for new polling. Already issued task tokens retain their existing completion behavior. Neither this migration nor provider recovery changes the owning-service receipt, callback or ambiguous-attempt retry contract.

## Pinned CDK evidence and scope

Unmodified pinned synthesis emits `DefinitionString` and a generated `states.amazonaws.com` execution role for `StateMachine` with `LambdaInvoke`, plus an ARN-scoped `lambda:InvokeFunction` policy (including qualified function ARNs). `DefinitionBody.fromFile` emits a bootstrap-bucket `DefinitionS3Location` and supplied substitutions. L2 `Activity` emits a concrete generated `Name`. The learning fixture and `test/cloudformation-step-functions-cdk.test.ts` exercise these normal deployment forms and supported common integrations; the deployed template is not rewritten to bypass admission.

The provider uses the existing Standard JSONPath runtime: Lambda, DynamoDB item calls, SQS, SNS, EventBridge, Activities and nested workflows in the SFN-03 integration registry. SFN-04 does not activate Express, JSONata, execution logging, X-Ray, KMS, versions, aliases, redrive, Distributed Map, HTTP tasks or general AWS SDK integrations. Unsupported forms return precise admission errors instead of inert success.
