/**
 * Pi Matrix Integration — RoomUx.
 *
 * The room-facing auto-reply surface: the slash-relay suggestion reply, the
 * `@@` artifact-attach picker + uploads, the `@` file-attach picker, and the
 * /matrix-help guide. Every room
 * auto-reply posts through the outgoing pipeline (`post` =
 * MessageHandler.post — configuration-and-room-behaviour.md: MessageHandler is the only writer;
 * auto-replies ride the dedupe window).
 *
 * Uses the injected PickerState (configuration-and-room-behaviour.md: the two protocol pickers
 * are distinct tracker instances — the "never share a posted list"
 * invariant is a type-level fact). The instance is factory-scope in
 * index.ts, so picker memory survives /matrix-switch — the zero-delta
 * move of the two original factory-scope CandidateListTracker instances
 * (`index.ts:321/:324`). Stateful → class + one-line factory (the
 * message-handler.ts pattern); the instance itself is rebuilt with the
 * stack on /matrix-switch (the object-stable rebind discipline).
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
  extractArtifactToken,
  formatArtifactCaption,
  gitFileCommit,
  isLoneArtifactToken,
  isMediaPath,
  mimeFor,
  pickArtifactFiles,
} from "./artifact-attach.js";
import {
  expandBody,
  extractFileTokens,
  formatCandidateList,
  formatNumberedMatches,
  formatNoMatches,
  isLoneToken,
  matchCandidates,
  namesRealFile,
  nodeFsAttach,
  pickFiles,
  PickerState,
} from "./file-attach.js";
import { formatCommandSuggestion } from "./command-relay.js";
import { buildMatrixHelp } from "./matrix-help.js";
import type { Outbox } from "./outbox.js";
import type { SendKind } from "./threading.js";
import type { MatrixConfig, MatrixMessage, MatrixSendResult } from "./types.js";
import type { MatrixLogger } from "./logger.js";

export interface RoomUxDeps {
  cfg: MatrixConfig;
  logger: MatrixLogger;
  /** The Outbox seam for `@@` artifact uploads + in-thread notes
   *  (`postThreadReply`/`sendFile`); absent →
   *  the no-transport note path. */
  outbox?: Outbox;
  /** The pipeline write surface: room auto-replies post
   *  through the MessageHandler (`formatCommandSuggestion`, the picker
   *  lists, the help guide). */
  post: (text: string, kind?: SendKind) => Promise<MatrixSendResult>;
  /** The session-scoped picker state (the two protocol pickers). Injected
   *  from factory scope in index.ts so it SURVIVES /matrix-switch —
   *  the zero-delta move of the two original factory-scope
   *  CandidateListTracker instances (`index.ts:321/:324`). */
  picker: PickerState;
}

export interface RoomUx {
  /** The slash-relay suggestion reply (plain-text room send via the pipeline). */
  replySuggestion(name: string, candidates: string[]): void;
  /** `@@` artifact attach. True when the message was consumed (the funnel stops). */
  handleArtifactAttach(message: MatrixMessage): boolean;
  /** `@` file attach (10a expansion + 10b picker). `inject` lands the
   *  expanded body on the normal-injection path. True when consumed. */
  handleFileAttach(message: MatrixMessage, inject: (expanded: string) => void): boolean;
  /** Post the /matrix-help end-user guide into the room (the pipeline). */
  postHelp(): Promise<void>;
}

export class RoomUx {
  private readonly deps: RoomUxDeps;
  private readonly picker: PickerState;

  constructor(deps: RoomUxDeps) {
    this.deps = deps;
    this.picker = deps.picker;
  }

  replySuggestion(name: string, candidates: string[]): void {
    this.deps.post(formatCommandSuggestion(name, candidates), "other").catch((error: unknown) => {
      this.deps.logger.warn(`[matrix] command suggestion reply failed: ${error}`);
    });
  }

