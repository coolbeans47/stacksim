import type { SimState } from "../types.js";

export function migrateV4ToV5(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    const previous = region.cloudwatch as any;
    region.cloudwatch = {
      alarms: previous?.alarms && typeof previous.alarms === "object" ? previous.alarms : {},
      compositeAlarms: {},
      logAlarms: {},
      alarmMuteRules: {},
      anomalyDetectors: {},
      metricStreams: {},
      insightRules: {},
      alarmHistory: Array.isArray(previous?.alarmHistory) ? previous.alarmHistory : [],
      eventBridgeOutbox: [],
    };
  }
  state.schemaVersion = 5;
  return state;
}
