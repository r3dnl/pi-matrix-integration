#!/usr/bin/env node
/**
 * Fake `mtx` binary for testing the matrix-client / message-handler logic
 * without a real homeserver. State lives in $FAKE_MTX_STATE.
 */
const fs = require("fs");

const stateDir = process.env.FAKE_MTX_STATE;
const [verb, action, ...rest] = process.argv.slice(2);

function events() {
  try {
    return JSON.parse(fs.readFileSync(`${stateDir}/events.json`, "utf8"));
  } catch {
    return [];
  }
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

switch (`${verb} ${action}`.trim()) {
  case "user whoami":
    out({
      env: "tst2",
      user: "pi-agent",
      user_id: "@pi-agent:tst2-matrix.r3d.nl",
      domain: "tst2-matrix.r3d.nl",
      homeserver: "https://tst2-matrix.r3d.nl",
    });
    break;
  case "room list":
    out({
      env: "tst2",
      user: "pi-agent",
      domain: "tst2-matrix.r3d.nl",
      rooms: [
        {
          room_id: "!pi-updates:tst2-matrix.r3d.nl",
          alias: "#pi-updates:tst2-matrix.r3d.nl",
        },
      ],
    });
    break;
  case "message send": {
    const text = rest.find((a) => !a.startsWith("-")) || "";
    // The matrix-client forwards the config-driven prod allowance to the child
    // env; record it so tests can assert the MTX_ALLOW_PROD plumbing.
    fs.writeFileSync(
      `${stateDir}/last-send-allow-prod.txt`,
      process.env.MTX_ALLOW_PROD ?? "",
      "utf8",
    );
    // `--html <html>` (item 7a): the real CLI posts format + formatted_body;
    // the fake mirrors the event content so client logic can be asserted.
    const htmlIdx = rest.indexOf("--html");
    const html = htmlIdx !== -1 && htmlIdx + 1 < rest.length ? rest[htmlIdx + 1] : undefined;
    fs.writeFileSync(`${stateDir}/last-send.txt`, text, "utf8");
    if (html !== undefined) {
      fs.writeFileSync(`${stateDir}/last-send-html.txt`, html, "utf8");
    } else {
      fs.rmSync(`${stateDir}/last-send-html.txt`, { force: true });
    }
    const evts = events();
    const seq =
      (fs.existsSync(`${stateDir}/counter`)
        ? parseInt(fs.readFileSync(`${stateDir}/counter`, "utf8"), 10)
        : 0) + 1;
    fs.writeFileSync(`${stateDir}/counter`, String(seq), "utf8");
    evts.push({
      event_id: `$evt-S${seq}`,
      sender: "@pi-agent:tst2-matrix.r3d.nl",
      origin_server_ts: Date.now(),
      type: "m.room.message",
      room_id: "!pi-updates:tst2-matrix.r3d.nl",
      content:
        html !== undefined
          ? { body: text, format: "org.matrix.custom.html", formatted_body: html, msgtype: "m.text" }
          : { body: text, msgtype: "m.text" },
    });
    fs.writeFileSync(`${stateDir}/events.json`, JSON.stringify(evts, null, 1));
    out({
      env: "tst2",
      domain: "tst2-matrix.r3d.nl",
      sent: [{ t: "0s", user: "pi-agent", event_id: `$evt-S${seq}`, ok: true }],
    });
    break;
  }
  case "message read": {
    // Count completed read cycles so tests can await "at least one poll
    // finished" deterministically instead of sleeping a fixed window.
    const rc = fs.existsSync(`${stateDir}/read-count`)
      ? parseInt(fs.readFileSync(`${stateDir}/read-count`, "utf8"), 10)
      : 0;
    fs.writeFileSync(`${stateDir}/read-count`, String(rc + 1));
    out({
      env: "tst2",
      domain: "tst2-matrix.r3d.nl",
      user: "pi-agent",
      room: "!pi-updates:tst2-matrix.r3d.nl",
      messages: events(),
      unread_cleared: 0,
    });
    // Second counter: a read cycle is *complete* (its event snapshot was
    // taken) — tests that add events must wait on this, or the snapshot may
    // race their write and the baseline round remembers what the live round
    // was supposed to emit.
    const dc = fs.existsSync(`${stateDir}/read-done`)
      ? parseInt(fs.readFileSync(`${stateDir}/read-done`, "utf8"), 10)
      : 0;
    fs.writeFileSync(`${stateDir}/read-done`, String(dc + 1));
    break;
  }
  case "room members":
    out({
      env: "tst2",
      room: "!pi-updates:tst2-matrix.r3d.nl",
      members: {
        "@vincent:tst2-matrix.r3d.nl": "join",
        "@pi-agent:tst2-matrix.r3d.nl": "join",
      },
    });
    break;
  case "unread":
    out({ stale: false, accounts: { "pi-agent": { total: 0, rooms: {} } } });
    break;
  default:
    process.stderr.write(`fake-mtx: unknown command "${verb} ${action}"\n`);
    process.exit(2);
}
