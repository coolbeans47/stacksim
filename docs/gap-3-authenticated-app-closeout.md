# Authenticated application learning gap

Status: **AMX-13A/B/C, AMX-14A/B/C and milestone-scoped AMX-19 complete** on
2026-09-23. This closes **AMX-M4 for the exact pinned fixtures below**. All three
real CLI/client lifecycle tests pass, including final workload cleanup and
shared bootstrap preservation. The public AMX-M2 prerequisite workflow was
rechecked with its current Parameter Store cooldown.

This closeout covers the exact email Auth, owner Data, and authenticated
Identity Pool Data fixtures. The [Private Notes walkthrough](../examples/amplify-auth-notes/README.md)
shows how to deploy the two application modes, confirm users through SES, test
Alice/Bob isolation, refresh and switch users, inspect an IAM denial, and delete
the sandboxes.

## Frozen contract

| Fixture | Resources / assets | Authorization |
| --- | --- | --- |
| `amplify-gen2-auth-email` | 9 / 2 | Email User Pool with SRP and default guest/authenticated Identity roles. |
| `amplify-gen2-auth-data-owner` | 84 / 33 | User Pool access tokens; unchanged generated owner pipelines and DynamoDB conditions. |
| `amplify-gen2-auth-data-iam` | 83 / 31 | Authenticated Identity Pool credentials; guests cannot access Data. |

All three pin `@aws-amplify/backend` 1.24.0, `@aws-amplify/backend-cli`
1.9.0, `aws-amplify` 6.20.0, and CDK 2.265.0. Evidence was captured with
Node 22.13.0 and npm 11.9.0. Each fixture contains its lockfile, original
templates/assets, dependency and source integrities, repeated synthesis proof,
provider/property graph, IAM policies, schema/resolvers, output contract, and
endpoint derivation. The synthesis trace is explicitly synthesis evidence;
it does not claim that frontend calls occurred. The older public Data fixture
retains its original CDK 2.263.0 evidence.

The [generated capability record](generated/amplify-auth-capabilities.json)
records exact transitive package versions, fixture graph/trace/endpoint hashes,
commands and limitations. Run `node scripts/generate-amplify-auth-capabilities.mjs --check`
to check it. Package upgrades require a new locked install, evidence capture,
semantic review of every changed graph/asset, and rerunning the claimed matrix.

## Slice-to-proof map

| Slice | Implementation and focused proof |
| --- | --- |
| AMX-13A | Three unchanged frozen graphs; User Pool/client provider defaults and email verification-before-update; `amplify-amx13-corpus.test.ts` and `amplify-amx13-user-pool.test.ts`. Direct provider create/recovery/update/rollback/restart/delete and late-child unsupported-property rejection before workload mutation. |
| AMX-13B | AppSync consumes the in-process Cognito verifier, native directives and verified resolver identity. `appsync-cognito.test.ts` covers access-token admission, ID-token denial, wrong pool/client/Region/issuer, bad signature, not-before/expiry, signing-key retirement/deletion and admission-generation races, mixed native fields, offline sign-out/disable semantics, and redaction. |
| AMX-13C | Shared VTL argument state and `isList` allow unchanged generated pipelines to execute. Owner stamping and immutable ownership, CRUD/filter/pagination and simultaneous subscription isolation run against direct generated resources. `amplify-amx13-auth-client.test.ts` uses unmodified Amplify Auth against exact direct User Pool/client providers with SES confirmation. The integrated real client verifies actual subscriptions and user-session reconnects. |
| AMX-14A | Existing CID-01 service/providers accept only the emitted Identity properties and one no-group `Token`/`AuthenticatedRole` mapping. STS issuance and guest linking now share one durable state write; failure tests cover missing role, trust, vault and state save, including restart. |
| AMX-14B | `verify-amplify-auth.mjs` runs unmodified `ampx`, preserves its output bytes, then launches `exercise-amplify-auth.mjs` in a clean frontend process without administrator credentials. A credential digest observed on Data requests proves the same Auth session signed the IAM request before the separate retained-credential check. An adjacent sandbox API is denied using Amplify's public client-level endpoint option. |
| AMX-14C | `amplify-gen2-auth.test.ts` drives each fixture through create/repeat/update/injected rollback, a second sandbox, restart, independent deletion, and stale-output rejection. Guest promotion/fallback, guest Data denial, refreshed credentials and retained issued STS validity are checked in the actual client. |
| Scoped AMX-19 | Capability artifact and drift checks, prerequisite public Data corpus/CLI regression, relevant service suites, browser walkthrough, example build, and the documentation/inventory updates described here. This scope depends on AMX-M2; it does not require or claim the entire AMX-M3 crash-recovery programme. |

