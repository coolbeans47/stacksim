import type { SimState } from "../types.js";

export function migrateV3ToV4(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) for (const api of Object.values(region.apis ?? {})) {
    api.binaryMediaTypes ??= [];
    api.gatewayResponses ??= {};
    for (const deployment of Object.values(api.deployments ?? {})) if (deployment.snapshot) {
      deployment.snapshot.binaryMediaTypes ??= structuredClone(api.binaryMediaTypes);
      deployment.snapshot.gatewayResponses ??= structuredClone(api.gatewayResponses);
      if (deployment.snapshot.minimumCompressionSize === undefined && api.minimumCompressionSize !== undefined) deployment.snapshot.minimumCompressionSize = api.minimumCompressionSize;
    }
  }
  state.schemaVersion = 4;
  return state;
}
