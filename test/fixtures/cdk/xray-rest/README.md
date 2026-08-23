# XRY-01 CDK fixture

This is an ordinary pinned CDK v2 `RestApi` with a Lambda proxy integration and
`deployOptions.tracingEnabled`. Its normal Lambda execution role is generated
by CDK; the fixture deliberately declares neither the API Gateway service-linked
role nor an X-Ray resource. `XRY_TRACING=false` exercises the mutable standalone
stage update without changing the owning deployment shape.
