/**
 * Pi Matrix Integration - room-encryption status vocabulary.
 *
 * The shared words/icons for a room's encryption state. Pure strings —
 * importable by any surface (TUI footer, commands, notifications) without
 * depending on the TUI widget module.
 */

/**
 * The room-encryption badge — the ONE source of the lock language shared by
 * the footer, the startup connect notice, and the /matrix-login room step.
 * Green lock = encrypted; red unlock = plaintext. `encrypted` is read from
 * the room's real `m.room.encryption` state, never from config.
 *
 * Lives here (not in tui-footer.ts) because the footer is ONE consumer of
 * this vocabulary, not its owner: /matrix-status, ui.notify and the login
 * flow all quote it, and the footer widget itself may move extensions.
 */
export function encryptionBadge(encrypted: boolean): { icon: string; label: string } {
  return encrypted
    ? { icon: "🔒", label: "encrypted" }
    : { icon: "🔓", label: "not encrypted" };
}

/** The plain-text encryption line for `ui.notify` (badge's words, no color). */
export function encryptionNotice(encrypted: boolean): string {
  const b = encryptionBadge(encrypted);
  return encrypted
    ? `${b.icon} ${b.label} (E2EE)`
    : `${b.icon} ${b.label} — messages go in plaintext`;
}
