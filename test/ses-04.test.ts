import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchGetMetricDataCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateContactCommand,
  CreateContactListCommand,
  CreateCustomVerificationEmailTemplateCommand,
  CreateEmailIdentityCommand,
  GetContactCommand,
  GetEmailIdentityCommand,
  GetMessageInsightsCommand,
  GetSuppressedDestinationCommand,
  ListSuppressedDestinationsCommand,
  PutConfigurationSetSuppressionOptionsCommand,
  PutConfigurationSetTrackingOptionsCommand,
  PutEmailIdentityDkimAttributesCommand,
  PutEmailIdentityMailFromAttributesCommand,
  PutSuppressedDestinationCommand,
  SESv2Client,
  SendCustomVerificationEmailCommand,
  SendEmailCommand,
  SendBulkEmailCommand,
} from "@aws-sdk/client-sesv2";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function verify(simulator: StackSim, client: SESv2Client, address: string): Promise<void> {
  await client.send(new CreateEmailIdentityCommand({ EmailIdentity: address }));
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const inbox = await (await fetch(`${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(address)}`)).json() as any;
  const message = inbox.messages.find((item: any) => item.operation === "VerifyEmailIdentity");
  const detail = await (await fetch(`${endpoint}/_stacksim/api/ses/inbox/${message.messageId}`)).json() as any;
  const link = detail.message.textBody.match(/https?:\/\/[^\s<]+/)[0];
  assert.equal((await fetch(link, { redirect: "manual" })).status, 303);
}

