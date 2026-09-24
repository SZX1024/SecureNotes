/**
 * Version reported by `/api/v1/health` and shown in Settings/About (§21).
 * `scripts/check-version.mjs` fails the build when this drifts from the version
 * in the repository root `package.json`.
 */
export const APP_VERSION = "0.1.0";
