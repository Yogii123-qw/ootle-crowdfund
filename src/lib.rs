// Ootle Crowdfund — all-or-nothing crowdfunding with backer protection.
//
// Original code, written for the Tari November Build Contest (theme: MVP).
// SPDX-License-Identifier: MIT
//
// Design summary (mechanism v2 — see docs/MECHANISM-V2.md, the single
// source of truth):
//   * A creator opens one campaign per component: a funding goal (TARI), a
//     deadline expressed as an Ootle epoch, a promise text (what backers
//     get, stored on-chain, labeled as the creator's words — never
//     enforced by code), and a bond of their own TARI locked at creation
//     (`max(goal / 10, 100)` minimum; overpayment becomes a larger bond).
//   * Backers pledge TARI into the campaign vault before the deadline.
//   * At or after the deadline, exactly one funding outcome is possible:
//       - goal missed -> each backer refunds their own pledge in full,
//         once; the creator's bond returns.
//       - goal met    -> funds release in 3 equal tranches (remainder to
//         tranche 3), one per `claim()` call, at gates
//         `deadline + (k-1) * 72` epochs. Backers may veto a pending
//         release with a strict pledge-weighted majority (> 50%); a
//         successful veto — or creator abandonment 72 epochs past a gate
//         — freezes all unreleased funds and refunds them pro-rata plus
//         pro-rata shares of the forfeited bond. The last refunder takes
//         all rounding dust, so both vaults reconcile to exactly zero.
//   * Pledge amounts are PUBLIC in this design (vault-based accounting). This
//     is stated openly in the app UI and README; hiding amounts would
//     require a confidential/stealth design and is explicitly out of scope.
//   * No resource is created by this template: the vaults hold TARI, the
//     system resource. Authorization is enforced in code by comparing the
//     transaction signer against the recorded creator / pledge keys, so the
//     component has no owner-bypassable resource rules to get wrong.

use tari_template_lib::prelude::*;

/// Floor of the creator bond, in smallest TARI units: `max(goal / 10, 100)`.
const MIN_BOND_UNITS: u128 = 100;

/// The minimum creator bond for a funding goal: 10% of the goal (floor
/// division), with a 100-unit floor so tiny-goal spam is never nearly free.
fn required_bond_for(goal: Amount) -> Amount {
    Amount::new((goal.to_u128() / 10).max(MIN_BOND_UNITS))
}

/// A pledge-weighted share of a pool: `pledge * pool / total`, floor
/// division, computed in u128.
///
/// # Panics
///
/// Panics with a clear message if the intermediate multiplication overflows
/// (unreachable for realistic supplies). `total` must be non-zero; every
/// caller guarantees that (veto/abandonment require a funded campaign).
fn pro_rata_share(pledge: Amount, pool: Amount, total: Amount) -> Amount {
    let numerator = pledge
        .to_u128()
        .checked_mul(pool.to_u128())
        .expect("Pro-rata share computation overflowed");
    Amount::new(numerator / total.to_u128())
}

#[template]
mod crowdfund {
    use std::collections::HashMap;

    use super::*;

    /// Maximum campaign title length, in characters. Keeps component state
    /// small and predictable; titles are display text, not storage.
    const MAX_TITLE_CHARS: usize = 120;

    /// Maximum creator promise length, in characters: one short paragraph.
    const MAX_PROMISE_CHARS: usize = 280;

    /// Number of staged releases. Equal thirds keep the creator's incentive
    /// uniform across gates and give exact integer accounting.
    const TRANCHE_COUNT: u32 = 3;

    /// Minimum deliberation period between releases, in epochs (~24 hours on
    /// mainnet). Also the grace period past a gate before creator inaction
    /// counts as abandonment.
    const VETO_WINDOW_EPOCHS: u64 = 72;

