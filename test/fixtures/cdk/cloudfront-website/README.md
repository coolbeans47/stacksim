# Pinned private-S3 CloudFront website fixture

This is the self-contained ordinary AWS CDK v2 fixture for CFR-01. It uses the
unmodified default synthesizer and only standard `aws-cdk-lib` constructs. It
does not load files from the motivating Shipments repository.

The repository pins `cdk@2.1132.0`, `aws-cdk-lib@2.265.0`, and
`constructs@10.7.1`. The fixture synthesizes two output-only producer stacks
and a 17-resource Web stack. Four unique exports are consumed at five
`Fn::ImportValue` sites: API ID is used by both CSP and runtime configuration.

Build and synthesize with portable Node.js commands:

```powershell
Set-Location frontend
npm run build
Set-Location ..
npx --no-install cdk synth --all
```

`CLOUDFRONT_FIXTURE_VARIANT=v2` changes both application and immutable asset
bytes. `CLOUDFRONT_FIXTURE_APP_VARIANT` and
`CLOUDFRONT_FIXTURE_ASSET_VARIANT` can vary them independently for the
whole-prefix prune and `Prune=false` regressions.

The Web stack intentionally preserves standard helper behavior: the
application deployment overlays two ordered sources, applies runtime markers,
uses `cache-control: no-cache`, prunes the whole bucket prefix, and invalidates
`/*`. The asset deployment runs afterward with
`cache-control: public,max-age=31536000,immutable` and `Prune=false`.

`expected-assembly.json` freezes synthesis semantics. `expected-runtime.json`
freezes the separate canonical CloudFront output and local-viewer request
expectations. Generated `cdk.out` and frontend `dist` directories are ignored.

