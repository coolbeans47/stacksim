import type { IncomingMessage } from "node:http";
import { AwsError } from "../errors.js";
import { readBody } from "../util.js";

const operations = new Map([
  ["/Execute", "ExecuteStatement"], ["/BatchExecute", "BatchExecuteStatement"], ["/BeginTransaction", "BeginTransaction"],
  ["/CommitTransaction", "CommitTransaction"], ["/RollbackTransaction", "RollbackTransaction"], ["/ExecuteSql", "ExecuteSql"],
]);
export function rdsDataOperation(pathname: string): string | undefined { return operations.get(pathname); }

export async function readRdsDataBody(req: IncomingMessage): Promise<Buffer> {
  const headerBytes = req.rawHeaders.reduce((bytes, value) => bytes + Buffer.byteLength(value) + 2, 0);
  const bytes = 4 * 1024 * 1024 - headerBytes;
  const exceeded = () => new AwsError("BadRequestException", "The request exceeds 4 MiB", 413);
  if (bytes < 0 || Number(req.headers["content-length"]) > bytes) {
    req.resume();
    throw exceeded();
  }
  return readBody(req, { bytes, exceeded });
}
