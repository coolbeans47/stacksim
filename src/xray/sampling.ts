import type { Clock } from "../core/clock.js";
import type { SamplingDecision } from "./trace-header.js";

export interface SamplingResult {
  sampled: boolean;
  source: "upstream" | "default" | "passive";
  ruleName?: "Default";
}

export class XRayDefaultSampler {
  private readonly reservoirs = new Map<string, number>();

  constructor(private readonly clock: Clock, private readonly random: () => number = Math.random) {}

  decide(accountId: string, region: string, active: boolean, upstream: SamplingDecision): SamplingResult {
    if (upstream === "sampled") return { sampled: true, source: "upstream" };
    if (upstream === "not-sampled") return { sampled: false, source: "upstream" };
    if (!active) return { sampled: false, source: "passive" };
    const second = Math.floor(this.clock.now() / 1000);
    const key = `${accountId}\0${region}`;
    if (this.reservoirs.get(key) !== second) {
      this.reservoirs.set(key, second);
      return { sampled: true, source: "default", ruleName: "Default" };
    }
    return { sampled: this.random() < 0.05, source: "default", ruleName: "Default" };
  }
}

