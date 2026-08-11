export function decodeBase64Strict(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = value.indexOf("=");
  if (padding >= 0 && value.length % 4 !== 0) return undefined;
  const unpadded = value.replace(/=+$/, "");
  const normalized = `${unpadded}${"=".repeat((4 - unpadded.length % 4) % 4)}`;
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) return undefined;
  return decoded;
}
