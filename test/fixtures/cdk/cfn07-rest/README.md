# CFN-07 standard-CDK fixture

This ordinary CDK v2 application uses `SpecRestApi` with
`ApiDefinition.fromAsset` and explicitly exercises every one of the 13 CFN-07
API Gateway providers. It also freezes the Lambda/IAM dependencies and the
three permissions emitted for deployed invoke, test invoke, and authorizer
invoke. There is no stacksim construct, wrapper, or template rewrite.

## Pinned toolchain and context

- `cdk` 2.1132.0
- `aws-cdk-lib` 2.265.0
- `constructs` 10.7.1
- `tsx` 4.23.1
- CDK context: `@aws-cdk/core:newStyleStackSynthesis=true`
- account `000000000000`, Region `eu-west-1`, qualifier `hnb659fds`

Every deploy subprocess uses standard credentials and `AWS_ENDPOINT_URL`, and
loads `../network-tripwire.cjs`, which permits only the selected loopback
simulator port. Synthesis is local and needs no endpoint.

## Release variants and commands

- `CDK_CFN07_RELEASE=v1` publishes OpenAPI version 1.0.0 and creates the stack.
- `v2` publishes changed OpenAPI/configuration and updates the same resources.
- `broken` deliberately gives the usage plan an absent API stage; the failure
  occurs after representative mutations and must roll the stack back to v2.

```powershell
$env:CDK_DEFAULT_ACCOUNT = "000000000000"
$env:CDK_DEFAULT_REGION = "eu-west-1"
$env:CDK_CFN07_RELEASE = "v1"
npx --no-install cdk --output synth-v1.out synth Cfn07Stack --no-notices --no-color
npx --no-install cdk --output create.out deploy Cfn07Stack --require-approval never --outputs-file outputs.json --no-notices --no-color

$env:CDK_CFN07_RELEASE = "v2"
npx --no-install cdk --output update.out deploy Cfn07Stack --require-approval never --no-notices --no-color

$env:CDK_CFN07_RELEASE = "broken"
# Expected non-zero followed by UPDATE_ROLLBACK_COMPLETE.
npx --no-install cdk --output broken.out deploy Cfn07Stack --require-approval never --no-notices --no-color

# Restart stacksim with the same data directory before the final read/destroy checks.
$env:CDK_CFN07_RELEASE = "v2"
npx --no-install cdk --output destroy.out destroy Cfn07Stack --force --no-notices --no-color
```

## Frozen synthesized inventory

The v1 assembly contains 20 resources. Each API Gateway type below has count
one: `Account`, `ApiKey`, `Authorizer`, `Deployment`, `GatewayResponse`,
`Method`, `Model`, `RequestValidator`, `Resource`, `RestApi`, `Stage`,
`UsagePlan`, and `UsagePlanKey`. It also contains one `AWS::CDK::Metadata`, two
`AWS::IAM::Role`, one `AWS::Lambda::Function`, and three
`AWS::Lambda::Permission` resources.

The exact logical ID/type corpus is:

```text
ApiGatewayAccount                                                     AWS::ApiGateway::Account
ApiGatewayAccountRoleC18DC09B                                         AWS::IAM::Role
AssetApi95634D48                                                      AWS::ApiGateway::RestApi
AssetApiAccessDeniedResponse4E95FE88                                  AWS::ApiGateway::GatewayResponse
AssetApiClientPlanD96FF8B9                                            AWS::ApiGateway::UsagePlan
AssetApiClientPlanUsagePlanKeyResourceCfn07StackClientKey8A39C768FC397D51 AWS::ApiGateway::UsagePlanKey
AssetApilambda611194AA                                                AWS::ApiGateway::Resource
AssetApilambdaPOSTApiPermissionCfn07StackAssetApi06BFDD54POSTlambda84D554AF AWS::Lambda::Permission
AssetApilambdaPOSTApiPermissionTestCfn07StackAssetApi06BFDD54POSTlambdaE12EE498 AWS::Lambda::Permission
AssetApilambdaPOSTF1764C38                                            AWS::ApiGateway::Method
BackendCfn07StackTokenAuthorizer7AF7DF4CPermissionsC1E0F3FD           AWS::Lambda::Permission
BackendEC8447F5                                                       AWS::Lambda::Function
BackendServiceRole02B059A1                                            AWS::IAM::Role
BodyValidator875B4CA1                                                 AWS::ApiGateway::RequestValidator
CDKMetadata                                                          AWS::CDK::Metadata
ClientKey8E681D3D                                                     AWS::ApiGateway::ApiKey
Deployment37BBD5E43fa939113aac17cdff05159a775231f4                    AWS::ApiGateway::Deployment
PayloadModel6D24568D                                                  AWS::ApiGateway::Model
Stage0E8C2AF5                                                        AWS::ApiGateway::Stage
TokenAuthorizer82AECDDC                                               AWS::ApiGateway::Authorizer
```

The Lambda function explicitly depends on `BackendServiceRole02B059A1`.
`ApiGatewayAccount` depends on `ApiGatewayAccountRoleC18DC09B`. The deployment
depends exactly on the deployed permission, test-invoke permission, and method:

```text
AssetApilambdaPOSTApiPermissionCfn07StackAssetApi06BFDD54POSTlambda84D554AF
AssetApilambdaPOSTApiPermissionTestCfn07StackAssetApi06BFDD54POSTlambdaE12EE498
AssetApilambdaPOSTF1764C38
```

Property references provide the remaining ordering. The test additionally
asserts that every permission targets `BackendEC8447F5`, classifies the exact
permission categories, links the authorizer and method, and verifies all 13
authoritative backing resources through the API Gateway SDK.

## Bootstrap assets and frozen digests

The v1 asset manifest contains exactly two file assets and no image assets:
the OpenAPI JSON object
`b62a0fbaffeda5fccbb297eff1b7b6bcda59486797fb317c784eedcd554766fd`
and the stack template. Standard CDK publishes both through the reduced
bootstrap file-publishing role. The provider consumes the version-pinned
OpenAPI object through `BodyS3Location`; it is never inlined or fetched from an
external host.

| Artifact | SHA-256 |
| --- | --- |
| `Cfn07Stack.template.json` | `45c23ecca43f45aa9bb97a90087abe88e9b097e01fa6e649707227ee3ed6a546` |
| `manifest.json` | `a824e4b2d66f7a1a2104156f1de4a33820fc57847c08d5b75a3a8ba893da69e4` |
| `Cfn07Stack.assets.json` | `9b28ed2122c4ddf917ef1b8195f39b2ebd6e4f58ee484f4a6d4047fbe01850ab` |
