import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { AwsError } from "./errors.js";
import type { LambdaArchitecture, LambdaImageConfigState } from "./types.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 * 1024;

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  annotations?: Record<string, string>;
}

export interface ResolvedLambdaImage {
  imageUri: string;
  resolvedImageUri: string;
  executionImageUri?: string;
  imageSource: "oci" | "docker";
  codeSha256: string;
  codeSize: number;
}

function invalid(message: string): never {
  throw new AwsError("InvalidParameterValueException", message);
}

function imageReference(value: unknown, region: string): { uri: string; repository: string; digest?: string; tag: string } {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) invalid("Code.ImageUri must be a non-empty ECR image URI");
  const match = value.match(/^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9]+(?:[._\/-][a-z0-9]+)*)(?:(:)([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})|@(sha256:[a-f0-9]{64}))?$/);
  if (!match) invalid("Code.ImageUri must be an ECR-shaped repository tag or sha256 digest URI");
  if (match[2] !== region) invalid(`Container image Region ${match[2]} must match function Region ${region}`);
  const repository = `${match[1]}.dkr.ecr.${match[2]}.amazonaws.com/${match[3]}`;
  return { uri: value, repository, ...(match[6] ? { digest: match[6] } : {}), tag: match[5] ?? "latest" };
}

function digestHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid(`${label} must use a sha256 digest`);
  return value.slice("sha256:".length);
}

async function metadata(path: string, label: string): Promise<Buffer> {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile()) invalid(`${label} is missing from the configured OCI image layout`);
  if (details.size > MAX_METADATA_BYTES) invalid(`${label} exceeds the 1 MB local metadata limit`);
  return readFile(path);
}

async function verifiedBlob(root: string, descriptor: Descriptor, label: string): Promise<Buffer> {
  const hex = digestHex(descriptor.digest, label);
  const bytes = await metadata(resolve(root, "blobs", "sha256", hex), label);
  if (createHash("sha256").update(bytes).digest("hex") !== hex) invalid(`${label} digest does not match its OCI descriptor`);
  if (descriptor.size !== undefined && descriptor.size !== bytes.length) invalid(`${label} size does not match its OCI descriptor`);
  return bytes;
}

function parseJson(bytes: Buffer, label: string): any {
  try { return JSON.parse(bytes.toString("utf8")); } catch { return invalid(`${label} is not valid JSON`); }
}

function platformArchitecture(value: unknown): LambdaArchitecture | undefined {
  if (value === "amd64" || value === "x86_64") return "x86_64";
  if (value === "arm64") return "arm64";
  return undefined;
}

function assertPlatform(os: unknown, architecture: unknown, expected: LambdaArchitecture): void {
  if (os !== "linux") invalid("Lambda container images must target Linux");
  const actual = platformArchitecture(architecture);
  if (!actual) invalid(`Unsupported container image architecture: ${String(architecture)}`);
  if (actual !== expected) invalid(`Container image architecture ${actual} does not match function architecture ${expected}`);
}

function resolvedUri(repository: string, digest: string): string { return `${repository}@${digest}`; }

export class LambdaImages {
  constructor(private readonly region: string) {}

  validateImageConfig(value: unknown): void {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("ImageConfig must be an object");
    const input = value as Record<string, unknown>;
    for (const [field, name] of [["EntryPoint", "ImageConfig.EntryPoint"], ["Command", "ImageConfig.Command"]] as const) {
      const values = input[field];
      if (values !== undefined && (!Array.isArray(values) || values.length > 1500 || values.some(item => typeof item !== "string"))) invalid(`${name} must contain at most 1500 strings`);
    }
    if (input.WorkingDirectory !== undefined && (typeof input.WorkingDirectory !== "string" || input.WorkingDirectory.length > 1000)) invalid("ImageConfig.WorkingDirectory must not exceed 1000 characters");
  }

  imageConfig(value: any, current?: LambdaImageConfigState): LambdaImageConfigState | undefined {
    if (value === undefined) return current ? structuredClone(current) : undefined;
    return {
      ...(value.EntryPoint !== undefined ? { entryPoint: [...value.EntryPoint] } : current?.entryPoint ? { entryPoint: [...current.entryPoint] } : {}),
      ...(value.Command !== undefined ? { command: [...value.Command] } : current?.command ? { command: [...current.command] } : {}),
      ...(value.WorkingDirectory !== undefined ? { workingDirectory: value.WorkingDirectory } : current?.workingDirectory !== undefined ? { workingDirectory: current.workingDirectory } : {}),
    };
  }

  imageConfigView(value?: LambdaImageConfigState): any {
    return { ...(value?.entryPoint ? { EntryPoint: value.entryPoint } : {}), ...(value?.command ? { Command: value.command } : {}), ...(value?.workingDirectory !== undefined ? { WorkingDirectory: value.workingDirectory } : {}) };
  }

  async resolve(imageUri: unknown, architecture: LambdaArchitecture): Promise<ResolvedLambdaImage> {
    const reference = imageReference(imageUri, this.region);
    const ociRoot = process.env.STACKSIM_LAMBDA_OCI_ROOT;
    const dockerSocket = process.env.STACKSIM_LAMBDA_DOCKER_SOCKET;
    if (!ociRoot && !dockerSocket) invalid("Local container image resolution is disabled; set STACKSIM_LAMBDA_OCI_ROOT or STACKSIM_LAMBDA_DOCKER_SOCKET");
    if (ociRoot) return this.resolveOci(reference, architecture, ociRoot);
    return this.resolveDocker(reference, architecture, dockerSocket!);
  }

