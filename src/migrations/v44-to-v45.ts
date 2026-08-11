import type { SimState } from "../types.js";

export function migrateV44ToV45(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      (region as any).rdsDbParameterGroups ??= {};
      for (const instance of Object.values((region as any).rdsDbInstances ?? {}) as any[]) {
        instance.dbParameterGroupName ??= "default.mysql8.0";
        instance.parameterApplyStatus ??= "in-sync";
        instance.appliedParameters ??= { max_connections: "100", wait_timeout: "28800", max_allowed_packet: "16777216", innodb_flush_log_at_trx_commit: "1", collation_server: "utf8mb4_unicode_ci" };
      }
    }
  }
  state.schemaVersion = 45;
  return state;
}
