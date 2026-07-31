import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractAccessTokenFromAuthResult,
  extractMemberIdFromAuthResult,
  isMemberAlreadyExistsError,
  isInvalidCredentialsError,
  formatMemberstackUserError,
  authenticateEmailPassword,
  tryResolveSessionAccessToken,
  MEMBERSTACK_ERROR_CODES,
} from "../../../widgets/shared/memberstack-auth";

/** Documented @memberstack/dom MemberAuth response */
const DOCUMENTED_SIGNUP_RESULT = {
  data: {
    tokens: {
      accessToken:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Im1lbV8xIn0.signature",
      expires: 9999999999,
      type: "bearer",
    },
    member: {
      id: "mem_abc",
      auth: { email: "user@example.com" },
      customFields: {},
    },
    redirect: "",
  },
};

const DOCUMENTED_LOGIN_RESULT = {
  data: {
    tokens: {
      accessToken:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Im1lbV8yIn0.siglogin",
      expires: 9999999999,
      type: "bearer",
    },
    member: { id: "mem_login", auth: { email: "exist@example.com" } },
  },
};

describe("extractAccessTokenFromAuthResult", () => {
  it("extracts token from documented signup response", () => {
    const t = extractAccessTokenFromAuthResult(DOCUMENTED_SIGNUP_RESULT);
    expect(t).toBe(DOCUMENTED_SIGNUP_RESULT.data.tokens.accessToken);
    expect(t!.split(".")).toHaveLength(3);
  });

  it("extracts token from documented login response", () => {
    expect(extractAccessTokenFromAuthResult(DOCUMENTED_LOGIN_RESULT)).toBe(
      DOCUMENTED_LOGIN_RESULT.data.tokens.accessToken
    );
  });

  it("supports tokens at root", () => {
    expect(
      extractAccessTokenFromAuthResult({
        tokens: {
          accessToken:
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig",
        },
      })
    ).toMatch(/^eyJ/);
  });

  it("returns null for missing token", () => {
    expect(extractAccessTokenFromAuthResult(null)).toBeNull();
    expect(extractAccessTokenFromAuthResult({})).toBeNull();
    expect(extractAccessTokenFromAuthResult({ data: {} })).toBeNull();
  });

  it("does not throw on malformed response", () => {
    expect(() => extractAccessTokenFromAuthResult(undefined)).not.toThrow();
    expect(() => extractAccessTokenFromAuthResult(42)).not.toThrow();
    expect(() => extractAccessTokenFromAuthResult("not-a-jwt")).not.toThrow();
    expect(extractAccessTokenFromAuthResult("not-a-jwt")).toBeNull();
  });

  it("extracts member id", () => {
    expect(extractMemberIdFromAuthResult(DOCUMENTED_SIGNUP_RESULT)).toBe("mem_abc");
  });
});

describe("isMemberAlreadyExistsError", () => {
  it("detects documented email-already-in-use code", () => {
    expect(
      isMemberAlreadyExistsError({
        code: MEMBERSTACK_ERROR_CODES.EMAIL_ALREADY_EXISTS,
        message: "Email already in use",
      })
    ).toBe(true);
  });

  it("does not treat network errors as already exists", () => {
    expect(isMemberAlreadyExistsError(new Error("Network Error"))).toBe(false);
    expect(isMemberAlreadyExistsError({ code: "rate-limited", message: "Slow down" })).toBe(
      false
    );
    expect(isMemberAlreadyExistsError({ message: "Internal server error" })).toBe(false);
  });
});

describe("isInvalidCredentialsError", () => {
  it("detects invalid credentials", () => {
    expect(
      isInvalidCredentialsError({
        code: MEMBERSTACK_ERROR_CODES.INVALID_CREDENTIALS,
        message: "Invalid",
      })
    ).toBe(true);
    expect(formatMemberstackUserError({ code: "invalid-credentials" })).toMatch(
      /Incorrect email or password/i
    );
  });
});

