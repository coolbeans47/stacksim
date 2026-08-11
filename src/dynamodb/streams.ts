import { createHash } from "node:crypto";
import { SegmentedStore } from "../persistence/segmented-store.js";
import type { DynamoStreamDescriptorState, DynamoStreamRecordState } from "../types.js";

export class DynamoStreamPersistence {
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string, private readonly accountId: string, private readonly region: string) {}

  private store(streamArn: string): SegmentedStore<DynamoStreamRecordState> { const id = createHash("sha256").update(streamArn).digest("hex"); return new SegmentedStore(this.root, `dynamodb/streams/${this.accountId}/${this.region}/${id}`); }

  private serialize<T>(streamArn: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(streamArn) ?? Promise.resolve(); const current = previous.catch(() => undefined).then(operation); this.tails.set(streamArn, current); void current.finally(() => { if (this.tails.get(streamArn) === current) this.tails.delete(streamArn); }).catch(() => undefined); return current;
  }

  read(descriptor: DynamoStreamDescriptorState): Promise<DynamoStreamRecordState[]> { return this.serialize(descriptor.streamArn, () => this.store(descriptor.streamArn).readAll()); }

  appendAndPrune(descriptor: DynamoStreamDescriptorState, record: DynamoStreamRecordState, cutoff: number): Promise<boolean> {
    return this.serialize(descriptor.streamArn, async () => { const store = this.store(descriptor.streamArn); const records = await store.readAll(); const retained = records.filter(candidate => candidate.dynamodb.ApproximateCreationDateTime * 1000 >= cutoff); const changed = retained.length !== records.length; if (changed) { descriptor.trimmedThroughSequence = records.slice(0, records.length - retained.length).at(-1)?.dynamodb.SequenceNumber ?? descriptor.trimmedThroughSequence; await store.compact(retained); } await store.append(record); return changed; });
  }

  prune(descriptor: DynamoStreamDescriptorState, cutoff: number): Promise<boolean> {
    return this.serialize(descriptor.streamArn, async () => { const store = this.store(descriptor.streamArn); const records = await store.readAll(); const retained = records.filter(record => record.dynamodb.ApproximateCreationDateTime * 1000 >= cutoff); if (retained.length === records.length) return false; descriptor.trimmedThroughSequence = records.slice(0, records.length - retained.length).at(-1)?.dynamodb.SequenceNumber ?? descriptor.trimmedThroughSequence; await store.compact(retained); return true; });
  }

  replace(descriptor: DynamoStreamDescriptorState, records: DynamoStreamRecordState[]): Promise<void> { return this.serialize(descriptor.streamArn, () => this.store(descriptor.streamArn).compact(records)); }
  clear(descriptor: DynamoStreamDescriptorState): Promise<void> { return this.serialize(descriptor.streamArn, () => this.store(descriptor.streamArn).clear()); }
}
