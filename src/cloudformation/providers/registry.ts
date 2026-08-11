import type {
  CloudFormationResourceProvider,
  ProductionResourceProvider,
  ProviderPropertyUpdateBehavior,
  ProviderPropertyValueType,
  ProviderRetentionPolicy,
  TestOnlyResourceProvider,
} from "./contract.js";

type AnyProvider = CloudFormationResourceProvider<any>;
type AnyProductionProvider = ProductionResourceProvider<any>;
type AnyTestProvider = TestOnlyResourceProvider<any>;

const TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*(?:::[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const VALUE_TYPES = new Set<ProviderPropertyValueType>(["any", "string", "number", "boolean", "object", "array"]);
const UPDATE_BEHAVIORS = new Set<ProviderPropertyUpdateBehavior>([
  "MUTABLE",
  "REPLACEMENT",
  "CONDITIONAL_REPLACEMENT",
  "NOT_SUPPORTED",
]);
const RETENTION_POLICIES = new Set<ProviderRetentionPolicy>(["Delete", "Retain", "RetainExceptOnCreate", "Snapshot"]);

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

export class DuplicateProviderError extends ProviderRegistryError {
  constructor(readonly typeName: string) {
    super(`A CloudFormation provider is already registered for ${typeName}`);
    this.name = "DuplicateProviderError";
  }
}

export class InvalidProviderDeclarationError extends ProviderRegistryError {
  constructor(readonly typeName: string, message: string) {
    super(`Invalid CloudFormation provider declaration for ${typeName}: ${message}`);
    this.name = "InvalidProviderDeclarationError";
  }
}

export class UnsupportedResourceProviderError extends ProviderRegistryError {
  readonly code = "ValidationError" as const;

  constructor(readonly typeName: string) {
    super(`Resource type ${typeName} is not supported by the local CloudFormation provider registry`);
    this.name = "UnsupportedResourceProviderError";
  }
}

function invalid(provider: AnyProvider, message: string): never {
  throw new InvalidProviderDeclarationError(provider.typeName || "<missing>", message);
}

function assertUnique(values: readonly string[], provider: AnyProvider, description: string): void {
  if (new Set(values).size !== values.length) invalid(provider, `${description} contains duplicates`);
}

/** Runtime checks keep JavaScript callers from bypassing the TypeScript contract. */
export function validateProviderDeclaration(provider: AnyProvider): void {
  if (!provider || typeof provider !== "object") throw new InvalidProviderDeclarationError("<missing>", "provider must be an object");
  if (typeof provider.typeName !== "string" || !TYPE_NAME.test(provider.typeName)) invalid(provider, "typeName must be a namespaced CloudFormation resource type");
  if (!Number.isInteger(provider.providerVersion) || provider.providerVersion < 1) invalid(provider, "providerVersion must be a positive integer");
  if (provider.visibility !== "production" && provider.visibility !== "test-only") invalid(provider, "visibility must be production or test-only");
  if (!provider.schema || provider.schema.typeName !== provider.typeName) invalid(provider, "schema.typeName must match typeName");
  if (provider.schema.unknownProperties !== "REJECT" && provider.schema.unknownProperties !== "ALLOW") invalid(provider, "unknownProperties must be REJECT or ALLOW");
  const isGeneralCustomResource = provider.typeName === "AWS::CloudFormation::CustomResource" || provider.typeName.startsWith("Custom::") && provider.typeName !== "Custom::CDKBucketDeployment";
  if (provider.schema.unknownProperties === "ALLOW" && !isGeneralCustomResource) invalid(provider, "only a general Lambda custom-resource provider may allow additional properties");
  if (!provider.schema.properties || typeof provider.schema.properties !== "object" || Array.isArray(provider.schema.properties)) invalid(provider, "schema.properties must be an object");

  for (const [name, declaration] of Object.entries(provider.schema.properties)) {
    if (!name) invalid(provider, "property names must not be empty");
    if (!declaration || typeof declaration !== "object") invalid(provider, `property ${name} must have a declaration`);
    if (!VALUE_TYPES.has(declaration.valueType)) invalid(provider, `property ${name} has invalid valueType`);
    if (!UPDATE_BEHAVIORS.has(declaration.updateBehavior)) invalid(provider, `property ${name} has invalid updateBehavior`);
  }

  if (!provider.schema.ref || typeof provider.schema.ref.supported !== "boolean") invalid(provider, "schema.ref.supported must be boolean");
  if (provider.schema.ref.supported && !provider.schema.ref.valueType) invalid(provider, "a supported Ref must declare valueType");
  if (provider.schema.ref.valueType && !VALUE_TYPES.has(provider.schema.ref.valueType)) invalid(provider, "Ref has invalid valueType");
  if (!provider.schema.attributes || typeof provider.schema.attributes !== "object" || Array.isArray(provider.schema.attributes)) invalid(provider, "schema.attributes must be an object");
  for (const [name, declaration] of Object.entries(provider.schema.attributes)) {
    if (!name) invalid(provider, "attribute names must not be empty");
    if (!declaration || !VALUE_TYPES.has(declaration.valueType)) invalid(provider, `attribute ${name} has invalid valueType`);
  }
  if (provider.schema.additionalAttributes !== undefined && typeof provider.schema.additionalAttributes !== "boolean") invalid(provider, "additionalAttributes must be boolean when supplied");
  if (provider.schema.additionalAttributes && !isGeneralCustomResource) invalid(provider, "only a general Lambda custom-resource provider may allow additional attributes");

  const replacement = provider.schema.replacement;
  if (!replacement || !["CREATE_BEFORE_DELETE", "DELETE_BEFORE_CREATE"].includes(replacement.defaultOrder)) invalid(provider, "replacement.defaultOrder is invalid");
  if (replacement.defaultOrder === "DELETE_BEFORE_CREATE" && !replacement.deleteBeforeCreateReason?.trim()) invalid(provider, "delete-before-create replacement requires a reason");

  const retention = provider.schema.retention;
  if (!retention || !Array.isArray(retention.deletionPolicies) || !Array.isArray(retention.updateReplacePolicies)) invalid(provider, "retention policies must be arrays");
  assertUnique(retention.deletionPolicies, provider, "deletionPolicies");
  assertUnique(retention.updateReplacePolicies, provider, "updateReplacePolicies");
  for (const policy of [...retention.deletionPolicies, ...retention.updateReplacePolicies]) {
    if (!RETENTION_POLICIES.has(policy)) invalid(provider, `retention policy ${policy} is invalid`);
  }
  const declaresSnapshot = retention.deletionPolicies.includes("Snapshot") || retention.updateReplacePolicies.includes("Snapshot");
  if (declaresSnapshot !== retention.snapshotSupported) invalid(provider, "snapshotSupported must match whether Snapshot is accepted");

  const tags = provider.schema.tags;
  if (!tags || !["NONE", "RESOURCE_PROPERTY", "STACK_AND_RESOURCE"].includes(tags.behavior)) invalid(provider, "tags.behavior is invalid");
  if (tags.behavior === "NONE" && tags.propertyName !== undefined) invalid(provider, "a provider with no tag behavior cannot declare propertyName");
  if (tags.behavior !== "NONE" && !tags.propertyName?.trim()) invalid(provider, "tag-aware providers must declare propertyName");

  for (const method of ["validate", "canonicalize", "plan", "create", "read", "update", "delete", "ref", "getAtt"] as const) {
    if (typeof provider[method] !== "function") invalid(provider, `method ${method} is required`);
  }
}

function validateBatch(providers: readonly AnyProvider[], existing: ReadonlyMap<string, AnyProvider>, visibility: AnyProvider["visibility"]): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    validateProviderDeclaration(provider);
    if (provider.visibility !== visibility) invalid(provider, `${visibility} registry cannot accept a ${provider.visibility} provider`);
    if (existing.has(provider.typeName) || seen.has(provider.typeName)) throw new DuplicateProviderError(provider.typeName);
    seen.add(provider.typeName);
  }
}

