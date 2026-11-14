// Parity tests: the browser simulation (sim.js) must behave exactly like
// the CrowdfundCampaign template on the same scenarios the engine tests
// prove in tests/test.rs — same outcomes, same rejection messages
// (asserted with EXACT string equality, never substrings), same formulas.
//
// The suite covers every edge case E1-E30 in docs/MECHANISM-V2.md section 9
// that is expressible in the simulation. E18 (bond paid in a non-TARI
// token) has NO simulation equivalent: the sim has no buckets/resources,
// so the "Bond must be paid in TARI" resource check cannot be expressed
// here; it is enforced on-chain by the template assert (see the sim.js
// header). Every other E-number has a dedicated test, named with its
// E-number. Every test that creates a campaign reconciles the pledge
// vault and the bond vault.
//
// Run: node --test app/sim.test.mjs   (Node >= 20, no dependencies)

import test from "node:test";
import assert from "node:assert/strict";
import { CrowdfundSim, parseAmount, formatAmount } from "./sim.js";

const CREATOR = "rani";
const ALICE = "bima";
const BOB = "sari";
const CAROL = "dewi";
const STRANGER = "stranger";
const PROMISE = "Name in credits and early access.";

/** Campaign with a valid promise and exactly the required bond by default. */
function campaign(goal = 1000n, deadline = 10, epoch = 0, overrides = {}) {
  const opts = {
    creator: CREATOR,
    title: "Test campaign",
    promise: PROMISE,
    goal,
    deadlineEpoch: deadline,
    currentEpoch: epoch,
    ...overrides,
  };
  if (!("bond" in overrides)) {
    const tenth = opts.goal / 10n;
    opts.bond = tenth > 100n ? tenth : 100n;
  }
  return new CrowdfundSim(opts);
}

function topics(events) {
  return events.map((e) => e.topic);
}

/** Assert the rejection message matches EXACTLY (spec messages are verbatim). */
function rejects(fn, message) {
  assert.throws(
    fn,
    (err) => err instanceof Error && err.message === message,
  );
}

/** Reconcile both vaults: pledge vault + bond vault. */
function assertBalances(sim, vault, bondVault) {
  assert.equal(sim.vaultBalance, vault);
  assert.equal(sim.bondBalance, bondVault);
}

/** Drive a funded campaign through all three tranche gates. Returns amounts. */
function claimAll(sim) {
  const amounts = [];
  amounts.push(sim.claim(CREATOR, sim.deadlineEpoch).amount);
  amounts.push(sim.claim(CREATOR, sim.deadlineEpoch + 72).amount);
  amounts.push(sim.claim(CREATOR, sim.deadlineEpoch + 144).amount);
  return amounts;
}

test("creation records state and emits CampaignCreated", () => {
  const sim = campaign();
  assert.equal(sim.creator, CREATOR);
  assert.equal(sim.title, "Test campaign");
  assert.equal(sim.promise, PROMISE);
  assert.equal(sim.goal, 1000n);
  assert.equal(sim.deadlineEpoch, 10);
  assert.equal(sim.totalPledged, 0n);
  assert.equal(sim.vaultBalance, 0n);
  assert.equal(sim.bondAmount, 100n);
  assert.equal(sim.requiredBond, 100n);
  assert.equal(sim.bondBalance, 100n);
  assert.equal(sim.bondClaimed, false);
  assert.equal(sim.tranchesReleased, 0);
  assert.equal(sim.nextTrancheEpoch, 10);
  assert.equal(sim.isVetoed, false);
  assert.equal(sim.isAbandoned, false);
  assert.equal(sim.vetoTotal, 0n);
  assert.equal(sim.myVeto(ALICE), 0n);
  assert.equal(sim.pledgeCount, 0);
  assert.equal(sim.pledgeOf(ALICE), 0n);
  assert.equal(sim.isClaimed, false);
  assert.equal(sim.isFunded, false);
  assert.equal(sim.status(0), "open");
  assert.deepEqual(topics(sim.events), ["CrowdfundCampaign.CampaignCreated"]);
  assert.deepEqual(sim.events[0].payload, {
    creator: CREATOR,
    title: "Test campaign",
    promise: PROMISE,
    goal: "1000",
    deadline_epoch: "10",
    bond: "100",
  });
  assertBalances(sim, 0n, 100n);
});

test("pledges accumulate and Funded fires exactly once", () => {
  const sim = campaign();
  const first = sim.pledge(ALICE, 400n, 0);
  assert.deepEqual(topics(first), ["CrowdfundCampaign.Pledged"]);
  assert.equal(first[0].payload.total_pledged, "400");
  assert.equal(sim.pledgeOf(ALICE), 400n);
  assert.equal(sim.totalPledged, 400n);
  assert.equal(sim.vaultBalance, 400n);

  const second = sim.pledge(BOB, 600n, 0);
  assert.deepEqual(topics(second), ["CrowdfundCampaign.Pledged", "CrowdfundCampaign.Funded"]);
  assert.equal(second[0].payload.total_pledged, "1000");
  assert.deepEqual(second[1].payload, { goal: "1000", total_pledged: "1000" });
  assert.equal(sim.isFunded, true);
  assert.equal(sim.pledgeCount, 2);

  // Second pledge by the same backer accumulates; no second Funded event.
  const third = sim.pledge(ALICE, 100n, 0);
  assert.deepEqual(topics(third), ["CrowdfundCampaign.Pledged"]);
  assert.equal(third[0].payload.total_pledged, "1100");
  assert.equal(sim.pledgeOf(ALICE), 500n);
  assert.equal(sim.pledgeOf(BOB), 600n);
  assert.equal(sim.pledgeCount, 2);
  assert.equal(sim.totalPledged, 1100n); // overfunding is allowed
  assert.equal(sim.vaultBalance, 1100n);
  assertBalances(sim, 1100n, 100n);
});

