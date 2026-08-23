# CloudFront action and resource inventory

Status: CFR-01 frozen inventory, verified 2026-08-22

The source inventory is the installed
`@aws-sdk/client-cloudfront@3.1097.0` declaration corpus. Its package integrity
is `sha512-YZrDIvdLqd53NcodnOQFgLZloA9WB7wj4NHSrf7VAnEaF4VPaw+0iYCLDNwzqk2GuEq4F02Yr+if8I58nukSsA==`.
There are exactly 167 commands, 17 paginators, and four waiters. An upstream
addition must be classified before the inventory lock is updated.

The phase labels are ownership assignments, not current support claims. Only
CFR-01 is implemented by this slice. A later-phase command remains rejected
before mutation.

## Commands

### CFR-01 — 36 commands

`CreateDistribution`, `CreateDistributionWithTags`, `CreateFunction`,
`CreateInvalidation`, `CreateOriginAccessControl`,
`CreateResponseHeadersPolicy`, `DeleteDistribution`, `DeleteFunction`,
`DeleteOriginAccessControl`, `DeleteResponseHeadersPolicy`,
`DescribeFunction`, `GetCachePolicy`, `GetCachePolicyConfig`,
`GetDistribution`, `GetDistributionConfig`, `GetFunction`, `GetInvalidation`,
`GetOriginAccessControl`, `GetOriginAccessControlConfig`,
`GetResponseHeadersPolicy`, `GetResponseHeadersPolicyConfig`,
`ListCachePolicies`, `ListDistributions`, `ListFunctions`,
`ListInvalidations`, `ListOriginAccessControls`,
`ListResponseHeadersPolicies`, `ListTagsForResource`, `PublishFunction`,
`TagResource`, `TestFunction`, `UntagResource`, `UpdateDistribution`,
`UpdateFunction`, `UpdateOriginAccessControl`, and
`UpdateResponseHeadersPolicy`.

Cache-policy reads expose only the two immutable AWS-managed CFR-01 records.
Response-policy and distribution commands accept only their closed CFR-01
profiles. Command ownership does not imply broader property acceptance.

### CFR-02 — 18 commands

`CreateCachePolicy`, `CreateCloudFrontOriginAccessIdentity`,
`CreateOriginRequestPolicy`, `DeleteCachePolicy`,
`DeleteCloudFrontOriginAccessIdentity`, `DeleteOriginRequestPolicy`,
`GetCloudFrontOriginAccessIdentity`,
`GetCloudFrontOriginAccessIdentityConfig`, `GetOriginRequestPolicy`,
`GetOriginRequestPolicyConfig`, `ListCloudFrontOriginAccessIdentities`,
`ListDistributionsByCachePolicyId`,
`ListDistributionsByOriginRequestPolicyId`,
`ListDistributionsByResponseHeadersPolicyId`, `ListOriginRequestPolicies`,
`UpdateCachePolicy`, `UpdateCloudFrontOriginAccessIdentity`, and
`UpdateOriginRequestPolicy`.

### CFR-03 — five commands

`CreateKeyValueStore`, `DeleteKeyValueStore`, `DescribeKeyValueStore`,
`ListKeyValueStores`, and `UpdateKeyValueStore`.

### CFR-04 — 41 commands

`AssociateAlias`, `AssociateDistributionWebACL`,
`CreateFieldLevelEncryptionConfig`, `CreateFieldLevelEncryptionProfile`,
`CreateKeyGroup`, `CreateMonitoringSubscription`, `CreatePublicKey`,
`CreateRealtimeLogConfig`, `DeleteFieldLevelEncryptionConfig`,
`DeleteFieldLevelEncryptionProfile`, `DeleteKeyGroup`,
`DeleteMonitoringSubscription`, `DeletePublicKey`, `DeleteRealtimeLogConfig`,
`DisassociateDistributionWebACL`, `GetFieldLevelEncryption`,
`GetFieldLevelEncryptionConfig`, `GetFieldLevelEncryptionProfile`,
`GetFieldLevelEncryptionProfileConfig`, `GetKeyGroup`, `GetKeyGroupConfig`,
`GetMonitoringSubscription`, `GetPublicKey`, `GetPublicKeyConfig`,
`GetRealtimeLogConfig`, `ListConflictingAliases`,
`ListDistributionsByKeyGroup`, `ListDistributionsByRealtimeLogConfig`,
`ListDistributionsByWebACLId`, `ListFieldLevelEncryptionConfigs`,
`ListFieldLevelEncryptionProfiles`, `ListKeyGroups`, `ListPublicKeys`,
`ListRealtimeLogConfigs`, `UpdateDomainAssociation`,
`UpdateFieldLevelEncryptionConfig`, `UpdateFieldLevelEncryptionProfile`,
`UpdateKeyGroup`, `UpdatePublicKey`, `UpdateRealtimeLogConfig`, and
`VerifyDnsConfiguration`.

### CFR-05 — 67 commands