Test filenames above are under `test/`; scripts are under `scripts/`.
The lifecycle failure is injected before the authoritative Auth update. A
post-mutation lost-response failure is recovered by the provider and is tested
separately; it is not counted as rollback.

Credential and stale-output negatives require the modeled authorization or
missing-pool error and an observed local request. A transport failure cannot
count as a successful denial.

## Actual client routing and identity boundaries

The frontend reads normal CLI-written outputs, then uses the pinned library's
public `Auth.Cognito.userPoolEndpoint` and
`Auth.Cognito.identityPoolEndpoint` configuration fields. Their types and
implementations are frozen in each `endpoint-derivation.json`. Routes are
`/_stacksim/cognito-idp/eu-west-1/sdk` and
`/_stacksim/cognito-identity/eu-west-1/sdk`; AppSync HTTP and WSS derive from
the output's local HTTPS URL. The scoped Cognito CORS allow-list includes the
browser client's `cache-control` request header. Outputs, fetch factories,
dependencies, hosts/DNS, and public AWS TLS are not patched.

CLI and Node frontend subprocesses run with a loopback network tripwire;
browser verification records request hosts. Frontend requests are observed at
the actual server boundary. Access tokens authorize owner Data; ID tokens are
the distinct Identity Pool login proof. Native AppSync API/type/field rules
apply before the generated model rules. IAM authenticated access in the shared
mode does not imply owner isolation.

The generated owner field admits read/delete and excludes direct create/update
assignments. Its pipeline stores the compound subject/username owner and may
return the username presentation to the client. The UI does not add an owner
filter to conceal unauthorized records or events. Native tests exercise two
simultaneous connections; the one-process client test disposes subscriptions
and lets Amplify close the prior socket before reconnecting under another user.

Local sign-out clears frontend tokens/credentials and subscriptions. Global
sign-out, refresh revocation and user disable do not invalidate every previously
issued JWT at an offline AppSync verifier. Expiry, signing-key retention and
generation changes are still enforced. Issued STS credentials keep their normal
one-hour server lifetime; the new guest session receives different credentials
and remains denied authenticated-only Data. Diagnostics and retained test
evidence contain no bearer tokens, passwords or temporary credential secrets.

