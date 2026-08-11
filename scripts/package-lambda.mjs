import { mkdir, readFile, writeFile } from "node:fs/promises";

const output = new URL("../examples/lambda/function.zip", import.meta.url);
const entries = [
  { name: "handler.js", content: await readFile(new URL("../.lambda-build/handler.js", import.meta.url)) },
  { name: "package.json", content: Buffer.from('{"type":"commonjs"}') },
];
const localParts = []; const centralParts = []; let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name); let crc = 0xffffffff;
  for (const byte of entry.content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.content.length, 18); local.writeUInt32LE(entry.content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.content.length, 20); central.writeUInt32LE(entry.content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  const localPart = Buffer.concat([local, name, entry.content]); localParts.push(localPart); centralParts.push(Buffer.concat([central, name])); offset += localPart.length;
}
const centralDirectory = Buffer.concat(centralParts); const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralDirectory.length, 12); eocd.writeUInt32LE(offset, 16);
await mkdir(new URL("../examples/lambda/", import.meta.url), { recursive: true });
await writeFile(output, Buffer.concat([...localParts, centralDirectory, eocd]));
console.log(`Created ${output.pathname}`);
