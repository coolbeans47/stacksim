# CloudFront CFR-01 compatibility manifest

Status: CFR-01 implementation contract, frozen 2026-08-22

This manifest records the exact private-S3 website slice. It is intentionally
narrower than the CloudFront namespace. Fields, actions, resource types, and
origins not named here remain unsupported before mutation.

## Version and supply-chain lock

| Component | Version / identity |
|---|---|
| CloudFront REST/XML API | `2020-05-31` |
| SigV4 service | `cloudfront` |
| SDK | `@aws-sdk/client-cloudfront@3.1097.0` |
| SDK integrity | `sha512-YZrDIvdLqd53NcodnOQFgLZloA9WB7wj4NHSrf7VAnEaF4VPaw+0iYCLDNwzqk2GuEq4F02Yr+if8I58nukSsA==` |
| CDK library | `aws-cdk-lib@2.265.0` |
| fixture CLI | `cdk@2.1132.0` |
| fixture constructs | `constructs@10.7.1` |
| assembly schema | `54.0.0`, minimum CLI `2.1138.0` |
| guest engine | `quickjs-emscripten-core@0.32.0` |
| guest WASM | `@jitl/quickjs-wasmfile-release-sync@0.32.0` |

The runtime packages are exact pins. The WASM guest has no host import bridge;
each invocation gets a fresh worker, runtime, and context. Customer code is
never evaluated with host `eval`, `Function`, or `node:vm`.

## Identity and endpoints

- Resources are account-global; request-signing Region does not partition
  state.
- ARNs omit Region:
  `arn:aws:cloudfront::<account>:distribution/<id>`, `function/<name>`,
  `origin-access-control/<id>`, `response-headers-policy/<id>`, and
  `cache-policy/<id>`.
- Distribution IDs and canonical `d<label>.cloudfront.net` domains are
  independent persisted values.
- `DomainName` always remains canonical. Local reachability is separately
  reported as `https://d<label>.localhost:<persisted-port>/`.
- No DNS, hosts file, port 443, ACM resource, or system trust store is changed.

## REST/XML routes

All routes use namespace
`http://cloudfront.amazonaws.com/doc/2020-05-31/`.

| Family | Routes |
|---|---|
| Distribution | `POST|GET /2020-05-31/distribution`; `GET|DELETE /distribution/{Id}`; `GET|PUT /distribution/{Id}/config` |
| Function | `POST|GET /function`; `GET|PUT|DELETE /function/{Name}`; `GET /describe`; `POST /publish`; `POST /test` |
| OAC | `POST|GET /origin-access-control`; `GET|DELETE /{Id}`; `GET|PUT /{Id}/config` |
| Response policy | `POST|GET /response-headers-policy`; `GET|DELETE /{Id}`; `GET|PUT /{Id}/config` |
| Invalidation | `POST|GET /distribution/{Id}/invalidation`; `GET /distribution/{Id}/invalidation/{InvalidationId}` |
| Managed cache | `GET /cache-policy`; `GET /cache-policy/{Id}`; `GET /cache-policy/{Id}/config` |
| Tags | `GET /tagging?Resource=...`; mutation uses the modeled tagging operation query |

`CreateDistributionWithTags` uses the create route with the SDK-emitted tagged
root document. Function code is base64 in create/update XML; `GetFunction`
returns raw bytes with `application/octet-stream` and ETag. Errors use the
CloudFront XML `ErrorResponse` envelope.

Opening modeled errors include missing-resource errors, `PreconditionFailed`,
`InvalidIfMatchVersion`, `DistributionAlreadyExists`,
`InvalidationBatchAlreadyExists`, `DistributionNotDisabled`, `FunctionInUse`,
`OriginAccessControlInUse`, `ResponseHeadersPolicyInUse`, `InvalidArgument`,
`InvalidFunctionAssociation`, `InvalidOriginAccessControl`,
`IllegalOriginAccessConfiguration`, `InconsistentQuantities`, and bounded
function/path/capacity failures.

## Managed policies

| Name | ID | Min/default/max TTL |
|---|---|---|
| `Managed-CachingDisabled` | `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` | `0 / 0 / 0` |
| `Managed-CachingOptimized` | `658327ea-f89d-4fab-a63d-7e88639e58f6` | `1 / 86400 / 31536000` |

Both exclude cookies, query strings, and viewer headers. Optimized caching
normalizes admitted gzip and Brotli variants. Disabled caching never stores an
entry.

## Function runtime limits

| Limit | CFR-01 value |
|---|---:|
| Runtime | `cloudfront-js-1.0` |
| Code | 10 KiB UTF-8 |
| Event | 40 KiB JSON |
| Output | 40 KiB JSON |
| Guest memory | 16 MiB |
| Guest instruction/deadline window | 50 ms |
| Parent worker deadline | 3 seconds |
| Guest stack | 512 KiB |
| URI | 8 KiB |
| Headers | 100; 8 KiB per value |

The method is immutable, returned URIs begin with `/`, headers are lowercase,
and invalid or oversized output fails the viewer request without origin access.
`process`, loaders, filesystem, network, timers, workers, native addons, and
nested WebAssembly are unavailable.

## Viewer and cache limits

- One same-account simulator-owned regional S3 origin per distribution.
- Methods: GET, HEAD, OPTIONS; opening OPTIONS reaches S3 CORS evaluation and
  does not read an object.
