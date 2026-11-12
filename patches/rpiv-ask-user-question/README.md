# rpiv-ask-user-question — pairing patches

Local patches for the installed
[`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
package. Its answer channel lets this extension settle a questionnaire from
the Matrix room, but it does not tell the mounted terminal dialog about
answers that arrive from outside. These two hunks close that gap:

| Patch | What it adds |
|-------|--------------|
| `0001-partial-answer-registration.patch` | A `partial` answer set registers into the mounted TUI dialog for **display** (entries, clears, tab advance) without resolving the wait. The room mirror ships one per reply; the authoritative complete set still ships on confirm. |
| `0002-terminal-answers-sync.patch` | Every answer-map change in the dialog — terminal keystroke or a 0001 partial — broadcasts the full map, so the mirror sees terminal-side answers and can arm its review surface. Depends on 0001; the order matters. |

Without them the room flow still works (a complete answer settles on
confirm), but the terminal does not follow room replies and terminal
keystrokes do not reach the room.

## Apply

**pre-requisite: patch binary**

`apply.sh` patches the installed package in `~/.pi/agent/npm/node_modules/`.
The package is not a dependency of this extension — install it first with
`pi install npm:@juicesharp/rpiv-ask-user-question`:

```sh
sh ~/.pi/agent/npm/node_modules/pi-matrix-integration/patches/rpiv-ask-user-question/apply.sh
sh .../apply.sh --check   # exit 0 when applied, 1 when missing; used by npm run test:integration
```

Re-run it after any update of the ask-user-question package — an update
replaces the patched files. `npm run test:integration` (maintainer machine,
never a CI gate) fails when the installed package has lost the patches.

User-facing background: [docs/user/ask-user-pairing.md](../../docs/user/ask-user-pairing.md).
