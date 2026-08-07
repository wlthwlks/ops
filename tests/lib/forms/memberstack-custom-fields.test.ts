import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildMemberstackCustomFieldsPayload,
  getMemberstackCustomFieldKeys,
} from "@/lib/forms/memberstack/custom-fields";

describe("memberstack custom fields", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    delete process.env.MEMBERSTACK_CF_FIRST_NAME;
    delete process.env.MEMBERSTACK_CF_LAST_NAME;
    delete process.env.MEMBERSTACK_CF_PHONE;
    delete process.env.MEMBERSTACK_CF_CITY;
    delete process.env.MEMBERSTACK_CF_COUNTRY;
    delete process.env.MEMBERSTACK_CF_POST_CODE;
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it("uses default kebab-case keys", () => {
    const keys = getMemberstackCustomFieldKeys();
    expect(keys.firstName).toBe("first-name");
    expect(keys.phoneNumber).toBe("phone-number");
    expect(keys.postCode).toBe("post-code");
  });

  it("builds payload with only provided fields", () => {
    const payload = buildMemberstackCustomFieldsPayload({
      firstName: "Ada",
      phoneNumber: "+64211234567",
      postCode: "1010",
    });
    expect(payload).toEqual({
      "first-name": "Ada",
      "phone-number": "+64211234567",
      "post-code": "1010",
    });
    expect(payload).not.toHaveProperty("email");
  });

  it("respects env key overrides", () => {
    process.env.MEMBERSTACK_CF_FIRST_NAME = "First Name";
    process.env.MEMBERSTACK_CF_PHONE = "Phone";
    const payload = buildMemberstackCustomFieldsPayload({
      firstName: "Ada",
      phoneNumber: "+64211234567",
    });
    expect(payload["First Name"]).toBe("Ada");
    expect(payload.Phone).toBe("+64211234567");
  });
});
