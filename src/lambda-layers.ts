import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { AwsError } from "./errors.js";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { StateStore } from "./state.js";
import type { LambdaLayerPolicyState, LambdaLayerReferenceState, LambdaLayerState, LambdaLayerVersionState } from "./types.js";
import { extractZip } from "./zip.js";
import { id, json, readBody, sha256 } from "./util.js";

const MAX_UNZIPPED_SIZE = 262_144_000;
const LAYER_NAME = /^[A-Za-z0-9-_]{1,140}$/;
const SUPPORTED_RUNTIMES = new Set(["nodejs18.x", "nodejs20.x", "nodejs22.x", "python3.13"]);
const ARCHITECTURES = new Set(["x86_64", "arm64"]);

interface LayerArn { region: string; accountId: string; name: string; version?: number }

function parseLayerArn(value: string): LayerArn | undefined {
  const match = value.match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:([^:]+):(\d{12}):layer:([A-Za-z0-9-_]+)(?::(\d+))?$/);
  if (!match) return undefined;
  return { region: match[1], accountId: match[2], name: match[3], ...(match[4] ? { version: Number(match[4]) } : {}) };
}

function validateList(values: unknown, label: string, maximum: number, allowed: Set<string>): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length || values.some(value => typeof value !== "string" || !allowed.has(value))) throw new AwsError("InvalidParameterValueException", `${label} contains an invalid or duplicate value`);
  return [...values];
}

function pageSize(url: URL): number {
  const value = Number(url.searchParams.get("MaxItems") ?? 50);
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 50");
  return value;
}

