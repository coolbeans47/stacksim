import { metrics, rest, sns } from "../api-client.js";
import { emptyState, escapeHtml, metricChart, pageHeader, tabs } from "../components.js";
import { decorateSnsPanelHelp } from "./sns-help.js";

export const metadata = {
  key: "sns",
  name: "SNS",
  icon: "N",
  cls: "sns",
  links: [["Overview", "#/sns"], ["Topics", "#/sns/topics"], ["Subscriptions", "#/sns/subscriptions"]],
  search: ["sns", "topic", "notification", "publish", "fan out", "subscription", "sqs", "lambda"],
};

const children = (node, name) => [...(node?.childNodes ?? [])]
  .filter(item => item.nodeType === 1 && (!name || item.localName === name || item.nodeName === name));
const child = (node, name) => children(node, name)[0];
const text = (node, name) => child(node, name)?.textContent ?? "";

function resultNode(result) {
  const root = result.xml?.documentElement;
  return children(root).find(node => /Result$/.test(node.localName || node.nodeName)) ?? root;
}

function resultMembers(result, containerName) {
  return children(child(resultNode(result), containerName), "member");
}

function resultMap(result, containerName) {
  return Object.fromEntries(children(child(resultNode(result), containerName), "entry")
    .map(entry => [text(entry, "key"), text(entry, "value")]));
}

const topicName = (arn = "") => String(arn).split(":").at(-1) ?? "";

function subscriptionView(node) {
  return Object.fromEntries(["SubscriptionArn", "Owner", "Protocol", "Endpoint", "TopicArn"]
    .map(name => [name, text(node, name)]));
}

function endpointLink(subscription) {
  if (subscription.Protocol === "sqs") {
    return `#/sqs/queues/${encodeURIComponent(subscription.Endpoint.split(":").at(-1))}/details`;
  }
  if (subscription.Protocol === "lambda") {
    const name = subscription.Endpoint.split(":function:")[1]?.split(":")[0] ?? subscription.Endpoint;
    return `#/lambda/functions/${encodeURIComponent(name)}`;
  }
  return "";
}

async function listTopics() {
  const topics = [];
  let NextToken;
  do {
    const result = await sns("ListTopics", NextToken ? { NextToken } : {});
    topics.push(...resultMembers(result, "Topics").map(node => text(node, "TopicArn")));
    NextToken = text(resultNode(result), "NextToken") || undefined;
  } while (NextToken);
  return topics;
}

async function listSubscriptions(TopicArn) {
  const items = [];
  let NextToken;
  const action = TopicArn ? "ListSubscriptionsByTopic" : "ListSubscriptions";
  do {
    const result = await sns(action, {
      ...(TopicArn ? { TopicArn } : {}),
      ...(NextToken ? { NextToken } : {}),
    });
    items.push(...resultMembers(result, "Subscriptions").map(subscriptionView));
    NextToken = text(resultNode(result), "NextToken") || undefined;
  } while (NextToken);
  return items;
}

async function topicDescriptor(name) {
  const TopicArn = (await listTopics()).find(arn => topicName(arn) === name);
  if (!TopicArn) throw new Error(`Topic ${name} does not exist`);
  const [attributeResult, tagResult, subscriptions] = await Promise.all([
    sns("GetTopicAttributes", { TopicArn }),
    sns("ListTagsForResource", { ResourceArn: TopicArn }),
    listSubscriptions(TopicArn),
  ]);
  const Tags = Object.fromEntries(resultMembers(tagResult, "Tags")
    .map(node => [text(node, "Key"), text(node, "Value")]));
  const describedSubscriptions = await Promise.all(subscriptions.map(async subscription => {
    const result = await sns("GetSubscriptionAttributes", { SubscriptionArn: subscription.SubscriptionArn });
    return { ...subscription, Attributes: resultMap(result, "Attributes") };
  }));
  return {
    name,
    TopicArn,
    Attributes: resultMap(attributeResult, "Attributes"),
    Tags,
    subscriptions: describedSubscriptions,
  };
}

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function bindCreateTopic(context) {
  document.querySelectorAll("[data-create-sns-topic]").forEach(button => button.addEventListener("click", () => {
    context.showModal(
      "Create topic",
      `<div class="alert info"><strong>Standard topics only</strong><br>FIFO topics are not currently available.</div>
      <div class="field"><label>Topic name</label><input name="name" required maxlength="256" pattern="[A-Za-z0-9_-]+" placeholder="orders"></div>
      <div class="field"><label>Display name (optional)</label><input name="displayName" maxlength="100"></div>
      <div class="field"><label>Signature version</label><select name="signatureVersion"><option value="1">1 (RSA-SHA1)</option><option value="2">2 (RSA-SHA256)</option></select></div>
      <div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>`,
      "Create topic",
      async data => {
        const tagMap = parseObject(data.get("tags"), "Tags");
        if (Object.values(tagMap).some(value => typeof value !== "string")) throw new Error("Tag values must be strings");
        const result = await sns("CreateTopic", {
          Name: String(data.get("name")),
          Attributes: {
            DisplayName: String(data.get("displayName") || ""),
            SignatureVersion: String(data.get("signatureVersion")),
          },
          Tags: Object.entries(tagMap).map(([Key, Value]) => ({ Key, Value })),
        });
        context.toast("Topic created");
        location.hash = `#/sns/topics/${encodeURIComponent(topicName(result.value("TopicArn")))}`;
      },
    );
  }));
}

