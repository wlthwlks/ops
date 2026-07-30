import { describe, it, expect, afterEach } from "vitest";
import {
  getIntroductionsMode,
  isIntroductionsLive,
  assertIntroductionsLive,
  introductionsModePayload,
  IntroductionsConfigError,
  IntroductionsReadOnlyError,
} from "@/lib/introduction/runtime-mode";

describe("introductions runtime mode", () => {
  const original = process.env.INTRODUCTIONS_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.INTRODUCTIONS_MODE;
    else process.env.INTRODUCTIONS_MODE = original;
  });

  it("missing INTRODUCTIONS_MODE resolves to read_only", () => {
    delete process.env.INTRODUCTIONS_MODE;
    expect(getIntroductionsMode()).toBe("read_only");
    expect(isIntroductionsLive()).toBe(false);
  });

  it("empty INTRODUCTIONS_MODE resolves to read_only", () => {
    process.env.INTRODUCTIONS_MODE = "";
    expect(getIntroductionsMode()).toBe("read_only");
  });

  it("read_only is accepted", () => {
    process.env.INTRODUCTIONS_MODE = "read_only";
    expect(getIntroductionsMode()).toBe("read_only");
    expect(isIntroductionsLive()).toBe(false);
  });

  it("live is accepted", () => {
    process.env.INTRODUCTIONS_MODE = "live";
    expect(getIntroductionsMode()).toBe("live");
    expect(isIntroductionsLive()).toBe(true);
  });

  it("unsupported values throw", () => {
    process.env.INTRODUCTIONS_MODE = "enabled";
    expect(() => getIntroductionsMode()).toThrow(IntroductionsConfigError);
  });

  it("assertIntroductionsLive throws in read_only", () => {
    process.env.INTRODUCTIONS_MODE = "read_only";
    expect(() => assertIntroductionsLive("test-action")).toThrow(IntroductionsReadOnlyError);
  });

  it("assertIntroductionsLive allows live", () => {
    process.env.INTRODUCTIONS_MODE = "live";
    expect(() => assertIntroductionsLive("test-action")).not.toThrow();
  });

  it("payload derives capabilities from mode", () => {
    process.env.INTRODUCTIONS_MODE = "read_only";
    const ro = introductionsModePayload();
    expect(ro.sendEnabled).toBe(false);
    expect(ro.writesEnabled).toBe(false);
    expect(ro.automationWillSend).toBe(false);

    process.env.INTRODUCTIONS_MODE = "live";
    const live = introductionsModePayload();
    expect(live.sendEnabled).toBe(true);
    expect(live.writesEnabled).toBe(true);
    expect(live.automationWillSend).toBe(true);
  });
});