test("E12: pledge at the deadline boundary", () => {
  const sim = campaign(1000n, 5);
  sim.pledge(ALICE, 100n, 4); // epoch 4 < deadline 5: open
  assert.equal(sim.totalPledged, 100n);
  rejects(() => sim.pledge(ALICE, 100n, 5), "Campaign deadline has passed");
  assert.equal(sim.totalPledged, 100n); // rejection commits nothing
  assertBalances(sim, 100n, 100n);
});

test("early claim is rejected", () => {
  const sim = campaign(500n, 10);
  sim.pledge(ALICE, 500n, 0);
  rejects(() => sim.claim(CREATOR, 0), "Campaign deadline has not been reached");
  assert.equal(sim.totalPledged, 500n);
  assert.equal(sim.isClaimed, false);
  assert.equal(sim.tranchesReleased, 0);
  assertBalances(sim, 500n, 100n);
});

test("E24: claim by a non-creator is rejected", () => {
  const sim = campaign(500n, 10);
  sim.pledge(ALICE, 500n, 0);
  rejects(() => sim.claim(ALICE, 10), "Only the campaign creator can claim the funds");
  rejects(() => sim.claim(STRANGER, 10), "Only the campaign creator can claim the funds");
  assert.equal(sim.totalPledged, 500n);
  assertBalances(sim, 500n, 100n);
});

test("claim on success releases one tranche per gate; completion needs 3 claims", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);

  const first = sim.claim(CREATOR, 10);
  assert.equal(first.amount, 333n);
  assert.deepEqual(topics(first.events), ["CrowdfundCampaign.TrancheReleased"]);
  assert.deepEqual(first.events[0].payload, { tranche: "1", amount: "333" });
  assert.equal(sim.tranchesReleased, 1);
  assert.equal(sim.isClaimed, false);
  assert.equal(sim.totalPledged, 1000n); // accumulator stable after a release
  assert.equal(sim.vaultBalance, 667n);
  assert.equal(sim.nextTrancheEpoch, 82);

  rejects(() => sim.claim(CREATOR, 81), "The next release has not opened yet");
  const second = sim.claim(CREATOR, 82);
  assert.equal(second.amount, 333n);
  assert.deepEqual(second.events[0].payload, { tranche: "2", amount: "333" });
  assert.equal(sim.isClaimed, false);
  assert.equal(sim.vaultBalance, 334n);

  rejects(() => sim.claim(CREATOR, 153), "The next release has not opened yet");
  const third = sim.claim(CREATOR, 154);
  assert.equal(third.amount, 334n);
  assert.deepEqual(topics(third.events), [
    "CrowdfundCampaign.TrancheReleased",
    "CrowdfundCampaign.CampaignCompleted",
  ]);
  assert.deepEqual(third.events[0].payload, { tranche: "3", amount: "334" });
  assert.deepEqual(third.events[1].payload, { total_released: "1000" });
  assert.equal(sim.tranchesReleased, 3);
  assert.equal(sim.isClaimed, true);
  assert.equal(sim.totalPledged, 1000n);
  assert.equal(sim.vaultBalance, 0n);
  assert.equal(sim.status(154), "completed");

  rejects(() => sim.claim(CREATOR, 154), "Campaign funds have already been claimed");
  assertBalances(sim, 0n, 100n);
});

test("claim when the goal is missed is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 500n, 0);
  rejects(() => sim.claim(CREATOR, 10), "Funding goal was not met; backers may refund instead");
  assert.equal(sim.totalPledged, 500n);
  assertBalances(sim, 500n, 100n);
});

test("refunds on failure repay every backer in full; accumulator is stable", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  sim.pledge(BOB, 400n, 0);
  rejects(() => sim.refund(STRANGER, 10), "No pledge to refund for this backer");
  const first = sim.refund(ALICE, 10);
  assert.equal(first.amount, 300n);
  assert.deepEqual(topics(first.events), ["CrowdfundCampaign.Refunded"]);
  assert.deepEqual(first.events[0].payload, { backer: ALICE, amount: "300", bond_share: "0" });
  assert.equal(sim.totalPledged, 700n); // refunds never touch the accumulator
  assert.equal(sim.vaultBalance, 400n);
  assert.equal(sim.pledgeCount, 1);
  const second = sim.refund(BOB, 10);
  assert.equal(second.amount, 400n);
  assert.equal(sim.totalPledged, 700n);
  assert.equal(sim.vaultBalance, 0n);
  assert.equal(sim.pledgeCount, 0);
  assert.equal(sim.isClaimed, false);
  assert.equal(sim.isFunded, false);
  assertBalances(sim, 0n, 100n);
});

test("double refund is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  assert.equal(sim.refund(ALICE, 10).amount, 300n);
  rejects(() => sim.refund(ALICE, 10), "No pledge to refund for this backer");
  assert.equal(sim.totalPledged, 300n);
  assert.equal(sim.vaultBalance, 0n);
  assertBalances(sim, 0n, 100n);
});

test("E13: refund after success is rejected, before and after completion", () => {
  const sim = campaign(500n, 10);
  sim.pledge(ALICE, 500n, 0);
  rejects(() => sim.refund(ALICE, 10), "Campaign reached its goal; refunds are closed");
  sim.claim(CREATOR, 10); // tranche 1 only: still the goal-closed message
  rejects(() => sim.refund(ALICE, 10), "Campaign reached its goal; refunds are closed");
  sim.claim(CREATOR, 82);
  sim.claim(CREATOR, 154); // completed: now the claimed-closed message
  rejects(() => sim.refund(ALICE, 154), "Campaign funds were claimed; refunds are closed");
  assert.equal(sim.totalPledged, 500n);
  assertBalances(sim, 0n, 100n);
});

