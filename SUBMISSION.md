# Submission draft — Tari November Build Contest (theme: MVP)

DRAFT ONLY. Links, address, and announcement post are placeholders until Monch
approves the public steps. Do not post this text anywhere without that approval.

---

## Project name

Ootle Crowdfund

## One-line description

All-or-nothing crowdfunding on Ootle with backer protection: goal met, funds
release in three vetoable tranches and the creator's bond is at stake; goal
missed, every backer refunds in full — no platform cut, no custody beyond the
template.

## Links (verified live 15 Nov 2026)

- Code: https://github.com/Yogii123-qw/ootle-crowdfund
- MVP app: https://yogii123-qw.github.io/ootle-crowdfund/
- Announcement post (Bluesky / Reddit / Medium / YouTube — X is not accepted this month): https://www.reddit.com/r/tari/comments/1xwaouw/ootle_crowdfund_my_entry_for_the_tari_november/
- Tari payment address (L1 Minotari address): 12BJgCZx2gbkcXmyMqkgCFqyPUCLJbkkL7sJaWUG1omzmk4DRnJqUCCcw2eRVMadssZ6EBH534N21ohMgeDh5PzxLJT

## Description (forum reply body)

**Ootle Crowdfund** is a minimum viable product for all-or-nothing crowdfunding
on Tari Ootle — something a creator could use to fund their next project today.

**How it works.** A creator opens a campaign with a funding goal (TARI), a
deadline (an Ootle epoch), a promise of what backers get (stored on-chain,
labelled as the creator's promise), and a bond of their own TARI —
`max(goal / 10, 100)`. Backers pledge TARI into the campaign's vault. If the
goal is missed by the deadline, every backer refunds in full and the bond
returns to the creator. If the goal is met, funds release in three equal
tranches gated 72 epochs apart — and backers holding more than half of the
pledged value can veto any pending tranche; a successful veto (or the creator
going silent past a gate) returns the remaining funds plus the forfeited bond
to backers pro-rata. There is no platform cut, no custody beyond the template,
and no account to create. One campaign is one component; the template emits
`CampaignCreated`, `Pledged`, `Funded`, `TrancheReleased`,
`CampaignCompleted`, `VetoCast`, `VetoSucceeded`, `Abandoned`,
`BondForfeited`, `BondReturned`, and `Refunded` events for indexers. The
mechanism — parameters with justification, threat model (including the
fresh-account Sybil case), edge cases, and honest limits — is specified in
`docs/MECHANISM-V2.md`.

**What was built.**

- A small, focused Rust template (`CrowdfundCampaign`): vault escrow, a
  separate bond vault, epoch-based deadlines and tranche gates, signer-checked
  claim/veto/abandon/bond/refund, and events. Authorization is enforced in
  code against the transaction signer; the template creates no resource, so
  the owner-bypasses-rules trap cannot apply.
- 52 engine tests run against the real Ootle engine in-process (no network,
  no funds): the v1 behaviors kept intact plus every v2 rule and edge case —
  tranche schedule and gates, veto below/at/above the 50% threshold (exactly
  50% fails), tally reset on release, abandonment timing, bond minimum and
  return/forfeit paths, pro-rata refunds with bond shares, and vault + bond
  vault reconciliation on every path.
- A browser demo whose default path is a walletless simulation: zero installs,
  zero wallet, zero funds, completable in about four minutes with a guided
  16-step checklist covering the full mechanism including the deliberate
  rejections. The simulation mirrors the template's rules and rejection
  messages exactly (46 parity tests).

**Honest limits.** No code can force a human to work or claw back released
funds: a creator who takes tranche 1 and vanishes keeps tranche 1. The
mechanism bounds the loss to released tranches, compensates backers from the
bond on veto or abandonment, and keeps unreleased funds under backer control.
The promise is stored, not enforced. A veto needs strictly more than half of
pledged value, so minority backers are not protected against majority apathy.
The bond prices dishonesty; it does not prevent it. The template has not been
published to Esmeralda or mainnet; the demo is a simulation and says so on
the page. Pledge amounts are public by design (vault accounting) — hiding
them would need a confidential/stealth design. Live wallet mode is an
honestly-labelled stub, not a working path. No on-chain claims are made that
the code cannot back up; `cargo test` reproduces the template's behavior
exactly.

**Code quality note.** Development used an AI agent, as the rules allow. The
code is original, MIT licensed, and written to be read: the template is one
file with its invariants documented, and every rule has a test on both the
engine side and the simulation side.

## How to verify (for judges)

1. Open the app link, follow the 4-minute walkthrough on the page (including
   the deliberate rejections).
2. Clone the repo, run `cargo test` (52 engine tests, no network needed).
3. Run `node --test app/sim.test.mjs` (46 simulation parity tests).
4. Build the WASM: `cargo build --target wasm32-unknown-unknown --release`.

## Update log (edit into the forum post if the submission changes)

- 15 Nov 2026: mechanism v2 — staged tranche release, pledge-weighted backer
  veto, creator bond, abandonment path, on-chain promise. Funding phase
  unchanged (all-or-nothing). 52 engine tests, 46 parity tests. Full spec in
  `docs/MECHANISM-V2.md`.
