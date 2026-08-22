import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, Billing, ProjectionType, TableClass, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const stack = new Stack(app, "TableV2Fixture", { env: { account, region } });

new TableV2(stack, "AuthTable", {
  tableName: "stacksim-shipments-dev-auth",
  removalPolicy: RemovalPolicy.DESTROY,
  partitionKey: { name: "id", type: AttributeType.STRING },
  sortKey: { name: "type", type: AttributeType.STRING },
  billing: Billing.onDemand(),
  encryption: TableEncryptionV2.dynamoOwnedKey(),
  globalSecondaryIndexes: [
    { indexName: "email-index", partitionKey: { name: "email", type: AttributeType.STRING }, projectionType: ProjectionType.KEYS_ONLY },
    { indexName: "company-memberships-index", partitionKey: { name: "cid", type: AttributeType.STRING }, sortKey: { name: "userId", type: AttributeType.STRING }, projectionType: ProjectionType.KEYS_ONLY },
    { indexName: "user-memberships-index", partitionKey: { name: "userId", type: AttributeType.STRING }, sortKey: { name: "cid", type: AttributeType.STRING }, projectionType: ProjectionType.KEYS_ONLY },
  ],
  deletionProtection: false,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 35 },
  tableClass: TableClass.STANDARD,
  tags: [
    { key: "Application", value: "StackSimShipments" },
    { key: "DataClassification", value: "Confidential" },
    { key: "Environment", value: "dev" },
    { key: "ManagedBy", value: "CDK" },
  ],
});