test("refund before the deadline is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  rejects(() => sim.refund(ALICE, 0), "Refunds open after the campaign deadline");
  assert.equal(sim.totalPledged, 300n);
  assertBalances(sim, 300n, 100n);
});

test("creation validates inputs in spec check order", () => {
  const VALID = {
    creator: CREATOR,
    title: "x",
    promise: "p",
    goal: 100n,
    deadlineEpoch: 10,
    currentEpoch: 0,
    bond: 100n,
  };
  const bad = (opts, message) =>
    rejects(() => new CrowdfundSim({ ...VALID, ...opts }), message);

  bad({ goal: 0n }, "Funding goal must be greater than zero");
  bad({ goal: -5n }, "Funding goal must be greater than zero");
  bad({ deadlineEpoch: 0 }, "Deadline epoch must be in the future");
  bad({ deadlineEpoch: 10, currentEpoch: 10 }, "Deadline epoch must be in the future");
  bad({ title: "" }, "Campaign title must not be empty");
  bad({ title: "y".repeat(121) }, "Campaign title is too long");
  bad({ promise: "" }, "Campaign promise must not be empty");
  bad({ promise: "y".repeat(281) }, "Campaign promise is too long");
  bad({ promise: undefined }, "Campaign promise must not be empty");
  bad({ bond: 99n }, "Creator bond is below the required minimum");
  bad({ bond: undefined }, "Creator bond is below the required minimum");
  // Check order: title before promise before goal before deadline before bond.
  bad({ title: "", promise: "" }, "Campaign title must not be empty");
  bad({ promise: "", goal: 0n }, "Campaign promise must not be empty");
  bad({ promise: "y".repeat(281), goal: 0n }, "Campaign promise is too long");
  bad({ goal: 0n, bond: 0n }, "Funding goal must be greater than zero");
  bad({ deadlineEpoch: 0, bond: 0n }, "Deadline epoch must be in the future");

  // Boundaries that must be accepted.
  const ok = new CrowdfundSim({ ...VALID, title: "y".repeat(120), promise: "y".repeat(280) });
  assert.equal(ok.bondAmount, 100n);
  assertBalances(ok, 0n, 100n);
});

test("zero and invalid pledges are rejected", () => {
  const sim = campaign();
  rejects(() => sim.pledge(ALICE, 0n, 0), "Pledge must be greater than zero");
  rejects(() => sim.pledge(ALICE, -5n, 0), "Pledge must be greater than zero");
  assert.equal(sim.totalPledged, 0n);
  assertBalances(sim, 0n, 100n);
});

test("amount parsing helpers", () => {
  assert.equal(parseAmount("1_000"), 1000n);
  assert.equal(parseAmount(" 42 "), 42n);
  rejects(() => parseAmount("1.5"), "Enter a whole number of TARI units (no decimals, no symbols).");
  rejects(() => parseAmount("-3"), "Enter a whole number of TARI units (no decimals, no symbols).");
  rejects(() => parseAmount("abc"), "Enter a whole number of TARI units (no decimals, no symbols).");
  assert.equal(formatAmount(1100n), "1,100");
  assert.equal(formatAmount(1000000n), "1,000,000");
});

test("E1: veto at exactly 50% fails; vote recorded, releases continue", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 500n, 0);
  sim.pledge(BOB, 500n, 0);
  const events = sim.veto(ALICE, 10);
  assert.deepEqual(topics(events), ["CrowdfundCampaign.VetoCast"]); // no VetoSucceeded
  assert.equal(sim.isVetoed, false);
  assert.equal(sim.vetoTotal, 500n);
  assert.equal(sim.myVeto(ALICE), 500n);
  assert.equal(sim.myVeto(BOB), 0n);
  // Releases continue: tranche 1 claims normally and resets the tally.
  assert.equal(sim.claim(CREATOR, 10).amount, 333n);
  assert.equal(sim.vetoTotal, 0n);
  assert.equal(sim.myVeto(ALICE), 0n);
  assert.equal(sim.status(10), "settled-funded");
  assertBalances(sim, 667n, 100n);
});

test("E2: veto at 50% + 1 unit succeeds immediately", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 501n, 0);
  sim.pledge(BOB, 499n, 0);
  const events = sim.veto(ALICE, 10);
  assert.deepEqual(topics(events), [
    "CrowdfundCampaign.VetoCast",
    "CrowdfundCampaign.VetoSucceeded",
    "CrowdfundCampaign.BondForfeited",
  ]);
  assert.deepEqual(events[1].payload, { veto_total: "501", pledged_total: "1000" });
  assert.deepEqual(events[2].payload, { amount: "100" });
  assert.equal(sim.isVetoed, true);
  assert.equal(sim.refundPool, 1000n);
  assert.equal(sim.status(10), "vetoed");
  rejects(() => sim.claim(CREATOR, 10), "Campaign was vetoed; remaining funds are refundable to backers");
  // Pro-rata refunds: 501 vault + 50 bond; last refunder takes the rest.
  const first = sim.refund(ALICE, 10);
  assert.equal(first.amount, 551n);
  assert.deepEqual(first.events[0].payload, { backer: ALICE, amount: "551", bond_share: "50" });
  assertBalances(sim, 499n, 50n);
  const last = sim.refund(BOB, 10);
  assert.equal(last.amount, 549n);
  assert.deepEqual(last.events[0].payload, { backer: BOB, amount: "549", bond_share: "50" });
  assert.equal(first.amount + last.amount, 1100n); // pledged + bond, nothing stranded
  assertBalances(sim, 0n, 0n);
});

