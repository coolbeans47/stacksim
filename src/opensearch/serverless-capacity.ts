import { AwsError } from "../errors.js";
import { SearchError } from "./query.js";

export interface GroupLimits { minIndexingCapacityInOCU: number; maxIndexingCapacityInOCU: number; minSearchCapacityInOCU: number; maxSearchCapacityInOCU: number }
export type ServerlessGeneration = "CLASSIC" | "NEXTGEN";
export function groupLimits(generation: ServerlessGeneration, input: Partial<GroupLimits> = {}, previous?: GroupLimits): GroupLimits {
  const limits = { minIndexingCapacityInOCU: generation === "NEXTGEN" ? 0 : 1, maxIndexingCapacityInOCU: 96, minSearchCapacityInOCU: generation === "NEXTGEN" ? 0 : 1, maxSearchCapacityInOCU: 96, ...previous, ...input };
  for (const [name, value] of Object.entries(limits)) {
    const zero = generation === "NEXTGEN" && name.startsWith("min") && value === 0;
    const valid = Number.isInteger(value) && value <= 1696 && (generation === "CLASSIC" && value === 1 || [2, 4, 8].includes(value) || value >= 16 && value % 16 === 0);
    if (!zero && !valid) throw new AwsError("ValidationException", "Group capacity must use its generation's supported OCU tiers (up to 1696); only NextGen minimums may be zero", 400);
  }
  if (limits.minIndexingCapacityInOCU > limits.maxIndexingCapacityInOCU || limits.minSearchCapacityInOCU > limits.maxSearchCapacityInOCU) throw new AwsError("ValidationException", "Minimum capacity cannot exceed maximum capacity", 400);
  return limits;
}

/** OCU settings allocate bounded local admission slots, never cloud workers. */
export class ServerlessCapacity {
  private pools = new Map<string, { read: { active: number; allocated: number; last: number }; write: { active: number; allocated: number; last: number } }>();
  constructor(private readonly now: () => number) {}
  private pool(key: string, limits: GroupLimits) {
    let pool = this.pools.get(key);
    if (!pool) { pool = { read: { active: 0, allocated: limits.minSearchCapacityInOCU, last: this.now() }, write: { active: 0, allocated: limits.minIndexingCapacityInOCU, last: this.now() } }; this.pools.set(key, pool); }
    for (const kind of ["read", "write"] as const) {
      const part = pool[kind], min = kind === "read" ? limits.minSearchCapacityInOCU : limits.minIndexingCapacityInOCU, max = kind === "read" ? limits.maxSearchCapacityInOCU : limits.maxIndexingCapacityInOCU;
      part.allocated = Math.max(min, Math.min(max, part.allocated));
      if (!part.active && this.now() - part.last >= 600000) part.allocated = min;
    }
    return pool;
  }
  admit(key: string, limits: GroupLimits, kind: "read" | "write", generation: ServerlessGeneration = "CLASSIC"): () => void {
    const pool = this.pool(key, limits), part = pool[kind], maximum = kind === "read" ? limits.maxSearchCapacityInOCU : limits.maxIndexingCapacityInOCU;
    if (part.active >= Math.min(32, maximum * 4)) throw new SearchError("rejected_execution_exception", "Serverless pool admission capacity exhausted", 429);
    part.active++; part.last = this.now();
    const needed = Math.ceil(part.active / 4), tiers = generation === "NEXTGEN" ? [2, 4, 8, 16] : [1, 2, 4, 8, 16];
    part.allocated = Math.max(part.allocated, Math.min(maximum, tiers.find(tier => tier >= needed) ?? needed));
    let released = false;
    return () => { if (!released) { released = true; part.active--; part.last = this.now(); } };
  }
  current(key: string, limits: GroupLimits) {
    const pool = this.pool(key, limits);
    return { search: { capacityInOcu: pool.read.allocated, autoscalingStatus: "NO_ACTION" }, indexing: { capacityInOcu: pool.write.allocated, autoscalingStatus: "NO_ACTION" } };
  }
  remove(key: string): void { this.pools.delete(key); }
  clear(): void { this.pools.clear(); }
}
