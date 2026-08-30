import { describe, it, expect } from "vitest";
import { canonicalIp, hashIp } from "@/lib/interest/ipHash";

describe("canonicalIp", () => {
  it("lowercases IPv6", () => {
    expect(canonicalIp("2001:DB8::1")).toBe("2001:db8::1");
  });

  it("reduces IPv4-mapped IPv6 to the IPv4 form", () => {
    expect(canonicalIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
  });

  it("strips surrounding whitespace and brackets", () => {
    expect(canonicalIp(" [2001:db8::1] ")).toBe("2001:db8::1");
  });

  it("returns 'unknown' for empty input, so a missing address still buckets", () => {
    expect(canonicalIp("")).toBe("unknown");
    expect(canonicalIp(null)).toBe("unknown");
  });
});

// ─── RFC 5952 ────────────────────────────────────────────────────────────────
// The property under test is one address, one spelling. Without it a client
// picks a different spelling per request and takes a fresh rate-limit bucket
// each time — a bypass of the limiter, not a degradation of it.

describe("canonicalIp: RFC 5952 normalisation", () => {
  it("leaves an already-canonical address alone", () => {
    expect(canonicalIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("compresses a fully written-out address", () => {
    expect(canonicalIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
  });

  it("strips leading zeros from every group", () => {
    expect(canonicalIp("2001:0db8:0001:0002:0003:0004:0005:0006")).toBe(
      "2001:db8:1:2:3:4:5:6",
    );
  });

  it("compresses a run at the start", () => {
    expect(canonicalIp("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(canonicalIp("0000:0000:0000:0000:0000:0000:0000:0000")).toBe("::");
    expect(canonicalIp("::")).toBe("::");
  });

  it("compresses a run at the end", () => {
    expect(canonicalIp("2001:db8:0:0:0:0:0:0")).toBe("2001:db8::");
    expect(canonicalIp("2001:db8::")).toBe("2001:db8::");
  });

  it("compresses a run in the middle", () => {
    expect(canonicalIp("2001:db8:0:0:0:0:1:2")).toBe("2001:db8::1:2");
  });

  it("takes the LONGEST run, not the first one it meets", () => {
    // A leftmost-first implementation would answer "2001::1:0:0:0:1".
    expect(canonicalIp("2001:0:0:1:0:0:0:1")).toBe("2001:0:0:1::1");
  });

  it("takes the LEFTMOST run when two are equally long", () => {
    // RFC 5952 §4.2.3. A rightmost-wins implementation would answer
    // "2001:db8:0:0:1::1".
    expect(canonicalIp("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
  });

  it("does NOT compress a single zero group", () => {
    // RFC 5952 §4.2.2, and the common bug: `::` there is no shorter than `0`
    // and hands one address two canonical forms — exactly the split bucket
    // this normalisation exists to remove.
    expect(canonicalIp("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1");
    expect(canonicalIp("2001:0db8:0000:0001:0001:0001:0001:0001")).toBe(
      "2001:db8:0:1:1:1:1:1",
    );
  });

  it("normalises mixed case together with the compression", () => {
    expect(canonicalIp("2001:0DB8:0000:0000:ABCD:0000:0000:0001")).toBe(
      "2001:db8::abcd:0:0:1",
    );
  });

  it("reduces every spelling of an IPv4-mapped address to the IPv4 form", () => {
    expect(canonicalIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(canonicalIp("0:0:0:0:0:ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(canonicalIp("0000:0000:0000:0000:0000:FFFF:1.2.3.4")).toBe("1.2.3.4");
    // The same address written with the last two groups in hex.
    expect(canonicalIp("::ffff:102:304")).toBe("1.2.3.4");
  });

  it("leaves an IPv4 address alone", () => {
    expect(canonicalIp("192.168.1.1")).toBe("192.168.1.1");
  });

  it("passes a non-address string through unchanged", () => {
    // "unknown" is what a missing address buckets as, and it must survive
    // normalisation untouched — it is not an address and must not be mangled
    // into one.
    expect(canonicalIp("unknown")).toBe("unknown");
    expect(canonicalIp("not an ip")).toBe("not an ip");
  });

  it("passes a malformed or unreadable literal through rather than mangling it", () => {
    // Each of these is either invalid or ambiguous. Returning it as-is keeps
    // it in a bucket of its own; guessing at it risks colliding a junk string
    // with a real client's bucket.
    expect(canonicalIp("2001:db8::1::2")).toBe("2001:db8::1::2"); // two "::"
    expect(canonicalIp("2001:db8:1:2:3:4:5")).toBe("2001:db8:1:2:3:4:5"); // seven groups
    expect(canonicalIp("2001:db8:0:0:0:0:0:0:1")).toBe("2001:db8:0:0:0:0:0:0:1"); // nine
    expect(canonicalIp("2001:db8::0:1:2:3:4:5:6")).toBe("2001:db8::0:1:2:3:4:5:6"); // "::" over nothing
    expect(canonicalIp("2001:db8::zzzz")).toBe("2001:db8::zzzz"); // not hex
    expect(canonicalIp("2001:db8::12345")).toBe("2001:db8::12345"); // group too wide
    expect(canonicalIp("fe80::1%eth0")).toBe("fe80::1%eth0"); // zone suffix
    expect(canonicalIp("::ffff:1.2.3.256")).toBe("::ffff:1.2.3.256"); // octet out of range
    expect(canonicalIp("::ffff:1.2.3.04")).toBe("::ffff:1.2.3.04"); // ambiguous octet
    expect(canonicalIp("::1.2.3.4:5")).toBe("::1.2.3.4:5"); // quad not last
  });
});

describe("hashIp", () => {
  it("returns lowercase hex sha256, matching the column CHECK", () => {
    expect(hashIp("1.2.3.4", "secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives one bucket per client regardless of representation", () => {
    expect(hashIp("::ffff:1.2.3.4", "s")).toBe(hashIp("1.2.3.4", "s"));
  });

  it("gives ONE bucket for every spelling of one IPv6 address", () => {
    // The bypass, stated as the limiter sees it. Every entry below is the
    // same address; before compression each took a bucket of its own and the
    // per-address limit could be walked past by re-spelling it.
    const spellings = [
      "2001:db8::1",
      "2001:0db8::1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      "2001:db8:0:0:0:0:0:1",
      "2001:DB8:0000:0000:0000:0000:0000:0001",
      " [2001:0DB8::0001] ",
    ];

    const buckets = new Set(spellings.map((s) => hashIp(s, "s")));
    expect(buckets.size).toBe(1);
  });

  it("keeps the single-zero-group address in the same bucket as its expansion", () => {
    // Compressing a lone zero group is the common bug, and it splits this
    // address across two buckets in exactly the direction an attacker wants.
    expect(hashIp("2001:db8:0:1:1:1:1:1", "s")).toBe(
      hashIp("2001:0db8:0000:0001:0001:0001:0001:0001", "s"),
    );
  });

  it("does NOT collide genuinely different addresses", () => {
    const distinct = [
      "2001:db8::1",
      "2001:db8::2",
      "2001:db8:0:1:1:1:1:1",
      "2001:db8:1::1",
      "2001:0:0:1::1",
      "::1",
      "::",
      "1.2.3.4",
      "1.2.3.5",
      "unknown",
    ];

    const buckets = new Set(distinct.map((s) => hashIp(s, "s")));
    expect(buckets.size).toBe(distinct.length);
  });

  it("changes with the secret", () => {
    expect(hashIp("1.2.3.4", "a")).not.toBe(hashIp("1.2.3.4", "b"));
  });

  it("throws when secret is empty", () => {
    expect(() => hashIp("1.2.3.4", "")).toThrow(
      "hashIp: secret must be a non-empty string"
    );
  });
});
