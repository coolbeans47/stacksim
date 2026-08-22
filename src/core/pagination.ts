import { createHmac, timingSafeEqual } from "node:crypto";

export class PaginationTokens {
  constructor(private readonly secret: string) {}
  encode(operation: string, cursor: unknown): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, operation, cursor })).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }
  decode<T>(operation: string, token: string): T {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw new Error("Invalid pagination token");
    const expected = Buffer.from(createHmac("sha256", this.secret).update(payload).digest("base64url"), "ascii");
    const actual = Buffer.from(signature, "ascii");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid pagination token");
    let decoded: any;
    try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Invalid pagination token"); }
    if (decoded.v !== 1 || decoded.operation !== operation) throw new Error("Invalid pagination token");
    return decoded.cursor as T;
  }
}
