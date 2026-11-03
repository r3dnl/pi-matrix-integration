/** Shared plumbing for the vendored MSC4388 files (design §16). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