export class LambdaLayers {
  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock) {}
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private get state(): Record<string, LambdaLayerState> { return this.store.regionState(this.region).lambdaLayers; }

  private layerName(value: string): string {
    value = decodeURIComponent(value);
    const arn = parseLayerArn(value);
    if (arn) {
      if (arn.version !== undefined || arn.region !== this.region || arn.accountId !== this.store.accountId) throw new AwsError("ResourceNotFoundException", "Layer not found", 404);
      return arn.name;
    }
    if (!LAYER_NAME.test(value)) throw new AwsError("InvalidParameterValueException", "LayerName must contain 1-140 letters, numbers, hyphens, or underscores");
    return value;
  }

  private requireLayer(value: string): LambdaLayerState {
    const name = this.layerName(value); const layer = this.state[name];
    if (!layer) throw new AwsError("ResourceNotFoundException", `Layer not found: ${name}`, 404);
    return layer;
  }

  private requireVersion(layerName: string, version: number, includeDeleted = false): LambdaLayerVersionState {
    if (!Number.isInteger(version) || version < 1) throw new AwsError("InvalidParameterValueException", "VersionNumber must be a positive integer");
    const layer = this.requireLayer(layerName); const item = layer.versions[String(version)];
    if (!item || (item.deleted && !includeDeleted)) throw new AwsError("ResourceNotFoundException", `Layer version not found: ${layer.layerName}:${version}`, 404);
    return item;
  }

  private versionByArn(value: string, includeDeleted = false): LambdaLayerVersionState {
    const arn = parseLayerArn(decodeURIComponent(value));
    if (!arn || arn.version === undefined || arn.region !== this.region || arn.accountId !== this.store.accountId) throw new AwsError("ResourceNotFoundException", "Layer version not found", 404);
    return this.requireVersion(arn.name, arn.version, includeDeleted);
  }

  private summary(item: LambdaLayerVersionState): any {
    return { LayerVersionArn: item.arn, Version: item.version, Description: item.description, CreatedDate: item.createdDate, CompatibleRuntimes: item.compatibleRuntimes, LicenseInfo: item.licenseInfo, CompatibleArchitectures: item.compatibleArchitectures };
  }

  private view(item: LambdaLayerVersionState): any {
    return { Content: { Location: `file://${item.codeDir}`, CodeSha256: item.codeSha256, CodeSize: item.codeSize }, LayerArn: item.layerArn, LayerVersionArn: item.arn, Description: item.description, CreatedDate: item.createdDate, Version: item.version, CompatibleRuntimes: item.compatibleRuntimes, LicenseInfo: item.licenseInfo, CompatibleArchitectures: item.compatibleArchitectures, ...(item.cloudFormationOwner ? { StackSimCloudFormationOwner: item.cloudFormationOwner } : {}), ...(item.cloudFormationOperationToken ? { StackSimCloudFormationOperationToken: item.cloudFormationOperationToken } : {}) };
  }

  private matches(item: LambdaLayerVersionState, runtime?: string | null, architecture?: string | null): boolean {
    return !item.deleted && (!runtime || item.compatibleRuntimes.includes(runtime)) && (!architecture || item.compatibleArchitectures.includes(architecture as "x86_64" | "arm64"));
  }

  resolveFunctionLayers(arns: unknown, runtime: string, functionUnzippedSize: number, architecture: "x86_64" | "arm64" = "x86_64"): LambdaLayerReferenceState[] {
    if (arns === undefined) return [];
    if (!Array.isArray(arns) || arns.length > 5 || arns.some(value => typeof value !== "string")) throw new AwsError("InvalidParameterValueException", "Layers must contain at most 5 layer version ARNs");
    if (new Set(arns).size !== arns.length) throw new AwsError("InvalidParameterValueException", "A layer version can be attached only once");
    const references = arns.map(arn => {
      const item = this.versionByArn(arn);
      return { arn: item.arn, codeSize: item.codeSize, uncompressedCodeSize: item.uncompressedCodeSize, codeDir: item.codeDir, compatibleRuntimes: [...item.compatibleRuntimes], compatibleArchitectures: [...item.compatibleArchitectures] } satisfies LambdaLayerReferenceState;
    });
    this.validateFunctionLayers(references, runtime, functionUnzippedSize, architecture);
    return references;
  }

  validateFunctionLayers(references: LambdaLayerReferenceState[], runtime: string, functionUnzippedSize: number, architecture: "x86_64" | "arm64" = "x86_64"): void {
    for (const layer of references) {
      if (layer.compatibleRuntimes.length && !layer.compatibleRuntimes.includes(runtime)) throw new AwsError("InvalidParameterValueException", `Layer ${layer.arn} is not compatible with runtime ${runtime}`);
      if (layer.compatibleArchitectures.length && !layer.compatibleArchitectures.includes(architecture)) throw new AwsError("InvalidParameterValueException", `Layer ${layer.arn} is not compatible with architecture ${architecture}`);
    }
    const total = functionUnzippedSize + references.reduce((sum, layer) => sum + layer.uncompressedCodeSize, 0);
    if (total > MAX_UNZIPPED_SIZE) throw new AwsError("InvalidParameterValueException", `Function code and layers exceed the maximum unzipped size of ${MAX_UNZIPPED_SIZE} bytes`);
  }

  functionView(references: LambdaLayerReferenceState[] = []): any[] {
    return references.map(layer => ({ Arn: layer.arn, CodeSize: layer.codeSize }));
  }

  storageBytes(): number {
    return Object.values(this.state).flatMap(layer => Object.values(layer.versions)).filter(version => !version.deleted).reduce((sum, version) => sum + version.codeSize, 0);
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    if (pathname === "/2018-10-31/layers" && req.method === "GET") {
      if (url.searchParams.get("find") === "LayerVersion") return json(res, this.view(this.versionByArn(url.searchParams.get("Arn") ?? "")));
      const runtime = url.searchParams.get("CompatibleRuntime"); const architecture = url.searchParams.get("CompatibleArchitecture");
      if (runtime && !SUPPORTED_RUNTIMES.has(runtime)) throw new AwsError("InvalidParameterValueException", "CompatibleRuntime is not supported");
      if (architecture && !ARCHITECTURES.has(architecture)) throw new AwsError("InvalidParameterValueException", "CompatibleArchitecture is invalid");
      const layers = Object.values(this.state).sort((left, right) => left.layerName.localeCompare(right.layerName)).map(layer => ({ layer, latest: Object.values(layer.versions).filter(version => this.matches(version, runtime, architecture)).sort((left, right) => right.version - left.version)[0] })).filter(value => value.latest);
      const max = pageSize(url); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ runtime?: string; architecture?: string; index: number }>("ListLayers", marker); if (cursor.runtime !== (runtime ?? undefined) || cursor.architecture !== (architecture ?? undefined)) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); }
      const page = layers.slice(start, start + max); const next = start + page.length;
      return json(res, { Layers: page.map(({ layer, latest }) => ({ LayerName: layer.layerName, LayerArn: layer.layerArn, LatestMatchingVersion: this.summary(latest!) })), ...(next < layers.length ? { NextMarker: this.tokens.encode("ListLayers", { runtime: runtime ?? undefined, architecture: architecture ?? undefined, index: next }) } : {}) });
    }

    const versions = pathname.match(/^\/2018-10-31\/layers\/([^/]+)\/versions$/);
    if (versions && req.method === "POST") {
      const layerName = this.layerName(versions[1]); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const operationToken = input.StackSimCloudFormationOperationToken;
      const owner = input.StackSimCloudFormationOwner;
      if (operationToken !== undefined && (typeof operationToken !== "string" || !operationToken || operationToken.length > 512)) throw new AwsError("InvalidParameterValueException", "StackSimCloudFormationOperationToken is invalid");
      if (owner !== undefined && (typeof owner !== "string" || !owner || owner.length > 2048)) throw new AwsError("InvalidParameterValueException", "StackSimCloudFormationOwner is invalid");
      if ((operationToken === undefined) !== (owner === undefined)) throw new AwsError("InvalidParameterValueException", "CloudFormation ownership fields must be supplied together");
      if (operationToken) {
        const existing = Object.values(this.state[layerName]?.versions ?? {}).find(version => !version.deleted && version.cloudFormationOperationToken === operationToken);
        if (existing) {
          if (existing.cloudFormationOwner !== owner) throw new AwsError("ResourceConflictException", "Layer version create token is owned by another CloudFormation resource", 409);
          return json(res, this.view(existing), 201);
        }
      }
      if (!input.Content?.ZipFile || typeof input.Content.ZipFile !== "string") { if (input.Content?.S3Bucket || input.Content?.S3Key) throw new AwsError("InvalidParameterValueException", "S3 layer content is not available in this simulator"); throw new AwsError("InvalidParameterValueException", "Content.ZipFile is required"); }
      if (typeof input.Description !== "undefined" && (typeof input.Description !== "string" || input.Description.length > 256)) throw new AwsError("InvalidParameterValueException", "Description must be at most 256 characters");
      if (typeof input.LicenseInfo !== "undefined" && (typeof input.LicenseInfo !== "string" || input.LicenseInfo.length > 512)) throw new AwsError("InvalidParameterValueException", "LicenseInfo must be at most 512 characters");
      const compatibleRuntimes = validateList(input.CompatibleRuntimes, "CompatibleRuntimes", 15, SUPPORTED_RUNTIMES);
      const compatibleArchitectures = validateList(input.CompatibleArchitectures, "CompatibleArchitectures", 2, ARCHITECTURES) as Array<"x86_64" | "arm64">;
      const zip = Buffer.from(input.Content.ZipFile, "base64"); const zippedLimit = Number(process.env.STACKSIM_LAMBDA_ZIP_LIMIT ?? 50 * 1024 * 1024);
      if (!zip.length) throw new AwsError("InvalidParameterValueException", "Content.ZipFile is not a valid ZIP archive");
      if (zip.length > zippedLimit) throw new AwsError("RequestEntityTooLargeException", `Zipped size must be smaller than ${zippedLimit} bytes`, 413);
      const layer = this.state[layerName] ??= { layerName, layerArn: `arn:aws:lambda:${this.region}:${this.store.accountId}:layer:${layerName}`, nextVersion: 1, versions: {} };
      const version = layer.nextVersion; const destination = resolve(this.store.root, "layers", layerName, `${version}-${id(8)}`); await mkdir(resolve(this.store.root, "layers", layerName), { recursive: true });
      let extraction; try { extraction = await extractZip(zip, destination, { maxUncompressedSize: MAX_UNZIPPED_SIZE }); } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
      const item: LambdaLayerVersionState = { version, layerArn: layer.layerArn, arn: `${layer.layerArn}:${version}`, description: input.Description ?? "", createdDate: new Date(this.clock.now()).toISOString(), ...(input.LicenseInfo !== undefined ? { licenseInfo: input.LicenseInfo } : {}), compatibleRuntimes, compatibleArchitectures, codeSha256: sha256(zip), codeSize: zip.length, uncompressedCodeSize: extraction.uncompressedSize, codeDir: destination, ...(owner ? { cloudFormationOwner: owner, cloudFormationOperationToken: operationToken } : {}) };
      layer.versions[String(version)] = item; layer.nextVersion++; await this.store.save(); return json(res, this.view(item), 201);
    }
    if (versions && req.method === "GET") {
      const layer = this.requireLayer(versions[1]); const runtime = url.searchParams.get("CompatibleRuntime"); const architecture = url.searchParams.get("CompatibleArchitecture");
      if (runtime && !SUPPORTED_RUNTIMES.has(runtime)) throw new AwsError("InvalidParameterValueException", "CompatibleRuntime is not supported"); if (architecture && !ARCHITECTURES.has(architecture)) throw new AwsError("InvalidParameterValueException", "CompatibleArchitecture is invalid");
      const values = Object.values(layer.versions).filter(item => this.matches(item, runtime, architecture)).sort((left, right) => right.version - left.version); const max = pageSize(url); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ name: string; runtime?: string; architecture?: string; index: number }>("ListLayerVersions", marker); if (cursor.name !== layer.layerName || cursor.runtime !== (runtime ?? undefined) || cursor.architecture !== (architecture ?? undefined)) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); }
      const page = values.slice(start, start + max); const next = start + page.length; return json(res, { LayerVersions: page.map(item => this.summary(item)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListLayerVersions", { name: layer.layerName, runtime: runtime ?? undefined, architecture: architecture ?? undefined, index: next }) } : {}) });
    }

    const versionRoute = pathname.match(/^\/2018-10-31\/layers\/([^/]+)\/versions\/(\d+)$/);
    if (versionRoute) { const version = Number(versionRoute[2]); if (req.method === "GET") return json(res, this.view(this.requireVersion(versionRoute[1], version))); if (req.method === "DELETE") { const item = this.requireVersion(versionRoute[1], version); item.deleted = true; await this.store.save(); res.statusCode = 204; res.end(); return; } }

    const policyRoute = pathname.match(/^\/2018-10-31\/layers\/([^/]+)\/versions\/(\d+)\/policy$/);
    if (policyRoute) {
      const item = this.requireVersion(policyRoute[1], Number(policyRoute[2]));
      if (req.method === "GET") { if (!item.policy?.statements.length) throw new AwsError("ResourceNotFoundException", "Layer version policy not found", 404); return json(res, { Policy: JSON.stringify({ Version: "2012-10-17", Id: "default", Statement: item.policy.statements }), RevisionId: item.policy.revisionId }); }
      if (req.method === "POST") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const revision = url.searchParams.get("RevisionId"); if (revision && revision !== item.policy?.revisionId) throw new AwsError("PreconditionFailedException", "The RevisionId provided does not match", 412); if (input.Action !== "lambda:GetLayerVersion") throw new AwsError("InvalidParameterValueException", "Action must be lambda:GetLayerVersion"); if (!/^[A-Za-z0-9-_]{1,100}$/.test(input.StatementId ?? "")) throw new AwsError("InvalidParameterValueException", "StatementId is invalid"); if (!/^(?:\d{12}|\*|arn:aws[a-zA-Z-]*:iam::\d{12}:root)$/.test(input.Principal ?? "")) throw new AwsError("InvalidParameterValueException", "Principal must be an account ID, account root ARN, or *"); if (input.OrganizationId !== undefined && (input.Principal !== "*" || !/^o-[a-z0-9]{10,32}$/.test(input.OrganizationId))) throw new AwsError("InvalidParameterValueException", "OrganizationId requires principal * and a valid organization ID"); const policy = item.policy ??= { revisionId: id(32), statements: [] }; if (policy.statements.some(statement => statement.Sid === input.StatementId)) throw new AwsError("ResourceConflictException", "The statement id already exists", 409); const principal = input.Principal === "*" ? "*" : { AWS: /^\d{12}$/.test(input.Principal) ? `arn:aws:iam::${input.Principal}:root` : input.Principal }; const statement: LambdaLayerPolicyState["statements"][number] = { Sid: input.StatementId, Effect: "Allow", Principal: principal, Action: "lambda:GetLayerVersion", Resource: item.arn, ...(input.OrganizationId ? { Condition: { StringEquals: { "aws:PrincipalOrgID": input.OrganizationId } } } : {}) }; if (Buffer.byteLength(JSON.stringify([...policy.statements, statement])) > 20_480) throw new AwsError("PolicyLengthExceededException", "The permissions policy is too large"); policy.statements.push(statement); policy.revisionId = id(32); await this.store.save(); return json(res, { Statement: JSON.stringify(statement), RevisionId: policy.revisionId }, 201); }
    }

    const statementRoute = pathname.match(/^\/2018-10-31\/layers\/([^/]+)\/versions\/(\d+)\/policy\/([^/]+)$/);
    if (statementRoute && req.method === "DELETE") { const item = this.requireVersion(statementRoute[1], Number(statementRoute[2])); const policy = item.policy; if (!policy) throw new AwsError("ResourceNotFoundException", "Layer version policy not found", 404); const revision = url.searchParams.get("RevisionId"); if (revision && revision !== policy.revisionId) throw new AwsError("PreconditionFailedException", "The RevisionId provided does not match", 412); const index = policy.statements.findIndex(statement => statement.Sid === decodeURIComponent(statementRoute[3])); if (index < 0) throw new AwsError("ResourceNotFoundException", "Statement not found", 404); policy.statements.splice(index, 1); if (!policy.statements.length) delete item.policy; else policy.revisionId = id(32); await this.store.save(); res.statusCode = 204; res.end(); return; }

    throw new AwsError("ResourceNotFoundException", "Unknown Lambda layer route", 404);
  }
}
