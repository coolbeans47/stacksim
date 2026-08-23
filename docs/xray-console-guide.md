# StackSim X-Ray console guide

StackSim X-Ray is a local trace explorer for the XRY-01 API Gateway REST tracing surface. Open **X-Ray** in the console navigation after enabling tracing on a REST API stage.

## Traces

The trace list shows the newest 100 retained traces for the selected account and Region, including trace ID, start time, duration, HTTP outcome, root service, and indexed API/stage annotations. Search is local to the displayed page. An API Gateway stage's **View X-Ray traces** link opens this list with its API ID and stage filter applied.

An active stage honors an upstream `Sampled=0` or `Sampled=1` decision. With no decision, StackSim applies the XRY-01 Default sampler: one request per account/Region/second, then five percent. A passive stage does not make local sampling decisions but still records a valid upstream `Sampled=1` request.

## Trace detail and timeline

Trace detail shows the service path, relative timing, duration, HTTP status, error/fault/throttle outcome, sampling source, and expandable segment documents. API Gateway adds an integration subsegment only after a backend attempt begins. A rejection in validation, authorization, usage-plan admission, or throttling therefore has only the stage segment. Lambda integrations receive a correlated `_X_AMZN_TRACE_ID`, but Lambda-owned service/function segments remain outside XRY-01.

Raw documents are decrypted only for the current request, redacted on the server, escaped in the browser, and kept out of URLs and browser storage. Authorization, cookie, password, secret, token, access-key, session-token, and credential fields are replaced before rendering. Use the authenticated official `BatchGetTraces` API when exact accepted segment bytes are required.

## Service map

The service map aggregates retained segment and embedded-subsegment identities into services and directed edges. It reports bounded request, error, fault, throttle, and response-time statistics. X-Ray groups, Insights, inferred remote nodes, sampling-rule management, and Transaction Search belong to later phases and return explicit unsupported errors.

## Repository diagnostics

Diagnostics report repository status, trace/segment/rejection counts, oldest and newest trace times, cleanup time, and bounded redacted errors. Raw trace documents live outside `state.json` in:

```text
.stacksim/data/xray/{accountId}/{region}/traces.sqlite3
```

Documents use installation-owned AES-256-GCM authenticated encryption. The matching key is `.stacksim/secrets/xray.key`. Back up or restore the database and key together while StackSim is stopped. Default retention is 30 days; default capacity is 100,000 traces, 500,000 segments, and 2 GiB of logical document data per account/Region.

Repository states are `ready`, `degraded`, `corrupt`, `key-unavailable`, `migration-required`, or `capacity-limited`. Trace-finalization failures never rewrite an already completed API Gateway application response.

## XRY-01 boundary

The official operations implemented in this phase are `PutTraceSegments`, `GetTraceSummaries`, `BatchGetTraces`, `GetServiceGraph`, and `GetTraceGraph`. Custom sampling rules/groups, Lambda automatic segments, the daemon receiver, OpenTelemetry ingestion, broader service producers, X-Ray CloudFormation resources, Insights, encryption configuration, and Transaction Search are not implemented by XRY-01.