    /// A single all-or-nothing crowdfunding campaign with staged release.
    pub struct CrowdfundCampaign {
        /// Public key of the transaction signer that created the campaign.
        /// Only this signer may claim tranches or reclaim the bond.
        creator: RistrettoPublicKeyBytes,
        /// Short human-readable campaign title.
        title: String,
        /// The creator's promise: what backers get. Stored on-chain and
        /// shown on the campaign card, labeled as the creator's words. It
        /// is NOT enforced by the template; enforcement is economic (bond
        /// + staged release + veto).
        promise: String,
        /// Funding goal, in TARI (smallest units, as with all Amount values).
        goal: Amount,
        /// First epoch at which the campaign settles. Pledges are accepted
        /// while `current_epoch < deadline_epoch`; claim/refund/veto open
        /// when `current_epoch >= deadline_epoch`.
        deadline_epoch: u64,
        /// Escrow vault holding every pledge. One resource only: TARI.
        vault: Vault,
        /// Vault holding ONLY the creator's bond. One resource only: TARI.
        bond_vault: Vault,
        /// The deposited bond (>= the required minimum; overpayment becomes
        /// a larger bond by design). Returns to the creator on honest
        /// completion or honest failure; forfeits to backers on veto or
        /// abandonment.
        bond_amount: Amount,
        /// True once the bond has returned to the creator.
        bond_claimed: bool,
        /// Accumulator: total ever pledged. NEVER decreases — refunds and
        /// tranche releases do not touch it. This is the stable denominator
        /// for vetoes, tranches, and pro-rata refunds.
        pledged_total: Amount,
        /// Pledge ledger: backer signer key -> total pledged by that backer.
        /// A backer may pledge more than once; amounts accumulate. Entries
        /// are removed when the backer refunds.
        pledges: HashMap<RistrettoPublicKeyBytes, Amount>,
        /// Tranches released so far, 0..=3. Fully claimed is derived:
        /// `tranches_released == TRANCHE_COUNT`.
        tranches_released: u32,
        /// True once a veto has crossed the strict-majority threshold.
        vetoed: bool,
        /// True once `abandon()` has succeeded.
        abandoned: bool,
        /// Current veto window: vetoer -> their pledge weight. Cleared on
        /// every tranche release: each release is a fresh decision point.
        vetoers: HashMap<RistrettoPublicKeyBytes, Amount>,
        /// Current veto window total.
        veto_total: Amount,
        /// Snapshot of the pledge-vault balance at veto/abandonment success;
        /// the pool pro-rata refunds draw from.
        refund_pool: Amount,
        /// True once the `Funded` event has been emitted, so it fires exactly
        /// once when the total first reaches the goal.
        funded_announced: bool,
    }

