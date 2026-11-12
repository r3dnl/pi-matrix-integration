# Design principles

**REVIEW COMMENT: IMO THE WHY FOR A PRINCIPLE SHOULD NOT REFER TO AN INCIDENT BUT STAND ON ITS OWN, INDEPENDENT. ALSO, WHAT IS A "GATE", OR WHAT DOES IT DO WITH A PRINCIPLE? DO YOU MEAN HOW THE PRINCIPLE GETS ENFORCED, WITH A PARTICULAR DESIGN (DECISION)?**

Cross-cutting rules that shape how this extension is built. Each principle
names its **why** (usually an incident) and its **gate** (the check, test
or review step that enforces it), in the spirit of
[coding standards](../coding-standards.md): a rule with no enforcement is
marked **(judgement)** and stays a human call. Rules that already have a
home are quoted with a pointer, not copied — this file is the index, and
the sole home for the principles that had none.

When a change seems to need an exception to one of these, that is a
proposal, not a licence (see `AGENTS.md`, scope discipline).

## 1. One identity, one writer

One Matrix account per Pi instance; every outbound message goes through
`src/outbox.ts`, every inbound room event arrives through `src/inbound.ts`.
A second client or a second dispatch point is a second writer.

- **Why:** dedupe, rate limits, thread bookkeeping and the trust boundary
  all assume a single choke point per direction.
- **Gate:** review (coding standards, Structure table);
  [transport and state](transport-and-state.md).

## 2. Soft failure, both directions

A Matrix outage must not stop you coding. Outbound failures land in the
TUI footer and the log; an inbound event we cannot handle is logged and
skipped, never thrown into Pi's event loop.

- **Gate:** review against the soft-fail invariant;
  [transport and state](transport-and-state.md#soft-failure).

## 3. The room is the security boundary

Room membership is the only access control on what the agent hears and
what the room can trigger. Widening the room's command surface is a
proposal, never a drive-by.

- **Gate:** `test/security-boundary.mjs`, the CI credential scan, and
  `AGENTS.md` rule 3; `SECURITY.md` carries the full statement.

## 4. Echo isolation: never arm your own trigger

A feedback loop must not be fed by the system's own output. Anything that
counts "activity" as a dispatch condition must measure *incoming human*
signals, not the extension's own sends — or one leaked echo re-arms the
machine.

- **Why:** the 2026-10 summary wake loop: `recordOnRoot()`
  (`src/threading.ts`) bumps `msgCount` on every own send, a leaked
  summary report-out counted as new content, and the next pass spawned.
  `bookkeepingSinceSummary` then subtracted our own pollution back out —
  two counters compensating for one contaminated meter.
- **Gate:** enforced since PROP-001 P2. The cadence and content gates read
  `humanMsgCount`, advanced only by `ThreadManager.recordHumanMessage()`
  from the human-input branch of `onMessageEnd`; the send path no longer
  runs the cadence gate at all. Enforced by `test/offline/summarize-cadence.mjs`
  (own sends dispatch nothing) and the cadence blocks of
  `test/logic/01-threading.mjs` ("own sends do not drive the cadence").

## 5. Declare, don't detect

When the extension injects a message (directive, wake hint, relay), its
identity is *declared* — a `details.kind`, a correlation carried from the
dispatch site — and every later decision reads that declaration. Pattern
matching our own message shapes at consumption time is detection, and it
misses.

- **Why:** `isSummarizeDirectiveNotice` / `isSummarizerWakeNotice`
  (`src/classify.ts`) re-infer "is this ours?" at each hook; every shape
  mismatch re-opens the loop-guard bug class.
- **Gate:** **(judgement)** review: a new `is…Notice`-style classifier is
  a smell — carry the fact from the dispatch site instead. Since PROP-001
  P3 both classifiers are consulted at exactly one site — `before_agent_start`
  naming the run's trigger — never again mid-run.

## 6. Decide at the turn's scope, from data — never from arrival order

"May this output reach the room?" is answered per turn from facts the run
knows (did this turn consume human input?), not from a run-scoped flag
plus a guess about which event fires first. Async lifecycle events have
no promised order; any state machine that depends on one is a latent bug.

- **Why:** the mute/lift bug class — three fixes (`73a8162`, `6a63654`,
  `c4aeb44`) each widened one trigger of an arrival-order-scoped
  escape hatch; a question queued *before* a summary directive still lost
  its answer (reported 2026-11-10, `docs/dev/proposals/`).
- **Gate:** enforced since PROP-001 P3: the shipping gate is one expression,
  `summaryTriggerRun && !humanInputPending`, read per turn — the mute, the
  lift and the wake-fuel flags are deleted. Pinned by `test/offline/summarizer-wake.mjs`
  (question queued before the directive, relay folded mid-run, absorbed
  notice). Review rule stands: any new boolean set in one hook and cleared
  in another needs a comment naming the interleaving it assumes — and a
  second look.

## 7. Background output gets its own channel

A background pass writes through its dedicated sink (the thread-root edit
via `matrix_update_thread_summary`); it is not allowed to join the
user-facing broadcast path. Output with no destination cannot leak, so it
needs no mute.

- **Why:** every mute, lift and wake-fuel flag in `src/lifecycle.ts`
  existed only because a summary pass's chatty turn closing shared the
  broadcast path with real answers.
- **Gate:** since PROP-001 P3 the flags are gone; what remains is a
  broadcast filter, not a guard — a summarizer-opened run's finals are held
  while no human input is pending, because a pure-summary turn has no
  answer in it. The cadence itself is immune by construction (principle 4).

## 8. Degrade, but never go silent

When a guard suppresses a room write, it logs what was suppressed with an
excerpt of the payload (warn level). "The agent went quiet" must be
answerable from the log alone, not by reading source.

- **Why:** the 2026-10 incident was invisible for a whole session because
  the drop path had no `turn_end` log line; the 80-char excerpt is the
  fix that made the 2026-11-10 report diagnosable.
- **Gate:** **(judgement)** review: any `return` that skips a room write
  logs the skip and why.

---

*Provenance: principles 1–3 predate this file (architecture README,
coding standards, `SECURITY.md`). Principles 4–8 were extracted from the
2026-10 wake-loop and 2026-11 summary-mute incidents during PROP-001
(proposals are kept out of git; the file lives in `docs/dev/proposals/`).*
