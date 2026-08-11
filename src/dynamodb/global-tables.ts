import { createHash } from "node:crypto";
import { SegmentedStore } from "../persistence/segmented-store.js";
import type { DynamoGlobalTableChangeState } from "../types.js";

const tails = new Map<string, Promise<unknown>>();

export class DynamoGlobalTablePersistence {
  constructor(private readonly root: string, private readonly accountId: string) {}

  private key(tableName: string): string { return `${this.accountId}\0${tableName}`; }
  private store(tableName: string): SegmentedStore<DynamoGlobalTableChangeState> {
    const tableId = createHash("sha256").update(tableName).digest("hex");
    return new SegmentedStore(this.root, `dynamodb/global-tables/${this.accountId}/${tableId}`);
  }

  private serialize<T>(tableName: string, operation: () => Promise<T>): Promise<T> {
    const key = this.key(tableName); const previous = tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation); tails.set(key, current);
    void current.finally(() => { if (tails.get(key) === current) tails.delete(key); }).catch(() => undefined);
    return current;
  }

  append(tableName: string, change: DynamoGlobalTableChangeState): Promise<void> {
    return this.serialize(tableName, () => this.store(tableName).append(change));
  }

  read(tableName: string): Promise<DynamoGlobalTableChangeState[]> {
    return this.serialize(tableName, () => this.store(tableName).readAll());
  }
}