    impl CrowdfundCampaign {
        /// Opens a new campaign. The caller becomes the creator and locks
        /// their bond: the whole `bond` bucket is deposited into the bond
        /// vault, and the whole deposit becomes the bond.
        ///
        /// # Panics
        ///
        /// Panics if the title is empty or too long, the promise is empty or
        /// too long, the goal is zero, the deadline is not strictly in the
        /// future, the bond is not TARI, or the bond is below the required
        /// minimum — checked in exactly that order.
        pub fn new(
            title: String,
            promise: String,
            goal: Amount,
            deadline_epoch: u64,
            bond: Bucket,
        ) -> Component<Self> {
            assert!(!title.is_empty(), "Campaign title must not be empty");
            assert!(
                title.chars().count() <= MAX_TITLE_CHARS,
                "Campaign title is too long"
            );
            assert!(!promise.is_empty(), "Campaign promise must not be empty");
            assert!(
                promise.chars().count() <= MAX_PROMISE_CHARS,
                "Campaign promise is too long"
            );
            assert!(
                goal > Amount::zero(),
                "Funding goal must be greater than zero"
            );
            let now = Consensus::current_epoch();
            assert!(deadline_epoch > now, "Deadline epoch must be in the future");
            assert_eq!(
                bond.resource_address(),
                TARI_TOKEN,
                "Bond must be paid in TARI"
            );
            let bond_amount = bond.amount();
            assert!(
                bond_amount >= required_bond_for(goal),
                "Creator bond is below the required minimum"
            );

            let creator = CallerContext::transaction_signer_public_key();

            let bond_vault = Vault::new_empty(TARI_TOKEN);
            bond_vault.deposit(bond);

            // Every method is callable by anyone at the access-rule layer;
            // authorization is enforced inside each method by signer checks.
            // This is deliberate: the template creates no resource, so there
            // are no resource access rules for an owner to bypass, and the
            // creator gains no privilege beyond the explicit signer checks
            // in `claim` and `claim_bond`. Backers need no permission to
            // pledge, veto, or refund, and `abandon` is callable by anyone
            // because its trigger condition is fully objective (epoch-based).
            let access_rules = AccessRules::new()
                .method("pledge", rule![allow_all])
                .method("claim", rule![allow_all])
                .method("veto", rule![allow_all])
                .method("abandon", rule![allow_all])
                .method("refund", rule![allow_all])
                .method("claim_bond", rule![allow_all])
                .method("goal", rule![allow_all])
                .method("deadline_epoch", rule![allow_all])
                .method("title", rule![allow_all])
                .method("creator", rule![allow_all])
                .method("total_pledged", rule![allow_all])
                .method("pledge_count", rule![allow_all])
                .method("is_claimed", rule![allow_all])
                .method("is_funded", rule![allow_all])
                .method("my_pledge", rule![allow_all])
                .method("promise", rule![allow_all])
                .method("bond_amount", rule![allow_all])
                .method("required_bond", rule![allow_all])
                .method("bond_balance", rule![allow_all])
                .method("vault_balance", rule![allow_all])
                .method("tranches_released", rule![allow_all])
                .method("next_tranche_epoch", rule![allow_all])
                .method("is_vetoed", rule![allow_all])
                .method("is_abandoned", rule![allow_all])
                .method("veto_total", rule![allow_all])
                .method("my_veto", rule![allow_all]);

            emit_event(
                "CampaignCreated",
                metadata![
                    "creator" => creator.to_string(),
                    "title" => title.clone(),
                    "promise" => promise.clone(),
                    "goal" => goal.to_string(),
                    "deadline_epoch" => deadline_epoch.to_string(),
                    "bond" => bond_amount.to_string(),
                ],
            );

            Component::new(Self {
                creator,
                title,
                promise,
                goal,
                deadline_epoch,
                vault: Vault::new_empty(TARI_TOKEN),
                bond_vault,
                bond_amount,
                bond_claimed: false,
                pledged_total: Amount::zero(),
                pledges: HashMap::new(),
                tranches_released: 0,
                vetoed: false,
                abandoned: false,
                vetoers: HashMap::new(),
                veto_total: Amount::zero(),
                refund_pool: Amount::zero(),
                funded_announced: false,
            })
            .with_access_rules(access_rules)
            .create()
        }

        /// Pledges TARI into the campaign vault.
        ///
        /// Callable by anyone, any number of times, while the campaign is open
        /// (current epoch strictly before the deadline, no tranche released,
        /// not vetoed, not abandoned). Amounts accumulate per backer and in
        /// `pledged_total`.
        ///
        /// # Panics
        ///
        /// Panics if the payment is not TARI, the amount is zero, the deadline
        /// has passed, funds have already been released, or the campaign was
        /// vetoed or abandoned — checked in exactly that order.
        pub fn pledge(&mut self, payment: Bucket) {
            assert_eq!(
                payment.resource_address(),
                TARI_TOKEN,
                "Pledges must be paid in TARI"
            );
            let amount = payment.amount();
            assert!(amount > Amount::zero(), "Pledge must be greater than zero");
            assert!(
                Consensus::current_epoch() < self.deadline_epoch,
                "Campaign deadline has passed"
            );
            assert!(
                self.tranches_released == 0,
                "Campaign funds have already been released"
            );
            assert!(!self.vetoed, "Campaign was vetoed; pledges are closed");
            assert!(
                !self.abandoned,
                "Campaign was abandoned; pledges are closed"
            );

            let backer = CallerContext::transaction_signer_public_key();
            let previous = self
                .pledges
                .get(&backer)
                .copied()
                .unwrap_or_else(Amount::zero);
            let updated = previous
                .checked_add(amount)
                .expect("Backer pledge total overflowed");
            self.pledges.insert(backer, updated);
            self.vault.deposit(payment);
            self.pledged_total = self
                .pledged_total
                .checked_add(amount)
                .expect("Total pledged amount overflowed");

            let total = self.pledged_total;
            emit_event(
                "Pledged",
                metadata![
                    "backer" => backer.to_string(),
                    "amount" => amount.to_string(),
                    "total_pledged" => total.to_string(),
                ],
            );

            // During the funding phase the vault balance equals
            // `pledged_total` (no release or refund can have happened yet),
            // so this is the same "first reaches the goal" moment as v1.
            if !self.funded_announced && total >= self.goal {
                self.funded_announced = true;
                emit_event(
                    "Funded",
                    metadata![
                        "goal" => self.goal.to_string(),
                        "total_pledged" => total.to_string(),
                    ],
                );
            }
        }

