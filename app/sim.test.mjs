// Parity tests: the browser simulation (sim.js) must behave exactly like
// the CrowdfundCampaign template on the same scenarios the engine tests
// prove in tests/test.rs — same outcomes, same rejection messages.
//
// Run: node --test app/sim.test.mjs   (Node >= 20, no dependencies)

import test from "node:test";
import assert from "node:assert/strict";
import { CrowdfundSim, parseAmount, formatAmount } from "./sim.js";

const CREATOR = "rani";
const ALICE = "bima";
const BOB = "sari";
const STRANGER = "stranger";

function campaign(goal = 1000n, deadline = 10, epoch = 0) {
  return new CrowdfundSim({
    creator: CREATOR,
    title: "Test campaign",
    goal,
    deadlineEpoch: deadline,
    currentEpoch: epoch,
  });
}

function topics(events) {
  return events.map((e) => e.topic);
}

test("creation records state and emits CampaignCreated", () => {
  const sim = campaign();
  assert.equal(sim.creator, CREATOR);
  assert.equal(sim.goal, 1000n);
  assert.equal(sim.deadlineEpoch, 10);
  assert.equal(sim.totalPledged, 0n);
  assert.equal(sim.pledgeCount, 0);
  assert.equal(sim.isClaimed, false);
  assert.equal(sim.isFunded, false);
  assert.deepEqual(topics(sim.events), ["CrowdfundCampaign.CampaignCreated"]);
  assert.equal(sim.events[0].payload.goal, "1000");
  assert.equal(sim.events[0].payload.deadline_epoch, "10");
});

test("pledges accumulate and Funded fires exactly once", () => {
  const sim = campaign();
  const first = sim.pledge(ALICE, 400n, 0);
  assert.deepEqual(topics(first), ["CrowdfundCampaign.Pledged"]);
  assert.equal(sim.pledgeOf(ALICE), 400n);
  assert.equal(sim.totalPledged, 400n);

  const second = sim.pledge(BOB, 600n, 0);
  assert.deepEqual(topics(second), ["CrowdfundCampaign.Pledged", "CrowdfundCampaign.Funded"]);
  assert.equal(sim.isFunded, true);
  assert.equal(sim.pledgeCount, 2);

  // Second pledge by the same backer accumulates; no second Funded event.
  const third = sim.pledge(ALICE, 100n, 0);
  assert.deepEqual(topics(third), ["CrowdfundCampaign.Pledged"]);
  assert.equal(sim.pledgeOf(ALICE), 500n);
  assert.equal(sim.pledgeOf(BOB), 600n);
  assert.equal(sim.pledgeCount, 2);
  assert.equal(sim.totalPledged, 1100n); // overfunding is allowed
});

test("pledge at the deadline boundary", () => {
  const sim = campaign(1000n, 5);
  sim.pledge(ALICE, 100n, 4); // epoch 4 < deadline 5: open
  assert.equal(sim.totalPledged, 100n);
  assert.throws(() => sim.pledge(ALICE, 100n, 5), /Campaign deadline has passed/);
  assert.equal(sim.totalPledged, 100n); // rejection commits nothing
});

test("early claim is rejected", () => {
  const sim = campaign(500n, 10);
  sim.pledge(ALICE, 500n, 0);
  assert.throws(() => sim.claim(CREATOR, 0), /Campaign deadline has not been reached/);
  assert.equal(sim.totalPledged, 500n);
  assert.equal(sim.isClaimed, false);
});

test("claim by a non-creator is rejected", () => {
  const sim = campaign(500n, 10);
  sim.pledge(ALICE, 500n, 0);
  assert.throws(() => sim.claim(ALICE, 10), /Only the campaign creator can claim the funds/);
  assert.equal(sim.totalPledged, 500n);
});