describe("authenticateEmailPassword", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      $memberstackDom: {},
      location: { hostname: "localhost" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses token from signup result without getMemberCookie", async () => {
    const signup = vi.fn(async () => DOCUMENTED_SIGNUP_RESULT);
    const login = vi.fn();
    (window as unknown as { $memberstackDom: unknown }).$memberstackDom = {
      signupMemberEmailPassword: signup,
      loginMemberEmailPassword: login,
    };

    const result = await authenticateEmailPassword({
      email: "user@example.com",
      password: "password12",
      firstName: "Jane",
      lastName: "Doe",
    });

    expect(signup).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(result.accessToken).toBe(DOCUMENTED_SIGNUP_RESULT.data.tokens.accessToken);
    expect(result.source).toBe("signup");
  });

  it("logs in only when email already exists", async () => {
    const signup = vi.fn(async () => {
      throw { code: "email-already-in-use", message: "Email already in use" };
    });
    const login = vi.fn(async () => DOCUMENTED_LOGIN_RESULT);
    (window as unknown as { $memberstackDom: unknown }).$memberstackDom = {
      signupMemberEmailPassword: signup,
      loginMemberEmailPassword: login,
    };

    const result = await authenticateEmailPassword({
      email: "exist@example.com",
      password: "password12",
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("login");
    expect(result.accessToken).toBe(DOCUMENTED_LOGIN_RESULT.data.tokens.accessToken);
  });

  it("does not login on network/server signup errors", async () => {
    const signup = vi.fn(async () => {
      throw new Error("Network Error");
    });
    const login = vi.fn();
    (window as unknown as { $memberstackDom: unknown }).$memberstackDom = {
      signupMemberEmailPassword: signup,
      loginMemberEmailPassword: login,
    };

    await expect(
      authenticateEmailPassword({ email: "a@b.com", password: "password12" })
    ).rejects.toThrow(/Network Error/i);
    expect(login).not.toHaveBeenCalled();
  });

  it("surfaces login error for wrong password on existing email", async () => {
    const signup = vi.fn(async () => {
      throw { code: "email-already-in-use", message: "Email already in use" };
    });
    const login = vi.fn(async () => {
      throw { code: "invalid-credentials", message: "Invalid credentials" };
    });
    (window as unknown as { $memberstackDom: unknown }).$memberstackDom = {
      signupMemberEmailPassword: signup,
      loginMemberEmailPassword: login,
    };

    await expect(
      authenticateEmailPassword({ email: "exist@example.com", password: "wrongpass" })
    ).rejects.toThrow(/Incorrect email or password/i);
  });
});

describe("tryResolveSessionAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads string cookie from getMemberCookie", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Im1lbSJ9.sig";
    vi.stubGlobal("window", {
      $memberstackDom: {
        getMemberCookie: () => jwt,
      },
      location: { hostname: "localhost" },
    });
    expect(await tryResolveSessionAccessToken()).toBe(jwt);
  });

  it("returns null when session API missing", async () => {
    vi.stubGlobal("window", {
      $memberstackDom: {},
      location: { hostname: "localhost" },
    });
    expect(await tryResolveSessionAccessToken()).toBeNull();
  });

  it("handles getMemberCookie returning undefined", async () => {
    vi.stubGlobal("window", {
      $memberstackDom: {
        getMemberCookie: () => undefined,
      },
      location: { hostname: "localhost" },
    });
    expect(await tryResolveSessionAccessToken()).toBeNull();
  });
});

describe("diagnostics safety", () => {
  it("does not embed sample tokens in error formatters", () => {
    const secret =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZWNyZXQiOnRydWV9.xxx";
    const msg = formatMemberstackUserError({
      code: "invalid-credentials",
      message: `fail ${secret}`,
    });
    // User-facing invalid-credentials path uses fixed copy
    expect(msg).not.toContain(secret);
    expect(msg).toMatch(/Incorrect email or password/i);
  });
});
