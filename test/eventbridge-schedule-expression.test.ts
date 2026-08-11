import assert from "node:assert/strict";
import { test } from "node:test";
import { nextScheduleOccurrence, parseScheduleExpression, validateScheduleTimezone } from "../src/eventbridge/schedule-expression.js";

test("Scheduler expressions validate AWS at/rate/cron grammar and special calendar fields", () => {
  assert.equal(parseScheduleExpression("rate(1 minute)").kind, "rate");
  assert.equal(parseScheduleExpression("at(2026-07-27T09:30:00)").kind, "at");
  assert.equal(parseScheduleExpression("cron(0 9 ? * MON-FRI 2026)").kind, "cron");
  assert.equal(parseScheduleExpression("cron(0 9 LW * ? 2026)").kind, "cron");
  assert.throws(() => parseScheduleExpression("rate(1 minutes)"), /invalid rate/);
  assert.throws(() => parseScheduleExpression("cron(0 9 1 * MON 2026)"), /Exactly one/);
  assert.throws(() => parseScheduleExpression("cron(0 9 ? * ? 2026)"), /Exactly one/);
  assert.equal(validateScheduleTimezone("Europe/London"), "Europe/London");
  assert.throws(() => validateScheduleTimezone("Mars/Olympus"), /not a valid IANA/);
});

test("IANA schedules skip spring gaps and commit only one fall overlap occurrence", () => {
  const springGap = nextScheduleOccurrence({
    expression: "at(2026-03-29T01:30:00)",
    timezone: "Europe/London",
    after: Date.parse("2026-03-28T00:00:00Z"),
    anchor: 0,
  });
  assert.equal(springGap, undefined);

  const expression = "cron(30 1 ? 10 SUN 2026)";
  const firstOverlap = nextScheduleOccurrence({
    expression,
    timezone: "Europe/London",
    after: Date.parse("2026-10-25T00:00:00Z"),
    anchor: 0,
  });
  assert.equal(firstOverlap?.at, Date.parse("2026-10-25T00:30:00Z"));
  const afterCommit = nextScheduleOccurrence({
    expression,
    timezone: "Europe/London",
    after: firstOverlap!.at,
    anchor: 0,
    endDate: Date.parse("2026-10-25T02:00:00Z"),
    lastLocalKey: firstOverlap!.localKey,
  });
  assert.equal(afterCommit, undefined);
});

test("rate schedules use StartDate as their recurrence anchor", () => {
  const startDate = Date.parse("2026-07-27T09:03:00Z");
  const occurrence = nextScheduleOccurrence({
    expression: "rate(5 minutes)",
    timezone: "UTC",
    after: Date.parse("2026-07-27T09:00:00Z"),
    anchor: startDate,
    startDate,
    rateFirstAtAnchor: true,
  });
  assert.equal(occurrence?.at, Date.parse("2026-07-27T09:03:00Z"));
});