When an unlinked guest signs in as an existing user, the verified login resolves
to that user's original authenticated Identity ID. The guest is retired only
after successful credential issuance; trust/vault/save failures preserve both
records, and a different authenticated subject cannot take over the identity.
This bounded repeat-login transition follows Cognito's documented
[guest identity switching](https://docs.aws.amazon.com/cognito/latest/developerguide/switching-identities.html).
It does not implement arbitrary login or developer-identity merging.

## Verification and operating limits

Verification uses temporary state and the exact Node 22.13.0 runtime on macOS
arm64. Linux and Windows paths/process handling are supported in code but were
not executed in this session. At the user's explicit request, the full Node and
browser regression suites were run on 2026-09-23, followed by focused reruns:

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Full Node suite | 962 | 3 | 1 |
| Affected Node files after corrections | 6 | 0 | 0 |
| Full browser suite | 150 | 9 | 0 |
| All failed browser cases after correction/retry | 9 | 0 | 0 |

The three Node failures were stale expectations for mixed-auth rejection,
supported IAM-default APIs, and bootstrap revision 21. The tests now preserve
query-limit/redaction coverage, explicitly check mixed-auth rejection, verify
IAM API lifecycle, and retain unsupported-provider and authorization checks.
One browser failure exposed missing Cognito support wording in AppSync panel
help; that text was corrected. The other eight browser failures coincided with
macOS sleep intervals and passed unchanged on rerun with the original timeouts.
All 965 enabled Node tests and 159 browser tests have passing results across
the full runs and focused reruns. The missing-bootstrap negative test remains
intentionally opt-in because the pinned CLI opens an AWS page in the browser.
The follow-up build, capability drift check, and `git diff --check` also pass.

Focused commands are available in the relevant test files; after building and
installing the baseline frozen dependencies, the integrated gate is:

```sh
npm ci --prefix test/fixtures/amplify-gen2-data --no-audit --no-fund
npm run build
node --test dist/test/amplify-gen2-auth.test.js
```

The focused verification set includes:

| Area | Checks run |
| --- | --- |
| Frozen/provider contract | Auth corpus, direct User Pool lifecycle, bootstrap, Cognito provider, S3 bucket-policy provider and existing email verification-target regression. |
| Native/generated Data | AppSync Cognito, VTL, pipeline, API-key/NONE and IAM GraphQL, action inventory, CloudFormation providers, realtime, and the shared API Gateway Cognito verifier. |
| Identity and credentials | Identity service/provider, Cognito protocol/CORS, STS issuance, chaining/session tags, atomic issuance and canonical guest merge, plus the existing CDK Identity fixture. |
| Real client | Direct generated User Pool providers with unmodified Auth; all three complete CLI/Auth/Data lifecycle fixtures, including same-session signing and modeled negative responses. |
| Prerequisites | Public AMX-09 real CLI deployment/restart/delete; AMX-09/10 corpus, hotswap and evidence; live public repeat/watch/edit/fallback/two-identifier/delete/recreation; AMX-03 recursion, AMX-04 generated helpers and Logs providers. |
| Runtime/upgrade | Existing Cognito SRP/remembered-device and RDS snapshot tests; capability generation/drift/health; TypeScript compilation and `git diff --check`. |
| Browser | Chromium 149.0.7827.55 with separate owner profiles and the IAM mode; create/read/update/delete, foreign denial, realtime isolation, refresh/reconnect, same-profile user switch and repeat sign-in. The frontend production build also passes. |

The [client evidence](generated/amplify-auth-client-evidence.json) records the
actual per-fixture lifecycle and observed request facts. The [browser evidence](../examples/amplify-auth-notes/evidence/browser-smoke.json)
records browser versions, tested actions, loopback hosts and the absence of
page errors. Browser TLS used the temporary simulator certificate's public-key
pin for that browser process; the walkthrough uses normal local CA trust.

The example adds React 19.1.1 and Vite 8.1.5. See its README for the two-terminal
launch commands, local CA trust and browser profiles. The simulator command is
`npm run start:amplify`; in `examples/amplify-auth-notes`, run `npm ci`,
`npm run backend:install`, `npm run deploy`, then `npm start`.

Only the pinned scalar Todo graphs and named lifecycle boundaries are claimed.
Unlisted package versions, social identity providers, advanced MFA/passwordless
flows, group/role-claim selection, other Identity role mappings, AppSync ID-token
authorization, OIDC/Lambda authorizers, JavaScript resolvers, general enhanced
subscription filters, Storage, user Functions, Hosting, relationships/indexes,
custom operations, auxiliary code generation and `pipeline-deploy` remain out
of scope. `ALLOW_CUSTOM_AUTH` is admitted because the default client emits it;
invoking a custom challenge without a supported trigger remains denied.

Two compatibility corrections were required by the real client/minimum runtime:
Cognito SRP uses the client's minimal positive integer encoding, including
device verifiers with a leading sign byte; SQLite snapshot creation falls back
to `VACUUM INTO` on Node 22.13, which predates `node:sqlite.backup`. Existing
SRP/remembered-device and RDS snapshot suites cover these changes. Password
verifiers created with the previous incompatible SRP encoding may need a local
password reset to regenerate them; fresh fixtures use the corrected encoding.

General crash/callback/descendant recovery beyond these Auth lifecycle rows is
still a separate AMX-M3 gate. Local TLS URLs also require the same configured
port after restart; changing ports requires a normal redeploy to regenerate
outputs.

Same-name sandbox recreation must wait at least 30 seconds after deletion for
Parameter Store's documented name-reuse cooldown. The live public AMX-10
prerequisite check now observes this wait and requires both CLI output-write
evidence and a new `CREATE_COMPLETE` root. Historical frozen AMX-10 evidence
predates that owning-service cooldown and is retained without rewriting.
