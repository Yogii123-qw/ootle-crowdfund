# Ootle Crowdfund

All-or-nothing crowdfunding on Tari Ootle, with backer protection built into
the mechanism. A creator sets a funding goal and an epoch deadline, states
what backers get (a promise, stored on-chain), and locks their own TARI as a
bond. Backers pledge TARI into a vault. Goal missed by the deadline → every
backer refunds in full and the bond returns to the creator. Goal met → funds
release in three tranches, and backers holding more than half of the pledged
value can veto any release they have lost faith in; a successful veto (or the
creator going silent) returns the remaining funds plus the forfeited bond to
backers pro-rata. No platform cut, no custody beyond the template, no
accounts. The mechanism is specified in full — parameters, threat model, and
honest limits — in `docs/MECHANISM-V2.md`.

Built for the **Tari November Build Contest** (theme: MVP). Original code,
written with an AI agent (explicitly allowed by the contest rules), MIT licensed.

## Try it in ~2 minutes (no installs, no wallet)

The demo is a **walletless browser simulation** of the template — the default
judge path. It mirrors the template's state machine exactly (same rules, same
rejection messages) and runs entirely in your browser.

```sh
cd app
python3 -m http.server 8000
# open http://localhost:8000/
```

No build step, no dependencies, no network calls. The page includes a guided
walkthrough checklist that ticks itself off:

1. Pledge 400 as Bima on *Community radio*.
2. Switch to Sari and pledge 600 — the goal fills and the `Funded` event fires.
3. Pledge 300 as Bima on *Neighborhood mural*, before advancing time (pledges
   close at the deadline). This campaign will miss its goal — that is what
   makes the refund steps possible.
4. Try **Claim** as Rani before the deadline — rejected (early claim).
5. As Rani, create *Rooftop garden*: goal 900, a promise to backers, deadline
   5 epochs — and note the 100 TARI bond leaving Rani's wallet at creation.
6. Fund *Rooftop garden*: pledge 600 as Bima, then 300 as Sari.
7. Advance the epoch to 5 (the deadline).
8. Claim *Community radio* as Rani — tranche 1 of 3 pays out (333 of 1,000).
9. As Bima, **Veto** *Community radio* — 400 of 1,000 is under half, so the
   veto fails and the campaign continues.
10. Jump +72 epochs, then claim tranche 2 as Rani — the veto tally resets on
    release.
11. **Veto** as Bima, then as Sari — together over half, so the veto succeeds
    and the rest freezes.
12. As Bima, **Refund** *Community radio* — a pro-rata share of what remains,
    plus a share of the forfeited bond.
13. Switch to Bima and **Refund** *Neighborhood mural* — full repayment.
14. Refund again — rejected (double refund).
15. Finish *Rooftop garden* as Rani: claim all three tranches across the
    release windows, then **Claim bond**.
16. Try refunding *Rooftop garden* — rejected (refunds closed after
    completion).

The transaction **History** records every simulated action — create, pledge,
claim, veto, abandon, bond return, refund, and rejections — as one row with a deterministic simulated
hash (an FNV-1a digest of the call data, so the same actions always yield
the same hashes), type, actor, campaign, amount, epoch, and outcome.
Selecting a row opens the simulated **block view**: the epoch as the
block-height analog, the block hash derived from the block's transactions,
the template call, its effects, and the other transactions in the same
block. Both are labeled simulated everywhere — demo hashes, no real chain —
and nothing links to a real explorer.

## The template

`src/lib.rs` — `CrowdfundCampaign`, one campaign per component.

| Call | Who | When | Effect |
|---|---|---|---|
| `new(creator, title, goal, deadline, promise, bond)` | anyone (becomes creator) | deadline must be in the future; promise 1–280 chars; bond ≥ `max(goal / 10, 100)` TARI | Opens the campaign, empty pledge vault + locked bond vault |
| `pledge(bucket)` | anyone | `current_epoch < deadline` and campaign still open | Deposits TARI, records the backer; amounts accumulate |
| `claim() -> Bucket` | creator only | `current_epoch >= next tranche gate`, goal met, not vetoed/abandoned | Releases the next tranche (1 of 3), once per gate |
| `veto()` | any backer with a pledge | campaign funded, tranche pending | Records a veto weighted by the backer's pledge; over half of pledged value freezes the campaign |
| `abandon()` | anyone | 72 epochs past the next tranche's gate with no release | Opens refunds of remaining funds + the forfeited bond |
| `claim_bond() -> Bucket` | creator only | goal missed (after deadline) or all 3 tranches released | Returns the bond, once |
| `refund() -> Bucket` | any backer | goal missed (full pledge), or after veto/abandonment (pro-rata share of remaining vault + forfeited bond) | Pays the caller out, once |
| getters | anyone | anytime | `get_status`, `get_title`, `get_promise`, `get_creator`, `get_goal`, `get_deadline`, `get_bond_amount`, `get_tranches_released`, `get_next_tranche_gate`, `get_tranche_amount`, `get_veto_total`, `get_total_pledged`, `get_pledge`, `get_backer_count`, `is_funded`, `is_refunded`, `is_claimed`, `is_vetoed`, `is_abandoned`, `is_bond_claimed`, `has_vetoed` |