async function overview(context) {
  const [topics, subscriptions, diagnostics] = await Promise.all([
    listTopics(),
    listSubscriptions(),
    rest("/_stacksim/api/sns/deliveries"),
  ]);
  const active = diagnostics.filter(item => item.status === "QUEUED" || item.status === "LEASED").length;
  const failed = diagnostics.filter(item => item.status === "FAILED").length;
  context.setChrome("sns", ["SNS", "Overview"]);
  context.main.innerHTML = `<div class="page-width">
    ${pageHeader("SNS", "Durable local publish and fan-out for Standard topics.", '<button class="button primary" data-create-sns-topic>Create topic</button>')}
    <div class="sns-summary-grid">
      <section class="card"><div class="card-body"><div class="metric">${topics.length}</div><div>Standard topics</div></div></section>
      <section class="card"><div class="card-body"><div class="metric">${subscriptions.length}</div><div>SQS and Lambda subscriptions</div></div></section>
      <section class="card"><div class="card-body"><div class="metric">${active}</div><div>Pending deliveries</div></div></section>
    </div>
    <div class="alert info"><strong>Available integrations</strong><br>Filters, raw SQS delivery, topic policies, signatures, managed retry, Standard SQS dead-letter queues, delivery feedback logs, four exact CloudFormation providers, and the named first-party producer paths are active. FIFO and HTTP/S, email, SMS, and mobile endpoints remain unavailable.</div>
    <section class="card"><div class="card-header"><h2>Integration health</h2><span class="status">Available</span></div>
      <div class="table-wrap"><table><thead><tr><th>Producer</th><th>Status</th><th>Related resources</th></tr></thead><tbody>
        <tr><td>Lambda async and DynamoDB Streams</td><td><span class="status">Policy-aware publication</span></td><td><a href="#/lambda/functions">Lambda functions</a></td></tr>
        <tr><td>CloudWatch alarms</td><td><span class="status">Durable action outbox</span></td><td><a href="#/cloudwatch/alarms">Alarms</a></td></tr>
        <tr><td>EventBridge targets</td><td><span class="status">Existing retry/DLQ worker</span></td><td><a href="#/eventbridge/rules">Rules</a></td></tr>
        <tr><td>CloudFormation notifications</td><td><span class="status">Durable event outbox</span></td><td><a href="#/cloudformation/stacks">Stacks</a></td></tr>
        <tr><td>API Gateway Publish</td><td><span class="status inactive">Dependency blocked</span></td><td>Assumed-role Query mapping and recovery are not active</td></tr>
      </tbody></table></div>
    </section>
    <section class="card"><div class="card-header"><h2>Delivery health</h2><a href="#/sns/subscriptions">View subscriptions</a></div>
      <div class="card-body"><p><strong>${failed}</strong> terminal failure${failed === 1 ? "" : "s"} in retained redacted diagnostics.</p><p class="muted">Message bodies and attributes are never exposed here. Accepted payloads are stored only in the authenticated-encrypted SNS delivery store.</p></div>
    </section>
  </div>`;
  bindCreateTopic(context);
}