/** Registry safe to hand to the public CloudFormation endpoint. */
export class CloudFormationProviderRegistry {
  private readonly providers = new Map<string, AnyProductionProvider>();
  private readonly customResourceProviders = new Map<string, AnyProductionProvider>();
  private customResourceFactory?: (typeName: string) => AnyProductionProvider;

  constructor(providers: Iterable<AnyProductionProvider> = []) {
    this.registerAll(providers);
  }

  register<Model>(provider: ProductionResourceProvider<Model>): this {
    return this.registerAll([provider]);
  }

  /** Batch registration is atomic when validation or duplicate checks fail. */
  registerAll(providers: Iterable<AnyProductionProvider>): this {
    const batch = [...providers];
    validateBatch(batch, this.providers, "production");
    for (const provider of batch) this.providers.set(provider.typeName, provider);
    return this;
  }

  get(typeName: string): AnyProductionProvider | undefined {
    const exact = this.providers.get(typeName);
    if (exact || !typeName.startsWith("Custom::") || typeName === "Custom::CDKBucketDeployment" || !this.customResourceFactory) return exact;
    const cached = this.customResourceProviders.get(typeName);
    if (cached) return cached;
    const dynamic = this.customResourceFactory(typeName);
    validateProviderDeclaration(dynamic);
    if (dynamic.visibility !== "production" || dynamic.typeName !== typeName || dynamic.schema.unknownProperties !== "ALLOW") invalid(dynamic, "dynamic custom-resource factory returned an invalid provider");
    this.customResourceProviders.set(typeName, dynamic);
    return dynamic;
  }

