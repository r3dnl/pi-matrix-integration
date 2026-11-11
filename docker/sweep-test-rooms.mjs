// TTL sweep for the live-tier junk rooms on the maintainer's TEST homeserver
// only (credentials arrive via docker/.env through compose — same as make e2e).
// Purges rooms that are: named e2e-*/live-e2e-*/optout-*, CREATED BY the agent
// account (PI_MATRIX_USERNAME), and older than SWEEP_TTL_DAYS (default 7).
// Purge requires the Synapse admin API, so admin identity is the second actor:
// PI_MATRIX_SECOND_TOKEN, or PI_MATRIX_SECOND_USER + PI_MATRIX_SECOND_PASSWORD
// (same contract as the live scenario suite). Discovery runs against the admin
// room list, not joined_rooms — the admin account is not a member of most
// harness rooms. Run from cron; see the crontab entry.
const hs = process.env.PI_MATRIX_HOMESERVER;
const agentUser = process.env.PI_MATRIX_USERNAME;
const ttlMs = Number(process.env.SWEEP_TTL_DAYS ?? 7) * 24 * 60 * 60 * 1000;
const JUNK = /^(optout|e2e|live-e2e)-/;
const missing = [
  [hs, "PI_MATRIX_HOMESERVER"],
  [agentUser, "PI_MATRIX_USERNAME"],
  [process.env.PI_MATRIX_SECOND_TOKEN || (process.env.PI_MATRIX_SECOND_USER && process.env.PI_MATRIX_SECOND_PASSWORD),
    "PI_MATRIX_SECOND_TOKEN or PI_MATRIX_SECOND_USER+PI_MATRIX_SECOND_PASSWORD"],
].filter(([v]) => !v).map(([, n]) => n);
if (missing.length) {
  console.error(`sweep: missing ${missing.join(", ")} — aborting without touching anything`);
  process.exit(1);
}

const loginWith = async (user, pass) => {
  const r = await fetch(`${hs}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password: pass }),
  });
  const j = await r.json();
  if (!j.access_token) console.log(`sweep: login as ${user} HTTP ${r.status}: ${j.errcode ?? ""} ${j.error ?? ""}`);
  return j.access_token;
};

// compose fills unset vars with "" — treat empty as absent (?? would pass "" through).
const adminToken = process.env.PI_MATRIX_SECOND_TOKEN
  || await loginWith(process.env.PI_MATRIX_SECOND_USER, process.env.PI_MATRIX_SECOND_PASSWORD);
if (!adminToken) { console.error("sweep: admin login failed — aborting"); process.exit(1); }
const admin = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
// Identity anchor: which account the harness rooms belong to.
const agentUserId = `@${agentUser}:${new URL(hs).host}`;

// Admin room list, paginated. First call doubles as the admin-capability check.
const rooms = [];
let since;
for (;;) {
  const r = await fetch(`${hs}/_synapse/admin/v1/rooms?limit=200&dir=b${since ? `&from=${since}` : ""}`, { headers: admin });
  if (r.status === 403) { console.error(`sweep: admin account is not a server admin (403) — aborting: ${await r.text()}`); process.exit(1); }
  if (!r.ok) { console.error(`sweep: room list HTTP ${r.status} — aborting`); process.exit(1); }
  const j = await r.json();
  rooms.push(...(j.rooms ?? []));
  if (!j.next_batch) break;
  since = j.next_batch;
}

let purged = 0;
for (const { room_id: id, name = "" } of rooms) {
  if (!JUNK.test(name)) continue;
  const infoRes = await fetch(`${hs}/_synapse/admin/v1/rooms/${encodeURIComponent(id)}`, { headers: admin });
  if (!infoRes.ok) { console.log(`skip ${name}: admin detail HTTP ${infoRes.status}`); continue; }
  const info = await infoRes.json();
  if (info.creator !== agentUserId) { console.log(`skip ${name}: creator is ${info.creator}, not ${agentUserId}`); continue; }
  const age = Date.now() - Number(info.created_at); // admin API created_at is epoch ms
  if (age <= ttlMs) { console.log(`keep ${name}: ${Math.floor(age / 3600000)} h old (TTL ${ttlMs / 86400000} d)`); continue; }
  const del = await fetch(`${hs}/_synapse/admin/v1/rooms/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: admin, body: JSON.stringify({ purge: true }),
  });
  console.log(`${del.ok ? "purged" : "FAILED"} ${name} (${Math.floor(age / 86400000)} d old) HTTP ${del.status}`);
  if (del.ok) purged++;
}
console.log(`sweep done: ${rooms.length} rooms listed, ${purged} purged`);