async function topicsPage(context) {
  const topics = await listTopics();
  context.setChrome("sns", ["SNS", "Topics"]);
  context.main.innerHTML = `<div class="page-width">
    ${pageHeader("Topics", "Create and inspect regional Standard topics.", '<button class="button refresh" data-refresh title="Refresh" aria-label="Refresh topics">↻</button><button class="button primary" data-create-sns-topic>Create topic</button>')}
    <section class="card"><div class="card-header"><h2>Topics <span class="muted">(${topics.length})</span></h2></div>
      <div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find topics"></label></div>
      <div class="table-wrap">${topics.length
        ? `<table class="sns-resource-table"><thead><tr><th>Name</th><th>Type</th><th>Topic ARN</th></tr></thead><tbody>${topics.map(arn => `<tr data-search-row="${escapeHtml(arn.toLowerCase())}"><td><a href="#/sns/topics/${encodeURIComponent(topicName(arn))}">${escapeHtml(topicName(arn))}</a></td><td>Standard</td><td class="mono">${escapeHtml(arn)}</td></tr>`).join("")}</tbody></table>`
        : emptyState("N", "No topics", "Create a Standard topic to publish notifications.", '<button class="button primary" data-create-sns-topic>Create topic</button>')}</div>
    </section>
  </div>`;
  context.bindTableFilter();
  bindCreateTopic(context);
  document.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

function topicTabs(name, active) {
  const encoded = encodeURIComponent(name);
  return tabs([
    { label: "Details", href: `#/sns/topics/${encoded}`, active: active === "details" },
    { label: "Monitoring", href: `#/sns/topics/${encoded}/monitoring`, active: active === "monitoring" },
  ]);
}

function bindSubscription(context, topic) {
  document.querySelectorAll("[data-create-sns-subscription]").forEach(button => button.addEventListener("click", () => {
    context.showModal(
      "Create subscription",
      `<div class="field"><label>Protocol</label><select name="protocol"><option value="sqs">SQS</option><option value="lambda">Lambda</option></select></div>
      <div class="field"><label>Endpoint ARN</label><input name="endpoint" required placeholder="arn:aws:sqs:REGION:ACCOUNT:queue-name"><span class="hint">The endpoint must already exist in this account and Region. Configure its resource policy to trust <span class="mono">sns.amazonaws.com</span> and this topic ARN.</span></div>
      <div class="field"><label>Filter policy (JSON, optional)</label><textarea name="filter"></textarea></div>
      <div class="field-row"><div class="field"><label>Filter scope</label><select name="scope"><option value="MessageAttributes">Message attributes</option><option value="MessageBody">Message body</option></select></div>
      <div class="field"><label><input type="checkbox" name="raw" value="true"> Raw SQS delivery</label></div></div>
      <div class="field"><label>Dead-letter queue ARN (optional)</label><input name="dlq" placeholder="arn:aws:sqs:REGION:ACCOUNT:dead-letter-queue"></div>
      <p><a href="#/sqs/queues">Open SQS queues</a> · <a href="#/lambda/functions">Open Lambda functions</a></p>`,
      "Create subscription",
      async data => {
        const filter = String(data.get("filter") || "").trim();
        if (filter) parseObject(filter, "Filter policy");
        const dlq = String(data.get("dlq") || "").trim();
        await sns("Subscribe", {
          TopicArn: topic.TopicArn,
          Protocol: String(data.get("protocol")),
          Endpoint: String(data.get("endpoint")).trim(),
          ReturnSubscriptionArn: true,
          Attributes: {
            FilterPolicyScope: String(data.get("scope")),
            ...(filter ? { FilterPolicy: filter } : {}),
            RawMessageDelivery: String(data.get("raw") === "true"),
            ...(dlq ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq }) } : {}),
          },
        });
        context.toast("Subscription created");
      },
    );
  }));
}

