/**
 * Browser Memberstack DOM authentication helpers.
 *
 * Primary token source: signup/login response
 *   { data: { tokens: { accessToken, expires, type }, member } }
 * per @memberstack/dom MemberAuth payload.
 *
 * Session fallback: getMemberCookie() → string | undefined (when present).
 * Do not scrape localStorage/cookies manually.
 */

export const MEMBERSTACK_ERROR_CODES = {
  EMAIL_ALREADY_EXISTS: "email-already-in-use",
  INVALID_CREDENTIALS: "invalid-credentials",
  INVALID_PASSWORD: "invalid-password",
  MEMBER_NOT_FOUND: "member-not-found",
  INVALID_TOKEN: "client/invalid-token",
} as const;

export type MemberstackAuthTokens = {
  accessToken: string;
  expires?: number;
  type?: string;
};

export type MemberstackAuthResult = {
  accessToken: string;
  memberId?: string;
  email?: string;
  source: "signup" | "login" | "session";
};

type MemberstackDomLike = {
  signupMemberEmailPassword?: (p: Record<string, unknown>) => Promise<unknown>;
  loginMemberEmailPassword?: (p: Record<string, unknown>) => Promise<unknown>;
  getMemberCookie?: () => unknown;
  getCurrentMember?: () => Promise<unknown>;
  auth?: {
    signupMemberEmailPassword?: (p: Record<string, unknown>) => Promise<unknown>;
    loginMemberEmailPassword?: (p: Record<string, unknown>) => Promise<unknown>;
  };
  member?: {
    getCurrentMember?: () => Promise<unknown>;
  };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Extract access token from documented Memberstack auth responses.
 * Supports:
 * - { data: { tokens: { accessToken } } }  // current DOM package
 * - { tokens: { accessToken } }
 * - { data: { accessToken } }
 * - { accessToken }
 */
export function extractAccessTokenFromAuthResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") {
    const t = result.trim();
    return t && looksLikeJwt(t) ? t : null;
  }
  if (!isRecord(result)) return null;

  const candidates: unknown[] = [];

  const data = isRecord(result.data) ? result.data : null;
  if (data) {
    if (isRecord(data.tokens) && typeof data.tokens.accessToken === "string") {
      candidates.push(data.tokens.accessToken);
    }
    if (typeof data.accessToken === "string") candidates.push(data.accessToken);
    if (typeof data.token === "string") candidates.push(data.token);
  }

  if (isRecord(result.tokens) && typeof result.tokens.accessToken === "string") {
    candidates.push(result.tokens.accessToken);
  }
  if (typeof result.accessToken === "string") candidates.push(result.accessToken);
  if (typeof result.token === "string") candidates.push(result.token);

  for (const c of candidates) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t && looksLikeJwt(t)) return t;
    }
  }
  return null;
}

export function extractMemberIdFromAuthResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const data = isRecord(result.data) ? result.data : result;
  const member = isRecord(data.member) ? data.member : null;
  const id = member?.id ?? data.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  if (typeof error.code === "string") return error.code;
  if (isRecord(error.data) && typeof error.data.code === "string") return error.data.code;
  if (isRecord(error.error) && typeof error.error.code === "string") return error.error.code;
  return null;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (!isRecord(error)) return "Authentication failed";
  if (typeof error.message === "string" && error.message.trim()) return error.message;
  if (isRecord(error.data) && typeof error.data.message === "string") {
    return error.data.message;
  }
  return "Authentication failed";
}

/** Only treat documented “email already in use” as existing-member. */
export function isMemberAlreadyExistsError(error: unknown): boolean {
  const code = getErrorCode(error)?.toLowerCase() || "";
  if (
    code === MEMBERSTACK_ERROR_CODES.EMAIL_ALREADY_EXISTS ||
    code === "email_already_in_use" ||
    code === "email-already-exists"
  ) {
    return true;
  }
  const msg = getErrorMessage(error).toLowerCase();
  // Narrow message fallback for older SDKs
  if (
    msg.includes("email already") ||
    msg.includes("already in use") ||
    msg.includes("already exists") ||
    msg.includes("member already")
  ) {
    return true;
  }
  return false;
}

