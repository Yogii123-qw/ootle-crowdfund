// Demo harness: wires the CrowdfundSim state machine (sim.js) to the page.
//
// This file owns ONLY demo concerns: persona wallets, the epoch control,
// rendering, the activity log, and the walkthrough checklist. Every funding
// rule lives in sim.js, which mirrors the Rust template. Wallet balances
// here play the role test accounts play in the engine tests: a pledge
// deducts from the signer's demo wallet, a claim/refund credits it back.

import { CrowdfundSim, parseAmount, formatAmount } from "./sim.js";
import { liveStatus } from "./live.js";

const PERSONAS = {
  rani: { name: "Rani", role: "creator" },
  bima: { name: "Bima", role: "backer" },
  sari: { name: "Sari", role: "backer" },
};
const STARTING_BALANCE = 10_000n;

const state = {
  epoch: 0,
  activePersona: "bima",
  wallets: new Map(),
  campaigns: [],
  progress: {},
  // Successful refunds, as "campaignId:persona" keys. Lets the checklist tell
  // a genuine double-refund apart from a refund attempt by someone who never
  // pledged — both are rejected with the same message.
  refunded: new Set(),
};

const WALKTHROUGH_STEPS = [
  "pledge-bima",
  "pledge-sari",
  "pledge-mural",
  "early-claim",
  "advance",
  "claim",
  "refund",
  "double-refund",
  "refund-after-success",
];

function freshDemo() {
  state.epoch = 0;
  state.activePersona = "bima";
  state.wallets = new Map(Object.keys(PERSONAS).map((id) => [id, STARTING_BALANCE]));
  state.progress = {};
  state.refunded = new Set();
  state.campaigns = [
    {
      id: "c1",
      // The walkthrough's first pledge is 400; prefill it so step 1 is one click.
      defaultAmount: "400",
      sim: new CrowdfundSim({
        creator: "rani",
        title: "Community radio",
        goal: 1000n,
        deadlineEpoch: 5,
        currentEpoch: 0,
      }),
    },
    {
      id: "c2",
      // The walkthrough's mural pledge is 300; prefill it so step 3 is one click.
      defaultAmount: "300",
      sim: new CrowdfundSim({
        creator: "rani",
        title: "Neighborhood mural",
        goal: 5000n,
        deadlineEpoch: 5,
        currentEpoch: 0,
      }),
    },
  ];
}

function el(id) {
  return document.getElementById(id);
}

function logCall(text) {
  const li = document.createElement("li");
  li.className = "call";
  li.textContent = `→ ${text}`;
  el("log").prepend(li);
}

function logOk(text) {
  const li = document.createElement("li");
  li.className = "ok";
  li.textContent = `✓ ${text}`;
  el("log").prepend(li);
}

function logReject(message) {
  const li = document.createElement("li");
  li.className = "reject";
  li.textContent = `✗ Rejected: “${message}” — nothing was committed.`;
  el("log").prepend(li);
}

function markStep(step) {
  if (state.progress[step]) return;
  state.progress[step] = true;
  const item = document.querySelector(`[data-step="${step}"]`);
  if (item) item.classList.add("done");
  updateWalkthroughCount();
}

// Presentational only: mirrors how many checklist items are done.
function updateWalkthroughCount() {
  el("walkthrough-count").textContent =
    `${Object.keys(state.progress).length} / ${WALKTHROUGH_STEPS.length}`;
}

function statusLabel(sim) {
  const status = sim.status(state.epoch);
  switch (status) {
    case "claimed":
      return "Claimed — creator paid";
    case "open":
      return `Open — ends at epoch ${sim.deadlineEpoch}`;
    case "open-funded":
      return `Open — goal reached, settles at epoch ${sim.deadlineEpoch}`;
    case "settled-funded":
      return "Settled — goal met, awaiting creator claim";
    case "settled-failed":
      return "Settled — goal missed, refunds open";
    default:
      return status;
  }
}

// Short pill label for the status badge; the full sentence from
// statusLabel stays visible as the status note below the card header.
function shortStatusLabel(sim) {
  switch (sim.status(state.epoch)) {
    case "claimed":
      return "Claimed";
    case "open":
      return "Open";
    case "open-funded":
      return "Goal reached";
    case "settled-funded":
      return "Settled · funded";
    case "settled-failed":
      return "Refunds open";
    default:
      return sim.status(state.epoch);
  }
}