test("E3: veto after tranche 1 freezes only future tranches", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  const released = sim.claim(CREATOR, 10).amount;
  assert.equal(released, 333n);
  assert.deepEqual(topics(sim.veto(BOB, 10)), ["CrowdfundCampaign.VetoCast"]); // 400 <= 600
  assert.equal(sim.isVetoed, false);
  assert.deepEqual(topics(sim.veto(ALICE, 10)), [
    "CrowdfundCampaign.VetoCast",
    "CrowdfundCampaign.VetoSucceeded",
    "CrowdfundCampaign.BondForfeited",
  ]);
  assert.equal(sim.refundPool, 667n); // tranche 1 stays with the creator
  const first = sim.refund(ALICE, 10);
  assert.equal(first.amount, 460n); // 600*667/1000 = 400 vault + 60 bond
  assert.deepEqual(first.events[0].payload, { backer: ALICE, amount: "460", bond_share: "60" });
  const last = sim.refund(BOB, 10);
  assert.equal(last.amount, 307n); // remaining 267 vault + 40 bond
  assert.equal(released + first.amount + last.amount, 1100n);
  assertBalances(sim, 0n, 0n);
});

test("E4: veto before tranche 1 freezes ALL tranches", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  sim.veto(ALICE, 10); // 600 > 400: succeeds before any claim
  assert.equal(sim.isVetoed, true);
  assert.equal(sim.tranchesReleased, 0);
  assert.equal(sim.refundPool, 1000n);
  rejects(() => sim.claim(CREATOR, 10), "Campaign was vetoed; remaining funds are refundable to backers");
  assert.equal(sim.refund(ALICE, 10).amount, 660n);
  assert.equal(sim.refund(BOB, 10).amount, 440n);
  assertBalances(sim, 0n, 0n);
});

test("E5: veto by a zero-pledge account is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  rejects(() => sim.veto(STRANGER, 0), "Veto opens after the campaign deadline");
  rejects(() => sim.veto(STRANGER, 10), "No pledge to veto with for this backer");
  assert.equal(sim.isVetoed, false);
  assert.equal(sim.vetoTotal, 0n);
  assertBalances(sim, 1000n, 100n);
});

test("E6: same backer vetoes twice in one window", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 400n, 0);
  sim.pledge(BOB, 600n, 0);
  sim.veto(ALICE, 10);
  assert.equal(sim.vetoTotal, 400n);
  rejects(() => sim.veto(ALICE, 10), "Backer has already vetoed this release");
  assert.equal(sim.vetoTotal, 400n); // rejection commits nothing
  assert.equal(sim.isVetoed, false);
  assertBalances(sim, 1000n, 100n);
});

test("E7: veto tally resets on release", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 400n, 0);
  sim.pledge(BOB, 600n, 0);
  sim.veto(ALICE, 10);
  assert.equal(sim.vetoTotal, 400n);
  sim.claim(CREATOR, 10);
  assert.equal(sim.vetoTotal, 0n);
  assert.equal(sim.myVeto(ALICE), 0n);
  // Window 1 votes do not count in window 2; the backer must vote again.
  sim.veto(ALICE, 10);
  assert.equal(sim.vetoTotal, 400n);
  assert.equal(sim.isVetoed, false);
  sim.veto(BOB, 10);
  assert.equal(sim.isVetoed, true);
  assert.equal(sim.refundPool, 667n);
  assertBalances(sim, 667n, 100n);
});

test("E8: abandonment when the creator never claims tranche 1", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  rejects(() => sim.abandon(STRANGER, 81), "Creator has not abandoned the campaign yet");
  const events = sim.abandon(STRANGER, 82); // deadline + 72; anyone may call
  assert.deepEqual(topics(events), ["CrowdfundCampaign.Abandoned", "CrowdfundCampaign.BondForfeited"]);
  assert.deepEqual(events[0].payload, { unreleased: "1000", bond_forfeited: "100" });
  assert.equal(sim.isAbandoned, true);
  assert.equal(sim.refundPool, 1000n);
  assert.equal(sim.status(82), "abandoned");
  rejects(() => sim.abandon(STRANGER, 82), "Campaign was already abandoned");
  assert.equal(sim.refund(ALICE, 82).amount, 660n);
  assert.equal(sim.refund(BOB, 82).amount, 440n);
  assertBalances(sim, 0n, 0n);
});

test("E9: abandonment after tranche 1, creator disappears", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  assert.equal(sim.claim(CREATOR, 10).amount, 333n);
  rejects(() => sim.abandon(STRANGER, 153), "Creator has not abandoned the campaign yet");
  sim.abandon(STRANGER, 154); // deadline + 144: gate 2 + 72
  assert.equal(sim.isAbandoned, true);
  assert.equal(sim.refundPool, 667n);
  assert.equal(sim.refund(ALICE, 154).amount, 460n);
  assert.equal(sim.refund(BOB, 154).amount, 307n);
  assertBalances(sim, 0n, 0n);
});

test("E10: abandon() one epoch too early is rejected", () => {
  const fresh = campaign(1000n, 10);
  fresh.pledge(ALICE, 1000n, 0);
  rejects(() => fresh.abandon(STRANGER, 81), "Creator has not abandoned the campaign yet");
  assert.equal(fresh.isAbandoned, false);
  assertBalances(fresh, 1000n, 100n);

  // Same boundary after two tranches: gate 3 is 154, abandonment at 226.
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  sim.claim(CREATOR, 10);
  sim.claim(CREATOR, 82);
  rejects(() => sim.abandon(STRANGER, 225), "Creator has not abandoned the campaign yet");
  sim.abandon(STRANGER, 226);
  assert.equal(sim.isAbandoned, true);
  assert.equal(sim.refundPool, 334n);
  assert.equal(sim.refund(ALICE, 226).amount, 434n); // last refunder: 334 + 100 bond
  assertBalances(sim, 0n, 0n);
});

