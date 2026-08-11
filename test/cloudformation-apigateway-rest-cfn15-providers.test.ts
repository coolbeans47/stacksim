import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateBasePathMappingCommand,
  CreateDocumentationPartCommand,
  CreateDocumentationVersionCommand,
  CreateRestApiCommand,
  DeleteBasePathMappingCommand,
  DeleteDocumentationPartCommand,
  DeleteDocumentationVersionCommand,
  GetBasePathMappingCommand,
  GetDocumentationPartCommand,
  GetDocumentationVersionCommand,
} from "@aws-sdk/client-api-gateway";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type {
  ProductionResourceProvider,
  ProviderContext,
} from "../src/cloudformation/providers/contract.js";
import {
  API_GATEWAY_BASE_PATH_MAPPING_TYPE,
  API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE,
  API_GATEWAY_CLIENT_CERTIFICATE_TYPE,
  API_GATEWAY_DOCUMENTATION_PART_TYPE,
  API_GATEWAY_DOCUMENTATION_VERSION_TYPE,
  API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE,
  API_GATEWAY_DOMAIN_NAME_TYPE,
  API_GATEWAY_DOMAIN_NAME_V2_TYPE,
  API_GATEWAY_VPC_LINK_TYPE,
  createApiGatewayRestCfn15CloudFormationProviders,
} from "../src/cloudformation/providers/apigateway-rest-cfn15.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/cfn15-apigateway/stack-id`;
const identity: PrincipalContext = {
  accessKeyId: credentials.accessKeyId,
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId,
    logicalId,
    operationId: `${logicalId}-operation`,
    resourceOperationId: `${logicalId}-resource-operation`,
    idempotencyKey: `${logicalId}-idempotency-key`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

function provider(
  providers: ReadonlyMap<string, ProductionResourceProvider<any>>,
  typeName: string,
): ProductionResourceProvider<any> {
  const result = providers.get(typeName);
  assert.ok(result, `missing provider ${typeName}`);
  return result;
}

function success(result: any): any {
  assert.equal(result.status, "SUCCESS", result.message);
  return result;
}

function apiGatewayPhysicalId(kind: string, values: readonly string[]): string {
  return `stacksim:apigateway:${kind}:${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
}

function ownershipConflict(result: any): void {
  assert.equal(result.status, "FAILED", result.message);
  assert.equal(result.errorCode, "OwnershipConflict");
}

async function createReadReplay(
  resourceProvider: ProductionResourceProvider<any>,
  properties: unknown,
  providerContext: ProviderContext,
): Promise<any> {
  assert.deepEqual(resourceProvider.validate(properties, providerContext), []);
  const desired = resourceProvider.canonicalize(properties, providerContext);
  assert.equal(resourceProvider.plan(undefined, desired, providerContext).action, "CREATE");
  const created = success(await resourceProvider.create(desired, providerContext));
  const replay = success(await resourceProvider.create(desired, providerContext));
  assert.equal(replay.physicalId, created.physicalId);
  assert.deepEqual(replay.model.properties, desired);
  const read = success(await resourceProvider.read(created.physicalId, providerContext));
  assert.deepEqual(read.model.properties, desired);
  return created;
}

async function updateRead(
  resourceProvider: ProductionResourceProvider<any>,
  created: any,
  properties: unknown,
  providerContext: ProviderContext,
): Promise<any> {
  const desired = resourceProvider.canonicalize(properties, providerContext);
  assert.equal(resourceProvider.plan(created.model.properties, desired, providerContext).action, "UPDATE");
  const updated = success(await resourceProvider.update(
    created.physicalId,
    created.model.properties,
    desired,
    providerContext,
  ));
  const read = success(await resourceProvider.read(created.physicalId, providerContext));
  assert.deepEqual(read.model.properties, desired);
  return updated;
}

test("CFN-15 API Gateway REST administration providers expose the exact pinned nine-type contract", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn15-apigateway-schema-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  try {
    const providers = createApiGatewayRestCfn15CloudFormationProviders(simulator.apigateway);
    assert.deepEqual(
      providers.map(item => item.typeName).sort(),
      [
        API_GATEWAY_BASE_PATH_MAPPING_TYPE,
        API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE,
        API_GATEWAY_CLIENT_CERTIFICATE_TYPE,
        API_GATEWAY_DOCUMENTATION_PART_TYPE,
        API_GATEWAY_DOCUMENTATION_VERSION_TYPE,
        API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE,
        API_GATEWAY_DOMAIN_NAME_TYPE,
        API_GATEWAY_DOMAIN_NAME_V2_TYPE,
        API_GATEWAY_VPC_LINK_TYPE,
      ].sort(),
    );
    for (const item of providers) {
      assert.equal(item.visibility, "production");
      assert.equal(item.schema.unknownProperties, "REJECT");
      assert.deepEqual(item.schema.retention.deletionPolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);
      assert.equal(item.schema.retention.snapshotSupported, false);
    }
  } finally {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CFN-15 untaggable API Gateway resources reject identical foreign state, preserve it, and replay only owned creates", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn15-apigateway-ownership-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let client: APIGatewayClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new APIGatewayClient({ endpoint, region, credentials });
    const restApiId = String((await client.send(new CreateRestApiCommand({ name: "cfn15-ownership" }))).id);
    const providers = new Map(
      createApiGatewayRestCfn15CloudFormationProviders(simulator.apigateway)
        .map(item => [item.typeName, item] as const),
    );
    const publicDomainProvider = provider(providers, API_GATEWAY_DOMAIN_NAME_TYPE);
    const publicMappingProvider = provider(providers, API_GATEWAY_BASE_PATH_MAPPING_TYPE);
    const privateDomainProvider = provider(providers, API_GATEWAY_DOMAIN_NAME_V2_TYPE);
    const privateMappingProvider = provider(providers, API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE);
    const partProvider = provider(providers, API_GATEWAY_DOCUMENTATION_PART_TYPE);
    const versionProvider = provider(providers, API_GATEWAY_DOCUMENTATION_VERSION_TYPE);
    const certificateArn = `arn:aws:acm:${region}:${accountId}:certificate/cfn15-ownership`;

    const publicDomainContext = context("OwnershipPublicDomain");
    const publicDomain = await createReadReplay(publicDomainProvider, {
      CertificateArn: certificateArn,
      DomainName: "ownership-public.example.test",
      EndpointConfiguration: { Types: ["EDGE"] },
    }, publicDomainContext);
    const privateDomainContext = context("OwnershipPrivateDomain");
    const privateDomain = await createReadReplay(privateDomainProvider, {
      CertificateArn: certificateArn,
      DomainName: "ownership-private.example.test",
      EndpointConfiguration: { Types: ["PRIVATE"], IpAddressType: "dualstack" },
    }, privateDomainContext);
    const privateDomainArn = String(privateDomainProvider.ref(privateDomain.model));
    const privateDomainId = String(privateDomainProvider.getAtt(privateDomain.model, "DomainNameId"));

    const publicMappingContext = context("OwnershipPublicMapping");
    const publicMappingProperties = {
      BasePath: "foreign",
      DomainName: "ownership-public.example.test",
      RestApiId: restApiId,
    };
    const publicMappingDesired = publicMappingProvider.canonicalize(
      publicMappingProperties,
      publicMappingContext,
    );
    await client.send(new CreateBasePathMappingCommand({
      domainName: "ownership-public.example.test",
      basePath: "foreign",
      restApiId,
    }));
    ownershipConflict(await publicMappingProvider.create(publicMappingDesired, publicMappingContext));
    ownershipConflict(await publicMappingProvider.delete(
      apiGatewayPhysicalId("base-path-mapping", ["ownership-public.example.test", "foreign"]),
      publicMappingDesired,
      publicMappingContext,
    ));
    const foreignPublicMapping = await client.send(new GetBasePathMappingCommand({
      domainName: "ownership-public.example.test",
      basePath: "foreign",
    }));
    assert.equal(foreignPublicMapping.restApiId, restApiId);
    assert.equal((foreignPublicMapping as any).cloudFormationOwner, undefined);
    assert.equal((foreignPublicMapping as any).cloudFormationOperationToken, undefined);
    await client.send(new DeleteBasePathMappingCommand({
      domainName: "ownership-public.example.test",
      basePath: "foreign",
    }));
    const ownedPublicMapping = await createReadReplay(
      publicMappingProvider,
      publicMappingProperties,
      publicMappingContext,
    );
    const rawPublicMapping = await (await fetch(
      `${endpoint}/domainnames/ownership-public.example.test/basepathmappings/foreign`,
    )).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(rawPublicMapping, "cloudFormationOwner"), false);
    assert.equal(Object.hasOwn(rawPublicMapping, "cloudFormationOperationToken"), false);

    const privateMappingContext = context("OwnershipPrivateMapping");
    const privateMappingProperties = {
      BasePath: "foreign-private",
      DomainNameArn: privateDomainArn,
      RestApiId: restApiId,
    };
    const privateMappingDesired = privateMappingProvider.canonicalize(
      privateMappingProperties,
      privateMappingContext,
    );
    await client.send(new CreateBasePathMappingCommand({
      domainName: "ownership-private.example.test",
      domainNameId: privateDomainId,
      basePath: "foreign-private",
      restApiId,
    }));
    ownershipConflict(await privateMappingProvider.create(privateMappingDesired, privateMappingContext));
    ownershipConflict(await privateMappingProvider.delete(
      apiGatewayPhysicalId("base-path-mapping-v2", [privateDomainArn, "foreign-private"]),
      privateMappingDesired,
      privateMappingContext,
    ));
    const foreignPrivateMapping = await client.send(new GetBasePathMappingCommand({
      domainName: "ownership-private.example.test",
      domainNameId: privateDomainId,
      basePath: "foreign-private",
    }));
    assert.equal(foreignPrivateMapping.restApiId, restApiId);
    assert.equal((foreignPrivateMapping as any).cloudFormationOwner, undefined);
    assert.equal((foreignPrivateMapping as any).cloudFormationOperationToken, undefined);
    await client.send(new DeleteBasePathMappingCommand({
      domainName: "ownership-private.example.test",
      domainNameId: privateDomainId,
      basePath: "foreign-private",
    }));
    const ownedPrivateMapping = await createReadReplay(
      privateMappingProvider,
      privateMappingProperties,
      privateMappingContext,
    );
    const rawPrivateMapping = await (await fetch(
      `${endpoint}/domainnames/ownership-private.example.test/basepathmappings/foreign-private?domainNameId=${privateDomainId}`,
    )).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(rawPrivateMapping, "cloudFormationOwner"), false);
    assert.equal(Object.hasOwn(rawPrivateMapping, "cloudFormationOperationToken"), false);

    const partContext = context("OwnershipDocumentationPart");
    const partProperties = {
      Location: { Type: "API" },
      Properties: "{\"description\":\"foreign\"}",
      RestApiId: restApiId,
    };
    const partDesired = partProvider.canonicalize(partProperties, partContext);
    const foreignPart = await client.send(new CreateDocumentationPartCommand({
      restApiId,
      location: { type: "API" },
      properties: "{\"description\":\"foreign\"}",
    }));
    const foreignPartId = String(foreignPart.id);
    ownershipConflict(await partProvider.create(partDesired, partContext));
    ownershipConflict(await partProvider.delete(
      apiGatewayPhysicalId("documentation-part", [restApiId, foreignPartId]),
      partDesired,
      partContext,
    ));
    const persistedForeignPart = await client.send(new GetDocumentationPartCommand({
      restApiId,
      documentationPartId: foreignPartId,
    }));
    assert.equal(persistedForeignPart.id, foreignPartId);
    assert.equal((persistedForeignPart as any).cloudFormationOwner, undefined);
    assert.equal((persistedForeignPart as any).cloudFormationOperationToken, undefined);
    await client.send(new DeleteDocumentationPartCommand({
      restApiId,
      documentationPartId: foreignPartId,
    }));
    const ownedPart = await createReadReplay(partProvider, partProperties, partContext);
    const ownedPartId = String(partProvider.ref(ownedPart.model));
    const rawPart = await (await fetch(
      `${endpoint}/restapis/${restApiId}/documentation/parts/${ownedPartId}`,
    )).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(rawPart, "cloudFormationOwner"), false);
    assert.equal(Object.hasOwn(rawPart, "cloudFormationOperationToken"), false);

    const versionContext = context("OwnershipDocumentationVersion");
    const versionProperties = {
      Description: "foreign",
      DocumentationVersion: "foreign-v1",
      RestApiId: restApiId,
    };
    const versionDesired = versionProvider.canonicalize(versionProperties, versionContext);
    await client.send(new CreateDocumentationVersionCommand({
      restApiId,
      documentationVersion: "foreign-v1",
      description: "foreign",
    }));
    ownershipConflict(await versionProvider.create(versionDesired, versionContext));
    ownershipConflict(await versionProvider.delete(
      apiGatewayPhysicalId("documentation-version", [restApiId, "foreign-v1"]),
      versionDesired,
      versionContext,
    ));
    const persistedForeignVersion = await client.send(new GetDocumentationVersionCommand({
      restApiId,
      documentationVersion: "foreign-v1",
    }));
    assert.equal(persistedForeignVersion.version, "foreign-v1");
    assert.equal((persistedForeignVersion as any).cloudFormationOwner, undefined);
    assert.equal((persistedForeignVersion as any).cloudFormationOperationToken, undefined);
    await client.send(new DeleteDocumentationVersionCommand({
      restApiId,
      documentationVersion: "foreign-v1",
    }));
    const ownedVersion = await createReadReplay(versionProvider, versionProperties, versionContext);
    const rawVersion = await (await fetch(
      `${endpoint}/restapis/${restApiId}/documentation/versions/foreign-v1`,
    )).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(rawVersion, "cloudFormationOwner"), false);
    assert.equal(Object.hasOwn(rawVersion, "cloudFormationOperationToken"), false);

    success(await versionProvider.delete(
      ownedVersion.physicalId,
      ownedVersion.model.properties,
      versionContext,
    ));
    success(await partProvider.delete(ownedPart.physicalId, ownedPart.model.properties, partContext));
    success(await privateMappingProvider.delete(
      ownedPrivateMapping.physicalId,
      ownedPrivateMapping.model.properties,
      privateMappingContext,
    ));
    success(await publicMappingProvider.delete(
      ownedPublicMapping.physicalId,
      ownedPublicMapping.model.properties,
      publicMappingContext,
    ));
    success(await privateDomainProvider.delete(
      privateDomain.physicalId,
      privateDomain.model.properties,
      privateDomainContext,
    ));
    success(await publicDomainProvider.delete(
      publicDomain.physicalId,
      publicDomain.model.properties,
      publicDomainContext,
    ));
  } finally {
    client?.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CFN-15 API Gateway REST administration providers reconcile authoritative create, replay, update, read, Ref/GetAtt, and delete state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn15-apigateway-lifecycle-"));
  const targetArn = `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/net/cfn15/0123456789abcdef`;
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir,
    accountId,
    region,
    apiGatewayAllowClientCertificates: true,
    apiGatewayVpcLinkOrigins: { [targetArn]: "http://127.0.0.1:65535" },
  authMode: "off"});
  let client: APIGatewayClient | undefined;
  try {
    await simulator.start();
    client = new APIGatewayClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
    });
    const firstApiId = String((await client.send(new CreateRestApiCommand({ name: "cfn15-first" }))).id);
    const secondApiId = String((await client.send(new CreateRestApiCommand({ name: "cfn15-second" }))).id);
    const providers = new Map(
      createApiGatewayRestCfn15CloudFormationProviders(simulator.apigateway)
        .map(item => [item.typeName, item] as const),
    );
    const publicDomainProvider = provider(providers, API_GATEWAY_DOMAIN_NAME_TYPE);
    const mappingProvider = provider(providers, API_GATEWAY_BASE_PATH_MAPPING_TYPE);
    const privateDomainProvider = provider(providers, API_GATEWAY_DOMAIN_NAME_V2_TYPE);
    const privateMappingProvider = provider(providers, API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE);
    const associationProvider = provider(providers, API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE);
    const vpcLinkProvider = provider(providers, API_GATEWAY_VPC_LINK_TYPE);
    const certificateProvider = provider(providers, API_GATEWAY_CLIENT_CERTIFICATE_TYPE);
    const partProvider = provider(providers, API_GATEWAY_DOCUMENTATION_PART_TYPE);
    const versionProvider = provider(providers, API_GATEWAY_DOCUMENTATION_VERSION_TYPE);

    const certificateArn = `arn:aws:acm:${region}:${accountId}:certificate/cfn15-certificate`;
    const publicContext = context("PublicDomain");
    const publicDomain = await createReadReplay(publicDomainProvider, {
      CertificateArn: certificateArn,
      DomainName: "public.example.test",
      EndpointConfiguration: { Types: ["EDGE"] },
      Tags: [{ Key: "environment", Value: "test" }],
    }, publicContext);
    assert.equal(publicDomainProvider.ref(publicDomain.model), "public.example.test");
    assert.match(String(publicDomainProvider.getAtt(publicDomain.model, "DomainNameArn")), /\/domainnames\/public\.example\.test$/);
    const foreignRead = await publicDomainProvider.read(publicDomain.physicalId, context("ForeignDomainOwner"));
    assert.equal(foreignRead.status, "FAILED");
    assert.equal((foreignRead as any).errorCode, "OwnershipConflict");
    const publicDomainUpdated = await updateRead(publicDomainProvider, publicDomain, {
      CertificateArn: certificateArn,
      DomainName: "public.example.test",
      EndpointConfiguration: { Types: ["EDGE"] },
      RoutingMode: "ROUTING_RULE_THEN_BASE_PATH_MAPPING",
      Tags: [],
    }, publicContext);

    const mappingContext = context("PublicMapping");
    const publicMapping = await createReadReplay(mappingProvider, {
      BasePath: "docs",
      DomainName: "public.example.test",
      RestApiId: firstApiId,
    }, mappingContext);
    assert.equal(mappingProvider.ref(publicMapping.model), "public.example.test|docs");
    const publicMappingUpdated = await updateRead(mappingProvider, publicMapping, {
      BasePath: "docs",
      DomainName: "public.example.test",
      RestApiId: secondApiId,
    }, mappingContext);

    const privateContext = context("PrivateDomain");
    const privateDomain = await createReadReplay(privateDomainProvider, {
      CertificateArn: certificateArn,
      DomainName: "private.example.test",
      EndpointConfiguration: { Types: ["PRIVATE"], IpAddressType: "dualstack" },
      Policy: { Version: "2012-10-17", Statement: [] },
      Tags: [{ Key: "scope", Value: "private" }],
    }, privateContext);
    const privateDomainArn = String(privateDomainProvider.ref(privateDomain.model));
    assert.equal(privateDomainProvider.getAtt(privateDomain.model, "DomainNameArn"), privateDomainArn);
    const privateDomainUpdated = await updateRead(privateDomainProvider, privateDomain, {
      CertificateArn: certificateArn,
      DomainName: "private.example.test",
      EndpointConfiguration: { Types: ["PRIVATE"], IpAddressType: "dualstack" },
      Policy: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: "*", Action: "execute-api:Invoke", Resource: "*" }],
      },
      RoutingMode: "ROUTING_RULE_THEN_BASE_PATH_MAPPING",
      Tags: [{ Key: "scope", Value: "updated" }],
    }, privateContext);

    const privateMappingContext = context("PrivateMapping");
    const privateMapping = await createReadReplay(privateMappingProvider, {
      BasePath: "private",
      DomainNameArn: privateDomainArn,
      RestApiId: firstApiId,
    }, privateMappingContext);
    assert.equal(
      privateMappingProvider.ref(privateMapping.model),
      privateMappingProvider.getAtt(privateMapping.model, "BasePathMappingArn"),
    );
    const privateMappingUpdated = await updateRead(privateMappingProvider, privateMapping, {
      BasePath: "private",
      DomainNameArn: privateDomainArn,
      RestApiId: secondApiId,
    }, privateMappingContext);

    const associationContext = context("AccessAssociation");
    const association = await createReadReplay(associationProvider, {
      AccessAssociationSource: "vpce-0123456789abcdef0",
      AccessAssociationSourceType: "VPCE",
      DomainNameArn: privateDomainArn,
      Tags: [{ Key: "purpose", Value: "test" }],
    }, associationContext);
    assert.equal(
      associationProvider.ref(association.model),
      associationProvider.getAtt(association.model, "DomainNameAccessAssociationArn"),
    );
    const changedAssociation = associationProvider.canonicalize({
      AccessAssociationSource: "vpce-0123456789abcdef0",
      AccessAssociationSourceType: "VPCE",
      DomainNameArn: privateDomainArn,
      Tags: [{ Key: "purpose", Value: "replacement" }],
    }, associationContext);
    assert.equal(
      associationProvider.plan(association.model.properties, changedAssociation, associationContext).action,
      "REPLACE",
    );

    const vpcContext = context("VpcLink");
    const vpcLink = await createReadReplay(vpcLinkProvider, {
      Description: "initial",
      Name: "cfn15-vpc-link",
      Tags: [{ Key: "obsolete", Value: "remove-me" }, { Key: "team", Value: "api" }],
      TargetArns: [targetArn],
    }, vpcContext);
    assert.equal(vpcLinkProvider.ref(vpcLink.model), vpcLinkProvider.getAtt(vpcLink.model, "VpcLinkId"));
    const vpcLinkUpdated = await updateRead(vpcLinkProvider, vpcLink, {
      Description: "updated",
      Name: "cfn15-vpc-link-updated",
      Tags: [{ Key: "team", Value: "platform" }],
      TargetArns: [targetArn],
    }, vpcContext);

    const certificateContext = context("ClientCertificate");
    const clientCertificate = await createReadReplay(certificateProvider, {
      Description: "initial",
      Tags: [{ Key: "obsolete", Value: "remove-me" }, { Key: "team", Value: "api" }],
    }, certificateContext);
    assert.equal(
      certificateProvider.ref(clientCertificate.model),
      certificateProvider.getAtt(clientCertificate.model, "ClientCertificateId"),
    );
    const clientCertificateUpdated = await updateRead(certificateProvider, clientCertificate, {
      Description: "updated",
      Tags: [{ Key: "team", Value: "platform" }],
    }, certificateContext);

    const partContext = context("DocumentationPart");
    const documentationPart = await createReadReplay(partProvider, {
      Location: { Type: "API" },
      Properties: "{\"description\":\"initial\"}",
      RestApiId: firstApiId,
    }, partContext);
    assert.equal(partProvider.ref(documentationPart.model), partProvider.getAtt(documentationPart.model, "DocumentationPartId"));
    const documentationPartUpdated = await updateRead(partProvider, documentationPart, {
      Location: { Type: "API" },
      Properties: "{\"description\":\"updated\",\"summary\":\"CFN-15\"}",
      RestApiId: firstApiId,
    }, partContext);

    const versionContext = context("DocumentationVersion");
    const documentationVersion = await createReadReplay(versionProvider, {
      Description: "initial",
      DocumentationVersion: "v1",
      RestApiId: firstApiId,
    }, versionContext);
    assert.equal(versionProvider.ref(documentationVersion.model), `v1|${firstApiId}`);
    const documentationVersionUpdated = await updateRead(versionProvider, documentationVersion, {
      Description: "updated",
      DocumentationVersion: "v1",
      RestApiId: firstApiId,
    }, versionContext);

    for (const [resourceProvider, created, current, providerContext] of [
      [versionProvider, documentationVersion, documentationVersionUpdated, versionContext],
      [partProvider, documentationPart, documentationPartUpdated, partContext],
      [certificateProvider, clientCertificate, clientCertificateUpdated, certificateContext],
      [vpcLinkProvider, vpcLink, vpcLinkUpdated, vpcContext],
      [associationProvider, association, association, associationContext],
      [privateMappingProvider, privateMapping, privateMappingUpdated, privateMappingContext],
      [privateDomainProvider, privateDomain, privateDomainUpdated, privateContext],
      [mappingProvider, publicMapping, publicMappingUpdated, mappingContext],
      [publicDomainProvider, publicDomain, publicDomainUpdated, publicContext],
    ] as const) {
      success(await resourceProvider.delete(created.physicalId, current.model.properties, providerContext));
      assert.equal((await resourceProvider.read(created.physicalId, providerContext)).status, "NOT_FOUND");
      assert.equal((await resourceProvider.delete(created.physicalId, current.model.properties, providerContext)).status, "NOT_FOUND");
    }
  } finally {
    client?.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
