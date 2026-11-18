# OS-03 embedded security and workspace implementation

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

Implementation date: 2026-11-17. This advances the user's request to implement
all remaining phases without Docker. It does not declare the entire design or
native OpenSearch parity complete.

## Protected storage

`EncryptionAtRestOptions.Enabled=true` uses SQLite entirely in memory, including
its journal and temporary store. AES-256-GCM protects persisted snapshots,
transaction changesets and commit records. Files are bound cryptographically to
the resource generation and their purpose. A durable commit record detects a
missing final journal transaction, as well as gaps and corrupted ciphertext.
Checkpoints compact the encrypted journal without exposing plaintext files.
The default API profile remains unencrypted for compatibility; the console
selects encryption for new domains.

Existing domains can enable encryption through a configuration revision. New
requests pause while active requests drain and the data is copied. A durable
transition marker selects the encrypted copy during restart recovery. Plaintext
database/WAL files are removed before publishing encryption as active. Refresh
visibility, mappings, sequence numbers, versions, aliases and saved objects are
preserved. Encryption cannot be disabled.

Keys are resource-owned local secrets under the installation's `secrets` tree;
this is a local managed-key analogue, not AWS KMS. Missing keys and invalid
ciphertext fail closed. Database pages, journal records, temporary search files,
and copied search-storage backups are within the encryption boundary. OS-05
snapshot/export features still need their own encrypted backup implementation.
The single-process engine has no inter-node network traffic; enabling
node-to-node protection prohibits no additional channel because none exists.
It does not create a simulated distributed TLS topology.

Every ciphertext file is flushed before atomic replacement. Directory fsync is
used on Linux/macOS; Windows uses flushed files and atomic replacement because
Node cannot fsync a Windows directory. Host administrators, process memory,
swap/hibernation and the local key files are outside the ciphertext boundary.
The encrypted store is bounded to 512 MiB, with a 256 MiB snapshot limit.

## Security and configuration

Fine-grained access requires encrypted storage, HTTPS and node-to-node
protection. IAM master identities and internal master users are supported.
Salted scrypt password verifiers are protected by the shared encrypted material
store and encrypted search metadata. Public domain configuration, state JSON,
errors and logs do not contain master passwords or verifiers. Internal-user
password changes and role changes take effect on subsequent requests.

The resource gateway evaluates IAM/domain policy before fine-grained access.
Basic authentication is an anonymous identity at the IAM edge and cannot satisfy
an IAM-signature-only policy. IAM role sessions map through their actual role
ARN; pagination and workspace identity still distinguish individual sessions.
Index targets are authorized after alias resolution, including bulk, multi-get
and multi-search body targets. DLS and FLS run before query evaluation,
aggregations, counts, projection, sorting and highlighting. Restricted roles are
read-only. Context identity includes a permission revision, so revoked
permissions cannot continue an old scroll or PIT.

The bounded security REST surface supports internal users, roles, role mappings
and auth information under `/_plugins/_security`. Security administration
requires the master user. Shared tenants, field masking, user-attribute
substitution and host/conjunctive role mappings remain unavailable.

Configuration changes that affect protection use durable pending/applying/
completed/failed/cancelled revisions. Reads expose active and pending values;
overlapping changes reject. Basic dry runs validate synchronously; verbose dry
runs have persisted IDs and progress. Cancellation supports preview and only
cancels pending work. Failed publication preserves the working revision, except
an interrupted storage transition fails closed until restart completes cleanup.

CloudFormation carries write-only master inputs in transient desired models,
supports secure SSM/Secrets Manager dynamic references at the exact password
property, and waits for security updates to complete. Its persisted templates
retain the dynamic reference rather than the resolved password. As with other
resources, a caller who puts a literal password in a CloudFormation template
has supplied that literal to the template service; use secure dynamic references.

## Workspace

The console offers a signed-session workspace at
`#/opensearch/domains/:name/workspace`. The domain HTTPS gateway offers a
standalone login at `/_stacksim/workspace-ui/`, with SigV4 or internal credentials
kept only in page memory. It uses same-origin requests, a restrictive CSP, no
credential cookies, and no browser-storage credentials. Trust the installation
CA in the browser before opening this endpoint.

Discover provides data views, query DSL, source fields, sorting, field
inspection and paginated results. Saved views/searches persist privately per
identity and resource generation. Dev Tools sends bounded REST/NDJSON requests
using the same authorization chain. Sign-out clears displayed results and
credentials; stale responses cannot repopulate the new session. This is local
StackSim functionality, not the upstream Dashboards distribution or a claim of
AWS visual parity.

## Evidence and remaining gates

Focused Node tests cover encrypted ciphertext inspection and checkpoint/restart,
missing keys, corrupted/transplanted files, missing journal records, forced
termination, security layers, DLS/FLS, permission revocation, workspace isolation,
configuration cancellation and password rotation. Process-kill fixtures exercise
storage migration at intent, encrypted-copy publication and final publication.
An injected publication failure preserves the active revision. The protected
CloudFormation fixture deploys and rotates a secure SSM parameter reference and
scans persisted files for plaintext credentials and documents.

The focused OpenSearch tests run on Node 22.13.0/macOS. Chrome workspace journeys
cover 1440px and 390px, internal and IAM users, private saved state, DLS/FLS and
Dev Tools. The existing five domain-console journeys also passed. The full
project regression suite was not run. `.github/workflows/opensearch.yml` adds
focused Linux/macOS/Windows checks on Node 22.13.0 and 24; remote executions are
not yet evidence. AWS/native reference execution, authenticated AWS screenshots,
KMS/customer keys, additional TLS/certificate profiles and the remaining service
phases are still open.

References used to check contracts:

- [AWS FGAC layers](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/fgac.html)
- [AWS configuration changes and dry-run status](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-configuration-changes.html)
- [AWS cancellation contract](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_CancelDomainConfigChange.html)
- [SQLite session changesets](https://www.sqlite.org/session/sqlite3session_changeset.html)
