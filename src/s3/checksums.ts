import { createHash, type Hash } from "node:crypto";
import { Crc32, Crc32c, Crc64Nvme } from "@aws-sdk/checksums/crc";
import { createXXHash128, createXXHash3, createXXHash64 } from "hash-wasm";
import { AwsError } from "../errors.js";

export type S3ChecksumAlgorithm = "CRC32" | "CRC32C" | "CRC64NVME" | "MD5" | "SHA1" | "SHA256" | "SHA512" | "XXHASH64" | "XXHASH3" | "XXHASH128";
export type S3ChecksumValues = Partial<Record<S3ChecksumAlgorithm, string>>;

export class S3Checksums {
  readonly md5: Hash = createHash("md5");
  readonly sha1: Hash = createHash("sha1");
  readonly sha256: Hash = createHash("sha256");
  readonly sha512: Hash = createHash("sha512");
  readonly crc32 = new Crc32();
  readonly crc32c = new Crc32c();
  readonly crc64nvme = new Crc64Nvme();
  private readonly xxhashers = Promise.all([createXXHash64(), createXXHash3(), createXXHash128()]);
  size = 0;

  async update(chunk: Uint8Array): Promise<void> {
    this.size += chunk.byteLength;
    this.md5.update(chunk); this.sha1.update(chunk); this.sha256.update(chunk); this.sha512.update(chunk);
    this.crc32.update(chunk); this.crc32c.update(chunk); this.crc64nvme.update(chunk);
    const [xxhash64, xxhash3, xxhash128] = await this.xxhashers; xxhash64.update(chunk); xxhash3.update(chunk); xxhash128.update(chunk);
  }

  async digest(): Promise<{ etag: string; md5: string; sha256Hex: string; values: S3ChecksumValues }> {
    const md5Buffer = this.md5.digest();
    const sha256Buffer = this.sha256.digest();
    const [crc32, crc32c, crc64nvme, xxhashers] = await Promise.all([this.crc32.digest(), this.crc32c.digest(), this.crc64nvme.digest(), this.xxhashers]);
    return {
      etag: md5Buffer.toString("hex"),
      md5: md5Buffer.toString("base64"),
      sha256Hex: sha256Buffer.toString("hex"),
      values: {
        CRC32: Buffer.from(crc32).toString("base64"),
        CRC32C: Buffer.from(crc32c).toString("base64"),
        CRC64NVME: Buffer.from(crc64nvme).toString("base64"),
        MD5: md5Buffer.toString("base64"),
        SHA1: this.sha1.digest("base64"),
        SHA256: sha256Buffer.toString("base64"),
        SHA512: this.sha512.digest("base64"),
        XXHASH64: Buffer.from(xxhashers[0].digest("binary")).toString("base64"),
        XXHASH3: Buffer.from(xxhashers[1].digest("binary")).toString("base64"),
        XXHASH128: Buffer.from(xxhashers[2].digest("binary")).toString("base64"),
      },
    };
  }
}

export function checksumHeaderName(algorithm: S3ChecksumAlgorithm): string {
  return `x-amz-checksum-${algorithm.toLowerCase()}`;
}

export const S3_CHECKSUM_ALGORITHMS: readonly S3ChecksumAlgorithm[] = ["CRC32", "CRC32C", "CRC64NVME", "MD5", "SHA1", "SHA256", "SHA512", "XXHASH64", "XXHASH3", "XXHASH128"];

export function providedChecksumAlgorithms(headers: Record<string, string | string[] | undefined>, trailers: Record<string, string> = {}): S3ChecksumAlgorithm[] {
  return S3_CHECKSUM_ALGORITHMS.filter(algorithm => {
    const header = checksumHeaderName(algorithm);
    return headers[header] !== undefined || trailers[header] !== undefined;
  });
}

export function requestedChecksumAlgorithm(value: string | string[] | undefined): S3ChecksumAlgorithm | undefined {
  if (value === undefined) return undefined;
  const algorithm = String(Array.isArray(value) ? value[0] : value).toUpperCase();
  if (S3_CHECKSUM_ALGORITHMS.includes(algorithm as S3ChecksumAlgorithm)) return algorithm as S3ChecksumAlgorithm;
  throw new AwsError("InvalidRequest", `Unsupported checksum algorithm ${algorithm}`, 400);
}

export function validateProvidedChecksums(headers: Record<string, string | string[] | undefined>, trailers: Record<string, string>, digest: { md5: string; values: S3ChecksumValues }): void {
  const contentMd5 = headers["content-md5"];
  if (contentMd5 !== undefined && String(contentMd5) !== digest.md5) throw new AwsError("BadDigest", "The Content-MD5 you specified did not match what we received.", 400);
  for (const algorithm of S3_CHECKSUM_ALGORITHMS) {
    const name = checksumHeaderName(algorithm); const supplied = trailers[name] ?? (headers[name] === undefined ? undefined : String(headers[name]));
    if (supplied !== undefined && supplied !== digest.values[algorithm]) throw new AwsError("BadDigest", `The ${algorithm} checksum you specified did not match what we received.`, 400);
  }
}
