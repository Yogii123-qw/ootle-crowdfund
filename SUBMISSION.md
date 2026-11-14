# Submission draft — Tari November Build Contest (theme: MVP)

DRAFT ONLY. Links, address, and announcement post are placeholders until Monch
approves the public steps. Do not post this text anywhere without that approval.

---

## Project name

Ootle Crowdfund

## One-line description

All-or-nothing crowdfunding on Ootle: goal met, the creator claims; goal missed,
every backer refunds in full — no platform cut, no custody beyond the template.

## Links (PLACEHOLDERS — fill in at submission time)

- Code: TODO_REPO_URL
- MVP app: TODO_APP_URL
- Announcement post (Bluesky / Reddit / Medium / YouTube — X is not accepted this month): TODO_ANNOUNCEMENT_URL
- Tari payment address (L1 Minotari address): TODO_TARI_ADDRESS

## Description (forum reply body)

**Ootle Crowdfund** is a minimum viable product for all-or-nothing crowdfunding
on Tari Ootle — something a creator could use to fund their next project today.

**How it works.** A creator opens a campaign with a funding goal (TARI) and a
deadline (an Ootle epoch). Backers pledge TARI into the campaign's vault. At the
deadline, exactly one thing happens: if the goal was met, the creator claims the
whole vault in one call; if it was missed, each backer refunds their own pledge
in full. There is no platform cut, no custody beyond the template, and no
account to create. One campaign is one component; the template emits
`CampaignCreated`, `Pledged`, `Funded`, `Claimed`, and `Refunded` events for
indexers.

**What was built.**

- A small, focused Rust template (`CrowdfundCampaign`): vault escrow,
  epoch-based deadlines, signer-checked claim/refund, and events. Authorization
  is enforced in code against the transaction signer; the template creates no
  resource, so the owner-bypasses-rules trap cannot apply.
- 15 engine tests run against the real Ootle engine in-process (no network, no
  funds): happy paths plus every rejection that matters — early claim,
  non-creator claim, double claim, claim on a missed goal, double refund,
  refund after success, refund before the deadline, both sides of the
  deadline boundary, non-TARI and zero-amount pledges, post-claim pledges,
  and creation input validation including the title-length limit.
- A browser demo whose default path is a walletless simulation: zero installs,
  zero wallet, zero funds, completable in about two minutes with a guided
  checklist. The simulation mirrors the template's rules and rejection messages
  exactly and is parity-tested against the same scenarios as the engine tests.

**Honest limits.** The template has not been published to Esmeralda or mainnet;
the demo is a simulation and says so on the page. Pledge amounts are public by
design in v1 (vault accounting) — hiding them would need a confidential/stealth
design. Live wallet mode is an honestly-labelled stub, not a working path. No
on-chain claims are made that the code cannot back up; `cargo test` reproduces
the template's behavior exactly.

**Code quality note.** Development used an AI agent, as the rules allow. The
code is original, MIT licensed, and written to be read: the template is one
file with its invariants documented, and every rule has a test on both the
engine side and the simulation side.

## How to verify (for judges)

1. Open the app link, follow the 2-minute walkthrough on the page (including
   the deliberate rejections).
2. Clone the repo, run `cargo test` (15 engine tests, no network needed).
3. Run `node --test app/sim.test.mjs` (14 simulation parity tests).
4. Build the WASM: `cargo build --target wasm32-unknown-unknown --release`.

## Update log (edit into the forum post if the submission changes)

- (none yet)
