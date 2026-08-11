# Pinned public React S3 deployment fixture

This is an ordinary TypeScript AWS CDK v2 application. It uses the unmodified default synthesizer with the repository compatibility baseline:

- `cdk@2.1132.0`
- `aws-cdk-lib@2.261.0`
- `constructs@10.7.1`

`frontend/build.mjs` bundles the small React application into deterministic `dist/index.html`, `dist/assets/app.js`, `dist/assets/app.css`, and build-marker files. `REACT_FIXTURE_VARIANT=v2` changes real application bytes and omits `obsolete.txt` so update and `prune: true` behavior can be tested. `CDK_FRONTEND_PREFIX` optionally selects a destination prefix.

## Frozen assembly

`expected-assembly.json` is the machine-readable contract. It freezes the template, asset-manifest, cloud-assembly, and tree SHA-256 values plus the asset identities. The current v1 identities are:

| Artifact | SHA-256 / asset ID |
|---|---|
| Stack template | `2585c1327a92f71078ab1ad2501281d63cc3d582aceafabc3f6ff5697c915d3c` |
| Asset manifest | `b341c5d42b21330ea549ffa0759100a70e4452a332e7e84cfa103c4a9b511430` |
| Cloud assembly | `7a69f762287efa2b8de229d9071eb90d9078f977325aced9299d4e8c09557b22` |
| React build ZIP | `14e2d1e5a545b4a88a68ea09293196666f6aea3e4c29e61469ef30d8883a6691` |
| CDK bucket-deployment handler ZIP | `97e9ebf0b174a5c8f7faa505739022b7f509edddffcab9211dcd08b759944c4f` |
| CDK AWS CLI layer ZIP | `a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023` |

The pinned template contains exactly eight resources:

| Logical ID | Type | Important emitted contract |
|---|---|---|
| `FrontendBucketEFE2E19C` | `AWS::S3::Bucket` | SSE-S3/AES256, versioning enabled, `BlockPublicAcls`/`IgnorePublicAcls` true, ownership tag, index document, retain policies |
| `FrontendBucketPolicy1DFF75D9` | `AWS::S3::BucketPolicy` | One public `s3:GetObject` allow for the application bucket's `/*` ARN |
| `DeployFrontendAwsCliLayerD774ED8F` | `AWS::Lambda::LayerVersion` | Bootstrap asset `a725…9023.zip`, description `/opt/awscli/aws` |
| `DeployFrontendCustomResource3E02C3B7` | `Custom::CDKBucketDeployment` | One React source ZIP, separate destination bucket, wait flag true, prune true, output keys true |
| `CustomCDKBucketDeployment…ServiceRole89A01265` | `AWS::IAM::Role` | Lambda trust and basic-execution managed policy |
| `CustomCDKBucketDeployment…ServiceRoleDefaultPolicy88902FDF` | `AWS::IAM::Policy` | Generated source-read and destination read/write/prune permissions |
| `CustomCDKBucketDeployment…81C01536` | `AWS::Lambda::Function` | Python 3.13, `index.handler`, 900 seconds, AWS CLI layer, pinned helper code and CA-bundle environment |
| `CDKMetadata` | `AWS::CDK::Metadata` | Standard CDK analytics metadata |

The helper Lambda explicitly depends on its role and inline policy; intrinsic references establish the bucket, layer, role, helper, and custom-resource ordering. Outputs are `FrontendBucketName` and the simulator-backed `FrontendWebsiteUrl`.

## Run locally

Start stacksim with its reduced bootstrap enabled, and use only the standard endpoint variables:

```powershell
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
$env:AWS_REGION = "eu-west-1"
$env:AWS_DEFAULT_REGION = "eu-west-1"
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:CDK_DEFAULT_ACCOUNT = "000000000000"
$env:CDK_DEFAULT_REGION = "eu-west-1"

Set-Location frontend
npm run build
Set-Location ..
npx --no-install cdk synth ReactBucketStack
npx --no-install cdk diff ReactBucketStack --method template
npx --no-install cdk deploy ReactBucketStack --require-approval never --outputs-file cdk-outputs.json
```

Use the official S3 client/CLI against the same endpoint to read `index.html`, `assets/app.js`, and `assets/app.css`; open `FrontendWebsiteUrl` for anonymous index-document hosting. The bootstrap and application buckets are distinct. Stack destroy deletes the normal bucket-policy resource but retains the nonempty application bucket and deployed objects because the bucket uses `RemovalPolicy.RETAIN` and the pinned deployment helper defaults to retain-on-delete.

The fixture does not claim CloudFront, `autoDeleteObjects`, ACL hosting, CORS, lifecycle, replication, notifications, KMS/DSSE, Object Lock, access points, arbitrary bucket policies, arbitrary custom resources, or the full S3 CloudFormation surface.