        /// Releases the NEXT tranche to the creator, one per call. The
        /// returned bucket must be deposited by the caller (typically into
        /// their account) in the same transaction.
        ///
        /// Tranche `k` (1-based) is claimable at epoch >=
        /// `deadline + (k-1) * 72`. Tranches 1–2 pay `pledged_total / 3`
        /// (floor); tranche 3 pays the remainder, so the three tranches sum
        /// to exactly `pledged_total`. Each release clears the veto tally: a
        /// release is a fresh decision point.
        ///
        /// # Panics
        ///
        /// Panics if the caller is not the creator, the campaign was vetoed
        /// or abandoned, all tranches were already claimed, the deadline has
        /// not been reached, the goal was missed, or the next release gate
        /// has not opened — checked in exactly that order.
        pub fn claim(&mut self) -> Bucket {
            let caller = CallerContext::transaction_signer_public_key();
            assert_eq!(
                caller, self.creator,
                "Only the campaign creator can claim the funds"
            );
            assert!(
                !self.vetoed,
                "Campaign was vetoed; remaining funds are refundable to backers"
            );
            assert!(
                !self.abandoned,
                "Campaign was abandoned; remaining funds are refundable to backers"
            );
            assert!(
                self.tranches_released < TRANCHE_COUNT,
                "Campaign funds have already been claimed"
            );
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Campaign deadline has not been reached"
            );
            assert!(
                self.pledged_total >= self.goal,
                "Funding goal was not met; backers may refund instead"
            );
            let gate_epoch =
                self.deadline_epoch + u64::from(self.tranches_released) * VETO_WINDOW_EPOCHS;
            assert!(
                Consensus::current_epoch() >= gate_epoch,
                "The next release has not opened yet"
            );

            // Effects before the outward transfer: compute the tranche,
            // advance the counter, and clear the veto tally first, so no
            // path can pay a tranche twice.
            let total = self.pledged_total.to_u128();
            let base = total / u128::from(TRANCHE_COUNT);
            let tranche_number = self.tranches_released + 1;
            let tranche_amount = if tranche_number >= TRANCHE_COUNT {
                Amount::new(total - 2 * base)
            } else {
                Amount::new(base)
            };
            self.tranches_released = tranche_number;
            self.vetoers.clear();
            self.veto_total = Amount::zero();

            let funds = self.vault.withdraw(tranche_amount);
            emit_event(
                "TrancheReleased",
                metadata![
                    "tranche" => tranche_number.to_string(),
                    "amount" => tranche_amount.to_string(),
                ],
            );
            if self.tranches_released >= TRANCHE_COUNT {
                emit_event(
                    "CampaignCompleted",
                    metadata![
                        "total_released" => self.pledged_total.to_string(),
                    ],
                );
            }
            funds
        }