test("claim on success pays the creator exactly once", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 600n, 0);
  sim.pledge(BOB, 400n, 0);
  const { amount, events } = sim.claim(CREATOR, 10);
  assert.equal(amount, 1000n);
  assert.deepEqual(topics(events), ["CrowdfundCampaign.Claimed"]);
  assert.equal(sim.totalPledged, 0n);
  assert.equal(sim.isClaimed, true);
  assert.throws(() => sim.claim(CREATOR, 10), /Campaign funds have already been claimed/);
});

test("claim when the goal is missed is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 500n, 0);
  assert.throws(() => sim.claim(CREATOR, 10), /Funding goal was not met/);
  assert.equal(sim.totalPledged, 500n);
});

test("refunds on failure repay every backer in full", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  sim.pledge(BOB, 400n, 0);
  assert.throws(() => sim.refund(STRANGER, 10), /No pledge to refund for this backer/);
  const first = sim.refund(ALICE, 10);
  assert.equal(first.amount, 300n);
  assert.deepEqual(topics(first.events), ["CrowdfundCampaign.Refunded"]);
  assert.equal(sim.totalPledged, 400n);
  const second = sim.refund(BOB, 10);
  assert.equal(second.amount, 400n);
  assert.equal(sim.totalPledged, 0n);
  assert.equal(sim.pledgeCount, 0);
  assert.equal(sim.isClaimed, false);
});

test("double refund is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  assert.equal(sim.refund(ALICE, 10).amount, 300n);
  assert.throws(() => sim.refund(ALICE, 10), /No pledge to refund for this backer/);
  assert.equal(sim.totalPledged, 0n);
});

test("refund after success is rejected, before and after claim", () => {
  const sim = campaign(500n, 10);
  sim.pledge(ALICE, 500n, 0);
  assert.throws(() => sim.refund(ALICE, 10), /Campaign reached its goal; refunds are closed/);
  sim.claim(CREATOR, 10);
  assert.throws(() => sim.refund(ALICE, 10), /Campaign funds were claimed; refunds are closed/);
});

test("refund before the deadline is rejected", () => {
  const sim = campaign(1000n, 10);
  sim.pledge(ALICE, 300n, 0);
  assert.throws(() => sim.refund(ALICE, 0), /Refunds open after the campaign deadline/);
  assert.equal(sim.totalPledged, 300n);
});

test("creation validates inputs", () => {
  assert.throws(
    () => new CrowdfundSim({ creator: CREATOR, title: "x", goal: 0n, deadlineEpoch: 10, currentEpoch: 0 }),
    /Funding goal must be greater than zero/,
  );
  assert.throws(
    () => new CrowdfundSim({ creator: CREATOR, title: "x", goal: 100n, deadlineEpoch: 0, currentEpoch: 0 }),
    /Deadline epoch must be in the future/,
  );
  assert.throws(
    () => new CrowdfundSim({ creator: CREATOR, title: "", goal: 100n, deadlineEpoch: 10, currentEpoch: 0 }),
    /Campaign title must not be empty/,
  );
  assert.throws(
    () =>
      new CrowdfundSim({
        creator: CREATOR,
        title: "y".repeat(121),
        goal: 100n,
        deadlineEpoch: 10,
        currentEpoch: 0,
      }),
    /Campaign title is too long/,
  );
});

test("zero and invalid pledges are rejected", () => {
  const sim = campaign();
  assert.throws(() => sim.pledge(ALICE, 0n, 0), /Pledge must be greater than zero/);
  assert.throws(() => sim.pledge(ALICE, -5n, 0), /Pledge must be greater than zero/);
  assert.equal(sim.totalPledged, 0n);
});

test("amount parsing helpers", () => {
  assert.equal(parseAmount("1_000"), 1000n);
  assert.equal(parseAmount(" 42 "), 42n);
  assert.throws(() => parseAmount("1.5"), /whole number/);
  assert.throws(() => parseAmount("-3"), /whole number/);
  assert.throws(() => parseAmount("abc"), /whole number/);
  assert.equal(formatAmount(1100n), "1,100");
  assert.equal(formatAmount(1000000n), "1,000,000");
});