test("E11: abandon() on a failed campaign is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 500n, 0);
  rejects(() => sim.abandon(STRANGER, 10), "Campaign did not reach its goal; refunds are already open");
  rejects(() => sim.abandon(STRANGER, 82), "Campaign did not reach its goal; refunds are already open");
  assert.equal(sim.isAbandoned, false);
  // Refunds are already open and the bond returns to the creator.
  assert.equal(sim.claimBond(CREATOR, 10).amount, 100n);
  assert.equal(sim.refund(ALICE, 10).amount, 500n);
  assertBalances(sim, 0n, 0n);
});

test("E14: refund after veto, remainder case; dust goes to the last refunder", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 333n, 0);
  sim.pledge(BOB, 333n, 0);
  sim.pledge(CAROL, 334n, 0);
  assert.equal(sim.claim(CREATOR, 10).amount, 333n); // vault 667 remains
  sim.veto(ALICE, 10); // 333, not a majority
  sim.veto(BOB, 10); // 666 > 334: succeeds
  assert.equal(sim.isVetoed, true);
  assert.equal(sim.refundPool, 667n);
  // Floor shares: 333*667/1000 = 222 vault, 333*100/1000 = 33 bond.
  const first = sim.refund(ALICE, 10);
  assert.equal(first.amount, 255n);
  assert.deepEqual(first.events[0].payload, { backer: ALICE, amount: "255", bond_share: "33" });
  const second = sim.refund(BOB, 10);
  assert.equal(second.amount, 255n);
  assert.deepEqual(second.events[0].payload, { backer: BOB, amount: "255", bond_share: "33" });
  assertBalances(sim, 223n, 34n);
  // Last refunder takes the entire remainder: 223 vault + 34 bond (1 dust each).
  const last = sim.refund(CAROL, 10);
  assert.equal(last.amount, 257n);
  assert.deepEqual(last.events[0].payload, { backer: CAROL, amount: "257", bond_share: "34" });
  assert.equal(first.amount + second.amount + last.amount, 767n); // 667 pool + 100 bond
  assertBalances(sim, 0n, 0n);
});

test("E15: refund after veto, then a second refund is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  sim.veto(ALICE, 10);
  assert.equal(sim.refund(ALICE, 10).amount, 660n);
  rejects(() => sim.refund(ALICE, 10), "No pledge to refund for this backer");
  rejects(() => sim.refund(STRANGER, 10), "No pledge to refund for this backer");
  assert.equal(sim.pledgeOf(ALICE), 0n);
  assert.equal(sim.pledgeCount, 1);
  assert.equal(sim.refund(BOB, 10).amount, 440n);
  assertBalances(sim, 0n, 0n);
});

test("E16: bond below the minimum at creation is rejected", () => {
  rejects(
    () => campaign(1000n, 10, 0, { bond: 99n }),
    "Creator bond is below the required minimum",
  );
  rejects(
    () => campaign(5000n, 10, 0, { bond: 499n }),
    "Creator bond is below the required minimum",
  );
  // The 100-unit floor binds for tiny goals: goal 50 still needs a bond of 100.
  rejects(
    () => campaign(50n, 10, 0, { bond: 99n }),
    "Creator bond is below the required minimum",
  );
  const floored = campaign(50n, 10, 0, { bond: 100n });
  assert.equal(floored.requiredBond, 100n);
  assertBalances(floored, 0n, 100n);
  const exact = campaign(5000n, 10, 0, { bond: 500n });
  assert.equal(exact.requiredBond, 500n);
  assertBalances(exact, 0n, 500n);
});

test("E17: bond overpayment becomes the whole bond", () => {
  // Overpayment returns in full on honest completion.
  const done = campaign(1000n, 10, 0, { bond: 250n });
  assert.equal(done.bondAmount, 250n);
  assert.equal(done.requiredBond, 100n);
  assert.equal(done.bondBalance, 250n);
  done.pledge(ALICE, 1000n, 0);
  assert.deepEqual(claimAll(done), [333n, 333n, 334n]);
  const returned = done.claimBond(CREATOR, 154);
  assert.equal(returned.amount, 250n);
  assert.deepEqual(returned.events[0].payload, { creator: CREATOR, amount: "250" });
  assertBalances(done, 0n, 0n);

  // Overpayment forfeits in full on veto, shared pro-rata.
  const sim = campaign(1000n, 10, 0, { bond: 250n });
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  const events = sim.veto(ALICE, 10);
  assert.deepEqual(events[2].payload, { amount: "250" });
  assert.equal(sim.refund(ALICE, 10).amount, 750n); // 600 vault + 150 bond
  assert.equal(sim.refund(BOB, 10).amount, 500n); // 400 vault + 100 bond
  assertBalances(sim, 0n, 0n);
});

test("E19: bond returns on campaign failure, even before refunds", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  sim.pledge(BOB, 200n, 0);
  const returned = sim.claimBond(CREATOR, 10);
  assert.equal(returned.amount, 100n);
  assert.deepEqual(topics(returned.events), ["CrowdfundCampaign.BondReturned"]);
  assert.equal(sim.bondClaimed, true);
  assertBalances(sim, 500n, 0n); // pledge vault untouched by the bond return
  assert.equal(sim.refund(ALICE, 10).amount, 300n);
  assert.equal(sim.refund(BOB, 10).amount, 200n);
  assert.equal(sim.totalPledged, 500n);
  assertBalances(sim, 0n, 0n);
});

test("E20: bond returns on completion; second claim_bond is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  claimAll(sim);
  const returned = sim.claimBond(CREATOR, 154);
  assert.equal(returned.amount, 100n);
  assert.equal(sim.bondClaimed, true);
  assertBalances(sim, 0n, 0n);
  rejects(() => sim.claimBond(CREATOR, 154), "Bond has already been claimed");
  assertBalances(sim, 0n, 0n);
});

