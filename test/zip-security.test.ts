import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createZip } from "../src/core/zip-create.js";
import { extractZip, readZipEntries } from "../src/zip.js";

function centralOffset(zip: Buffer): number { return zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); }
function eocdOffset(zip: Buffer): number { return zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); }

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function descriptorZip(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name); const bytes = Buffer.from(content); const compressed = deflateRawSync(bytes); const checksum = crc32(bytes);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0008, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(nameBytes.length, 26);
  const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(bytes.length, 12);
  const centralOffset = local.length + nameBytes.length + compressed.length + descriptor.length;
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0008, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, compressed, descriptor, central, nameBytes, end]);
}

function renamed(zip: Buffer, name: string): Buffer {
  const result = Buffer.from(zip);
  const localLength = result.readUInt16LE(26);
  const central = centralOffset(result);
  const centralLength = result.readUInt16LE(central + 28);
  const bytes = Buffer.from(name);
  assert.equal(bytes.length, localLength);
  assert.equal(bytes.length, centralLength);
  bytes.copy(result, 30);
  bytes.copy(result, central + 46);
  return result;
}

test("ZIP reader validates the complete archive before filesystem mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-zip-security-"));
  const destination = join(root, "expanded");
  try {
    const valid = createZip([{ name: "assets/app.js", content: "exact javascript" }, { name: "index.html", content: "<main>exact</main>" }]);
    const archive = readZipEntries(valid, { maxEntryCount: 2, maxEntrySize: 64, maxUncompressedSize: 128 });
    assert.deepEqual(archive.entries.map(entry => entry.name), ["assets/app.js", "index.html"]);
    assert.equal(archive.fileCount, 2);
    await extractZip(valid, destination, { maxEntryCount: 2, maxEntrySize: 64, maxUncompressedSize: 128 });
    assert.equal(await readFile(join(destination, "assets", "app.js"), "utf8"), "exact javascript");

    const corrupt = Buffer.from(createZip([{ name: "first.js", content: "first" }, { name: "second.js", content: "second" }]));
    corrupt[30 + Buffer.byteLength("first.js")] ^= 0xff;
    const untouched = join(root, "corrupt-output");
    await assert.rejects(extractZip(corrupt, untouched), /checksum|corrupt/i);
    await assert.rejects(access(untouched));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("filesystem extraction rejects Windows device, alternate-stream, and trailing-dot paths before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-zip-portable-"));
  try {
    for (const [index, name] of ["NUL.txt", "assets/file:stream", "assets/trailing. "].entries()) {
      const archive = createZip([{ name, content: "unsafe on Windows" }]);
      assert.equal(readZipEntries(archive).entries[0].name, name, "S3-only ZIP validation should preserve valid object-key characters");
      const destination = join(root, `expanded-${index}`);
      await assert.rejects(extractZip(archive, destination), /portable filesystem extraction/i);
      await assert.rejects(access(destination));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ZIP reader supports bounded deflate entries with a validated data descriptor", () => {
  const archive = readZipEntries(descriptorZip("assets/app.js", "descriptor-compressed"));
  assert.equal(archive.entries[0].name, "assets/app.js");
  assert.equal(archive.entries[0].content.toString(), "descriptor-compressed");
  const corrupt = descriptorZip("assets/app.js", "descriptor-compressed");
  const descriptor = 30 + Buffer.byteLength("assets/app.js") + deflateRawSync(Buffer.from("descriptor-compressed")).length;
  corrupt.writeUInt32LE(0, descriptor + 4);
  assert.throws(() => readZipEntries(corrupt), /descriptor/i);
});

test("ZIP reader rejects traversal, absolute, backslash, duplicate, symlink, nonregular, and overlapping entries", () => {
  const base = createZip([{ name: "safe.js", content: "safe" }]);
  for (const unsafe of ["../evil", "/bad.js", "bad\\.js"]) assert.throws(() => readZipEntries(renamed(base, unsafe)), /unsafe/i);
  assert.throws(() => readZipEntries(createZip([{ name: "same.txt", content: "one" }, { name: "same.txt", content: "two" }])), /duplicate/i);

  const symlink = Buffer.from(base);
  const central = centralOffset(symlink);
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  assert.throws(() => readZipEntries(symlink), /symbolic link/i);

  const fifo = Buffer.from(base);
  fifo.writeUInt32LE((0o010644 << 16) >>> 0, centralOffset(fifo) + 38);
  assert.throws(() => readZipEntries(fifo), /non-regular/i);

  const overlap = createZip([{ name: "first.js", content: "first" }, { name: "other.js", content: "other" }]);
  const firstCentral = centralOffset(overlap);
  const secondCentral = firstCentral + 46 + Buffer.byteLength("first.js");
  const modified = Buffer.from(overlap);
  modified.writeUInt32LE(0, secondCentral + 42);
  assert.throws(() => readZipEntries(modified), /inconsistent|overlap/i);
});

test("ZIP reader rejects corrupt, encrypted, multidisk, ZIP64, and over-limit archives", () => {
  const base = createZip([{ name: "safe.js", content: "0123456789" }]);
  const corrupt = Buffer.from(base);
  corrupt[30 + Buffer.byteLength("safe.js")] ^= 0x01;
  assert.throws(() => readZipEntries(corrupt), /checksum|corrupt/i);

  const encrypted = Buffer.from(base);
  encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt16LE(1, centralOffset(encrypted) + 8);
  assert.throws(() => readZipEntries(encrypted), /encrypted|unsupported/i);

  const multidisk = Buffer.from(base);
  multidisk.writeUInt16LE(1, eocdOffset(multidisk) + 4);
  assert.throws(() => readZipEntries(multidisk), /multi-disk/i);

  const zip64 = Buffer.from(base);
  zip64.writeUInt32LE(0xffffffff, eocdOffset(zip64) + 12);
  assert.throws(() => readZipEntries(zip64), /ZIP64/i);

  assert.throws(() => readZipEntries(base, { maxEntryCount: 0 }), /more than 0 entries/i);
  assert.throws(() => readZipEntries(base, { maxEntrySize: 9 }), /per-entry/i);
  assert.throws(() => readZipEntries(base, { maxUncompressedSize: 9 }), /Unzipped size/i);
});
