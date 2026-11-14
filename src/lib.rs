// Ootle Crowdfund — all-or-nothing crowdfunding with automatic refunds.
//
// Original code, written for the Tari November Build Contest (theme: MVP).
// SPDX-License-Identifier: MIT
//
// Design summary:
//   * A creator opens one campaign per component: a funding goal (TARI) and a
//     deadline expressed as an Ootle epoch.
//   * Backers pledge TARI into the campaign vault before the deadline.
//   * At or after the deadline, exactly one outcome is possible:
//       - goal met   -> only the creator can claim the whole vault, once.
//       - goal missed -> each backer can refund their own pledge in full, once.
//   * Pledge amounts are PUBLIC in this design (vault-based accounting). This is
//     stated openly in the app UI and README; hiding amounts would require a
//     confidential/stealth design and is explicitly out of scope for v1.
//   * No resource is created by this template: the vault holds TARI, the system
//     resource. Authorization is enforced in code by comparing the transaction
//     signer against the recorded creator / pledge keys, so the component has
//     no owner-bypassable resource rules to get wrong.

use tari_template_lib::prelude::*;

#[template]
mod crowdfund {
    use std::collections::HashMap;

    use super::*;

    /// Maximum campaign title length, in characters. Keeps component state
    /// small and predictable; titles are display text, not storage.
    const MAX_TITLE_CHARS: usize = 120;

    /// A single all-or-nothing crowdfunding campaign.
    pub struct CrowdfundCampaign {
        /// Public key of the transaction signer that created the campaign.
        /// Only this signer may claim the funds.
        creator: RistrettoPublicKeyBytes,
        /// Short human-readable campaign title.
        title: String,
        /// Funding goal, in TARI (smallest units, as with all Amount values).
        goal: Amount,
        /// First epoch at which the campaign settles. Pledges are accepted
        /// while `current_epoch < deadline_epoch`; claim/refund open when
        /// `current_epoch >= deadline_epoch`.
        deadline_epoch: u64,
        /// Escrow vault holding every pledge. One resource only: TARI.
        vault: Vault,
        /// Pledge ledger: backer signer key -> total pledged by that backer.
        /// A backer may pledge more than once; amounts accumulate.
        pledges: HashMap<RistrettoPublicKeyBytes, Amount>,
        /// True once the creator has claimed. Prevents double claims and
        /// closes refunds after a successful campaign.
        claimed: bool,
        /// True once the `Funded` event has been emitted, so it fires exactly
        /// once when the total first reaches the goal.
        funded_announced: bool,
    }

    impl CrowdfundCampaign {
        /// Opens a new campaign. The caller becomes the creator.
        ///
        /// # Panics
        ///
        /// Panics if the title is empty or too long, the goal is zero, or the
        /// deadline is not strictly in the future.
        pub fn new(title: String, goal: Amount, deadline_epoch: u64) -> Component<Self> {
            assert!(!title.is_empty(), "Campaign title must not be empty");
            assert!(
                title.chars().count() <= MAX_TITLE_CHARS,
                "Campaign title is too long"
            );
            assert!(goal > Amount::zero(), "Funding goal must be greater than zero");
            let now = Consensus::current_epoch();
            assert!(
                deadline_epoch > now,
                "Deadline epoch must be in the future"
            );

            let creator = CallerContext::transaction_signer_public_key();

            // Every method is callable by anyone at the access-rule layer;
            // authorization is enforced inside each method by signer checks.
            // This is deliberate: the template creates no resource, so there
            // are no resource access rules for an owner to bypass, and the
            // creator gains no privilege beyond the explicit signer check in
            // `claim`. Backers need no permission to pledge or refund.
            let access_rules = AccessRules::new()
                .method("pledge", rule![allow_all])
                .method("claim", rule![allow_all])
                .method("refund", rule![allow_all])
                .method("goal", rule![allow_all])
                .method("deadline_epoch", rule![allow_all])
                .method("title", rule![allow_all])
                .method("creator", rule![allow_all])
                .method("total_pledged", rule![allow_all])
                .method("pledge_count", rule![allow_all])
                .method("is_claimed", rule![allow_all])
                .method("is_funded", rule![allow_all])
                .method("my_pledge", rule![allow_all]);

            emit_event(
                "CampaignCreated",
                metadata![
                    "creator" => creator.to_string(),
                    "title" => title.clone(),
                    "goal" => goal.to_string(),
                    "deadline_epoch" => deadline_epoch.to_string(),
                ],
            );

            Component::new(Self {
                creator,
                title,
                goal,
                deadline_epoch,
                vault: Vault::new_empty(TARI_TOKEN),
                pledges: HashMap::new(),
                claimed: false,
                funded_announced: false,
            })
            .with_access_rules(access_rules)
            .create()
        }