`AssociateDistributionTenantWebACL`, `CopyDistribution`,
`CreateAnycastIpList`, `CreateConnectionFunction`, `CreateConnectionGroup`,
`CreateContinuousDeploymentPolicy`, `CreateDistributionTenant`,
`CreateInvalidationForDistributionTenant`, `CreateStreamingDistribution`,
`CreateStreamingDistributionWithTags`, `CreateTrustStore`, `CreateVpcOrigin`,
`DeleteAnycastIpList`, `DeleteConnectionFunction`, `DeleteConnectionGroup`,
`DeleteContinuousDeploymentPolicy`, `DeleteDistributionTenant`,
`DeleteResourcePolicy`, `DeleteStreamingDistribution`, `DeleteTrustStore`,
`DeleteVpcOrigin`, `DescribeConnectionFunction`,
`DisassociateDistributionTenantWebACL`, `GetAnycastIpList`,
`GetConnectionFunction`, `GetConnectionGroup`,
`GetConnectionGroupByRoutingEndpoint`, `GetContinuousDeploymentPolicy`,
`GetContinuousDeploymentPolicyConfig`, `GetDistributionTenant`,
`GetDistributionTenantByDomain`, `GetInvalidationForDistributionTenant`,
`GetManagedCertificateDetails`, `GetResourcePolicy`,
`GetStreamingDistribution`, `GetStreamingDistributionConfig`,
`GetTrustStore`, `GetVpcOrigin`, `ListAnycastIpLists`,
`ListConnectionFunctions`, `ListConnectionGroups`,
`ListContinuousDeploymentPolicies`, `ListDistributionTenants`,
`ListDistributionTenantsByCustomization`,
`ListDistributionsByAnycastIpListId`,
`ListDistributionsByConnectionFunction`, `ListDistributionsByConnectionMode`,
`ListDistributionsByOwnedResource`, `ListDistributionsByTrustStore`,
`ListDistributionsByVpcOriginId`, `ListDomainConflicts`,
`ListInvalidationsForDistributionTenant`, `ListStreamingDistributions`,
`ListTrustStores`, `ListVpcOrigins`, `PublishConnectionFunction`,
`PutResourcePolicy`, `TestConnectionFunction`, `UpdateAnycastIpList`,
`UpdateConnectionFunction`, `UpdateConnectionGroup`,
`UpdateContinuousDeploymentPolicy`, `UpdateDistributionTenant`,
`UpdateDistributionWithStagingConfig`, `UpdateStreamingDistribution`,
`UpdateTrustStore`, and `UpdateVpcOrigin`.

The five phase counts sum to 167 and the sets are disjoint.

## Paginators

| Paginator | Phase |
|---|---:|
| `ListDistributions` | CFR-01 |
| `ListInvalidations` | CFR-01 |
| `ListOriginAccessControls` | CFR-01 |
| `ListCloudFrontOriginAccessIdentities` | CFR-02 |
| `ListKeyValueStores` | CFR-03 |
| `ListPublicKeys` | CFR-04 |
| `ListConnectionFunctions` | CFR-05 |
| `ListConnectionGroups` | CFR-05 |
| `ListDistributionTenants` | CFR-05 |
| `ListDistributionTenantsByCustomization` | CFR-05 |
| `ListDistributionsByConnectionFunction` | CFR-05 |
| `ListDistributionsByConnectionMode` | CFR-05 |
| `ListDistributionsByTrustStore` | CFR-05 |
| `ListDomainConflicts` | CFR-05 |
| `ListInvalidationsForDistributionTenant` | CFR-05 |
| `ListStreamingDistributions` | CFR-05 |
| `ListTrustStores` | CFR-05 |

## Waiters

| Waiter | Phase |
|---|---:|
| `DistributionDeployed` | CFR-01 |
| `InvalidationCompleted` | CFR-01 |
| `InvalidationForDistributionTenantCompleted` | CFR-05 |
| `StreamingDistributionDeployed` | CFR-05 |

## IAM-only actions

The implementation-day service-authorization page identifies these
permission-only actions: `AllowVendedLogDeliveryForResource`,
`CreateSavingsPlan`, `GetSavingsPlan`, `ListDistributionsByLambdaFunction`,
`ListRateCards`, `ListSavingsPlans`, `ListUsages`, and `UpdateSavingsPlan`.
They are assigned to CFR-04 for vended logging and Lambda@Edge, and CFR-05 for
commercial/account administration. None is admitted by CFR-01.

CFR-01 uses global `aws:RequestTag/${TagKey}`,
`aws:ResourceTag/${TagKey}`, and `aws:TagKeys` conditions where applicable.
There is no generic verb-derived `cloudfront:GET` or `cloudfront:POST` action.

## CloudFormation resources

CFR-01 owns exactly:

- `AWS::CloudFront::Distribution`
- `AWS::CloudFront::Function`
- `AWS::CloudFront::OriginAccessControl`
- `AWS::CloudFront::ResponseHeadersPolicy`

`AWS::CloudFront::CachePolicy`, `CloudFrontOriginAccessIdentity`, and
`OriginRequestPolicy` are CFR-02. `KeyValueStore` is CFR-03. Public keys, key
groups, realtime logging, monitoring, and security-integration resources are
CFR-04. Anycast, connection, continuous-deployment, tenant, trust-store, VPC
origin, streaming, managed-certificate, SaaS Manager, and newer resource types
are CFR-05 or a separately approved dependency. Until their phase lands they
must remain unknown to CloudFormation before stack mutation.

## Authoritative evidence

- [CloudFront service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html)
- [CloudFront API reference](https://docs.aws.amazon.com/cloudfront/latest/APIReference/Welcome.html)
- Installed SDK declaration files under `node_modules/@aws-sdk/client-cloudfront/dist-types/`