function bindPublish(context, topic) {
  document.querySelectorAll("[data-publish-sns]").forEach(button => button.addEventListener("click", () => {
    context.showModal(
      "Publish message",
      `<div class="field"><label>Message</label><textarea name="message" required maxlength="262144"></textarea></div>
      <div class="field"><label>Subject (optional)</label><input name="subject" maxlength="99"></div>
      <div class="field-row"><div class="field"><label>Message structure</label><select name="structure"><option value="">Identical payload</option><option value="json">Protocol-specific JSON</option></select></div>
      <div class="field"><label>Message group ID (optional)</label><input name="group" maxlength="128"><span class="hint">Forwarded to Standard SQS fair queues.</span></div></div>
      <div class="field"><label>Message attributes (JSON object)</label><textarea name="attributes">{}</textarea><span class="hint">Use SNS values such as {"kind":{"DataType":"String","StringValue":"created"}}. Attributes cannot accompany JSON message structure.</span></div>`,
      "Publish",
      async data => {
        const structure = String(data.get("structure"));
        const attributes = parseObject(data.get("attributes"), "Message attributes");
        if (structure && Object.keys(attributes).length) throw new Error("Message attributes cannot be used with protocol-specific JSON");
        const result = await sns("Publish", {
          TopicArn: topic.TopicArn,
          Message: String(data.get("message")),
          Subject: String(data.get("subject") || "") || undefined,
          MessageStructure: structure || undefined,
          MessageGroupId: String(data.get("group") || "") || undefined,
          MessageAttributes: attributes,
        });
        context.toast(`Message accepted · ${result.value("MessageId")}`);
      },
      true,
    );
  }));
}

function bindTags(context, topic) {
  document.querySelector("[data-manage-sns-tags]")?.addEventListener("click", () => {
    context.showModal(
      "Manage tags",
      `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(topic.Tags, null, 2))}</textarea><span class="hint">Removing a key here untags it.</span></div>`,
      "Save",
      async data => {
        const next = parseObject(data.get("tags"), "Tags");
        if (Object.values(next).some(value => typeof value !== "string")) throw new Error("Tag values must be strings");
        const removed = Object.keys(topic.Tags).filter(key => !(key in next));
        if (removed.length) await sns("UntagResource", { ResourceArn: topic.TopicArn, TagKeys: removed });
        if (Object.keys(next).length) await sns("TagResource", {
          ResourceArn: topic.TopicArn,
          Tags: Object.entries(next).map(([Key, Value]) => ({ Key, Value })),
        });
        context.toast("Topic tags updated");
      },
    );
  });
}

function bindTopicConfiguration(context, topic) {
  document.querySelector("[data-configure-sns-topic]")?.addEventListener("click", () => {
    context.showModal(
      "Topic delivery configuration",
      `<div class="field"><label>Signature version</label><select name="signature"><option value="1"${topic.Attributes.SignatureVersion === "1" ? " selected" : ""}>1 (RSA-SHA1)</option><option value="2"${topic.Attributes.SignatureVersion === "2" ? " selected" : ""}>2 (RSA-SHA256)</option></select></div>
      <div class="field"><label>Topic policy</label><textarea name="policy">${escapeHtml(JSON.stringify(JSON.parse(topic.Attributes.Policy), null, 2))}</textarea></div>
      <div class="field-row"><div class="field"><label>SQS success feedback role ARN</label><input name="sqsSuccessRole" value="${escapeHtml(topic.Attributes.SQSSuccessFeedbackRoleArn || "")}"></div><div class="field"><label>Success sample %</label><input name="sqsSample" type="number" min="0" max="100" value="${escapeHtml(topic.Attributes.SQSSuccessFeedbackSampleRate || "0")}"></div></div>
      <div class="field"><label>SQS failure feedback role ARN</label><input name="sqsFailureRole" value="${escapeHtml(topic.Attributes.SQSFailureFeedbackRoleArn || "")}"></div>
      <div class="field-row"><div class="field"><label>Lambda success feedback role ARN</label><input name="lambdaSuccessRole" value="${escapeHtml(topic.Attributes.LambdaSuccessFeedbackRoleArn || "")}"></div><div class="field"><label>Success sample %</label><input name="lambdaSample" type="number" min="0" max="100" value="${escapeHtml(topic.Attributes.LambdaSuccessFeedbackSampleRate || "0")}"></div></div>
      <div class="field"><label>Lambda failure feedback role ARN</label><input name="lambdaFailureRole" value="${escapeHtml(topic.Attributes.LambdaFailureFeedbackRoleArn || "")}"></div>`,
      "Save",
      async data => {
        parseObject(data.get("policy"), "Topic policy");
        const values = {
          SignatureVersion: String(data.get("signature")),
          Policy: String(data.get("policy")),
          SQSSuccessFeedbackRoleArn: String(data.get("sqsSuccessRole") || ""),
          SQSSuccessFeedbackSampleRate: String(data.get("sqsSample")),
          SQSFailureFeedbackRoleArn: String(data.get("sqsFailureRole") || ""),
          LambdaSuccessFeedbackRoleArn: String(data.get("lambdaSuccessRole") || ""),
          LambdaSuccessFeedbackSampleRate: String(data.get("lambdaSample")),
          LambdaFailureFeedbackRoleArn: String(data.get("lambdaFailureRole") || ""),
        };
        for (const [AttributeName, AttributeValue] of Object.entries(values)) {
          await sns("SetTopicAttributes", { TopicArn: topic.TopicArn, AttributeName, AttributeValue });
        }
        context.toast("Topic configuration updated");
      },
      true,
    );
  });
}

