/**
 * Perf tier guard. The perf suite lands with the performance stories
 * (context-size and latency numbers measured against a live room); until
 * then this fails loudly rather than no-op green — a tier that silently
 * passes is worse than a missing one.
 */
console.error(
  "perf tier: not yet implemented.\n" +
    "The performance suites (latency under load, context-size budgets) land with their\n" +
    "stories; see docs/dev/developing.md, 'Test tiers'.",
);
process.exit(1);
