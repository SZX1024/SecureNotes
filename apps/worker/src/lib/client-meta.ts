/**
 * Coarse request metadata for sessions and audit logs (§4, §5).
 *
 * The requirements are explicit that the full IP and the full User-Agent are
 * never stored or shown: an audit entry keeps a network prefix and a
 * browser/OS category, nothing more.
 */

/** Truncates an address to its network prefix: IPv4 /24, IPv6 /48. */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) {
    return null;
  }
  // Drop any zone index ("%eth0") before parsing.
  const value = (ip.trim().split("%")[0] ?? "").trim();
  if (value.length === 0) {
    return null;
  }

  if (value.includes(":")) {
    const hextets = value.split(":").filter((group) => group.length > 0);
    if (hextets.length === 0) {
      return null;
    }
    // Only the first three hextets are kept, so the stored value can never be
    // the full address. The result is a coarse label for audit display and
    // rate-limit bucketing, not a routable prefix.
    return `${hextets.slice(0, 3).join(":")}::/48`;
  }

  const octets = value.split(".");
  if (octets.length === 4 && octets.every((octet) => /^[0-9]{1,3}$/.test(octet))) {
    return `${octets.slice(0, 3).join(".")}.0/24`;
  }
  // Anything unexpected is not stored rather than stored raw.
  return null;
}

const BROWSER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Firefox", /firefox\/[\d.]+/i],
  ["Edge", /edg\/[\d.]+/i],
  ["Chrome", /chrome\/[\d.]+/i],
  ["Safari", /safari\/[\d.]+/i],
];

const OS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Windows", /windows nt/i],
  ["Android", /android/i],
  ["iOS", /iphone|ipad|ipod/i],
  ["macOS", /mac os x/i],
  ["Linux", /linux/i],
];

/**
 * Maps a User-Agent to `"<browser> on <os>"`. Unknown clients collapse to
 * "Unknown", so a novel or spoofed agent string cannot smuggle arbitrary text
 * into the database or the device list.
 */
export function classifyClient(userAgent: string | null | undefined): string {
  if (!userAgent) {
    return "Unknown";
  }
  const browser = BROWSER_PATTERNS.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "Unknown";
  const os = OS_PATTERNS.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "Unknown";
  return `${browser} on ${os}`;
}
