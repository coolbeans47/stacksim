import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  GetRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  GetEmailTemplateCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import {
  CDK_BOOTSTRAP_COGNITO_POLICY_NAME,
  CDK_BOOTSTRAP_POLICY_NAME,
  CDK_BOOTSTRAP_POLICY_REVISION,
  CloudFormationBootstrapManager,
  cdkBootstrapNames,
} from "../src/cloudformation/bootstrap.js";
import { COGNITO_CLOUDFORMATION_EXECUTION_ACTIONS } from "../src/cloudformation/providers/cognito.js";
import {
  SES_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
  SES_CONFIGURATION_SET_TYPE,
  SES_CONTACT_LIST_TYPE,
  SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
  SES_EMAIL_IDENTITY_TYPE,
  SES_TEMPLATE_TYPE,
} from "../src/cloudformation/providers/ses.js";
import { TestClock } from "../src/core/clock.js";
import { IamService } from "../src/iam.js";
import { S3Service } from "../src/s3.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";
import type { PolicyDocument, PolicyStatement } from "../src/types.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function statements(document: PolicyDocument): PolicyStatement[] {
  return Array.isArray(document.Statement) ? document.Statement : [document.Statement];
}

function actionList(statement: PolicyStatement): string[] {
  return (Array.isArray(statement.Action)
    ? statement.Action
    : statement.Action === undefined
      ? []
      : [statement.Action]).map(String);
}

function operationUnion(typeName: keyof typeof SES_CLOUDFORMATION_AUTHORIZATION_MATRIX): string[] {
  return [...new Set(Object.values(SES_CLOUDFORMATION_AUTHORIZATION_MATRIX[typeName]).flat())].sort();
}

