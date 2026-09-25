/**
 * Where the arrow keys land in a menu (§22).
 *
 * Pure, and separate from the menu itself, because this is the part of keyboard navigation that can be reasoned
 * about without a browser: which item an arrow selects, wrapping at both ends, and which menu a left or right press
 * moves to while one is open.
 */

/** The index an arrow lands on, wrapping at both ends. */
export function nextMenuIndex(current: number, length: number, delta: number): number {
  if (length === 0) {
    return -1;
  }
  return (current + delta + length) % length;
}

/**
 * The first item that can actually be run.
 *
 * Opening a menu should put the highlight somewhere useful: landing on a separator or a disabled item means the
 * first Enter does nothing, which reads as a broken menu.
 */
export function firstRunnableIndex(
  items: readonly { separator?: boolean; disabled?: boolean }[],
): number {
  const index = items.findIndex((item) => !item.separator && !item.disabled);
  return index < 0 ? 0 : index;
}
