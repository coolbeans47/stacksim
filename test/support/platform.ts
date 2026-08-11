import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

export async function assertPrivateFile(path: string): Promise<void> {
  const details = await stat(path);
  assert.equal(details.isFile(), true, `${path} must be a regular file`);
  if (process.platform !== "win32") assert.equal(details.mode & 0o777, 0o600, `${path} must use mode 0600`);
}

export function slashPath(value: string): string {
  return value.replaceAll("\\", "/");
}
