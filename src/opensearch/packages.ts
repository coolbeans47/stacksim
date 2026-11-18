import { createHash, randomUUID } from "node:crypto";
import type { StateStore } from "../state.js";
import type { Clock } from "../core/clock.js";
import type { PrincipalContext } from "../auth/sigv4.js";
import { EncryptedMaterialStore, type MaterialBinding } from "../configuration-secrets/encrypted-material-store.js";
import { PaginationTokens } from "../core/pagination.js";
import { AwsError } from "../errors.js";
import { exact, object, reject } from "./validation.js";
import { wildcard } from "./query.js";
import type { DomainRecord } from "./model.js";
import type { DictionaryVersion } from "./analyzers.js";

export const PACKAGE_ACTIONS = new Set(["CreatePackage", "UpdatePackage", "DeletePackage", "DescribePackages", "GetPackageVersionHistory", "AssociatePackage", "AssociatePackages", "DissociatePackage", "DissociatePackages", "ListDomainsForPackage", "ListPackagesForDomain", "UpdatePackageScope"]);
interface PackageVersion { version: string; material: string; createdAt: number; commitMessage?: string }
interface Association { generation: string; accountId: string; region: string; domain: string; version: string; activeVersion?: string; updatedAt: number; state: "ASSOCIATING" | "ACTIVE" | "ASSOCIATION_FAILED" | "DISSOCIATING" | "DISSOCIATION_FAILED"; prerequisites: string[]; error?: string }
export interface SearchPackage {
  id: string; generation: string; name: string; description?: string; accountId: string; region: string; createdAt: number; updatedAt: number;
  state: "COPYING" | "AVAILABLE" | "COPY_FAILED" | "DELETING" | "DELETE_FAILED"; versions: PackageVersion[]; available?: string; pending?: PackageVersion; error?: string;
  vending: boolean; users: string[]; associations: Record<string, Association>;
}
export interface PackageCatalog { records: Record<string, SearchPackage>; cursorKey: string }
interface PackagePorts {
  catalog(region: string, accountId: string): PackageCatalog;
  all(): SearchPackage[];
  domain(region: string, accountId: string, name: string): DomainRecord;
  source(region: string, accountId: string, bucket: string, key: string, principal?: PrincipalContext): Promise<Buffer>;
  install(domain: DomainRecord, id: string, version: string, versions: DictionaryVersion[], validate?: boolean): () => void;
  remove(domain: DomainRecord, id: string): () => void;
  validate(domain: DomainRecord): void;
  mutate(domain: DomainRecord, work: () => Promise<void>): Promise<void>;
  inUse(domain: DomainRecord, id: string): boolean;
}
const resource = (pkg: SearchPackage) => `arn:${pkg.region.startsWith("cn-") ? "aws-cn" : pkg.region.startsWith("us-gov-") ? "aws-us-gov" : "aws"}:es:${pkg.region}:${pkg.accountId}:package/${pkg.id}`;
const bounded = (value: any, label: string, max: number, optional = false): string | undefined => { if (optional && value === undefined) return undefined; if (typeof value !== "string" || value.length > max || !optional && !value.length) reject(`${label} must be ${optional ? "a" : "a nonempty"} string of at most ${max} characters`); return value; };
const failure = (error: unknown): string => error instanceof AwsError ? error.message.slice(0, 1024) : "Protected package storage or domain installation failed";

