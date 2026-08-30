// Pseudonymised client address for the signup rate limiter.
//
// Keyed HMAC rather than sha256(ip + salt): concatenation leaves the
// delimiter and ordering as unstated convention that a later edit can change
// without anyone noticing, which silently resets every bucket.
//
// This is a cost and reputation control, NOT an authorization boundary.
// Forwarded headers are attacker-influenced.
import { createHmac } from "crypto";

/**
 * One client, one bucket.
 *
 * IPv6 is normalised to RFC 5952 form: expanded to eight groups, leading
 * zeros stripped, lowercased, then the longest run of zero groups compressed
 * to `::` (leftmost wins on a tie, and a single zero group is never
 * compressed). IPv4-mapped forms reduce to the IPv4 address.
 *
 * Compression is load-bearing, not cosmetic. One IPv6 address has many valid
 * textual spellings — leading zeros in any group, `::` over any run of zeros —
 * so lowercasing alone lets a client mint a fresh bucket per spelling and walk
 * straight past the limit. That is a bypass of the limiter, not a degradation
 * of it.
 *
 * Anything that is not an IPv6 literal this function can parse with
 * confidence is returned as it arrived, trimmed and lowercased: a bare IPv4
 * address, `"unknown"`, a `%zone` or `:port` suffix, an IPv4 octet with a
 * leading zero (`010` is decimal to some resolvers and octal to others).
 * Passing those through keeps each in its own bucket rather than mangling one
 * into a collision with a real address.
 *
 * Known gap, stated rather than dismissed: a port suffix is not stripped, so
 * a proxy that appended the source port would hand every connection its own
 * bucket and defeat the limiter. Callers pass a bare address today
 * (`NextRequest.ip`, or the first `x-forwarded-for` entry), and no proxy in
 * front of this application emits one — if that ever changes, the suffix has
 * to be stripped here.
 */
export function canonicalIp(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  let ip = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!ip) return "unknown";
  ip = ip.toLowerCase();

  const groups = parseIpv6(ip);
  if (!groups) return ip;

  // IPv4-mapped (::ffff:a.b.c.d) and every expansion of it are one client.
  // Reduced from the parsed groups rather than by matching the compressed
  // spelling, so `0:0:0:0:0:ffff:1.2.3.4` lands in the same bucket as
  // `::ffff:1.2.3.4` and as a bare `1.2.3.4`.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }

  return formatIpv6(groups);
}

export function hashIp(raw: string | null | undefined, secret: string): string {
  if (!secret) {
    throw new Error("hashIp: secret must be a non-empty string");
  }
  return createHmac("sha256", secret).update(canonicalIp(raw)).digest("hex");
}

// ─── RFC 5952 ────────────────────────────────────────────────────────────────
// Node has no built-in for this. `net.isIPv6` only validates, and the URL
// parser normalises hosts but rejects a bare address that is not part of a
// URL, so the normalisation is written out here.

/**
 * Parses an already-lowercased IPv6 literal into its eight 16-bit groups, or
 * returns null for anything it cannot read with confidence. The caller treats
 * null as "leave the string alone".
 */
function parseIpv6(ip: string): number[] | null {
  if (!ip.includes(":")) return null;

  // At most one `::`. `indexOf !== lastIndexOf` also rejects `:::`.
  const gap = ip.indexOf("::");
  if (gap !== ip.lastIndexOf("::")) return null;

  if (gap === -1) {
    // Fully written out: exactly eight groups, with a trailing dotted quad
    // allowed to stand in for the last two.
    const all = parseGroups(ip, true);
    return all && all.length === 8 ? all : null;
  }

  // A dotted quad is only ever legal as the final piece, so it is permitted
  // in the tail half and refused in the head half.
  const head = parseGroups(ip.slice(0, gap), false);
  const tail = parseGroups(ip.slice(gap + 2), true);
  if (head === null || tail === null) return null;

  // `::` stands for at least one group of zeros: a `::` that expands to none
  // is not a valid address, it is a fully written-out one with a stray colon.
  if (head.length + tail.length >= 8) return null;

  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

/** Colon-separated groups of one half of a literal. `""` yields `[]`. */
function parseGroups(part: string, allowDottedQuad: boolean): number[] | null {
  if (part === "") return [];

  const pieces = part.split(":");
  const out: number[] = [];

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];

    if (piece.includes(".")) {
      if (!allowDottedQuad || i !== pieces.length - 1) return null;
      const quad = parseIpv4(piece);
      if (!quad) return null;
      out.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    out.push(parseInt(piece, 16));
  }

  return out;
}

/** Strict decimal dotted quad. A leading zero is ambiguous, so it is refused. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;

  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** Eight groups to their single canonical RFC 5952 spelling. */
function formatIpv6(groups: number[]): string {
  // Longest run of zero groups. `>` and not `>=`, so the LEFTMOST longest run
  // wins on a tie — RFC 5952 §4.2.3.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;

  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart === -1) runStart = i;
      runLength++;
      continue;
    }
    if (runLength > bestLength) {
      bestLength = runLength;
      bestStart = runStart;
    }
    runStart = -1;
    runLength = 0;
  }

  // Leading zeros within a group are dropped by toString(16).
  const hex = groups.map((group) => group.toString(16));

  // A single zero group must NOT be compressed — RFC 5952 §4.2.2. `::` there
  // is the same length as `0` and gives one address two canonical forms,
  // which is the bug this whole function exists to remove.
  if (bestLength < 2) return hex.join(":");

  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}
