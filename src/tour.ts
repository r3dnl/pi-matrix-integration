/**
 * Pi Matrix Integration — scripted introduction tour.
 *
 * The fixed onboarding runbook: every step is one exact, human-written
 * message posted by code through the outgoing pipeline
 * (`messageHandler.post`). The LLM is not in the loop in either direction:
 * no directive is injected (so no session turn starts), and the posted
 * messages echo back as own-user events, which the inbound funnel drops
 * before prompt injection — same guard as every other code-posted message.
 * Kept a pure function of `MatrixConfig` (like `buildMatrixHelp`) so the
 * sequence is unit-testable per config variant.
 */
import type { MatrixConfig } from "./types.js";
import type { SendKind } from "./threading.js";

export interface TourStep {
  text: string;
  kind: SendKind;
}

interface TourEntry extends TourStep {
  // Numbered steps are re-numbered after the conditional steps are pruned,
  // so no config variant shows "3." followed by "6.".
  numbered?: boolean;
}

/**
 * The fixed 11-step tour, in play order (maintainer-approved runbook).
 * Three steps follow their live config toggles, same as the help guide:
 * the `@` picker (`remoteFilePicker`), the `@@` attach (`fileAttach`) and
 * voice transcription (`voiceTranscription`, on unless explicitly off).
 */
export function buildTourScript(config: MatrixConfig): TourStep[] {
  const entries: TourEntry[] = [
    {
      kind: "other",
      text:
        "👋 Welcome — a quick tour of this room (about 2 minutes). It connects a Pi coding session to you: you steer from here, the agent works in the terminal.",
    },
    {
      kind: "other",
      numbered: true,
      text:
        "Just talk. Send a message in plain language and the agent picks it up on its next poll and replies here. Try it: say hello.",
    },
    {
      kind: "milestone",
      text:
        "🎯 Milestone: tour step 3 — this is the milestone format. Expect these when the agent hits checkpoints. You will also see 📋 TODO progress updates and 🧑 your terminal-typed prompts echoed here.",
    },
    {
      kind: "other",
      numbered: true,
      text:
        "Slash commands are relayed from the room into the terminal. Type /name here and it runs as if typed in the terminal — any extension or pipeline command. Misspell one and the agent suggests the closest match.",
    },
  ];
  if (config.remoteFilePicker) {
    entries.push({
      kind: "other",
      numbered: true,
      text:
        "Hand the agent a file with @. Send a fragment like @src/, or a glob like @src/*.ts. The room lists the matches; reply with the number and the file's contents are handed to the agent.",
    });
  }
  if (config.fileAttach) {
    entries.push({
      kind: "other",
      numbered: true,
      text:
        "Get files from the agent with @@. Send @@fragment here, pick from the list, and that work artifact is uploaded and attached to a room message.",
    });
  }
  if (config.voiceTranscription !== false) {
    entries.push({
      kind: "other",
      numbered: true,
      text:
        "Voice notes work too. Drop a voice message into the room or a thread — the agent transcribes it and treats it as typed text.",
    });
  }
  entries.push(
    {
      kind: "decision",
      numbered: true,
      text:
        "Decisions. When the agent needs a choice it posts a numbered list like this one — reply with the number or the option text. Nothing to answer now; this is what it looks like:\n1. Example option\n2. Another example option",
    },
    {
      kind: "other",
      numbered: true,
      text:
        "Sub-agents. For parallel work the agent spawns sub-agents and their activity is mirrored into this room. /matrix-subagents lists the live spawns.",
    },
    {
      kind: "other",
      numbered: true,
      text:
        "Threads. Each conversation lives in a thread and its root carries a running summary the agent refreshes as you talk. /matrix-thread-summarize forces a refresh right now.",
    },
    {
      kind: "other",
      numbered: true,
      text:
        "Controls. From the terminal: /matrix-status, /matrix-send TEXT, /matrix-messages [n], /matrix-connect, /matrix-disconnect, /matrix-toggle, /matrix-switch [profile]. From anywhere: send help (or run /pi-help) to re-post the full guide, /matrix-introduction-tour to replay this tour. That's it — go build something.",
    },
  );
  let n = 0;
  return entries.map(({ numbered, ...step }) =>
    numbered ? { ...step, text: `${++n}. ${step.text}` } : step,
  );
}

/**
 * Play the script: one message at a time, in order, through the caller's
 * post (the outgoing pipeline). `dedupe: false` is deliberate — a replay
 * within the dedupe window must still post every step. Throws on the first
 * failed send; the caller logs and the room keeps whatever already landed.
 */
export async function runTourScript(
  steps: TourStep[],
  post: (text: string, kind: SendKind) => Promise<{ success: boolean; error?: string }>,
): Promise<number> {
  for (const step of steps) {
    const result = await post(step.text, step.kind);
    if (!result.success) {
      throw new Error(`tour step failed: ${step.text.slice(0, 60)} — ${result.error ?? "send failed"}`);
    }
  }
  return steps.length;
}