/** Encrypted immutable dictionary versions with durable asynchronous publication. */
export class SearchPackages {
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly materials: EncryptedMaterialStore, private readonly ports: PackagePorts) {}
  references(): string[] { return this.ports.all().filter(pkg => !["DELETING", "DELETE_FAILED"].includes(pkg.state)).flatMap(pkg => [...pkg.versions, ...(pkg.pending ? [pkg.pending] : [])].map(version => version.material)); }
  private binding(pkg: SearchPackage, version: string): MaterialBinding { return { service: "opensearch", accountId: pkg.accountId, region: pkg.region, resourceArn: resource(pkg), generationId: pkg.generation, valueKind: "SecretString", version }; }
  private visible(pkg: SearchPackage, accountId: string): boolean { return pkg.accountId === accountId || pkg.vending && (pkg.users.includes(accountId) || pkg.users.includes("GLOBAL")); }
  private get(id: any, region: string, accountId: string, owner = false): SearchPackage {
    if (typeof id !== "string" || !/^(?:[FG]\d+|pkg-[a-f0-9]+)$/.test(id)) reject("Invalid PackageID");
    const pkg = this.ports.all().find(pkg => pkg.id === id && pkg.region === region && (owner ? pkg.accountId === accountId : this.visible(pkg, accountId)));
    if (!pkg) throw new AwsError("ResourceNotFoundException", "Package not found", 409); return pkg;
  }
  private details(pkg: SearchPackage): any {
    return { PackageID: pkg.id, PackageName: pkg.name, PackageType: "TXT-DICTIONARY", ...(pkg.description === undefined ? {} : { PackageDescription: pkg.description }), PackageStatus: pkg.state, CreatedAt: pkg.createdAt / 1000, LastUpdatedAt: pkg.updatedAt / 1000, ...(pkg.available ? { AvailablePackageVersion: pkg.available } : {}), PackageOwner: pkg.accountId, AllowListedUserList: [...pkg.users], PackageVendingOptions: { VendingEnabled: pkg.vending }, PackageEncryptionOptions: { EncryptionEnabled: true }, ...(pkg.error ? { ErrorDetails: { ErrorType: "PackageFailure", ErrorMessage: pkg.error } } : {}) };
  }
  private associationDetails(pkg: SearchPackage, association: Association): any { return { PackageID: pkg.id, PackageName: pkg.name, PackageType: "TXT-DICTIONARY", DomainName: association.domain, DomainPackageStatus: association.state, LastUpdated: association.updatedAt / 1000, PackageVersion: association.activeVersion ?? association.version, ReferencePath: `analyzers/${pkg.id}`, PrerequisitePackageIDList: association.prerequisites, ...(association.error ? { ErrorDetails: { ErrorType: "AssociationFailure", ErrorMessage: association.error } } : {}) }; }
  private async text(pkg: SearchPackage, version: string): Promise<string> {
    const item = pkg.versions.find(item => item.version === version) ?? (pkg.pending?.version === version ? pkg.pending : undefined);
    if (!item) throw new AwsError("ResourceNotFoundException", "Package version not found", 409);
    const bytes = await this.materials.read(this.binding(pkg, version), item.material);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } finally { bytes.fill(0); }
  }
  private enqueue(key: string, work: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(work).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job); void job.catch(() => undefined);
  }
  private async versions(pkg: SearchPackage, current: string): Promise<DictionaryVersion[]> {
    return Promise.all(pkg.versions.filter(version => Number(version.version) <= Number(current)).map(async version => ({ version: version.version, text: await this.text(pkg, version.version) })));
  }
  private publish(pkg: SearchPackage): void {
    this.enqueue(`package:${pkg.generation}`, () => this.store.withMutationLock(`opensearch-packages:${pkg.region}`, async () => {
      try {
        if (pkg.state === "DELETING") {
          for (const version of [...pkg.versions, ...(pkg.pending ? [pkg.pending] : [])]) await this.materials.remove(version.material);
          const catalog = this.ports.catalog(pkg.region, pkg.accountId); delete catalog.records[pkg.id];
          try { await this.store.save(); } catch (error) { catalog.records[pkg.id] = pkg; throw error; } return;
        }
        if (!pkg.pending) return;
        await this.text(pkg, pkg.pending.version);
        const previous = structuredClone(pkg), pending = pkg.pending;
        pkg.versions.push(pending); pkg.available = pending.version; delete pkg.pending; delete pkg.error; pkg.state = "AVAILABLE"; pkg.updatedAt = this.clock.now();
        try { await this.store.save(); } catch (error) { for (const key of Object.keys(pkg)) delete (pkg as any)[key]; Object.assign(pkg, previous); throw error; }
        await this.materials.commit(pending.material);
      } catch (error) { pkg.state = pkg.state === "DELETING" ? "DELETE_FAILED" : "COPY_FAILED"; pkg.error = failure(error); pkg.updatedAt = this.clock.now(); await this.store.save(); }
    }));
  }
  private apply(pkg: SearchPackage, association: Association): void {
    this.enqueue(`association:${pkg.generation}:${association.generation}`, () => this.store.withMutationLock(`opensearch-packages:${pkg.region}`, async () => {
      const removing = association.state === "DISSOCIATING";
      const previousVersion = association.activeVersion;
      try {
        const domain = this.ports.domain(association.region, association.accountId, association.domain);
        if (domain.generation !== association.generation || domain.state !== "active") throw new AwsError("ConflictException", "The associated domain generation is unavailable", 409);
        const versions = removing ? [] : await this.versions(pkg, association.version);
        await this.ports.mutate(domain, async () => { if (removing) {
          if (this.ports.inUse(domain, pkg.id)) throw new AwsError("ConflictException", "Indexes still reference this package", 409);
          const undo = this.ports.remove(domain, pkg.id); delete pkg.associations[association.generation];
          try { await this.store.save(); } catch (error) { undo(); pkg.associations[association.generation] = association; throw error; }
        } else {
          // A newer queued association cannot be overwritten by an older worker.
          if (pkg.associations[association.generation] !== association) return;
          const undo = this.ports.install(domain, pkg.id, association.version, versions); association.state = "ACTIVE"; association.activeVersion = association.version; delete association.error; association.updatedAt = this.clock.now();
          try { await this.store.save(); } catch (error) { undo(); throw error; }
        } });
      } catch (error) { if (previousVersion) association.activeVersion = previousVersion; else delete association.activeVersion; association.state = removing ? "DISSOCIATION_FAILED" : "ASSOCIATION_FAILED"; association.error = failure(error); association.updatedAt = this.clock.now(); await this.store.save(); }
    }));
  }
  async resume(): Promise<void> {
    for (const pkg of this.ports.all()) {
      if (["COPYING", "DELETING"].includes(pkg.state)) this.publish(pkg);
      for (const association of Object.values(pkg.associations)) if (["ACTIVE", "ASSOCIATING", "DISSOCIATING"].includes(association.state)) this.apply(pkg, association);
    }
    await this.drain();
  }
  async drain(): Promise<void> { await Promise.all([...this.jobs.values()]); }
  async restoreDomain(domain: DomainRecord): Promise<void> {
    for (const pkg of this.ports.all()) { const association = pkg.associations[domain.generation], version = association?.activeVersion ?? (association?.state === "ACTIVE" ? association.version : undefined); if (version) this.ports.install(domain, pkg.id, version, await this.versions(pkg, version), false); }
    this.ports.validate(domain);
  }
  async removeDomain(domain: DomainRecord): Promise<void> {
    await this.store.withMutationLock(`opensearch-packages:${domain.region}`, async () => {
      const removed = this.ports.all().flatMap(pkg => pkg.associations[domain.generation] ? [{ pkg, association: pkg.associations[domain.generation] }] : []);
      removed.forEach(item => delete item.pkg.associations[domain.generation]);
      try { await this.store.save(); } catch (error) { removed.forEach(item => item.pkg.associations[domain.generation] = item.association); throw error; }
    });
  }
  private page(list: any[], scope: string, input: any, catalog: PackageCatalog): { items: any[]; NextToken?: string } {
    const size = input.MaxResults ?? 100;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) reject("MaxResults must be between 1 and 100");
    const fingerprint = createHash("sha256").update(JSON.stringify(list)).digest("hex"), tokens = new PaginationTokens(catalog.cursorKey); let offset = 0;
    if (input.NextToken !== undefined) {
      try { if (typeof input.NextToken !== "string" || input.NextToken.length > 4096) throw new Error(); const cursor = tokens.decode<{ offset: number; fingerprint: string; expires: number }>(scope, input.NextToken); if (cursor.fingerprint !== fingerprint || cursor.expires <= this.clock.now() || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 || cursor.offset >= list.length) throw new Error(); offset = cursor.offset; } catch { reject("Invalid or stale package pagination token"); }
    }
    return { items: list.slice(offset, offset + size), ...(offset + size < list.length ? { NextToken: tokens.encode(scope, { offset: offset + size, fingerprint, expires: this.clock.now() + 600000 }) } : {}) };
  }
  async execute(operation: string, input: any, region: string, accountId: string, principal?: PrincipalContext): Promise<any> {
    object(input, operation);
    // Cross-account sharing affects one regional catalog, so its mutations share
    // a regional lock regardless of which account issued the operation.
    return this.store.withMutationLock(`opensearch-packages:${region}`, async () => {
      const catalog = this.ports.catalog(region, accountId), now = this.clock.now();
      if (["CreatePackage", "UpdatePackage"].includes(operation)) {
        const creating = operation === "CreatePackage";
        exact(input, creating ? ["PackageName", "PackageType", "PackageDescription", "PackageSource", "PackageConfiguration", "EngineVersion", "PackageVendingOptions", "PackageEncryptionOptions"] : ["PackageID", "PackageSource", "PackageDescription", "CommitMessage", "PackageConfiguration", "PackageEncryptionOptions"], operation);
        if (creating && input.PackageType !== "TXT-DICTIONARY") reject("Only data-only TXT-DICTIONARY packages are supported");
        if (input.PackageConfiguration !== undefined || input.EngineVersion !== undefined) reject("Plugin package configuration and engine-specific packages are unsupported");
        if (input.PackageEncryptionOptions !== undefined) { const encryption = object(input.PackageEncryptionOptions, "PackageEncryptionOptions"); exact(encryption, ["EncryptionEnabled"], "PackageEncryptionOptions"); if (encryption.EncryptionEnabled !== undefined && encryption.EncryptionEnabled !== true) reject("Package copies always use managed local encryption"); }
        let vending = false;
        if (input.PackageVendingOptions !== undefined) { const options = object(input.PackageVendingOptions, "PackageVendingOptions"); exact(options, ["VendingEnabled"], "PackageVendingOptions"); if (typeof options.VendingEnabled !== "boolean") reject("VendingEnabled must be boolean"); vending = options.VendingEnabled; }
        const description = bounded(input.PackageDescription, "PackageDescription", 1024, true), commitMessage = bounded(input.CommitMessage, "CommitMessage", 160, true);
        const source = object(input.PackageSource, "PackageSource"); exact(source, ["S3BucketName", "S3Key"], "PackageSource"); const bucket = bounded(source.S3BucketName, "S3BucketName", 63)!, key = bounded(source.S3Key, "S3Key", 1024)!;
        let pkg: SearchPackage;
        if (creating) {
          if (typeof input.PackageName !== "string" || !/^[a-z][a-z0-9-]{2,255}$/.test(input.PackageName)) reject("Invalid PackageName");
          if (Object.values(catalog.records).some(pkg => pkg.name === input.PackageName)) throw new AwsError("ResourceAlreadyExistsException", "Package name already exists", 409);
          if (Object.keys(catalog.records).length >= 100) throw new AwsError("LimitExceededException", "The local limit of 100 packages per account and Region was reached");
          pkg = { id: `pkg-${randomUUID().replaceAll("-", "")}`, generation: randomUUID(), name: input.PackageName, accountId, region, createdAt: now, updatedAt: now, state: "COPYING", versions: [], description, vending, users: [], associations: {} };
        } else { pkg = this.get(input.PackageID, region, accountId, true); if (pkg.state !== "AVAILABLE") throw new AwsError("ConflictException", "Package is not available for update", 409); if (pkg.versions.length >= 20) throw new AwsError("LimitExceededException", "The local limit of 20 retained package versions was reached"); }
        const content = await this.ports.source(region, accountId, bucket, key, principal);
        let material: string | undefined;
        try {
          if (!content.length || content.length > 65536) reject("Dictionary packages require 1–65536 bytes");
          let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { return reject("Dictionary packages require valid UTF-8 text"); }
          if (text.includes("\0") || text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#")).length > 1000) reject("Dictionary packages allow at most 1000 non-comment entries and no NUL characters");
          const version = String(pkg.versions.length + 1), published = await this.materials.publish(this.binding(pkg, version), content); material = published.materialId;
          const previous = structuredClone(pkg); pkg.pending = { version, material, createdAt: now, commitMessage }; pkg.state = "COPYING"; pkg.updatedAt = now; if (description !== undefined) pkg.description = description; delete pkg.error; catalog.records[pkg.id] = pkg;
          try { await this.store.save(); } catch (error) { if (creating) delete catalog.records[pkg.id]; else { Object.assign(pkg, previous); delete pkg.pending; } throw error; }
          material = undefined; const result = this.details(pkg); this.publish(pkg); return { PackageDetails: result };
        } finally { content.fill(0); if (material) await this.materials.abort(material); }
      }
      if (operation === "DescribePackages") {
        exact(input, ["Filters", "MaxResults", "NextToken"], operation);
        if (input.Filters !== undefined && (!Array.isArray(input.Filters) || input.Filters.length > 6)) reject("At most six package filters are supported");
        for (const filter of input.Filters ?? []) { object(filter, "Filter"); exact(filter, ["Name", "Value"], "Filter"); if (!["PackageID", "PackageName", "PackageStatus", "PackageType", "EngineVersion", "PackageOwner"].includes(filter.Name) || !Array.isArray(filter.Value) || !filter.Value.length || filter.Value.length > 100 || filter.Value.some((value: any) => typeof value !== "string" || !value.length || value.length > 256)) reject("Invalid package filter"); }
        const list = this.ports.all().filter(pkg => pkg.region === region && this.visible(pkg, accountId)).map(pkg => this.details(pkg)).filter(pkg => (input.Filters ?? []).every((filter: any) => filter.Value.some((value: string) => wildcard(value, String(pkg[filter.Name] ?? ""))))).sort((a, b) => a.PackageID.localeCompare(b.PackageID));
        const { items, ...page } = this.page(list, `${accountId}:${region}:${operation}:${JSON.stringify(input.Filters ?? [])}`, input, catalog); return { PackageDetailsList: items, ...page };
      }
      if (operation === "UpdatePackageScope") {
        exact(input, ["PackageID", "Operation", "PackageUserList"], operation); const pkg = this.get(input.PackageID, region, accountId, true);
        if (!pkg.vending) throw new AwsError("DisabledOperationException", "Vending must be enabled when creating the package", 409);
        if (!["ADD", "REMOVE", "OVERRIDE"].includes(input.Operation) || !Array.isArray(input.PackageUserList) || input.PackageUserList.length > 100 || input.PackageUserList.some((value: any) => typeof value !== "string" || !/^(?:\d{12}|GLOBAL)$/.test(value))) reject("Invalid package scope");
        const previous = pkg.users, users = input.Operation === "OVERRIDE" ? input.PackageUserList : input.Operation === "ADD" ? [...previous, ...input.PackageUserList] : previous.filter(value => !input.PackageUserList.includes(value));
        pkg.users = [...new Set<string>(users)]; if (pkg.users.length > 100) { pkg.users = previous; reject("Package scopes allow at most 100 accounts"); }
        try { await this.store.save(); } catch (error) { pkg.users = previous; throw error; } return { PackageID: pkg.id, Operation: input.Operation, PackageUserList: pkg.users };
      }
      if (operation === "DeletePackage") {
        exact(input, ["PackageID"], operation); const pkg = this.get(input.PackageID, region, accountId, true);
        if (Object.keys(pkg.associations).length || this.jobs.has(`package:${pkg.generation}`)) throw new AwsError("ConflictException", "Package has associations or an active operation", 409);
        const before = pkg.state; pkg.state = "DELETING"; try { await this.store.save(); } catch (error) { pkg.state = before; throw error; } const result = this.details(pkg); this.publish(pkg); return { PackageDetails: result };
      }
      if (["GetPackageVersionHistory", "ListDomainsForPackage", "ListPackagesForDomain"].includes(operation)) {
        exact(input, [operation === "ListPackagesForDomain" ? "DomainName" : "PackageID", "MaxResults", "NextToken"], operation);
        let list: any[], key: string;
        if (operation === "ListPackagesForDomain") { const domain = this.ports.domain(region, accountId, input.DomainName); list = this.ports.all().flatMap(pkg => pkg.associations[domain.generation] ? [this.associationDetails(pkg, pkg.associations[domain.generation])] : []); key = "DomainPackageDetailsList"; }
        else {
          const pkg = this.get(input.PackageID, region, accountId, operation === "ListDomainsForPackage");
          list = operation === "GetPackageVersionHistory" ? [...pkg.versions].reverse().map(version => ({ PackageVersion: version.version, CreatedAt: version.createdAt / 1000, ...(version.commitMessage === undefined ? {} : { CommitMessage: version.commitMessage }) })) : Object.values(pkg.associations).filter(association => association.accountId === accountId).map(association => this.associationDetails(pkg, association));
          key = operation === "GetPackageVersionHistory" ? "PackageVersionHistoryList" : "DomainPackageDetailsList";
        }
        const { items, ...page } = this.page(list, `${accountId}:${region}:${operation}:${input.PackageID ?? input.DomainName}`, input, catalog); return { [key]: items, ...(operation === "GetPackageVersionHistory" ? { PackageID: input.PackageID } : {}), ...page };
      }
      if (["AssociatePackage", "AssociatePackages", "DissociatePackage", "DissociatePackages"].includes(operation)) {
        const multiple = operation.endsWith("Packages"), removing = operation.startsWith("Dissociate");
        exact(input, multiple ? ["PackageList", "DomainName"] : removing ? ["PackageID", "DomainName"] : ["PackageID", "DomainName", "PrerequisitePackageIDList", "AssociationConfiguration"], operation);
        const domain = this.ports.domain(region, accountId, input.DomainName); if (domain.state !== "active") throw new AwsError("ConflictException", "Domain must be active", 409);
        const requests = multiple ? input.PackageList : [removing ? input.PackageID : input]; if (!Array.isArray(requests) || !requests.length || requests.length > 20) reject("Package associations require 1–20 packages");
        const selected = requests.map(request => {
          const id = removing ? request : object(request, "Package").PackageID;
          if (!removing && multiple) exact(request, ["PackageID", "PrerequisitePackageIDList", "AssociationConfiguration"], "Package");
          // Existing associations can be removed even after their sharing grant is revoked.
          const pkg = removing ? this.ports.all().find(pkg => pkg.id === id && pkg.associations[domain.generation]) : this.get(id, region, accountId);
          if (!pkg) throw new AwsError("ResourceNotFoundException", "Package association not found", 409);
          if (this.jobs.has(`association:${pkg.generation}:${domain.generation}`)) throw new AwsError("ConflictException", "Package association is changing", 409);
          const old = pkg.associations[domain.generation];
          if (removing) { if (this.ports.inUse(domain, pkg.id)) throw new AwsError("ConflictException", "Indexes still reference this package", 409); return { pkg, old, association: { ...old, state: "DISSOCIATING", updatedAt: now } as Association }; }
          if (request.AssociationConfiguration !== undefined) reject("Plugin association configuration is unsupported");
          const prerequisites = request.PrerequisitePackageIDList ?? []; if (!Array.isArray(prerequisites) || prerequisites.length > 20 || prerequisites.some((id: any) => typeof id !== "string" || id === pkg.id || this.get(id, region, accountId).associations[domain.generation]?.state !== "ACTIVE")) reject("Prerequisite packages must already be active on the domain");
          if (pkg.state !== "AVAILABLE" || !pkg.available) throw new AwsError("ConflictException", "Package is not available", 409);
          return { pkg, old, association: { generation: domain.generation, accountId, region, domain: domain.name, version: pkg.available, ...(old?.activeVersion ? { activeVersion: old.activeVersion } : {}), state: "ASSOCIATING", updatedAt: now, prerequisites: [...new Set<string>(prerequisites)] } as Association };
        });
        if (new Set(selected.map(item => item.pkg.id)).size !== selected.length) reject("Duplicate package IDs");
        if (!removing && this.ports.all().filter(pkg => pkg.associations[domain.generation]).length + selected.filter(item => !item.old).length > 20) throw new AwsError("LimitExceededException", "The local limit of 20 packages per domain was reached");
        if (removing) for (const { pkg } of selected) if (this.ports.all().some(other => !selected.some(item => item.pkg.id === other.id) && other.associations[domain.generation]?.prerequisites.includes(pkg.id))) throw new AwsError("ConflictException", "Another association requires this package", 409);
        selected.forEach(item => item.pkg.associations[domain.generation] = item.association);
        try { await this.store.save(); } catch (error) { selected.forEach(item => { if (item.old) item.pkg.associations[domain.generation] = item.old; else delete item.pkg.associations[domain.generation]; }); throw error; }
        const result = selected.map(item => this.associationDetails(item.pkg, item.association)); selected.forEach(item => this.apply(item.pkg, item.association)); return multiple ? { DomainPackageDetailsList: result } : { DomainPackageDetails: result[0] };
      }
      reject(`Unsupported package operation ${operation}`);
    });
  }
}
