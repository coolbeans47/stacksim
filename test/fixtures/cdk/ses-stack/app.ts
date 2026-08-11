import { App, CfnOutput, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const release = process.env.CDK_SES_TEST_RELEASE ?? "v1";
const stack = new Stack(app, "SesStack", {
  env: { account, region },
  description: "Pinned stacksim SES-03 CDK fixture",
});

const configurationSet = new ses.ConfigurationSet(stack, "ConfigurationSet", {
  configurationSetName: "ses03-configuration-set",
  sendingEnabled: true,
});

const identity = new ses.EmailIdentity(stack, "Identity", {
  identity: ses.Identity.email("sender@ses03.example.test"),
  configurationSet,
});

const template = new ses.CfnTemplate(stack, "Template", {
  template: {
    templateName: "ses03-welcome",
    subjectPart: release === "v2" ? "Welcome back, {{name}}" : "Welcome, {{name}}",
    textPart: release === "v2" ? "Hello {{name}} from the updated stack." : "Hello {{name}}.",
    htmlPart: "<p>Hello <strong>{{name}}</strong>.</p>",
  },
});

const senderRole = new iam.Role(stack, "SenderRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
});
identity.grantSendEmail(senderRole);

new CfnOutput(stack, "IdentityName", { value: identity.emailIdentityName });
new CfnOutput(stack, "ConfigurationSetName", { value: configurationSet.configurationSetName });
new CfnOutput(stack, "TemplateName", { value: template.ref });
