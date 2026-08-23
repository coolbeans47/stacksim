# CloudFront console guide

The local CloudFront console is diagnostic tooling for CFR-01. It reads the
same account-global service state as the official client. It does not replace
the CloudFront API and does not change application outputs.

Distribution detail deliberately shows two different values:

- Canonical domain: `d<label>.cloudfront.net`, returned by CloudFront and
  `Fn::GetAtt DomainName`.
- Local viewer URL: `https://d<label>.localhost:<port>/`, reachable only on the
  loopback listener using the installation CA.

Use the displayed `curl --cacert <ca-path> <local-url>` command. StackSim does
not edit DNS or hosts files, bind port 443, install CA trust, create ACM
resources, or claim public reachability.

The CFR-01 pages cover distributions, DEVELOPMENT/LIVE Functions, OACs,
response-header policies, invalidation history, and bounded cache counters.
They do not expose cached bodies, S3 authorization context, credentials,
private callback URLs, or executable Function source. Missing TLS material,
listener bind failures, unavailable Function runtime, and corrupt service state
are shown as degraded/error states rather than healthy empty lists.

The fixture SPA still contains canonical API Gateway and Cognito endpoints.
Serving its static shell through the local CloudFront viewer does not make
those separate browser endpoints routable.

