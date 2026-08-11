import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchExecuteStatementCommand,
  CreateTableCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { partiqlAuthorizationReference, partiqlAuthorizationTarget } from "../src/auth/partiql.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const accountId = "000000000000";

test("PartiQL authorization headers preserve verbs and quoted table/index identifiers", () => {
  assert.deepEqual(partiqlAuthorizationReference(`SELECT "FROM", title FROM "Music"."ByAlbum" WHERE artist='from here'`), { action: "dynamodb:PartiQLSelect", tableName: "Music", indexName: "ByAlbum" });
  assert.deepEqual(partiqlAuthorizationReference(`insert into "Music" value {'id':'one'}`), { action: "dynamodb:PartiQLInsert", tableName: "Music" });
  assert.deepEqual(partiqlAuthorizationReference(`UPDATE "Odd""Table" SET value=1 WHERE id='one'`), { action: "dynamodb:PartiQLUpdate", tableName: 'Odd"Table' });
  assert.deepEqual(partiqlAuthorizationReference(`DELETE FROM Music WHERE id='one'`), { action: "dynamodb:PartiQLDelete", tableName: "Music" });
  assert.deepEqual(partiqlAuthorizationReference(`EXISTS (SELECT * FROM "Music" WHERE id='one' AND active=true)`), { action: "dynamodb:PartiQLSelect", tableName: "Music" });
  assert.deepEqual(partiqlAuthorizationTarget(`SELECT * FROM "Music"."ByAlbum"`, region, accountId), { action: "dynamodb:PartiQLSelect", resource: `arn:aws:dynamodb:${region}:${accountId}:table/Music/index/ByAlbum` });
  assert.deepEqual(partiqlAuthorizationReference("SELECT * FROM"), { action: "dynamodb:PartiQLSelect" }, "malformed statements remain fail-closed on the correct IAM action without replacing service validation");
});