  /** Install the one bounded factory used to materialize arbitrary Custom::* names. */
  setCustomResourceFactory(factory: (typeName: string) => AnyProductionProvider): this {
    this.customResourceFactory = factory;
    return this;
  }

  require(typeName: string): AnyProductionProvider {
    const provider = this.get(typeName);
    if (!provider) throw new UnsupportedResourceProviderError(typeName);
    return provider;
  }

  has(typeName: string): boolean {
    return this.providers.has(typeName);
  }

  list(): readonly AnyProductionProvider[] {
    return [...this.providers.values()].sort((left, right) => left.typeName.localeCompare(right.typeName));
  }
}

/**
 * Explicit test harness overlay. Test-only providers never enter or resolve
 * from CloudFormationProviderRegistry, so the public route cannot see them.
 */
export class CloudFormationTestProviderRegistry {
  private readonly providers = new Map<string, AnyTestProvider>();

  constructor(
    readonly production: CloudFormationProviderRegistry = new CloudFormationProviderRegistry(),
    providers: Iterable<AnyTestProvider> = [],
  ) {
    this.registerAllForTest(providers);
  }

  registerForTest<Model>(provider: TestOnlyResourceProvider<Model>): this {
    return this.registerAllForTest([provider]);
  }

  registerAllForTest(providers: Iterable<AnyTestProvider>): this {
    const batch = [...providers];
    const occupied = new Map<string, AnyProvider>([
      ...this.production.list().map(provider => [provider.typeName, provider] as const),
      ...this.providers,
    ]);
    validateBatch(batch, occupied, "test-only");
    for (const provider of batch) this.providers.set(provider.typeName, provider);
    return this;
  }

  resolveForTest(typeName: string): AnyProvider | undefined {
    return this.production.get(typeName) ?? this.providers.get(typeName);
  }

  requireForTest(typeName: string): AnyProvider {
    const provider = this.resolveForTest(typeName);
    if (!provider) throw new UnsupportedResourceProviderError(typeName);
    return provider;
  }

  listTestOnly(): readonly AnyTestProvider[] {
    return [...this.providers.values()].sort((left, right) => left.typeName.localeCompare(right.typeName));
  }
}
