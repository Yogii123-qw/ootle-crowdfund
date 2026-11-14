// Demo harness: wires the CrowdfundSim state machine (sim.js) to the page.
//
// This file owns ONLY demo concerns: persona wallets, the epoch control,
// rendering, the transaction history (with deterministic simulated hashes
// and the in-app block view), and the walkthrough checklist. Every funding
// rule lives in sim.js, which mirrors the Rust template. Wallet balances
// here play the role test accounts play in the engine tests: a pledge
// deducts from the signer's demo wallet, a claim/refund credits it back.
// The bond formula below is a display-only mirror for the live bond hint;
// sim.js enforces the real check at creation.
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
// v2 mechanism constants (spec §2). Display and gate math only — sim.js
// is the authority on every rule.
const VETO_WINDOW_EPOCHS = 72;
const TRANCHE_COUNT = 3;
const MIN_BOND = 100n;

// Seeded campaigns (spec §11 demo contract): honest promises, created by
// Rani, bonds deducted from her demo wallet at freshDemo.
const SEEDED_CAMPAIGNS = [
  {
    id: "c1",
    title: "Community radio",
    promise: "Backers' names read on the first broadcast + invite to launch day",
    goal: 1000n,
    bond: 100n,
    // The walkthrough's first pledge is 400; prefill it so step 1 is one click.
    defaultAmount: "400",
  },
  {
    id: "c2",
    title: "Neighborhood mural",
    promise: "Each backer picks one small mural element + names on a plaque",
    goal: 5000n,
    bond: 500n,
    // The walkthrough's mural pledge is 300; prefill it so step 3 is one click.
    defaultAmount: "300",
  },
];

/** Required creator bond: max(goal / 10, 100), floor division (spec §2). */
function requiredBond(goal) {
  const tenth = goal / 10n;
  return tenth > MIN_BOND ? tenth : MIN_BOND;
}

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
  // Campaign ids whose bond has returned to the creator via claimBond.
  // Lets the bond line show "returned" even if the sim exposes no flag.
  bondReturned: new Set(),
  // Simulated transaction history, newest first. seq restarts on reset, so
  // the same action sequence always produces the same hashes.
  history: [],
  seq: 0,
  // Last rejection message per campaign id. render() rebuilds every card,
  // so without this the inline error would be wiped before it ever paints;
  // the message survives until the next action on that card.
  cardErrors: {},
};

const WALKTHROUGH_STEPS = [
  "pledge-bima",
  "pledge-sari",
  "pledge-mural",
  "early-claim",
  "create-promise",
  "fund-created",
  "advance",
  "claim",
  "veto-fails",
  "claim-tranche-2",
  "veto-succeeds",
  "refund-bond-share",
  "refund",
  "double-refund",
  "complete-bond",
  "refund-after-success",
];

function freshDemo() {
  state.epoch = 0;
  state.activePersona = "bima";
  // Rani funded both seeded bonds (100 + 500) at creation; her wallet
  // starts net of them. Bima and Sari start whole.
  const seededBondTotal = SEEDED_CAMPAIGNS.reduce((sum, c) => sum + c.bond, 0n);
  state.wallets = new Map(
    Object.keys(PERSONAS).map((id) => [
      id,
      id === "rani" ? STARTING_BALANCE - seededBondTotal : STARTING_BALANCE,
    ]),
  );
  state.progress = {};
  state.refunded = new Set();
  state.bondReturned = new Set();
  state.cardErrors = {};
  state.history = [];
  state.seq = 0;
  state.campaigns = SEEDED_CAMPAIGNS.map((seed) => ({
    id: seed.id,
    promise: seed.promise,
    bond: seed.bond,
    defaultAmount: seed.defaultAmount,
    sim: new CrowdfundSim({
      creator: "rani",
      title: seed.title,
      promise: seed.promise,
      goal: seed.goal,
      deadlineEpoch: 5,
      bond: seed.bond,
      currentEpoch: 0,
    }),
  }));
}

