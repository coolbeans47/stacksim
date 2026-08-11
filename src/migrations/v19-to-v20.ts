import type { LambdaExecutableConfigurationState, SimState } from "../types.js";

function defaults(functionName: string): LambdaExecutableConfigurationState {
  return {
    packageType: "Zip",
    architectures: ["x86_64"],
    ephemeralStorageSize: 512,
    loggingConfig: { logFormat: "Text", logGroup: `/aws/lambda/${functionName}` },
    tracingMode: "PassThrough",
    fileSystemConfigs: [],
    vpcConfig: { subnetIds: [], securityGroupIds: [], ipv6AllowedForDualStack: false },
    runtimeManagementConfig: { updateRuntimeOn: "Auto" },
  };
}

export function migrateV19ToV20(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.lambdaCodeSigningConfigs ??= {};
      for (const fn of Object.values(region.functions ?? {})) {
        Object.assign(fn, defaults(fn.functionName), fn);
        fn.recursiveLoop ??= "Terminate";
        for (const version of Object.values(fn.versions ?? {})) Object.assign(version, defaults(fn.functionName), version);
      }
    }
  }
  state.schemaVersion = 20;
  return state;
}
