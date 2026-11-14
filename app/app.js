// Demo harness: wires the CrowdfundSim state machine (sim.js) to the page.
//
// This file owns ONLY demo concerns: persona wallets, the epoch control,
// rendering, the transaction history (with deterministic simulated hashes
// and the in-app block view), and the walkthrough checklist. Every funding
// rule lives in sim.js, which mirrors the Rust template. Wallet balances
// here play the role test accounts play in the engine tests: a pledge
// deducts from the signer's demo wallet, a claim/refund credits it back.
//
// History honesty: every entry records a real simulated call made through
// sim.js. Hashes are deterministic FNV-1a digests of the call data — the
// same action sequence always yields the same hashes — and are labeled
// everywhere as simulated. Nothing here touches a real chain.

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
  // Simulated transaction history, newest first. seq restarts on reset, so
  // the same action sequence always produces the same hashes.
  history: [],
  seq: 0,
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
  state.history = [];
  state.seq = 0;
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

// --- Deterministic simulated hashes -------------------------------------
//
// FNV-1a 64-bit, run twice with different seeds and concatenated, giving a
// 32-hex-character digest. Synchronous, dependency-free, and stable across
// runs: the same call data always yields the same hash. This is a demo
// fingerprint, not a cryptographic hash — it is labeled simulated.