Events (indexable): `CampaignCreated`, `Pledged`, `Funded` (fires once, when
the total first reaches the goal), `TrancheReleased`, `CampaignCompleted`,
`VetoCast`, `VetoSucceeded`, `Abandoned`, `BondForfeited`, `BondReturned`,
`Refunded`. The full mechanism — tranche schedule, bond parameters, veto
threshold, threat model, and every edge case — is specified in
`docs/MECHANISM-V2.md`.

### Design decisions

- **Epoch deadlines, with a tested boundary.** Pledges are accepted while
  `current_epoch < deadline`; settlement opens at `current_epoch >=
  deadline`. Both sides of the boundary are covered by engine tests using
  epoch overrides.
- **One funding outcome, enforced.** After the deadline, tranches require the
  goal to be met and full refunds require it to be missed, so the two paths
  are mutually exclusive. A backer's ledger entry is removed before their
  refund pays out — no double-refund on any path — and each tranche releases
  at most once.
- **Staged release, fixed for every campaign.** Three equal tranches of the
  pledged total (floor thirds, remainder in the last), gated at the deadline,
  +72 epochs, and +144 epochs. One epoch is ~20 minutes on mainnet, so each
  window is about a day: long enough for backers to react, short enough that a
  creator is not strung along. Fixed counts keep the rules — and the demo —
  the same for every campaign.
- **Pledge-weighted veto, strictly over half.** A veto succeeds only when
  backers holding MORE than 50% of pledged value object. Fresh accounts with
  no stake cannot veto, and cannot fake support either. Exactly 50% fails.
  The tally resets on each release, so every tranche needs its own fresh
  majority to stop.
- **The creator's bond is the economic answer to fresh accounts.** Every
  campaign requires the creator to lock `max(goal / 10, 100)` TARI of their
  own at creation — 10% of the goal, at least 100 TARI. A new account does
  not escape it: every campaign demands a fresh bond. The bond returns on
  failure or completion, and is forfeited to backers pro-rata on veto or
  abandonment.
- **Abandonment has a path.** If the creator never claims, anyone may call
  `abandon()` 72 epochs after the next tranche's gate; remaining funds plus
  the bond become refundable. Backers are never locked in by a silent
  creator.
- **The promise is stored, not enforced.** The creator's promise text lives
  on-chain and is shown on the campaign card, labelled as the creator's
  promise. The template cannot verify that a human kept a promise — claiming
  otherwise would be dishonest. The enforcement is economic: tranches and the
  bond, not words.
- **Authorization in code, not in resource rules.** Methods are `allow_all` at
  the access-rule layer; `claim`/`refund`/`veto`/`claim_bond` check the
  transaction signer against the recorded creator/pledge keys inside the
  method. The template creates no resource (the vaults hold TARI, the system
  resource), so there are no owner-bypassable resource rules to get wrong — the known trap where a
  resource owner bypasses its own rules cannot apply here.
- **Overfunding is allowed.** The total may exceed the goal; tranches are
  computed from the pledged total, so the creator releases everything pledged
  across the three tranches. This is tested, not accidental.
- **Small on purpose.** One component, two vaults, two maps. The release WASM
  is 157.1 KiB, well under the 1 MiB cap (see Verification).

## Build + test the template

Prerequisites: Rust via rustup, plus the WASM target:

```sh
rustup target add wasm32-unknown-unknown
```

Run the engine tests (the harness compiles the template to WASM and runs real
engine transactions in-process — no network, funds, or faucet needed):

```sh
cargo test
```

