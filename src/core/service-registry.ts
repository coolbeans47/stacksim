import type { AwsRequestContext } from "./request-context.js";

export type ServiceHandler<TRequest = unknown, TResponse = unknown> =
  (request: TRequest, context: AwsRequestContext) => Promise<TResponse> | TResponse;

export class ServiceRegistry {
  private readonly handlers = new Map<string, ServiceHandler>();

  register(service: string, operation: string, handler: ServiceHandler): void {
    const key = this.key(service, operation);
    if (this.handlers.has(key)) throw new Error(`Handler already registered for ${service}.${operation}`);
    this.handlers.set(key, handler);
  }

  has(service: string, operation: string): boolean {
    return this.handlers.has(this.key(service, operation));
  }

  async dispatch(service: string, operation: string, request: unknown, context: AwsRequestContext): Promise<unknown> {
    const handler = this.handlers.get(this.key(service, operation));
    if (!handler) throw new Error(`Unknown operation ${service}.${operation}`);
    return handler(request, context);
  }

  list(): Array<{ service: string; operation: string }> {
    return [...this.handlers.keys()].sort().map(key => {
      const [service, operation] = key.split("\0");
      return { service, operation };
    });
  }

  private key(service: string, operation: string): string { return `${service}\0${operation}`; }
}
