import type { Env } from "../env";
import { base64ToBytes } from "./crypto";

/**
 * Configuration validation.
 *
 * Secrets are supplied out of band (`wrangler secret put` in production,
 * `.dev.vars` locally), so a deployment can be missing one without anything
 * failing to build. Without an explicit check the first symptom is a crash
 * inside AES-GCM with a message that names nothing — this turns that into a
 * precise, actionable error, and names the missing binding in development.
 */

interface Requirement {
  readonly name: keyof Env;
  readonly expectedBytes: number;
}

const REQUIREMENTS: readonly Requirement[] = [
  { name: "SECRET_WRAP_KEY", expectedBytes: 32 },
  { name: "CSRF_SIGNING_KEY", expectedBytes: 32 },
];

/** Returns a human-readable problem description, or null when configured. */
export function findConfigProblem(env: Env): string | null {
  for (const requirement of REQUIREMENTS) {
    const value = env[requirement.name];
    if (typeof value !== "string" || value.length === 0) {
      return `${requirement.name} is not configured`;
    }
    let decoded: Uint8Array;
    try {
      decoded = base64ToBytes(value);
    } catch {
      return `${requirement.name} is not valid base64`;
    }
    if (decoded.length !== requirement.expectedBytes) {
      return `${requirement.name} must decode to ${requirement.expectedBytes} bytes, got ${decoded.length}`;
    }
  }

  if (!env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS.trim().length === 0) {
    // Failing closed here is deliberate: an empty allowlist would reject every
    // browser request with a 403 that looks like a client bug.
    return "ALLOWED_ORIGINS is not configured";
  }

  return null;
}