        /// Vetoes the pending release. Any backer with a pledge may veto,
        /// once per window, with their pledge as weight. The threshold is
        /// evaluated eagerly: a strict pledge-weighted majority
        /// (`veto_total > pledged_total - veto_total`) succeeds immediately,
        /// freezing all unreleased tranches. An exact 50/50 split fails.
        ///
        /// Veto is open from the deadline until each tranche is actually
        /// released. A veto after a release affects only future tranches:
        /// released funds are never clawed back.
        ///
        /// # Panics
        ///
        /// Panics if the deadline has not been reached, the campaign was
        /// already vetoed or abandoned, the campaign is complete, the goal
        /// was missed, the caller has no pledge, or the caller already
        /// vetoed in this window — checked in exactly that order.
        pub fn veto(&mut self) {
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Veto opens after the campaign deadline"
            );
            assert!(!self.vetoed, "Campaign was already vetoed");
            assert!(!self.abandoned, "Campaign was abandoned; veto is closed");
            assert!(
                self.tranches_released < TRANCHE_COUNT,
                "Campaign is complete; veto is closed"
            );
            assert!(
                self.pledged_total >= self.goal,
                "Campaign did not reach its goal; refunds are already open"
            );
            let caller = CallerContext::transaction_signer_public_key();
            let weight = self
                .pledges
                .get(&caller)
                .copied()
                .unwrap_or_else(Amount::zero);
            assert!(
                weight > Amount::zero(),
                "No pledge to veto with for this backer"
            );
            assert!(
                !self.vetoers.contains_key(&caller),
                "Backer has already vetoed this release"
            );

            self.vetoers.insert(caller, weight);
            self.veto_total = self
                .veto_total
                .checked_add(weight)
                .expect("Veto total overflowed");
            emit_event(
                "VetoCast",
                metadata![
                    "backer" => caller.to_string(),
                    "weight" => weight.to_string(),
                    "veto_total" => self.veto_total.to_string(),
                ],
            );