function fnv1a64(text, seed) {
  let hash = seed;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function simHash(text) {
  const offset = 0xcbf29ce484222325n;
  return `0x${fnv1a64(text, offset)}${fnv1a64(text, offset ^ 0xa5a5a5a5a5a5a5a5n)}`;
}

function shortHash(hash) {
  return `${hash.slice(0, 10)}…`;
}

// --- Transaction history -------------------------------------------------

function recordHistory({ type, actor, campaignId, campaignTitle, amountText, call, ok, message, events }) {
  const seq = state.seq++;
  const payload = `${seq}|${call}|${ok ? "ok" : `rejected:${message}`}`;
  state.history.unshift({
    seq,
    hash: simHash(payload),
    type,
    actor,
    campaignId,
    campaignTitle,
    amountText,
    call,
    ok,
    message,
    events: events ?? [],
    epoch: state.epoch,
  });
  renderHistory();
}

function renderHistory() {
  const list = el("history");
  list.innerHTML = "";
  for (const entry of state.history) {
    const row = document.createElement("li");
    row.className = "hist-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `hist-entry ${entry.ok ? "hist-ok" : "hist-reject"}`;
    button.dataset.seq = String(entry.seq);
    button.setAttribute(
      "aria-label",
      `${entry.type} on ${entry.campaignTitle}, ${entry.ok ? "success" : "rejected"}, epoch ${entry.epoch}. Open block.`,
    );

    const main = document.createElement("span");
    main.className = "hist-main";
    const title = document.createElement("span");
    title.className = "hist-title";
    title.textContent = `${entry.type} · ${entry.campaignTitle}`;
    const meta = document.createElement("span");
    meta.className = "hist-meta";
    meta.textContent = `${PERSONAS[entry.actor]?.name ?? entry.actor} · epoch ${entry.epoch} · `;
    const hash = document.createElement("span");
    hash.className = "hist-hash";
    hash.textContent = shortHash(entry.hash);
    meta.appendChild(hash);
    main.appendChild(title);
    main.appendChild(meta);
    if (!entry.ok) {
      const error = document.createElement("span");
      error.className = "hist-error";
      error.textContent = entry.message;
      main.appendChild(error);
    }

    const side = document.createElement("span");
    side.className = "hist-side";
    const amount = document.createElement("span");
    amount.className = "hist-amount";
    amount.textContent = entry.ok ? entry.amountText : "Not committed";
    const status = document.createElement("span");
    status.className = "hist-status";
    status.textContent = entry.ok ? "✓ Success" : "✗ Rejected";
    side.appendChild(amount);
    side.appendChild(status);

    button.appendChild(main);
    button.appendChild(side);
    button.addEventListener("click", () => openBlock(entry.seq));
    row.appendChild(button);
    list.appendChild(row);
  }
}

// --- Simulated block view -------------------------------------------------
//
// The epoch is the block-height analog: every entry recorded at the same
// epoch belongs to the same simulated block. The block hash is derived
// deterministically from the epoch and the block's transaction hashes, in
// sequence order. The view is in-app only and labeled simulated.

let blockReturnFocus = null;

function blockHash(epoch, entries) {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  return simHash(`block:${epoch}:${ordered.map((e) => e.hash).join(",")}`);
}

function factRow(label, value, { mono = false, tone = null } = {}) {
  const row = document.createElement("div");
  row.className = "fact";
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (mono) dd.className = "mono";
  if (tone) dd.classList.add(tone);
  dd.textContent = value;
  row.appendChild(dt);
  row.appendChild(dd);
  return row;
}

function renderBlockDetail(entry) {
  const siblings = state.history.filter((e) => e.epoch === entry.epoch);
  el("block-title").textContent = `Block — epoch ${entry.epoch}`;

  const detail = el("block-detail");
  detail.innerHTML = "";

  const blockFacts = document.createElement("dl");
  blockFacts.className = "block-facts";
  blockFacts.appendChild(factRow("Block hash", blockHash(entry.epoch, siblings), { mono: true }));
  blockFacts.appendChild(factRow("Epoch (block height)", String(entry.epoch)));
  blockFacts.appendChild(factRow("Transactions in block", String(siblings.length)));
  detail.appendChild(blockFacts);

  const txHead = document.createElement("h3");
  txHead.className = "block-sub";
  txHead.textContent = "This transaction";
  detail.appendChild(txHead);

  const txFacts = document.createElement("dl");
  txFacts.className = "block-facts";
  txFacts.appendChild(factRow("Transaction hash", entry.hash, { mono: true }));
  txFacts.appendChild(factRow("Type", entry.type));
  txFacts.appendChild(factRow("Actor", PERSONAS[entry.actor]?.name ?? entry.actor));
  txFacts.appendChild(factRow("Campaign", entry.campaignTitle));
  txFacts.appendChild(factRow("Amount", entry.ok ? entry.amountText : "Not committed"));
  txFacts.appendChild(
    factRow("Status", entry.ok ? "Success" : `Rejected — ${entry.message}`, {
      tone: entry.ok ? "ok" : "bad",
    }),
  );
  detail.appendChild(txFacts);

  const callHead = document.createElement("h3");
  callHead.className = "block-sub";
  callHead.textContent = "Template call";
  detail.appendChild(callHead);
  const call = document.createElement("pre");
  call.className = "block-call";
  call.textContent = entry.call;
  detail.appendChild(call);

  const effectsHead = document.createElement("h3");
  effectsHead.className = "block-sub";
  effectsHead.textContent = "Effects";
  detail.appendChild(effectsHead);
  if (entry.events.length > 0) {
    const events = document.createElement("ul");
    events.className = "block-events";
    for (const event of entry.events) {
      const li = document.createElement("li");
      const topic = document.createElement("span");
      topic.className = "ev-topic";
      topic.textContent = event.topic;
      li.appendChild(topic);
      li.appendChild(document.createTextNode(` ${JSON.stringify(event.payload)}`));
      events.appendChild(li);
    }
    detail.appendChild(events);
  } else {
    const none = document.createElement("p");
    none.className = "muted small";
    none.textContent = "No events — the call was rejected, nothing was committed.";
    none.style.margin = "0";
    detail.appendChild(none);
  }

  const sibHead = document.createElement("h3");
  sibHead.className = "block-sub";
  sibHead.textContent = "Other transactions in this block";
  detail.appendChild(sibHead);
  const others = siblings.filter((e) => e.seq !== entry.seq);
  if (others.length === 0) {
    const none = document.createElement("p");
    none.className = "muted small";
    none.textContent = "No other transactions in this block.";
    none.style.margin = "0";
    detail.appendChild(none);
  } else {
    const list = document.createElement("ul");
    list.className = "sibling-list";
    for (const other of others) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sibling-btn";
      const label = document.createElement("span");
      label.textContent = `${other.type} · ${other.campaignTitle}`;
      const hash = document.createElement("span");
      hash.className = "sib-hash";
      hash.textContent = shortHash(other.hash);
      button.appendChild(label);
      button.appendChild(hash);
      button.addEventListener("click", () => renderBlockDetail(other));
      li.appendChild(button);
      list.appendChild(li);
    }
    detail.appendChild(list);
  }
}

function openBlock(seq) {
  const entry = state.history.find((e) => e.seq === seq);
  if (!entry) return;
  blockReturnFocus = document.activeElement;
  renderBlockDetail(entry);
  el("block-modal").hidden = false;
  document.body.classList.add("modal-open");
  el("block-close").focus();
}

function closeBlock() {
  if (el("block-modal").hidden) return;
  el("block-modal").hidden = true;
  document.body.classList.remove("modal-open");
  if (blockReturnFocus && document.contains(blockReturnFocus)) {
    blockReturnFocus.focus();
  }
  blockReturnFocus = null;
}