        /// Pledges TARI into the campaign vault.
        ///
        /// Callable by anyone, any number of times, while the campaign is open
        /// (current epoch strictly before the deadline). Amounts accumulate
        /// per backer.
        ///
        /// # Panics
        ///
        /// Panics if the payment is not TARI, the amount is zero, the deadline
        /// has passed, or the campaign was already claimed.
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
            assert!(!self.claimed, "Campaign funds have already been claimed");

            let backer = CallerContext::transaction_signer_public_key();
            let previous = self.pledges.get(&backer).copied().unwrap_or_else(Amount::zero);
            self.pledges.insert(backer, previous + amount);
            self.vault.deposit(payment);

            let total = self.vault.balance();
            emit_event(
                "Pledged",
                metadata![
                    "backer" => backer.to_string(),
                    "amount" => amount.to_string(),
                    "total_pledged" => total.to_string(),
                ],
            );

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

        /// Claims the full vault for the creator, once the deadline has passed
        /// and the goal has been met. The returned bucket must be deposited by
        /// the caller (typically into their account) in the same transaction.
        ///
        /// # Panics
        ///
        /// Panics if the caller is not the creator, the funds were already
        /// claimed, the deadline has not been reached, or the goal was missed.
        pub fn claim(&mut self) -> Bucket {
            let caller = CallerContext::transaction_signer_public_key();
            assert_eq!(caller, self.creator, "Only the campaign creator can claim the funds");
            assert!(!self.claimed, "Campaign funds have already been claimed");
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Campaign deadline has not been reached"
            );
            let total = self.vault.balance();
            assert!(
                total >= self.goal,
                "Funding goal was not met; backers may refund instead"
            );

            // Effects before the outward transfer: mark claimed first so no
            // path can claim twice.
            self.claimed = true;
            let funds = self.vault.withdraw_all();
            emit_event(
                "Claimed",
                metadata![
                    "creator" => self.creator.to_string(),
                    "amount" => total.to_string(),
                ],
            );
            funds
        }

        /// Refunds the caller's full pledge, once the deadline has passed and
        /// the goal was missed. Each backer can refund exactly once: their
        /// ledger entry is removed before the vault pays out.
        ///
        /// # Panics
        ///
        /// Panics if the deadline has not been reached, the campaign was
        /// claimed, the goal was met, or the caller has no pledge to refund.
        pub fn refund(&mut self) -> Bucket {
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Refunds open after the campaign deadline"
            );
            assert!(
                !self.claimed,
                "Campaign funds were claimed; refunds are closed"
            );
            assert!(
                self.vault.balance() < self.goal,
                "Campaign reached its goal; refunds are closed"
            );

            let backer = CallerContext::transaction_signer_public_key();
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

        pub fn total_pledged(&self) -> Amount {
            self.vault.balance()
        }

        pub fn pledge_count(&self) -> u64 {
            self.pledges.len() as u64
        }

        pub fn is_claimed(&self) -> bool {
            self.claimed
        }

        pub fn is_funded(&self) -> bool {
            self.vault.balance() >= self.goal
        }

        /// The caller's own total pledge (zero if they never pledged).
        pub fn my_pledge(&self) -> Amount {
            let caller = CallerContext::transaction_signer_public_key();
            self.pledges.get(&caller).copied().unwrap_or_else(Amount::zero)
        }
    }
}
