export function cloudFormationConsoleStackTemplate(analytics: string): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Real browser Lambda, REST API, and DynamoDB stack",
    Parameters: {
      Environment: { Type: "String", Default: "browser" },
    },
    Resources: {
      ItemsTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: "console-stack-items",
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          Tags: [{ Key: "environment", Value: { Ref: "Environment" } }],
        },
      },
      FunctionLogs: {
        Type: "AWS::Logs::LogGroup",
        Properties: { LogGroupName: "/aws/lambda/console-stack-handler", RetentionInDays: 7 },
      },
      FunctionRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: "console-stack-function-role",
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
          },
          Tags: [{ Key: "environment", Value: { Ref: "Environment" } }],
        },
      },
      Function: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["FunctionLogs", "FunctionRole"],
        Properties: {
          FunctionName: "console-stack-handler",
          Description: "CloudFormation console browser fixture",
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          Role: { "Fn::GetAtt": ["FunctionRole", "Arn"] },
          Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200, body: 'ok' });" },
          Environment: { Variables: { TABLE_NAME: { Ref: "ItemsTable" } } },
          LoggingConfig: { LogGroup: { Ref: "FunctionLogs" } },
          Tags: [{ Key: "environment", Value: { Ref: "Environment" } }],
        },
      },
      RestApi: {
        Type: "AWS::ApiGateway::RestApi",
        Properties: { Name: "console-stack-api", Description: "Real CloudFormation console REST API" },
      },
      HelloResource: {
        Type: "AWS::ApiGateway::Resource",
        Properties: {
          RestApiId: { Ref: "RestApi" },
          ParentId: { "Fn::GetAtt": ["RestApi", "RootResourceId"] },
          PathPart: "hello",
        },
      },
      InvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          Action: "lambda:InvokeFunction",
          FunctionName: { "Fn::GetAtt": ["Function", "Arn"] },
          Principal: "apigateway.amazonaws.com",
          SourceArn: { "Fn::Sub": "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/*/GET/hello" },
        },
      },
      HelloMethod: {
        Type: "AWS::ApiGateway::Method",
        DependsOn: "InvokePermission",
        Properties: {
          RestApiId: { Ref: "RestApi" },
          ResourceId: { Ref: "HelloResource" },
          HttpMethod: "GET",
          AuthorizationType: "NONE",
          Integration: {
            Type: "AWS_PROXY",
            IntegrationHttpMethod: "POST",
            Uri: { "Fn::Sub": "arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Function.Arn}/invocations" },
          },
        },
      },
      ApiDeployment: {
        Type: "AWS::ApiGateway::Deployment",
        DependsOn: "HelloMethod",
        Properties: { RestApiId: { Ref: "RestApi" }, Description: "Browser fixture deployment" },
      },
      ProdStage: {
        Type: "AWS::ApiGateway::Stage",
        Properties: { RestApiId: { Ref: "RestApi" }, DeploymentId: { Ref: "ApiDeployment" }, StageName: "prod" },
      },
      CdkMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: analytics } },
    },
    Outputs: {
      ApiId: { Value: { Ref: "RestApi" } },
      ApiUrl: {
        Description: "AWS-shaped CDK output",
        Value: { "Fn::Sub": "https://${RestApi}.execute-api.${AWS::Region}.amazonaws.com/prod/" },
        Export: { Name: "console-api-url" },
      },
      FunctionName: { Value: { Ref: "Function" } },
      TableName: { Value: { Ref: "ItemsTable" } },
      Release: { Value: analytics },
    },
  });
}

export function cloudFormationFailedStackTemplate(): string {
  return JSON.stringify({
    Description: "Rollback-disabled browser error fixture",
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "failed-browser-stack" } } },
    Outputs: { Invalid: { Value: ["not", "a", "scalar"] } },
  });
}
