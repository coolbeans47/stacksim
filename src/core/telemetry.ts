export interface TelemetryEvent {
  namespace: "AWS/Lambda" | "AWS/ApiGateway" | "AWS/DynamoDB" | "AWS/SQS" | string;
  metricName: string;
  dimensions: Record<string, string>;
  value: number;
  unit: string;
  timestamp: number;
  /** Gauges keep the latest sample in a minute; ordinary samples accumulate statistics. */
  aggregation?: "sample" | "gauge";
}

export type TelemetrySubscriber = (event: TelemetryEvent) => void | Promise<void>;

export class TelemetryBus {
  private readonly subscribers = new Set<TelemetrySubscriber>();

  subscribe(subscriber: TelemetrySubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async publish(event: TelemetryEvent): Promise<void> {
    await Promise.all([...this.subscribers].map(subscriber => subscriber(event)));
  }
}