test("SES-04 contacts, suppression, identity depth and bulk sends persist exact outcomes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses04-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  await simulator.start();
  let client = new SESv2Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
  let cloudwatch = new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
  try {
    await verify(simulator, client, "sender@example.test");
    await client.send(new PutEmailIdentityDkimAttributesCommand({ EmailIdentity: "sender@example.test", SigningEnabled: true }));
    await client.send(new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: "sender@example.test", MailFromDomain: "mail.example.test", BehaviorOnMxFailure: "REJECT_MESSAGE" }));
    const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: "sender@example.test" }));
    assert.equal(identity.DkimAttributes?.SigningEnabled, true);
    assert.equal(identity.MailFromAttributes?.MailFromDomain, "mail.example.test");

    await client.send(new CreateCustomVerificationEmailTemplateCommand({
      TemplateName: "welcome",
      FromEmailAddress: "sender@example.test",
      TemplateSubject: "Verify",
      TemplateContent: "<a href=\"{{amazonSESVerificationURL}}\">Verify</a>",
      SuccessRedirectionURL: "http://localhost/success",
      FailureRedirectionURL: "http://localhost/failure",
    }));
    const customVerification = await client.send(new SendCustomVerificationEmailCommand({
      EmailAddress: "custom@example.test",
      TemplateName: "welcome",
    }));
    const customInbox = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/ses/inbox?recipient=custom%40example.test`)).json() as any;
    const customSummary = customInbox.messages.find((item: any) => item.messageId === customVerification.MessageId);
    const customDetail = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/ses/inbox/${customSummary.messageId}`)).json() as any;
    assert.equal(customDetail.message.subject, "Verify");
    assert.match(customDetail.message.htmlBody, /SendCustomVerificationEmail|verify-email|Verify/);
    const verificationLink = customDetail.message.textBody.match(/https?:\/\/[^\s<]+/)[0];
    const verificationResponse = await fetch(verificationLink, { redirect: "manual" });
    const localResult = await fetch(new URL(verificationResponse.headers.get("location")!, verificationLink));
    assert.match(await localResult.text(), /href="http:\/\/localhost\/success"/);
    await client.send(new CreateContactListCommand({
      ContactListName: "customers",
      Topics: [{ TopicName: "news", DisplayName: "News", DefaultSubscriptionStatus: "OPT_IN" }],
    }));
    await client.send(new CreateContactCommand({
      ContactListName: "customers",
      EmailAddress: "optout@example.test",
      TopicPreferences: [{ TopicName: "news", SubscriptionStatus: "OPT_OUT" }],
    }));
    assert.equal((await client.send(new GetContactCommand({ ContactListName: "customers", EmailAddress: "optout@example.test" }))).TopicPreferences?.[0].SubscriptionStatus, "OPT_OUT");

    await client.send(new PutSuppressedDestinationCommand({ EmailAddress: "blocked@example.test", Reason: "BOUNCE" }));
    assert.equal((await client.send(new GetSuppressedDestinationCommand({ EmailAddress: "blocked@example.test" }))).SuppressedDestination?.Reason, "BOUNCE");
    assert.deepEqual((await client.send(new ListSuppressedDestinationsCommand({}))).SuppressedDestinationSummaries?.map(item => item.EmailAddress), ["blocked@example.test"]);

    await client.send(new CreateConfigurationSetCommand({ ConfigurationSetName: "events" }));
    await client.send(new PutConfigurationSetSuppressionOptionsCommand({ ConfigurationSetName: "events", SuppressedReasons: ["BOUNCE"] }));
    await client.send(new PutConfigurationSetTrackingOptionsCommand({ ConfigurationSetName: "events", HttpsPolicy: "OPTIONAL" }));
    await client.send(new CreateConfigurationSetEventDestinationCommand({
      ConfigurationSetName: "events",
      EventDestinationName: "metrics",
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ["SEND", "BOUNCE", "CLICK"],
        CloudWatchDestination: {
          DimensionConfigurations: [{ DimensionName: "campaign", DimensionValueSource: "MESSAGE_TAG", DefaultDimensionValue: "default" }],
        },
      },
    }));
    const metricStart = new Date(Date.now() - 60_000);
    const result = await client.send(new SendBulkEmailCommand({
      FromEmailAddress: "sender@example.test",
      ConfigurationSetName: "events",
      DefaultEmailTags: [{ Name: "campaign", Value: "ses04" }],
      DefaultContent: { Template: { TemplateContent: { Subject: "Hello {{name}}", Text: "Hi {{name}}" }, TemplateData: "{\"name\":\"default\"}" } },
      BulkEmailEntries: [
        { Destination: { ToAddresses: ["ok@example.test"] }, ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: "{\"name\":\"Ada\"}" } } },
        { Destination: { ToAddresses: ["blocked@example.test"] }, ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: "{\"name\":\"Grace\"}" } } },
        { Destination: { ToAddresses: ["bad address"] } },
      ],
    }));
    assert.deepEqual(result.BulkEmailEntryResults?.map(item => item.Status), ["SUCCESS", "SUCCESS", "FAILED"]);
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const inbox = await (await fetch(`${endpoint}/_stacksim/api/ses/inbox`)).json() as any;
    const bulk = inbox.messages.filter((item: any) => item.operation === "SendBulkEmail");
    assert.equal(bulk.length, 2);
    const details = await Promise.all(bulk.map(async (item: any) => (await (await fetch(`${endpoint}/_stacksim/api/ses/inbox/${item.messageId}`)).json() as any).message));
    assert.deepEqual(details.map((item: any) => item.localDisposition).sort(), ["CAPTURED", "SUPPRESSED"]);
    const sendMetric = await cloudwatch.send(new GetMetricStatisticsCommand({
      Namespace: "AWS/SES",
      MetricName: "Send",
      Dimensions: [{ Name: "campaign", Value: "ses04" }],
      StartTime: metricStart,
      EndTime: new Date(Date.now() + 60_000),
      Period: 60,
      Statistics: ["Sum"],
    }));
    assert.equal(sendMetric.Datapoints?.reduce((total, point) => total + (point.Sum ?? 0), 0), 1);

    const managed = await client.send(new SendEmailCommand({
      FromEmailAddress: "sender@example.test",
      ConfigurationSetName: "events",
      Destination: { ToAddresses: ["managed@example.test"] },
      ListManagementOptions: { ContactListName: "customers", TopicName: "news" },
      Content: {
        Simple: {
          Subject: { Data: "Managed" },
          Body: { Html: { Data: "<a href=\"http://localhost:43210/path?x=1\">Tracked</a>" } },
        },
      },
    }));
    const managedDetail = await (await fetch(`${endpoint}/_stacksim/api/ses/inbox/${managed.MessageId}`)).json() as any;
    const unsubscribeLink = managedDetail.message.textBody.match(/https?:\/\/[^\s<]+/)[0];
    const clickLink = managedDetail.message.htmlBody.match(/https?:\/\/[^"]+\/click\?token=[^"]+/)[0].replaceAll("&amp;", "&");
    const persistedPort = simulator.port;

    client.destroy();
    cloudwatch.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: persistedPort, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    client = new SESv2Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    cloudwatch = new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    assert.equal((await client.send(new GetSuppressedDestinationCommand({ EmailAddress: "blocked@example.test" }))).SuppressedDestination?.Reason, "BOUNCE");
    const unsubscribe = await fetch(unsubscribeLink, { headers: { connection: "close" } });
    assert.equal(unsubscribe.status, 200);
    await unsubscribe.text();
    const unsubscribeReplay = await fetch(unsubscribeLink, { headers: { connection: "close" } });
    assert.equal(unsubscribeReplay.status, 400, "unsubscribe callback tokens are one-time");
    await unsubscribeReplay.text();
    assert.equal((await client.send(new GetContactCommand({ ContactListName: "customers", EmailAddress: "managed@example.test" }))).TopicPreferences?.[0].SubscriptionStatus, "OPT_OUT");
    const click = await fetch(clickLink, { redirect: "manual", headers: { connection: "close" } });
    assert.equal(click.status, 303);
    assert.equal(click.headers.get("location"), "http://localhost:43210/path?x=1");
    await click.text();
    const clickMetrics = await client.send(new BatchGetMetricDataCommand({ Queries: [{
      Id: "clicks",
      Namespace: "VDM",
      Metric: "CLICK",
      StartDate: new Date(Date.now() - 60_000),
      EndDate: new Date(Date.now() + 60_000),
    }] }));
    assert.equal(clickMetrics.Results?.[0].Values?.[0], 1);
    const insights = await client.send(new GetMessageInsightsCommand({ MessageId: managed.MessageId! }));
    assert.ok(insights.Insights?.some(item => item.Events?.some(event => event.Type === "CLICK")));
    const clickReplay = await fetch(clickLink, { redirect: "manual", headers: { connection: "close" } });
    assert.equal(clickReplay.status, 400, "click callback tokens are one-time");
    await clickReplay.text();
  } finally {
    client.destroy();
    cloudwatch.destroy();
    await simulator.stop();
    await rm(root, { recursive: true, force: true });
  }
});
