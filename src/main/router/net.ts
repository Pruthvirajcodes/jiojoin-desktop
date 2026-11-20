import { isIPv4 } from "node:net";

/** RFC 1918, link-local and CGNAT ranges: the only places a home router lives. */
export function isPrivateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
