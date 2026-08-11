import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";
import {
  SES_CFN_LOGICAL_ID_TAG,
  SES_CFN_RESOURCE_OPERATION_ID_TAG,
  SES_CFN_STACK_ID_TAG,
  SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
  SES_CONFIGURATION_SET_TYPE,
  SES_CONTACT_LIST_TYPE,
  SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
  SES_EMAIL_IDENTITY_TYPE,
  SES_TEMPLATE_TYPE,
  createSesCloudFormationProviders,
  type SesConfigurationSetEventDestinationModel,
  type SesConfigurationSetModel,
  type SesContactListModel,
  type SesCustomVerificationTemplateModel,
  type SesEmailIdentityModel,
  type SesTemplateModel,
} from "../src/cloudformation/providers/ses.js";
import type {
  ProductionResourceProvider,
  ProviderContext,
  ProviderCreateResult,
  ProviderReadModel,
} from "../src/cloudformation/providers/contract.js";

const region = "eu-west-1";
const accountId = "000000000000";
const principal = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string, resourceOperationId = `${logicalId}-resource-operation`, callbackContext?: Readonly<Record<string, any>>): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/ses-provider/00000000-0000-0000-0000-000000000001`,
    logicalId,
    operationId: "stack-operation",
    resourceOperationId,
    idempotencyKey: `stack-operation:${logicalId}`,
    deadlineAt: Date.now() + 60_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity: principal },
  };
}

async function completeCreate<Model>(
  provider: ProductionResourceProvider<Model>,
  desired: Model,
  initial: ProviderContext,
): Promise<Extract<ProviderCreateResult<Model>, { status: "SUCCESS" }>> {
  const first = await provider.create(desired, initial);
  assert.equal(first.status, "IN_PROGRESS", `${provider.typeName} must checkpoint its physical ID before mutation`);
  const expectedPhysicalId = physicalId(desired);
  if (expectedPhysicalId !== undefined) assert.equal(first.status === "IN_PROGRESS" ? first.checkpoint.physicalId : undefined, expectedPhysicalId);
  const second = await provider.create(desired, { ...initial, callbackContext: first.status === "IN_PROGRESS" ? first.checkpoint.callbackContext : {} });
  assert.equal(second.status, "SUCCESS", JSON.stringify(second));
  return second as Extract<ProviderCreateResult<Model>, { status: "SUCCESS" }>;
}

function physicalId(model: unknown): string | undefined {
  const value = model as any;
  const result = value.EmailIdentity ?? value.Name ?? value.Template?.TemplateName ?? value.TemplateName ?? value.ContactListName;
  return result === undefined ? undefined : String(result);
}

test("SES providers declare closed schemas, exact defaults, references, no-ops, and replacement boundaries", async () => {
  const providers = createSesCloudFormationProviders({} as any);
  assert.deepEqual(providers.map(provider => provider.typeName).sort(), [
    SES_CONFIGURATION_SET_TYPE,
    SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
    SES_CONTACT_LIST_TYPE,
    SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
    SES_EMAIL_IDENTITY_TYPE,
    SES_TEMPLATE_TYPE,
  ]);
  const identity = providers.find(provider => provider.typeName === SES_EMAIL_IDENTITY_TYPE)! as ProductionResourceProvider<SesEmailIdentityModel>;
  const configuration = providers.find(provider => provider.typeName === SES_CONFIGURATION_SET_TYPE)! as ProductionResourceProvider<SesConfigurationSetModel>;
  const template = providers.find(provider => provider.typeName === SES_TEMPLATE_TYPE)! as ProductionResourceProvider<SesTemplateModel>;

  const identityContext = context("Identity");
  const identityModel = identity.canonicalize({ EmailIdentity: "sender@example.test", ConfigurationSetAttributes: {}, Tags: [] }, identityContext);
  assert.deepEqual(identityModel, { EmailIdentity: "sender@example.test", Tags: [] });
  for (const property of ["DkimAttributes", "DkimSigningAttributes", "FeedbackAttributes", "MailFromAttributes", "Unknown"]) {
    assert.ok(identity.validate({ EmailIdentity: "sender@example.test", [property]: {} }, identityContext).some(issue => issue.path === `Properties.${property}`), property);
  }
  assert.ok(identity.validate({ EmailIdentity: "sender@example.test", ConfigurationSetAttributes: { ConfigurationSetName: "set", Extra: true } }, identityContext).some(issue => issue.path === "Properties.ConfigurationSetAttributes.Extra"));

  const generatedOne = configuration.canonicalize({ SendingOptions: {}, Tags: [] }, context("Configuration", "first"));
  const generatedTwo = configuration.canonicalize({ Tags: [] }, context("Configuration", "second"));
  assert.equal(generatedOne.Name, generatedTwo.Name, "generated names must not depend on the stack operation");
  assert.deepEqual(generatedOne.SendingOptions, { SendingEnabled: true });
  for (const property of ["ArchivingOptions", "DeliveryOptions", "ReputationOptions", "SuppressionOptions", "TrackingOptions", "VdmOptions", "Unknown"]) {
    assert.ok(configuration.validate({ [property]: {} }, context("Configuration")).some(issue => issue.path === `Properties.${property}`), property);
  }
  assert.ok(configuration.validate({ SendingOptions: { SendingEnabled: true, Extra: true } }, context("Configuration")).some(issue => issue.path === "Properties.SendingOptions.Extra"));

  assert.ok(template.validate({}, context("Template")).some(issue => issue.path === "Properties.Template"));
  const invalidTemplateCreate = await template.create(
    { Tags: [] } as any,
    { ...context("Template"), callbackContext: { stage: "create" } },
  );
  assert.equal(invalidTemplateCreate.status, "FAILED");
  assert.equal(invalidTemplateCreate.status === "FAILED" ? invalidTemplateCreate.errorCode : undefined, "InvalidRequest");
  assert.ok(template.validate({ Template: { SubjectPart: "hello", Extra: true } }, context("Template")).some(issue => issue.path === "Properties.Template.Extra"));
  const generatedTemplate = template.canonicalize({ Template: { SubjectPart: "hello", TextPart: "text" }, Tags: [] }, context("Template"));
  assert.match(generatedTemplate.Template.TemplateName, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(template.plan(generatedTemplate, structuredClone(generatedTemplate), context("Template")), {
    action: "NO_OP",
    desired: generatedTemplate,
    changedProperties: [],
    replacementProperties: [],
  });
  assert.equal(template.plan(generatedTemplate, { ...generatedTemplate, Template: { ...generatedTemplate.Template, SubjectPart: "changed" } }, context("Template")).action, "UPDATE");
  const replacement = template.plan(generatedTemplate, { ...generatedTemplate, Template: { ...generatedTemplate.Template, TemplateName: "replacement" } }, context("Template"));
  assert.equal(replacement.action, "REPLACE");
  assert.deepEqual(replacement.replacementProperties, ["Template.TemplateName"]);

  const fifty = Array.from({ length: 50 }, (_, index) => ({ Key: `key-${index}`, Value: String(index) }));
  assert.deepEqual(configuration.canonicalize({ Name: "tags", Tags: fifty }, context("ConfigurationTags")).Tags.length, 50);
  const invalidTags = [
    [...fifty, { Key: "extra", Value: "" }],
    [{ Key: "aws:cloudformation:stack-id", Value: "forged" }],
    [{ Key: "duplicate", Value: "one" }, { Key: "duplicate", Value: "two" }],
    [{ Key: "unknown", Value: "", Extra: true }],
  ];
  for (const Tags of invalidTags) assert.ok(configuration.validate({ Name: "tags", Tags }, context("ConfigurationTags")).length > 0);

  const identityRead: ProviderReadModel<SesEmailIdentityModel> = {
    physicalId: identityModel.EmailIdentity,
    properties: identityModel,
    attributes: {
      DkimDNSTokenName1: "", DkimDNSTokenName2: "", DkimDNSTokenName3: "",
      DkimDNSTokenValue1: "", DkimDNSTokenValue2: "", DkimDNSTokenValue3: "",
    },
  };
  assert.equal(identity.ref(identityRead), "sender@example.test");
  assert.equal(identity.getAtt(identityRead, "DkimDNSTokenValue3"), "");
  assert.throws(() => identity.getAtt(identityRead, "Arn"), /does not support/);
  assert.throws(() => configuration.getAtt({ physicalId: "set", properties: generatedOne, attributes: {} }, "Arn"), /does not support/);
  assert.equal(template.ref({ physicalId: "template", properties: generatedTemplate, attributes: { Id: "template" } }), "template");
  assert.equal(template.getAtt({ physicalId: "template", properties: generatedTemplate, attributes: { Id: "template" } }, "Id"), "template");
});

test("SES providers share SDK state, preserve protected tags, apply mutable defaults, and retain mailbox history", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-provider-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off"});
  try {
    await simulator.start();
    const providers = createSesCloudFormationProviders(simulator.ses);
    const identity = providers.find(provider => provider.typeName === SES_EMAIL_IDENTITY_TYPE)! as ProductionResourceProvider<SesEmailIdentityModel>;
    const configuration = providers.find(provider => provider.typeName === SES_CONFIGURATION_SET_TYPE)! as ProductionResourceProvider<SesConfigurationSetModel>;
    const template = providers.find(provider => provider.typeName === SES_TEMPLATE_TYPE)! as ProductionResourceProvider<SesTemplateModel>;

    const userTags = Array.from({ length: 50 }, (_, index) => ({ Key: `tag-${String(index).padStart(2, "0")}`, Value: String(index) }));
    const configurationContext = context("Configuration");
    const configurationModel = configuration.canonicalize({ Name: "provider-set", SendingOptions: { SendingEnabled: false }, Tags: userTags }, configurationContext);
    const configurationCreated = await completeCreate(configuration, configurationModel, configurationContext);
    assert.equal(configurationCreated.physicalId, "provider-set");
    assert.equal((await configuration.read("provider-set", configurationContext)).status, "SUCCESS");
    const configurationTags = (await simulator.ses.execute("ListTagsForResource", { ResourceArn: `arn:aws:ses:${region}:${accountId}:configuration-set/provider-set` }, "ses-v2", "tags")) as any;
    assert.equal(configurationTags.Tags.length, 53, "50 user tags plus three protected markers must fit");
    const mappedTags = Object.fromEntries(configurationTags.Tags.map((tag: any) => [tag.Key, tag.Value]));
    assert.equal(mappedTags[SES_CFN_STACK_ID_TAG], configurationContext.stackId);
    assert.equal(mappedTags[SES_CFN_LOGICAL_ID_TAG], configurationContext.logicalId);
    assert.equal(mappedTags[SES_CFN_RESOURCE_OPERATION_ID_TAG], configurationContext.resourceOperationId);
    await assert.rejects(
      simulator.ses.execute("TagResource", { ResourceArn: `arn:aws:ses:${region}:${accountId}:configuration-set/provider-set`, Tags: [{ Key: SES_CFN_STACK_ID_TAG, Value: "forged" }] }, "ses-v2", "protected-set"),
      (error: any) => error.code === "BadRequestException",
    );
    await assert.rejects(
      simulator.ses.execute("UntagResource", { ResourceArn: `arn:aws:ses:${region}:${accountId}:configuration-set/provider-set`, TagKeys: [SES_CFN_LOGICAL_ID_TAG] }, "ses-v2", "protected-remove"),
      (error: any) => error.code === "BadRequestException",
    );

    const templateContext = context("Template");
    const templateModel = template.canonicalize({
      Template: { TemplateName: "provider-template", SubjectPart: "Hello {{name}}", TextPart: "Text {{name}}", HtmlPart: "<b>{{name}}</b>" },
      Tags: [{ Key: "phase", Value: "SES-03" }],
    }, templateContext);
    await completeCreate(template, templateModel, templateContext);
    assert.equal((await template.read("provider-template", templateContext)).status, "SUCCESS");
    const generatedTemplateContext = context("GeneratedTemplate");
    const generatedTemplateModel = template.canonicalize({
      Template: { SubjectPart: "Generated" },
      Tags: [],
    }, generatedTemplateContext);
    const generatedTemplateCreated = await completeCreate(template, generatedTemplateModel, generatedTemplateContext);
    assert.equal(generatedTemplateCreated.physicalId, generatedTemplateModel.Template.TemplateName);
    assert.match(generatedTemplateCreated.physicalId, /^[A-Za-z0-9_-]{1,64}$/);
    const classic = await simulator.ses.execute("GetTemplate", { TemplateName: "provider-template" }, "ses-v1", "classic-read") as any;
    assert.deepEqual(classic.Template, {
      TemplateName: "provider-template",
      SubjectPart: "Hello {{name}}",
      TextPart: "Text {{name}}",
      HtmlPart: "<b>{{name}}</b>",
    });

    const identityContext = context("Identity");
    const identityModel = identity.canonicalize({
      EmailIdentity: "sender@example.test",
      ConfigurationSetAttributes: { ConfigurationSetName: "provider-set" },
      Tags: [{ Key: "owner", Value: "application" }],
    }, identityContext);
    const messagesBeforeIdentity = simulator.ses.summary().messageCount;
    const identityCreated = await completeCreate(identity, identityModel, identityContext);
    assert.equal(identityCreated.model.attributes.DkimDNSTokenName1, "");
    assert.equal((await identity.read("sender@example.test", identityContext)).status, "SUCCESS");
    assert.equal((await simulator.ses.execute("GetEmailIdentity", { EmailIdentity: "sender@example.test" }, "ses-v2", "identity-read") as any).VerifiedForSendingStatus, false);
    assert.equal(simulator.ses.summary().messageCount, messagesBeforeIdentity + 1, "pending verification capture must occur exactly once");

    const domainContext = context("DomainIdentity");
    const domainModel = identity.canonicalize({ EmailIdentity: "example.test", Tags: [] }, domainContext);
    const domainCreated = await completeCreate(identity, domainModel, domainContext);
    const domainTokens = simulator.store.regionState(region).ses.identities["example.test"].dkimTokens;
    assert.equal(domainTokens.length, 3);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(
        domainCreated.model.attributes[`DkimDNSTokenName${index + 1}`],
        `${domainTokens[index]}._domainkey.example.test`,
      );
      assert.equal(
        domainCreated.model.attributes[`DkimDNSTokenValue${index + 1}`],
        `${domainTokens[index]}.dkim.amazonses.com`,
      );
    }

    const stateIdentity = simulator.store.regionState(region).ses.identities["sender@example.test"];
    stateIdentity.verificationStatus = "SUCCESS";
    stateIdentity.verifiedForSendingStatus = true;
    await simulator.store.save();
    await assert.rejects(
      simulator.ses.execute("SendEmail", {
        FromEmailAddress: "sender@example.test",
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Content: { Template: { TemplateName: "provider-template", TemplateData: JSON.stringify({ name: "Ada" }) } },
      }, "ses-v2", "paused-send"),
      (error: any) => error.code === "SendingPausedException",
    );

    const enabledModel = configuration.canonicalize({ Name: "provider-set", Tags: [] }, configurationContext);
    const enabled = await configuration.update("provider-set", configurationModel, enabledModel, configurationContext);
    assert.equal(enabled.status, "SUCCESS");
    assert.deepEqual(enabled.status === "SUCCESS" ? enabled.model.properties.SendingOptions : undefined, { SendingEnabled: true });
    const revisionBeforeNoOp = simulator.store.regionState(region).ses.controlRevision;
    const noOp = await configuration.update("provider-set", enabledModel, structuredClone(enabledModel), configurationContext);
    assert.equal(noOp.status, "SUCCESS");
    assert.equal(simulator.store.regionState(region).ses.controlRevision, revisionBeforeNoOp, "provider no-op must not mutate SES state");

    const messagesBeforeSend = simulator.ses.summary().messageCount;
    await simulator.ses.execute("SendEmail", {
      FromEmailAddress: "sender@example.test",
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: { Template: { TemplateName: "provider-template", TemplateData: JSON.stringify({ name: "Ada" }) } },
    }, "ses-v2", "template-send");
    assert.equal(simulator.ses.summary().messageCount, messagesBeforeSend + 1);

    const updatedTemplate = template.canonicalize({
      Template: { TemplateName: "provider-template", SubjectPart: "Updated {{name}}", HtmlPart: "<i>{{name}}</i>" },
      Tags: [],
    }, templateContext);
    const templateUpdated = await template.update("provider-template", templateModel, updatedTemplate, templateContext);
    assert.equal(templateUpdated.status, "SUCCESS");
    const updatedClassic = await simulator.ses.execute("GetTemplate", { TemplateName: "provider-template" }, "ses-v1", "classic-updated") as any;
    assert.deepEqual(updatedClassic.Template, {
      TemplateName: "provider-template",
      SubjectPart: "Updated {{name}}",
      HtmlPart: "<i>{{name}}</i>",
    }, "removing TextPart must clear it in the shared classic/v2 catalog");

    const clearedIdentity = identity.canonicalize({ EmailIdentity: "sender@example.test", Tags: [] }, identityContext);
    const identityUpdated = await identity.update("sender@example.test", identityModel, clearedIdentity, identityContext);
    assert.equal(identityUpdated.status, "SUCCESS");
    assert.equal((await simulator.ses.execute("GetEmailIdentity", { EmailIdentity: "sender@example.test" }, "ses-v2", "identity-cleared") as any).ConfigurationSetName, undefined);

    const historyBeforeDelete = simulator.ses.summary().messageCount;
    assert.equal((await template.delete("provider-template", updatedTemplate, templateContext)).status, "SUCCESS");
    assert.equal((await template.delete(generatedTemplateModel.Template.TemplateName, generatedTemplateModel, generatedTemplateContext)).status, "SUCCESS");
    assert.equal((await identity.delete("sender@example.test", clearedIdentity, identityContext)).status, "SUCCESS");
    assert.equal((await identity.delete("example.test", domainModel, domainContext)).status, "SUCCESS");
    assert.equal((await configuration.delete("provider-set", enabledModel, configurationContext)).status, "SUCCESS");
    assert.equal(simulator.ses.summary().messageCount, historyBeforeDelete, "resource deletion must preserve historical captured mail");
    assert.equal((await template.read("provider-template", templateContext)).status, "NOT_FOUND");
    assert.equal((await identity.delete("sender@example.test", clearedIdentity, identityContext)).status, "NOT_FOUND");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES create recovery adopts only the exact operation markers and reports direct conflicts and out-of-band deletion", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-recovery-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off"});
  try {
    await simulator.start();
    const providers = createSesCloudFormationProviders(simulator.ses);
    const provider = providers.find(candidate => candidate.typeName === SES_TEMPLATE_TYPE)! as ProductionResourceProvider<SesTemplateModel>;
    const configuration = providers.find(candidate => candidate.typeName === SES_CONFIGURATION_SET_TYPE)! as ProductionResourceProvider<SesConfigurationSetModel>;
    const identity = providers.find(candidate => candidate.typeName === SES_EMAIL_IDENTITY_TYPE)! as ProductionResourceProvider<SesEmailIdentityModel>;
    const recoveryContext = context("RecoveredTemplate", "stable-recovery-operation");
    const desired = provider.canonicalize({ Template: { TemplateName: "lost-response-template", SubjectPart: "subject" }, Tags: [] }, recoveryContext);
    const first = await provider.create(desired, recoveryContext);
    assert.equal(first.status, "IN_PROGRESS");
    const resumed = { ...recoveryContext, callbackContext: first.status === "IN_PROGRESS" ? first.checkpoint.callbackContext : {} };

    const originalExecute = simulator.ses.execute.bind(simulator.ses);
    let inject = true;
    (simulator.ses as any).execute = async (...args: any[]) => {
      const result = await (originalExecute as any)(...args);
      if (inject && args[0] === "CreateEmailTemplate") {
        inject = false;
        throw new AwsError("InternalServiceErrorException", "simulated response loss after durable create", 500);
      }
      return result;
    };
    const lost = await provider.create(desired, resumed);
    assert.equal(lost.status, "FAILED");
    assert.equal(lost.status === "FAILED" ? lost.retryable : undefined, true);
    const recovered = await provider.create(desired, resumed);
    assert.equal(recovered.status, "SUCCESS", JSON.stringify(recovered));
    (simulator.ses as any).execute = originalExecute;

    await simulator.ses.execute("CreateEmailTemplate", {
      TemplateName: "direct-template",
      TemplateContent: { Subject: "direct" },
    }, "ses-v2", "direct-create");
    const directDesired = provider.canonicalize({ Template: { TemplateName: "direct-template", SubjectPart: "direct" }, Tags: [] }, context("DirectConflict"));
    const directFirst = await provider.create(directDesired, context("DirectConflict"));
    assert.equal(directFirst.status, "IN_PROGRESS");
    const directConflict = await provider.create(directDesired, {
      ...context("DirectConflict"),
      callbackContext: directFirst.status === "IN_PROGRESS" ? directFirst.checkpoint.callbackContext : {},
    });
    assert.equal(directConflict.status, "FAILED");
    assert.equal(directConflict.status === "FAILED" ? directConflict.errorCode : undefined, "AlreadyExists");

    await simulator.ses.execute("CreateConfigurationSet", {
      ConfigurationSetName: "direct-configuration",
    }, "ses-v2", "direct-configuration-create");
    const directConfigurationContext = context("DirectConfigurationConflict");
    const directConfiguration = configuration.canonicalize({ Name: "direct-configuration" }, directConfigurationContext);
    const directConfigurationFirst = await configuration.create(directConfiguration, directConfigurationContext);
    assert.equal(directConfigurationFirst.status, "IN_PROGRESS");
    const directConfigurationConflict = await configuration.create(directConfiguration, {
      ...directConfigurationContext,
      callbackContext: directConfigurationFirst.status === "IN_PROGRESS" ? directConfigurationFirst.checkpoint.callbackContext : {},
    });
    assert.equal(directConfigurationConflict.status, "FAILED");
    assert.equal(directConfigurationConflict.status === "FAILED" ? directConfigurationConflict.errorCode : undefined, "AlreadyExists");

    await simulator.ses.execute("CreateEmailIdentity", {
      EmailIdentity: "direct-identity@example.test",
    }, "ses-v2", "direct-identity-create");
    const directIdentityContext = context("DirectIdentityConflict");
    const directIdentity = identity.canonicalize({ EmailIdentity: "direct-identity@example.test" }, directIdentityContext);
    const directIdentityFirst = await identity.create(directIdentity, directIdentityContext);
    assert.equal(directIdentityFirst.status, "IN_PROGRESS");
    const directIdentityConflict = await identity.create(directIdentity, {
      ...directIdentityContext,
      callbackContext: directIdentityFirst.status === "IN_PROGRESS" ? directIdentityFirst.checkpoint.callbackContext : {},
    });
    assert.equal(directIdentityConflict.status, "FAILED");
    assert.equal(directIdentityConflict.status === "FAILED" ? directIdentityConflict.errorCode : undefined, "AlreadyExists");

    await simulator.ses.execute("DeleteEmailTemplate", { TemplateName: "lost-response-template" }, "ses-v2", "out-of-band-delete");
    assert.equal((await provider.read("lost-response-template", recoveryContext)).status, "NOT_FOUND");
    assert.equal((await provider.delete("lost-response-template", desired, recoveryContext)).status, "NOT_FOUND");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration-set deletion surfaces an authoritative SES dependency conflict", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-delete-conflict-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off"});
  try {
    await simulator.start();
    const providers = createSesCloudFormationProviders(simulator.ses);
    const configuration = providers.find(provider => provider.typeName === SES_CONFIGURATION_SET_TYPE)! as ProductionResourceProvider<SesConfigurationSetModel>;
    const identity = providers.find(provider => provider.typeName === SES_EMAIL_IDENTITY_TYPE)! as ProductionResourceProvider<SesEmailIdentityModel>;
    const configurationContext = context("ReferencedConfiguration");
    const configurationModel = configuration.canonicalize({ Name: "referenced-set" }, configurationContext);
    await completeCreate(configuration, configurationModel, configurationContext);
    const identityContext = context("ReferencingIdentity");
    const identityModel = identity.canonicalize({ EmailIdentity: "dependency@example.test", ConfigurationSetAttributes: { ConfigurationSetName: "referenced-set" } }, identityContext);
    await completeCreate(identity, identityModel, identityContext);
    const deletion = await configuration.delete("referenced-set", configurationModel, configurationContext);
    assert.equal(deletion.status, "FAILED");
    assert.equal(deletion.status === "FAILED" ? deletion.errorCode : undefined, "ConflictException");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES-04 CloudFormation providers share lifecycle state and stable child identity", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses04-provider-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off" });
  try {
    await simulator.start();
    await simulator.ses.execute("CreateEmailIdentity", { EmailIdentity: "verified@example.test" }, "ses-v2", "identity");
    const identity = simulator.store.regionState(region).ses.identities["verified@example.test"];
    identity.verificationStatus = "SUCCESS";
    identity.verifiedForSendingStatus = true;
    await simulator.store.save();
    await simulator.ses.execute("CreateConfigurationSet", { ConfigurationSetName: "events" }, "ses-v2", "configuration");

    const providers = createSesCloudFormationProviders(simulator.ses);
    const custom = providers.find(provider => provider.typeName === SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE)! as ProductionResourceProvider<SesCustomVerificationTemplateModel>;
    const contacts = providers.find(provider => provider.typeName === SES_CONTACT_LIST_TYPE)! as ProductionResourceProvider<SesContactListModel>;
    const events = providers.find(provider => provider.typeName === SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE)! as ProductionResourceProvider<SesConfigurationSetEventDestinationModel>;

    const customContext = context("VerificationTemplate");
    const customModel = custom.canonicalize({
      TemplateName: "verify",
      FromEmailAddress: "verified@example.test",
      TemplateSubject: "Verify",
      TemplateContent: "<p><a href=\"{{amazonSESVerificationURL}}\">Verify</a></p>",
      SuccessRedirectionURL: "http://localhost/success",
      FailureRedirectionURL: "http://localhost/failure",
      Tags: [{ Key: "phase", Value: "SES-04" }],
    }, customContext);
    await completeCreate(custom, customModel, customContext);
    assert.equal((await custom.read("verify", customContext)).status, "SUCCESS");

    const contactContext = context("Contacts");
    const contactModel = contacts.canonicalize({
      ContactListName: "customers",
      Description: "Customers",
      Topics: [{ TopicName: "news", DisplayName: "News", DefaultSubscriptionStatus: "OPT_IN" }],
      Tags: [],
    }, contactContext);
    await completeCreate(contacts, contactModel, contactContext);
    const updatedContact = contacts.canonicalize({ ...contactModel, Description: "Updated" }, contactContext);
    assert.equal((await contacts.update("customers", contactModel, updatedContact, contactContext)).status, "SUCCESS");

    const eventContext = context("Events");
    const eventModel = events.canonicalize({
      ConfigurationSetName: "events",
      EventDestination: {
        Name: "bus",
        Enabled: true,
        MatchingEventTypes: ["send", "renderingFailure"],
        EventBridgeDestination: { EventBusArn: `arn:aws:events:${region}:${accountId}:event-bus/default` },
      },
    }, eventContext);
    const createdEvent = await completeCreate(events, eventModel, eventContext);
    assert.match(createdEvent.physicalId, /^\d+:events[a-f0-9]{24}$/);
    assert.equal(events.ref(createdEvent.model), createdEvent.physicalId);
    assert.equal(events.getAtt(createdEvent.model, "Id"), createdEvent.physicalId);
    const renamedEvent = events.canonicalize({
      ConfigurationSetName: "events",
      EventDestination: {
        ...eventModel.EventDestination,
        Name: "renamed",
      },
    }, eventContext);
    const eventUpdate = await events.update(createdEvent.physicalId, eventModel, renamedEvent, eventContext);
    assert.equal(eventUpdate.status, "SUCCESS", JSON.stringify(eventUpdate));
    assert.equal(eventUpdate.status === "SUCCESS" ? eventUpdate.physicalId : undefined, createdEvent.physicalId);

    assert.equal((await events.delete(createdEvent.physicalId, renamedEvent, eventContext)).status, "SUCCESS");
    assert.equal((await contacts.delete("customers", updatedContact, contactContext)).status, "SUCCESS");
    assert.equal((await custom.delete("verify", customModel, customContext)).status, "SUCCESS");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
