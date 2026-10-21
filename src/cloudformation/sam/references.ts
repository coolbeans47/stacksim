import { isObject } from "./common.js";

type References = ReadonlyMap<string, ReadonlyMap<string, string>>;

function resolve(references: References, logicalId: string, property: string): string | undefined {
  return references.get(logicalId)?.get(property);
}

/**
 * Resolve SAM resource references such as `MyApi.Stage` and `MyApi.Deployment`
 * inside Ref, Fn::GetAtt, and Fn::Sub, as SAM does after translation.
 */
export function resolveSamReferences(value: unknown, references: References): unknown {
  if (Array.isArray(value)) return value.map(item => resolveSamReferences(item, references));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "Ref" && typeof value.Ref === "string" && value.Ref.includes(".")) {
    const [logicalId, property, ...rest] = value.Ref.split(".");
    const target = rest.length === 0 ? resolve(references, logicalId, property) : undefined;
    if (target) return { Ref: target };
  }
  if (keys.length === 1 && keys[0] === "Fn::GetAtt" && Array.isArray(value["Fn::GetAtt"]) && value["Fn::GetAtt"].length >= 2 && value["Fn::GetAtt"].every(item => typeof item === "string")) {
    const [logicalId, property, ...rest] = (value["Fn::GetAtt"] as string[]).join(".").split(".");
    const target = resolve(references, logicalId, property);
    if (target) return { "Fn::GetAtt": [target, ...rest] };
  }
  if (keys.length === 1 && keys[0] === "Fn::Sub") {
    const replace = (text: string) => text.replace(/\$\{([^}!]+)\}/g, (match, inner: string) => {
      const [logicalId, property, ...rest] = inner.split(".");
      const target = property === undefined ? undefined : resolve(references, logicalId, property);
      return target ? `\${${[target, ...rest].join(".")}}` : match;
    });
    const sub = value["Fn::Sub"];
    if (typeof sub === "string") return { "Fn::Sub": replace(sub) };
    if (Array.isArray(sub) && typeof sub[0] === "string") return { "Fn::Sub": [replace(sub[0]), ...sub.slice(1).map(item => resolveSamReferences(item, references))] };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSamReferences(item, references)]));
}
