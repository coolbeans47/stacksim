import { createHash } from "node:crypto";

export interface SqsMessageAttributeValue {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string | Uint8Array;
  StringListValues?: string[];
  BinaryListValues?: Array<string | Uint8Array>;
}

function binary(value: string | Uint8Array): Buffer {
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.from(value);
}

function sized(value: Buffer): Buffer {
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(value.length);
  return Buffer.concat([size, value]);
}

/** AWS' documented SQS message-body digest (UTF-8 bytes). */
export function md5OfMessageBody(body: string): string {
  return createHash("md5").update(body, "utf8").digest("hex");
}

/**
 * Implements the SQS message-attribute checksum framing used by AWS SDKs.
 * Attribute names are sorted by their UTF-8 byte representation, then framed
 * as name, data type, transport discriminator, and value.
 */
export function md5OfMessageAttributes(attributes: Record<string, SqsMessageAttributeValue>): string | undefined {
  const names = Object.keys(attributes).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (!names.length) return undefined;
  const chunks: Buffer[] = [];
  for (const name of names) {
    const attribute = attributes[name];
    chunks.push(sized(Buffer.from(name, "utf8")));
    chunks.push(sized(Buffer.from(attribute.DataType, "utf8")));
    const baseType = attribute.DataType.split(".", 1)[0];
    if (baseType === "Binary") {
      chunks.push(Buffer.from([2]));
      chunks.push(sized(binary(attribute.BinaryValue ?? new Uint8Array())));
    } else {
      chunks.push(Buffer.from([1]));
      chunks.push(sized(Buffer.from(attribute.StringValue ?? "", "utf8")));
    }
  }
  return createHash("md5").update(Buffer.concat(chunks)).digest("hex");
}

export function normalizeBinaryAttributeValue(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("base64");
}
