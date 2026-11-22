/**
 * A failure whose message is written for the user and carries no paths or
 * story content, so it may cross back to the backend and appear in the UI.
 * Any other error thrown while answering a backend request stays generic.
 */
export class DesktopOperationError extends Error {
  override readonly name = 'DesktopOperationError'
}
