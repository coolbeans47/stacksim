# Standard CDK multi-stack fixture

This ordinary CDK v2 application exercises `cdk deploy --all`, a retained
DynamoDB data stack exporting its table name and ARN, and a REST API stack
that imports both values into its API description, MOCK response, and outputs.
It verifies import protection, live API invocation, outputs, reverse-order
`cdk destroy --all`, and `RemovalPolicy.RETAIN`. It uses the default
synthesizer and no stacksim-specific construct or deployment wrapper.

## Pinned toolchain and context

- `cdk` 2.1132.0
- `aws-cdk-lib` 2.265.0
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
and no image assets. `DataStack.assets.json` contains file asset
`28f5f724c34e7e0f42fb2fd70a42712137046cb58b87bb3e1cf9408ed464147f`;
`ApiStack.assets.json` contains
`6061cf8eed7f0305531a8f49ea00c82a6f753fbe7ce2f691e433738b2653fc73`.
Both templates are published through the reduced bootstrap's file-publishing
role. Destroying both workload stacks retains both the declared DynamoDB table
and the simulator-managed versioned bootstrap bucket.

| Artifact | SHA-256 |
| --- | --- |
| `DataStack.template.json` | `28f5f724c34e7e0f42fb2fd70a42712137046cb58b87bb3e1cf9408ed464147f` |
| `DataStack.assets.json` | `02ac102c0f3bc042bed4e25813c39ed031f599065405af393cd7a7984b7d32e8` |
| `ApiStack.template.json` | `6061cf8eed7f0305531a8f49ea00c82a6f753fbe7ce2f691e433738b2653fc73` |
| `ApiStack.assets.json` | `0b7f92acdd4c1d9a9a7bf8ea0910d7292071928107126302ad33f8bfc930c039` |
| `manifest.json` | `0cc0c3323d23104b62fe89ffb5e2581935f62307d90a9676b2ab5ced9156c1eb` |