            // Strict majority without multiplication: exact, overflow-free.
            // `veto_total <= pledged_total` always (veto weights are
            // pledges), so the subtraction cannot underflow.
            let veto_total = self.veto_total.to_u128();
            let pledged_total = self.pledged_total.to_u128();
            if veto_total > pledged_total - veto_total {
                self.vetoed = true;
                self.refund_pool = self.vault.balance();
                emit_event(
                    "VetoSucceeded",
                    metadata![
                        "veto_total" => self.veto_total.to_string(),
                        "pledged_total" => self.pledged_total.to_string(),
                    ],
                );
                emit_event(
                    "BondForfeited",
                    metadata!["amount" => self.bond_amount.to_string()],
                );
            }
        }

        /// Declares the campaign abandoned. Callable by ANYONE: the trigger
        /// condition is fully objective (the creator has been silent for a
        /// full veto window past the next tranche's gate), so the caller
        /// identity is irrelevant. Remaining vault funds and the bond become
        /// refundable pro-rata exactly as after a veto.
        ///
        /// # Panics
        ///
        /// Panics if the campaign was already vetoed or abandoned, the
        /// campaign is complete, the goal was missed, or the abandonment
        /// epoch has not been reached — checked in exactly that order.
        pub fn abandon(&mut self) {
            assert!(!self.vetoed, "Campaign was already vetoed");
            assert!(!self.abandoned, "Campaign was already abandoned");
            assert!(
                self.tranches_released < TRANCHE_COUNT,
                "Campaign is complete; abandonment is closed"
            );
            assert!(
                self.pledged_total >= self.goal,
                "Campaign did not reach its goal; refunds are already open"
            );
            let abandon_epoch = self.deadline_epoch
                + u64::from(self.tranches_released) * VETO_WINDOW_EPOCHS
                + VETO_WINDOW_EPOCHS;
            assert!(
                Consensus::current_epoch() >= abandon_epoch,
                "Creator has not abandoned the campaign yet"
            );

            self.abandoned = true;
            self.refund_pool = self.vault.balance();
            emit_event(
                "Abandoned",
                metadata![
                    "unreleased" => self.refund_pool.to_string(),
                    "bond_forfeited" => self.bond_amount.to_string(),
                ],
            );
            emit_event(
                "BondForfeited",
                metadata!["amount" => self.bond_amount.to_string()],
            );
        }

        /// Refunds the caller, once the deadline has passed.
        ///
        /// Two paths. On a failed campaign (goal missed, no veto or
        /// abandonment) the caller is repaid their full pledge from the
        /// vault. After a veto or abandonment, the caller receives their
        /// pro-rata share of the remaining pool plus their pro-rata share of
        /// the forfeited bond; the LAST refunder receives the entire
        /// remaining balance of both vaults, including all rounding dust, so
        /// both vaults reconcile to exactly zero when every backer refunds.
        ///
        /// Each backer can refund exactly once: their ledger entry is removed
        /// before the vault pays out.
        ///
        /// # Panics
        ///
        /// Panics if the deadline has not been reached, all tranches were
        /// claimed, the goal was met (on the non-veto path), or the caller
        /// has no pledge to refund — checked in exactly that order.
        pub fn refund(&mut self) -> Bucket {
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Refunds open after the campaign deadline"
            );
            assert!(
                self.tranches_released < TRANCHE_COUNT,
                "Campaign funds were claimed; refunds are closed"
            );

            let backer = CallerContext::transaction_signer_public_key();
            if self.vetoed || self.abandoned {
                // Pro-rata path: remove the ledger entry BEFORE payout, so a
                // second refund finds nothing.
                let pledged = self.pledges.remove(&backer).unwrap_or_else(Amount::zero);
                assert!(
                    pledged > Amount::zero(),
                    "No pledge to refund for this backer"
                );

                // The call that empties the ledger takes every remaining
                // unit of both vaults — computed shares plus all dust.
                let is_last_refunder = self.pledges.is_empty();
                let (vault_share, bond_share) = if is_last_refunder {
                    (self.vault.balance(), self.bond_vault.balance())
                } else {
                    (
                        pro_rata_share(pledged, self.refund_pool, self.pledged_total),
                        pro_rata_share(pledged, self.bond_amount, self.pledged_total),
                    )
                };

                // Pay as one bucket: move the bond share into the pledge
                // vault, then withdraw the combined amount. (Skipping a
                // zero bond share changes nothing observable.)
                if bond_share > Amount::zero() {
                    let bond_bucket = self.bond_vault.withdraw(bond_share);
                    self.vault.deposit(bond_bucket);
                }
                let total_paid = vault_share
                    .checked_add(bond_share)
                    .expect("Refund total overflowed");
                let funds = self.vault.withdraw(total_paid);
                emit_event(
                    "Refunded",
                    metadata![
                        "backer" => backer.to_string(),
                        "amount" => total_paid.to_string(),
                        "bond_share" => bond_share.to_string(),
                    ],
                );
                funds
            } else {
                assert!(
                    self.pledged_total < self.goal,
                    "Campaign reached its goal; refunds are closed"
                );
                // Remove the ledger entry first: a second refund finds nothing.
                let pledged = self.pledges.remove(&backer).unwrap_or_else(Amount::zero);
                assert!(
                    pledged > Amount::zero(),
                    "No pledge to refund for this backer"
                );

                let funds = self.vault.withdraw(pledged);
                emit_event(
                    "Refunded",
                    metadata![
                        "backer" => backer.to_string(),
                        "amount" => pledged.to_string(),
                        "bond_share" => Amount::zero().to_string(),
                    ],
                );
                funds
            }
        }

        /// Returns the bond to the creator: on campaign failure (after the
        /// deadline, even if some backers have not refunded yet) or on
        /// completion (all three tranches released). On a vetoed or
        /// abandoned campaign the bond was forfeited to backers.
        ///
        /// # Panics
        ///
        /// Panics if the caller is not the creator, the bond was already
        /// claimed, the bond was forfeited, the deadline has not been
        /// reached, or the campaign is funded but incomplete — checked in
        /// exactly that order.
        pub fn claim_bond(&mut self) -> Bucket {
            let caller = CallerContext::transaction_signer_public_key();
            assert_eq!(
                caller, self.creator,
                "Only the campaign creator can claim the bond"
            );
            assert!(!self.bond_claimed, "Bond has already been claimed");
            assert!(!self.vetoed, "Bond was forfeited to backers");
            assert!(!self.abandoned, "Bond was forfeited to backers");
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Bond is locked until the campaign deadline"
            );
            assert!(
                self.pledged_total < self.goal || self.tranches_released >= TRANCHE_COUNT,
                "Bond is locked until all releases complete"
            );

            // Effects before the outward transfer: mark claimed first so no
            // path can return the bond twice.
            self.bond_claimed = true;
            let funds = self.bond_vault.withdraw_all();
            emit_event(
                "BondReturned",
                metadata![
                    "creator" => self.creator.to_string(),
                    "amount" => funds.amount().to_string(),
                ],
            );
            funds
        }

        // ---- Read-only getters (no state change, callable by anyone) ----

        pub fn goal(&self) -> Amount {
            self.goal
        }

        pub fn deadline_epoch(&self) -> u64 {
            self.deadline_epoch
        }

        pub fn title(&self) -> String {
            self.title.clone()
        }

        pub fn creator(&self) -> RistrettoPublicKeyBytes {
            self.creator
        }

        /// Total EVER pledged. Stable: tranche releases and refunds never
        /// change it (unlike v1, where this returned the vault balance).
        pub fn total_pledged(&self) -> Amount {
            self.pledged_total
        }

        pub fn pledge_count(&self) -> u64 {
            self.pledges.len() as u64
        }

        /// True once ALL tranches have been released (fully claimed).
        pub fn is_claimed(&self) -> bool {
            self.tranches_released >= TRANCHE_COUNT
        }

        /// True once total ever pledged reaches the goal. Stable across
        /// releases (unlike v1's vault-balance basis).
        pub fn is_funded(&self) -> bool {
            self.pledged_total >= self.goal
        }

        /// The caller's own total pledge (zero if they never pledged).
        pub fn my_pledge(&self) -> Amount {
            let caller = CallerContext::transaction_signer_public_key();
            self.pledges
                .get(&caller)
                .copied()
                .unwrap_or_else(Amount::zero)
        }

        pub fn promise(&self) -> String {
            self.promise.clone()
        }

        /// The deposited bond (the whole deposit, including any overpayment).
        pub fn bond_amount(&self) -> Amount {
            self.bond_amount
        }

        /// The minimum bond for this campaign's goal: `max(goal / 10, 100)`.
        pub fn required_bond(&self) -> Amount {
            required_bond_for(self.goal)
        }

        /// Current bond-vault balance: the bond, until returned or
        /// distributed to backers.
        pub fn bond_balance(&self) -> Amount {
            self.bond_vault.balance()
        }

        /// Current pledge-vault balance: drops as tranches release and as
        /// backers refund.
        pub fn vault_balance(&self) -> Amount {
            self.vault.balance()
        }

        pub fn tranches_released(&self) -> u32 {
            self.tranches_released
        }

        /// The epoch at which the next tranche becomes claimable:
        /// `deadline + tranches_released * 72`.
        pub fn next_tranche_epoch(&self) -> u64 {
            self.deadline_epoch + u64::from(self.tranches_released) * VETO_WINDOW_EPOCHS
        }

        pub fn is_vetoed(&self) -> bool {
            self.vetoed
        }

        pub fn is_abandoned(&self) -> bool {
            self.abandoned
        }

        /// Current veto-window tally (resets on every tranche release).
        pub fn veto_total(&self) -> Amount {
            self.veto_total
        }

        /// The caller's recorded veto weight in this window (zero if they
        /// have not vetoed in this window).
        pub fn my_veto(&self) -> Amount {
            let caller = CallerContext::transaction_signer_public_key();
            self.vetoers
                .get(&caller)
                .copied()
                .unwrap_or_else(Amount::zero)
        }
    }
}
