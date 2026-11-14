# Mechanism v2 — backer protection: creator bond + staged release + pledge-weighted veto

Status: SPECIFICATION. This document is the single source of truth for v2.
The Rust template (`src/lib.rs`), the browser simulation (`app/sim.js`), the
parity suite (`app/sim.test.mjs`), the engine tests (`tests/test.rs`), and the
demo UI must all implement exactly what is written here. Any deviation must be
reported to the coordinator, never silently introduced.

## 1. The problem v2 answers

In v1, once a campaign's goal was met and the creator claimed, backers had no
recourse if the creator never delivered. Their pledges were a one-way gift:
the template guaranteed the money flow, not the promise. Worse, address-based
reputation cannot fix this: a dishonest creator can abandon an address, make a
fresh account, and run the same campaign again at zero cost.

v2 answers with economics, not reputation:

1. **Every campaign costs the creator something real.** The creator locks
   their own TARI as a bond at creation. A fresh account does not escape this:
   every campaign requires a fresh bond.
2. **Backers keep control over funds not yet released.** Pledged funds are
   released in tranches. Later tranches release only if backers do not veto,
   and a successful veto returns the remaining funds (plus the forfeited bond)
   to backers.
3. **The creator's promise is on the record.** Every campaign carries the
   creator's promise text — what backers get — stored on-chain and shown on
   the campaign card. It is labeled as the creator's promise and is NOT
   enforced by the template. The enforcement is economic (bond + staged
   release), never a claim that code can verify real-world delivery.

What v2 does NOT change: the funding phase stays exactly all-or-nothing
(goal missed by the deadline → every backer refunds in full, once), and all
v1 authorization rules stay (creator-only claim actions, per-backer one-time
full refund on failure, signer checks, non-TARI rejection).

## 2. Parameters (every number justified)

