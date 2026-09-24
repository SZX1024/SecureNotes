/**
 * The unlock state machine (§7).
 *
 * The app has three states, and the transitions between them are the security
 * boundary of the local layer:
 *
 * ```text
 * anonymous --credentials verified--> unlocked
 * anonymous --device key present----> locked (offline unlock available)
 * unlocked  --App Lock expires------> locked
 * unlocked  --session revoked-------> anonymous  (keys destroyed)
 * ```
 *
 * `forgotten` is deliberately not a state the app can enter by itself: only a
 * 401 from the server or an explicit sign-out destroys local key material.
 */

export type UnlockState = "anonymous" | "locked" | "unlocked";

export type UnlockEvent =
  | { type: "enrolment-required" }
  | { type: "credentials-verified" }
  | { type: "device-key-available" }
  | { type: "unlocked" }
  | { type: "app-lock-expired" }
  | { type: "session-revoked" }
  | { type: "signed-out" };

export interface UnlockContext {
  state: UnlockState;
  /** Whether a wrapped DEK is stored locally, which is what enables offline unlock. */
  hasLocalKeyMaterial: boolean;
}

export function initialUnlockContext(
  hasLocalKeyMaterial: boolean,
  hasAccount: boolean,
): UnlockContext {
  if (!hasAccount) {
    return { state: "anonymous", hasLocalKeyMaterial };
  }
  return { state: hasLocalKeyMaterial ? "locked" : "anonymous", hasLocalKeyMaterial };
}

/**
 * Applies an event.
 *
 * Kept as a pure reducer so every transition can be asserted, including the ones
 * that must destroy local state: a revoked session and an explicit sign-out both
 * end at `anonymous` with no local key material.
 */
export function reduceUnlock(context: UnlockContext, event: UnlockEvent): UnlockContext {
  switch (event.type) {
    case "enrolment-required":
      return { state: "anonymous", hasLocalKeyMaterial: false };
    case "credentials-verified":
      return { state: "unlocked", hasLocalKeyMaterial: context.hasLocalKeyMaterial };
    case "device-key-available":
      return {
        state: context.state === "unlocked" ? "unlocked" : "locked",
        hasLocalKeyMaterial: true,
      };
    case "unlocked":
      return { state: "unlocked", hasLocalKeyMaterial: context.hasLocalKeyMaterial };
    case "app-lock-expired":
      // The App Lock window closed: keys are dropped but the account is intact,
      // so the user can unlock again with the device key.
      return { state: "locked", hasLocalKeyMaterial: context.hasLocalKeyMaterial };
    case "session-revoked":
    case "signed-out":
      // §4: a device that learns its session was revoked destroys its cached keys
      // and returns to authentication.
      return { state: "anonymous", hasLocalKeyMaterial: false };
    default:
      return context;
  }
}

/** What the UI should show for a state. */
export function describeUnlockState(context: UnlockContext): {
  screen: "setup" | "login" | "unlock" | "app";
  message: string;
} {
  if (context.state === "unlocked") {
    return { screen: "app", message: "Unlocked" };
  }
  if (context.state === "locked" && context.hasLocalKeyMaterial) {
    return { screen: "unlock", message: "Locked — unlock with this device" };
  }
  return { screen: "login", message: "Sign in with your authenticator code" };
}
