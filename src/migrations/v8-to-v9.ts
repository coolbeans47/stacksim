import type { DynamoStreamDescriptorState, SimState } from "../types.js";

function sequence(value: number): string { return String(value).padStart(21, "0"); }

export function migrateV8ToV9(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.dynamodbStreams ??= {};
    for (const table of Object.values(region.tables ?? {}) as any[]) {
      table.streamSequence ??= 0;
      if (table.streamSpecification?.StreamEnabled && table.latestStreamArn && !region.dynamodbStreams[table.latestStreamArn]) {
        const label = table.latestStreamArn.split("/stream/")[1] ?? new Date(table.createdAt).toISOString().replace(/Z$/, "");
        const records = structuredClone(table.streamRecords ?? []);
        const maximum = records.reduce((value: number, record: any) => Math.max(value, Number(record?.dynamodb?.SequenceNumber ?? 0)), Number(table.streamSequence ?? 0));
        table.streamSequence = maximum;
        const createdAt = Number.isFinite(Date.parse(`${label}Z`)) ? Date.parse(`${label}Z`) : table.createdAt;
        const descriptor: DynamoStreamDescriptorState = {
          streamArn: table.latestStreamArn,
          streamLabel: label,
          tableName: table.name,
          tableArn: table.arn,
          keySchema: structuredClone(table.keySchema),
          streamViewType: table.streamSpecification.StreamViewType ?? "KEYS_ONLY",
          streamStatus: "ENABLED",
          createdAt,
          shardId: `shardId-${String(Math.floor(createdAt / 1000)).padStart(20, "0")}-${String(table.id).slice(0, 8).padEnd(8, "0")}`,
          startingSequenceNumber: records[0]?.dynamodb?.SequenceNumber ?? sequence(1),
          ...(records.length ? { lastSequenceNumber: records.at(-1)?.dynamodb?.SequenceNumber } : {}),
          ...(records.length ? { legacyRecords: records } : {}),
        };
        region.dynamodbStreams[descriptor.streamArn] = descriptor;
      }
      delete table.streamRecords;
    }
  }
  state.schemaVersion = 9;
  return state;
}
