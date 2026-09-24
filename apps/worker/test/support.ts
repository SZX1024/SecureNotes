import { API_PREFIX, type CryptoEnvelope } from "@securenotes/shared";
import { env, SELF } from "cloudflare:test";

import type { Env } from "../src/env";
import { base32Decode } from "../src/lib/base32";
import { readSetCookieHeaders } from "../src/lib/http";
import { generateTotpCode, totpStep } from "../src/lib/totp";

/**
 * Shared support for the worker integration tests.
 *
 * Storage is isolated per *test file*, and writes persist across the tests in a
 * file, so each file enrols its account once (in `beforeAll`) and the helpers
 * here pass the resulting cookies around. Tests that intentionally consume rate
 * limits pass distinct `cf-connecting-ip` values so one test cannot exhaust
 * another's budget.
 *
 * Responses are decoded into explicit shapes rather than `Record<string,
 * unknown>` so that a renamed field is a compile error instead of a silently
 * passing assertion.
 */

export const testEnv = env as unknown as Env;

/** An origin the worker accepts, matching ALLOWED_ORIGINS in wrangler.toml. */
export const ALLOWED_ORIGIN = "http://localhost:5173";

export interface ErrorBody {
  code: string;
  message: string;
  diagnostic?: string;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  setCookies: string[];
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Raw body, for tests that need malformed JSON or a size check. */
  rawBody?: string;
  /** `null` omits the Origin header entirely. */
  origin?: string | null;
  /** `null` omits the Content-Type header entirely. */
  contentType?: string | null;
  headers?: Record<string, string>;
  cookie?: string;
}

export function apiUrl(path: string): string {
  return `https://notes.example.com${API_PREFIX}${path}`;
}

/**
 * Sends a request through the worker's own fetch handler.
 *
 * `SELF.fetch` dispatches in-process, so the tests exercise the real routing,
 * middleware and D1 bindings without needing DNS or a running dev server.
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});

  if (options.origin !== null) {
    headers.set("origin", options.origin ?? ALLOWED_ORIGIN);
  }
  if (method !== "GET" && method !== "HEAD" && options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  }

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

  const response = await SELF.fetch(apiUrl(path), { method, headers, body });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  return {
    status: response.status,
    body: parsed as T,
    setCookies: readSetCookieHeaders(response.headers),
  };
}

export interface CookieJar {
  session: string;
  csrf: string;
  /** Ready-to-send `cookie` header value. */
  header: string;
}

