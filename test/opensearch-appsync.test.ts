import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as AppSync from "@aws-sdk/client-appsync";
import * as Iam from "@aws-sdk/client-iam";
import * as Cfn from "@aws-sdk/client-cloudformation";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../src/server.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const response = '#if($ctx.error) $util.error($ctx.error.message, $ctx.error.type) #end $util.toJson($ctx.result._source)';
const get = '{"version":"2017-02-28","operation":"GET","path":"/products/_doc/$ctx.args.id"}';
async function active(sim: StackSim) { for (let i = 0; i < 200 && sim.opensearch.domain(region, "graphql-search").state !== "active"; i++) await delay(10); return sim.opensearch.domain(region, "graphql-search"); }

test("AppSync OpenSearch resolvers execute under source-scoped roles, enforce IAM and domain policies, and recover after restart", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-search-")), options = { port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" as const, cdkBootstrap: false }; let sim = new StackSim(options);
  let appsync: AppSync.AppSyncClient | undefined, iam: Iam.IAMClient | undefined, search: Client | undefined, limited: AppSync.AppSyncClient | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; appsync = new AppSync.AppSyncClient(sdk); iam = new Iam.IAMClient(sdk); return sdk; };
  try {
    await sim.start(); const sdk = connect(); await sim.opensearch.execute("CreateDomain", { DomainName: "graphql-search", EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${sim.store.accountId}:user/admin` } } }, region); const domain = await active(sim), endpoint = `https://127.0.0.1:${domain.gatewayPort}`;
    search = new Client({ node: endpoint, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    const api = (await appsync!.send(new AppSync.CreateGraphqlApiCommand({ name: "search-api", authenticationType: "API_KEY" }))).graphqlApi!;
    const apiKey = (await appsync!.send(new AppSync.CreateApiKeyCommand({ apiId: api.apiId! }))).apiKey!.id!;
    await appsync!.send(new AppSync.StartSchemaCreationCommand({ apiId: api.apiId!, definition: Buffer.from('type Product { name: String } type Query { get(id: ID!): Product pipelineGet(id: ID!): Product } type Mutation { put(id: ID!, name: String!): String }') }));
    for (let i = 0; i < 200; i++) { const status = await appsync!.send(new AppSync.GetSchemaCreationStatusCommand({ apiId: api.apiId! })); if (status.status === "SUCCESS") break; assert.notEqual(status.status, "FAILED", status.details); await delay(10); }
    const trust = (source = api.arn) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "appsync.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": sim.store.accountId }, ArnEquals: { "aws:SourceArn": source } } }] });
    const role = (await iam!.send(new Iam.CreateRoleCommand({ RoleName: "GraphqlSearch", AssumeRolePolicyDocument: trust() }))).Role!;
    const source = { apiId: api.apiId!, name: "Search", type: "AMAZON_OPENSEARCH_SERVICE" as const, serviceRoleArn: role.Arn!, openSearchServiceConfig: { endpoint, awsRegion: region } };
    await assert.rejects(appsync!.send(new AppSync.CreateDataSourceCommand({ ...source, openSearchServiceConfig: { endpoint: "https://example.com", awsRegion: region } })), /current same-account/);
    await assert.rejects(appsync!.send(new AppSync.CreateDataSourceCommand({ ...source, openSearchServiceConfig: { endpoint, awsRegion: "us-east-1" } })), /Region/);
    await iam!.send(new Iam.CreateUserCommand({ UserName: "graphql-manager" })); await iam!.send(new Iam.PutUserPolicyCommand({ UserName: "graphql-manager", PolicyName: "manage", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "appsync:*", Resource: "*" }] }) }));
    const access = (await iam!.send(new Iam.CreateAccessKeyCommand({ UserName: "graphql-manager" }))).AccessKey!; limited = new AppSync.AppSyncClient({ ...sdk, credentials: { accessKeyId: access.AccessKeyId!, secretAccessKey: access.SecretAccessKey! } });
    await assert.rejects(limited.send(new AppSync.CreateDataSourceCommand(source)), /PassRole/);
    await appsync!.send(new AppSync.CreateDataSourceCommand(source));
    assert.deepEqual((await appsync!.send(new AppSync.GetDataSourceCommand({ apiId: api.apiId!, name: "Search" }))).dataSource!.openSearchServiceConfig, source.openSearchServiceConfig);
    await appsync!.send(new AppSync.CreateResolverCommand({ apiId: api.apiId!, typeName: "Query", fieldName: "get", dataSourceName: "Search", requestMappingTemplate: get, responseMappingTemplate: response }));
    await appsync!.send(new AppSync.CreateResolverCommand({ apiId: api.apiId!, typeName: "Mutation", fieldName: "put", dataSourceName: "Search", requestMappingTemplate: '{"version":"2017-02-28","operation":"PUT","path":"/products/_doc/$ctx.args.id","params":{"queryString":{"refresh":"true"},"body":{"name":$util.toJson($ctx.args.name)}}}', responseMappingTemplate: '#if($ctx.error) $util.error($ctx.error.message, $ctx.error.type) #end $util.toJson($ctx.result.result)' }));
    const fn = (await appsync!.send(new AppSync.CreateFunctionCommand({ apiId: api.apiId!, name: "Fetch", dataSourceName: "Search", functionVersion: "2018-05-29", requestMappingTemplate: get, responseMappingTemplate: response }))).functionConfiguration!;
    await appsync!.send(new AppSync.CreateResolverCommand({ apiId: api.apiId!, typeName: "Query", fieldName: "pipelineGet", kind: "PIPELINE", pipelineConfig: { functions: [fn.functionId!] }, requestMappingTemplate: '{}', responseMappingTemplate: '$util.toJson($ctx.prev.result)' }));
    // Resolve the exact authoritative path returned by the service.
    let graphqlUrl = api.uris!.GRAPHQL!;
    const run = async (query: string) => (await fetch(graphqlUrl, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ query }) })).json() as Promise<any>;
    assert.ok((await run('mutation { put(id:"one", name:"Sneakers") }')).errors?.length);
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: "GraphqlSearch", PolicyName: "search", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["es:ESHttpGet", "es:ESHttpPut"], Resource: `${domain.arn}/products/*` }] }) }));
    assert.ok((await run('mutation { put(id:"one", name:"Sneakers") }')).errors?.length, "IAM alone cannot bypass FGAC");
    const permissions = { cluster_permissions: [], index_permissions: [{ index_patterns: ["products"], allowed_actions: ["crud", "create_index"] }] };
    await search.transport.request({ method: "PUT", path: "/_plugins/_security/api/roles/graphql", body: permissions });
    await search.transport.request({ method: "PUT", path: "/_plugins/_security/api/rolesmapping/graphql", body: { backend_roles: [role.Arn] } });
    assert.deepEqual((await run('mutation { put(id:"one", name:"Sneakers") }')).data, { put: "created" });
    assert.deepEqual((await run('{ get(id:"one") { name } pipelineGet(id:"one") { name } }')).data, { get: { name: "Sneakers" }, pipelineGet: { name: "Sneakers" } });
    assert.equal((await search.get({ index: "products", id: "one" })).body._source.name, "Sneakers");
    await search.transport.request({ method: "PUT", path: "/_plugins/_security/api/roles/graphql", body: { cluster_permissions: [], index_permissions: [{ index_patterns: ["products"], allowed_actions: ["read"], fls: ["~name"] }] } });
    assert.deepEqual((await run('{ get(id:"one") { name } }')).data, { get: { name: null } });
    await search.transport.request({ method: "PUT", path: "/_plugins/_security/api/roles/graphql", body: permissions });
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: "GraphqlSearch", PolicyName: "deny", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "es:ESHttpPut", Resource: `${domain.arn}/*` }] }) }));
    assert.ok((await run('mutation { put(id:"one", name:"denied") }')).errors?.length); assert.equal((await search.get({ index: "products", id: "one" })).body._version, 1);
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: "GraphqlSearch", PolicyName: "deny" }));
    await sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: role.Arn }, Action: "es:ESHttpGet", Resource: `${domain.arn}/*` }] }) }, region);
    assert.ok((await run('{ get(id:"one") { name } }')).errors?.length);
    await sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: role.Arn }, Action: "es:ESHttpGet", Resource: `${domain.arn}/*` }] }) }, region);
    await iam!.send(new Iam.UpdateAssumeRolePolicyCommand({ RoleName: "GraphqlSearch", PolicyDocument: trust(api.arn + "wrong") })); assert.ok((await run('{ get(id:"one") { name } }')).errors?.length);
    await iam!.send(new Iam.UpdateAssumeRolePolicyCommand({ RoleName: "GraphqlSearch", PolicyDocument: trust() }));
    await search.close(); search = undefined; appsync!.destroy(); iam!.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); graphqlUrl = (await appsync!.send(new AppSync.GetGraphqlApiCommand({ apiId: api.apiId! }))).graphqlApi!.uris!.GRAPHQL!;
    assert.deepEqual((await run('{ get(id:"one") { name } }')).data, { get: { name: "Sneakers" } });
    await sim.opensearch.execute("DeleteDomain", { DomainName: domain.name }, region); assert.ok((await run('{ get(id:"one") { name } }')).errors?.length);
  } finally { await search?.close(); appsync?.destroy(); iam?.destroy(); limited?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation AppSync OpenSearch data sources create, update and clean up through the owning services", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-search-cfn-")), sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let cfn: Cfn.CloudFormationClient | undefined, appsync: AppSync.AppSyncClient | undefined, search: Client | undefined;
  const template = (description: string) => JSON.stringify({ Resources: {
    Domain: { Type: "AWS::OpenSearchService::Domain", Properties: { DomainName: "graphql-search" } },
    Api: { Type: "AWS::AppSync::GraphQLApi", Properties: { Name: "cfn-search", AuthenticationType: "API_KEY" } },
    Schema: { Type: "AWS::AppSync::GraphQLSchema", Properties: { ApiId: { "Fn::GetAtt": ["Api", "ApiId"] }, Definition: 'type Product { name: String } type Query { get(id: ID!): Product } schema { query: Query }' } },
    Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "appsync.amazonaws.com" }, Condition: { ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": ["Api", "Arn"] } } } }] }, Policies: [{ PolicyName: "search", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:ESHttpGet", Resource: { "Fn::Sub": "${Domain.Arn}/products/*" } }] } }] } },
    Source: { Type: "AWS::AppSync::DataSource", Properties: { ApiId: { "Fn::GetAtt": ["Api", "ApiId"] }, Name: "Search", Type: "AMAZON_OPENSEARCH_SERVICE", Description: description, ServiceRoleArn: { "Fn::GetAtt": ["Role", "Arn"] }, OpenSearchServiceConfig: { Endpoint: { "Fn::Sub": "https://${Domain.DomainEndpoint}" }, AwsRegion: { Ref: "AWS::Region" } } } },
    Resolver: { Type: "AWS::AppSync::Resolver", DependsOn: ["Source", "Schema"], Properties: { ApiId: { "Fn::GetAtt": ["Api", "ApiId"] }, TypeName: "Query", FieldName: "get", DataSourceName: { "Fn::GetAtt": ["Source", "Name"] }, RequestMappingTemplate: get, ResponseMappingTemplate: response } },
  }, Outputs: { ApiId: { Value: { "Fn::GetAtt": ["Api", "ApiId"] } }, Url: { Value: { "Fn::GetAtt": ["Api", "GraphQLUrl"] } } } });
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; cfn = new Cfn.CloudFormationClient(sdk); appsync = new AppSync.AppSyncClient(sdk);
    const id = (await cfn.send(new Cfn.CreateStackCommand({ StackName: "graphql-search", TemplateBody: template("first"), Capabilities: ["CAPABILITY_IAM"] }))).StackId!;
    const wait = async (expected: string) => { for (let i = 0; i < 400; i++) { const stack = (await cfn!.send(new Cfn.DescribeStacksCommand({ StackName: id }))).Stacks![0]; if (stack.StackStatus === expected) return Object.fromEntries((stack.Outputs ?? []).map(value => [value.OutputKey!, value.OutputValue!])); if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(10); } throw new Error(`Stack did not reach ${expected}`); };
    const outputs = await wait("CREATE_COMPLETE"), domain = await active(sim);
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    await search.index({ index: "products", id: "one", body: { name: "Stack product" } });
    const key = (await appsync.send(new AppSync.CreateApiKeyCommand({ apiId: outputs.ApiId }))).apiKey!.id!;
    const result = await (await fetch(outputs.Url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ query: '{ get(id:"one") { name } }' }) })).json(); assert.deepEqual(result, { data: { get: { name: "Stack product" } } });
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: id, TemplateBody: template("updated"), Capabilities: ["CAPABILITY_IAM"] })); await wait("UPDATE_COMPLETE");
    assert.equal((await appsync.send(new AppSync.GetDataSourceCommand({ apiId: outputs.ApiId, name: "Search" }))).dataSource!.description, "updated");
    await search.close(); search = undefined; await cfn.send(new Cfn.DeleteStackCommand({ StackName: id })); await wait("DELETE_COMPLETE"); assert.equal(sim.opensearch.domains(region).length, 0);
  } finally { await search?.close(); cfn?.destroy(); appsync?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
