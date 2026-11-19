# Pinned public React S3 deployment fixture

This is an ordinary TypeScript AWS CDK v2 application. It uses the unmodified default synthesizer with the repository compatibility baseline:

- `cdk@2.1144.0`
- `aws-cdk-lib@2.273.0`
- `constructs@10.7.1`

`frontend/build.mjs` bundles the small React application into deterministic `dist/index.html`, `dist/assets/app.js`, `dist/assets/app.css`, and build-marker files. `REACT_FIXTURE_VARIANT=v2` changes real application bytes and omits `obsolete.txt` so update and `prune: true` behavior can be tested. `CDK_FRONTEND_PREFIX` optionally selects a destination prefix.

## Frozen assembly

`expected-assembly.json` is the machine-readable contract. It freezes the template, asset-manifest, cloud-assembly, and tree SHA-256 values plus the asset identities. The current v1 identities are:

| Artifact | SHA-256 / asset ID |
|---|---|
| Stack template | `c5090e1a6e201a2ce97d91a5d90259ae8ee093e99dffd797cc98303b0dc2ca69` |
| Asset manifest | `d264aac8cec7de2be002ba619c9abd72ef4763e8ccf27703362a2055505da713` |
| Cloud assembly | `146f1acb7bde0a20dcbb8147d72fb048562a918dca4e07dbc67dc42557c0f363` |
| React build ZIP | `c33c74ebfe63491213ee51f5f01cd1cfcd661703cca2fbc78c0d182850c1a6a3` |
| CDK bucket-deployment handler ZIP | `35328da138f26fbd9160297abc9a2522d93dbf75878cd5114a9c050419fc1ce0` |
| CDK AWS CLI layer ZIP | `98f62bef9320f8c0a0a7be21d7c746f069131f196f51ffe3008a6bb730b368ec` |

The pinned template contains exactly eight resources:

| Logical ID | Type | Important emitted contract |
|---|---|---|
| `FrontendBucketEFE2E19C` | `AWS::S3::Bucket` | SSE-S3/AES256, versioning enabled, `BlockPublicAcls`/`IgnorePublicAcls` true, ownership tag, index document, retain policies |
| `FrontendBucketPolicy1DFF75D9` | `AWS::S3::BucketPolicy` | One public `s3:GetObject` allow for the application bucket's `/*` ARN |
| `DeployFrontendAwsCliLayerD774ED8F` | `AWS::Lambda::LayerVersion` | Bootstrap asset `98f6…68ec.zip`, description `/opt/awscli/aws` |
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
