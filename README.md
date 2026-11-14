# Ootle Crowdfund

All-or-nothing crowdfunding on Tari Ootle. A creator sets a funding goal and an
epoch deadline; backers pledge TARI into a vault. Goal met by the deadline →
the creator claims the whole vault. Goal missed → every backer refunds in full.
No platform cut, no custody beyond the template, no accounts.

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
5. Advance the epoch to 5 (the deadline).
6. Claim as Rani — the full vault pays out.
7. Switch to Bima and **Refund** *Neighborhood mural* — full repayment.
8. Refund again — rejected (double refund).
9. Try refunding *Community radio* — rejected (refunds closed after success).

The activity log maps every click to the template call it mirrors, and shows
rejections with the exact message the template would panic with on-chain.

## The template

`src/lib.rs` — `CrowdfundCampaign`, one campaign per component.

| Call | Who | When | Effect |
|---|---|---|---|
| `new(title, goal, deadline_epoch)` | anyone (becomes creator) | deadline must be in the future | Opens the campaign, empty TARI vault |
| `pledge(bucket)` | anyone | `current_epoch < deadline_epoch` | Deposits TARI, records the backer; amounts accumulate |
| `claim() -> Bucket` | creator only | `current_epoch >= deadline_epoch` and goal met | Pays the whole vault out, once |
| `refund() -> Bucket` | any backer | `current_epoch >= deadline_epoch` and goal missed | Repays the caller's full pledge, once |
| getters | anyone | anytime | `goal`, `deadline_epoch`, `title`, `creator`, `total_pledged`, `pledge_count`, `is_claimed`, `is_funded`, `my_pledge` |

Events (indexable): `CampaignCreated`, `Pledged`, `Funded` (fires once, when
the total first reaches the goal), `Claimed`, `Refunded`.

### Design decisions

- **Epoch deadlines, with a tested boundary.** Pledges are accepted while
  `current_epoch < deadline_epoch`; settlement opens at `current_epoch >=
  deadline_epoch`. Both sides of the boundary are covered by engine tests using
  epoch overrides.
- **One outcome, enforced.** After the deadline, `claim` requires the goal to
  be met and `refund` requires it to be missed, so the two paths are mutually
  exclusive. `claimed` is set before the vault pays out, and a backer's ledger
  entry is removed before their refund pays out — no double-claim, no
  double-refund, on any path.
- **Authorization in code, not in resource rules.** Methods are `allow_all` at
  the access-rule layer; `claim`/`refund` check the transaction signer against
  the recorded creator/pledge keys inside the method. The template creates no
  resource (the vault holds TARI, the system resource), so there are no
  owner-bypassable resource rules to get wrong — the known trap where a
  resource owner bypasses its own rules cannot apply here.
- **Overfunding is allowed.** The total may exceed the goal; the creator claims
  everything pledged. This is tested, not accidental.
- **Small on purpose.** One component, one vault, one map. The release WASM is
  136.8 KiB, well under the 1 MiB cap (see Verification).

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

15 tests cover: creation state + event, pledge accumulation, the `Funded`
event firing exactly once, the deadline boundary both ways, early-claim
rejection, non-creator-claim rejection, claim-on-success paying exactly once,
claim-on-missed-goal rejection, full refunds to every backer, double-refund
rejection, refund-after-success rejection (before and after claim),
pre-deadline-refund rejection, creation input validation (including the
120-character title limit both ways), non-TARI pledge rejection (proven with
a test-only token template — see Project structure), zero-amount pledge
rejection, and post-claim pledge rejection. Every assert in the template is
exercised.

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

14 tests, no dependencies (Node ≥ 20). The UI wiring (real `index.html` +
`app.js`, full walkthrough clicks) was additionally verified end-to-end in
headless Chromium during development — real clicks through the 9-step
walkthrough, desktop + mobile viewports, zero console/page errors; that
harness is dev-only and not shipped.

## Verification (as built 2026-11-15, Rust 1.100.0, Node 24)

