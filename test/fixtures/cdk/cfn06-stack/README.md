# CFN-06 standard-CDK compatibility fixture

This ordinary CDK v2 stack exercises the complete CFN-06 provider set through
standard constructs: IAM role, inline policy and managed policy; inline and
locally bundled Node.js Lambda functions; Lambda permission, version and
alias; and explicit CloudWatch Logs groups. It has no fixture-local package or
deployment wrapper.

## Pinned toolchain and context

- `cdk` 2.1132.0
- `aws-cdk-lib` 2.261.0
- `constructs` 10.7.1
- `tsx` 4.23.1
- `esbuild` 0.28.1
- CDK context: `@aws-cdk/core:newStyleStackSynthesis=true`
- Frozen environment: account `000000000000`, Region `eu-west-1`, qualifier
  `hnb659fds`

`lambda-nodejs.NodejsFunction` uses the repository-pinned lock file and local
`esbuild` binary. Every CDK subprocess loads `../network-tripwire.cjs`; only
the selected loopback simulator port is allowed.

## Release variants and commands

`CDK_CFN06_TEST_RELEASE` accepts three fixture variants:

- `v1` creates the baseline resources.
- `v2` changes both function assets/configuration, IAM policy documents, role
  session duration, log retention, immutable version, and alias target.
- `fail` changes those properties again, replaces the Events permission, then
  creates `RollbackFailure` against `cfn06-missing-function`. That permission
  explicitly depends on every representative mutation, so it fails last and
  drives compound update rollback.

After setting standard local credentials, Region variables, and
`AWS_ENDPOINT_URL`, the reproducible lifecycle is:

```powershell
$env:CDK_CFN06_TEST_RELEASE = "v1"
npx --no-install cdk --output synth-v1.out synth Cfn06Stack --no-notices --no-color
npx --no-install cdk --output create.out deploy Cfn06Stack --require-approval never --outputs-file outputs-v1.json --no-notices --no-color

$env:CDK_CFN06_TEST_RELEASE = "v2"
npx --no-install cdk --output update.out deploy Cfn06Stack --require-approval never --outputs-file outputs-v2.json --no-notices --no-color

$env:CDK_CFN06_TEST_RELEASE = "fail"
# Expected non-zero after CloudFormation compensates to UPDATE_ROLLBACK_COMPLETE.
npx --no-install cdk --output rollback-fail.out deploy Cfn06Stack --require-approval never --no-notices --no-color

# Restart stacksim with the same data directory and select the restored release.
$env:CDK_CFN06_TEST_RELEASE = "v2"
npx --no-install cdk --output destroy.out destroy Cfn06Stack --force --no-notices --no-color
```

## Frozen synthesized inventory

`v1` and `v2` each synthesize 11 resources. `fail` adds one permission, for 12
resources.

| CloudFormation type | v1 | v2 | fail |
| --- | ---: | ---: | ---: |
| `AWS::CDK::Metadata` | 1 | 1 | 1 |
| `AWS::IAM::Role` | 1 | 1 | 1 |
| `AWS::IAM::Policy` | 1 | 1 | 1 |
| `AWS::IAM::ManagedPolicy` | 1 | 1 | 1 |
| `AWS::Lambda::Function` | 2 | 2 | 2 |
| `AWS::Lambda::Permission` | 1 | 1 | 2 |
| `AWS::Lambda::Version` | 1 | 1 | 1 |
| `AWS::Lambda::Alias` | 1 | 1 | 1 |
| `AWS::Logs::LogGroup` | 2 | 2 | 2 |

The exact common logical IDs are:

```text
BundledAlias861CB90F                 AWS::Lambda::Alias
BundledFunction779AF8D0              AWS::Lambda::Function
BundledFunctionEventsInvoke6A044305  AWS::Lambda::Permission
BundledLogs8D534D85                  AWS::Logs::LogGroup
BundledVersionB6E637E6               AWS::Lambda::Version
CDKMetadata                          AWS::CDK::Metadata
EventPolicyCF688C56                  AWS::IAM::Policy
InlineFunction18B48CA2               AWS::Lambda::Function
InlineLogs3C9EA4A8                   AWS::Logs::LogGroup
StreamPolicyBC48CF2E                 AWS::IAM::ManagedPolicy
WorkloadRoleA63FFF66                 AWS::IAM::Role
```

`fail` additionally emits:

```text
RollbackFailure                      AWS::Lambda::Permission
```

For `v1` and `v2`, the only explicit resource-level dependencies are:

```text
BundledFunction779AF8D0 -> WorkloadRoleA63FFF66
InlineFunction18B48CA2  -> WorkloadRoleA63FFF66
```

The `fail` variant retains those edges and adds dependency-last ordering from
`RollbackFailure` to all ten representative workload resources:
`WorkloadRoleA63FFF66`, `StreamPolicyBC48CF2E`, `EventPolicyCF688C56`,
`InlineLogs3C9EA4A8`, `BundledLogs8D534D85`, `InlineFunction18B48CA2`,
`BundledFunction779AF8D0`, `BundledVersionB6E637E6`,
`BundledAlias861CB90F`, and `BundledFunctionEventsInvoke6A044305`.

## Bootstrap assets and frozen digest corpus

Every release has exactly two file assets and no image assets: the stack
template and the locally esbuild-bundled Lambda ZIP. `Code.fromInline` remains
`Code.ZipFile` in the template and does not add an asset. Standard CDK publishes
the files to the reduced bootstrap's versioned S3 bucket through the
file-publishing role, then deploys through the deployment and CloudFormation
execution roles.

| Release | Template SHA-256 | Asset manifest SHA-256 | File asset IDs (sorted) |
| --- | --- | --- | --- |
| v1 | `a707cb8f9f49b4bc97602845403c97c4256b8417f91070eaa9f0415aafd7c2c5` | `22a116fcac3f8397a0caf01898764042a352362538b1e23c49a805f4fde005bf` | `9b10c0f44fc69e3f7e81d8b9d9c9c096eb210e6aa44673c33133b301f6539f30`, `a707cb8f9f49b4bc97602845403c97c4256b8417f91070eaa9f0415aafd7c2c5` |
| v2 | `00b7d3cdef3322105c1f24cfce7e8e4715b33a533a4cb5504d4f0c445a8074ac` | `b181afa2dc34c37537d4f96ff47ca9ad46f074369e1c31f59801ee4e36f8ba0f` | `00b7d3cdef3322105c1f24cfce7e8e4715b33a533a4cb5504d4f0c445a8074ac`, `1ac5e9b5a25e405916726af422ab74525ea39dee08f535d710911699a8d13f9e` |
| fail | `1539295d792cd08c6aa288fbcffd6de848a3d1762b67a8cb275f007ff6f7cab6` | `410d3fa51636911a95d1078bba0b58e3f29bd8d73d3392a77028587c95a040ed` | `1539295d792cd08c6aa288fbcffd6de848a3d1762b67a8cb275f007ff6f7cab6`, `2461b7c6e32e0d8e9be9bec5d7908bc8081a9e9cbce48c98ae81c235f0ffce13` |

All three releases are frozen by `test/cloudformation-cdk-cfn06.test.ts`,
including the failure release's 12-resource logical/type/dependency corpus.
