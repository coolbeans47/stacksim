import { cfnResource, isIntrinsic, isObject, passthroughAttributes, ref, resourceError, type JsonObject } from "./common.js";
import { truthy } from "./events/common.js";

const CORS_TYPES: Readonly<Record<string, { readonly name: string; readonly valid: (value: unknown) => boolean }>> = {
  AllowOrigins: { name: "list", valid: Array.isArray },
  AllowMethods: { name: "list", valid: Array.isArray },
  AllowCredentials: { name: "bool", valid: value => typeof value === "boolean" },
  AllowHeaders: { name: "list", valid: Array.isArray },
  ExposeHeaders: { name: "list", valid: Array.isArray },
  // Python's bool is an int, so MaxAge accepts booleans too.
  MaxAge: { name: "int", valid: value => typeof value === "boolean" || Number.isInteger(value) },
};

/** isIntrinsic without type narrowing, for values that are maps either way. */
const intrinsic = (value: unknown): boolean => isIntrinsic(value);

function validate(logicalId: string, config: JsonObject): void {
  if (intrinsic(config)) return;
  const authType = config.AuthType;
  if (!(authType && isIntrinsic(authType)) && (authType !== "AWS_IAM" && authType !== "NONE")) {
    throw resourceError(logicalId, "AuthType is required to configure function property `FunctionUrlConfig`. Please provide either AWS_IAM or NONE.");
  }
  const cors = config.Cors;
  if (!truthy(cors) || isIntrinsic(cors)) return;
  if (!isObject(cors)) throw resourceError(logicalId, "Property 'FunctionUrlConfig.Cors' should be a map.");
  for (const [name, value] of Object.entries(cors)) {
    const type = CORS_TYPES[name];
    if (!type) throw resourceError(logicalId, `${name} is not a valid property for configuring Cors.`);
    if (!isIntrinsic(value) && !type.valid(value)) throw resourceError(logicalId, `${name} must be of type ${type.name}.`);
  }
}

/**
 * FunctionUrlConfig → `<F>Url`. AuthType NONE adds the two public permissions
 * SAM generates: lambda:InvokeFunctionUrl, and lambda:InvokeFunction limited
 * to calls through the function URL. `target` is the function, or its alias
 * when AutoPublishAlias is set.
 */
export function translateFunctionUrl(logicalId: string, resource: JsonObject, config: unknown, target: JsonObject = ref(logicalId)): Record<string, JsonObject> {
  if (!isObject(config)) throw resourceError(logicalId, "Property 'FunctionUrlConfig' should be a map.");
  validate(logicalId, config);
  const attributes = passthroughAttributes(resource);
  const cors = config.Cors;
  const output: Record<string, JsonObject> = {
    [`${logicalId}Url`]: cfnResource("AWS::Lambda::Url", {
      TargetFunctionArn: target,
      AuthType: config.AuthType,
      Cors: truthy(cors) ? cors : undefined,
      InvokeMode: config.InvokeMode,
    }, attributes),
  };
  if (config.AuthType !== "NONE" || intrinsic(config)) return output;
  output[`${logicalId}UrlPublicPermissions`] = cfnResource("AWS::Lambda::Permission", {
    Action: "lambda:InvokeFunctionUrl",
    FunctionName: target,
    Principal: "*",
    FunctionUrlAuthType: "NONE",
  }, attributes);
  output[`${logicalId}URLInvokeAllowPublicAccess`] = cfnResource("AWS::Lambda::Permission", {
    Action: "lambda:InvokeFunction",
    Principal: "*",
    FunctionName: target,
    InvokedViaFunctionUrl: true,
  }, attributes);
  return output;
}
