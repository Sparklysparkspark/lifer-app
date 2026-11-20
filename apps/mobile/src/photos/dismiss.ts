// Swipe down to close the photo viewer, tuned to feel like Apple Photos.

/** Fraction of the screen height a slow drag must cover to close. */
export const DISMISS_DISTANCE = 0.15;
/** A downward flick this fast (points per second) closes from a short drag. */
export const DISMISS_VELOCITY = 900;
/** The smallest the photo gets while dragged, reached with the backdrop gone at half the screen height. */
export const MIN_SCALE = 0.75;
/** An upward drag this far opens the Info sheet, as swiping up does in Photos. */
export const INFO_DISTANCE = 80;

/** Whether letting go after this drag closes the viewer; an upward or returning flick never does. */
export function shouldDismiss(dy: number, vy: number, height: number): boolean {
  if (dy <= 0 || vy < -200) return false;
  return dy > height * DISMISS_DISTANCE || (vy > DISMISS_VELOCITY && dy > 20);
}