52 tests cover: the v1 behaviors kept intact (creation state + event, pledge
accumulation, the `Funded` event firing exactly once, the deadline boundary
both ways, early-claim rejection, non-creator-claim rejection, claim
semantics updated to tranches, claim-on-missed-goal rejection, full refunds
to every backer, double-refund rejection, refund-after-success rejection,
pre-deadline-refund rejection, creation input validation including the
title and promise length limits both ways, non-TARI pledge rejection (proven
with a test-only token template — see Project structure), zero-amount pledge
rejection, and post-settlement pledge rejection), plus every v2 rule and
edge case: the tranche schedule and gates, tranche amounts including the
remainder rule, veto below/at/above the 50% threshold (exactly 50% fails),
veto tally reset on release, veto after a tranche released, veto by a
non-backer, double veto, veto with no pledge, abandonment timing and its
anyone-may-call rule, bond minimum and overpayment, bond return on failure
and on completion, bond forfeit on veto and abandonment, pro-rata refunds
with bond shares including the last-refunder dust rule, vault + bond vault
balance reconciliation on every path, and the zero-pledge and
pledge-after-success rejections. Every assert in the template is exercised.

Build the release WASM:

```sh
cargo build --target wasm32-unknown-unknown --release
ls -la target/wasm32-unknown-unknown/release/tari_crowdfund.wasm
```

### Version pins