test("E21: claim_bond on a vetoed or abandoned campaign is rejected", () => {
  const vetoed = campaign(1000n, 10);
  vetoed.pledge(ALICE, 600n, 0);
  vetoed.pledge(BOB, 400n, 0);
  vetoed.veto(ALICE, 10);
  rejects(() => vetoed.claimBond(CREATOR, 10), "Bond was forfeited to backers");
  assert.equal(vetoed.bondClaimed, false);
  assertBalances(vetoed, 1000n, 100n);

  const abandoned = campaign(1000n, 10);
  abandoned.pledge(ALICE, 1000n, 0);
  abandoned.abandon(STRANGER, 82);
  rejects(() => abandoned.claimBond(CREATOR, 82), "Bond was forfeited to backers");
  assert.equal(abandoned.bondClaimed, false);
  assertBalances(abandoned, 1000n, 100n);
});

test("E22: claim_bond before the deadline / while funded-incomplete is locked", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  rejects(() => sim.claimBond(CREATOR, 0), "Bond is locked until the campaign deadline");
  rejects(() => sim.claimBond(ALICE, 0), "Only the campaign creator can claim the bond");
  rejects(() => sim.claimBond(CREATOR, 10), "Bond is locked until all releases complete");
  sim.claim(CREATOR, 10);
  rejects(() => sim.claimBond(CREATOR, 10), "Bond is locked until all releases complete");
  sim.claim(CREATOR, 82);
  rejects(() => sim.claimBond(CREATOR, 82), "Bond is locked until all releases complete");
  assert.equal(sim.bondClaimed, false);
  assertBalances(sim, 334n, 100n);
});

test("E23: claim() one epoch before a tranche gate is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  assert.equal(sim.nextTrancheEpoch, 10);
  assert.equal(sim.claim(CREATOR, 10).amount, 333n);
  assert.equal(sim.nextTrancheEpoch, 82);
  rejects(() => sim.claim(CREATOR, 81), "The next release has not opened yet");
  assert.equal(sim.claim(CREATOR, 82).amount, 333n);
  assert.equal(sim.nextTrancheEpoch, 154);
  rejects(() => sim.claim(CREATOR, 153), "The next release has not opened yet");
  assert.equal(sim.claim(CREATOR, 154).amount, 334n);
  assert.equal(sim.nextTrancheEpoch, 226);
  assertBalances(sim, 0n, 100n);
});

test("E25: tranche amounts with a remainder sum exactly to the total", () => {
  const cases = [
    [1000n, [333n, 333n, 334n]],
    [1001n, [333n, 333n, 335n]],
    [1002n, [334n, 334n, 334n]],
  ];
  for (const [total, expected] of cases) {
    const sim = campaign(1000n, 10);
    sim.pledge(ALICE, total, 0);
    const amounts = claimAll(sim);
    assert.deepEqual(amounts, expected);
    assert.equal(amounts.reduce((a, b) => a + b, 0n), total);
    assert.equal(sim.totalPledged, total);
    assertBalances(sim, 0n, 100n);
  }
});

test("E26: promise empty / 281 chars rejected; 280 chars accepted", () => {
  const VALID = {
    creator: CREATOR,
    title: "x",
    promise: "p",
    goal: 100n,
    deadlineEpoch: 10,
    currentEpoch: 0,
    bond: 100n,
  };
  const bad = (opts, message) =>
    rejects(() => new CrowdfundSim({ ...VALID, ...opts }), message);
  bad({ promise: "" }, "Campaign promise must not be empty");
  bad({ promise: "y".repeat(281) }, "Campaign promise is too long");
  // Char count is by code point, like the title check: 281 emoji rejected.
  bad({ promise: "😀".repeat(281) }, "Campaign promise is too long");
  bad({ promise: 42 }, "Campaign promise must not be empty");
  // Order: title first, then promise, then goal.
  bad({ title: "", promise: "" }, "Campaign title must not be empty");
  bad({ promise: "", goal: 0n }, "Campaign promise must not be empty");

  const ascii = new CrowdfundSim({ ...VALID, promise: "y".repeat(280) });
  assert.equal(ascii.promise, "y".repeat(280));
  assert.equal(ascii.events[0].payload.promise, "y".repeat(280));
  assertBalances(ascii, 0n, 100n);
  const unicode = new CrowdfundSim({ ...VALID, promise: "é".repeat(280) });
  assert.equal([...unicode.promise].length, 280);
  assertBalances(unicode, 0n, 100n);
});

test("E27: pledge after a tranche released (epoch rewound) is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  sim.claim(CREATOR, 10);
  rejects(() => sim.pledge(BOB, 100n, 5), "Campaign funds have already been released");
  // At a normal post-deadline epoch the deadline guard fires first.
  rejects(() => sim.pledge(BOB, 100n, 10), "Campaign deadline has passed");
  assert.equal(sim.totalPledged, 1000n);
  assertBalances(sim, 667n, 100n);
});

test("E28: claim() after veto success is rejected; vault untouched", () => {
  const vetoed = campaign(1000n, 10);
  vetoed.pledge(ALICE, 600n, 0);
  vetoed.pledge(BOB, 400n, 0);
  vetoed.veto(ALICE, 10);
  rejects(
    () => vetoed.claim(CREATOR, 10),
    "Campaign was vetoed; remaining funds are refundable to backers",
  );
  rejects(() => vetoed.claim(ALICE, 10), "Only the campaign creator can claim the funds");
  assert.equal(vetoed.tranchesReleased, 0);
  assertBalances(vetoed, 1000n, 100n);

  const abandoned = campaign(1000n, 10);
  abandoned.pledge(ALICE, 1000n, 0);
  abandoned.abandon(STRANGER, 82);
  rejects(
    () => abandoned.claim(CREATOR, 82),
    "Campaign was abandoned; remaining funds are refundable to backers",
  );
  assertBalances(abandoned, 1000n, 100n);
});