- Additional behaviors are ordered `assets/*`, then `runtime-config.json`;
  otherwise the default behavior is selected before Function rewriting.
- Automatic compression applies to admitted text/JavaScript/JSON/XML/WASM/SVG
  content from 1,000 bytes through 10 MiB when no origin encoding exists.
- Origin response body ceiling is 10 MiB.
- Cache ceiling: 1,000 entries and 128 MiB with deterministic LRU eviction.
- Invalidation accepts 1–3,000 leading-slash paths, up to 4,000 bytes each;
  only a final `*` is wildcard. A generation fence prevents stale fill publish.
- Cache entries are derived and may cold-start after restart. Control records
  and invalidation history remain durable.

The response pipeline is behavior selection, trusted-scheme redirect/method
check, default root, LIVE viewer-request Function, cache lookup, OAC-authorized
S3 origin, compression, security response policy, then diagnostics. HEAD emits
GET-equivalent headers with no body.

## OAC/S3 contract

Only `s3` + `always` + `sigv4` is admitted. The origin uses an empty legacy
origin-access identity and a simulator-owned `RegionalDomainName`. GET/HEAD is
authorized by S3 as principal `cloudfront.amazonaws.com`, action
`s3:GetObject`, exact object ARN, exact distribution source ARN, source account,
secure transport, and actual bucket Region. Direct anonymous reads, missing or
wrong policy context, explicit deny, cross-account origins, website endpoints,
and arbitrary hosts fail closed.

The bucket profile is AES256 SSE-S3, `BucketOwnerEnforced`, and all four public
access blocks true. The steady policy contains exactly TLS deny, generated
auto-delete grant, and the OAC allow. Only the attested auto-delete cleanup may
temporarily add its exact `Deny s3:PutObject` object statement.

## BucketDeployment profile

- One or more equal-length pinned source bucket/key arrays; the opening app
  deployment has two and assets has one. CFR-01 admits 1 through 32 sources,
  at most 128 MiB of combined source archives, 256 MiB/10,000 entries of
  combined expanded input, 64 MiB per object, 10,000 merged/destination
  objects, and 256 S3 mutations per continuation callback.
- Sources extract and overlay in declared order. Markers apply to only their
  source. Opening `SourceMarkersConfig` entries are empty and `jsonEscape`
  therefore remains false. Tokens use exact grammar
  `<<marker:0x[a-f0-9]{4}:[0-9]+>>`, are globally unique, occur exactly once
  in their corresponding source, and are limited to 256 per source, 128 UTF-8
  token bytes, and 16 KiB of resolved scalar-string replacement bytes. Unknown,
  repeated, missing, and leftover marker forms reject before S3 mutation.
- Only lowercase `cache-control` system metadata is admitted, limited to 1,024
  UTF-8 bytes with CR/LF rejected.
- `Prune=true` is whole-prefix `sync --delete`; there is no per-deployment
  ownership exemption. `Prune=false` retains omitted destination objects.
- Metadata-only desired changes do not force transfer of unchanged bytes.
- Distribution input requires `WaitForDistributionInvalidation=true` and
  1 through 3,000 paths. Each path starts with `/`, is at most 4,000 UTF-8
  bytes, and permits `*` only as its final character. The fixture uses `/*`.
- `OutputObjectKeys=true` returns the original ordered source keys.
  `DestinationBucketArn` is emitted only when supplied.
- Omitted `RetainOnDelete` means true. Destination bytes remain, while a
  configured delete invalidation still occurs and is awaited.
- Pins and checkpoints include logical ID, property path, and source index.
  Rollback uses prior pinned archives and performs its own invalidation.
- Invalidation caller references are
  `stacksim-<phase>-sha256(resourceOperationId NUL logicalId NUL phase)`, where
  phase is `create`, `update`, `rollback`, or `delete`. The durable intent is
  saved before create; the returned invalidation ID is then saved and polled
  with `GetInvalidation` until `Completed`.

## Fixture and provenance

The portable fixture is under `test/fixtures/cdk/cloudfront-website/`. Its
semantic lock proves a 17-resource Web stack, two output producers, four
unique exports/five imports, helper attestation, two deployment shapes, and
canonical output. Runtime expectations live in `expected-runtime.json`.

Read-only Shipments provenance, never loaded by tests:

| Artifact | SHA-256 |
|---|---|
| Web template | `285f0651ec5e39eeb3724d528a91d2d755fbc502e138592da803ac658564ea57` |
| Web assets manifest | `e8f4aa0931f8712ed39caa8a60c8cef4d91f8422adb631e42e246421596dfb32` |
| Assembly manifest | `59b74b47a9fa957acae0c4b9b3988dedf5a733a4ef1941edd3510180720e360b` |
| Auto-delete helper | `faa95a81ae7d7373f3e1f242268f904eb748d8d0fdd306e8a6fe515a1905a7d6` |
| AWS CLI layer | `98f62bef9320f8c0a0a7be21d7c746f069131f196f51ffe3008a6bb730b368ec` |
| BucketDeployment helper | `97e9ebf0b174a5c8f7faa505739022b7f509edddffcab9211dcd08b759944c4f` |
| Inline Function | `a800e67a67d669aebb2aade8fcd0fd9621be694d31addf6607ac593c4d178e2c` |

Unsupported aliases/certificates, custom or public origins, WAF, logging,
Lambda@Edge, runtime 2.0, KVS, mutable customer cache policies, and every later
CloudFront resource continue to reject before mutation.