function el(id) {
  return document.getElementById(id);
}

// --- Simulation access helpers ------------------------------------------
//
// The §11 contract names getters in camelCase. Read them defensively:
// a getter may be a property or a zero-argument method, and older sims
// may lack a field entirely — every helper falls back to a value derived
// from the campaign wrapper or the spec formulas, so rendering never
// throws on a missing getter. Funding rules still live in sim.js; these
// helpers only READ state for display.

function simValue(sim, name, fallback) {
  const value = sim[name];
  if (typeof value === "function") {
    try {
      return value.call(sim);
    } catch {
      return fallback;
    }
  }
  return value === undefined ? fallback : value;
}

function campaignPromise(entry) {
  const fromSim = simValue(entry.sim, "promise", undefined);
  if (typeof fromSim === "string" && fromSim.length > 0) return fromSim;
  return entry.promise ?? "";
}

function bondAmountOf(entry) {
  const fromSim = simValue(entry.sim, "bondAmount", undefined);
  if (typeof fromSim === "bigint") return fromSim;
  return entry.bond ?? requiredBond(entry.sim.goal);
}

function tranchesReleasedOf(sim, epoch) {
  const value = simValue(sim, "tranchesReleased", undefined);
  if (typeof value === "number") return value;
  // v1 fallback: claimed means fully released.
  return sim.status(epoch) === "claimed" ? TRANCHE_COUNT : 0;
}

function trancheGate(sim, index) {
  return sim.deadlineEpoch + index * VETO_WINDOW_EPOCHS;
}

function nextTrancheEpochOf(sim, epoch) {
  const value = simValue(sim, "nextTrancheEpoch", undefined);
  if (typeof value === "number") return value;
  return trancheGate(sim, tranchesReleasedOf(sim, epoch));
}

function trancheAmountsOf(sim) {
  const total = sim.totalPledged;
  const base = total / BigInt(TRANCHE_COUNT);
  return [base, base, total - 2n * base];
}

function isVetoedOf(sim, epoch) {
  const value = simValue(sim, "isVetoed", undefined);
  if (typeof value === "boolean") return value;
  return sim.status(epoch) === "vetoed";
}

function isAbandonedOf(sim, epoch) {
  const value = simValue(sim, "isAbandoned", undefined);
  if (typeof value === "boolean") return value;
  return sim.status(epoch) === "abandoned";
}

function vetoTotalOf(sim) {
  const value = simValue(sim, "vetoTotal", undefined);
  return typeof value === "bigint" ? value : 0n;
}