  private async resolveOci(reference: ReturnType<typeof imageReference>, architecture: LambdaArchitecture, configuredRoot: string): Promise<ResolvedLambdaImage> {
    if (!isAbsolute(configuredRoot)) invalid("STACKSIM_LAMBDA_OCI_ROOT must be an absolute path");
    const root = resolve(configuredRoot);
    const layout = parseJson(await metadata(resolve(root, "oci-layout"), "oci-layout"), "oci-layout");
    if (layout.imageLayoutVersion !== "1.0.0") invalid("OCI image layout version must be 1.0.0");
    const index = parseJson(await metadata(resolve(root, "index.json"), "OCI index"), "OCI index");
    if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) invalid("OCI index must be a schemaVersion 2 manifest list");
    const candidates = new Set([reference.uri, `${reference.repository}:${reference.tag}`, reference.tag]);
    const matches = (index.manifests as Descriptor[]).filter(descriptor => reference.digest ? descriptor.digest === reference.digest : candidates.has(descriptor.annotations?.["org.opencontainers.image.ref.name"] ?? ""));
    if (matches.length !== 1) invalid(matches.length ? "OCI image reference is ambiguous" : `Image ${reference.uri} was not found in STACKSIM_LAMBDA_OCI_ROOT`);
    const descriptor = matches[0];
    if (!new Set([OCI_MANIFEST, DOCKER_MANIFEST]).has(descriptor.mediaType ?? "")) invalid("Lambda requires a single-platform OCI or Docker schema 2 image manifest");
    const manifestBytes = await verifiedBlob(root, descriptor, "image manifest");
    const manifest = parseJson(manifestBytes, "image manifest");
    if (manifest.schemaVersion !== 2 || !manifest.config || !Array.isArray(manifest.layers)) invalid("Image manifest must contain schemaVersion 2 config and layers");
    const configBytes = await verifiedBlob(root, manifest.config, "image config");
    const config = parseJson(configBytes, "image config");
    assertPlatform(config.os, config.architecture, architecture);
    let size = manifestBytes.length + configBytes.length;
    for (const layer of manifest.layers as Descriptor[]) { digestHex(layer.digest, "image layer"); if (!Number.isInteger(layer.size) || layer.size! < 0) invalid("Image layer size is invalid"); size += layer.size!; if (size > MAX_IMAGE_BYTES) invalid("Container image exceeds the 10 GB Lambda image limit"); }
    const digest = descriptor.digest!;
    return { imageUri: reference.uri, resolvedImageUri: resolvedUri(reference.repository, digest), imageSource: "oci", codeSha256: createHash("sha256").update(manifestBytes).digest("base64"), codeSize: size };
  }

  private async resolveDocker(reference: ReturnType<typeof imageReference>, architecture: LambdaArchitecture, configuredSocket: string): Promise<ResolvedLambdaImage> {
    const socket = configuredSocket.startsWith("unix://") ? configuredSocket.slice("unix://".length) : configuredSocket;
    if (!isAbsolute(socket)) invalid("STACKSIM_LAMBDA_DOCKER_SOCKET must be an absolute local socket or named-pipe path");
    const response = await new Promise<{ status: number; body: Buffer }>((resolveResponse, reject) => {
      const req = request({ socketPath: socket, path: `/v1.41/images/${encodeURIComponent(reference.uri)}/json`, method: "GET", headers: { accept: "application/json" } }, res => {
        const chunks: Buffer[] = []; let length = 0;
        res.on("data", chunk => { const bytes = Buffer.from(chunk); length += bytes.length; if (length <= MAX_METADATA_BYTES) chunks.push(bytes); });
        res.on("end", () => length > MAX_METADATA_BYTES ? reject(new AwsError("InvalidParameterValueException", "Docker image metadata exceeds 1 MB")) : resolveResponse({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
      });
      req.once("error", error => reject(new AwsError("InvalidParameterValueException", `Configured Docker socket is unavailable: ${error.message}`)));
      req.end();
    });
    if (response.status === 404) invalid(`Image ${reference.uri} is not present on the configured Docker socket; implicit pulls are disabled`);
    if (response.status < 200 || response.status >= 300) invalid(`Docker image inspection failed with status ${response.status}`);
    const details = parseJson(response.body, "Docker image metadata");
    assertPlatform(String(details.Os ?? "").toLowerCase(), details.Architecture, architecture);
    const repositoryDigest = Array.isArray(details.RepoDigests) ? details.RepoDigests.map((item: unknown) => typeof item === "string" && item.startsWith(`${reference.repository}@`) ? item.slice(reference.repository.length + 1) : undefined).find((item: unknown) => typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item)) : undefined;
    const digest = reference.digest ?? repositoryDigest ?? details.Id;
    const digestValue = typeof digest === "string" ? digest : invalid("Docker image ID must use a sha256 digest");
    digestHex(digestValue, "Docker image ID");
    const size = Number(details.Size ?? 0); if (!Number.isSafeInteger(size) || size < 0 || size > MAX_IMAGE_BYTES) invalid("Docker image size exceeds the 10 GB Lambda image limit");
    return { imageUri: reference.uri, resolvedImageUri: resolvedUri(reference.repository, digestValue), executionImageUri: reference.digest ? reference.uri : repositoryDigest ? resolvedUri(reference.repository, repositoryDigest) : digestValue, imageSource: "docker", codeSha256: Buffer.from(digestValue.slice("sha256:".length), "hex").toString("base64"), codeSize: size };
  }
}
