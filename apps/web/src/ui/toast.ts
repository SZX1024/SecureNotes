/**
 * The message that appears at the bottom of the window (§22).
 *
 * A note that says what just happened, and — when there is something to be done about it — a single button that does
 * it. Two decisions live here rather than in the component:
 *
 *  - how long each kind stays. A confirmation is read once and goes; a failure is the thing a person needs to read
 *    *after* they have looked away, and one that disappears on its own is the easiest way to miss a problem.
 *  - what a screen reader should do with it. A confirmation is a status, an error is an alert, and the difference is
 *    whether it interrupts.
 */

export type ToastKind = "success" | "info" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  kind: ToastKind;
  message: string;
  /** One thing to be done about it, such as undoing what just happened. */
  action?: ToastAction;
}

/** How long a message that dismisses itself stays. Long enough to read, short enough not to be in the way. */
export const TOAST_DURATION_MS = 3000;

export function autoDismisses(kind: ToastKind): boolean {
  return kind !== "error";
}

export function toastRole(kind: ToastKind): "status" | "alert" {
  return kind === "error" ? "alert" : "status";
}