export function isInvalidCredentialsError(error: unknown): boolean {
  const code = getErrorCode(error)?.toLowerCase() || "";
  if (
    code === MEMBERSTACK_ERROR_CODES.INVALID_CREDENTIALS ||
    code === MEMBERSTACK_ERROR_CODES.INVALID_PASSWORD ||
    code === "invalid_credentials"
  ) {
    return true;
  }
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("invalid credentials") ||
    msg.includes("incorrect password") ||
    msg.includes("wrong password") ||
    msg.includes("invalid password")
  );
}

export function formatMemberstackUserError(error: unknown): string {
  if (isInvalidCredentialsError(error)) {
    return "Incorrect email or password. Please try again.";
  }
  if (isMemberAlreadyExistsError(error)) {
    return "An account with this email already exists. Please check your password and try again.";
  }
  const msg = getErrorMessage(error);
  // Avoid dumping internal stacks
  if (msg.length > 200) return "Authentication failed. Please try again.";
  return msg || "Authentication failed. Please try again.";
}

export function getMemberstackDom(): MemberstackDomLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { $memberstackDom?: MemberstackDomLike };
  return w.$memberstackDom || null;
}

function getSignupFn(dom: MemberstackDomLike) {
  return dom.signupMemberEmailPassword || dom.auth?.signupMemberEmailPassword;
}

function getLoginFn(dom: MemberstackDomLike) {
  return dom.loginMemberEmailPassword || dom.auth?.loginMemberEmailPassword;
}

/**
 * Safe session token resolve.
 * getMemberCookie() is documented to return string | undefined in current DOM types.
 */
export async function tryResolveSessionAccessToken(): Promise<string | null> {
  const dom = getMemberstackDom();
  if (!dom) return null;

  try {
    if (typeof dom.getMemberCookie === "function") {
      const raw = dom.getMemberCookie();
      const value = raw instanceof Promise ? await raw : raw;
      if (typeof value === "string") {
        const t = value.trim();
        if (t && looksLikeJwt(t)) return t;
      }
      // Legacy object shapes (older installs) — only documented accessToken/token fields
      if (isRecord(value)) {
        if (typeof value.accessToken === "string" && looksLikeJwt(value.accessToken)) {
          return value.accessToken.trim();
        }
        if (typeof value.token === "string" && looksLikeJwt(value.token)) {
          return value.token.trim();
        }
      }
    }
  } catch {
    /* session unavailable */
  }
  return null;
}

export type AuthenticateParams = {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  customFields?: Record<string, string>;
};

/**
 * Signup first; only login when Memberstack reports email already in use.
 */
export async function authenticateEmailPassword(
  params: AuthenticateParams
): Promise<MemberstackAuthResult> {
  const dom = getMemberstackDom();
  if (!dom) {
    throw new Error(
      "Memberstack is not loaded. Add the Memberstack script on this Webflow page."
    );
  }

  const signup = getSignupFn(dom);
  const login = getLoginFn(dom);
  if (!signup) {
    throw new Error(
      "Memberstack signup is unavailable. Check that the DOM package is installed and initialized."
    );
  }

  const customFields = {
    ...(params.customFields || {}),
    ...(params.firstName
      ? { "first-name": params.firstName, firstName: params.firstName }
      : {}),
    ...(params.lastName ? { "last-name": params.lastName, lastName: params.lastName } : {}),
  };

  let signupResult: unknown;
  try {
    signupResult = await signup({
      email: params.email,
      password: params.password,
      customFields,
    });
  } catch (signupErr) {
    if (!isMemberAlreadyExistsError(signupErr)) {
      throw new Error(formatMemberstackUserError(signupErr));
    }
    if (!login) {
      throw new Error(
        "An account with this email already exists, but login is unavailable on this page."
      );
    }
    try {
      const loginResult = await login({
        email: params.email,
        password: params.password,
      });
      const token = extractAccessTokenFromAuthResult(loginResult);
      if (!token) {
        throw new Error(
          "Signed in but Memberstack did not return an access token. Check the Memberstack DOM package version."
        );
      }
      return {
        accessToken: token,
        memberId: extractMemberIdFromAuthResult(loginResult),
        email: params.email,
        source: "login",
      };
    } catch (loginErr) {
      throw new Error(formatMemberstackUserError(loginErr));
    }
  }

  const token = extractAccessTokenFromAuthResult(signupResult);
  if (!token) {
    // Some installs set cookie only — try session fallback once after successful signup
    const session = await tryResolveSessionAccessToken();
    if (session) {
      return {
        accessToken: session,
        memberId: extractMemberIdFromAuthResult(signupResult),
        email: params.email,
        source: "signup",
      };
    }
    throw new Error(
      "Account created but Memberstack did not return an access token. Ensure you are using a current Memberstack DOM package."
    );
  }

  return {
    accessToken: token,
    memberId: extractMemberIdFromAuthResult(signupResult),
    email: params.email,
    source: "signup",
  };
}

