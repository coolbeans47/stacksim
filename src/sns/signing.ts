import { createHmac, createPrivateKey, sign, timingSafeEqual, X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSelfSignedSigningCertificate } from "../core/x509.js";
import type { StateStore } from "../state.js";

export interface SnsNotificationFields {
  Type: "Notification";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Subject?: string;
}

export class SnsSigner {
  readonly root: string;
  private readonly certificatePath: string;
  private readonly privateKeyPath: string;
  private certificate = "";
  private privateKey = "";

  constructor(private readonly store: StateStore) {
    this.root = resolve(store.root, "secrets", "sns");
    this.certificatePath = resolve(this.root, "signing-cert.pem");
    this.privateKeyPath = resolve(this.root, "signing-key.pem");
  }

  async start(now: number): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const [certificate, privateKey] = await Promise.all([
        readFile(this.certificatePath, "utf8"),
        readFile(this.privateKeyPath, "utf8"),
      ]);
      const parsed = new X509Certificate(certificate);
      const key = createPrivateKey(privateKey);
      if (!parsed.checkPrivateKey(key) || Date.parse(parsed.validTo) <= Date.now() + 24 * 60 * 60_000) throw new Error("SNS signing identity is invalid or expiring");
      this.certificate = certificate;
      this.privateKey = privateKey;
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const generated = createSelfSignedSigningCertificate(`stacksim SNS ${this.store.state.installation.id}`, Math.max(now, Date.now()));
    await this.atomicWrite(this.certificatePath, generated.certificate, 0o644);
    await this.atomicWrite(this.privateKeyPath, generated.privateKey, 0o600);
    this.certificate = generated.certificate;
    this.privateKey = generated.privateKey;
  }

  publicCertificate(): string {
    if (!this.certificate) throw new Error("SNS signer is not started");
    return this.certificate;
  }

  signature(fields: SnsNotificationFields, version: "1" | "2" = "1"): string {
    if (!this.privateKey) throw new Error("SNS signer is not started");
    const canonical = [
      "Message", fields.Message,
      "MessageId", fields.MessageId,
      ...(fields.Subject === undefined ? [] : ["Subject", fields.Subject]),
      "Timestamp", fields.Timestamp,
      "TopicArn", fields.TopicArn,
      "Type", fields.Type,
    ].join("\n") + "\n";
    return sign(version === "1" ? "RSA-SHA1" : "RSA-SHA256", Buffer.from(canonical, "utf8"), this.privateKey).toString("base64");
  }

  unsubscribeToken(subscriptionArn: string, generation: string): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, subscriptionArn, generation })).toString("base64url");
    const signature = createHmac("sha256", this.store.state.installation.snsEncryptionKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  verifyUnsubscribeToken(token: string): { subscriptionArn: string; generation: string } | undefined {
    const [payload, supplied, extra] = token.split(".");
    if (!payload || !supplied || extra) return undefined;
    const expected = createHmac("sha256", this.store.state.installation.snsEncryptionKey).update(payload).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return decoded?.v === 1 && typeof decoded.subscriptionArn === "string" && typeof decoded.generation === "string"
        ? { subscriptionArn: decoded.subscriptionArn, generation: decoded.generation }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async atomicWrite(path: string, contents: string, mode: number): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode });
    await rename(temporary, path);
  }
}
