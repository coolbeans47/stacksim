import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import {
  createCloudWatchAnomalyDetectorProvider,
  createCloudWatchInsightRuleProvider,
} from "../src/cloudformation/providers/cloudwatch-cfn10.js";
import { createEventRuleProvider } from "../src/cloudformation/providers/eventbridge-resources.js";
import { createLogDestinationProvider } from "../src/cloudformation/providers/logs-cfn10.js";
import { createLogGroupProvider } from "../src/cloudformation/providers/logs-log-group.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/cfn09-cfn10-lifecycle/stack-id`;
const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId,
    logicalId,
    operationId: `operation-${logicalId}`,
    resourceOperationId: `resource-operation-${logicalId}`,
    idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

test("CFN-09 and CFN-10 providers close replacement, compensation, retry, and state-update lifecycle gaps", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn09-cfn10-lifecycle-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  try {
    await simulator.start();

    await t.test("AnomalyDetector deletes first only for a MetricCharacteristics-only replacement", () => {
      const provider = createCloudWatchAnomalyDetectorProvider(simulator.metrics);
      const providerContext = context("AnomalyDetector");
      const initial = provider.canonicalize({
        MetricName: "Latency",
        Namespace: "AWS/Sim",
        Stat: "Average",
      }, providerContext);
      const characteristicsOnly = provider.canonicalize({
        MetricName: "Latency",
        Namespace: "AWS/Sim",
        Stat: "Average",
        MetricCharacteristics: { PeriodicSpikes: true },
      }, providerContext);
      const identityOnly = provider.canonicalize({
        MetricName: "Errors",
        Namespace: "AWS/Sim",
        Stat: "Average",
      }, providerContext);
      const identityAndCharacteristics = provider.canonicalize({
        MetricName: "Errors",
        Namespace: "AWS/Sim",
        Stat: "Average",
        MetricCharacteristics: { PeriodicSpikes: true },
      }, providerContext);

      const characteristicPlan = provider.plan(initial, characteristicsOnly, providerContext);
      assert.equal(characteristicPlan.action, "REPLACE");
      assert.deepEqual(characteristicPlan.replacementProperties, ["MetricCharacteristics"]);
      assert.equal(characteristicPlan.replacementOrder, "DELETE_BEFORE_CREATE");

      const identityPlan = provider.plan(initial, identityOnly, providerContext);
      assert.equal(identityPlan.action, "REPLACE");
      assert.deepEqual(identityPlan.replacementProperties, ["SingleMetricAnomalyDetector"]);
      assert.equal(identityPlan.replacementOrder, "CREATE_BEFORE_DELETE");

      const combinedPlan = provider.plan(initial, identityAndCharacteristics, providerContext);
      assert.equal(combinedPlan.action, "REPLACE");
      assert.deepEqual(combinedPlan.replacementProperties, ["MetricCharacteristics", "SingleMetricAnomalyDetector"]);
      assert.equal(combinedPlan.replacementOrder, "CREATE_BEFORE_DELETE");
    });

    await t.test("EventBridge rule create compensates a partial PutTargets failure", async () => {
      const provider = createEventRuleProvider(simulator.eventbridge);
      const providerContext = context("CompensatedRule");
      const functionArn = `arn:aws:lambda:${region}:${accountId}:function:event-target`;
      const desired = provider.canonicalize({
        Name: "cfn-compensated-rule",
        EventPattern: { source: ["orders"] },
        Targets: [
          { Arn: functionArn, Id: "accepted" },
          {
            Arn: functionArn,
            Id: "rejected",
            InputTransformer: {
              InputPathsMap: { id: "$.detail.id" },
              InputTemplate: "{\"missing\":<undefined-variable>}",
            },
          },
        ],
      }, providerContext);

      const created = await provider.create(desired, providerContext);
      assert.equal(created.status, "FAILED");
      assert.equal((created as { errorCode?: string }).errorCode, "ValidationException");

      await assert.rejects(
        simulator.eventbridge.DescribeRule({ Name: desired.Name, EventBusName: desired.EventBusName }),
        error => (error as { code?: string }).code === "ResourceNotFoundException",
      );
      const listed = await simulator.eventbridge.ListRules({ EventBusName: desired.EventBusName, Limit: 100 });
      assert.equal(listed.Rules?.some((rule: { Name?: string }) => rule.Name === desired.Name), false);
    });

    await t.test("Logs destination policy removal is durable in the authoritative model", async () => {
      const provider = createLogDestinationProvider(simulator.logs);
      const providerContext = context("LogsDestination");
      const initial = provider.canonicalize({
        DestinationName: "cfn-destination",
        DestinationPolicy: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
        RoleArn: `arn:aws:iam::${accountId}:role/logs-destination`,
        Tags: [{ Key: "service", Value: "orders" }],
        TargetArn: `arn:aws:kinesis:${region}:${accountId}:stream/orders`,
      }, providerContext);
      const desired = provider.canonicalize({
        DestinationName: "cfn-destination",
        RoleArn: `arn:aws:iam::${accountId}:role/logs-destination`,
        Tags: [{ Key: "service", Value: "orders" }],
        TargetArn: `arn:aws:kinesis:${region}:${accountId}:stream/orders`,
      }, providerContext);

      assert.equal((await provider.create(initial, providerContext)).status, "SUCCESS");
      const updated = await provider.update(initial.DestinationName, initial, desired, providerContext);
      assert.equal(updated.status, "SUCCESS");

      const read = await provider.read(initial.DestinationName, providerContext);
      assert.equal(read.status, "SUCCESS");
      if (read.status === "SUCCESS") assert.equal(Object.hasOwn(read.model.properties, "DestinationPolicy"), false);
      const authoritative = (await simulator.logs.DescribeDestinations({ DestinationNamePrefix: initial.DestinationName })).destinations
        ?.find((destination: { destinationName?: string }) => destination.destinationName === initial.DestinationName);
      assert.ok(authoritative);
      assert.equal(Object.hasOwn(authoritative, "accessPolicy"), false);
    });

    await t.test("LogGroup create retry reconciles retention on an existing owned group", async () => {
      const provider = createLogGroupProvider(simulator.logs);
      const providerContext = context("RetryLogGroup");
      const desired = provider.canonicalize({
        LogGroupName: "/stacksim/cfn/retry-log-group",
        RetentionInDays: 30,
        Tags: [{ Key: "service", Value: "orders" }],
      }, providerContext);

      assert.equal((await provider.create(desired, providerContext)).status, "SUCCESS");
      await simulator.logs.DeleteRetentionPolicy({ logGroupName: desired.LogGroupName });
      const retried = await provider.create(desired, providerContext);
      assert.equal(retried.status, "SUCCESS");

      const authoritative = (await simulator.logs.DescribeLogGroups({ logGroupNamePrefix: desired.LogGroupName, limit: 50 })).logGroups
        .find((group: { logGroupName?: string }) => group.logGroupName === desired.LogGroupName);
      assert.equal(authoritative?.retentionInDays, 30);
    });

    await t.test("InsightRule state-only update changes the backed RuleState", async () => {
      const provider = createCloudWatchInsightRuleProvider(simulator.metrics);
      const providerContext = context("InsightRule");
      const ruleBody = JSON.stringify({
        Schema: { Name: "CloudWatchLogRule", Version: 1 },
        AggregateOn: "Count",
        Contribution: { Keys: ["$.service"], Filters: [] },
        LogFormat: "JSON",
        LogGroupNames: ["/stacksim/orders"],
      });
      const initial = provider.canonicalize({
        RuleBody: ruleBody,
        RuleName: "cfn-insight-rule",
        RuleState: "ENABLED",
        Tags: [{ Key: "service", Value: "orders" }],
      }, providerContext);
      const desired = provider.canonicalize({
        RuleBody: ruleBody,
        RuleName: "cfn-insight-rule",
        RuleState: "DISABLED",
        Tags: [{ Key: "service", Value: "orders" }],
      }, providerContext);

      assert.equal((await provider.create(initial, providerContext)).status, "SUCCESS");
      const updated = await provider.update(initial.RuleName, initial, desired, providerContext);
      assert.equal(updated.status, "SUCCESS");

      const read = await provider.read(initial.RuleName, providerContext);
      assert.equal(read.status, "SUCCESS");
      if (read.status === "SUCCESS") assert.equal(read.model.properties.RuleState, "DISABLED");
      const authoritative = (await simulator.metrics.insightRules.DescribeInsightRules({ MaxResults: 500 })).InsightRules
        ?.find((rule: { Name?: string }) => rule.Name === initial.RuleName);
      assert.equal(authoritative?.State, "DISABLED");
    });
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
