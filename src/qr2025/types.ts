/** Shared plumbing for the vendored MSC4388 files (configuration-and-room-behaviour.md). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
