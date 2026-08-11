import { createHash } from "node:crypto";
import type { SimState } from "../types.js";

function stableId(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }

/** DUG-05 separates immutable admitted Scheduler occurrences from mutable schedules. */
export function migrateV73ToV74(input: SimState): SimState {
  const state = structuredClone(input) as any;
  for (const [accountId, account] of Object.entries<any>(state.accounts ?? {})) {
    for (const [regionName, region] of Object.entries<any>(account.regions ?? {})) {
      region.eventScheduleOccurrences ??= {};
      for (const schedule of Object.values<any>(region.eventSchedules ?? {})) {
        schedule.generation ??= stableId(`${schedule.arn}:generation:${schedule.creationDate}`);
        const delivery = schedule.pendingDelivery;
        if (!delivery) continue;
        const eventId = stableId(`${schedule.arn}:${delivery.scheduledAt}:${delivery.invocationAt}`);
        const payload = schedule.target.input ?? JSON.stringify({ version: "1", id: eventId, "detail-type": "Scheduled Event", source: "aws.scheduler", account: accountId, time: new Date(delivery.scheduledAt).toISOString(), region: regionName, resources: [schedule.arn], detail: { attempt: delivery.attempts } });
        region.eventScheduleOccurrences[eventId] ??= {
          occurrenceId: eventId, eventId, scheduleArn: schedule.arn, scheduleName: schedule.name, groupName: schedule.groupName,
          scheduleGeneration: schedule.generation, scheduledAt: delivery.scheduledAt, invocationAt: delivery.invocationAt,
          admittedAt: delivery.invocationAt, payload, target: structuredClone(schedule.target), flexibleTimeWindow: structuredClone(schedule.flexibleTimeWindow),
          actionAfterCompletion: schedule.actionAfterCompletion, lineage: [schedule.arn], attempts: delivery.attempts,
          nextAttemptAt: delivery.nextAttemptAt, status: delivery.status, ...(delivery.leaseId ? { leaseId: delivery.leaseId } : {}),
          ...(delivery.leaseUntil ? { leaseUntil: delivery.leaseUntil } : {}), ...(delivery.lastError ? { lastError: delivery.lastError } : {}),
        };
        delete schedule.pendingDelivery;
      }
    }
  }
  state.schemaVersion = 74;
  return state as SimState;
}
