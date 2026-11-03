// Integration guard: the INSTALLED @juicesharp/rpiv-ask-user-question must
// carry the native answer channel (>= 2.13) AND the local kit v2 patch
// (partial answer registration). A silent `pi install` / npm update reverts
// the patch — this test fails loudly so the next run says "re-run apply.sh"
// instead of the terminal tab silently stop following room answers.
//
//   node test/integration/installed-patches.mjs

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

// Env override or pi's global npm root (installed via `pi install`, not in
// the extension's own node_modules) — same convention as apply.sh.
const pkgRoot =
  process.env.RPIV_AUQ_PKG ||
  `${homedir()}/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/`;

if (!existsSync(pkgRoot + "state/state-reducer.ts")) {
  console.error(`package not found at ${pkgRoot} — skip (install it or set RPIV_AUQ_PKG).`);
  process.exit(0);
}
const events = readFileSync(pkgRoot + "events.ts", "utf8");
const channel = readFileSync(pkgRoot + "answer-channel.ts", "utf8");

const checks = [
  ["channel: inbound rpiv:ask-user:answer", /ASK_USER_ANSWER_EVENT\s*=\s*"rpiv:ask-user:answer"/.test(events)],
  ["channel: verdict rpiv:ask-user:answer-result", /ASK_USER_ANSWER_RESULT_EVENT\s*=\s*"rpiv:ask-user:answer-result"/.test(events)],
  ["channel: prompt carries toolCallId (answers address the wait)", /toolCallId\??:\s*(readonly )?string/.test(events)],
  ["channel: cancel path on the answer payload", /cancel\?:\s*boolean/.test(events)],
  ["channel: indexed entries (optionIndexes, no label payloads)", /optionIndexes\?:\s*readonly number\[\]/.test(events)],
  ["patch 0001: partial flag on the payload", /partial\?:\s*boolean/.test(events)],
  ["patch 0001: mounted-session partial target (attachPartial)", /attachPartial\(/.test(channel)],
  ["patch 0002: outbound answers-state channel", /ASK_USER_ANSWERS_STATE_EVENT\s*=\s*"rpiv:ask-user:answers-state"/.test(events)],
  ["patch 0002: state broadcast wired (broadcastAnswers)", /broadcastAnswers\(/.test(channel)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed — the installed package lost the native channel or the kit v2 patch.`);
  console.error("Fix: sh ~/.pi/agent/extensions/rpiv-patches/rpiv-ask-user-question/apply.sh, then /reload Pi.");
  process.exit(1);
}
console.log("\ninstalled package: native channel + kit v2 patch OK");
