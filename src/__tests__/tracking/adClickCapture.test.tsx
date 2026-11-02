import { describe, it, expect } from "vitest";
import { clickCookieToWrite } from "@/components/tracking/AdClickCapture";

const base = { containerId: "GTM-ABC1234", pathname: "/enroll/event", search: "?fbclid=F1", existing: null, now: 5 };

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
