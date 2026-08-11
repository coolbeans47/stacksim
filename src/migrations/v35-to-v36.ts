import type { SimState } from "../types.js";

export function migrateV35ToV36(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.cloudwatch ??= { alarms: {}, compositeAlarms: {}, logAlarms: {}, alarmMuteRules: {}, anomalyDetectors: {}, metricStreams: {}, insightRules: {}, alarmHistory: [], eventBridgeOutbox: [] };
    region.cloudwatch.compositeAlarms ??= {};
  }
  state.schemaVersion = 36;
  return state;
}