test("E29: veto on a failed campaign is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 500n, 0);
  rejects(() => sim.veto(ALICE, 0), "Veto opens after the campaign deadline");
  rejects(() => sim.veto(ALICE, 10), "Campaign did not reach its goal; refunds are already open");
  assert.equal(sim.isVetoed, false);
  assert.equal(sim.refund(ALICE, 10).amount, 500n); // refunds are already open
  assertBalances(sim, 0n, 100n);
});

test("E30: is_funded / total_pledged stay stable after releases", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 500n, 0); // overfunded: 1100
  assert.equal(sim.claim(CREATOR, 10).amount, 366n);
  assert.equal(sim.totalPledged, 1100n);
  assert.equal(sim.isFunded, true);
  assert.equal(sim.pledgeCount, 2);
  assert.equal(sim.vaultBalance, 734n);
  assert.equal(sim.claim(CREATOR, 82).amount, 366n);
  assert.equal(sim.totalPledged, 1100n);
  assert.equal(sim.isFunded, true);
  assert.equal(sim.vaultBalance, 368n);
  assert.equal(sim.claim(CREATOR, 154).amount, 368n);
  assert.equal(sim.totalPledged, 1100n);
  assert.equal(sim.isFunded, true);
  assert.equal(sim.vaultBalance, 0n);
  assertBalances(sim, 0n, 100n);
});

test("event topics and payloads mirror spec section 6", () => {
  // Completion path: exact topic sequence, TrancheReleased replaces Claimed.
  const done = campaign(1000n, 10);
  done.pledge(ALICE, 600n, 0);
  done.pledge(BOB, 400n, 0);
  claimAll(done);
  done.claimBond(CREATOR, 154);
  assert.deepEqual(topics(done.events), [
    "CrowdfundCampaign.CampaignCreated",
    "CrowdfundCampaign.Pledged",
    "CrowdfundCampaign.Pledged",
    "CrowdfundCampaign.Funded",
    "CrowdfundCampaign.TrancheReleased",
    "CrowdfundCampaign.TrancheReleased",
    "CrowdfundCampaign.TrancheReleased",
    "CrowdfundCampaign.CampaignCompleted",
    "CrowdfundCampaign.BondReturned",
  ]);
  assert.ok(!topics(done.events).includes("CrowdfundCampaign.Claimed"));
  assertBalances(done, 0n, 0n);

  // Veto path: exact payload shapes for VetoCast, VetoSucceeded,
  // BondForfeited, and Refunded (with bond_share).
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  const vetoEvents = sim.veto(ALICE, 10);
  assert.deepEqual(vetoEvents[0].payload, { backer: ALICE, weight: "600", veto_total: "600" });
  assert.deepEqual(vetoEvents[1].payload, { veto_total: "600", pledged_total: "1000" });
  assert.deepEqual(vetoEvents[2].payload, { amount: "100" });
  const refunded = sim.refund(ALICE, 10);
  assert.deepEqual(refunded.events[0].payload, { backer: ALICE, amount: "660", bond_share: "60" });
  sim.refund(BOB, 10);
  assertBalances(sim, 0n, 0n);

  // Abandonment path: Abandoned payload shape.
  const gone = campaign(1000n, 10);
  gone.pledge(ALICE, 1000n, 0);
  const abandonEvents = gone.abandon(STRANGER, 82);
  assert.deepEqual(abandonEvents[0].payload, { unreleased: "1000", bond_forfeited: "100" });
  assert.deepEqual(abandonEvents[1].payload, { amount: "100" });
  const solo = gone.refund(ALICE, 82);
  assert.deepEqual(solo.events[0].payload, { backer: ALICE, amount: "1100", bond_share: "100" });
  assertBalances(gone, 0n, 0n);
});

test("getters and status vocabulary mirror spec sections 5 and 11", () => {
  // requiredBond = max(goal/10, 100), floor division.
  const bonds = [
    [50n, 100n],
    [999n, 100n],
    [1000n, 100n],
    [1001n, 100n],
    [1009n, 100n],
    [1010n, 101n],
    [2000n, 200n],
    [5000n, 500n],
  ];
  for (const [goal, expected] of bonds) {
    const sim = campaign(goal, 10);
    assert.equal(sim.requiredBond, expected);
    assert.equal(sim.bondAmount, expected);
    assertBalances(sim, 0n, expected);
  }

  const sim = campaign(1000n, 10);
  assert.equal(sim.myVeto(ALICE), 0n);
  const seen = new Set([sim.status(0)]);
  assert.equal(sim.status(0), "open");
  sim.pledge(ALICE, 1000n, 0);
  seen.add(sim.status(0));
  assert.equal(sim.status(0), "open-funded");
  seen.add(sim.status(10));
  assert.equal(sim.status(10), "settled-funded");
  claimAll(sim);
  seen.add(sim.status(154));
  assert.equal(sim.status(154), "completed");

  const failed = campaign(1000n, 10);
  failed.pledge(ALICE, 500n, 0);
  seen.add(failed.status(10));
  assert.equal(failed.status(10), "settled-failed");
  assertBalances(failed, 500n, 100n);

  const vetoed = campaign(1000n, 10);
  vetoed.pledge(ALICE, 1000n, 0);
  vetoed.veto(ALICE, 10);
  seen.add(vetoed.status(0)); // terminal states win, even at a rewound epoch
  assert.equal(vetoed.status(0), "vetoed");
  assertBalances(vetoed, 1000n, 100n);

  const abandoned = campaign(1000n, 10);
  abandoned.pledge(ALICE, 1000n, 0);
  abandoned.abandon(STRANGER, 82);
  seen.add(abandoned.status(0));
  assert.equal(abandoned.status(0), "abandoned");
  assertBalances(abandoned, 1000n, 100n);

  assert.ok(!seen.has("claimed")); // v1 "claimed" status value is gone
  assertBalances(sim, 0n, 100n);
});