function bindSubscriptionConfiguration(context, topic) {
  document.querySelectorAll("[data-configure-sns-subscription]").forEach(button => button.addEventListener("click", () => {
    const subscription = topic.subscriptions.find(item => item.SubscriptionArn === button.dataset.configureSnsSubscription);
    if (!subscription) return;
    const attributes = subscription.Attributes;
    const redrive = attributes.RedrivePolicy ? JSON.parse(attributes.RedrivePolicy).deadLetterTargetArn : "";
    context.showModal(
      "Subscription delivery configuration",
      `<div class="field"><label>Filter policy (JSON, empty removes)</label><textarea name="filter">${escapeHtml(attributes.FilterPolicy || "")}</textarea></div>
      <div class="field"><label>Filter scope</label><select name="scope"><option value="MessageAttributes"${attributes.FilterPolicyScope === "MessageAttributes" ? " selected" : ""}>Message attributes</option><option value="MessageBody"${attributes.FilterPolicyScope === "MessageBody" ? " selected" : ""}>Message body</option></select></div>
      <div class="field"><label><input type="checkbox" name="raw" value="true"${attributes.RawMessageDelivery === "true" ? " checked" : ""}> Raw SQS delivery</label></div>
      <div class="field"><label>Dead-letter queue ARN (empty removes)</label><input name="dlq" value="${escapeHtml(redrive)}"></div>`,
      "Save",
      async data => {
        const filter = String(data.get("filter") || "").trim();
        if (filter) parseObject(filter, "Filter policy");
        const dlq = String(data.get("dlq") || "").trim();
        const values = {
          FilterPolicyScope: String(data.get("scope")),
          FilterPolicy: filter,
          RawMessageDelivery: String(data.get("raw") === "true"),
          RedrivePolicy: dlq ? JSON.stringify({ deadLetterTargetArn: dlq }) : "",
        };
        for (const [AttributeName, AttributeValue] of Object.entries(values)) {
          await sns("SetSubscriptionAttributes", { SubscriptionArn: subscription.SubscriptionArn, AttributeName, AttributeValue });
        }
        context.toast("Subscription configuration updated");
      },
      true,
    );
  }));
}

