import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateConfigurationSetCommand as CreateConfigurationSetV1Command,
  CreateTemplateCommand,
  DescribeConfigurationSetCommand,
  GetTemplateCommand,
  SESClient,
  SendEmailCommand as SendEmailV1Command,
} from "@aws-sdk/client-ses";
import {
  CreateEmailIdentityCommand,
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  GetEmailTemplateCommand,
  PutConfigurationSetSendingOptionsCommand,
  PutEmailIdentityConfigurationSetAttributesCommand,
  SESv2Client,
  SendEmailCommand as SendEmailV2Command,
  TestRenderEmailTemplateCommand,
} from "@aws-sdk/client-sesv2";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface InboxSummary {
  messageId: string;
  operation: string;
  subject?: string;
  templateName?: string;
  configurationSetName?: string;
  renderStatus: string;
}

interface InboxDetail {
  messageId: string;
  apiFamily: string;
  operation: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  templateName?: string;
  configurationSetName?: string;
  renderStatus: string;
  localDisposition: string;
  outcomeCode?: string;
}

function endpointFor(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function clients(simulator: StackSim): { v1: SESClient; v2: SESv2Client } {
  const options = { endpoint: endpointFor(simulator), region, credentials };
  return { v1: new SESClient(options), v2: new SESv2Client(options) };
}

async function jsonResponse<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (response.status !== 200) assert.fail(`GET ${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function consumeVerification(endpoint: string, identity: string): Promise<void> {
  const inbox = await jsonResponse<{ messages: InboxSummary[] }>(
    `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identity)}`,
  );
  const verification = inbox.messages.find(message => message.operation === "VerifyEmailIdentity");
  assert(verification);
  const detail = await jsonResponse<{ message: InboxDetail }>(
    `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(verification.messageId)}`,
  );
  const link = detail.message.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
  assert(link);
  const callback = await fetch(link, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const location = callback.headers.get("location");
  assert(location);
  const result = await fetch(new URL(location, endpoint));
  assert.equal(result.status, 200);
}

test("SES v1/v2 share identities, templates and configuration sets and persist Inbox state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-core-"));
  const simulatorOptions = {
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off" as const,
  };
  let simulator = new StackSim(simulatorOptions);
  let active = clients(simulator);
  try {
    await simulator.start();
    active.v1.destroy();
    active.v2.destroy();
    active = clients(simulator);
    let endpoint = endpointFor(simulator);
    const identity = "shared-sender@example.com";
    const templateName = "SharedWelcome";
    const configurationSetName = "shared_config";

    await active.v2.send(new CreateEmailIdentityCommand({ EmailIdentity: identity }));
    await consumeVerification(endpoint, identity);

    await active.v1.send(new CreateTemplateCommand({
      Template: {
        TemplateName: templateName,
        SubjectPart: "Welcome {{name}}",
        TextPart: "Hello {{name}} from {{team}}",
        HtmlPart: "<p>Hello <strong>{{name}}</strong> from {{team}}</p>",
      },
    }));
    const v2Template = await active.v2.send(new GetEmailTemplateCommand({
      TemplateName: templateName,
    }));
    assert.equal(v2Template.TemplateContent?.Subject, "Welcome {{name}}");
    const rendered = await active.v2.send(new TestRenderEmailTemplateCommand({
      TemplateName: templateName,
      TemplateData: JSON.stringify({ name: "Ada", team: "SES" }),
    }));
    assert.match(rendered.RenderedTemplate ?? "", /^Subject: Welcome Ada\r\n/);
    assert.match(rendered.RenderedTemplate ?? "", /Hello Ada from SES/);

    await active.v1.send(new CreateConfigurationSetV1Command({
      ConfigurationSet: { Name: configurationSetName },
    }));
    const v2Configuration = await active.v2.send(new GetConfigurationSetCommand({
      ConfigurationSetName: configurationSetName,
    }));
    assert.equal(v2Configuration.ConfigurationSetName, configurationSetName);
    assert.equal(v2Configuration.SendingOptions?.SendingEnabled, true);
    await active.v2.send(new PutEmailIdentityConfigurationSetAttributesCommand({
      EmailIdentity: identity,
      ConfigurationSetName: configurationSetName,
    }));

    const sent = await active.v2.send(new SendEmailV2Command({
      FromEmailAddress: identity,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: {
        Template: {
          TemplateName: templateName,
          TemplateData: JSON.stringify({ name: "Ada", team: "SES" }),
        },
      },
    }));
    assert(sent.MessageId);
    const detail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(sent.MessageId)}`,
    );
    assert.equal(detail.message.templateName, templateName);
    assert.equal(detail.message.configurationSetName, configurationSetName);
    assert.equal(detail.message.subject, "Welcome Ada");
    assert.equal(detail.message.textBody, "Hello Ada from SES");
    assert.equal(detail.message.renderStatus, "RENDERED");
    assert.equal(detail.message.localDisposition, "CAPTURED");

    const failedRender = await active.v2.send(new SendEmailV2Command({
      FromEmailAddress: identity,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: {
        Template: {
          TemplateName: templateName,
          TemplateData: JSON.stringify({ name: "Grace" }),
        },
      },
    }));
    assert(failedRender.MessageId, "accepted template sends return a MessageId before rendering outcome");
    const failedDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(failedRender.MessageId)}`,
    );
    assert.equal(failedDetail.message.renderStatus, "FAILED");
    assert.equal(failedDetail.message.localDisposition, "NOT_ATTEMPTED");
    assert.equal(failedDetail.message.outcomeCode, "TEMPLATE_RENDERING_FAILURE");

    await active.v2.send(new PutConfigurationSetSendingOptionsCommand({
      ConfigurationSetName: configurationSetName,
      SendingEnabled: false,
    }));
    await assert.rejects(
      active.v2.send(new SendEmailV2Command({
        FromEmailAddress: identity,
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Content: {
          Simple: {
            Subject: { Data: "paused" },
            Body: { Text: { Data: "must not be captured" } },
          },
        },
      })),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, "SendingPausedException");
        return true;
      },
    );
    await assert.rejects(
      active.v1.send(new SendEmailV1Command({
        Source: identity,
        ConfigurationSetName: configurationSetName,
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Message: {
          Subject: { Data: "paused v1" },
          Body: { Text: { Data: "must not be captured" } },
        },
      })),
      (error: unknown) => {
        assert.match((error as { name?: string }).name ?? "", /ConfigurationSetSendingPaused/);
        return true;
      },
    );
    const beforeRestart = await jsonResponse<{ messages: InboxSummary[] }>(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=success%40simulator.amazonses.com`,
    );
    assert.deepEqual(
      new Set(beforeRestart.messages.map(message => message.messageId)),
      new Set([sent.MessageId!, failedRender.MessageId!]),
      "disabled configuration-set sends create no Inbox rows",
    );

    await active.v2.send(new PutConfigurationSetSendingOptionsCommand({
      ConfigurationSetName: configurationSetName,
      SendingEnabled: true,
    }));
    active.v1.destroy();
    active.v2.destroy();
    await simulator.stop();

    simulator = new StackSim(simulatorOptions);
    await simulator.start();
    active = clients(simulator);
    endpoint = endpointFor(simulator);

    const persistedIdentity = await active.v2.send(new GetEmailIdentityCommand({
      EmailIdentity: identity,
    }));
    assert.equal(persistedIdentity.VerifiedForSendingStatus, true);
    assert.equal(persistedIdentity.ConfigurationSetName, configurationSetName);
    const persistedTemplateV1 = await active.v1.send(new GetTemplateCommand({
      TemplateName: templateName,
    }));
    assert.equal(persistedTemplateV1.Template?.SubjectPart, "Welcome {{name}}");
    const persistedConfigurationV1 = await active.v1.send(new DescribeConfigurationSetCommand({
      ConfigurationSetName: configurationSetName,
    }));
    assert.equal(persistedConfigurationV1.ConfigurationSet?.Name, configurationSetName);
    const persistedConfigurationV2 = await active.v2.send(new GetConfigurationSetCommand({
      ConfigurationSetName: configurationSetName,
    }));
    assert.equal(persistedConfigurationV2.SendingOptions?.SendingEnabled, true);

    const persistedDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(sent.MessageId!)}`,
    );
    assert.equal(persistedDetail.message.subject, "Welcome Ada");
    assert.equal(persistedDetail.message.templateName, templateName);
    const persistedFilter = await jsonResponse<{ messages: InboxSummary[] }>(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=SUCCESS%40SIMULATOR.AMAZONSES.COM`,
    );
    assert(persistedFilter.messages.some(message => message.messageId === sent.MessageId));
  } finally {
    active.v1.destroy();
    active.v2.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