  handleArtifactAttach(matrixMessage: MatrixMessage): boolean {
    if (!this.deps.cfg.fileAttach || matrixMessage.isFromPi) return false;
    const aBody = (matrixMessage.body ?? "").trim();
    const outbox = this.deps.outbox;
    // When the request came from a thread, the auto-replies ride that
    // thread (the `m.relates_to` reply relation); otherwise flat room
    // (the pipeline post).
    const threadRoot = matrixMessage.threadRoot;
    // `outbox?.available()` instead of `outbox.available()`: the plain call threw a
    // TypeError on the no-outbox path, before the note could display. The
    // optional chain is what makes the guard live.
    const note = (message: string) => {
      if (threadRoot && outbox?.available()) {
        outbox.postThreadReply(message, threadRoot).catch((error: unknown) => {
          this.deps.logger.warn(`[matrix] artifact reply failed: ${error}`);
        });
        return;
      }
      this.deps.post(message, "other").catch((error: unknown) => {
        this.deps.logger.warn(`[matrix] artifact reply failed: ${error}`);
      });
    };
    const uploadArtifact = (relPath: string) => {
      let data: Buffer;
      try {
        data = readFileSync(join(process.cwd(), relPath));
      } catch {
        note(`@@${relPath} could not be read`);
        return;
      }
      // One attach cap for text and media (`maxBytesUpload`, default 25 MB).
      // Media is the binding case (screenshots and clips clear 200 KB easily),
      // so the shared cap takes the media number.
      const cap = this.deps.cfg.maxBytesUpload ?? 25_000_000;
      if (data.length > cap) {
        note(`@@${relPath} is ${data.length} bytes, over the ${cap}-byte attach cap`);
        return;
      }
      void outbox
        .sendFile(
          basename(relPath),
          data,
          mimeFor(relPath),
          formatArtifactCaption(basename(relPath), relPath, gitFileCommit(relPath, process.cwd())),
          threadRoot,
        )
        .then((r) => {
          if (!r.success) note(`@@${relPath}: upload failed (${r.error ?? "unknown"})`);
        });
    };
    // A numbered or exact-path reply resolves against the LAST candidate
    // list posted in this session (the artifact picker).
    const picked = this.picker.artifact.resolveReply(aBody);
    if (picked) {
      if (!outbox?.available()) note("File attachments need a live Matrix connection (the transport is the sdk outbox; check the connection status / credentials).");
      else uploadArtifact(picked);
      return true;
    }
    if (isLoneArtifactToken(aBody, this.deps.cfg.fileAttachPrefix ?? "@@", true)) {
      const fragment = extractArtifactToken(aBody, this.deps.cfg.fileAttachPrefix ?? "@@", true);
      const mode = this.deps.cfg.fileSearchMethod ?? "builtin";
      const matches = pickArtifactFiles(fragment, process.cwd(), undefined, mode, () => {
        this.deps.logger.warn("[matrix] artifact search: fzf unavailable, using builtin ranking");
      });
      const pickerLimit = this.deps.cfg.pickerLimit ?? 10;
      const unavailable = () => {
        note("File attachments need a live Matrix connection (the transport is the sdk outbox; check the connection status / credentials).");
      };
      // Same contract as the `@` picker: upload only when the fragment IS one of
      // the attachable paths, otherwise the menu decides. Exactness is judged
      // against the candidate list (extension-filtered), so a path to a
      // non-artifact file still lands in the "no matches" nudge, as before.
      if (matches.length === 1 && matches[0] === fragment) {
        this.picker.artifact.post(matches);
        if (outbox?.available()) uploadArtifact(matches[0]);
        else unavailable();
        return true;
      }
      if (matches.length === 0) {
        note(`No .md/.feature or media (image/audio/video) matches for @@${fragment}. Send a longer fragment (a path substring of the file you want).`);
        return true;
      }
      // Same contract as the `@` picker: show the top pickerLimit, say the list
      // is partial, and remember exactly what was shown.
      const shown = matches.slice(0, pickerLimit);
      note(formatNumberedMatches(`Artifact matches for @@${fragment}:`, shown, matches.length));
      this.picker.artifact.post(shown);
      return true;
    }
    return false;
  }

