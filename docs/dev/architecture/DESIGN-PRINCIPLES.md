# Design principles

Cross-cutting rules that shape how this extension is built. Each principle
sets its scene — what the system does, and what breaks when the rule is
not held — and then names its **why** (the reason the rule holds,
independent of any single incident) and its **enforced by** (the check,
test or review step that keeps it true), in the spirit of
[coding standards](../coding-standards.md): a rule with no enforcement is
marked **(judgement)** and stays a human call. Rules that already have a
home are quoted with a pointer, not copied — this file is the index, and
the sole home for the principles that had none.

When a change seems to need an exception to one of these, that is a
proposal, not a licence (see `AGENTS.md`, scope discipline).

## 1. One identity, one writer

The extension is the only bridge between a Pi session and its Matrix
room: what the session sends goes out over this bridge, and what room
members type comes back over it. Nothing outside the code stops a second
bridge from appearing — a script that starts another Matrix client, or a
second spot inside the extension that posts to the room. Each extra
bridge keeps its own records, and the checks that watch the first bridge
never see the second. So the rule is:

One Matrix account per Pi instance; every outbound message goes through
`src/outbox.ts`, every inbound room event arrives through
`src/inbound.ts`. A second client or a second dispatch point is a second
writer.

- **Why:** dedupe, rate limits, thread bookkeeping and the trust boundary
  all assume one choke point per direction. With two writers, each keeps
  its own records and no single check sees every message.
- **Enforced by:** review (coding standards, Structure table);
  [transport and state](transport-and-state.md).

## 2. Soft failure, both directions

Matrix lives on a network, and the homeserver can be down or stalled in
the middle of any session — exactly when the extension wants to send, or
while it is delivering what a room member typed. If either path lets a
connection error reach Pi's event loop, Pi stops, and so does the person
who only wanted to keep writing code. So the rule is:

A Matrix outage must not stop you coding. Outbound failures land in the
TUI footer and the log; an inbound event we cannot handle is logged and
skipped, never thrown into Pi's event loop.

- **Why:** writing code is local work; it should not stop because a
  remote service is down. A Matrix outage should show up as a degraded
  footer, not as a broken session.