test("enforced IAM authorizes every PartiQL statement action and resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-partiql-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials: adminCredentials };
    const dynamoRoot = new DynamoDBClient(options); const iam = new IAMClient(options); const sts = new STSClient(options); clients.push(dynamoRoot, iam, sts);

    await dynamoRoot.send(new CreateTableCommand({ TableName: "PartiqlAllowed", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "group", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByGroup", KeySchema: [{ AttributeName: "group", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] }));
    for (const tableName of ["PartiqlConditional", "PartiqlDenied"]) await dynamoRoot.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], ...(tableName === "PartiqlConditional" ? { Tags: [{ Key: "scope", Value: "secondary" }] } : {}) }));
    for (const tableName of ["PartiqlAllowed", "PartiqlConditional", "PartiqlDenied"]) await waitForTableActive(dynamoRoot, tableName);
    await dynamoRoot.send(new PutItemCommand({ TableName: "PartiqlAllowed", Item: { id: { S: "allowed" }, group: { S: "blue" }, value: { S: "seed" } } }));
    await dynamoRoot.send(new PutItemCommand({ TableName: "PartiqlConditional", Item: { id: { S: "conditional" }, value: { S: "seed" } } }));
    await dynamoRoot.send(new PutItemCommand({ TableName: "PartiqlDenied", Item: { id: { S: "denied" }, value: { S: "seed" } } }));

    const roleName = "partiql-authorized"; const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }] }) }));
    const allowedArn = `arn:aws:dynamodb:${region}:${accountId}:table/PartiqlAllowed`; const conditionalArn = `arn:aws:dynamodb:${region}:${accountId}:table/PartiqlConditional`; const deniedArn = `arn:aws:dynamodb:${region}:${accountId}:table/PartiqlDenied`;
    const policy = await iam.send(new CreatePolicyCommand({ PolicyName: "PartiqlAuthorization", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Sid: "GenericApiNamesAreInsufficient", Effect: "Allow", Action: ["dynamodb:ExecuteStatement", "dynamodb:BatchExecuteStatement", "dynamodb:ExecuteTransaction"], Resource: "*" },
      { Sid: "AllowedTableStatements", Effect: "Allow", Action: ["dynamodb:PartiQLSelect", "dynamodb:PartiQLInsert", "dynamodb:PartiQLUpdate", "dynamodb:PartiQLDelete"], Resource: allowedArn },
      { Sid: "DenyFullTableScans", Effect: "Deny", Action: "dynamodb:PartiQLSelect", Resource: allowedArn, Condition: { Bool: { "dynamodb:FullTableScan": "true" } } },
      { Sid: "AllowedIndexSelect", Effect: "Allow", Action: "dynamodb:PartiQLSelect", Resource: `${allowedArn}/index/ByGroup` },
      { Sid: "ConditionalBatchAndTransaction", Effect: "Allow", Action: "dynamodb:PartiQLSelect", Resource: conditionalArn, Condition: { StringEquals: { "dynamodb:EnclosingOperation": ["BatchExecuteStatement", "ExecuteTransaction"], "aws:ResourceTag/scope": "secondary" } } },
      { Sid: "DeniedTable", Effect: "Deny", Action: "dynamodb:PartiQLSelect", Resource: deniedArn },
    ] }) }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.Policy!.Arn! }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "partiql-session" }));
    const credentials = { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! };
    const dynamo = new DynamoDBClient({ endpoint, region, credentials }); clients.push(dynamo);
    const denied = (promise: Promise<unknown>) => assert.rejects(promise, (error: any) => error.name === "AccessDeniedException");

    const selected = await dynamo.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlAllowed" WHERE id=?`, Parameters: [{ S: "allowed" }] }));
    assert.equal(selected.Items?.[0]?.value?.S, "seed");
    await denied(dynamo.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlAllowed" WHERE value='seed'` })));
    await denied(dynamo.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlAllowed" WHERE id='allowed' OR value='seed'` })));
    const indexed = await dynamo.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlAllowed"."ByGroup" WHERE "group"=?`, Parameters: [{ S: "blue" }] }));
    assert.equal(indexed.Items?.[0]?.id?.S, "allowed");
    await dynamo.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "PartiqlAllowed" VALUE {'id':'written','group':'blue','value':'inserted'}` }));
    const updated = await dynamo.send(new ExecuteStatementCommand({ Statement: `UPDATE "PartiqlAllowed" SET value='updated' WHERE id='written' RETURNING ALL NEW *` })); assert.equal(updated.Items?.[0]?.value?.S, "updated");
    const deleted = await dynamo.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "PartiqlAllowed" WHERE id='written' RETURNING ALL OLD *` })); assert.equal(deleted.Items?.[0]?.value?.S, "updated");

    await denied(dynamo.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlConditional" WHERE id='conditional'` })));
    await denied(dynamo.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlDenied" WHERE id='denied'` })));

    const batch = await dynamo.send(new BatchExecuteStatementCommand({ Statements: [{ Statement: `SELECT * FROM "PartiqlAllowed" WHERE id='allowed'` }, { Statement: `SELECT * FROM "PartiqlConditional" WHERE id='conditional'` }] }));
    assert.deepEqual(batch.Responses?.map(response => response.Item?.id?.S), ["allowed", "conditional"]);
    await denied(dynamo.send(new BatchExecuteStatementCommand({ Statements: [{ Statement: `SELECT * FROM "PartiqlAllowed" WHERE id='allowed'` }, { Statement: `SELECT * FROM "PartiqlDenied" WHERE id='denied'` }] })));

    const transaction = await dynamo.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `SELECT * FROM "PartiqlAllowed" WHERE id='allowed'` }, { Statement: `SELECT * FROM "PartiqlConditional" WHERE id='conditional'` }] }));
    assert.deepEqual(transaction.Responses?.map(response => response.Item?.id?.S), ["allowed", "conditional"]);
    await denied(dynamo.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `SELECT * FROM "PartiqlAllowed" WHERE id='allowed'` }, { Statement: `SELECT * FROM "PartiqlDenied" WHERE id='denied'` }] })));
    await dynamo.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `EXISTS (SELECT * FROM "PartiqlAllowed" WHERE id='allowed' AND value='seed')` }] }));
    await denied(dynamo.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `EXISTS (SELECT * FROM "PartiqlDenied" WHERE id='denied' AND value='seed')` }] })));

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions.filter(decision => decision.principalArn.includes("assumed-role/partiql-authorized/partiql-session"));
    for (const action of ["dynamodb:PartiQLSelect", "dynamodb:PartiQLInsert", "dynamodb:PartiQLUpdate", "dynamodb:PartiQLDelete"]) assert.ok(decisions.some(decision => decision.action === action && decision.resource === allowedArn), `${action} must be evaluated on the embedded table ARN`);
    assert.ok(decisions.some(decision => decision.action === "dynamodb:PartiQLSelect" && decision.resource === `${allowedArn}/index/ByGroup` && decision.decision === "allowed"));
    assert.ok(decisions.some(decision => decision.action === "dynamodb:PartiQLSelect" && decision.resource === deniedArn && decision.decision === "explicitDeny"));
    assert.equal(decisions.some(decision => new Set(["dynamodb:ExecuteStatement", "dynamodb:BatchExecuteStatement", "dynamodb:ExecuteTransaction"]).has(decision.action)), false, "generic API operation names must not authorize valid PartiQL statements");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