  handleFileAttach(matrixMessage: MatrixMessage, inject: (expanded: string) => void): boolean {
    if (!this.deps.cfg.remoteFilePicker || matrixMessage.isFromPi) return false;
    const rawBody = matrixMessage.body ?? "";
    const body = rawBody.trim();
    const attachOpts = {
      cwd: process.cwd(),
      attachMaxBytes: this.deps.cfg.attachMaxBytes ?? 200_000,
      // realpath-based resolve: a symlink pointing outside the cwd is
      // caught by the prefix check; a missing path falls back to the
      // lexical resolve and the exists() check reports "missing".
      fs: nodeFsAttach(process.cwd()),
    };
    // The configured token prefix (default "@"): ONE read — the picker
    // test, the reconstructed tokens and the inline expansion must agree,
    // or half the feature runs on the changed prefix and half on "@".
    const prefix = this.deps.cfg.filePickerPrefix ?? "@";
    // 10b protocol: a numbered or exact-path reply resolves against the
    // last candidate list posted in this session.
    const picked = this.picker.file.resolveReply(body);
    if (picked) {
      inject(expandBody(`${prefix}${picked}`, attachOpts, prefix));
      return true;
    }
    // `globs`: the picker understands `*` (`@src/*.ts`). An ordinary message
    // keeps the strict token charset, so a stray glob stays literal text.
    if (isLoneToken(body, prefix, true)) {
      const fragment = extractFileTokens(body, prefix, true)[0] ?? "";
      // A fragment that is itself a real path attaches directly — there is
      // nothing to choose. A search always answers with the menu, even when it
      // finds one candidate: `@config.ts` matching one file is a guess about
      // which file the user meant, and a silent wrong guess costs an attached
      // file nobody asked for.
      if (namesRealFile(fragment, attachOpts)) {
        inject(expandBody(`${prefix}${fragment}`, attachOpts, prefix));
        return true;
      }
      const matches = matchCandidates(fragment, pickFiles(fragment));
      if (matches.length === 0) {
        // 0 matches: nudge in the room AND inject the token kept
        // verbatim + note so the LLM still sees the attempt.
        this.deps.post(formatNoMatches(fragment, prefix), "other").catch((error: unknown) => {
          this.deps.logger.warn(`[matrix] no-matches reply failed: ${error}`);
        });
        inject(expandBody(rawBody, attachOpts, prefix));
        return true;
      }
      // More matches than pickerLimit: show the top pickerLimit instead of
      // refusing. `@src/` in a real repo always exceeds the limit, and a
      // truncated list still reaches the file in one reply — matchCandidates
      // ranks shortest path first, so what survives the cut is the closest
      // thing to what was asked. The tracker stores the SAME slice the room
      // sees: a number must never resolve to a path that was never posted.
      const shown = matches.slice(0, this.deps.cfg.pickerLimit ?? 10);
      this.picker.file.post(shown);
      this.deps.post(formatCandidateList(fragment, shown, matches.length, prefix), "other").catch((error: unknown) => {
        this.deps.logger.warn(`[matrix] candidate list reply failed: ${error}`);
      });
      return true;
    }

    // 10a: inline expansion of @tokens in an ordinary message.
    const expanded = expandBody(rawBody, attachOpts, prefix);
    if (expanded !== rawBody) {
      inject(expanded);
      return true;
    }
    return false;
  }

  async postHelp(): Promise<void> {
    const result = await this.deps.post(buildMatrixHelp(this.deps.cfg), "other");
    if (!result.success && !result.deduped) {
      this.deps.logger.warn(`[matrix] help send failed: ${result.error}`);
    }
  }
}

/** Build the room-UX aggregation (the one-line factory pattern). */
export function createRoomUx(deps: RoomUxDeps): RoomUx {
  return new RoomUx(deps);
}
