import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudWatchClient,
  DeleteAlarmMuteRuleCommand,
  DescribeAlarmContributorsCommand,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  GetAlarmMuteRuleCommand,
  ListAlarmMuteRulesCommand,
  ListTagsForResourceCommand,
  PutAlarmMuteRuleCommand,
  PutLogAlarmCommand,
  TagResourceCommand,
} from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function connect(simulator: StackSim) {
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials };
  return { cloudwatch: new CloudWatchClient(options), logs: new CloudWatchLogsClient(options) };
}

test("CloudWatch log alarms evaluate contributors, emit contributor history, honor mute rules, support XML, and persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-log-alarm-"));
  const clock = new TestClock(Date.parse("2026-07-17T12:01:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"});
  let clients: ReturnType<typeof connect> | undefined;
  try {
    await simulator.start(); clients = connect(simulator);
    await clients.logs.send(new CreateLogGroupCommand({ logGroupName: "/learning/orders" }));
    await clients.logs.send(new CreateLogStreamCommand({ logGroupName: "/learning/orders", logStreamName: "application" }));
    await clients.logs.send(new PutLogEventsCommand({ logGroupName: "/learning/orders", logStreamName: "application", logEvents: [
      { timestamp: Date.parse("2026-07-17T12:00:10Z"), message: '{"level":"ERROR","host":"api-a","requestId":"one"}' },
      { timestamp: Date.parse("2026-07-17T12:00:20Z"), message: '{"level":"ERROR","host":"api-a","requestId":"two"}' },
      { timestamp: Date.parse("2026-07-17T12:00:30Z"), message: '{"level":"ERROR","host":"api-b","requestId":"three"}' },
      { timestamp: Date.parse("2026-07-17T12:00:40Z"), message: '{"level":"INFO","host":"api-c","requestId":"four"}' },
    ] }));

    const action = "arn:aws:sns:eu-west-1:000000000000:log-alarm-notifications";
    await clients.cloudwatch.send(new PutLogAlarmCommand({
      AlarmName: "order-errors-by-host",
      AlarmDescription: "Error contributors from the orders log group",
      ScheduledQueryConfiguration: {
        QueryString: "filter level = 'ERROR' | fields @timestamp, @message, host",
        LogGroupIdentifiers: ["/learning/orders"],
        ScheduledQueryRoleARN: "arn:aws:iam::000000000000:role/cloudwatch-log-query",
        ScheduleConfiguration: { ScheduleExpression: "rate(1 minute)", StartTimeOffset: 60, EndTimeOffset: 0 },
        AggregationExpression: "count(*) as errors by host | sort errors desc",
        Tags: [{ Key: "query", Value: "orders" }],
      },
      QueryResultsToEvaluate: 1,
      QueryResultsToAlarm: 1,
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "missing",
      AlarmActions: [action],
      OKActions: [action],
      ActionLogLineCount: 2,
      ActionLogLineRoleArn: "arn:aws:iam::000000000000:role/cloudwatch-log-lines",
      Tags: [{ Key: "team", Value: "learning" }],
    }));
    await clients.cloudwatch.send(new PutAlarmMuteRuleCommand({ Name: "active-maintenance", Description: "Mute the first contributor transition", Rule: { Schedule: { Expression: "at(2026-07-17T12:01)", Duration: "PT10M", Timezone: "UTC" } }, MuteTargets: { AlarmNames: ["order-errors-by-host"] }, Tags: [{ Key: "owner", Value: "platform" }] }));
    await clients.cloudwatch.send(new PutAlarmMuteRuleCommand({ Name: "nightly-maintenance", Rule: { Schedule: { Expression: "cron(0 2 * * *)", Duration: "PT30M", Timezone: "Europe/London" } }, MuteTargets: { AlarmNames: [] } }));
    const firstMutePage = await clients.cloudwatch.send(new ListAlarmMuteRulesCommand({ MaxRecords: 1 })); assert.equal(firstMutePage.AlarmMuteRuleSummaries?.length, 1); assert.ok(firstMutePage.NextToken); const secondMutePage = await clients.cloudwatch.send(new ListAlarmMuteRulesCommand({ MaxRecords: 1, NextToken: firstMutePage.NextToken })); assert.equal(secondMutePage.AlarmMuteRuleSummaries?.length, 1);
    const activeRule = await clients.cloudwatch.send(new GetAlarmMuteRuleCommand({ AlarmMuteRuleName: "active-maintenance" })); assert.equal(activeRule.Status, "ACTIVE"); assert.equal(activeRule.MuteType, "ONE_TIME"); assert.deepEqual(activeRule.MuteTargets?.AlarmNames, ["order-errors-by-host"]);
    await clients.cloudwatch.send(new TagResourceCommand({ ResourceARN: activeRule.AlarmMuteRuleArn!, Tags: [{ Key: "change", Value: "cw08c" }] })); const muteTags = await clients.cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: activeRule.AlarmMuteRuleArn! })); assert.deepEqual(muteTags.Tags, [{ Key: "change", Value: "cw08c" }, { Key: "owner", Value: "platform" }]);

    await simulator.metrics.evaluateAlarmsNow(clock.now());
    const described = await clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["order-errors-by-host"], AlarmTypes: ["LogAlarm"] })); const alarm = described.LogAlarms?.[0]; assert.equal(alarm?.StateValue, "ALARM"); assert.equal(alarm?.EvaluationState, undefined); assert.equal(alarm?.ScheduledQueryConfiguration?.AggregationExpression, "count(*) as errors by host | sort errors desc"); assert.match(alarm?.ScheduledQueryConfiguration?.QueryARN ?? "", /scheduled-query:order-errors-by-host$/);
    const contributorResponse = await clients.cloudwatch.send(new DescribeAlarmContributorsCommand({ AlarmName: "order-errors-by-host" })); const contributors = contributorResponse.AlarmContributors ?? []; assert.equal(contributors.length, 2); assert.deepEqual(contributors.map(item => item.ContributorAttributes?.host).sort(), ["api-a", "api-b"]); assert.ok(contributors.every(item => item.ContributorId?.length === 16));
    const contributorId = contributors[0].ContributorId!; const stateHistory = await clients.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "order-errors-by-host", AlarmTypes: ["LogAlarm"], AlarmContributorId: contributorId, HistoryItemType: "AlarmContributorStateUpdate" })); assert.equal(stateHistory.AlarmHistoryItems?.length, 1); assert.equal(stateHistory.AlarmHistoryItems?.[0].AlarmType, "LogAlarm"); assert.equal(stateHistory.AlarmHistoryItems?.[0].AlarmContributorAttributes?.host, contributors[0].ContributorAttributes?.host);
    let actionHistory = await clients.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "order-errors-by-host", AlarmTypes: ["LogAlarm"], HistoryItemType: "AlarmContributorAction" })); assert.equal(actionHistory.AlarmHistoryItems?.length, 2); assert.ok(actionHistory.AlarmHistoryItems?.every(item => JSON.parse(item.HistoryData ?? "{}").status === "Suppressed"));

    await clients.cloudwatch.send(new DeleteAlarmMuteRuleCommand({ AlarmMuteRuleName: "active-maintenance" })); actionHistory = await clients.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "order-errors-by-host", AlarmTypes: ["LogAlarm"], HistoryItemType: "AlarmContributorAction" })); assert.ok((actionHistory.AlarmHistoryItems?.length ?? 0) >= 4, "deleting an active rule replays actions for ALARM contributors and may record an immediate durable retry"); assert.ok((actionHistory.AlarmHistoryItems?.filter(item => ["Queued", "Retrying"].includes(JSON.parse(item.HistoryData ?? "{}").status)).length ?? 0) >= 2); await clients.cloudwatch.send(new DeleteAlarmMuteRuleCommand({ AlarmMuteRuleName: "active-maintenance" }));

    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "ListAlarmMuteRules", Version: "2010-08-01", MaxRecords: "10" }) }); const xml = await raw.text(); assert.equal(raw.status, 200); assert.match(xml, /<ListAlarmMuteRulesResponse/); assert.match(xml, /<AlarmMuteRuleArn>arn:aws:cloudwatch:eu-west-1:000000000000:alarm-mute-rule:nightly-maintenance<\/AlarmMuteRuleArn>/);

    clients.cloudwatch.destroy(); clients.logs.destroy(); clients = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); clients = connect(simulator); const afterRestart = await clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["order-errors-by-host"], AlarmTypes: ["LogAlarm"] })); assert.equal(afterRestart.LogAlarms?.[0].StateValue, "ALARM"); assert.equal((await clients.cloudwatch.send(new GetAlarmMuteRuleCommand({ AlarmMuteRuleName: "nightly-maintenance" }))).MuteType, "RECURRING"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally {
    clients?.cloudwatch.destroy(); clients?.logs.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