| Parameter | Value | Justification |
|---|---|---|
| `TRANCHE_COUNT` | 3 | Few enough to keep the story simple and the demo completable; enough that no single release dominates. Two tranches would put half the funds at risk in the first release; four or more would drag honest creators through too many gates. |
| Tranche sizes | Equal thirds of `pledged_total`; remainder to tranche 3 | Symmetric exposure: the creator's incentive is uniform across gates — no big early payday to run with. Equal division gives exact integer accounting (floor for tranches 1–2, remainder to 3, sum is exactly `pledged_total`, zero dust). Simpler to explain than weighted splits, and simpler is more auditable. |
| `VETO_WINDOW_EPOCHS` | 72 | The minimum deliberation period between releases. On mainnet (~20 min/epoch) 72 epochs ≈ 24 hours: backers are humans across time zones, and a full day is the minimum credible window to notice and act. Shorter would let releases slip past inattentive backers; longer would starve honest creators. On Esmeralda (~1 h/epoch) the same constant is ~3 days — slower, but the same rule. |
| Tranche gates | Tranche `k` (1-based) claimable at epoch ≥ `deadline_epoch + (k-1) * 72` | Tranche 1 releases at funding success (the deadline itself); each later tranche waits one full veto window after the previous gate. The window is a MINIMUM: veto stays open until the tranche is actually released (see §4), so the gate never silently extinguishes backer control. |
| Veto threshold | Strictly more than 50% of pledged value | Majority rule, pledge-weighted. Strictly greater (not ≥): an exact 50/50 split must NOT kill a campaign — the burden of action is on the objectors. Implemented without multiplication as `veto_total > pledged_total - veto_total` (exact, overflow-free). |
| Bond | `max(goal / 10, 100)` (floor division) | 10% of the goal: material enough to hurt a scammer running many campaigns (ten scam campaigns cost a full goal's worth of bonds), small enough that an honest creator can fund it from their own stake. The 100-unit floor keeps tiny-goal spam nearly-free no more: a goal of 50 would otherwise need a bond of 5. 100 units equals 10% of the smallest realistic 1,000-unit campaign. The bond is a FLOOR, not a fixed price: a creator may deposit more, and the whole deposit becomes the bond (voluntary over-bonding is a trust signal). Crucially, the bond costs an honest creator only lockup (it returns on honest completion or honest failure) while it costs a dishonest creator the full amount. |
| `ABANDON_EPOCHS` | 72 past the next tranche's gate | Symmetric with the veto window: the creator gets one full extra window of grace past the gate before inaction is read as abandonment. Shorter would punish creators for ordinary delays; longer would strand backer funds. |
| `MAX_PROMISE_CHARS` | 280 | One short paragraph — enough for a real offer ("name in credits, early access, invite to launch day"), bounded so component state stays small and the card stays scannable. The promise is REQUIRED (non-empty): an empty offer is not an offer; a creator who offers nothing must say so in words ("nothing but the project itself"). |
| Veto tally reset | On each tranche release | Each release is a fresh decision point. Stale objections from an earlier stage must not silently kill a later stage after the creator demonstrably earned the release. Backers who still object vote again. |

## 3. State

Additions to the v1 `CrowdfundCampaign` component (v1 fields unchanged
unless noted):

```text
promise: String                 // creator's promise, 1..=280 chars, stored on-chain
bond_vault: Vault               // holds ONLY the creator's bond (TARI)
bond_amount: Amount             // the deposited bond (>= required bond)
bond_claimed: bool              // true once the bond has returned to the creator
pledged_total: Amount           // accumulator: total ever pledged. NEVER decreases.
                                // Refunds do not touch it. This is the stable
                                // denominator for vetoes, tranches, and pro-rata
                                // refunds. (v1's total_pledged was the vault
                                // balance; in v2 the vault balance drops as
                                // tranches release, so the accumulator is the
                                // only stable total.)
tranches_released: u32          // 0..=3
vetoed: bool
abandoned: bool
vetoers: HashMap<key, Amount>   // current window: vetoer -> their pledge weight
veto_total: Amount              // current window total
refund_pool: Amount             // snapshot of the vault balance at veto/abandon
                                // success; the pool pro-rata refunds draw from
```

Removed: the v1 `claimed: bool`. "Fully claimed" is now derived:
`tranches_released == TRANCHE_COUNT`. The `is_claimed` getter keeps its name
and returns this derived value (meaning: all tranches released).

Invariants (every test must reconcile these):

- `vault.balance() + released_so_far == pledged_total - refunded_so_far`
  (pledge vault: every unit is either still escrowed, released to the
  creator, or refunded).
- `bond_vault.balance() + bond_returned_or_distributed == bond_amount`.
- `veto_total <= pledged_total` always (veto weights are pledges).
- `pledged_total` never decreases; `sum(pledges.values()) <= pledged_total`,
  with equality until the first refund removes a ledger entry.
- Tranche amounts sum to exactly `pledged_total` (remainder to tranche 3).
- After veto/abandonment, `refund_pool` plus already-refunded vault shares
  equals the vault balance at the moment of veto/abandonment.

## 4. Methods

Check order matters: the simulation mirrors it exactly, and tests assert the
exact rejection message for each guard. Messages are normative — copy them
verbatim.

### 4.1 `new(title, promise, goal, deadline_epoch, bond: Bucket) -> Component`

Check order:

1. Title non-empty → `Campaign title must not be empty`
2. Title ≤ 120 chars → `Campaign title is too long`
3. Promise non-empty → `Campaign promise must not be empty`
4. Promise ≤ 280 chars → `Campaign promise is too long`
5. Goal > 0 → `Funding goal must be greater than zero`
6. Deadline strictly in the future → `Deadline epoch must be in the future`
7. Bond is TARI → `Bond must be paid in TARI`
8. Bond ≥ `max(goal/10, 100)` → `Creator bond is below the required minimum`

Effects: deposit the WHOLE bond bucket into `bond_vault`;
`bond_amount = deposited amount` (overpayment becomes a larger bond, by
design). Emit `CampaignCreated` (see §6). Access rules: all methods
`allow_all` as in v1 — authorization stays enforced in code by signer
checks. Add the new methods and getters to the access-rules list.

### 4.2 `pledge(payment: Bucket)`

Unchanged from v1, plus the accumulator and release guards. Check order:

1. Payment is TARI → `Pledges must be paid in TARI`
2. Amount > 0 → `Pledge must be greater than zero`
3. Epoch < deadline → `Campaign deadline has passed`
4. `tranches_released == 0` → `Campaign funds have already been released`
   (v1 message was "…already been claimed"; the v2 message reflects staged
   release. This guard also covers the harness-epoch-rewind case.)
5. Not vetoed → `Campaign was vetoed; pledges are closed`
6. Not abandoned → `Campaign was abandoned; pledges are closed`

Effects: accumulate the backer's ledger entry, deposit into the vault,
`pledged_total += amount`. `Funded` fires exactly once when the vault
balance first reaches the goal (unchanged from v1; during the funding phase
vault balance equals `pledged_total`).

### 4.3 `claim() -> Bucket` — releases the NEXT tranche

Creator-only, one tranche per call. Check order:

1. Caller is creator → `Only the campaign creator can claim the funds`
2. Not vetoed → `Campaign was vetoed; remaining funds are refundable to backers`
3. Not abandoned → `Campaign was abandoned; remaining funds are refundable to backers`
4. `tranches_released < 3` → `Campaign funds have already been claimed`
5. Epoch ≥ deadline → `Campaign deadline has not been reached`
6. `pledged_total >= goal` → `Funding goal was not met; backers may refund instead`
7. Epoch ≥ next gate (`deadline + tranches_released * 72`) →
   `The next release has not opened yet`

Effects (in this order): compute the tranche amount; increment
`tranches_released`; CLEAR the veto tally (`vetoers`, `veto_total`) — a
release is a fresh decision point; withdraw the tranche from the vault;
emit `TrancheReleased`; if this was tranche 3, emit `CampaignCompleted`.

Tranche amount: `base = pledged_total / 3` (floor division). Tranches 1–2
pay `base`; tranche 3 pays `pledged_total - 2 * base` (the remainder).
The sum of the three tranches is exactly `pledged_total`.

### 4.4 `veto()`

Any backer with a pledge may veto the pending release. Check order:

1. Epoch ≥ deadline → `Veto opens after the campaign deadline`
2. Not already vetoed → `Campaign was already vetoed`
3. Not abandoned → `Campaign was abandoned; veto is closed`
4. `tranches_released < 3` → `Campaign is complete; veto is closed`
5. `pledged_total >= goal` → `Campaign did not reach its goal; refunds are already open`
6. Caller has a pledge > 0 → `No pledge to veto with for this backer`
7. Caller has not vetoed in this window → `Backer has already vetoed this release`

Effects: record the caller's weight (their current ledger pledge) in
`vetoers`; `veto_total += weight`; emit `VetoCast`. Then evaluate the
threshold EAGERLY: if `veto_total > pledged_total - veto_total`, the veto
succeeds immediately — set `vetoed = true`, snapshot
`refund_pool = vault.balance()`, emit `VetoSucceeded` and `BondForfeited`.

Notes:

- Veto is open from the deadline until each tranche is actually released.
  A successful veto freezes ALL unreleased tranches, including tranche 1
  if the creator has not claimed it yet. "Tranche 1 releases at funding
  success" means it is CLAIMABLE at funding success, not auto-released.
- A veto after a tranche released affects only FUTURE tranches: released
  funds are never clawed back (no code can do that — see §8).
- The creator may veto too, if they pledged: vetoing forfeits their own
  bond to the other backers pro-rata, so it is self-harm, not an exploit.
  No identity exception is needed.
- A veto at exactly 50% FAILS (strict majority). The tally stays recorded;
  further vetoes in the same window can still push it over.

### 4.5 `abandon()`

Callable by ANYONE — the trigger condition is fully objective
(epoch-based), so the caller identity is irrelevant, and restricting the
caller would only add a failure mode where no backer bothers to call it.
Check order:

1. Not vetoed → `Campaign was already vetoed`
2. Not abandoned → `Campaign was already abandoned`
3. `tranches_released < 3` → `Campaign is complete; abandonment is closed`
4. `pledged_total >= goal` → `Campaign did not reach its goal; refunds are already open`
5. Epoch ≥ `deadline + tranches_released * 72 + 72` →
   `Creator has not abandoned the campaign yet`

Effects: set `abandoned = true`, snapshot `refund_pool = vault.balance()`,
emit `Abandoned` and `BondForfeited`. Remaining vault funds and the bond
become refundable pro-rata exactly as after a veto (§4.6).

### 4.6 `refund() -> Bucket`

Check order:

1. Epoch ≥ deadline → `Refunds open after the campaign deadline`
2. Not complete (`tranches_released < 3`) →
   `Campaign funds were claimed; refunds are closed`
3. If vetoed OR abandoned → PRO-RATA PATH (below). Otherwise:
4. `pledged_total < goal` → `Campaign reached its goal; refunds are closed`
5. Caller has a pledge → `No pledge to refund for this backer`
   (ledger entry removed BEFORE payout, as in v1)
6. Pay the full pledge from the vault; emit `Refunded` with `bond_share = 0`.

Pro-rata path (vetoed or abandoned). The vault no longer holds every
pledge in full (tranches may have released), so each backer receives
their share of what remains, plus their share of the forfeited bond:

- `vault_share = pledge * refund_pool / pledged_total` (floor division)
- `bond_share = pledge * bond_amount / pledged_total` (floor division)
- The LAST refunder (the call that empties the ledger map) receives the
  ENTIRE remaining balance of both vaults — their computed shares plus all
  rounding dust. This guarantees both vaults reconcile to exactly zero
  when every backer has refunded, and no dust is ever stranded by
  rounding. (If a backer never refunds, their share simply stays in the
  vaults — unclaimed, not leaked: vault balances always equal the sum of
  unclaimed entitlements.)
- Ledger entry removed BEFORE payout (double-refund impossible).
- Payment technique: withdraw the bond share from `bond_vault`, deposit
  it into the pledge vault, then withdraw `vault_share + bond_share` as a
  single bucket. (This uses only withdraw/deposit primitives; if the
  Bucket API offers merging, either approach is acceptable — the
  observable behavior must match this spec.)
- Emit `Refunded` with the total `amount` paid and the `bond_share`
  portion, so indexers can separate the two.

Arithmetic: shares are computed in u128 (`pledge * pool / total`, floor).
Overflow is unreachable for realistic supplies; use checked arithmetic
and panic with a clear message if it ever occurs. The simulation uses
BigInt and the same floor-division formulas; parity tests prove identical
results, including remainder cases.

### 4.7 `claim_bond() -> Bucket`

Returns the bond to the creator. Check order:

1. Caller is creator → `Only the campaign creator can claim the bond`
2. Not already claimed → `Bond has already been claimed`
3. Not vetoed → `Bond was forfeited to backers`
4. Not abandoned → `Bond was forfeited to backers`
5. Epoch ≥ deadline → `Bond is locked until the campaign deadline`
6. Campaign failed (`pledged_total < goal`) OR complete
   (`tranches_released == 3`) → otherwise
   `Bond is locked until all releases complete`

Effects: set `bond_claimed = true` BEFORE the transfer; withdraw the whole
bond vault; emit `BondReturned`.

## 5. Getters (all `allow_all`, read-only)

v1 getters, with v2 semantics noted:

| Getter | Returns |
|---|---|
| `goal()` | goal |
| `deadline_epoch()` | deadline |
| `title()` | title |
| `creator()` | creator key |
| `total_pledged()` | `pledged_total` (total EVER pledged; stable — CHANGED from v1's vault balance, which drops as tranches release) |
| `pledge_count()` | live ledger size (shrinks as refunds remove entries, as in v1) |
| `is_claimed()` | `tranches_released == 3` (fully claimed; CHANGED meaning, same name) |
| `is_funded()` | `pledged_total >= goal` (stable — CHANGED from vault-balance basis) |
| `my_pledge()` | caller's ledger pledge, else 0 |

New getters:

| Getter | Returns |
|---|---|
| `promise()` | promise text |
| `bond_amount()` | deposited bond |
| `required_bond()` | `max(goal / 10, 100)` |
| `bond_balance()` | current bond-vault balance |
| `vault_balance()` | current pledge-vault balance |
| `tranches_released()` | 0..=3 |
| `next_tranche_epoch()` | `deadline + tranches_released * 72` |
| `is_vetoed()` | `vetoed` |
| `is_abandoned()` | `abandoned` |
| `veto_total()` | current-window veto tally |
| `my_veto()` | caller's recorded veto weight this window, else 0 |

## 6. Events

Topics carry the `CrowdfundCampaign.` prefix (as in v1).

| Event | Payload | When |
|---|---|---|
| `CampaignCreated` | creator, title, promise, goal, deadline_epoch, bond | creation |
| `Pledged` | backer, amount, total_pledged | every pledge |
| `Funded` | goal, total_pledged | once, when the total first reaches the goal |
| `TrancheReleased` | tranche (1-based), amount | every `claim()` (REPLACES v1's `Claimed`) |
| `CampaignCompleted` | total_released | tranche 3 releases |
| `VetoCast` | backer, weight, veto_total | every `veto()` |
| `VetoSucceeded` | veto_total, pledged_total | threshold crossed |
| `Abandoned` | unreleased, bond_forfeited | `abandon()` succeeds |
| `BondForfeited` | amount | veto success or abandonment |
| `BondReturned` | creator, amount | `claim_bond()` succeeds |
| `Refunded` | backer, amount, bond_share | every `refund()` (`bond_share` is 0 on the failure path) |

## 7. State machine

```text
                        epoch >= deadline
   OPEN  ─────────────────────────────────► SETTLED
     │                                        │
     │ pledges open                           ├─ pledged_total < goal ──► FAILED
     │                                        │   refunds open (full),
     │                                        │   bond returnable
     │                                        └─ pledged_total >= goal ──► RELEASING
     │                                                                  │
     │                                          claim() at each gate   │
     │                                          (veto open until        │
     │                                           each release)          │
     │                                               │                  │
     │                         ┌─────────────────────┼──────────────────┐
     │                         ▼                     ▼                  ▼
     │                    COMPLETED              VETOED            ABANDONED
     │                    (3 tranches,          (>50% veto,       (creator silent
     │                     bond returnable)      refunds pro-rata  72 epochs past
     │                                           + bond shares)   a gate; same
     │                                                              refund path)
     └─ (pledge/veto/abandon/claim guards above keep every transition legal;
        no transition exists from any terminal state except refunds/bond return)
```

## 8. Threat model

- **Fresh-account Sybil (the critique that motivated v2).** A dishonest
  creator's cost is per-campaign, not per-identity: EVERY campaign
  requires a fresh bond, and a fresh account starts with no reputation to
  spend — the bond IS the reputation, in money. Abandoning an address
  forfeits nothing already spent, but the next campaign costs a new bond
  and the previous bond is gone (forfeited on veto/abandonment, or
  returned only on honest completion/failure). Reputation is never
  consulted anywhere in the template.
- **Veto gaming.** Veto power is pledge-weighted, so fresh Sybil accounts
  with no stake have no voice — and cannot fake support either. A Sybil
  army can only veto by pledging >50% of the value, i.e. by funding the
  campaign itself: self-defeating. A whale backer CAN veto unilaterally
  if they hold >50% — that is majority rule by design, and they cannot
  steal: refunds are pro-rata, never winner-take-all, so a vetoing whale
  recovers only their own share plus their bond share.
- **Creator self-pledge + veto.** The creator pledging to their own
  campaign then vetoing forfeits their own bond to the other backers.
  Net loss. No exploit; no identity exception needed.
- **Veto at exactly 50%.** Fails (strict majority). No state change
  except the recorded vote; the tally persists for the window.
- **Creator abandonment.** `abandon()` gives backers a permissionless path
  to remaining funds + bond after a defined epoch. No backer action is
  needed to "activate" it beyond one call by anyone.
- **Griefing.** Dust pledges carry dust veto weight. Veto/claim/refund
  calls cost gas on a real network (not modeled in the demo). A backer
  cannot block a release without majority stake, and cannot double-vote
  (one veto per backer per window, enforced by the `vetoers` map).
- **Front-running / ordering.** All gates are epoch-based; within an
  epoch, veto evaluation is eager per call, so no ordering games change
  the outcome: the first call that crosses the threshold decides.
- **Overfunding.** Tranches are computed on `pledged_total`, so
  overfunding flows to the creator proportionally — as in v1, where the
  creator claimed everything pledged. Documented, not accidental.
- **Double-pay / re-entrancy.** Every payout sets its one-time flag or
  removes the ledger entry BEFORE the outward transfer (claimed flags,
  `bond_claimed`, ledger removal, tranche counter increment). The
  template model has no callbacks; the ordering discipline is kept
  anyway so the logic is auditable.
- **Rounding / dust.** All divisions floor; remainders go to tranche 3
  and to the last refunder. Vaults reconcile to exactly zero when every
  entitlement is claimed (proven in tests).

## 9. Edge-case table (each MUST have an engine test AND a parity test)

| # | Case | Expected |
|---|---|---|
| E1 | Veto at exactly 50% of pledged value | Rejected as unsuccessful: vote recorded, `vetoed` stays false, releases continue |
| E2 | Veto at 50% + 1 unit | Succeeds immediately; remaining tranches frozen; refunds + bond shares open |
| E3 | Veto after tranche 1 released | Only tranches 2–3 frozen; tranche 1 stays with the creator; refunds are pro-rata on the remainder |
| E4 | Veto before tranche 1 claimed | Freezes ALL tranches including tranche 1; full pool + bond refundable |
| E5 | Veto by a zero-pledge account | Rejected: `No pledge to veto with for this backer` |
| E6 | Same backer vetoes twice in one window | Second rejected: `Backer has already vetoed this release` |
| E7 | Veto tally resets on release | Votes from window 1 do not count in window 2; a backer must vote again |
| E8 | Creator never claims tranche 1 (abandonment) | `abandon()` succeeds at `deadline + 72`; full pool + bond refundable |
| E9 | Creator claims tranche 1, then disappears | `abandon()` succeeds at `deadline + 144`; remainder + bond refundable |
| E10 | `abandon()` one epoch too early | Rejected: `Creator has not abandoned the campaign yet` |
| E11 | `abandon()` on a failed campaign | Rejected (refunds already open; bond returns to creator) |
| E12 | Pledge after funding success (post-deadline) | Rejected: `Campaign deadline has passed` (unchanged from v1) |
| E13 | Refund on a funded campaign before any veto | Rejected: `Campaign reached its goal; refunds are closed` (unchanged) |
| E14 | Refund after veto, remainder case | Shares floor-divide; last refunder receives all dust; both vaults end at exactly 0 |
| E15 | Refund after veto, then second refund | Rejected: `No pledge to refund for this backer` |
| E16 | Bond below minimum at creation | Rejected: `Creator bond is below the required minimum`; no component created |
| E17 | Bond overpayment at creation | Accepted; the whole deposit becomes the bond; all of it returns/forfeits |
| E18 | Bond with a non-TARI token at creation | Rejected: `Bond must be paid in TARI` |
| E19 | Bond returns on campaign failure | `claim_bond()` succeeds after the deadline when the goal was missed, even if some backers have not refunded yet |
| E20 | Bond returns on completion | `claim_bond()` succeeds after tranche 3; second call rejected |
| E21 | `claim_bond()` on a vetoed campaign | Rejected: `Bond was forfeited to backers` |
| E22 | `claim_bond()` before the deadline / while funded-incomplete | Rejected with the locked messages (§4.7) |
| E23 | `claim()` for tranche 2 one epoch before its gate | Rejected: `The next release has not opened yet` |
| E24 | `claim()` by a non-creator | Rejected (v1 message, unchanged) |
| E25 | Tranche amounts with a remainder | e.g. total 1000 → 333 + 333 + 334; sum is exactly 1000 |
| E26 | Promise empty / 281 chars | Rejected with the promise messages; 280 chars accepted (boundary) |
| E27 | Pledge after a tranche released (epoch rewound by the harness) | Rejected: `Campaign funds have already been released` |
| E28 | `claim()` after veto success | Rejected: veto message (§4.3); vault untouched |
| E29 | Veto on a failed campaign | Rejected: refunds already open (§4.4) |
| E30 | `is_funded`/`total_pledged` stability | Both stay at the settled values after releases (accumulator semantics); `vault_balance` drops instead |

## 10. Honest limits (v2)

Stated in the README, the demo's "Read before judging" section, and the
submission text. Nothing here may be softened:

- **No code can force a human to work.** The mechanism limits loss and
  gives backers control; it cannot verify real-world delivery and cannot
  claw back released funds. A creator who takes tranche 1 and vanishes
  keeps tranche 1. What v2 guarantees is that the loss is bounded to
  released tranches, that the bond compensates backers on veto or
  abandonment, and that unreleased funds stay under backer control.
- **The promise is not enforced.** The promise text is the creator's
  words, stored on-chain, labeled as such. The template cannot check
  whether a radio station was built. Backers judge the promise; the
  veto is their enforcement tool.
- **Minority backers are not protected against majority apathy.** A veto
  needs strictly more than 50% of pledged value. If most backers never
  act, releases proceed. Apathy is consent — that is the stated rule,
  not a hidden flaw.
- **The bond prices dishonesty; it does not prevent it.** A wealthy bad
  actor can afford to lose bonds. The bond raises the cost of every
  attempt and makes mass scam campaigns unprofitable at small scales; it
  is not a guarantee of good behavior.
- **Parameters are protocol constants**, chosen and justified in §2, not
  tuned to live TARI prices or real campaign data. A production deployment
  would revisit the bond fraction, the window lengths, and the tranche
  count with real usage data.
- **Pledge amounts are public** (unchanged from v1 — vault accounting).
- **Epochs are coarse on real networks** (~20 min mainnet, ~1 h
  Esmeralda). Real veto windows last ~a day or more; the demo's epoch
  control exists only to make the story judgeable in minutes.
- **Not published.** The template has not been published to Esmeralda or
  mainnet; the demo is a simulation and says so. The live path remains an
  honestly-labeled stub.

## 11. Simulation + UI contract

`app/sim.js` mirrors this spec EXACTLY: same method names (`pledge`,
`claim`, `veto`, `abandon`, `refund`, `claimBond`), same check order,
same rejection messages verbatim, same formulas (BigInt floor division),
same event topics and payload shapes (with persona ids instead of public
keys). Constructor options add `promise` (string) and `bond` (bigint,
the deposited bond amount). New getters mirror §5 in camelCase
(`totalPledged`, `vaultBalance`, `bondAmount`, `requiredBond`,
`bondBalance`, `tranchesReleased`, `nextTrancheEpoch`, `isVetoed`,
`isAbandoned`, `vetoTotal`, `myVeto(caller)`, `pledgeOf(backer)`).

`status(currentEpoch)` vocabulary (derived, never stored): `open`,
`open-funded`, `settled-funded`, `settled-failed`, `vetoed`, `abandoned`,
`completed` (replaces v1's `claimed` status value; the `isClaimed` getter
is retained and means "completed").

The demo UI (see the v2 task brief for full requirements) must show, per
campaign: the promise text (labeled as the creator's promise), the bond
amount and its state (locked/returned/forfeited), tranche progress
(released/pending/locked with amounts and gate epochs), the live veto
tally with the >50% rule stated, and a veto action for backers with a
pledge. The create form gains a promise field and shows the bond
requirement before creation. History and the block view cover the new
calls (`veto`, `abandon`, `claim_bond`, tranche releases, bond
return/forfeit) with simulated hashes as before. The walkthrough is
extended to cover the new flow end-to-end and must stay completable.
No visual redesign: the shipped design system, Tari identity, splash,
navigation, and density stay exactly as they are.