/** Dev-only diagnostics — never logs secrets or tokens. */
export function logMemberstackDiagnostics(label: string, extra?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    // Minimal in production
    const isProd =
      (typeof process !== "undefined" && process.env?.NODE_ENV === "production") ||
      (window.location.hostname.endsWith("wlthwlks.com") &&
        !window.location.hostname.includes("staging") &&
        !window.location.hostname.includes("webflow"));
    if (isProd) return;

    const dom = getMemberstackDom();
    const methods = dom
      ? Object.keys(dom as object).filter((k) => typeof (dom as Record<string, unknown>)[k] === "function")
      : [];
    console.info("[wlth-memberstack]", label, {
      domLoaded: Boolean(dom),
      publicMethods: methods.slice(0, 30),
      hasSignup: Boolean(dom && getSignupFn(dom)),
      hasLogin: Boolean(dom && getLoginFn(dom)),
      hasGetMemberCookie: typeof dom?.getMemberCookie === "function",
      ...extra,
    });
  } catch {
    /* ignore */
  }
}

export function topLevelKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).slice(0, 20);
}

/**
 * Change password via Memberstack DOM.
 * Tries documented updateMemberPassword shapes; falls back to login(old)+update if needed.
 */
export async function changeMemberstackPassword(input: {
  currentPassword: string;
  newPassword: string;
  email?: string;
}): Promise<void> {
  const dom = getMemberstackDom() as MemberstackDomLike & {
    updateMemberPassword?: (p: Record<string, unknown>) => Promise<unknown>;
    updatePassword?: (p: Record<string, unknown>) => Promise<unknown>;
    auth?: {
      updateMemberPassword?: (p: Record<string, unknown>) => Promise<unknown>;
      updatePassword?: (p: Record<string, unknown>) => Promise<unknown>;
    };
  };
  if (!dom) {
    throw new Error("Memberstack is not loaded on this page.");
  }

  const attempts: Array<() => Promise<unknown>> = [];
  const payloads = [
    { password: input.currentPassword, newPassword: input.newPassword },
    { currentPassword: input.currentPassword, newPassword: input.newPassword },
    { oldPassword: input.currentPassword, newPassword: input.newPassword },
  ];

  for (const fn of [
    dom.updateMemberPassword,
    dom.updatePassword,
    dom.auth?.updateMemberPassword,
    dom.auth?.updatePassword,
  ]) {
    if (typeof fn !== "function") continue;
    for (const p of payloads) {
      attempts.push(() => fn.call(dom, p));
    }
  }

  let lastErr: unknown;
  for (const run of attempts) {
    try {
      await run();
      return;
    } catch (e) {
      lastErr = e;
      // Wrong password should surface immediately when clearly indicated
      if (isInvalidCredentialsError(e)) {
        throw new Error(formatMemberstackUserError(e));
      }
    }
  }

  // Fallback: verify current password via login, then try update with new password only
  const login = getLoginFn(dom);
  if (login && input.email) {
    try {
      await login({ email: input.email, password: input.currentPassword });
      for (const fn of [dom.updateMemberPassword, dom.updatePassword]) {
        if (typeof fn !== "function") continue;
        try {
          await fn.call(dom, { password: input.newPassword, newPassword: input.newPassword });
          return;
        } catch (e) {
          lastErr = e;
        }
      }
    } catch (e) {
      throw new Error(formatMemberstackUserError(e));
    }
  }

  throw new Error(
    lastErr ? formatMemberstackUserError(lastErr) : "Password change is unavailable on this page."
  );
}
