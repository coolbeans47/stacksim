import { randomBytes } from "node:crypto";

export function requestId(): string {
  return randomBytes(16).toString("hex");
}
