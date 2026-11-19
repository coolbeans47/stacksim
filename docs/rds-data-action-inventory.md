# RDS Data API

Configure an AWS SDK RDS Data client with the StackSim HTTP endpoint, the cluster Region and local AWS credentials. Send the cluster ARN as `resourceArn` and a Secrets Manager ARN as `secretArn`. Every operation resolves the secret's `AWSCURRENT` JSON username and password. Under IAM enforcement the caller needs the operation's `rds-data` action on the cluster and `secretsmanager:GetSecretValue` on the secret. The writer must be available and the cluster's HTTP endpoint enabled. [Terraform and SDK example](reference.md#terraform-aurora-clusters)

| AWS action | POST path | Local behavior |
| --- | --- | --- |
| `ExecuteStatement` | `/Execute` | Executes one prepared statement. Returns typed records, optional column metadata or JSON-formatted rows. Writes report affected rows and applicable generated IDs. |
| `BatchExecuteStatement` | `/BatchExecute` | Validates every parameter set, then runs one DML statement for each set in order. Returns per-set generated fields. |
| `BeginTransaction` | `/BeginTransaction` | Opens a transaction on one authenticated writer connection and returns its ID. |
| `CommitTransaction` | `/CommitTransaction` | Commits the connection's changes and consumes the ID. |
| `RollbackTransaction` | `/RollbackTransaction` | Rolls back the changes and consumes the ID. |
| `ExecuteSql` (deprecated) | `/ExecuteSql` | Returns a modeled error. Use `ExecuteStatement` or `BatchExecuteStatement`. |

SQL uses named parameters such as `:id`. Bind nulls, booleans, safe integers, doubles, strings and blobs using SDK `Field` values. String parameters accept the supported date, time, timestamp, decimal, JSON and UUID hints. The HTTP SQL profile rejects parameter arrays, multiple statements, the `schema` option and DDL inside an explicit transaction. Use separate autocommit statements for migrations. [SQL profile](rds-mysql8-development-profile.md)

The request limit is 4 MiB including headers. StackSim enforces a 64 KiB row limit, a 1 MiB typed-result limit and a 10 MiB formatted JSON limit. The HTTP handler applies a 45-second statement timeout. JSON output uses column labels, so selected expressions need distinct labels. On Node 22.13–22.15, give overlapping columns explicit aliases when selecting from joined tables. Those Node versions cannot reliably describe duplicate wildcard columns. [AWS troubleshooting](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html) · [AWS ExecuteStatement](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html)

Without a transaction ID, each successful DML execution commits independently. A database error midway through a batch leaves earlier successful sets committed. In an explicit transaction, earlier successful sets remain on the pinned connection and can be rolled back. A busy transaction rejects overlapping calls. The ID is bound to the cluster and writer generation, credential and database. Idle transactions expire after three minutes and all transactions expire after an hour. Disabling the endpoint, removing the writer or stopping StackSim closes open transactions and rolls back pending writes. [AWS action inventory](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_Operations.html) · [AWS transaction lifetime](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_BeginTransaction.html)
