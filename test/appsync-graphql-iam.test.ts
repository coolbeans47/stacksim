import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import { CloudWatchClient, GetMetricStatisticsCommand, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateDataSourceCommand,
  CreateGraphqlApiCommand,
  CreateResolverCommand,
  GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand,
} from "@aws-sdk/client-appsync";
import { CreatePolicyCommand, CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

class Sha256 {
  private value: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(private readonly secret?: any) {
    this.value = secret ? createHmac("sha256", secret) : createHash("sha256");
  }
  update(data: any): void { this.value.update(data); }
  async digest(): Promise<Uint8Array> { return this.value.digest(); }
  reset(): void { this.value = this.secret ? createHmac("sha256", this.secret) : createHash("sha256"); }
}

async function officialSignedRequest(
  endpoint: string,
  credentials: Credentials,
  clock: TestClock,
  input: Record<string, unknown>,
): Promise<any> {
  const url = new URL(endpoint);
  const body = JSON.stringify(input);
  const signer = new SignatureV4({ credentials, region, service: "appsync", sha256: Sha256, applyChecksum: true });
  const signed = await signer.sign({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: { host: url.host, "content-type": "application/json" },
    body,
  }, { signingDate: new Date(clock.now()) });
  const response = await fetch(endpoint, { method: "POST", headers: signed.headers, body });
  assert.equal(response.status, 200);
  return response.json();
}

function signedGraphqlHeaders(
  urlValue: string,
  body: string,
  credentials: Credentials,
  date: Date,
  overrides: { region?: string; service?: string; host?: string; path?: string } = {},
): Record<string, string> {
  const url = new URL(urlValue);
  const signingRegion = overrides.region ?? region;
  const signingService = overrides.service ?? "appsync";
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const values: Record<string, string> = {
    "content-type": "application/json",
    host: overrides.host ?? url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) values["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(values).sort();
  const canonicalHeaders = names.map(name => `${name}:${values[name]}\n`).join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]))
    .map(([key, value]) => `${key}=${value}`).join("&");
  const canonicalRequest = `POST\n${overrides.path ?? url.pathname}\n${canonicalQuery}\n${canonicalHeaders}\n${names.join(";")}\n${payloadHash}`;
  const scope = `${shortDate}/${signingRegion}/${signingService}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, shortDate), signingRegion), signingService), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(values).filter(([name]) => name !== "host")),
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

async function signedRequest(
  endpoint: string,
  credentials: Credentials,
  clock: TestClock,
  input: Record<string, unknown>,
  overrides: Parameters<typeof signedGraphqlHeaders>[4] = {},
): Promise<{ status: number; value: any }> {
  const body = JSON.stringify(input);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: signedGraphqlHeaders(endpoint, body, credentials, new Date(clock.now()), overrides),
    body,
  });
  return { status: response.status, value: await response.json() };
}

test("AMX-06 authenticates AppSync SigV4 and authorizes each selected root field", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-graphql-iam-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const appsync = new AppSyncClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const cloudwatch = new CloudWatchClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    clients.push(appsync, iam, sts, cloudwatch);

    const api = (await appsync.send(new CreateGraphqlApiCommand({
      name: "amx06",
      authenticationType: "API_KEY",
      additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
    }))).graphqlApi!;
    assert.deepEqual(api.additionalAuthenticationProviders?.map(provider => provider.authenticationType), ["AWS_IAM"]);
    const schema = `
      type Query {
        allowed: String @aws_api_key @aws_iam
        other: String @aws_api_key @aws_iam
        nullableDenied: String @aws_api_key @aws_iam
        requiredDenied: String! @aws_api_key @aws_iam
        identity: AWSJSON @aws_iam
        apiKeyOnly: String @aws_api_key
      }
      type Mutation { write: String @aws_iam }
    `;
    await appsync.send(new StartSchemaCreationCommand({ apiId: api.apiId, definition: Buffer.from(schema) }));
    assert.equal((await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");
    await appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "Local", type: "NONE" }));
    for (const fieldName of ["allowed", "other", "nullableDenied", "requiredDenied", "apiKeyOnly"]) {
      await appsync.send(new CreateResolverCommand({
        apiId: api.apiId, typeName: "Query", fieldName, dataSourceName: "Local",
        requestMappingTemplate: `{"version":"2018-05-29","payload":"${fieldName}"}`,
        responseMappingTemplate: "$util.toJson($ctx.result)",
      }));
    }
    await appsync.send(new CreateResolverCommand({
      apiId: api.apiId, typeName: "Query", fieldName: "identity", dataSourceName: "Local",
      requestMappingTemplate: '{"version":"2018-05-29","payload":$util.toJson($ctx.identity)}',
      responseMappingTemplate: "$util.toJson($ctx.result)",
    }));
    await appsync.send(new CreateResolverCommand({
      apiId: api.apiId, typeName: "Mutation", fieldName: "write", dataSourceName: "Local",
      requestMappingTemplate: '{"version":"2018-05-29","payload":"written"}',
      responseMappingTemplate: "$util.toJson($ctx.result)",
    }));

    const roleName = "amx06-machine";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole",
      }] }),
    }));
    const fieldArn = (field: string) => `${api.arn}/types/Query/fields/${field}`;
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "graphql-fields",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "appsync:GraphQL", Resource: [fieldArn("allowed"), fieldArn("identity"), `${api.arn}/types/Mutation/fields/write`] },
        { Effect: "Deny", Action: "appsync:GraphQL", Resource: fieldArn("requiredDenied") },
      ] }),
    }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "machine" }));
    const session: Credentials = {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    };

    const selected = await signedRequest(api.uris!.GRAPHQL!, session, clock, {
      query: `query One($includeOther: Boolean!) {
        alias: allowed
        ...Fields
        other @include(if: $includeOther)
      }
      query Two { other }
      fragment Fields on Query { nullableDenied }
      `,
      operationName: "One",
      variables: { includeOther: false },
    });
    assert.equal(selected.status, 200);
    assert.deepEqual(selected.value.data, { alias: "allowed", nullableDenied: null });
    assert.deepEqual(selected.value.errors[0].path, ["nullableDenied"]);
    assert.equal(selected.value.errors[0].extensions.errorType, "Unauthorized");
    const deniedResolverMetrics = await cloudwatch.send(new GetMetricStatisticsCommand({
      Namespace: "AWS/AppSync",
      MetricName: "ResolverRequestCount",
      Dimensions: [
        { Name: "GraphQLAPIId", Value: api.apiId! },
        { Name: "AuthenticationType", Value: "AWS_IAM" },
        { Name: "TypeName", Value: "Query" },
        { Name: "FieldName", Value: "nullableDenied" },
      ],
      StartTime: new Date(clock.now() - 1_000), EndTime: new Date(clock.now() + 1_000), Period: 60,
      Statistics: ["Sum"],
    }));
    assert.deepEqual(deniedResolverMetrics.Datapoints, [], "a denied field must not enter resolver metrics or execution");

    const nonNull = await signedRequest(api.uris!.GRAPHQL!, session, clock, {
      query: "{ allowed requiredDenied }",
    });
    assert.equal(nonNull.status, 200);
    assert.equal(nonNull.value.data, null);
    assert.deepEqual(nonNull.value.errors[0].path, ["requiredDenied"]);

    const identity = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ identity }" });
    const resolverIdentity = typeof identity.value.data.identity === "string"
      ? JSON.parse(identity.value.data.identity)
      : identity.value.data.identity;
    assert.deepEqual(Object.keys(resolverIdentity).sort(), ["accountId", "sourceIp", "userArn", "username"]);
    assert.equal(resolverIdentity.accountId, accountId);
    assert.match(resolverIdentity.userArn, /assumed-role\/amx06-machine\/machine$/);
    assert.doesNotMatch(JSON.stringify(identity.value), /ASIA|password|authorization|security-token/i);
    assert.deepEqual((await signedRequest(api.uris!.GRAPHQL!, session, clock, {
      query: "mutation Save { write }", operationName: "Save",
    })).value, { data: { write: "written" } });
    assert.deepEqual(await officialSignedRequest(api.uris!.GRAPHQL!, session, clock, {
      query: "query Official { allowed }", operationName: "Official",
    }), { data: { allowed: "allowed" } });
    assert.deepEqual((await signedRequest(`${api.uris!.GRAPHQL!}?client=official`, session, clock, {
      query: "{ allowed }",
    })).value, { data: { allowed: "allowed" } });

    for (const policyDocument of [
      { Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "appsync:GraphQL", Resource: `${api.arn}/*` },
        { Effect: "Deny", Action: "appsync:GraphQL", Resource: `${api.arn}/types/Query/*` },
      ] },
      { Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "appsync:GraphQL", Resource: fieldArn("allowed") },
        { Effect: "Deny", Action: "appsync:GraphQL", Resource: `${api.arn}/*` },
      ] },
    ]) {
      await iam.send(new PutRolePolicyCommand({
        RoleName: roleName, PolicyName: "graphql-fields", PolicyDocument: JSON.stringify(policyDocument),
      }));
      const hierarchicalDeny = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" });
      assert.equal(hierarchicalDeny.value.data.allowed, null);
      assert.equal(hierarchicalDeny.value.errors[0].extensions.errorType, "Unauthorized");
    }
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "graphql-fields",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL", Resource: `${api.arn}/types/Mutation/*`,
      }] }),
    }));
    const implicitTypeMismatch = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" });
    assert.equal(implicitTypeMismatch.value.data.allowed, null);
    assert.equal(implicitTypeMismatch.value.errors[0].extensions.errorType, "Unauthorized");

    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "graphql-fields",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL",
        Resource: `arn:aws:appsync:${region}:111111111111:apis/${api.apiId}/*`,
      }] }),
    }));
    const crossAccountResource = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" });
    assert.equal(crossAccountResource.value.data.allowed, null);
    assert.equal(crossAccountResource.value.errors[0].extensions.errorType, "Unauthorized");

    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "graphql-fields",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL", Resource: `${api.arn}/types/Query/*`,
      }] }),
    }));
    assert.deepEqual((await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ other }" })).value, {
      data: { other: "other" },
    }, "a root-type wildcard must authorize its fields");
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "graphql-fields",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL", Resource: `${api.arn}/*`,
      }] }),
    }));
    const introspection = await signedRequest(api.uris!.GRAPHQL!, session, clock, {
      query: "{ __schema { queryType { name } } }",
    });
    assert.equal(introspection.value.data.__schema.queryType.name, "Query");

    const limited = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "limited",
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL", Resource: fieldArn("allowed"),
      }] }),
    }));
    const limitedCredentials: Credentials = {
      accessKeyId: limited.Credentials!.AccessKeyId!, secretAccessKey: limited.Credentials!.SecretAccessKey!,
      sessionToken: limited.Credentials!.SessionToken!,
    };
    const limitedResult = await signedRequest(api.uris!.GRAPHQL!, limitedCredentials, clock, { query: "{ allowed other }" });
    assert.deepEqual(limitedResult.value.data, { allowed: "allowed", other: null });
    assert.equal(limitedResult.value.errors[0].extensions.errorType, "Unauthorized");

    const boundaryPolicy = await iam.send(new CreatePolicyCommand({
      PolicyName: "Amx06Boundary",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL", Resource: fieldArn("allowed"),
      }] }),
    }));
    const boundaryRole = "amx06-boundary";
    const boundaryRoleArn = `arn:aws:iam::${accountId}:role/${boundaryRole}`;
    await iam.send(new CreateRoleCommand({
      RoleName: boundaryRole,
      PermissionsBoundary: boundaryPolicy.Policy!.Arn!,
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole",
      }] }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: boundaryRole,
      PolicyName: "broad",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL", Resource: `${api.arn}/*`,
      }] }),
    }));
    const bounded = await sts.send(new AssumeRoleCommand({ RoleArn: boundaryRoleArn, RoleSessionName: "bounded" }));
    const boundedCredentials: Credentials = {
      accessKeyId: bounded.Credentials!.AccessKeyId!, secretAccessKey: bounded.Credentials!.SecretAccessKey!,
      sessionToken: bounded.Credentials!.SessionToken!,
    };
    const boundedResult = await signedRequest(api.uris!.GRAPHQL!, boundedCredentials, clock, { query: "{ allowed other }" });
    assert.deepEqual(boundedResult.value.data, { allowed: "allowed", other: null });
    assert.match(
      [...simulator.store.ensureAccount().iam.authorizationDecisions].reverse()
        .find(decision => decision.resource === fieldArn("other"))?.reason ?? "",
      /Permissions boundary/,
    );

    const key = (await appsync.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
    const apiKeyResponse = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: "{ apiKeyOnly allowed }" }),
    });
    assert.deepEqual(await apiKeyResponse.json(), { data: { apiKeyOnly: "apiKeyOnly", allowed: "allowed" } });
    const apiKeyIsolation = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: "{ apiKeyOnly identity }" }),
    });
    const apiKeyIsolationResult: any = await apiKeyIsolation.json();
    assert.deepEqual(apiKeyIsolationResult.data, { apiKeyOnly: "apiKeyOnly", identity: null });
    assert.equal(apiKeyIsolationResult.errors[0].extensions.errorType, "Unauthorized");
    const authMetrics = (await cloudwatch.send(new ListMetricsCommand({
      Namespace: "AWS/AppSync", MetricName: "GraphQLRequestCount",
    }))).Metrics ?? [];
    const authDimensions = authMetrics.map(metric => metric.Dimensions?.find(dimension => dimension.Name === "AuthenticationType")?.Value).filter(Boolean);
    assert.ok(authDimensions.includes("API_KEY") && authDimensions.includes("AWS_IAM"));

    for (const override of [
      { service: "execute-api" },
      { region: "us-east-1" },
      { host: "wrong.example" },
      { path: "/graphql/wrong/path" },
    ]) {
      const rejected = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" }, override);
      assert.ok(rejected.status === 401 || rejected.status === 403);
    }
    const missingToken = await signedRequest(api.uris!.GRAPHQL!, { ...session, sessionToken: undefined }, clock, { query: "{ allowed }" });
    assert.ok(missingToken.status === 401 || missingToken.status === 403);
    const unknownCredential = await signedRequest(api.uris!.GRAPHQL!, {
      accessKeyId: "AKIAUNKNOWNCREDENTIAL", secretAccessKey: "not-a-secret",
    }, clock, { query: "{ allowed }" });
    assert.ok(unknownCredential.status === 401 || unknownCredential.status === 403);
    const wrongSecret = await signedRequest(api.uris!.GRAPHQL!, {
      ...session, secretAccessKey: "incorrect-signing-secret",
    }, clock, { query: "{ allowed }" });
    assert.ok(wrongSecret.status === 401 || wrongSecret.status === 403);
    const tamperedBody = JSON.stringify({ query: "{ other }" });
    const signedBody = JSON.stringify({ query: "{ allowed }" });
    const tampered = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: signedGraphqlHeaders(api.uris!.GRAPHQL!, signedBody, session, new Date(clock.now())),
      body: tamperedBody,
    });
    assert.ok(tampered.status === 401 || tampered.status === 403);
    const tamperedHeaders = signedGraphqlHeaders(api.uris!.GRAPHQL!, signedBody, session, new Date(clock.now()));
    tamperedHeaders["content-type"] = "application/graphql";
    const tamperedHeader = await fetch(api.uris!.GRAPHQL!, {
      method: "POST", headers: tamperedHeaders, body: signedBody,
    });
    assert.ok(tamperedHeader.status === 401 || tamperedHeader.status === 403);
    const signedQueryEndpoint = `${api.uris!.GRAPHQL!}?signed=one`;
    const tamperedQuery = await fetch(`${api.uris!.GRAPHQL!}?signed=two`, {
      method: "POST",
      headers: signedGraphqlHeaders(signedQueryEndpoint, signedBody, session, new Date(clock.now())),
      body: signedBody,
    });
    assert.ok(tamperedQuery.status === 401 || tamperedQuery.status === 403);
    const batchBody = JSON.stringify([{ query: "{ allowed }" }]);
    const batch = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: signedGraphqlHeaders(api.uris!.GRAPHQL!, batchBody, session, new Date(clock.now())),
      body: batchBody,
    });
    assert.equal(batch.status, 400);
    const expiredTimestamp = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" }, {});
    assert.equal(expiredTimestamp.status, 200);
    const staleBody = JSON.stringify({ query: "{ allowed }" });
    const stale = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: signedGraphqlHeaders(api.uris!.GRAPHQL!, staleBody, session, new Date(clock.now() - 6 * 60_000)),
      body: staleBody,
    });
    assert.ok(stale.status === 401 || stale.status === 403);
    const future = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: signedGraphqlHeaders(api.uris!.GRAPHQL!, staleBody, session, new Date(clock.now() + 6 * 60_000)),
      body: staleBody,
    });
    assert.ok(future.status === 401 || future.status === 403);

    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "graphql-fields",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "appsync:GraphQL",
        Resource: `arn:aws:appsync:${region}:${accountId}:apis/not-this-api/*`,
      }] }),
    }));
    (simulator as any).authMode = "off";
    const noGlobalBypass = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" });
    assert.equal(noGlobalBypass.value.data.allowed, null);
    assert.equal(noGlobalBypass.value.errors[0].extensions.errorType, "Unauthorized");

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions
      .filter(decision => decision.action === "appsync:GraphQL");
    assert(decisions.some(decision => decision.resource === fieldArn("allowed") && decision.decision === "allowed"));
    assert(decisions.some(decision => decision.resource === fieldArn("nullableDenied") && decision.decision === "implicitDeny"));
    assert(decisions.some(decision => decision.resource === fieldArn("requiredDenied") && decision.decision === "explicitDeny"));
    const persisted = JSON.stringify(simulator.store.regionState(region).appsync);
    assert.doesNotMatch(persisted, new RegExp(session.accessKeyId));
    assert.doesNotMatch(persisted, new RegExp(session.secretAccessKey));
    assert.doesNotMatch(persisted, new RegExp(session.sessionToken!));
    delete simulator.store.ensureAccount().iam.sessions[boundedCredentials.accessKeyId];
    await simulator.store.save();
    const deletedSession = await signedRequest(api.uris!.GRAPHQL!, boundedCredentials, clock, { query: "{ allowed }" });
    assert.ok(deletedSession.status === 401 || deletedSession.status === 403);
    clock.advance(3_601_000);
    const expiredSession = await signedRequest(api.uris!.GRAPHQL!, session, clock, { query: "{ allowed }" });
    assert.ok(expiredSession.status === 401 || expiredSession.status === 403);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
