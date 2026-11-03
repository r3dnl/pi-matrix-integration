#!/usr/bin/env node
// Vendored-code expiry check (release story 17): `src/qr2025/` is a
// snapshot of the matrix-js-sdk MSC4388 QR-sign-in prototype. It exists
// only because the published packages lack the secure channel. This probe
// asks the INSTALLED packages whether that is still true — by named
// export, not string grep, so an SDK refactor is reported instead of
// silently passing.
//
// Runs weekly in .github/workflows/live-nightly.yml. Exit 1 means the
// vendored copy is obsolete: delete it, do not update it.

// The exports that make each vendored piece redundant. One entry per
// upstream artifact; the probe reports which one landed.
const REDUNDANCY = [
  {
    pkg: "matrix-js-sdk",
    named: ["MSC4388RendezvousSession", "MSC4388SignInTransaction"],
    why: "the SDK now ships the MSC4388 sign-in classes that src/qr2025/ vendors",
  },
  {
    pkg: "@matrix-org/matrix-sdk-crypto-wasm",
    named: ["HpkeRecipientChannel"],
    why: "crypto-wasm now publishes the MSC4388 HPKE bindings the KNOWN GAP note waits on",
  },
];

const found = [];
for (const probe of REDUNDANCY) {
  let mod;
  try {
    mod = await import(probe.pkg);
  } catch (error) {
    console.log(`SKIP  ${probe.pkg} does not load here (${error.message})`);
    continue;
  }
  for (const name of probe.named) {
    if (typeof mod[name] === "function" || typeof mod[name] === "object") {
      found.push(`${probe.pkg} exports ${name} — ${probe.why}`);
    }
  }
}

if (found.length) {
  console.error("VENDORED CODE IS OBSOLETE:");
  for (const f of found) console.error(`  - ${f}`);
  console.error(
    "\nDelete src/qr2025/, route src/login.ts at the real SDK exports, and keep\n" +
      "the attribution: move the NOTICE provenance entry to a comment in the\n" +
      "replacing code. See docs/dev/developing.md (Vendored code).",
  );
  process.exit(1);
}
console.log("check-vendored: installed SDKs still lack the MSC4388 secure channel — src/qr2025/ remains needed");
