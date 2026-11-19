# Standard CDK multi-stack fixture

This ordinary CDK v2 application exercises `cdk deploy --all`, a retained
DynamoDB data stack exporting its table name and ARN, and a REST API stack
that imports both values into its API description, MOCK response, and outputs.
It verifies import protection, live API invocation, outputs, reverse-order
`cdk destroy --all`, and `RemovalPolicy.RETAIN`. It uses the default
synthesizer and no stacksim-specific construct or deployment wrapper.

## Pinned toolchain and context

- `cdk` 2.1144.0
- `aws-cdk-lib` 2.273.0
- `constructs` 10.7.1
- `tsx` 4.23.1
- `esbuild` 0.28.1 (repository pin used by `tsx`; no workload bundling)
- CDK context: `@aws-cdk/core:newStyleStackSynthesis=true`
- Frozen environment: account `000000000000`, Region `eu-west-1`, qualifier
  `hnb659fds`

The exact tested lifecycle is:

```powershell
npx --no-install cdk --output deploy-all.out deploy --all --require-approval never --outputs-file multi-outputs.json --no-notices --no-color
npx --no-install cdk --output destroy-all.out destroy --all --force --no-notices --no-color
```

All calls use standard endpoint environment variables and the shared loopback
network tripwire.

## Frozen synthesized inventory and dependencies

| Stack | Exact logical ID | CloudFormation type |
| --- | --- | --- |
| `DataStack` | `Items5C12978B` | `AWS::DynamoDB::Table` |
| `DataStack` | `CDKMetadata` | `AWS::CDK::Metadata` |
| `ApiStack` | `ApiF70053CD` | `AWS::ApiGateway::RestApi` |
| `ApiStack` | `ApiCloudWatchRole73EC6FC4` | `AWS::IAM::Role` |
| `ApiStack` | `ApiAccountA18C9B29` | `AWS::ApiGateway::Account` |
| `ApiStack` | `ApiDeploymentB17BE62Dcdb2db5f4ffe87a238e50a25189df434` | `AWS::ApiGateway::Deployment` |
| `ApiStack` | `ApiDeploymentStageprod3EB9684E` | `AWS::ApiGateway::Stage` |
| `ApiStack` | `ApiGET9257B917` | `AWS::ApiGateway::Method` |
| `ApiStack` | `CDKMetadata` | `AWS::CDK::Metadata` |

Across the assembly the exact type counts are two CDK metadata resources and
one each of DynamoDB table, REST API, IAM role, API Gateway account,
deployment, stage, and method. `Items5C12978B` has both `DeletionPolicy` and
`UpdateReplacePolicy` set to `Retain`. The API template has these explicit
resource dependencies:

- `ApiAccountA18C9B29` depends on `ApiF70053CD`.
- `ApiDeploymentB17BE62Dcdb2db5f4ffe87a238e50a25189df434` depends on
  `ApiGET9257B917`.
- `ApiDeploymentStageprod3EB9684E` depends on `ApiAccountA18C9B29`.

The `ApiStack` template imports both `StackSimMultiStackTableName` and
`StackSimMultiStackTableArn`. The cloud assembly records an explicit stack
dependency from `ApiStack` to `DataStack`. This is the ordering exercised by
deploy-all and reverse-order destroy-all; deleting `DataStack` while
`ApiStack` imports either export is rejected. After both stack records are
deleted, the table remains available as declared.

## Bootstrap assets and frozen digest corpus

Each stack asset manifest contains exactly one file asset, its stack template,
and no image assets. Both templates are published through the reduced
bootstrap's file-publishing role. Destroying both workload stacks retains both
the declared DynamoDB table and the simulator-managed versioned bootstrap bucket.

| Artifact | Semantic SHA-256 |
| --- | --- |
| `DataStack.template.json` | `6e53ea35757c657608ce8c2ecd3d2bba69b90f19dbf5437e3c73f5f77d298960` |
| `DataStack.assets.json` | `d116e3576521c2323f40ad57ca3d5e63239020d8ffd5d588c9216aa629d9b267` |
| `ApiStack.template.json` | `0312a4a068e3af7a69eff064f7badb0ab0c27da00fd2756960d9ce3f74dc4ed9` |
| `ApiStack.assets.json` | `3725060d454f069f7f5d9ddf2cd908fac79996985de9b5d261cb367de6e5eef9` |
| `manifest.json` | `d01dc11d49361baa631a6350d7cffa771e91b725d37811ce3987404c35325974` |
