# Answering questionnaires from phone and terminal

`ask_user_question` questionnaires appear on both surfaces at once: the
terminal dialog and a mirrored question in the Matrix room. Answer wherever
you are; whichever side completes the full set first wins.

## Room reply grammar

- Option number or label: `2`, or `Q2: 3` to name the question.
- Multiple options (multi-select questions): `2 3`.
- Free text: `Custom: your text`.
- Yes/no questions: 👍 / 👎 (also ✅ / ❌).
- When every question is answered, the room gets a review step: reply
  `Qn: x` or `Custom: text` to correct, `confirm` or 👍 to proceed.

## Terminal synchronisation needs one command

The room flow works on a stock install: each room reply is buffered, and
`confirm` settles the questionnaire. What a stock install does **not** do:

- the terminal dialog does not live-follow your room replies (tab
  highlighting and typed text stay put until confirm);
- answers typed in the terminal are not mirrored back into the room.

Full dual-surface behaviour needs two small patches to
`@juicesharp/rpiv-ask-user-question`. If you do not have that extension yet,
install it first (`pi install npm:@juicesharp/rpiv-ask-user-question`). This
package ships the patches, applied by one script:

```bash
sh ~/.pi/agent/npm/node_modules/pi-matrix-integration/patches/rpiv-ask-user-question/apply.sh
```

Check the state at any time:

```bash
sh ~/.pi/agent/npm/node_modules/pi-matrix-integration/patches/rpiv-ask-user-question/apply.sh --check
```

Facts to know:

- `apply.sh` needs the `patch` command (debian/ubuntu: `apt-get install patch`
  · alpine: `apk add patch`). Without it nothing can be patched, and the script
  now says exactly that instead of blaming upstream.
- The mirror checks at questionnaire-open time whether the installed package
  understands the pairing. When it does not — `patch` missing, or upstream
  moved past 2.13.9, the version these hunks were cut against — the terminal
  tab stays put and the room keeps the confirm gate: nothing answers the
  questionnaire on your behalf. The Pi log names it once per questionnaire:
  `ask-user display sync refused … run apply.sh --check`.
- The script is idempotent. Run it again any time; if the patches are in
  place it says so and does nothing.
- Run it after **every** install or update of
  `@juicesharp/rpiv-ask-user-question`. An update replaces the package on
  disk and drops the patches silently.
- If the script reports a dry-run failure, the dependency changed the
  patched source. The room question flow keeps working; only the terminal
  synchronisation is lost until the patch is rebased. Open an issue.
- Restart Pi (or `/reload`) after applying.