Pinned 2026-11-15 to the latest on crates.io, matching the official
`wasm-template` scaffold at HEAD (commit `672a25e`, "Tari Ootle 0.53 /
template_lib 0.40"):

| Crate | Pinned version |
|---|---|
| `tari_template_lib` | `=0.40.1` |
| `tari_template_test_tooling` | `=0.53.4` |

The full resolved tree is in `Cargo.lock` (committed). Tari versions churn
fast; if the network upgrades before judging, re-pin and re-run `cargo test`
before republishing anything.

## Test the simulation

The browser simulation (`app/sim.js`) is parity-tested against the same
scenarios as the engine tests — same outcomes, same rejection messages:

```sh
node --test app/sim.test.mjs
```

46 tests, no dependencies (Node ≥ 20). The UI wiring (real `index.html` +
`app.js`, full walkthrough clicks) was additionally verified end-to-end in
headless Chromium during development — real clicks through the 16-step
walkthrough, desktop + mobile viewports, zero console/page errors; that
harness is dev-only and not shipped.

## Verification (as built 2026-11-15, Rust 1.100.0, Node 24)

```text
$ cargo test
test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured
  (plus 0 lib/doc tests; the 52 engine tests run the real engine in-process)

$ node --test app/sim.test.mjs
tests 46, pass 46, fail 0

$ cargo build --target wasm32-unknown-unknown --release
tari_crowdfund.wasm: 160,863 bytes (157.1 KiB, 15.3% of the 1 MiB cap)
SHA-256 aa3bda5fb45e43f63162aa6ed90f19f9de46509dfe822eabed7972324d18dce8
(clean-copy offline rebuild produces the identical hash)

$ cargo clippy --all-targets
clean — no warnings for this crate

$ cargo fmt --check
clean
```

The demo page was also served locally and exercised end-to-end in headless
Chromium with real clicks through the full 16-step walkthrough — 249
assertions covering promise display, tranche states and amounts (including
the undetermined-before-funding state), the live veto tally and threshold
behavior just below and just above 50%, veto → refund + forfeit flows, the
abandonment path, bond return on failure and on completion, walkthrough
completion, history/block coverage of the new calls, step tracking and the
progress counter, exact rejection messages (now surfaced on the campaign
card as well as in History), wallet balances, the disabled time-travel
button, reset, the never-pledged refund precision case, the create-campaign
form (including the promise field, the live bond requirement, and its
rejections), pledge input validation, status-dot states, progress-bar
values, the app-first section order, the collapsible walkthrough/limits
sections, the splash screen, the section navigation and mobile menu, the
entry cards, the Proof section, the transaction history (hash format,
determinism across a reset, epoch grouping) and the block view (sibling
navigation, close paths, focus return), and layout checks (no horizontal
overflow, card stacking, tap-target sizes) — in desktop (1280px) and mobile
(390px) viewports, with zero console/page errors. All assertions passed. A
separate contrast check measured 21 text/background pairs in driven states
(including every new v2 element) against WCAG AA (all ≥ 4.5:1). The UI was
redesigned three times on 2026-11-15 (same rules, same hooks; the third pass
carries the official Tari identity, a splash screen, section navigation,
entry cards, and the history/block view); the harness was re-run against the
shipped bytes after every pass, and the v2 mechanism pass kept the design
system unchanged.

## Project structure

```
Cargo.toml            template crate (pinned deps, size-optimized release profile)
src/lib.rs            CrowdfundCampaign template (the whole on-chain logic)
tests/test.rs         52 engine tests (real engine, in-process)
tests/fixtures/test_token/  test-only template minting a non-TARI token, so
                      the pledge TARI-only check is engine-tested; never
                      published, never part of the submission template
template.toml         template metadata
docs/MECHANISM-V2.md  mechanism spec: parameters, threat model, edge cases,
                      honest limits
SUBMISSION.md         contest submission text
app/
  index.html          demo page: splash, navigation, entry cards, workspace,
                      campaigns, history + block view, About, Proof,
                      walkthrough, honest limits
  app.js              demo harness: wallets, epoch control, transaction
                      history + block view, checklist
  sim.js              faithful simulation of the template state machine
  sim.test.mjs        parity tests: sim vs template rules
  live.js             live-mode STUB: wallet detection + honest status only
  style.css
  tari-mark.svg       official Tari gem mark, vendored (see Brand assets)
LICENSE               MIT
```

## Brand assets

The Tari gem mark used in the splash screen and the top-bar lockup is the
official Tari design mark: the path data is copied verbatim and unaltered
from the wordmark SVG served by tari.com itself, and the violet (`#813BF5`)
and lime (`#c2ff28` on violet-black `#160c25`) come from tari.com and the
Ootle docs (ootle.tari.com). No public brand kit exists — the live site's
inline SVG is the authoritative current vector asset. Use is descriptive
only ("Built on Tari Ootle"): the mark is never altered and never presented
as this project's own logo. Full source notes live in the `tari-mark.svg`
file header. The layout, copy, and composition of the demo are original.

## Honest limits

- **No code can force a human to work.** The mechanism limits loss and gives
  backers control; it cannot verify real-world delivery and cannot claw back
  released funds. A creator who takes tranche 1 and vanishes keeps tranche
  1. What v2 guarantees is that the loss is bounded to released tranches,
  that the bond compensates backers on veto or abandonment, and that
  unreleased funds stay under backer control.
- **The promise is not enforced.** The promise text is the creator's words,
  stored on-chain, labelled as such. The template cannot check whether a
  radio station was built. Backers judge the promise; the veto is their
  enforcement tool.
- **Minority backers are not protected against majority apathy.** A veto
  needs strictly more than 50% of pledged value. If most backers never act,
  releases proceed. Apathy is consent — that is the stated rule, not a
  hidden flaw.
- **The bond prices dishonesty; it does not prevent it.** A wealthy bad
  actor can afford to lose bonds. The bond raises the cost of every attempt
  and makes mass scam campaigns unprofitable at small scales; it is not a
  guarantee of good behavior.
- **Parameters are protocol constants**, chosen and justified in
  `docs/MECHANISM-V2.md` §2, not tuned to live TARI prices or real campaign
  data. A production deployment would revisit the bond fraction, the window
  lengths, and the tranche count with real usage data.
- **Not published.** No template has been published to Esmeralda or mainnet
  and no on-chain state exists. The submission is the template + engine
  tests + simulation. Publishing is a separate, funded step (publish fees
  are size-priced; the faucet is frequently dry) and is not claimed here.
- **Live mode is a stub.** `app/live.js` only detects a `window.tari`
  provider and reports status. It never prompts, signs, or submits. Wiring
  a real live path needs a published template address plus testing against
  a real wallet; that work is documented in `live.js` and explicitly not
  done.
- **Pledge amounts are public.** Vault accounting means pledge amounts and
  backer keys are visible on-chain. This is a deliberate choice, stated in
  the UI — not a privacy claim. A confidential/stealth variant would hide
  amounts and is future work, not v2.
- **All-or-nothing funding only.** No partial refunds, no platform fee, no
  campaign discovery beyond direct links. Campaign discovery on-chain would
  need indexer event/state queries and is future work.
- **Epochs are coarse on real networks** (~20 min mainnet, ~1 h Esmeralda),
  so real campaigns and veto windows run for days. The demo's epoch control
  exists only to make the story judgeable in minutes.
- **Non-TARI rejection is engine-tested.** The `pledge` TARI-only check is
  proven by an engine test that pays a campaign with a different fungible
  token, minted by the test-only fixture template in
  `tests/fixtures/test_token/`. Every assert in the template is exercised
  by the engine suite.
- **Simulation differences.** The sim has no buckets/resources (so no
  resource-type check) and uses persona ids instead of public keys. Everything
  else — rules, check order, messages — matches, and the parity tests prove it.

## Stretch ideas (not built, not claimed)

- Confidential-resource variant hiding individual pledge amounts.
- Live mode: publish to Esmeralda, `window.tari` integration, indexer-based
  campaign discovery.
- Creator-set platform fee (would change the no-cut promise — only with a
  clear UI story).
- Campaign metadata beyond the title and promise (description hash, image
  link).
- Parameter governance: bond fraction and window lengths set per campaign
  within protocol bounds, instead of fixed constants.

## License

MIT — see `LICENSE`.
