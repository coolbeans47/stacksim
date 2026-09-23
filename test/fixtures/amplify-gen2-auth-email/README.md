# Pinned Amplify Gen 2 auth-email fixture

This is an unchanged official defineAuth/defineData application source, using Node 22.13.0, npm 11.9.0 and exact package/lock versions. Its generated templates and selected plaintext assets are frozen verbatim in evidence; all generated assets (including helper bundles) are SHA-256 inventoried. Each fixture received a separate clean npm ci on macOS arm64. Package installation is separate from the loopback-only synthesis/runtime tripwire. No Windows or Linux execution is claimed by this capture.

From the repository root, with the pinned Node/npm selected:

```sh
npm ci --prefix test/fixtures/amplify-gen2-auth-email --no-audit --no-fund
node scripts/capture-amplify-gen2-evidence.mjs --fixture test/fixtures/amplify-gen2-auth-email --synthesis-only --bootstrap --identifier amx13 --output .tmp/auth-email-synthesis.json
node scripts/generate-amplify-auth-evidence.mjs amplify-gen2-auth-email .tmp/auth-email-synthesis.json --verify-repeat
```

The evidence recorder rejects a different CLI Node version. The capture can select another executable using --node-executable; it never edits a dependency or generated artifact. Create the ignored .tmp directory before capture, or supply an existing output directory. First-time intentional corpus maintenance omits --verify-repeat; ordinary verification requires the existing frozen template/asset bytes to match. Do not run two CLI processes against the same fixture artifact directory.

See docs/gap-3-authenticated-app-closeout.md for client integration, lifecycle results and the learning example. Evidence-phase capture denies CloudFormation workload writes and does not by itself prove a deployment.
