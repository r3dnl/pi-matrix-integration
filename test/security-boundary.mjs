/**
 * Security-boundary contract (story 6) — the runnable check.
 *
 *   1. credentials land on disk at mode 0600;
 *   2. the http:// policy: local servers pass, loopback detection is exact,
 *      the scripted hatch reads the environment variable;
 *   3. the login fetch refuses a cross-host redirect and follows a
 *      same-host one;
 *   4. a room-supplied filename cannot escape the working directory
 *      (`../`, absolute paths, symlink targets outside the root);
 *   5. a flooding room cannot enqueue unbounded work: the rate cap drops
 *      the excess with one visible notice;
 *   6. the fixture access token never appears in any log line, console
 *      write, or room post during a full inbound cycle;
 *   7. the command relay adds no power of its own: relay code is pure
 *      parsing, and the room path only ever calls Pi's own registry
 *      surface (getCommands / sendUserMessage).
 *
 * Run: node test/security-boundary.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("security-boundary");

// --- 1. credential file mode -----------------------------------------------
{
  const { saveCredentials } = await jiti.import(`${EXT_DIR}/src/login.ts`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secbound-creds-"));
  const file = saveCredentials(dir, {
    access_token: "syt_tok_123",
    device_id: "DEVICE",
    homeserver: "https://matrix.example.org",
    user_id: "@pi_agent:example.org",
  });
  const mode = fs.statSync(file).mode & 0o777;
  check("credentials file is written 0600", mode === 0o600, mode.toString(8));
  const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
  check("account directory is written 0700", dirMode === 0o700, dirMode.toString(8));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2. http policy ----------------------------------------------------------
{
  const { isLocalHomeserver, insecureHttpExplicitlyAllowed } = await jiti.import(`${EXT_DIR}/src/login.ts`);
  check("localhost is local", isLocalHomeserver("http://localhost:8008"));
  check("127.x is local", isLocalHomeserver("http://127.0.0.1:8008"));
  check("::1 is local", isLocalHomeserver("http://[::1]:8008"));
  check(".local is local", isLocalHomeserver("http://synapse.local"));
  check("a public host is NOT local", !isLocalHomeserver("http://matrix.example.org"));
  check("an LAN address is NOT local (needs the explicit hatch)", !isLocalHomeserver("http://10.0.0.5"));
  check("https is never the http question", !isLocalHomeserver("https://localhost"));
  check("hatch closed by default", !insecureHttpExplicitlyAllowed());
  process.env.PI_MATRIX_ALLOW_INSECURE_HTTP = "1";
  check("hatch opens on PI_MATRIX_ALLOW_INSECURE_HTTP=1", insecureHttpExplicitlyAllowed());
  delete process.env.PI_MATRIX_ALLOW_INSECURE_HTTP;
}

// --- 3. cross-host redirect refusal ------------------------------------------
{
  const { makeLoginFetch } = await jiti.import(`${EXT_DIR}/src/login.ts`);
  const scripted = (steps) => {
    const seen = [];
    const base = async (input) => {
      const url = typeof input === "string" ? input : input.href;
      seen.push(url);
      const next = steps.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return next;
    };
    return { fetch: makeLoginFetch(base), seen };
  };

  const direct = scripted([new Response("ok", { status: 200 })]);
  const r1 = await direct.fetch("https://matrix.example.org/_matrix/client/v3/login");
  check("plain 200 passes through", r1.status === 200 && direct.seen.length === 1);

  const same = scripted([
    new Response(null, { status: 302, headers: { location: "/_matrix/client/v3/login-2" } }),
    new Response("ok", { status: 200 }),
  ]);
  const r2 = await same.fetch("https://matrix.example.org/_matrix/client/v3/login");
  check(
    "same-host redirect is followed",
    r2.status === 200 && same.seen.length === 2 && same.seen[1] === "https://matrix.example.org/_matrix/client/v3/login-2",
    JSON.stringify(same.seen),
  );

  const cross = scripted([new Response(null, { status: 301, headers: { location: "https://evil.example/collect" } })]);
  let threw = "";
  try {
    await cross.fetch("https://matrix.example.org/login");
  } catch (error) {
    threw = String(error.message ?? error);
  }
  check(
    "cross-host redirect is refused, naming both hosts",
    /Cross-host redirect refused.*matrix\.example\.org.*evil\.example/.test(threw),
    threw || "no error thrown",
  );
}

// --- 4. filename containment --------------------------------------------------
{
  const { resolveFileToken } = await jiti.import(`${EXT_DIR}/src/file-attach.ts`);
  // Production semantics: fs.resolve is realpath — a symlink pointing out of
  // the tree resolves to the outside target.
  const cwd = "/project/work";
  const opts = {
    cwd,
    attachMaxBytes: 1_000_000,
    fs: {
      exists: () => true,
      size: () => 10,
      read: () => "content",
      resolve: (p) => (p === "escape" || p.startsWith("../") || p.startsWith("/outside")
        ? "/home/user/.pi/agent/settings.json" // the escape targets resolve outside
        : p.startsWith("/") ? p : `${cwd}/${p}`),
    },
  };
  const t1 = resolveFileToken("../outside/secret", opts);
  check("`../` token is refused as outside", t1.kind === "outside", t1.kind);
  const t2 = resolveFileToken("/outside/etc/passwd", {
    ...opts,
    fs: { ...opts.fs, resolve: () => "/etc/passwd" },
  });
  check("absolute escape is refused as outside", t2.kind === "outside", t2.kind);
  const t3 = resolveFileToken("escape", opts);
  check("symlink to an outside target is refused", t3.kind === "outside", t3.kind);
  const t4 = resolveFileToken("src/main.ts", opts);
  check("an inside path still expands", t4.kind === "expanded", t4.kind);
}

// --- 5. room flood cap + 6. token never echoes ---------------------------------
{
  const { createInbound } = await jiti.import(`${EXT_DIR}/src/inbound.ts`);
  const TOKEN = "syt_tok_123";
  const injected = [];
  const posted = [];
  const logged = [];
  const mk = (extra) =>
    createInbound({
      cfg: {
        slashRelay: false,
        mirrorAskUser: false,
        voiceTranscription: false,
        userId: "@pi_agent:example.org",
        accessToken: TOKEN,
        maxMessageAgeMinutes: 0, // age guard off: this leg tests the RATE guard
        ...extra,
      },
      logger: {
        debug: (m) => logged.push(String(m)),
        info: (m) => logged.push(String(m)),
        warn: (m) => logged.push(String(m)),
        error: (m) => logged.push(String(m)),
      },
      pi: { sendUserMessage: () => {}, getCommands: () => [] },
      threadManager: { enabled: () => false, activeRoot: () => undefined, adoptRoot: () => {} },
      mirror: { tryConsumeReply: () => false },
      roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
      messageHandler: {
        handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
        post: async (text) => {
          posted.push(String(text));
          return { success: true };
        },
      },
      sessionIntegrator: { injectMatrixMessage: (m) => injected.push(m.body) },
      voiceTranscriber: { transcribe: async () => ({ text: "" }) },
    });

  const a = mk();
  const msg = (i) => ({
    eventId: `$f${i}`,
    sender: "@spam:example.org",
    body: `flood ${i}`,
    timestamp: Date.now(),
    roomId: "!room:example.org",
    isFromPi: false,
  });
  for (let i = 0; i < 40; i++) a.dispatch(msg(i));
  check("flood: the cap lets 30 through", injected.length === 30, `${injected.length} injected`);
  check("flood: the excess is warned per drop", logged.filter((l) => /rate limit/.test(l)).length === 10);
  await waitUntil(() => posted.length >= 1, { timeoutMs: 6_000, label: "flood notice" }).catch(() => {});
  check("flood: one visible room notice naming the limit", /rate limit \(30 per minute\)/.test(posted[0] ?? ""), posted[0]);

  // 6: the credential never surfaces anywhere — not in a log line, not in
  // a room post, not in what reaches the session. (One message carries a
  // body-level secret too: room text reaching Pi is the feature; leaking
  // the ACCESS TOKEN is not.)
  const all = [...logged, ...posted, ...injected];
  const leaked = all.filter((line) => line.includes(TOKEN));
  check("the access token appears in no log line, post, or injection", leaked.length === 0, leaked[0]);

  // Room message content stays out of the LOG too (the session is the
  // consumer, the log is not): a fresh fixture, one message, body secret.
  const b = mk();
  b.dispatch({
    eventId: "$leak",
    sender: "@vincent:example.org",
    body: "hello BODY_SECRET_do_not_log",
    timestamp: Date.now(),
    roomId: "!room:example.org",
    isFromPi: false,
  });
  const bodyLeak = logged.filter((line) => line.includes("BODY_SECRET_do_not_log"));
  check("message bodies stay out of the log", bodyLeak.length === 0, bodyLeak[0]);
}

// --- 7. the relay adds no power of its own ------------------------------------
{
  const relaySrc = fs.readFileSync(path.join(EXT_DIR, "src/command-relay.ts"), "utf8");
  const inboundSrc = fs.readFileSync(path.join(EXT_DIR, "src/inbound.ts"), "utf8");
  check(
    "command-relay.ts imports no filesystem, process, or network module",
    !/from "(node:)?(fs|path|child_process|net|http|https|os)"/.test(relaySrc) && !/require\(/.test(relaySrc),
  );
  const stripped = relaySrc.replace(/\/\*[\s\S]*?\*\//g, "").replace( /^\s*\/\/.*$/gm, "");
  check(
    "command-relay.ts is pure parsing: no eval, no Function, no pi handle",
    !/\beval\(|new Function\(|\bpi\./.test(stripped),
  );
  const piCalls = new Set([...inboundSrc.matchAll(/\bpi\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
  const allowed = new Set(["getCommands", "sendUserMessage"]);
  const beyond = [...piCalls].filter((m) => !allowed.has(m));
  check(
    "the room path only touches Pi's registry surface (getCommands, sendUserMessage)",
    beyond.length === 0,
    `beyond: ${beyond.join(", ")}`,
  );
}

finish();
