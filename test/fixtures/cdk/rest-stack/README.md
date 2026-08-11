# REST CDK acceptance fixture

This ordinary TypeScript CDK v2 application uses the default synthesizer and
standard constructs only. `RestStack` is the CFN-08 acceptance application;
`PlainRestStack` independently covers `apigateway.RestApi`; and `RetainStack`
proves a real retained DynamoDB resource. No stacksim construct, wrapper, or
template rewrite is involved.

## Pinned toolchain and context

- `cdk` 2.1132.0
- `aws-cdk-lib` 2.261.0
- `constructs` 10.7.1
- `tsx` 4.23.1
- CDK context: `@aws-cdk/core:newStyleStackSynthesis=true`
- account `000000000000`, Region `eu-west-1`, qualifier `hnb659fds`

Every subprocess uses standard credentials and `AWS_ENDPOINT_URL`, and loads
`../network-tripwire.cjs`, which permits only the selected loopback simulator
port.

## Stack variants and lifecycle commands

`CDK_REST_TEST_VERSION` selects the `RestStack` release:

| Value | Purpose |
| --- | --- |
| `v1` | Baseline alias-backed Lambda REST CRUD API, DynamoDB stream/TTL/GSI, scoped role policy, explicit Logs group, outputs, and default API Gateway account role. |
| `code-v2` | Changes only the Lambda file asset/current version and advances the stable `live` alias; the API deployment and table identities must not change. |
| `api-v2` | Keeps the v2 code, changes the API description, and adds `/health`, producing a separate immutable deployment. |
| `v3` | Adds the supported `byCategory` GSI and warm throughput in place. |
| `ddb-invalid` | Applies an earlier DynamoDB mutation, then deliberately fails a composite table update for explicit CDK rollback coverage. |
| `api-invalid` | Adds a duplicate POST method after earlier mutations so default change-set execution automatically rolls back. |

`CDK_RECOVERY_MATRIX=1` is an independent, recovery-test-only switch. It adds
standard CDK constructs for the eight production provider types not otherwise
present in `RestStack`: IAM managed policy plus API Gateway API key,
authorizer, gateway response, model, request validator, usage plan, and usage
plan key. Combined with the ordinary `v3` stack, this gives Scenario C one
resource of every current CFN-01 through CFN-08 production provider type while
leaving all default fixture variants and their frozen digests unchanged.

The tested standard command sequence is:

```powershell
$env:CDK_REST_TEST_VERSION = "v1"
npx --no-install cdk --output initial-diff.out diff RestStack --method template --no-notices --no-color
npx --no-install cdk --output create.out deploy RestStack --require-approval never --outputs-file outputs.json --no-notices --no-color

$env:CDK_REST_TEST_VERSION = "code-v2"
npx --no-install cdk --output diff.out diff RestStack --method change-set --no-notices --no-color
npx --no-install cdk --output code-update.out deploy RestStack --require-approval never --no-notices --no-color

$env:CDK_REST_TEST_VERSION = "api-v2"
npx --no-install cdk --output api-update.out deploy RestStack --require-approval never --no-notices --no-color

$env:CDK_REST_TEST_VERSION = "v3"
npx --no-install cdk --output table-update.out deploy RestStack --require-approval never --no-notices --no-color
npx --no-install cdk --output destroy.out destroy RestStack --force --no-notices --no-color

npx --no-install cdk --output plain.out deploy PlainRestStack --require-approval never --no-notices --no-color
npx --no-install cdk --output plain-destroy.out destroy PlainRestStack --force --no-notices --no-color
npx --no-install cdk --output retain.out deploy RetainStack --require-approval never --no-notices --no-color
npx --no-install cdk --output retain-destroy.out destroy RetainStack --force --no-notices --no-color
```

The test also runs ordinary and forced no-op deploys, bare/default change-set
diff, `cdk rollback --yes`, restart with the same data directory, public and
SigV4 REST invocations, and authoritative SDK reads before destruction.

## Frozen synthesized inventory

The v1 `RestStack` has 31 resources:

| CloudFormation type | Count |
| --- | ---: |
| `AWS::ApiGateway::Account` | 1 |
| `AWS::ApiGateway::Deployment` | 1 |
| `AWS::ApiGateway::Method` | 5 |
| `AWS::ApiGateway::Resource` | 3 |
| `AWS::ApiGateway::RestApi` | 1 |
| `AWS::ApiGateway::Stage` | 1 |
| `AWS::CDK::Metadata` | 1 |
| `AWS::DynamoDB::Table` | 1 |
| `AWS::IAM::Policy` | 1 |
| `AWS::IAM::Role` | 2 |
| `AWS::Lambda::Alias` | 1 |
| `AWS::Lambda::Function` | 1 |
| `AWS::Lambda::Permission` | 10 |
| `AWS::Lambda::Version` | 1 |
| `AWS::Logs::LogGroup` | 1 |

With `CDK_REST_TEST_VERSION=v3` and `CDK_RECOVERY_MATRIX=1`, `RestStack` has
48 resources across exactly these 23 production provider types:

| CloudFormation type | Count |
| --- | ---: |
| `AWS::ApiGateway::Account` | 1 |
| `AWS::ApiGateway::ApiKey` | 1 |
| `AWS::ApiGateway::Authorizer` | 1 |
| `AWS::ApiGateway::Deployment` | 1 |
| `AWS::ApiGateway::GatewayResponse` | 1 |
| `AWS::ApiGateway::Method` | 7 |
| `AWS::ApiGateway::Model` | 1 |
| `AWS::ApiGateway::RequestValidator` | 1 |
| `AWS::ApiGateway::Resource` | 5 |
| `AWS::ApiGateway::RestApi` | 1 |
| `AWS::ApiGateway::Stage` | 1 |
| `AWS::ApiGateway::UsagePlan` | 1 |
| `AWS::ApiGateway::UsagePlanKey` | 1 |
| `AWS::CDK::Metadata` | 1 |
| `AWS::DynamoDB::Table` | 1 |
| `AWS::IAM::ManagedPolicy` | 1 |
| `AWS::IAM::Policy` | 1 |
| `AWS::IAM::Role` | 2 |
| `AWS::Lambda::Alias` | 1 |
| `AWS::Lambda::Function` | 1 |
| `AWS::Lambda::Permission` | 15 |
| `AWS::Lambda::Version` | 1 |
| `AWS::Logs::LogGroup` | 1 |

`test/cloudformation-cdk-recovery-matrix.test.ts` asserts that this distinct
type set exactly matches the public production registry, pauses after a
create-complete checkpoint for every type, and verifies all 48 logical
resources remain singly owned after the repeated restarts. This conditional
variant freezes the following `v3` recovery corpus:

| Recovery artifact | SHA-256 |
| --- | --- |
| `RestStack.template.json` | `493752b472b79e4cf99463ddb0ee5b12f7a9ad5ad850c5dcf8dab664f8cdbfb9` |
| `RestStack.assets.json` | `34bc43113eb60ff15de3d605fcb95bfb6062e87a17d17efbc9e02cd8bd2f9e05` |
| `manifest.json` | `55ed54df4a1d92d23422792cffbc071f557a09afc0fb2ce599e2524d114213e0` |

The exact v1 logical IDs are:

```text
ApiAccountA18C9B29
ApiCloudWatchRole73EC6FC4
ApiDeploymentB17BE62D060ecbdc8aa2b04d16c338ab09bf74a3
ApiDeploymentStageprod3EB9684E
ApiF70053CD
Apiitems8F0ED6C4
ApiitemsPOST55EC2F9D
ApiitemsPOSTApiPermissionRestStackApi4D04A11FPOSTitems3D0067B0
ApiitemsPOSTApiPermissionTestRestStackApi4D04A11FPOSTitemsB20E6465
ApiitemsidDELETE8DBAEF8D
ApiitemsidDELETEApiPermissionRestStackApi4D04A11FDELETEitemsid491BE8D9
ApiitemsidDELETEApiPermissionTestRestStackApi4D04A11FDELETEitemsidED9A18CB
ApiitemsidE0B74190
ApiitemsidGET54650149
ApiitemsidGETApiPermissionRestStackApi4D04A11FGETitemsid2A370523
ApiitemsidGETApiPermissionTestRestStackApi4D04A11FGETitemsidF847090B
ApiitemsidPUT97D4F737
ApiitemsidPUTApiPermissionRestStackApi4D04A11FPUTitemsid02EE60D5
ApiitemsidPUTApiPermissionTestRestStackApi4D04A11FPUTitemsid95A4FB92
Apisecure35752B8A
ApisecureGET838F83B5
ApisecureGETApiPermissionRestStackApi4D04A11FGETsecure2C169696
ApisecureGETApiPermissionTestRestStackApi4D04A11FGETsecureB68E4E01
CDKMetadata
Handler886CB40B
HandlerCurrentVersion93FB80BF1d702938d55601977e7659c1a8b84d4c
HandlerLogs6FD01908
HandlerServiceRoleDefaultPolicyCBD0CC91
HandlerServiceRoleFCDC14AE
Items5C12978B
Live848578DF
```

All ten invoke/test-invoke permissions and all five integrations target
`Live848578DF`. The deployment depends exactly on the five methods and three
resources; the stage depends on the account, the account on the API, and the
function on its role and scoped policy. These explicit dependencies and the
complete type/count corpus are assertions in
`test/cloudformation-cdk-rest-stack.test.ts`.

`PlainRestStack` contains one each of RestApi, Resource, Method, Deployment,
Stage, Account, Lambda Function, and CDK Metadata, plus two IAM roles and two
Lambda permissions. Its deployment depends exactly on `ApiplainAFDDA460` and
`ApiplainGETF975BEAF`. `RetainStack` contains `RetainedItems157B3A11` and
`CDKMetadata`, with both deletion policies set to `Retain`.

## Bootstrap assets and frozen digests

`RestStack` v1 publishes the handler ZIP and stack template through the
standard file-publishing role. `PlainRestStack` uses inline Lambda code and
publishes only its template; `RetainStack` likewise publishes only its
template. No image asset is present.

| Stack/artifact | SHA-256 |
| --- | --- |
| `RestStack.template.json` | `4075c15e1d39db5fe0e75299cbcb111e7d53f6bad413c0874bbddbc6fbc68874` |
| v1 `manifest.json` | `72731a1d30a04f1b1704590833d623b39786f0d2f714b23109583dcc485a4a74` |
| `RestStack.assets.json` | `8fc176f42621e1e67df361d8ae4e1861e656d22d5204aeae126c4a011f93a62b` |
| `PlainRestStack.template.json` | `3ebbdd2c383af606cbe50858c464bacf6605005cdbd64ede1b035a66ac7229ce` |
| `PlainRestStack.assets.json` | `fd6edb7c569cbebdc42901846c417b5fd350b0ddaff38a281d6461d3f175d6ea` |
| `RetainStack.template.json` | `ffc56c9658de57462a8e8367149510e99dd2ca5ec7ec3d4ab89fa7070a773474` |
| `RetainStack.assets.json` | `c1955b7b6512e70c35d702d2d5d9451666a6f7bdff3b08df1bdbd4d25010b012` |
