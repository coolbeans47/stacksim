import models from "../../docs/opensearch/models.json" with { type: "json" };
import capabilities from "../../docs/opensearch-capabilities.json" with { type: "json" };
import { AwsError } from "../errors.js";
import type { OperationRoute } from "./protocol.js";
import { ENGINE_VERSION } from "./validation.js";

/** The legacy protocol is a facade, never a second domain catalog or engine. */
export const LEGACY_ACTIONS: Record<string, string> = capabilities.legacyActions;

export function modernRoute(route: OperationRoute): OperationRoute {
  if (route.family !== "es") return route;
  const operation = Object.hasOwn(LEGACY_ACTIONS, route.operation) && LEGACY_ACTIONS[route.operation];
  if (!operation) throw new AwsError("ValidationException", `${route.operation} is not implemented by the embedded provider`);
  const { ElasticsearchVersion, ElasticsearchClusterConfig, ...input } = route.input;
  if (route.operation === "CreateElasticsearchDomain" && ElasticsearchVersion !== ENGINE_VERSION) {
    throw new AwsError("ValidationException", `Legacy creation requires ElasticsearchVersion ${ENGINE_VERSION}; Elasticsearch engines are not implemented`);
  }
  if (route.operation.includes("CrossClusterSearchConnection")) {
    if (input.SourceDomainInfo) { input.LocalDomainInfo = { AWSDomainInformation: input.SourceDomainInfo }; delete input.SourceDomainInfo; }
    if (input.DestinationDomainInfo) { input.RemoteDomainInfo = { AWSDomainInformation: input.DestinationDomainInfo }; delete input.DestinationDomainInfo; }
    if (input.CrossClusterSearchConnectionId) { input.ConnectionId = input.CrossClusterSearchConnectionId; delete input.CrossClusterSearchConnectionId; }
    if (input.Filters) input.Filters = input.Filters.map((filter: any) => ({ ...filter, Name: filter.Name?.replace("cross-cluster-search-connection-id", "connection-id").replace("source-domain-info", "local-domain-info").replace("destination-domain-info", "remote-domain-info") }));
  }
  if (ElasticsearchVersion !== undefined) input.EngineVersion = ElasticsearchVersion;
  if (ElasticsearchClusterConfig !== undefined) input.ClusterConfig = ElasticsearchClusterConfig;
  return { ...route, family: "opensearch", operation, input };
}

export function legacyResponse(operation: string, result: any): any {
  const rename = (value: any): any => {
    if (Array.isArray(value)) return value.map(rename);
    if (!value || typeof value !== "object") return value;
    if (operation.includes("CrossClusterSearchConnection")) {
      const names: Record<string, string> = { LocalDomainInfo: "SourceDomainInfo", RemoteDomainInfo: "DestinationDomainInfo", ConnectionId: "CrossClusterSearchConnectionId", Connection: "CrossClusterSearchConnection", Connections: "CrossClusterSearchConnections" };
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [names[key] ?? key, rename(["LocalDomainInfo", "RemoteDomainInfo"].includes(key) ? (child as any).AWSDomainInformation : child)]));
    }
    const names: Record<string, string> = { EngineVersion: "ElasticsearchVersion", ClusterConfig: "ElasticsearchClusterConfig", Versions: "ElasticsearchVersions" };
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [Object.hasOwn(names, key) ? names[key] : key, rename(child)]));
  };
  const body = operation === "ListElasticsearchInstanceTypes"
    ? { ElasticsearchInstanceTypes: result.InstanceTypeDetails.map((item: any) => item.InstanceType) }
    : rename(result);
  // Modern responses contain fields absent from the legacy wire contract.
  const model: any = models.es;
  const project = (shapeName: string, value: any): any => {
    if (value === undefined) return value;
    const shape = model.shapes[shapeName];
    if (shape.type === "structure") return Object.fromEntries(Object.entries<any>(shape.members).filter(([key]) => Object.hasOwn(value, key)).map(([key, member]) => [key, project(member.shape, value[key])]));
    if (shape.type === "list") return value.map((child: any) => project(shape.member.shape, child));
    if (shape.type === "map") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, project(shape.value.shape, child)]));
    return value;
  };
  const output = model.operations[operation].output?.shape;
  return output ? project(output, body) : {};
}
