# CFN-04 negative-boundary fixture

This is an ordinary CDK v2 application using the pinned published libraries,
the default synthesizer, and no stacksim-specific construct or deployment
wrapper. Its variants prove the reduced bootstrap's environment, role, file
asset, image-asset, and provider-admission boundaries without mutating a stack.

## Pinned toolchain and context

- `cdk` 2.1144.0
- `aws-cdk-lib` 2.273.0
- `constructs` 10.7.1
- `tsx` 4.23.1
- `esbuild` 0.28.1 (repository pin used by `tsx`; this fixture has no local
  Lambda bundling step)
- CDK context: `@aws-cdk/core:newStyleStackSynthesis=true`
- Frozen environment: account `000000000000`, Region `eu-west-1`, default
  qualifier `hnb659fds` unless a negative case overrides it

The tests set standard AWS credentials, `AWS_ENDPOINT_URL`, both AWS Region
variables, and both CDK environment variables. Every subprocess loads
`../network-tripwire.cjs`, which permits only the selected loopback simulator
port.

## Variants and commands

The common command is expected to fail at the selected boundary:

```powershell
npx --no-install cdk --output variant.out deploy Cfn04NegativeStack --method direct --require-approval never --no-notices --no-color
```

| Environment selection | Synthesized behavior and tested boundary |
| --- | --- |
| No override | Metadata-only baseline; also used by the read-only `cdk diff Cfn04NegativeStack --method template` lookup-role check. |
| `CDK_TEST_ASSET_KIND=file` | Adds the generic `asset.txt` file asset. Wrong file-publishing trust or missing `s3:PutObject` must stop before stack creation. |
| `CDK_TEST_ASSET_KIND=image` | Adds one `DockerImageAsset`. CDK assumes the image-publishing role and stops at the first local `ecr:DescribeRepositories` denial; Docker must not run. |
| `CDK_TEST_ASSET_KIND=lambda-gate` | Adds a file-backed L1 Lambda function. Under a CFN-04-only provider registry, CDK publishes the file first and CloudFormation then rejects `AWS::Lambda::Function` before any Lambda mutation. |
| `CDK_TEST_QUALIFIER=localtest1` | Uses a changed default-synthesizer qualifier and fails against the absent alternate bootstrap names. |
| `CDK_TEST_STACK_ACCOUNT=111111111111` | Synthesizes for the wrong account and fails without stack mutation. |
| `CDK_TEST_STACK_REGION=us-east-1` | Synthesizes for the wrong Region and must not materialize bootstrap state there. |

The role matrix additionally corrupts, one at a time, the lookup,
file-publishing, image-publishing, deployment, and CloudFormation execution
role trust policies before running the applicable `diff` or direct `deploy`.

## Frozen synthesized inventory

| Variant | Exact resources | Type counts | File assets | Image assets |
| --- | --- | --- | ---: | ---: |
| baseline, qualifier, account, or Region | `CDKMetadata` (`AWS::CDK::Metadata`) | Metadata: 1 | template: 1 | 0 |
| `file` | `CDKMetadata` (`AWS::CDK::Metadata`) | Metadata: 1 | `asset.txt` plus template: 2 | 0 |
| `image` | `CDKMetadata` (`AWS::CDK::Metadata`) | Metadata: 1 | template: 1 | Docker image: 1 |
| `lambda-gate` | `CDKMetadata` (`AWS::CDK::Metadata`), `PhaseGateFunction` (`AWS::Lambda::Function`) | Metadata: 1; Function: 1 | `asset.txt` plus template: 2 | 0 |

No variant emits a resource-level `DependsOn`. Asset references and the
default synthesizer's bootstrap parameter supply the relevant implicit
ordering.

## Bootstrap asset behavior and digest corpus

Template and generic file assets target
`cdk-hnb659fds-assets-000000000000-eu-west-1` through the standard
file-publishing role. The image variant targets the standard image-publishing
role and deliberately stops at the unimplemented ECR boundary before a build.
The `lambda-gate` case is the historical phase gate: successful S3 publication
must precede exact provider-type admission failure.

`test/cloudformation-cfn04-negative.test.ts` freezes all three semantic assembly
digests for every variant:

| Variant | Template SHA-256 | `manifest.json` SHA-256 | Asset-manifest SHA-256 |
| --- | --- | --- | --- |
| baseline | `75559b26d9b068e5387bcd59e619b4d65acf3621e4ad3540a217ce86d3ab6e2f` | `848f23ee3b80f78d8cef45c9c822bf1688bbe52b4a75ba4141237d7d2c90b034` | `2dfcf5bd608d14f222420cf52449a2a3624e628c4e927ff4f94cbd4d71d81ecf` |
| `file` | `38ab0a638d98ef5b8a622f5269e0b1c3cee3903355e50fe18f90e67a19a17a70` | `bc0626a1c364b1591c5a201e923397dd2e904ad4122aff73684879bdbc5e4eaa` | `7d4f99d5a5e80ef14c06a795da2c4ea7137499d40d4e0a03e0cab7988fe1983b` |
| `image` | `c2dd9869420dd53d634cf61d87db48584a78038eaf0b1cd72cd9c140c42b8831` | `30643e63f9c69e1f26c4ad138fe91ee93e166a8890ca55165287024994440a03` | `bd07e92d88fe45843c38447f10bbd128b05aae1009330aa1c6bf8e4e68111489` |
| `lambda-gate` | `67f62c6b51d8dde83cc08e221630899bb7f73c73a3cd580f6a594d28132a09ad` | `6eb7d965080498e898a51b6e934231a8a78f66a8268b7f94545d5e959dc87b56` | `446af20e5b6445f02205977c3715ba53e89ed8362eef7b30975cbd8dcf37a98e` |