function render() {
  el("epoch-display").textContent = String(state.epoch);
  // Time only moves forward: once the deadline is reached, jumping "to"
  // epoch 5 would rewind it, so the button disables itself.
  el("epoch-to-deadline").disabled = state.epoch >= 5;
  for (const [id, balance] of state.wallets) {
    el(`balance-${id}`).textContent = formatAmount(balance);
  }
  document.querySelectorAll(".persona-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.persona === state.activePersona);
  });

  const grid = el("campaigns");
  grid.innerHTML = "";
  for (const { id, sim, defaultAmount } of state.campaigns) {
    const mine = sim.pledgeOf(state.activePersona);
    const pct = sim.goal > 0n ? Number((sim.totalPledged * 100n) / sim.goal) : 0;
    const card = document.createElement("article");
    card.className = "card campaign";
    // Markup hooks this template must keep: h3, p.muted > 3 strongs
    // (creator, deadline, backers), .status, .status-note, .progress /
    // .progress-bar, .total, .goal, .mine, .amount, .pledge-btn,
    // .claim-btn, .refund-btn, .error. Restyle freely; do not rename.
    // Button hierarchy (presentational only): Pledge is the single
    // primary action; Claim and Refund are quiet outline buttons.
    card.innerHTML = `
      <div class="campaign-head">
        <div>
          <h3></h3>
          <p class="meta muted">Creator: <strong></strong> · Deadline: epoch <strong></strong> · Backers: <strong></strong></p>
        </div>
        <p class="status"></p>
      </div>
      <p class="status-note muted small"></p>
      <p class="raised"><strong class="total"></strong><span class="raised-goal"> / <span class="goal"></span> TARI pledged</span><span class="pct-badge">${pct}%</span></p>
      <div class="progress${pct >= 100 ? " full" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(pct, 100)}" aria-label="Funding progress">
        <div class="progress-bar" style="width: ${Math.min(pct, 100)}%"></div>
      </div>
      <p class="mine-line">Your pledge (${PERSONAS[state.activePersona].name}): <strong class="mine"></strong> TARI</p>
      <div class="row">
        <label>Amount <input type="text" inputmode="numeric" class="amount" value="${defaultAmount ?? "400"}" aria-label="Pledge amount in TARI units"></label>
        <button type="button" class="pledge-btn btn-primary">Pledge</button>
        <button type="button" class="claim-btn">Claim</button>
        <button type="button" class="refund-btn">Refund</button>
      </div>
      <p class="error" role="alert" hidden></p>
    `;
    card.querySelector("h3").textContent = sim.title;
    card.querySelectorAll("p.muted strong")[0].textContent = PERSONAS[sim.creator]?.name ?? sim.creator;
    card.querySelectorAll("p.muted strong")[1].textContent = String(sim.deadlineEpoch);
    card.querySelectorAll("p.muted strong")[2].textContent = String(sim.pledgeCount);
    const statusEl = card.querySelector(".status");
    statusEl.textContent = shortStatusLabel(sim);
    statusEl.dataset.state = sim.status(state.epoch);
    card.querySelector(".status-note").textContent = statusLabel(sim);
    card.querySelector(".total").textContent = formatAmount(sim.totalPledged);
    card.querySelector(".goal").textContent = formatAmount(sim.goal);
    card.querySelector(".mine").textContent = formatAmount(mine);

    const errorBox = card.querySelector(".error");
    const showError = (message) => {
      errorBox.textContent = message;
      errorBox.hidden = false;
    };
    card.querySelector(".pledge-btn").addEventListener("click", () => {
      errorBox.hidden = true;
      doPledge(id, card.querySelector(".amount").value, showError);
    });
    card.querySelector(".claim-btn").addEventListener("click", () => {
      errorBox.hidden = true;
      doClaim(id, showError);
    });
    card.querySelector(".refund-btn").addEventListener("click", () => {
      errorBox.hidden = true;
      doRefund(id, showError);
    });
    grid.appendChild(card);
  }
}

function findCampaign(id) {
  return state.campaigns.find((c) => c.id === id);
}

function describeEvents(events) {
  return events.map((e) => `${e.topic} ${JSON.stringify(e.payload)}`).join("; ");
}

