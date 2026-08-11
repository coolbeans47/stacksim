import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteTemplateCommand,
  GetTemplateCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import {
  CreateEmailTemplateCommand,
  DeleteConfigurationSetCommand,
  DeleteEmailTemplateCommand,
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  GetEmailTemplateCommand,
  ListTagsForResourceCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { StackSim } from "../src/server.js";
import {
  SES_CFN_LOGICAL_ID_TAG,
  SES_CFN_RESOURCE_OPERATION_ID_TAG,
  SES_CFN_STACK_ID_TAG,
} from "../src/cloudformation/providers/ses.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const described = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    const status = described?.StackStatus;
    if (status === expected) return;
    if (status?.endsWith("_FAILED") && status !== expected) {
      throw new Error(`${stackName} reached ${status} while waiting for ${expected}: ${described?.StackStatusReason ?? "no reason"}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

function sesTemplate(version: 1 | 2): string {
  const configurationName = version === 1 ? "cfn-ses-set" : "cfn-ses-set-v2";
  const identity = version === 1 ? "stack-sender@example.test" : "replacement-sender@example.test";
  const templateName = version === 1 ? "cfn-ses-template" : "cfn-ses-template-v2";
  return JSON.stringify({
    Resources: {
      Configuration: {
        Type: "AWS::SES::ConfigurationSet",
        Properties: {
          Name: configurationName,
          SendingOptions: { SendingEnabled: version === 2 },
          Tags: version === 1 ? [{ Key: "phase", Value: "initial" }] : [],
        },
      },
      Identity: {
        Type: "AWS::SES::EmailIdentity",
        Properties: {
          EmailIdentity: identity,
          ConfigurationSetAttributes: { ConfigurationSetName: { Ref: "Configuration" } },
          Tags: version === 1 ? [{ Key: "owner", Value: "stack" }] : [],
        },
      },
      StoredTemplate: {
        Type: "AWS::SES::Template",
        Properties: {
          Template: {
            TemplateName: templateName,
            SubjectPart: version === 1 ? "Hello {{name}}" : "Updated {{name}}",
            ...(version === 1 ? { TextPart: "Text {{name}}" } : {}),
            HtmlPart: version === 1 ? "<b>{{name}}</b>" : "<i>{{name}}</i>",
          },
          Tags: version === 1 ? [{ Key: "phase", Value: "initial" }] : [],
        },
      },
    },
    Outputs: {
      ConfigurationName: { Value: { Ref: "Configuration" } },
      IdentityName: { Value: { Ref: "Identity" } },
      TemplateName: { Value: { Ref: "StoredTemplate" } },
      TemplateId: { Value: { "Fn::GetAtt": ["StoredTemplate", "Id"] } },
      IdentityDkimName: { Value: { "Fn::GetAtt": ["Identity", "DkimDNSTokenName1"] } },
      IdentityDkimValue: { Value: { "Fn::GetAtt": ["Identity", "DkimDNSTokenValue1"] } },
    },
  });
}

test("CloudFormation creates, reads, updates, no-ops, replaces, and destroys the exact SES-03 slice", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-lifecycle-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined; let classic: SESClient | undefined; let v2: SESv2Client | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options);
    classic = new SESClient(options);
    v2 = new SESv2Client(options);

    const created = await cloudformation.send(new CreateStackCommand({
      StackName: "ses-lifecycle",
      TemplateBody: sesTemplate(1),
      Tags: [{ Key: "stack-tag", Value: "propagated" }],
    }));
    await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
    const outputs = Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
    assert.deepEqual(outputs, {
      ConfigurationName: "cfn-ses-set",
      IdentityDkimName: "",
      IdentityDkimValue: "",
      IdentityName: "stack-sender@example.test",
      TemplateId: "cfn-ses-template",
      TemplateName: "cfn-ses-template",
    });

    const identity = await v2.send(new GetEmailIdentityCommand({ EmailIdentity: outputs.IdentityName }));
    assert.equal(identity.VerifiedForSendingStatus, false, "CloudFormation must complete while verification remains pending");
    assert.equal(identity.ConfigurationSetName, "cfn-ses-set");
    const configuration = await v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: "cfn-ses-set" }));
    assert.equal(configuration.SendingOptions?.SendingEnabled, false);
    const classicTemplate = await classic.send(new GetTemplateCommand({ TemplateName: "cfn-ses-template" }));
    const v2Template = await v2.send(new GetEmailTemplateCommand({ TemplateName: "cfn-ses-template" }));
    assert.deepEqual(classicTemplate.Template, {
      TemplateName: "cfn-ses-template",
      SubjectPart: "Hello {{name}}",
      TextPart: "Text {{name}}",
      HtmlPart: "<b>{{name}}</b>",
    });
    assert.deepEqual(v2Template.TemplateContent, {
      Subject: "Hello {{name}}",
      Text: "Text {{name}}",
      Html: "<b>{{name}}</b>",
    });
    for (const [kind, name, logicalId] of [
      ["identity", "stack-sender@example.test", "Identity"],
      ["configuration-set", "cfn-ses-set", "Configuration"],
      ["template", "cfn-ses-template", "StoredTemplate"],
    ] as const) {
      const tagsResponse: any = await v2.send(new ListTagsForResourceCommand({ ResourceArn: `arn:aws:ses:${region}:${accountId}:${kind}/${name}` }));
      const mapped: Record<string, string> = Object.fromEntries((tagsResponse.Tags ?? []).map((tag: any) => [tag.Key!, tag.Value!]));
      assert.equal(mapped[SES_CFN_STACK_ID_TAG], created.StackId);
      assert.equal(mapped[SES_CFN_LOGICAL_ID_TAG], logicalId);
      assert.match(mapped[SES_CFN_RESOURCE_OPERATION_ID_TAG] ?? "", /^[a-f0-9]{64}$/);
      assert.equal(mapped["stack-tag"], "propagated");
    }

    await assert.rejects(
      cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: sesTemplate(1), Tags: [{ Key: "stack-tag", Value: "propagated" }] })),
      (error: any) => error.name === "ValidationError" && /No updates/i.test(error.message),
    );

    const messagesBeforeReplacement = simulator.ses.summary().messageCount;
    await cloudformation.send(new UpdateStackCommand({
      StackName: created.StackId,
      TemplateBody: sesTemplate(2),
      Tags: [{ Key: "stack-tag", Value: "propagated" }],
    }));
    await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    await assert.rejects(v2.send(new GetEmailIdentityCommand({ EmailIdentity: "stack-sender@example.test" })), (error: any) => error.name === "NotFoundException");
    await assert.rejects(v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: "cfn-ses-set" })), (error: any) => error.name === "NotFoundException");
    await assert.rejects(v2.send(new GetEmailTemplateCommand({ TemplateName: "cfn-ses-template" })), (error: any) => error.name === "NotFoundException");
    assert.equal((await v2.send(new GetEmailIdentityCommand({ EmailIdentity: "replacement-sender@example.test" }))).ConfigurationSetName, "cfn-ses-set-v2");
    assert.equal((await v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: "cfn-ses-set-v2" }))).SendingOptions?.SendingEnabled, true);
    assert.deepEqual((await classic.send(new GetTemplateCommand({ TemplateName: "cfn-ses-template-v2" }))).Template, {
      TemplateName: "cfn-ses-template-v2",
      SubjectPart: "Updated {{name}}",
      HtmlPart: "<i>{{name}}</i>",
    });
    assert.ok(simulator.ses.summary().messageCount > messagesBeforeReplacement, "the replacement identity should retain its pending verification message");

    const historyBeforeDestroy = simulator.ses.summary().messageCount;
    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
    assert.equal(simulator.ses.summary().messageCount, historyBeforeDestroy, "stack deletion must not erase captured mail");
    assert.equal((await cloudformation.send(new ListStackResourcesCommand({ StackName: created.StackId }))).StackResourceSummaries?.length, 3);
  } finally {
    cloudformation?.destroy(); classic?.destroy(); v2?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES CloudFormation rollback, Retain, out-of-band deletion, and Snapshot rejection use the parent lifecycle", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-parent-lifecycle-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined; let classic: SESClient | undefined; let v2: SESv2Client | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options);
    classic = new SESClient(options);
    v2 = new SESv2Client(options);

    const rollbackTemplate = JSON.stringify({
      Resources: {
        Configuration: { Type: "AWS::SES::ConfigurationSet", Properties: { Name: "rollback-set" } },
        Identity: {
          Type: "AWS::SES::EmailIdentity",
          DependsOn: "Configuration",
          Properties: { EmailIdentity: "rollback@example.test", ConfigurationSetAttributes: { ConfigurationSetName: "missing-set" } },
        },
      },
    });
    const rollingBack = await cloudformation.send(new CreateStackCommand({ StackName: "ses-rollback", TemplateBody: rollbackTemplate }));
    await waitForStatus(cloudformation, rollingBack.StackId!, "ROLLBACK_COMPLETE");
    await assert.rejects(v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: "rollback-set" })), (error: any) => error.name === "NotFoundException");

    await v2.send(new CreateEmailTemplateCommand({
      TemplateName: "create-rollback-conflict",
      TemplateContent: { Subject: "direct create conflict" },
    }));
    const createConflict = await cloudformation.send(new CreateStackCommand({
      StackName: "ses-create-conflict",
      TemplateBody: JSON.stringify({
        Resources: {
          StoredTemplate: {
            Type: "AWS::SES::Template",
            Properties: { Template: { TemplateName: "create-rollback-conflict", SubjectPart: "stack subject" } },
          },
        },
      }),
    }));
    await waitForStatus(cloudformation, createConflict.StackId!, "ROLLBACK_COMPLETE");
    assert.equal(
      (await v2.send(new GetEmailTemplateCommand({ TemplateName: "create-rollback-conflict" }))).TemplateContent?.Subject,
      "direct create conflict",
      "create rollback must skip a provisional physical ID which resolves to an unowned direct resource",
    );
    await cloudformation.send(new DeleteStackCommand({ StackName: createConflict.StackId }));
    await waitForStatus(cloudformation, createConflict.StackId!, "DELETE_COMPLETE");
    assert.equal(
      (await v2.send(new GetEmailTemplateCommand({ TemplateName: "create-rollback-conflict" }))).TemplateContent?.Subject,
      "direct create conflict",
      "deleting the rolled-back stack must not reacquire or delete its discarded provisional physical ID",
    );
    await v2.send(new DeleteEmailTemplateCommand({ TemplateName: "create-rollback-conflict" }));

    const retainedTemplate = JSON.stringify({
      Resources: {
        Configuration: { Type: "AWS::SES::ConfigurationSet", DeletionPolicy: "Retain", Properties: { Name: "retained-set" } },
        StoredTemplate: {
          Type: "AWS::SES::Template",
          DeletionPolicy: "Retain",
          Properties: { Template: { TemplateName: "retained-template", SubjectPart: "retained" } },
        },
      },
    });
    const retained = await cloudformation.send(new CreateStackCommand({ StackName: "ses-retained", TemplateBody: retainedTemplate }));
    await waitForStatus(cloudformation, retained.StackId!, "CREATE_COMPLETE");
    await cloudformation.send(new DeleteStackCommand({ StackName: retained.StackId }));
    await waitForStatus(cloudformation, retained.StackId!, "DELETE_COMPLETE");
    assert.equal((await v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: "retained-set" }))).ConfigurationSetName, "retained-set");
    assert.equal((await classic.send(new GetTemplateCommand({ TemplateName: "retained-template" }))).Template?.SubjectPart, "retained");

    const outOfBandTemplate = JSON.stringify({
      Resources: {
        StoredTemplate: { Type: "AWS::SES::Template", Properties: { Template: { TemplateName: "out-of-band-template", SubjectPart: "temporary" } } },
      },
    });
    const outOfBand = await cloudformation.send(new CreateStackCommand({ StackName: "ses-out-of-band", TemplateBody: outOfBandTemplate }));
    await waitForStatus(cloudformation, outOfBand.StackId!, "CREATE_COMPLETE");
    await v2.send(new DeleteEmailTemplateCommand({ TemplateName: "out-of-band-template" }));
    await cloudformation.send(new DeleteStackCommand({ StackName: outOfBand.StackId }));
    await waitForStatus(cloudformation, outOfBand.StackId!, "DELETE_COMPLETE");

    const replacementRollbackTemplate = (name: string) => JSON.stringify({
      Resources: {
        StoredTemplate: {
          Type: "AWS::SES::Template",
          Properties: { Template: { TemplateName: name, SubjectPart: `subject-${name}` } },
        },
      },
    });
    const replacementRollback = await cloudformation.send(new CreateStackCommand({
      StackName: "ses-replacement-rollback",
      TemplateBody: replacementRollbackTemplate("rollback-original-template"),
    }));
    await waitForStatus(cloudformation, replacementRollback.StackId!, "CREATE_COMPLETE");
    await v2.send(new CreateEmailTemplateCommand({
      TemplateName: "rollback-conflicting-template",
      TemplateContent: { Subject: "direct conflict" },
    }));
    await cloudformation.send(new UpdateStackCommand({
      StackName: replacementRollback.StackId,
      TemplateBody: replacementRollbackTemplate("rollback-conflicting-template"),
    }));
    await waitForStatus(cloudformation, replacementRollback.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    assert.equal(
      (await v2.send(new GetEmailTemplateCommand({ TemplateName: "rollback-original-template" }))).TemplateContent?.Subject,
      "subject-rollback-original-template",
      "failed create-before-delete replacement must leave the original owned template intact",
    );
    assert.equal(
      (await v2.send(new GetEmailTemplateCommand({ TemplateName: "rollback-conflicting-template" }))).TemplateContent?.Subject,
      "direct conflict",
      "rollback must neither adopt nor delete the direct resource which caused the replacement failure",
    );
    await v2.send(new DeleteEmailTemplateCommand({ TemplateName: "rollback-conflicting-template" }));
    await cloudformation.send(new DeleteStackCommand({ StackName: replacementRollback.StackId }));
    await waitForStatus(cloudformation, replacementRollback.StackId!, "DELETE_COMPLETE");

    const snapshotTemplate = JSON.stringify({
      Resources: {
        Configuration: { Type: "AWS::SES::ConfigurationSet", DeletionPolicy: "Snapshot", Properties: { Name: "snapshot-must-not-exist" } },
      },
    });
    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "ses-snapshot", TemplateBody: snapshotTemplate })),
      (error: any) => error.name === "ValidationError" && /Snapshot/.test(error.message),
    );
    await assert.rejects(v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: "snapshot-must-not-exist" })), (error: any) => error.name === "NotFoundException");

    await v2.send(new DeleteConfigurationSetCommand({ ConfigurationSetName: "retained-set" }));
    await classic.send(new DeleteTemplateCommand({ TemplateName: "retained-template" }));
  } finally {
    cloudformation?.destroy(); classic?.destroy(); v2?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES CloudFormation rejects every closed-boundary property before authoritative SES mutation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-invalid-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    cloudformation = new CloudFormationClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    const invalidResources: Array<{ label: string; resource: Record<string, unknown>; expected?: RegExp }> = [
      ...["DkimAttributes", "DkimSigningAttributes", "FeedbackAttributes", "MailFromAttributes", "Unknown"].map(property => ({
        label: `identity-${property.toLowerCase()}`,
        resource: {
          Type: "AWS::SES::EmailIdentity",
          Properties: { EmailIdentity: "must-not-exist@example.test", [property]: {} },
        },
      })),
      {
        label: "identity-nested",
        resource: {
          Type: "AWS::SES::EmailIdentity",
          Properties: {
            EmailIdentity: "must-not-exist@example.test",
            ConfigurationSetAttributes: { ConfigurationSetName: "set", Extra: true },
          },
        },
      },
      ...["ArchivingOptions", "DeliveryOptions", "ReputationOptions", "SuppressionOptions", "TrackingOptions", "VdmOptions", "Unknown"].map(property => ({
        label: `configuration-${property.toLowerCase()}`,
        resource: {
          Type: "AWS::SES::ConfigurationSet",
          Properties: { Name: "must-not-exist", [property]: {} },
        },
      })),
      {
        label: "configuration-nested",
        resource: {
          Type: "AWS::SES::ConfigurationSet",
          Properties: { Name: "must-not-exist", SendingOptions: { SendingEnabled: true, Extra: true } },
        },
      },
      {
        label: "template-omitted",
        resource: { Type: "AWS::SES::Template", Properties: {} },
        expected: /InvalidRequest/,
      },
      {
        label: "template-nested",
        resource: {
          Type: "AWS::SES::Template",
          Properties: { Template: { TemplateName: "must-not-exist", SubjectPart: "subject", Extra: true } },
        },
      },
    ];
    const beforeRevision = simulator.store.regionState(region).ses.controlRevision;
    const beforeMessages = simulator.ses.summary().messageCount;
    for (const [index, invalid] of invalidResources.entries()) {
      await assert.rejects(
        cloudformation.send(new CreateStackCommand({
          StackName: `ses-invalid-${index}`,
          TemplateBody: JSON.stringify({ Resources: { Invalid: invalid.resource } }),
        })),
        (error: any) => error.name === "ValidationError" && (invalid.expected?.test(error.message) ?? true),
        invalid.label,
      );
    }
    const state = simulator.store.regionState(region).ses;
    assert.equal(state.controlRevision, beforeRevision);
    assert.deepEqual(Object.keys(state.identities), []);
    assert.deepEqual(Object.keys(state.configurationSets), []);
    assert.deepEqual(Object.keys(state.templates), []);
    assert.equal(simulator.ses.summary().messageCount, beforeMessages);
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