- **Enforced by:** review against the soft-fail invariant;
  [transport and state](transport-and-state.md#soft-failure).

## 3. The room is the security boundary

Everyone in the connected room can talk to the agent, and what they type
can reach the model — including commands. Pi has no roles for room
members and the Matrix protocol offers no per-message authorisation that
could tell one sender from another, so nothing can filter *inside* the
room. The only door that actually locks is the room itself. So the rule
is:

Room membership is the only access control on what the agent hears and
what the room can trigger. Widening the room's command surface is a
proposal, never a drive-by.

- **Why:** room membership is the one access list the user can actually
  see and edit; every other trigger surface has no list to audit. A
  second channel would be access control nobody can check.
- **Enforced by:** `test/security-boundary.mjs`, the CI credential scan,
  and `AGENTS.md` rule 3; `SECURITY.md` carries the full statement.

## 4. Echo isolation: never arm your own trigger

Some features fire when "enough activity" has happened in a thread — the
thread summarizer is one. Activity has to be measured somewhere, and a
counter that counts every message in the thread counts the extension's
own posts too. Then a summary the extension wrote itself reads as fresh
activity, which fires the summarizer again, which posts again: the loop
feeds itself and never stops. So the rule is:

A feedback loop must not be fed by the system's own output. Anything that
counts "activity" as a dispatch condition must measure *incoming human*
signals, not the extension's own sends.

- **Why:** a meter that counts the system's own output drifts, and every
  number derived from it is wrong until the pollution is subtracted —
  and that subtraction is a second counter that must stay correct
  forever, in its own right a place to hide a bug.
- **Enforced by:** the two dispatch checks read only `humanMsgCount`,
  which `ThreadManager.recordHumanMessage()` advances solely from the
  human-input branch of `onMessageEnd`; the send path never runs a
  dispatch check. Pinned by `test/offline/summarize-cadence.mjs` (own
  sends dispatch nothing) and the dispatch blocks of
  `test/logic/01-threading.mjs` ("own sends do not drive the cadence").

## 5. Declare, don't detect

The extension sometimes posts messages it wrote itself into the same room
where people write: a directive to itself, a wake hint, a relayed answer.
Later code must tell those messages apart from human ones — a message the
extension posted itself must not trigger another run, for example. There
are two ways to tell them apart. *Detect*: at read time, guess from the
wording whether the message was ours. *Declare*: at write time, record
what the message is — a `details.kind`, a correlation carried from the
code that posted it — and let every later decision read that record.
Detection guesses where the answer was known the whole time: change the
wording somewhere else, and a guess silently goes wrong, which is how a
self-posted message slips past the loop guard of principle 4. So the rule
is:

When the extension injects a message (directive, wake hint, relay), its
identity is *declared* — a `details.kind`, a correlation carried from the
dispatch site — and every later decision reads that declaration. Pattern
matching our own message shapes at consumption time is detection, and it
misses.

- **Why:** whoever sends a message knows exactly what it is at the
  moment it is sent; a later consumer that re-infers the kind from the
  shape throws that knowledge away and replaces it with a guess. Every
  wrong guess looks like a lost echo or a false loop guard.
- **Enforced by:** **(judgement)** review: a new `is…Notice`-style
  classifier is a smell — carry the fact from the dispatch site instead.
  Both remaining classifiers are consulted at exactly one site —
  `before_agent_start` naming the run's trigger — never mid-run.

## 6. Decide at the turn's scope, from data — never from arrival order

When a run ends, the extension must answer "may this output reach the
room?" Pi signals the end of a run with several async lifecycle events
and promises no order among them. A decision keyed to which handler runs
first — a flag set in one event, cleared in another — is a bet on an
order nobody promised, and it loses as soon as a room message lands
between two of those events. So the rule is:

Answer per turn from facts the run knows (did this turn consume human
input?), not from a run-scoped flag plus a guess about which event fires
first. Async lifecycle events have no promised order; any state machine
that depends on one is a latent bug.

- **Why:** a per-turn fact is true no matter what order the events
  arrive in; a flag plus an assumed order breaks the moment the order
  changes.
- **Enforced by:** one expression, `summaryTriggerRun &&
  !humanInputPending`, read per turn — the mute, the lift and the
  wake-fuel flags are deleted. Pinned by `test/offline/summarizer-wake.mjs`
  (question queued before the directive, relay folded mid-run, absorbed
  notice). Review rule: any new boolean set in one hook and cleared in
  another needs a comment naming the event order it assumes — and a
  second look.

## 7. Background output gets its own channel

Some passes run without anyone asking — the background summarizer is one
— and the machinery that posts a real answer to the room is shared code.
Let a background pass reach that shared path and its output lands in the
room next to real answers; then someone writes a mute, and something else
must clear the mute, and each flag is a chance to get it wrong. So the
rule is:

A background pass writes through its dedicated sink (the thread-root edit
via `matrix_update_thread_summary`); it is not allowed to join the
user-facing broadcast path. Output with no destination cannot leak, so it
needs no mute.

- **Why:** output that shares the user-facing channel needs a suppression
  flag per background pass — a flag to set, clear, and get wrong. Output
  with its own sink needs none of that: nothing to mute, nothing to leak.
- **Enforced by:** a broadcast filter, not a guard — a summarizer-opened
  run's finals are held while no human input is pending, because a
  pure-summary turn has no answer in it. The dispatch rule itself is safe
  by construction (principle 4).

## 8. Degrade, but never go silent

Guards suppress room writes for good reasons — principle 6's filter is
one. From outside the room, a suppressed write and a stuck agent look the
same: no message arrives. If the suppression also leaves no trace, the
only way to tell the two apart is to read source code while the incident
runs. So the rule is:

When a guard suppresses a room write, it logs what was suppressed with an
excerpt of the payload (warn level). "The agent went quiet" must be
answerable from the log alone, not by reading source.

- **Why:** a suppression that logs nothing forces the reader into the
  source; the log line with the excerpt is the whole diagnosis.
- **Enforced by:** **(judgement)** review: any `return` that skips a room
  write logs the skip and why.
