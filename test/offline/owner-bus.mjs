/**
 * Owner-bus gating (DESIGN-SUBAGENT-TRACKING §4.1/§4.2): the sub-agent
 * registry is process-scoped and owned by the MAIN line. The extension
 * factory runs once per session, so a side-chain session constructs its
 * own MatrixIntegration in the same process. The S1 bug: buildStack
 * published the bus unconditionally, so the side chain's EMPTY bus
 * displaced the owner's registry before the side chain's first `input`
 * arrived — bind found no records and the settle edit never landed.
 *
 * Regression: constructing + claiming a side-chain instance must NOT
 * displace the owner bus; spawn records stay bindable after the fact.
 */
import os from "node:os";
import path from "node:path";
import { createPiJiti, makeCheck } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const integ = await jiti.import("../../src/integration.ts");
const { ownerBus, clearOwnerBus } = await jiti.import("../../src/subagent-bus.ts");
const { check, finish } = makeCheck("OWNER-BUS");

const cfg = {
  roomId: "#test:test-matrix.local",
  userId: "@test:test-matrix.local",
  sendFormatted: false,
  pollIntervalMs: 60_000,
  threads: true,
  logPath: "",
  credentialsPath: path.join(os.tmpdir(), "pi-matrix-owner-bus-test-credentials.json"),
};
const fakePi = {};
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Main line: construct + claim → the owner bus becomes the process registry.
const main = new integ.MatrixIntegration(fakePi, cfg, logger);
main.claimOwner(false);
const ownerBusRef = ownerBus();
check("main line publishes the owner bus", ownerBusRef != null);

// A spawn record lands on the owner bus (post fails silently — the outbox
// is not connected in the test; the record registration is the point).
const rec = ownerBusRef.spawn({ description: "find the lock file", subagent_type: "Explore", prompt: "Find the lock file." });
check("spawn record registered on the owner bus", rec.status === "running");

// Side chain: construct (runs buildStack — the S1 regression point) and
// claim as a side chain. The owner bus must survive untouched.
const side = new integ.MatrixIntegration(fakePi, cfg, logger, main);
side.claimOwner(true);
check("side-chain construction does not displace the owner bus", ownerBus() === ownerBusRef);

// The side chain's own bus is a different object (it must stay shadowed).
const sideBus = side.stack.subagentBus;
check("side-chain bus is not the published one", sideBus !== ownerBusRef);

// Bind AFTER the side chain claimed: the record is still findable — this
// is the exact sequence that failed live (spawn → side-chain session_start
// → first input → bind).
const bound = ownerBus().bind("side-session-1", "Explore#abcd1234", "Find the  lock file.", true);
check("bind matches the pre-existing spawn record", bound?.name === "find the lock file" && bound.depth === 1);
check("bind recorded the session on the record", rec.sessionId === "side-session-1");

// The side-chain instance's lifecycle reads the OWNER bus through
// ownerBus(), so its settle would hit the record (settle resolves by
// sessionId on the owner bus).
ownerBus().settle("side-session-1", "done");
check("settle on the owner bus settles the bound record", rec.status === "settled");

// Runner posture (DESIGN-SUBAGENT-PROVIDER §6): inside a subagent child
// process every session is a side chain, so nothing in this process can
// claim main line. The marker is the launcher's PI_SUBAGENT_CHILD=1.
{
  const { isSubagentRunner } = await jiti.import("../../src/lifecycle.ts");
  check("outside a child: false", isSubagentRunner() === false);
  process.env.PI_SUBAGENT_CHILD = "1";
  check("a child recognises itself", isSubagentRunner() === true);
  process.env.PI_SUBAGENT_CHILD = "0";
  check("PI_SUBAGENT_CHILD=0 is not a child", isSubagentRunner() === false);
  delete process.env.PI_SUBAGENT_CHILD;
}

clearOwnerBus();
finish();