```text
$ cargo test
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured
  (plus 0 lib/doc tests; the 15 engine tests run the real engine in-process)

$ node --test app/sim.test.mjs
tests 14, pass 14, fail 0

$ cargo build --target wasm32-unknown-unknown --release
tari_crowdfund.wasm: 140,088 bytes (136.8 KiB, 13.4% of the 1 MiB cap)

$ cargo clippy --all-targets
clean — no warnings for this crate

$ cargo fmt --check
clean
```

The demo page was also served locally (`python3 -m http.server`) and exercised
end-to-end in headless Chromium with real clicks through the full 9-step
walkthrough — 88 assertions covering step tracking and the progress counter,
exact rejection messages, wallet balances, the disabled time-travel button,
reset, the never-pledged refund precision case, the create-campaign form
(including its zero-goal rejection), pledge input validation, status-dot
states, progress-bar values, the app-first section order, the collapsible
walkthrough/limits sections, and layout checks (no horizontal overflow,
card stacking, tap-target sizes) — in desktop (1280px) and mobile (390px)
viewports, with zero console/page errors. All assertions passed. A separate
contrast check verified 20 text/background pairs from the shipped CSS
against WCAG AA (all ≥ 4.5:1). The UI was redesigned twice on 2026-11-15
(same rules, same copy, same hooks; the second pass is an original light
identity — bright paper, rust accent, grotesque display type); the harness
was re-run against the redesigned bytes.

## Project structure

```
Cargo.toml            template crate (pinned deps, size-optimized release profile)
src/lib.rs            CrowdfundCampaign template (the whole on-chain logic)
tests/test.rs         15 engine tests (real engine, in-process)
tests/fixtures/test_token/  test-only template minting a non-TARI token, so
                      the pledge TARI-only check is engine-tested; never
                      published, never part of the submission template
template.toml         template metadata
app/
  index.html          demo page (simulation-first, judge walkthrough)
  app.js              demo harness: wallets, epoch control, log, checklist
  sim.js              faithful simulation of the template state machine
  sim.test.mjs        parity tests: sim vs template rules
  live.js             live-mode STUB: wallet detection + honest status only
  style.css
LICENSE               MIT
SUBMISSION.md         draft contest submission text (links TBD)
```

## Honest limits

- **Not published.** No template has been published to Esmeralda or mainnet and
  no on-chain state exists. The submission is the template + engine tests +
  simulation. Publishing is a separate, funded step (publish fees are
  size-priced; the faucet is frequently dry) and is not claimed here.
- **Live mode is a stub.** `app/live.js` only detects a `window.tari` provider
  and reports status. It never prompts, signs, or submits. Wiring a real live
  path needs a published template address plus testing against a real wallet;
  that work is documented in `live.js` and explicitly not done.
- **Pledge amounts are public.** Vault accounting means pledge amounts and
  backer keys are visible on-chain. This is a deliberate v1 choice, stated in
  the UI — not a privacy claim. A confidential/stealth variant would hide
  amounts and is future work, not v1.
- **All-or-nothing only.** No partial refunds, no milestone payouts, no
  platform fee, no campaign discovery beyond direct links. Campaign discovery
  on-chain would need indexer event/state queries and is future work.
- **Epochs are coarse on real networks** (~20 min mainnet, ~1 h Esmeralda), so
  real campaigns run for days. The demo's epoch control exists only to make
  the story judgeable in minutes.
- **Non-TARI rejection is engine-tested.** The `pledge` TARI-only check is
  proven by an engine test that pays a campaign with a different fungible
  token, minted by the test-only fixture template in
  `tests/fixtures/test_token/`. Every assert in the template is exercised by
  the engine suite; the one guard that needs a harness epoch rewind to reach
  (pledging after a claim) is documented as such in the test.
- **Simulation differences.** The sim has no buckets/resources (so no
  resource-type check) and uses persona ids instead of public keys. Everything
  else — rules, check order, messages — matches, and the parity tests prove it.

## Stretch ideas (not built, not claimed)

- Confidential-resource variant hiding individual pledge amounts.
- Live mode: publish to Esmeralda, `window.tari` integration, indexer-based
  campaign discovery.
- Creator-set platform fee or milestone payouts (would change the
  all-or-nothing promise — only with a clear UI story).
- Campaign metadata beyond the title (description hash, image link).

## License

MIT — see `LICENSE`.