function decodedPolicy(value: string | undefined): PolicyDocument {
  if (!value) throw new Error("Expected an inline policy document");
  return JSON.parse(decodeURIComponent(value)) as PolicyDocument;
}

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    if (status?.endsWith("_FAILED") && status !== expected) throw new Error(`${stackName} reached ${status} while waiting for ${expected}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

function template(templateName: string): string {
  return JSON.stringify({
    Resources: {
      MailTemplate: {
        Type: SES_TEMPLATE_TYPE,
        Properties: {
          Template: {
            TemplateName: templateName,
            SubjectPart: "Authorization contract",
            TextPart: "Provider mutation is resource scoped.",
          },
        },
      },
    },
  });
}

test("current bootstrap revision retains SES, SNS, AppSync, Cognito, and Step Functions execution access", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-bootstrap-"));
  const store = new StateStore(root, accountId, region);
  try {
    await store.load();
    const clock = new TestClock(1_720_000_000_000);
    const manager = new CloudFormationBootstrapManager(
      store,
      new IamService(store, clock),
      new S3Service(store, region, clock),
      region,
      clock,
    );
    const bootstrap = await manager.ensure();
    const names = cdkBootstrapNames(accountId, region);
    const executionRole = store.ensureAccount().iam.roles[names.roleNames.cloudFormationExecution];
    const policy = executionRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME];
    const allStatements = statements(policy);

    assert.equal(CDK_BOOTSTRAP_POLICY_REVISION, 18);
    assert.equal(bootstrap.policyRevision, CDK_BOOTSTRAP_POLICY_REVISION);
    assert.equal(executionRole.tags["stacksim:policy-revision"], String(CDK_BOOTSTRAP_POLICY_REVISION));
    const cognitoPolicyArn = `arn:aws:iam::${accountId}:policy/${CDK_BOOTSTRAP_COGNITO_POLICY_NAME}`;
    const cognitoPolicy = store.ensureAccount().iam.policies[cognitoPolicyArn];
    assert(cognitoPolicy);
    assert.deepEqual(actionList(statements(cognitoPolicy.versions[cognitoPolicy.defaultVersionId].document)[0]).sort(), [...COGNITO_CLOUDFORMATION_EXECUTION_ACTIONS]);
    assert.deepEqual(executionRole.attachedPolicyArns, [cognitoPolicyArn]);

    const expected = [
      {
        sid: "ManageSesEmailIdentities",
        typeName: SES_EMAIL_IDENTITY_TYPE,
        resource: `arn:aws:ses:${region}:${accountId}:identity/*`,
      },
      {
        sid: "ManageSesConfigurationSets",
        typeName: SES_CONFIGURATION_SET_TYPE,
        resource: `arn:aws:ses:${region}:${accountId}:configuration-set/*`,
      },
      {
        sid: "ManageSesTemplates",
        typeName: SES_TEMPLATE_TYPE,
        resource: `arn:aws:ses:${region}:${accountId}:template/*`,
      },
      {
        sid: "ManageSesConfigurationSetEventDestinations",
        typeName: SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
        resource: `arn:aws:ses:${region}:${accountId}:configuration-set/*`,
      },
      {
        sid: "ManageSesCustomVerificationTemplates",
        typeName: SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
        resource: `arn:aws:ses:${region}:${accountId}:custom-verification-email-template/*`,
      },
      {
        sid: "ManageSesContactLists",
        typeName: SES_CONTACT_LIST_TYPE,
        resource: `arn:aws:ses:${region}:${accountId}:contact-list/*`,
      },
    ] as const;

    const sesStatements = allStatements.filter(statement => actionList(statement).some(action => action.startsWith("ses:")));
    assert.deepEqual(sesStatements.map(statement => statement.Sid).sort(), expected.map(item => item.sid).sort());
    for (const item of expected) {
      const statement = allStatements.find(candidate => candidate.Sid === item.sid);
      assert(statement, `missing ${item.sid}`);
      assert.equal(statement.Effect, "Allow");
      assert.deepEqual(actionList(statement).sort(), operationUnion(item.typeName));
      assert.equal(statement.Resource, item.resource);
      assert.equal(actionList(statement).includes("ses:*"), false);
      assert.notEqual(statement.Resource, "*");
    }
    const stepFunctions = allStatements.find(statement => statement.Sid === "ManageStepFunctionsStateMachines");
    assert(stepFunctions);
    assert.deepEqual(actionList(stepFunctions), [
      "states:CreateStateMachine", "states:DeleteStateMachine", "states:DescribeStateMachine",
      "states:ListTagsForResource", "states:TagResource", "states:UntagResource", "states:UpdateStateMachine",
    ]);
    assert.equal(stepFunctions.Resource, `arn:aws:states:${region}:${accountId}:stateMachine:*`);
    const supportedPassRole = allStatements.find(statement => statement.Sid === "PassSupportedServiceRoles");
    assert(Array.isArray((supportedPassRole?.Condition as any)?.StringEquals?.["iam:PassedToService"]));
    assert((supportedPassRole!.Condition as any).StringEquals["iam:PassedToService"].includes("states.amazonaws.com"));

    const passRoleStatements = Object.values(store.ensureAccount().iam.roles)
      .flatMap(role => Object.values(role.inlinePolicies))
      .flatMap(statements)
      .filter(statement => actionList(statement).includes("iam:PassRole"))
      .map(statement => statement.Sid)
      .sort();
    assert.deepEqual(passRoleStatements, ["PassCloudFormationExecutionRole", "PassSnsDeliveryFeedbackRoles", "PassSupportedServiceRoles"]);
    assert.equal(sesStatements.some(statement => actionList(statement).includes("iam:PassRole")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforced CloudFormation execution role allows and denies SES template mutation on the exact template ARN", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-provider-auth-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const iam = new IAMClient(options);
    const ses = new SESv2Client(options);
    clients.push(cloudformation, iam, ses);

    const names = cdkBootstrapNames(accountId, region);
    const allowedName = "cfn-ses-auth-allowed";
    const allowed = await cloudformation.send(new CreateStackCommand({
      StackName: "ses-provider-authorized",
      TemplateBody: template(allowedName),
      RoleARN: names.roleArns.cloudFormationExecution,
    }));
    await waitForStatus(cloudformation, allowed.StackId!, "CREATE_COMPLETE");
    assert.equal((await ses.send(new GetEmailTemplateCommand({ TemplateName: allowedName }))).TemplateName, allowedName);
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision =>
      decision.principalArn.startsWith(`arn:aws:sts::${accountId}:assumed-role/${names.roleNames.cloudFormationExecution}/`)
      && decision.action === "ses:CreateEmailTemplate"
      && decision.resource === `arn:aws:ses:${region}:${accountId}:template/${allowedName}`
      && decision.decision === "allowed"));

    const roleName = names.roleNames.cloudFormationExecution;
    const current = decodedPolicy((await iam.send(new GetRolePolicyCommand({
      RoleName: roleName,
      PolicyName: CDK_BOOTSTRAP_POLICY_NAME,
    }))).PolicyDocument);
    const templateStatement = statements(current).find(statement => statement.Sid === "ManageSesTemplates");
    assert(templateStatement);
    templateStatement.Action = actionList(templateStatement).filter(action => action !== "ses:CreateEmailTemplate");
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: CDK_BOOTSTRAP_POLICY_NAME,
      PolicyDocument: JSON.stringify(current),
    }));

    const deniedName = "cfn-ses-auth-denied";
    const denied = await cloudformation.send(new CreateStackCommand({
      StackName: "ses-provider-denied",
      TemplateBody: template(deniedName),
      RoleARN: names.roleArns.cloudFormationExecution,
    }));
    await waitForStatus(cloudformation, denied.StackId!, "ROLLBACK_COMPLETE");
    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: denied.StackId }));
    assert.ok(events.StackEvents?.some(event =>
      event.LogicalResourceId === "MailTemplate"
      && event.ResourceStatus === "CREATE_FAILED"
      && /ses:CreateEmailTemplate|AccessDenied/i.test(event.ResourceStatusReason ?? "")));
    await assert.rejects(
      ses.send(new GetEmailTemplateCommand({ TemplateName: deniedName })),
      error => (error as { name?: string }).name === "NotFoundException",
    );
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision =>
      decision.principalArn.startsWith(`arn:aws:sts::${accountId}:assumed-role/${names.roleNames.cloudFormationExecution}/`)
      && decision.action === "ses:CreateEmailTemplate"
      && decision.resource === `arn:aws:ses:${region}:${accountId}:template/${deniedName}`
      && decision.decision !== "allowed"));

    await cloudformation.send(new DeleteStackCommand({
      StackName: allowed.StackId,
      RoleARN: names.roleArns.cloudFormationExecution,
    }));
    await waitForStatus(cloudformation, allowed.StackId!, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop();
    await rm(root, { recursive: true, force: true });
  }
});
