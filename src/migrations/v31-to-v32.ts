import type { SimState } from "../types.js";

export function migrateV31ToV32(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.apiGatewayVpcLinks ??= {};
    region.apiGatewayClientCertificates ??= {};
    for (const api of Object.values(region.apis ?? {})) {
      api.documentationParts ??= {};
      api.documentationVersions ??= {};
      for (const resource of Object.values(api.resources ?? {})) for (const integration of Object.values(resource.integrations ?? {})) integration.connectionType ??= "INTERNET";
      for (const deployment of Object.values(api.deployments ?? {})) for (const resource of Object.values(deployment.snapshot?.resources ?? {})) for (const integration of Object.values(resource.integrations ?? {})) integration.connectionType ??= "INTERNET";
    }
  }
  state.schemaVersion = 32;
  return state;
}