// --- Walkthrough + rendering (unchanged behavior) -------------------------

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
    const active = btn.dataset.persona === state.activePersona;
    btn.classList.toggle("active", active);
    // Presentational/a11y only: expose the active signer to assistive tech.
    if (active) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
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
  const call =
    `pledge(Bucket ${formatAmount(amount)} TARI) on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`;
  // Wallet-side check (mirrors the account withdraw in a real transaction):
  // the signer cannot pledge more demo units than their wallet holds.
  if (amount > state.wallets.get(persona)) {
    const message = "Insufficient demo balance — the wallet cannot withdraw more than it holds (wallet-side check, not a template rule).";
    showError(message);
    recordHistory({
      type: "Pledge", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI`, call, ok: false, message,
    });
    render();
    return;
  }
  try {
    const events = entry.sim.pledge(persona, amount, state.epoch);
    state.wallets.set(persona, state.wallets.get(persona) - amount);
    recordHistory({
      type: "Pledge", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI`, call, ok: true,
      message: `Pledged ${formatAmount(amount)} TARI`, events,
    });
    if (campaignId === "c1" && persona === "bima") markStep("pledge-bima");
    if (campaignId === "c1" && events.some((e) => e.topic === "CrowdfundCampaign.Funded")) {
      markStep("pledge-sari");
    }
    if (campaignId === "c2") markStep("pledge-mural");
  } catch (err) {
    showError(err.message);
    recordHistory({
      type: "Pledge", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI`, call, ok: false, message: err.message,
    });
  }
  render();
}

function doClaim(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  const call =
    `claim() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`;
  try {
    const { amount, events } = entry.sim.claim(persona, state.epoch);
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    recordHistory({
      type: "Claim", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI`, call, ok: true,
      message: `Claimed ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}`, events,
    });
    if (campaignId === "c1") markStep("claim");
  } catch (err) {
    showError(err.message);
    recordHistory({
      type: "Claim", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: "", call, ok: false, message: err.message,
    });
    if (err.message === "Campaign deadline has not been reached") markStep("early-claim");
  }
  render();
}

function doRefund(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  const call =
    `refund() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`;
  try {
    const { amount, events } = entry.sim.refund(persona, state.epoch);
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    state.refunded.add(`${campaignId}:${persona}`);
    recordHistory({
      type: "Refund", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI`, call, ok: true,
      message: `Refunded ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}`, events,
    });
    if (campaignId === "c2") markStep("refund");
  } catch (err) {
    showError(err.message);
    recordHistory({
      type: "Refund", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: "", call, ok: false, message: err.message,
    });
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
  // Epoch advances are time control, not transactions: they move the demo
  // to a new block height but record no history entry.
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
    closeBlock();
    freshDemo();
    renderHistory();
    for (const step of WALKTHROUGH_STEPS) {
      document.querySelector(`[data-step="${step}"]`)?.classList.remove("done");
    }
    updateWalkthroughCount();
    render();
  });
  el("clear-history").addEventListener("click", () => {
    state.history = [];
    renderHistory();
  });
  el("block-close").addEventListener("click", closeBlock);
  el("block-modal").addEventListener("click", (event) => {
    if (event.target === el("block-modal")) closeBlock();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBlock();
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
    const call =
      `new("${title}", goal ${formatAmount(goal)}, deadline_epoch ${deadlineEpoch}) — signer: ${PERSONAS[state.activePersona].name}, epoch ${state.epoch}`;
    try {
      const sim = new CrowdfundSim({
        creator: state.activePersona,
        title,
        goal,
        deadlineEpoch,
        currentEpoch: state.epoch,
      });
      const id = `custom-${Date.now()}`;
      state.campaigns.push({ id, sim });
      recordHistory({
        type: "Create", actor: state.activePersona, campaignId: id, campaignTitle: title,
        amountText: `Goal ${formatAmount(goal)} TARI`, call, ok: true,
        message: `Campaign “${title}” created`, events: sim.events,
      });
      event.target.reset();
      el("new-deadline").value = "5";
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      recordHistory({
        type: "Create", actor: state.activePersona, campaignId: "", campaignTitle: title,
        amountText: `Goal ${formatAmount(goal)} TARI`, call, ok: false, message: err.message,
      });
    }
    render();
  });

  el("live-status").textContent = liveStatus();
  renderHistory();
  render();
}

init();
