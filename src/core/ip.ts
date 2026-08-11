import { BlockList, isIP } from "node:net";

export function validIpOrCidr(value: string): boolean {
  const pieces = value.split("/");
  if (pieces.length > 2 || !isIP(pieces[0])) return false;
  if (pieces.length === 1) return true;
  if (!/^\d+$/.test(pieces[1])) return false;
  const prefix = Number(pieces[1]);
  return prefix >= 0 && prefix <= (isIP(pieces[0]) === 4 ? 32 : 128);
}

export function cidrMatches(actual: string, expected: string): boolean {
  if (!validIpOrCidr(expected)) return false;
  const [network, prefixText] = expected.split("/");
  const family = isIP(network);
  if (!family || isIP(actual) !== family) return false;
  if (prefixText === undefined) return actual === network;
  try {
    const block = new BlockList();
    block.addSubnet(network, Number(prefixText), family === 4 ? "ipv4" : "ipv6");
    return block.check(actual, family === 4 ? "ipv4" : "ipv6");
  } catch { return false; }
}