async function detailPage(context, name) {
  const [topic, diagnostics] = await Promise.all([
    topicDescriptor(name),
    rest("/_stacksim/api/sns/deliveries"),
  ]);
  const topicHealth = diagnostics.filter(item => topic.subscriptions.some(subscription => subscription.SubscriptionArn === item.subscriptionArn));
  context.setChrome("sns", ["SNS", "Topics", name]);
  context.main.innerHTML = `<div class="page-width sns-detail">
    ${pageHeader(name, topic.TopicArn, '<button class="button" data-configure-sns-topic>Configure</button><button class="button" data-create-sns-subscription>Create subscription</button><button class="button primary" data-publish-sns>Publish message</button><button class="button danger" data-delete-sns-topic>Delete</button>')}
    ${topicTabs(name, "details")}
    <div class="sns-detail-grid">
      <section class="card"><div class="card-header"><h2>Topic details</h2></div><div class="card-body"><dl class="key-value">
        <dt>Type</dt><dd>Standard</dd><dt>Owner</dt><dd class="mono">${escapeHtml(topic.Attributes.Owner)}</dd>
        <dt>Confirmed subscriptions</dt><dd>${escapeHtml(topic.Attributes.SubscriptionsConfirmed || "0")}</dd>
        <dt>Signature version</dt><dd>${escapeHtml(topic.Attributes.SignatureVersion)} (installation-local RSA certificate)</dd>
      </dl></div></section>
      <section class="card"><div class="card-header"><h2>Tags <span class="muted">(${Object.keys(topic.Tags).length})</span></h2><button class="button link" data-manage-sns-tags>Manage</button></div>
        <div class="table-wrap">${Object.keys(topic.Tags).length ? `<table><tbody>${Object.entries(topic.Tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : '<div class="card-body muted">No tags configured.</div>'}</div>
      </section>
    </div>
    <section class="card"><div class="card-header"><h2>Subscriptions <span class="muted">(${topic.subscriptions.length})</span></h2><button class="button" data-create-sns-subscription>Create subscription</button></div>
      <div class="table-wrap">${topic.subscriptions.length
        ? `<table class="sns-resource-table"><thead><tr><th>Protocol</th><th>Endpoint</th><th>Filter</th><th>Raw</th><th>Subscription ARN</th><th>Action</th></tr></thead><tbody>${topic.subscriptions.map(subscription => `<tr><td>${escapeHtml(subscription.Protocol)}</td><td>${endpointLink(subscription) ? `<a href="${escapeHtml(endpointLink(subscription))}">${escapeHtml(subscription.Endpoint)}</a>` : escapeHtml(subscription.Endpoint)}</td><td>${escapeHtml(subscription.Attributes.FilterPolicy ? subscription.Attributes.FilterPolicyScope : "None")}</td><td>${escapeHtml(subscription.Attributes.RawMessageDelivery)}</td><td class="mono">${escapeHtml(subscription.SubscriptionArn)}</td><td><button class="button link" data-configure-sns-subscription="${escapeHtml(subscription.SubscriptionArn)}">Configure</button> <button class="button link danger" data-unsubscribe="${escapeHtml(subscription.SubscriptionArn)}">Unsubscribe</button></td></tr>`).join("")}</tbody></table>`
        : emptyState("→", "No subscriptions", "Add an SQS queue or Lambda function endpoint.")}</div>
    </section>
    <section class="card"><div class="card-header"><h2>Payload-safe delivery health</h2><a href="#/sns/topics/${encodeURIComponent(name)}/monitoring">Monitoring</a></div>
      <div class="card-body"><p>${topicHealth.filter(item => item.status === "QUEUED" || item.status === "LEASED").length} pending · ${topicHealth.filter(item => item.status === "DELIVERED").length} delivered · ${topicHealth.filter(item => item.status === "FAILED").length} failed</p>
      <p class="muted">Only redacted endpoint hashes, status, attempts, and bounded error text are available. Payload content is never returned by diagnostics.</p></div>
    </section>
  </div>`;
  bindSubscription(context, topic);
  bindPublish(context, topic);
  bindTags(context, topic);
  bindTopicConfiguration(context, topic);
  bindSubscriptionConfiguration(context, topic);
  document.querySelectorAll("[data-unsubscribe]").forEach(button => button.addEventListener("click", () => {
    context.confirmDeletion(button.dataset.unsubscribe, "Remove this subscription? Already accepted delivery intents keep their immutable destination snapshot.", async () => {
      await sns("Unsubscribe", { SubscriptionArn: button.dataset.unsubscribe });
      context.toast("Subscription removed");
    });
  }));
  document.querySelector("[data-delete-sns-topic]")?.addEventListener("click", () => {
    context.confirmDeletion(name, `Delete topic ${name}? Its subscriptions will be removed. Already accepted delivery intents remain durable.`, async () => {
      await sns("DeleteTopic", { TopicArn: topic.TopicArn });
      context.toast("Topic deleted");
      location.hash = "#/sns/topics";
    });
  });
}

async function monitoringPage(context, name) {
  const [topic, diagnostics] = await Promise.all([
    topicDescriptor(name),
    rest("/_stacksim/api/sns/deliveries"),
  ]);
  const end = new Date();
  const start = new Date(end.getTime() - 3_600_000);
  const definitions = [
    ["published", "Published", "NumberOfMessagesPublished", "Sum"],
    ["size", "Publish size", "PublishSize", "Average"],
    ["delivered", "Delivered", "NumberOfNotificationsDelivered", "Sum"],
    ["failed", "Failed", "NumberOfNotificationsFailed", "Sum"],
    ["filtered", "Filtered", "NumberOfNotificationsFilteredOut", "Sum"],
  ];
  const result = await metrics("GetMetricData", {
    StartTime: start.toISOString(),
    EndTime: end.toISOString(),
    ScanBy: "TimestampAscending",
    MetricDataQueries: definitions.map(([Id, Label, MetricName, Stat]) => ({
      Id,
      Label,
      MetricStat: {
        Metric: { Namespace: "AWS/SNS", MetricName, Dimensions: [{ Name: "TopicName", Value: name }] },
        Period: 60,
        Stat,
      },
    })),
  });
  const series = (result.MetricDataResults ?? []).map(item => ({
    ...item,
    timestamps: item.Timestamps,
    values: item.Values,
    label: item.Label,
  }));
  const subscriptionArns = new Set(topic.subscriptions.map(item => item.SubscriptionArn));
  const health = diagnostics.filter(item => subscriptionArns.has(item.subscriptionArn));
  context.setChrome("sns", ["SNS", "Topics", name, "Monitoring"]);
  context.main.innerHTML = `<div class="page-width sns-detail">
    ${pageHeader("Monitoring", `Locally measured SNS metrics for ${escapeHtml(name)}.`, '<button class="button refresh" data-refresh title="Refresh" aria-label="Refresh monitoring">↻</button><a class="button" href="#/cloudwatch/metrics">View all metrics</a>')}
    ${topicTabs(name, "monitoring")}
    <section class="card"><div class="card-header"><h2>Topic activity</h2><span class="muted">Last hour · 1 minute</span></div><div class="card-body">${metricChart(series, `SNS activity for ${name}`)}</div></section>
    <section class="card"><div class="card-header"><h2>Retained delivery diagnostics</h2><span class="muted">Payload-safe</span></div>
      <div class="table-wrap">${health.length
        ? `<table class="sns-health-table"><thead><tr><th>Status</th><th>Protocol</th><th>Endpoint hash</th><th>Attempts</th><th>Error</th></tr></thead><tbody>${health.map(item => `<tr><td><span class="status ${item.status === "FAILED" ? "error" : item.status === "DELIVERED" ? "" : "inactive"}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.protocol)}</td><td class="mono">${escapeHtml(item.endpoint)}</td><td>${Number(item.attempts ?? 0)}</td><td>${escapeHtml(item.errorCode ? `${item.errorCode}: ${item.errorMessage || ""}` : "—")}</td></tr>`).join("")}</tbody></table>`
        : emptyState("◉", "No retained deliveries", "Publish a message to observe redacted delivery state and SNS metrics.")}</div>
    </section>
  </div>`;
  document.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

async function subscriptionsPage(context) {
  const subscriptions = await listSubscriptions();
  context.setChrome("sns", ["SNS", "Subscriptions"]);
  context.main.innerHTML = `<div class="page-width">
    ${pageHeader("Subscriptions", "Confirmed regional SQS and Lambda subscriptions.")}
    <section class="card"><div class="card-header"><h2>Subscriptions <span class="muted">(${subscriptions.length})</span></h2></div>
      <div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find subscriptions"></label></div>
      <div class="table-wrap">${subscriptions.length
        ? `<table class="sns-resource-table"><thead><tr><th>Topic</th><th>Protocol</th><th>Endpoint</th><th>Subscription ARN</th></tr></thead><tbody>${subscriptions.map(subscription => `<tr data-search-row="${escapeHtml(Object.values(subscription).join(" ").toLowerCase())}"><td><a href="#/sns/topics/${encodeURIComponent(topicName(subscription.TopicArn))}">${escapeHtml(topicName(subscription.TopicArn))}</a></td><td>${escapeHtml(subscription.Protocol)}</td><td>${endpointLink(subscription) ? `<a href="${escapeHtml(endpointLink(subscription))}">${escapeHtml(subscription.Endpoint)}</a>` : escapeHtml(subscription.Endpoint)}</td><td class="mono">${escapeHtml(subscription.SubscriptionArn)}</td></tr>`).join("")}</tbody></table>`
        : emptyState("→", "No subscriptions", "Open a topic to subscribe an SQS queue or Lambda function.")}</div>
    </section>
  </div>`;
  context.bindTableFilter();
}

export async function routeSns(parts, context) {
  if (parts[0] !== metadata.key) return false;
  const render = async pending => {
    const result = await pending;
    decorateSnsPanelHelp(context.main);
    return result;
  };
  if (parts.length === 1) return render(overview(context));
  if (parts[1] === "topics" && parts.length === 2) return render(topicsPage(context));
  if (parts[1] === "subscriptions" && parts.length === 2) return render(subscriptionsPage(context));
  if (parts[1] === "topics" && parts[2] && parts.length === 3) return render(detailPage(context, parts[2]));
  if (parts[1] === "topics" && parts[2] && parts[3] === "monitoring" && parts.length === 4) return render(monitoringPage(context, parts[2]));
  return context.notFound(parts);
}
