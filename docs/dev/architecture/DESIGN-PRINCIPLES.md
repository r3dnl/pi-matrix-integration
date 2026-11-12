# Design principles

Cross-cutting rules that shape how this extension is built. Each principle
names its **why** — the reason the rule holds, independent of any single
incident — and its **enforced by** — the check, test or review step that
keeps it true — in the spirit of
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
- **Enforced by:** review (coding standards, Structure table);
  [transport and state](transport-and-state.md).

## 2. Soft failure, both directions

A Matrix outage must not stop you coding. Outbound failures land in the
TUI footer and the log; an inbound event we cannot handle is logged and
skipped, never thrown into Pi's event loop.

- **Why:** Matrix is a remote network service that can be down; writing
  code is local work. A connectivity failure should show up as a degraded
  footer, not as a broken session.
- **Enforced by:** review against the soft-fail invariant;
  [transport and state](transport-and-state.md#soft-failure).

## 3. The room is the security boundary

Room membership is the only access control on what the agent hears and
what the room can trigger. Widening the room's command surface is a
proposal, never a drive-by.

- **Why:** room membership is the one access list the user can actually
  see and edit; every other trigger surface has no membership list to
  audit. A second channel would be access control nobody can check.
- **Enforced by:** `test/security-boundary.mjs`, the CI credential scan,
  and `AGENTS.md` rule 3; `SECURITY.md` carries the full statement.

## 4. Echo isolation: never arm your own trigger

A feedback loop must not be fed by the system's own output. Anything that
counts "activity" as a dispatch condition must measure *incoming human*
signals, not the extension's own sends.

- **Why:** a meter that counts the system's own output drifts, and every
  number derived from it is wrong until compensated — compensation is two
  counters fighting each other, and each one is a place to hide a bug.
- **Enforced by:** the cadence and content gates read only
  `humanMsgCount`, advanced by `ThreadManager.recordHumanMessage()` from
  the human-input branch of `onMessageEnd`; the send path never runs the
  cadence gate. Pinned by `test/offline/summarize-cadence.mjs` (own sends
  dispatch nothing) and the cadence blocks of `test/logic/01-threading.mjs`
  ("own sends do not drive the cadence").

## 5. Declare, don't detect

When the extension injects a message (directive, wake hint, relay), its
identity is *declared* — a `details.kind`, a correlation carried from the
dispatch site — and every later decision reads that declaration. Pattern
matching our own message shapes at consumption time is detection, and it
misses.

- **Why:** a message's identity is known exactly at the moment it is
  created; re-inferring it later from its shape throws that fact away and
  replaces knowledge with a guess. Every wrong guess looks like a lost
  echo or a false loop guard.
- **Enforced by:** **(judgement)** review: a new `is…Notice`-style
  classifier is a smell — carry the fact from the dispatch site instead.
  Both remaining classifiers are consulted at exactly one site —
  `before_agent_start` naming the run's trigger — never mid-run.

## 6. Decide at the turn's scope, from data — never from arrival order

"May this output reach the room?" is answered per turn from facts the run
knows (did this turn consume human input?), not from a run-scoped flag
plus a guess about which event fires first.

- **Why:** async lifecycle events have no promised order, so a decision
  keyed to arrival order is a guess about the future. A per-turn fact is
  true in every interleaving; a run-scoped flag plus an assumed order
  breaks the moment the interleaving changes.
- **Enforced by:** one expression, `summaryTriggerRun &&
  !humanInputPending`, read per turn — the mute, the lift and the
  wake-fuel flags are deleted. Pinned by `test/offline/summarizer-wake.mjs`
  (question queued before the directive, relay folded mid-run, absorbed
  notice). Review rule: any new boolean set in one hook and cleared in
  another needs a comment naming the interleaving it assumes — and a
  second look.

## 7. Background output gets its own channel

A background pass writes through its dedicated sink (the thread-root edit
via `matrix_update_thread_summary`); it is not allowed to join the
user-facing broadcast path. Output with no destination cannot leak, so it
needs no mute.

- **Why:** output that shares the user-facing channel needs a suppression
  flag per background pass — a flag to set, clear, and get wrong. Output
  with its own sink needs none of that: nothing to mute, nothing to leak.
- **Enforced by:** a broadcast filter, not a guard — a summarizer-opened
  run's finals are held while no human input is pending, because a
  pure-summary turn has no answer in it. The cadence itself is immune by
  construction (principle 4).

## 8. Degrade, but never go silent

When a guard suppresses a room write, it logs what was suppressed with an
excerpt of the payload (warn level). "The agent went quiet" must be
answerable from the log alone, not by reading source.

- **Why:** a suppressed write and a hung agent look identical from
  outside. If the log cannot say what was suppressed and why, the only
  diagnosis left is reading source while the incident runs.
- **Enforced by:** **(judgement)** review: any `return` that skips a room
  write logs the skip and why.

---

*Provenance: principles 1–3 predate this file (architecture README,
coding standards, `SECURITY.md`). Principles 4–8 were extracted during
PROP-001 from two incidents: the 2026-10 summary wake loop — own sends
bumping the cadence counter, invisible for a whole session behind a silent
drop path (principles 4 and 8) — and the 2026-11 summary-mute report, a
question queued before a directive losing its answer (principles 5–7).
The enforcement mechanics in "Enforced by" landed with PROP-001 P2/P3.
Proposals are kept out of git; the PROP files live in
`docs/dev/proposals/`.*
