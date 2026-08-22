import { App, Stack } from "aws-cdk-lib";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const stack = new Stack(app, "Cfn17InvalidTable", { env: { account, region } });
const table = new CfnTable(stack, "Table", {
  tableName: "cfn17-invalid-table",
  billingMode: "PAY_PER_REQUEST",
  attributeDefinitions: [{ attributeName: "id", attributeType: "S" }],
  keySchema: [{ attributeName: "id", keyType: "HASH" }],
});
table.overrideLogicalId("InvalidTable");
table.addPropertyOverride("StackSimInvalidAlpha", "redact-me-alpha");
table.addPropertyOverride("StackSimInvalidBeta", "redact-me-beta");
