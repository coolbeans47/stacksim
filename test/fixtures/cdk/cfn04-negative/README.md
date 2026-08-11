# CFN-04 negative-boundary fixture

This is an ordinary CDK v2 application using the pinned published libraries,
the default synthesizer, and no stacksim-specific construct or deployment
wrapper. Its variants prove the reduced bootstrap's environment, role, file
asset, image-asset, and provider-admission boundaries without mutating a stack.

## Pinned toolchain and context

- `cdk` 2.1132.0
- `aws-cdk-lib` 2.261.0
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

`test/cloudformation-cfn04-negative.test.ts` freezes all three assembly
digests for every variant:

| Variant | Template SHA-256 | `manifest.json` SHA-256 | Asset-manifest SHA-256 |
| --- | --- | --- | --- |
| baseline | `586462a70cf7584c24b13527184b07e6b416aa0151cc9879dccf1c39de37e8db` | `191ca70aa106f418a7440cc0d544ac5f38f172de3c86690825c09ead8b7461bb` | `ed758822871dd12982611dccec1765273589f98e3d883c04e4b8603d5dd092e2` |
| `file` | `17b5b52a11239f6a3e83f723629be7c58e01a6f84fdefb4832bb596f71773f58` | `f2c5bafa104fdfc0b8c5e379ac7c51d89e67949c7ec58fe7936592ea590da4c1` | `152335d28b55a760cd8e8c57e911e4e7deaf4d6d8c3ca5602acb09fe735d5d97` |
| `image` | `148359b9b60cb8129852c60934eb97ef4c1926e18a0c3c8658ce9724e0aa7617` | `8e1b756e3cd0c9500edea2e2faa8e59fe5ee36fc23ef70d3615c52026777dd21` | `7a19786de33dc35c33f2df42f87a768ae7087b1b4f54aff81ddf7dd74515738b` |
| `lambda-gate` | `26eed95d0667f5d1af4f362bdc0236c45dcf85ec6e6ba268c5f45d474275c9fe` | `7d1cd70c2c638017b404128e9de170bf791dcbec520d1448ff8c40a5ce7bddd4` | `68694eb62b0301b02ea87e742d7976d5c2fff88a2e02d58ea2a5ee3ee61da936` |
