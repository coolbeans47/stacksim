# S3 lifecycle CDK fixture

This portable fixture freezes the exact `AWS::S3::Bucket` resource and
`enforceSSL` companion policy observed in the StackSim Shipments application.
The bucket's canonical `Type`/`Properties` corpus is 715 bytes with SHA-256 digest
`f44c20d50301d09ca7d023d1e42635ba7d90e5cecaa1fe525243860d9fbcf72e`.
The TLS-only policy corpus is 381 bytes with digest
`e8b43925ca13ad065c2d49289d2533f7d4c72e41e53a089ebf1fa509fad7a390`.

CFN-19 owns the bucket lifecycle shape. CFN-20 owns only the exact TLS-deny
policy composition; it does not admit general bucket policies or treat the
simulator's HTTP endpoint as secure.

`test/cloudformation-cdk-s3-lifecycle.test.ts` verifies both provenance corpora
with an external-network tripwire. The CFN-19/20 endpoint case in
`test/cloudformation-cdk-endpoint.test.ts` verifies unmodified deploy, restart,
no-op, policy enforcement, authoritative lifecycle state, and destroy.