function myVetoOf(sim, caller) {
  if (typeof sim.myVeto === "function") {
    try {
      const value = sim.myVeto(caller);
      return typeof value === "bigint" ? value : 0n;
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/** Bond state for the card line: locked, returned, or forfeited. */
function bondStateOf(entry, epoch) {
  if (isVetoedOf(entry.sim, epoch) || isAbandonedOf(entry.sim, epoch)) return "forfeited";
  if (state.bondReturned.has(entry.id)) return "returned";
  const balance = simValue(entry.sim, "bondBalance", undefined);
  if (typeof balance === "bigint" && balance === 0n && bondAmountOf(entry) > 0n) {
    return "returned";
  }
  if (simValue(entry.sim, "bondClaimed", false) === true) return "returned";
  return "locked";
}

/** True when claimBond would succeed for the creator (failed or complete). */
function bondReturnable(entry, epoch) {
  if (bondStateOf(entry, epoch) !== "locked") return false;
  const status = entry.sim.status(epoch);
  return status === "settled-failed" || status === "completed";
}

/** True when a veto can currently be cast on this campaign. */
function vetoOpen(sim, epoch) {
  return (
    epoch >= sim.deadlineEpoch &&
    sim.totalPledged >= sim.goal &&
    tranchesReleasedOf(sim, epoch) < TRANCHE_COUNT &&
    !isVetoedOf(sim, epoch) &&
    !isAbandonedOf(sim, epoch)
  );
}

/** True when the next tranche is claimable right now. */
function trancheClaimable(sim, epoch) {
  return vetoOpen(sim, epoch) && epoch >= nextTrancheEpochOf(sim, epoch);
}

/** Normalize a sim call result to its event list (array or {events}). */
function asEvents(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.events)) return result.events;
  return [];
}

/** Normalize a payout call result to {amount, events}. */
function asPayout(result) {
  if (result && typeof result.amount === "bigint") {
    return { amount: result.amount, events: asEvents(result) };
  }
  if (typeof result === "bigint") return { amount: result, events: [] };
  return { amount: 0n, events: asEvents(result) };
}

function eventPayload(events, topic) {
  const found = events.find((e) => e.topic === topic);
  return found ? found.payload ?? {} : {};
}

function payloadBigInt(payload, key) {
  try {
    const raw = payload[key];
    if (raw === undefined || raw === null) return 0n;
    return BigInt(raw);
  } catch {
    return 0n;
  }
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
    meta.textContent = `${PERSONAS[entry.actor]?.name ?? entry.actor} · epoch ${entry.epoch}`;
    const hash = document.createElement("span");
    hash.className = "hist-hash";
    // The separator travels with the hash (nowrap in CSS) so a wrap never
    // orphans a lone "·" on its own line.
    hash.textContent = ` · ${shortHash(entry.hash)}`;
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

// --- Walkthrough + rendering ---------------------------------------------

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
    case "completed":
      return "Completed — all 3 releases paid, bond returnable";
    case "vetoed":
      return "Vetoed — backers stopped the release; remaining funds and bond refundable";
    case "abandoned":
      return "Abandoned — creator silent; remaining funds and bond refundable";
    case "open":
      return `Open — ends at epoch ${sim.deadlineEpoch}`;
    case "open-funded":
      return `Open — goal reached, settles at epoch ${sim.deadlineEpoch}`;
    case "settled-funded":
      return "Settled — goal met, releases open in tranches";
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
    case "completed":
      return "Completed";
    case "vetoed":
      return "Vetoed";
    case "abandoned":
      return "Abandoned";
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
  for (const entry of state.campaigns) {
    const { id, sim, defaultAmount } = entry;
    const mine = sim.pledgeOf(state.activePersona);
    const pct = sim.goal > 0n ? Number((sim.totalPledged * 100n) / sim.goal) : 0;
    const status = sim.status(state.epoch);
    const released = tranchesReleasedOf(sim, state.epoch);
    const amounts = trancheAmountsOf(sim);
    const vetoed = isVetoedOf(sim, state.epoch);
    const abandoned = isAbandonedOf(sim, state.epoch);
    const completed = status === "completed" || status === "claimed";
    const nextGate = nextTrancheEpochOf(sim, state.epoch);
    const bondState = bondStateOf(entry, state.epoch);
    const showClaimBond =
      state.activePersona === sim.creator && bondReturnable(entry, state.epoch);
    // Contextual primary (presentational only): the filled button marks
    // whichever action is currently meaningful, from visible state alone.
    // Nothing is ever disabled — rejections stay clickable and recorded,
    // because they demonstrate the template rules. Pledge is the fallback
    // so a card never has zero primaries or two.
    let primary = "pledge";
    if (state.activePersona === sim.creator && trancheClaimable(sim, state.epoch)) {
      primary = "claim";
    } else if (
      mine > 0n &&
      myVetoOf(sim, state.activePersona) === 0n &&
      vetoOpen(sim, state.epoch)
    ) {
      primary = "veto";
    } else if (
      mine > 0n &&
      (status === "settled-failed" || status === "vetoed" || status === "abandoned")
    ) {
      primary = "refund";
    } else if (showClaimBond) {
      primary = "claim-bond";
    }
    const balanceHint = `${PERSONAS[state.activePersona].name} holds ${formatAmount(state.wallets.get(state.activePersona))} TARI`;
    const card = document.createElement("article");
    card.className = "card campaign";
    // Markup hooks this template must keep: h3, p.muted > 3 strongs
    // (creator, deadline, backers), .status, .status-note, .progress /
    // .progress-bar, .total, .goal, .mine, .amount, .balance-hint,
    // .pledge-btn, .claim-btn, .refund-btn, .veto-btn, .abandon-btn,
    // .claim-bond-btn (only when the bond is returnable to the acting
    // creator), .promise, .promise-note, .bond-line, .tranches /
    // .tranche-line / .tranche-segs / .seg / .seg-amt / .seg-meta /
    // .seg-state, .veto-line, .error. Restyle
    // freely; do not rename. Exactly one of the action buttons carries
    // .btn-primary at a time (see `primary` above).
    const segState = (index) => {
      if (index < released) return "released";
      if (vetoed || abandoned) return "frozen";
      if (status === "settled-failed") return "closed";
      if (index === released) return "pending";
      return "locked";
    };
    const segWord = { released: "released", pending: "next", locked: "locked", frozen: "frozen", closed: "closed" };
    const segHtml = amounts
      .map((amount, index) => {
        const st = segState(index);
        // No pledges yet: tranche amounts are undetermined (they split the
        // final pledged total), so show a dash instead of misleading zeros.
        const amtText = sim.totalPledged === 0n ? "—" : formatAmount(amount);
        return `<div class="seg seg-${st}"><span class="seg-amt">${amtText}</span><span class="seg-meta">epoch ${trancheGate(sim, index)}</span><span class="seg-state">${segWord[st]}</span></div>`;
      })
      .join("");
    const trancheLine = completed
      ? `Releases: ${TRANCHE_COUNT} of ${TRANCHE_COUNT} · complete`
      : vetoed
        ? `Releases: ${released} of ${TRANCHE_COUNT} · vetoed — rest refundable`
        : abandoned
          ? `Releases: ${released} of ${TRANCHE_COUNT} · abandoned — rest refundable`
          : status === "settled-failed"
            ? `Releases: ${released} of ${TRANCHE_COUNT} · goal missed`
            : state.epoch >= nextGate
              ? `Releases: ${released} of ${TRANCHE_COUNT} · next release open`
              : `Releases: ${released} of ${TRANCHE_COUNT} · next opens epoch ${nextGate}`;
    const vetoTotal = vetoTotalOf(sim);
    const showVeto = vetoOpen(sim, state.epoch) || vetoTotal > 0n || vetoed;
    const myVeto = myVetoOf(sim, state.activePersona);
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
      <p class="promise"><span class="promise-label">Promise:</span> <span class="promise-text"></span></p>
      <p class="promise-note muted small">Creator's promise — not enforced by the template.</p>
      <p class="bond-line">Bond: <strong class="bond-amount"></strong> · <span class="bond-state"></span></p>
      <div class="tranches">
        <p class="tranche-line muted small">${trancheLine}</p>
        <div class="tranche-segs">${segHtml}</div>
      </div>
      <p class="veto-line"${showVeto ? "" : " hidden"}>Veto: <strong class="veto-tally"></strong> <span class="veto-note"></span></p>
      <p class="mine-line">Your pledge (${PERSONAS[state.activePersona].name}): <strong class="mine"></strong> TARI</p>
      <div class="row">
        <label>Amount <input type="text" inputmode="numeric" class="amount" value="${defaultAmount ?? "400"}" aria-label="Pledge amount in TARI units"><span class="balance-hint">${balanceHint}</span></label>
        <button type="button" class="pledge-btn${primary === "pledge" ? " btn-primary" : ""}">Pledge</button>
        <button type="button" class="claim-btn${primary === "claim" ? " btn-primary" : ""}">Claim</button>
        <button type="button" class="refund-btn${primary === "refund" ? " btn-primary" : ""}">Refund</button>
        <button type="button" class="veto-btn${primary === "veto" ? " btn-primary" : ""}">Veto</button>
        <button type="button" class="abandon-btn">Abandon</button>
        ${showClaimBond ? `<button type="button" class="claim-bond-btn${primary === "claim-bond" ? " btn-primary" : ""}">Claim bond</button>` : ""}
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
    card.querySelector(".promise-text").textContent = campaignPromise(entry);
    card.querySelector(".bond-amount").textContent = `${formatAmount(bondAmountOf(entry))} TARI`;
    card.querySelector(".bond-state").textContent =
      bondState === "returned"
        ? "returned to creator"
        : bondState === "forfeited"
          ? "forfeited to backers"
          : "locked";
    if (showVeto) {
      card.querySelector(".veto-tally").textContent =
        `${formatAmount(vetoTotal)} / ${formatAmount(sim.totalPledged)} pledged`;
      card.querySelector(".veto-note").textContent = vetoed
        ? "— veto succeeded"
        : myVeto > 0n
          ? `— needs more than half · you vetoed (weight ${formatAmount(myVeto)})`
          : "— needs more than half";
    }

    const errorBox = card.querySelector(".error");
    // Persist rejections in state: render() rebuilds the card, so the box
    // alone would be wiped before it ever paints. A new attempt on this
    // card clears the saved message (see the listeners below).
    const showError = (message) => {
      state.cardErrors[id] = message;
      errorBox.textContent = message;
      errorBox.hidden = false;
    };
    if (state.cardErrors[id]) {
      errorBox.textContent = state.cardErrors[id];
      errorBox.hidden = false;
    }
    card.querySelector(".pledge-btn").addEventListener("click", () => {
      delete state.cardErrors[id];
      doPledge(id, card.querySelector(".amount").value, showError);
    });
    card.querySelector(".claim-btn").addEventListener("click", () => {
      delete state.cardErrors[id];
      doClaim(id, showError);
    });
    card.querySelector(".refund-btn").addEventListener("click", () => {
      delete state.cardErrors[id];
      doRefund(id, showError);
    });
    card.querySelector(".veto-btn").addEventListener("click", () => {
      delete state.cardErrors[id];
      doVeto(id, showError);
    });
    card.querySelector(".abandon-btn").addEventListener("click", () => {
      delete state.cardErrors[id];
      doAbandon(id, showError);
    });
    card.querySelector(".claim-bond-btn")?.addEventListener("click", () => {
      delete state.cardErrors[id];
      doClaimBond(id, showError);
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
  // The message names the actual balance and the next step, so the
  // rejection teaches instead of dead-ending.
  if (amount > state.wallets.get(persona)) {
    const balance = state.wallets.get(persona);
    const guidance = balance > 0n
      ? `pledge ${formatAmount(balance)} or less, or switch persona and pledge the rest`
      : "switch persona to pledge from another wallet";
    const message = `${PERSONAS[persona].name} holds ${formatAmount(balance)} TARI — ${guidance} (wallet-side check, not a template rule).`;
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
    if (
      campaignId.startsWith("custom-") &&
      events.some((e) => e.topic === "CrowdfundCampaign.Funded")
    ) {
      markStep("fund-created");
    }
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
    const { amount, events } = asPayout(entry.sim.claim(persona, state.epoch));
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    // The tranche just released: the counter after the call, or the
    // TrancheReleased event payload if the sim exposes no counter.
    const released = tranchesReleasedOf(entry.sim, state.epoch);
    const eventTranche = payloadBigInt(
      eventPayload(events, "CrowdfundCampaign.TrancheReleased"),
      "tranche",
    );
    const trancheNo = released > 0 ? released : Number(eventTranche || 1n);
    recordHistory({
      type: "Claim", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI · tranche ${trancheNo} of ${TRANCHE_COUNT}`,
      call, ok: true,
      message: `Claimed tranche ${trancheNo}: ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}`,
      events,
    });
    if (campaignId === "c1" && trancheNo === 1) markStep("claim");
    if (campaignId === "c1" && trancheNo === 2) markStep("claim-tranche-2");
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
    const { amount, events } = asPayout(entry.sim.refund(persona, state.epoch));
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    state.refunded.add(`${campaignId}:${persona}`);
    const bondShare = payloadBigInt(
      eventPayload(events, "CrowdfundCampaign.Refunded"),
      "bond_share",
    );
    recordHistory({
      type: "Refund", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: bondShare > 0n
        ? `+${formatAmount(amount)} TARI · ${formatAmount(bondShare)} bond share`
        : `+${formatAmount(amount)} TARI`,
      call, ok: true,
      message: `Refunded ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}`, events,
    });
    if (campaignId === "c2") markStep("refund");
    if (campaignId === "c1" && bondShare > 0n) markStep("refund-bond-share");
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
    // "Refunds are closed" proves the success path only on a funded
    // campaign; on an unfunded one the goal was simply missed instead.
    if (
      err.message.includes("refunds are closed") &&
      entry.sim.totalPledged >= entry.sim.goal
    ) {
      markStep("refund-after-success");
    }
  }
  render();
}

function doVeto(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  const call =
    `veto() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`;
  try {
    const events = asEvents(entry.sim.veto(persona, state.epoch));
    const weight = myVetoOf(entry.sim, persona) || entry.sim.pledgeOf(persona);
    const succeeded = events.some((e) => e.topic === "CrowdfundCampaign.VetoSucceeded");
    recordHistory({
      type: "Veto", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `Weight ${formatAmount(weight)} TARI`, call, ok: true,
      message: succeeded
        ? `Veto succeeded: ${formatAmount(vetoTotalOf(entry.sim))} of ${formatAmount(entry.sim.totalPledged)} pledged`
        : `Veto recorded: ${formatAmount(weight)} TARI weight`,
      events,
    });
    if (campaignId === "c1" && succeeded) markStep("veto-succeeds");
    else if (campaignId === "c1") markStep("veto-fails");
  } catch (err) {
    showError(err.message);
    recordHistory({
      type: "Veto", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: "", call, ok: false, message: err.message,
    });
  }
  render();
}

function doAbandon(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  const call =
    `abandon() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`;
  try {
    // abandon() is callable by anyone; the sim may take (caller, epoch)
    // or (epoch) alone. Dispatch on arity so either shape works.
    const result = entry.sim.abandon.length >= 2
      ? entry.sim.abandon(persona, state.epoch)
      : entry.sim.abandon(state.epoch);
    const events = asEvents(result);
    const unreleased = payloadBigInt(
      eventPayload(events, "CrowdfundCampaign.Abandoned"),
      "unreleased",
    );
    recordHistory({
      type: "Abandon", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `${formatAmount(unreleased)} TARI unreleased`,
      call, ok: true,
      message: `Campaign abandoned; ${formatAmount(unreleased)} TARI refundable`,
      events,
    });
  } catch (err) {
    showError(err.message);
    recordHistory({
      type: "Abandon", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: "", call, ok: false, message: err.message,
    });
  }
  render();
}

function doClaimBond(campaignId, showError) {
  const entry = findCampaign(campaignId);
  const persona = state.activePersona;
  const call =
    `claim_bond() on “${entry.sim.title}” — signer: ${PERSONAS[persona].name}, epoch ${state.epoch}`;
  try {
    const { amount, events } = asPayout(entry.sim.claimBond(persona, state.epoch));
    state.wallets.set(persona, state.wallets.get(persona) + amount);
    state.bondReturned.add(campaignId);
    recordHistory({
      type: "Bond", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: `+${formatAmount(amount)} TARI`, call, ok: true,
      message: `Bond returned: ${formatAmount(amount)} TARI to ${PERSONAS[persona].name}`,
      events,
    });
    if (
      campaignId.startsWith("custom-") &&
      tranchesReleasedOf(entry.sim, state.epoch) === TRANCHE_COUNT
    ) {
      markStep("complete-bond");
    }
  } catch (err) {
    showError(err.message);
    recordHistory({
      type: "Bond", actor: persona, campaignId, campaignTitle: entry.sim.title,
      amountText: "", call, ok: false, message: err.message,
    });
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
  el("epoch-plus-72").addEventListener("click", () => setEpoch(state.epoch + VETO_WINDOW_EPOCHS));
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
  // Quiet goal hint: the demo wallets hold a fixed total, so a goal
  // above it can never be funded in this demo. A hint only — it never
  // blocks creation. The total is net of the seeded bonds locked in
  // Rani's wallet (9,400 + 10,000 + 10,000).
  const totalDemoBalance = [...state.wallets.values()].reduce((sum, b) => sum + b, 0n);
  const goalHint = el("goal-hint");
  goalHint.textContent =
    `Demo wallets hold ${formatAmount(totalDemoBalance)} TARI in total — a larger goal can never be funded in this demo.`;
  const updateGoalHint = () => {
    let goal;
    try {
      goal = parseAmount(el("new-goal").value);
    } catch {
      goalHint.hidden = true;
      return;
    }
    goalHint.hidden = goal <= totalDemoBalance;
  };
  // Live bond requirement: updates as the goal is typed, so the cost
  // of creating is visible before the creator commits.
  const bondHint = el("bond-hint");
  const updateBondHint = () => {
    let goal;
    try {
      goal = parseAmount(el("new-goal").value);
    } catch {
      bondHint.hidden = true;
      return;
    }
    bondHint.textContent =
      `Bond required: ${formatAmount(requiredBond(goal))} TARI — 10% of goal, min 100; returns if the campaign completes or misses its goal.`;
    bondHint.hidden = false;
  };
  el("new-goal").addEventListener("input", () => {
    updateGoalHint();
    updateBondHint();
  });
  el("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const errorBox = el("create-error");
    errorBox.hidden = true;
    const title = el("new-title").value.trim();
    const promise = el("new-promise").value.trim();
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
    const bond = requiredBond(goal);
    const call =
      `new("${title}", promise "${promise}", goal ${formatAmount(goal)}, deadline_epoch ${deadlineEpoch}, bond ${formatAmount(bond)} TARI) — signer: ${PERSONAS[state.activePersona].name}, epoch ${state.epoch}`;
    // Wallet-side bond check, same pattern as the pledge wallet check:
    // the creator cannot lock a bond larger than their demo wallet.
    if (bond > state.wallets.get(state.activePersona)) {
      const balance = state.wallets.get(state.activePersona);
      const message = `${PERSONAS[state.activePersona].name} holds ${formatAmount(balance)} TARI, but the bond is ${formatAmount(bond)} TARI — lower the goal or switch persona to create from another wallet (wallet-side check, not a template rule).`;
      errorBox.textContent = message;
      errorBox.hidden = false;
      recordHistory({
        type: "Create", actor: state.activePersona, campaignId: "", campaignTitle: title,
        amountText: `Goal ${formatAmount(goal)} TARI`, call, ok: false, message,
      });
      render();
      return;
    }
    try {
      const sim = new CrowdfundSim({
        creator: state.activePersona,
        title,
        promise,
        goal,
        deadlineEpoch,
        bond,
        currentEpoch: state.epoch,
      });
      // The bond leaves the creator's demo wallet at creation and
      // returns only via claimBond (or forfeits to backers on veto).
      state.wallets.set(
        state.activePersona,
        state.wallets.get(state.activePersona) - bond,
      );
      const id = `custom-${Date.now()}`;
      state.campaigns.push({ id, sim, promise, bond });
      recordHistory({
        type: "Create", actor: state.activePersona, campaignId: id, campaignTitle: title,
        amountText: `Goal ${formatAmount(goal)} TARI`, call, ok: true,
        message: `Campaign “${title}” created`, events: sim.events,
      });
      markStep("create-promise");
      event.target.reset();
      el("new-deadline").value = "5";
      updateGoalHint();
      updateBondHint();
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
