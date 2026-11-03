import { describe, it, expect } from "vitest";
import { clickCookieToWrite, referrerCookieToWrite } from "@/components/tracking/AdClickCapture";

const base = { containerId: "GTM-ABC1234", pathname: "/enroll/event", search: "?fbclid=F1", existing: null, now: 5 };

describe("referrerCookieToWrite", () => {
  const ref = {
    containerId: "GTM-ABC1234",
    pathname: "/enroll/event",
    search: "",
    referrer: "https://l.facebook.com/l.php?u=secret",
    origin: "https://sky.example.com",
  };

  it("keeps only the outside site's address", () => {
    expect(decodeURIComponent(referrerCookieToWrite(ref)!)).toBe("https://l.facebook.com/");
  });
  it("ignores our own pages, whose URLs can hold order details", () => {
    expect(referrerCookieToWrite({ ...ref, referrer: "https://sky.example.com/enroll/form?ref=X" })).toBeNull();
  });
  it("does not write without a referrer", () => {
    expect(referrerCookieToWrite({ ...ref, referrer: "" })).toBeNull();
  });
  it("does not write without a valid container", () => {
    expect(referrerCookieToWrite({ ...ref, containerId: null })).toBeNull();
  });
  it("does not write on an untracked path", () => {
    expect(referrerCookieToWrite({ ...ref, pathname: "/enroll/form" })).toBeNull();
  });
  it("does not write when the URL has a sensitive param", () => {
    expect(referrerCookieToWrite({ ...ref, search: "?ref=X" })).toBeNull();
  });
});

describe("clickCookieToWrite", () => {
  it("writes on a tracked path with a valid container", () => {
    expect(clickCookieToWrite(base)).not.toBeNull();
  });
  it("does not write without a valid container", () => {
    expect(clickCookieToWrite({ ...base, containerId: null })).toBeNull();
    expect(clickCookieToWrite({ ...base, containerId: "bad" })).toBeNull();
  });
  it("does not write on an untracked path", () => {
    expect(clickCookieToWrite({ ...base, pathname: "/enroll/form" })).toBeNull();
  });
  it("does not write when the URL has a sensitive param", () => {
    expect(clickCookieToWrite({ ...base, search: "?fbclid=F1&ref=X" })).toBeNull();
  });
  it("does not write when there is no click ID", () => {
    expect(clickCookieToWrite({ ...base, search: "" })).toBeNull();
  });
});