test("guard check order follows spec section 4 exactly", () => {
  // Pledge: amount before deadline before release before veto before abandon.
  const p = campaign(1000n, 10);
  p.pledge(ALICE, 1000n, 0);
  rejects(() => p.pledge(BOB, 0n, 10), "Pledge must be greater than zero");
  p.claim(CREATOR, 10);
  p.veto(ALICE, 10); // released AND vetoed: the release guard fires first
  rejects(() => p.pledge(BOB, 100n, 5), "Campaign funds have already been released");
  assertBalances(p, 667n, 100n);

  const v = campaign(1000n, 10);
  v.pledge(ALICE, 1000n, 0);
  v.veto(ALICE, 10);
  rejects(() => v.pledge(BOB, 100n, 5), "Campaign was vetoed; pledges are closed");
  assertBalances(v, 1000n, 100n);

  const a = campaign(1000n, 10);
  a.pledge(ALICE, 1000n, 0);
  a.abandon(STRANGER, 82);
  rejects(() => a.pledge(BOB, 100n, 5), "Campaign was abandoned; pledges are closed");
  assertBalances(a, 1000n, 100n);

  // Claim: creator before veto before complete before deadline.
  const c = campaign(1000n, 10);
  c.pledge(ALICE, 1000n, 0);
  c.veto(ALICE, 10);
  rejects(() => c.claim(ALICE, 0), "Only the campaign creator can claim the funds");
  rejects(
    () => c.claim(CREATOR, 0),
    "Campaign was vetoed; remaining funds are refundable to backers",
  );
  assertBalances(c, 1000n, 100n);

  const done = campaign(1000n, 10);
  done.pledge(ALICE, 1000n, 0);
  claimAll(done);
  rejects(() => done.claim(CREATOR, 0), "Campaign funds have already been claimed");
  assertBalances(done, 0n, 100n);

  // Veto: already-vetoed / abandoned before the pledge check.
  rejects(() => v.veto(STRANGER, 10), "Campaign was already vetoed");
  rejects(() => a.veto(STRANGER, 82), "Campaign was abandoned; veto is closed");

  // Refund: deadline before complete.
  rejects(() => done.refund(ALICE, 0), "Refunds open after the campaign deadline");

  // Abandon: already-vetoed before the epoch check.
  rejects(() => v.abandon(STRANGER, 10), "Campaign was already vetoed");
  rejects(() => a.abandon(STRANGER, 82), "Campaign was already abandoned");
  rejects(() => done.abandon(STRANGER, 300), "Campaign is complete; abandonment is closed");

  // ClaimBond: creator before forfeited before deadline.
  rejects(() => v.claimBond(ALICE, 10), "Only the campaign creator can claim the bond");
  rejects(() => v.claimBond(CREATOR, 0), "Bond was forfeited to backers");
});

test("terminal-state guards: veto and abandon close at completion", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 1000n, 0);
  claimAll(sim);
  rejects(() => sim.veto(ALICE, 154), "Campaign is complete; veto is closed");
  rejects(() => sim.abandon(STRANGER, 300), "Campaign is complete; abandonment is closed");
  rejects(() => sim.pledge(BOB, 100n, 5), "Campaign funds have already been released");
  rejects(() => sim.refund(ALICE, 154), "Campaign funds were claimed; refunds are closed");
  assertBalances(sim, 0n, 100n);

  const vetoed = campaign(1000n, 10);
  vetoed.pledge(ALICE, 600n, 0);
  vetoed.pledge(BOB, 400n, 0);
  vetoed.veto(ALICE, 10);
  rejects(() => vetoed.veto(BOB, 10), "Campaign was already vetoed");
  rejects(() => vetoed.abandon(STRANGER, 200), "Campaign was already vetoed");
  assertBalances(vetoed, 1000n, 100n);

  const abandoned = campaign(1000n, 10);
  abandoned.pledge(ALICE, 1000n, 0);
  abandoned.abandon(STRANGER, 82);
  rejects(() => abandoned.veto(ALICE, 82), "Campaign was abandoned; veto is closed");
  rejects(() => abandoned.abandon(STRANGER, 82), "Campaign was already abandoned");
  assertBalances(abandoned, 1000n, 100n);
});

test("creator self-pledge + veto forfeits their own bond (no identity exception)", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(CREATOR, 600n, 0);
  sim.pledge(ALICE, 400n, 0);
  // The creator may veto like any backer; it forfeits their own bond.
  sim.veto(CREATOR, 10);
  assert.equal(sim.isVetoed, true);
  rejects(() => sim.claimBond(CREATOR, 10), "Bond was forfeited to backers");
  assert.equal(sim.refund(CREATOR, 10).amount, 660n);
  assert.equal(sim.refund(ALICE, 10).amount, 440n);
  assertBalances(sim, 0n, 0n);
});

test("abandon() accepts an epoch-only call as well as (caller, epoch)", () => {
  const solo = campaign(1000n, 10);
  solo.pledge(ALICE, 1000n, 0);
  rejects(() => solo.abandon(81), "Creator has not abandoned the campaign yet");
  solo.abandon(82);
  assert.equal(solo.isAbandoned, true);
  assert.equal(solo.refund(ALICE, 82).amount, 1100n);
  assertBalances(solo, 0n, 0n);

  const withCaller = campaign(1000n, 10);
  withCaller.pledge(ALICE, 1000n, 0);
  withCaller.abandon(STRANGER, 82);
  assert.equal(withCaller.isAbandoned, true);
  assertBalances(withCaller, 1000n, 100n);
});
