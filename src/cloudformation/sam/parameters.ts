import { isObject, type JsonObject } from "./common.js";

/**
 * SAM resolves template parameters in a few properties (for example Tracing
 * and BinaryMediaTypes). Values are the supplied parameters, then parameter
 * defaults, then the pseudo parameters SAM knows at transform time.
 */
export function samParameterValues(template: JsonObject, supplied: Readonly<Record<string, string>> | undefined, region: string, partition: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (isObject(template.Parameters)) {
    for (const [name, declaration] of Object.entries(template.Parameters)) {
      if (isObject(declaration) && declaration.Default !== undefined) values[name] = declaration.Default;
    }
  }
  for (const [name, value] of Object.entries(supplied ?? {})) values[name] = value;
  values["AWS::Region"] = region;
  values["AWS::Partition"] = partition;
  return values;
}

/** Replace `Ref` to known parameters and `${Parameter}` in `Fn::Sub` strings. */
export function resolveParameterRefs(value: unknown, parameters: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveParameterRefs(item, parameters));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "Ref" && typeof value.Ref === "string" && Object.hasOwn(parameters, value.Ref)) return parameters[value.Ref];
  if (keys.length === 1 && keys[0] === "Fn::Sub") {
    const sub = value["Fn::Sub"];
    const replace = (text: string, shadowed: ReadonlySet<string>) => text.replace(/\$\{([^}!]+)\}/g, (match, name: string) => !shadowed.has(name) && Object.hasOwn(parameters, name) ? String(parameters[name]) : match);
    if (typeof sub === "string") return { "Fn::Sub": replace(sub, new Set()) };
    if (Array.isArray(sub) && typeof sub[0] === "string") {
      const variables = isObject(sub[1]) ? sub[1] : {};
      return { "Fn::Sub": [replace(sub[0], new Set(Object.keys(variables))), resolveParameterRefs(variables, parameters)] };
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveParameterRefs(item, parameters)]));
}