function doPledge(campaignId, rawAmount, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  let amount;
  try {
    amount = parseAmount(rawAmount);
  } catch (err) {
    showError(err.message);
    return;
  }
  logCall(
    `pledge(Bucket ${formatAmount(amount)} TARI) on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`,
  );
  // Wallet-side check (mirrors the account withdraw in a real transaction):
  // the signer cannot pledge more demo units than their wallet holds.
  if (amount > state.wallets.get(persona)) {
    const message = "Insufficient demo balance — the wallet cannot withdraw more than it holds (wallet-side check, not a template rule).";
    showError(message);
    logReject(message);
    return;
  }
  try {
    const events = entry.sim.pledge(persona, amount, state.epoch);
    state.wallets.set(persona, state.wallets.get(persona) - amount);
    logOk(`Pledged ${formatAmount(amount)} TARI. Events: ${describeEvents(events)}`);
    if (campaignId === "c1" && persona === "bima") markStep("pledge-bima");
    if (campaignId === "c1" && events.some((e) => e.topic === "CrowdfundCampaign.Funded")) {
      markStep("pledge-sari");
    }
    if (campaignId === "c2") markStep("pledge-mural");
  } catch (err) {
    showError(err.message);
    logReject(err.message);
  }
  render();
}

function doClaim(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  logCall(
    `claim() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`,
  );
  try {
    const { amount, events } = entry.sim.claim(persona, state.epoch);
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    logOk(`Claimed ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}. Events: ${describeEvents(events)}`);
    if (campaignId === "c1") markStep("claim");
  } catch (err) {
    showError(err.message);
    logReject(err.message);
    if (err.message === "Campaign deadline has not been reached") markStep("early-claim");
  }
  render();
}

function doRefund(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  logCall(
    `refund() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`,
  );
  try {
    const { amount, events } = entry.sim.refund(persona, state.epoch);
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    state.refunded.add(`${campaignId}:${persona}`);
    logOk(`Refunded ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}. Events: ${describeEvents(events)}`);
    if (campaignId === "c2") markStep("refund");
  } catch (err) {
    showError(err.message);
    logReject(err.message);
    // A "no pledge" rejection is a double-refund only if this persona already
    // refunded this campaign; otherwise they simply never pledged.
    if (
      err.message === "No pledge to refund for this backer" &&
      state.refunded.has(`${campaignId}:${persona}`)
    ) {
      markStep("double-refund");
    }
    // "Refunds are closed" proves the success path only on the funded
    // campaign; on an unfunded one it would mean the goal was met instead.
    if (campaignId === "c1" && err.message.includes("refunds are closed")) {
      markStep("refund-after-success");
    }
  }
  render();
}

function setEpoch(epoch) {
  state.epoch = epoch;
  logCall(`Consensus epoch advanced to ${epoch} (demo time control — on-chain, epochs advance with consensus)`);
  if (epoch >= 5) markStep("advance");
  render();
}

function init() {
  freshDemo();
  updateWalkthroughCount();

  document.querySelectorAll(".persona-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activePersona = btn.dataset.persona;
      render();
    });
  });
  el("epoch-plus-1").addEventListener("click", () => setEpoch(state.epoch + 1));
  el("epoch-to-deadline").addEventListener("click", () => setEpoch(5));
  el("reset-demo").addEventListener("click", () => {
    freshDemo();
    el("log").innerHTML = "";
    for (const step of WALKTHROUGH_STEPS) {
      document.querySelector(`[data-step="${step}"]`)?.classList.remove("done");
    }
    updateWalkthroughCount();
    logCall("Demo reset: epoch 0, wallets restored, two fresh campaigns.");
    render();
  });
  el("clear-log").addEventListener("click", () => {
    el("log").innerHTML = "";
  });
  el("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const errorBox = el("create-error");
    errorBox.hidden = true;
    const title = el("new-title").value.trim();
    let goal;
    try {
      goal = parseAmount(el("new-goal").value);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      return;
    }
    const offset = Number(el("new-deadline").value);
    const deadlineEpoch = state.epoch + offset;
    logCall(
      `new("${title}", goal ${formatAmount(goal)}, deadline_epoch ${deadlineEpoch}) — signer: ${PERSONAS[state.activePersona].name}, epoch ${state.epoch}`,
    );
    try {
      const sim = new CrowdfundSim({
        creator: state.activePersona,
        title,
        goal,
        deadlineEpoch,
        currentEpoch: state.epoch,
      });
      state.campaigns.push({ id: `custom-${Date.now()}`, sim });
      logOk(`Campaign “${title}” created. Events: ${describeEvents(sim.events)}`);
      event.target.reset();
      el("new-deadline").value = "5";
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      logReject(err.message);
    }
    render();
  });

  el("live-status").textContent = liveStatus();
  logCall("Demo loaded in simulation mode. No wallet connected, no network calls made.");
  render();
}

init();
