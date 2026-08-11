import type { Writable } from "node:stream";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function stringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name); const valueBytes = Buffer.from(value);
  const output = Buffer.allocUnsafe(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  output.writeUInt8(nameBytes.length, 0); nameBytes.copy(output, 1); output.writeUInt8(7, 1 + nameBytes.length); output.writeUInt16BE(valueBytes.length, 2 + nameBytes.length); valueBytes.copy(output, 4 + nameBytes.length);
  return output;
}

export function eventStreamMessage(eventType: string, payload: Buffer, contentType: string): Buffer {
  const headers = Buffer.concat([
    stringHeader(":event-type", eventType),
    stringHeader(":message-type", "event"),
    stringHeader(":content-type", contentType),
  ]);
  const totalLength = 16 + headers.length + payload.length; const output = Buffer.allocUnsafe(totalLength);
  output.writeUInt32BE(totalLength, 0); output.writeUInt32BE(headers.length, 4); output.writeUInt32BE(crc32(output.subarray(0, 8)), 8); headers.copy(output, 12); payload.copy(output, 12 + headers.length); output.writeUInt32BE(crc32(output.subarray(0, totalLength - 4)), totalLength - 4);
  return output;
}

export async function writeWithBackpressure(stream: Writable, value: Buffer | string): Promise<void> {
  if (stream.destroyed) throw new Error("The response stream was closed");
  if (stream.write(value)) return;
  await new Promise<void>((resolve, reject) => { const cleanup = () => { stream.off("drain", drained); stream.off("error", failed); stream.off("close", closed); }; const drained = () => { cleanup(); resolve(); }; const failed = (error: Error) => { cleanup(); reject(error); }; const closed = () => { cleanup(); reject(new Error("The response stream was closed")); }; stream.once("drain", drained); stream.once("error", failed); stream.once("close", closed); });
}
