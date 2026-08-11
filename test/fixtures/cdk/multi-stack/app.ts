import { App, CfnOutput, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import { MockIntegration, PassthroughBehavior, RestApi } from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const data = new Stack(app, "DataStack", { env, description: "stacksim multi-stack data fixture" });
const table = new Table(data, "Items", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.RETAIN,
});
new CfnOutput(data, "TableName", { value: table.tableName, exportName: "StackSimMultiStackTableName" });
new CfnOutput(data, "TableArn", { value: table.tableArn, exportName: "StackSimMultiStackTableArn" });

const apiStack = new Stack(app, "ApiStack", { env, description: "stacksim multi-stack API fixture" });
const importedTableName = Fn.importValue("StackSimMultiStackTableName");
const importedTableArn = Fn.importValue("StackSimMultiStackTableArn");
const api = new RestApi(apiStack, "Api", {
  description: Fn.join("", ["REST API for ", importedTableName, " (", importedTableArn, ")"]),
});
api.root.addMethod("GET", new MockIntegration({
  passthroughBehavior: PassthroughBehavior.NEVER,
  requestTemplates: { "application/json": '{"statusCode":200}' },
  integrationResponses: [{
    statusCode: "200",
    responseTemplates: {
      "application/json": Fn.join("", ['{"tableName":"', importedTableName, '","tableArn":"', importedTableArn, '"}']),
    },
  }],
}), { methodResponses: [{ statusCode: "200" }] });
new CfnOutput(apiStack, "ApiId", { value: api.restApiId });
new CfnOutput(apiStack, "ImportedTableName", { value: importedTableName });
new CfnOutput(apiStack, "ImportedTableArn", { value: importedTableArn });
apiStack.addDependency(data);
