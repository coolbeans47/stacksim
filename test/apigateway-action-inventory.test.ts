import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sdk from "@aws-sdk/client-api-gateway";
import { API_GATEWAY_V1_ACTIONS } from "../src/apigateway/action-inventory.js";
import { StackSim } from "../src/server.js";

test("current API Gateway v1 inventory matches the official SDK and every command reaches a modeled service route", async () => {
  const sdkActions = Object.keys(sdk).filter(name => name.endsWith("Command") && name !== "$Command" && name !== "APIGatewayServiceException").map(name => name.slice(0, -"Command".length)).sort();
  assert.equal(API_GATEWAY_V1_ACTIONS.length, 124); assert.deepEqual([...API_GATEWAY_V1_ACTIONS].sort(), sdkActions);
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-inventory-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); await simulator.start();
  const client = new sdk.APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
  const sample: Record<string, any> = { restApiId: "missing", resourceId: "missing", parentId: "missing", httpMethod: "GET", statusCode: "200", responseType: "DEFAULT_4XX", authorizerId: "missing", modelName: "missing", requestValidatorId: "missing", deploymentId: "missing", stageName: "dev", documentationPartId: "missing", documentationVersion: "v1", domainName: "example.test", domainNameId: "missing", domainNameAccessAssociationArn: "arn:aws:apigateway:eu-west-1:000000000000:/domainnameaccessassociations/missing", domainNameArn: "arn:aws:apigateway:eu-west-1:000000000000:/domainnames/example.test+missing", basePath: "(none)", apiKey: "missing", usagePlanId: "missing", keyId: "missing", clientCertificateId: "missing", vpcLinkId: "missing", resourceArn: "arn:aws:apigateway:eu-west-1::/vpclinks/missing", exportType: "oas30", sdkType: "javascript", id: "javascript", name: "inventory", pathPart: "child", authorizationType: "NONE", type: "API", integrationHttpMethod: "POST", location: { type: "API" }, properties: "{}", body: Buffer.from("{}"), format: "csv", targetArns: ["arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/net/inventory/0123456789abcdef"], tags: {}, patchOperations: [], keyType: "API_KEY", keyIds: [], accessAssociationSourceType: "VPCE", accessAssociationSource: "vpce-missing" };
  try {
    for (const action of API_GATEWAY_V1_ACTIONS) {
      const Command = (sdk as any)[`${action}Command`];
      try { await client.send(new Command(sample)); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); assert.doesNotMatch(message, /Unknown service route|Unknown API Gateway route/, action); }
    }
  } finally { client.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});