export function cookieJarFrom(setCookies: string[], csrfFallback?: string): CookieJar {
  const find = (name: string) =>
    setCookies
      .map((entry) => entry.split(";")[0] ?? "")
      .find((pair) => pair.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? "";

  const session = find("session");
  const csrf = find("csrf") || (csrfFallback ?? "");
  return { session, csrf, header: `session=${session}; csrf=${csrf}` };
}

export interface EnrolmentData {
  userId: string;
  username: string;
  kdfSalt: string;
  keyVersion: number;
  totpSecret: string;
  totpUri: string;
  /** Each code travels with its public HKDF salt, needed to build its wrapping. */
  recoveryCodes: Array<{ code: string; salt: string }>;
  recoveryCodesShownOnce: boolean;
}

export interface SessionDto {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  rememberDevice: boolean;
  deviceName: string | null;
  clientCategory: string | null;
  ipTruncated: string | null;
}

export interface LoginData {
  session: SessionDto;
  csrfToken: string;
  /** The client needs its own id and salt to build the wrapped-DEK AAD. */
  userId: string;
  username: string;
  kdfSalt: string;
  keyVersion: number;
  keyMaterialPresent: boolean;
  totpSecret?: string | null;
  /** Only while a rebind is mid-flight, so a migration can be resumed. */
  pendingTotpSecret?: string | null;
  rebindState?: string;
  mustRebindTotp?: boolean;
  revokedOtherSessions?: number;
}

export interface SessionListEntry extends SessionDto {
  current: boolean;
}

/** A note as the API returns it: an opaque envelope plus structural metadata. */
export interface NoteDto {
  id: string;
  folderId: string | null;
  revision: number;
  payload: CryptoEnvelope;
  pinned: boolean;
  sortOrder: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TestAccount {
  username: string;
  totpSecret: string;
  recoveryCodes: Array<{ code: string; salt: string }>;
}

/** Enrols the single account once per test file. */
export async function createAccount(username = "alice"): Promise<TestAccount> {
  const response = await apiRequest<{ ok: boolean; data: EnrolmentData }>("/auth/setup", {
    method: "POST",
    body: { username },
  });
  if (response.status !== 200) {
    throw new Error(`setup failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return {
    username,
    totpSecret: response.body.data.totpSecret,
    recoveryCodes: response.body.data.recoveryCodes,
  };
}

/** A valid code for the account, for the current time-step. */
export async function currentCode(account: TestAccount, nowMs = Date.now()): Promise<string> {
  return generateTotpCode(base32Decode(account.totpSecret), totpStep(nowMs));
}

/**
 * Clears the TOTP anti-replay guard.
 *
 * A test that needs several logins in a row would otherwise be rejected after
 * the first, because replaying a consumed time-step is refused by design. Real
 * logins happen in different 30-second windows; the tests simulate that by
 * resetting the guard between logins.
 */
export async function clearTotpReplayGuard(): Promise<void> {
  await testEnv.DB.prepare("UPDATE totp_config SET last_used_step = NULL").run();
}

/**
 * Clears every piece of authentication throttling state.
 *
 * Writes persist for the whole file, so without this each test would inherit
 * the previous test's exhausted IP bucket, account bucket and progressive
 * backoff — and a test that legitimately trips a limit would break every test
 * after it. Resetting keeps the production thresholds exactly as configured
 * (the tests do not get their own limits), and is why this runs in `beforeEach`.
 */
export async function resetRateLimits(): Promise<void> {
  await testEnv.DB.prepare("DELETE FROM rate_limits").run();
  await testEnv.DB.prepare(
    "UPDATE users SET failed_auth_count = 0, auth_backoff_until = NULL",
  ).run();
}

export interface AuthResult {
  status: number;
  jar: CookieJar;
  setCookies: string[];
  /** Present on success. */
  data?: LoginData;
  /** Present on failure. */
  error?: ErrorBody;
}

function decodeAuthResult(
  status: number,
  setCookies: string[],
  body: { ok?: boolean; data?: LoginData; error?: ErrorBody },
): AuthResult {
  const data = body.data;
  return {
    status,
    setCookies,
    jar: cookieJarFrom(setCookies, data?.csrfToken),
    ...(body.ok === true && data ? { data } : {}),
    ...(body.error ? { error: body.error } : {}),
  };
}

export async function login(
  account: TestAccount,
  options: {
    code?: string;
    rememberDevice?: boolean;
    ip?: string;
    userAgent?: string;
    cookie?: string;
  } = {},
): Promise<AuthResult> {
  const response = await apiRequest<{ ok?: boolean; data?: LoginData; error?: ErrorBody }>(
    "/auth/login",
    {
      method: "POST",
      body: {
        username: account.username,
        code: options.code ?? (await currentCode(account)),
        ...(options.rememberDevice === undefined ? {} : { rememberDevice: options.rememberDevice }),
      },
      headers: {
        ...(options.ip ? { "cf-connecting-ip": options.ip } : {}),
        ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
      },
      cookie: options.cookie,
    },
  );

  return decodeAuthResult(response.status, response.setCookies, response.body);
}

/**
 * Logs in and returns the session id, failing loudly if the login did not work.
 *
 * The replay guard is cleared first: a test that logs in twice within one
 * 30-second window would otherwise be rejected by the anti-replay rule, which is
 * correct behaviour but not what the caller is testing.
 */
export async function loginOnce(
  account: TestAccount,
  options: Parameters<typeof login>[1] = {},
): Promise<{ jar: CookieJar; sessionId: string; data: LoginData; setCookies: string[] }> {
  await clearTotpReplayGuard();
  const result = await login(account, options);
  if (result.status !== 200 || !result.data) {
    throw new Error(
      `login failed: ${result.status} ${JSON.stringify(result.data ?? result.error)}`,
    );
  }
  return {
    jar: result.jar,
    sessionId: result.data.session.id,
    data: result.data,
    setCookies: result.setCookies,
  };
}

/** Authenticated state-changing request, with the CSRF header attached. */
export function authedRequest<T = unknown>(
  path: string,
  jar: CookieJar,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  return apiRequest<T>(path, {
    ...options,
    cookie: jar.header,
    headers: { "x-csrf-token": jar.csrf, ...(options.headers ?? {}) },
  });
}

/** Reads an error code from a failed response body of any shape. */
export function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}
