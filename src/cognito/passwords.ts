import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AwsError } from "../errors.js";
import type { CognitoPasswordHashState, CognitoPasswordPolicyState } from "../types.js";
import { CognitoSecurityError } from "./secrets.js";

export const COGNITO_PASSWORD_KDF = Object.freeze({
  version: 1 as const,
  algorithm: "scrypt" as const,
  N: 32_768 as const,
  r: 8 as const,
  p: 1 as const,
  maxmem: 67_108_864 as const,
  saltBytes: 16,
  outputBytes: 32,
  maximumConcurrentJobs: 4,
  maximumInputBytes: 256,
});

class AsyncJobLimit {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function passwordBytes(password: unknown): Buffer {
  if (typeof password !== "string") {
    throw new AwsError("InvalidPasswordException", "Password must be a string.");
  }
  const value = Buffer.from(password, "utf8");
  if (value.length > COGNITO_PASSWORD_KDF.maximumInputBytes) {
    value.fill(0);
    throw new AwsError("InvalidPasswordException", "Password exceeds the supported input length.");
  }
  return value;
}

function decodeRecordValue(value: string, bytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CognitoSecurityError("Cognito password verifier state is invalid.");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new CognitoSecurityError("Cognito password verifier state is invalid.");
  }
  return decoded;
}

function assertRecord(record: CognitoPasswordHashState): void {
  if (
    !record
    || record.version !== COGNITO_PASSWORD_KDF.version
    || record.algorithm !== COGNITO_PASSWORD_KDF.algorithm
    || record.N !== COGNITO_PASSWORD_KDF.N
    || record.r !== COGNITO_PASSWORD_KDF.r
    || record.p !== COGNITO_PASSWORD_KDF.p
    || record.maxmem !== COGNITO_PASSWORD_KDF.maxmem
  ) {
    throw new CognitoSecurityError("Cognito password verifier state is invalid.");
  }
}

export function validatePasswordPolicy(password: unknown, policy: CognitoPasswordPolicyState): void {
  if (typeof password !== "string") {
    throw new AwsError("InvalidPasswordException", "Password must be a string.");
  }
  const failures: string[] = [];
  if ([...password].length < policy.minimumLength) failures.push(`at least ${policy.minimumLength} characters`);
  if (policy.requireUppercase && !/\p{Lu}/u.test(password)) failures.push("an uppercase character");
  if (policy.requireLowercase && !/\p{Ll}/u.test(password)) failures.push("a lowercase character");
  if (policy.requireNumbers && !/\p{N}/u.test(password)) failures.push("a number");
  if (policy.requireSymbols && !/[^\p{L}\p{N}\s]/u.test(password)) failures.push("a symbol");
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes > COGNITO_PASSWORD_KDF.maximumInputBytes) failures.push("no more than 256 UTF-8 bytes");
  if (failures.length) {
    throw new AwsError("InvalidPasswordException", `Password must contain ${failures.join(", ")}.`);
  }
}

export class CognitoPasswordHasher {
  private readonly jobs = new AsyncJobLimit(COGNITO_PASSWORD_KDF.maximumConcurrentJobs);
  private readonly dummySalt = randomBytes(COGNITO_PASSWORD_KDF.saltBytes);
  private readonly dummyDigest = randomBytes(COGNITO_PASSWORD_KDF.outputBytes);

  private async derive(password: Buffer, salt: Buffer): Promise<Buffer> {
    return this.jobs.run(() => new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        COGNITO_PASSWORD_KDF.outputBytes,
        {
          N: COGNITO_PASSWORD_KDF.N,
          r: COGNITO_PASSWORD_KDF.r,
          p: COGNITO_PASSWORD_KDF.p,
          maxmem: COGNITO_PASSWORD_KDF.maxmem,
        },
        (error, derived) => error ? reject(error) : resolve(Buffer.from(derived)),
      );
    }));
  }

  async hash(password: unknown): Promise<CognitoPasswordHashState> {
    const input = passwordBytes(password);
    const salt = randomBytes(COGNITO_PASSWORD_KDF.saltBytes);
    try {
      const digest = await this.derive(input, salt);
      try {
        return {
          version: COGNITO_PASSWORD_KDF.version,
          algorithm: COGNITO_PASSWORD_KDF.algorithm,
          N: COGNITO_PASSWORD_KDF.N,
          r: COGNITO_PASSWORD_KDF.r,
          p: COGNITO_PASSWORD_KDF.p,
          maxmem: COGNITO_PASSWORD_KDF.maxmem,
          salt: salt.toString("base64url"),
          digest: digest.toString("base64url"),
        };
      } finally {
        digest.fill(0);
      }
    } finally {
      input.fill(0);
      salt.fill(0);
    }
  }

  async verify(password: unknown, record: CognitoPasswordHashState): Promise<boolean> {
    assertRecord(record);
    const input = passwordBytes(password);
    const salt = decodeRecordValue(record.salt, COGNITO_PASSWORD_KDF.saltBytes);
    const expected = decodeRecordValue(record.digest, COGNITO_PASSWORD_KDF.outputBytes);
    try {
      const actual = await this.derive(input, salt);
      try {
        return timingSafeEqual(actual, expected);
      } finally {
        actual.fill(0);
      }
    } finally {
      input.fill(0);
      salt.fill(0);
      expected.fill(0);
    }
  }

  async dummy(password: unknown): Promise<false> {
    const input = passwordBytes(password);
    try {
      const actual = await this.derive(input, this.dummySalt);
      try {
        timingSafeEqual(actual, this.dummyDigest);
      } finally {
        actual.fill(0);
      }
      return false;
    } finally {
      input.fill(0);
    }
  }
}
