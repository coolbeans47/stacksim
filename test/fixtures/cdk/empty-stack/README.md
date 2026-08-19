# Empty CDK compatibility fixture

This is an ordinary TypeScript CDK v2 application using the default
synthesizer and no fixture-local dependencies. It probes CLI/endpoint,
bootstrap, change-set, no-op, arbitrary file-asset, and destroy behavior with
the smallest possible templates.

## Pinned toolchain and context

- `cdk` 2.1132.0
- `aws-cdk-lib` 2.265.0
- `constructs` 10.7.1
- `tsx` 4.23.1
- `esbuild` 0.28.1 (repository pin used by `tsx`; no workload bundling)
- CDK context: `@aws-cdk/core:newStyleStackSynthesis=true`
- Frozen environment: account `000000000000`, Region `eu-west-1`, qualifier
  `hnb659fds`

Tests invoke the repository packages with `npx --no-install`. Their network
tripwire permits only the temporary loopback simulator endpoint.

## Variants and tested commands

| Variant | Selection | Purpose |
| --- | --- | --- |
| default | No fixture variable | Local synth/diff, direct deploy, default change-set deploy, no-op, and destroy. |
| analytics | `CDK_TEST_ANALYTICS=v1`, then `v2`, then `v3` | Adds a mutable metadata probe and output for create, update, change-set diff, prepare/execute, and no-op workflows. |
| generic file | `CDK_GENERIC_ASSET=true` | Adds `asset.txt` as an arbitrary bootstrap file asset and exposes its bucket, key, and hash. |

The command corpus includes:

```powershell
npx --no-install cdk --output synth.out synth EmptyStack --no-notices --no-color
npx --no-install cdk --output diff.out diff EmptyStack --method template --no-notices --no-color
npx --no-install cdk --output direct.out deploy EmptyStack --method direct --require-approval never --no-notices --no-color
npx --no-install cdk --output default.out deploy EmptyStack --require-approval never --no-notices --no-color
npx --no-install cdk --output diff-change-set.out diff EmptyStack --method change-set --no-notices --no-color
npx --no-install cdk deploy EmptyStack --method prepare-change-set --change-set-name prepared-local-update --require-approval never --no-notices --no-color
npx --no-install cdk deploy EmptyStack --method execute-change-set --change-set-name prepared-local-update --require-approval never --no-notices --no-color
npx --no-install cdk --output destroy.out destroy EmptyStack --force --no-notices --no-color
```

The reduced bootstrap is created automatically on an ordinary fresh start, and
the caller is the policy-backed default IAM user `user/admin`. Negative fixtures
explicitly pass `cdkBootstrap: false`; in that mode synth remains local and both
direct and default deploy stop at `/cdk-bootstrap/hnb659fds/version` without
creating a stack. With the default enabled, the same commands use the
simulator-managed roles and assets. The test also runs unmodified `cdk bootstrap
aws://000000000000/eu-west-1 --force` and requires it to fail before executing
the unsupported full bootstrap template.

## Frozen synthesized inventory and dependencies

| Variant | Exact logical IDs | Type counts |
| --- | --- | --- |
| default | `CDKMetadata` | `AWS::CDK::Metadata`: 1 |
| analytics | `WorkflowProbe`, `CDKMetadata` | `AWS::CDK::Metadata`: 2 |
| generic file | `CDKMetadata` | `AWS::CDK::Metadata`: 1 |

`ProbeOutput` and the three generic-asset values are outputs, not resources.
No variant emits a resource-level `DependsOn`.

## Bootstrap assets and frozen digest corpus

Default and analytics assemblies contain one file asset: the stack template.
The generic variant contains two: `asset.txt` and the template. There are no
image assets. Direct deployment publishes through the standard file-publishing
role into the versioned reduced-bootstrap bucket; redeploying identical
`asset.txt` bytes is deduplicated, and stack destroy retains both the bootstrap
bucket and its now-unreferenced object.

For the default variant, the focused test freezes:

| Artifact | SHA-256 |
| --- | --- |
| `EmptyStack.template.json` | `718b879789aa5e3cb3c39c592d15a19b09ffc2c3399f91803a1bb2fe3937c2fc` |
| `manifest.json` | `587f1031d0f19dfc512009421bb2f6646ec2947ade522e639e2a6d5af56f5687` |

No analytics or generic-asset template/manifest digest is asserted by the
current focused test.
