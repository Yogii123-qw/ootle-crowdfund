// Engine tests for the CrowdfundCampaign template (mechanism v2).
//
// These run the real Ootle engine in-process (tari_template_test_tooling):
// a passing test means the engine accepted the transaction. No network,
// funds, or faucet is involved. Epochs are overridden with virtual substates.
//
// Every test reconciles BOTH vaults through the template getters
// (`vault_balance`, `bond_balance`): no leaks, no double-pays. The v1 tests
// kept below are updated only where v2 legitimately changes behavior (staged
// release, accumulator totals, bond at creation); the `eNN_` tests cover
// every edge case E1–E30 of docs/MECHANISM-V2.md §9.

use tari_template_lib::types::{
    Amount, ComponentAddress, NonFungibleAddress, constants::TARI_TOKEN,
};
use tari_template_test_tooling::{
    TemplateTest,
    byte_type::ToByteType,
    crypto::{RistrettoPublicKey, RistrettoSecretKey},
    engine_types::{
        commit_result::ExecuteResult,
        virtual_substate::{VirtualSubstate, VirtualSubstateId},
    },
    support::assert_error::assert_reject_reason,
    transaction::args,
};

const TEMPLATE_NAME: &str = "CrowdfundCampaign";
const PROMISE: &str = "Name in the credits, early access, and an invite to launch day.";
const DEADLINE: u64 = 10;

/// One test identity: a funded account plus the key/proof that seals its txs.
struct Actor {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
    public_key: RistrettoPublicKey,
}

fn new_actor(test: &mut TemplateTest) -> Actor {
    let (account, proof, key, public_key) = test.create_funded_account_with_keypair();
    Actor {
        account,
        proof,
        key,
        public_key,
    }
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(epoch),
    );
}

/// Shorthand for whole-unit amounts in assertions.
fn amt(value: u64) -> Amount {
    Amount::from(value)
}

fn account_tari_balance(test: &TemplateTest, account: ComponentAddress) -> Amount {
    test.read_only_state_store()
        .get_vaults_for_account(account)
        .unwrap()
        .get(&TARI_TOKEN)
        .map(|vault| vault.balance())
        .unwrap_or_else(Amount::zero)
}

/// Sum of every vault the component holds, read from the state store. Used
/// only to cross-check the getters: the component must hold exactly two
/// vaults (pledge + bond), and their sum must equal
/// `vault_balance + bond_balance`.
fn state_store_vault_sum(test: &TemplateTest, campaign: ComponentAddress) -> Amount {
    test.read_only_state_store()
        .get_vaults_for_component(campaign)
        .unwrap()
        .values()
        .map(|vault| vault.balance())
        .fold(Amount::zero(), |acc, balance| acc + balance)
}

fn vault_balance(test: &mut TemplateTest, campaign: ComponentAddress) -> Amount {
    test.call_method::<Amount>(campaign, "vault_balance", args![], vec![])
}

fn bond_balance(test: &mut TemplateTest, campaign: ComponentAddress) -> Amount {
    test.call_method::<Amount>(campaign, "bond_balance", args![], vec![])
}

fn total_pledged(test: &mut TemplateTest, campaign: ComponentAddress) -> Amount {
    test.call_method::<Amount>(campaign, "total_pledged", args![], vec![])
}

fn veto_total(test: &mut TemplateTest, campaign: ComponentAddress) -> Amount {
    test.call_method::<Amount>(campaign, "veto_total", args![], vec![])
}

fn tranches_released(test: &mut TemplateTest, campaign: ComponentAddress) -> u32 {
    test.call_method::<u32>(campaign, "tranches_released", args![], vec![])
}

fn next_tranche_epoch(test: &mut TemplateTest, campaign: ComponentAddress) -> u64 {
    test.call_method::<u64>(campaign, "next_tranche_epoch", args![], vec![])
}

fn pledge_count(test: &mut TemplateTest, campaign: ComponentAddress) -> u64 {
    test.call_method::<u64>(campaign, "pledge_count", args![], vec![])
}

fn is_claimed(test: &mut TemplateTest, campaign: ComponentAddress) -> bool {
    test.call_method::<bool>(campaign, "is_claimed", args![], vec![])
}

fn is_funded(test: &mut TemplateTest, campaign: ComponentAddress) -> bool {
    test.call_method::<bool>(campaign, "is_funded", args![], vec![])
}

fn is_vetoed(test: &mut TemplateTest, campaign: ComponentAddress) -> bool {
    test.call_method::<bool>(campaign, "is_vetoed", args![], vec![])
}

fn is_abandoned(test: &mut TemplateTest, campaign: ComponentAddress) -> bool {
    test.call_method::<bool>(campaign, "is_abandoned", args![], vec![])
}

/// Reconciles both vaults at once: the pledge vault and the bond vault.
fn assert_vaults(test: &mut TemplateTest, campaign: ComponentAddress, vault: u64, bond: u64) {
    assert_eq!(vault_balance(test, campaign), amt(vault));
    assert_eq!(bond_balance(test, campaign), amt(bond));
}

fn create_campaign(
    test: &mut TemplateTest,
    creator: &Actor,
    title: &str,
    promise: &str,
    goal: u64,
    deadline: u64,
    bond: u64,
) -> ComponentAddress {
    let template = test.get_template_address(TEMPLATE_NAME);
    test.execute_expect_success(
        test.transaction()
            .call_method(creator.account, "withdraw", args![TARI_TOKEN, bond])
            .put_last_instruction_output_on_workspace("bond")
            .call_function(
                template,
                "new",
                args![
                    title.to_string(),
                    promise.to_string(),
                    goal,
                    deadline,
                    Workspace("bond")
                ],
            )
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    test.read_only_state_store()
        .get_components_by_template_address(template)
        .unwrap()
        .remove(0)
        .0
}

#[allow(clippy::too_many_arguments)]
fn expect_create_rejected(
    test: &mut TemplateTest,
    creator: &Actor,
    title: &str,
    promise: &str,
    goal: u64,
    deadline: u64,
    bond: u64,
    message: &str,
) {
    let template = test.get_template_address(TEMPLATE_NAME);
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(creator.account, "withdraw", args![TARI_TOKEN, bond])
            .put_last_instruction_output_on_workspace("bond")
            .call_function(
                template,
                "new",
                args![
                    title.to_string(),
                    promise.to_string(),
                    goal,
                    deadline,
                    Workspace("bond")
                ],
            )
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn pledge(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    backer: &Actor,
    amount: u64,
) -> ExecuteResult {
    test.execute_expect_success(
        test.transaction()
            .call_method(backer.account, "withdraw", args![TARI_TOKEN, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(campaign, "pledge", args![Workspace("funds")])
            .build_and_seal(&backer.key),
        vec![backer.proof.clone()],
    )
}

fn expect_pledge_rejected(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    backer: &Actor,
    amount: u64,
    message: &str,
) {
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(backer.account, "withdraw", args![TARI_TOKEN, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(campaign, "pledge", args![Workspace("funds")])
            .build_and_seal(&backer.key),
        vec![backer.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn claim(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> ExecuteResult {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "claim", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(actor.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    )
}

fn expect_claim_rejected(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    actor: &Actor,
    message: &str,
) {
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "claim", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(actor.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn veto(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> ExecuteResult {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "veto", args![])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    )
}

fn expect_veto_rejected(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    actor: &Actor,
    message: &str,
) {
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "veto", args![])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn abandon(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> ExecuteResult {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "abandon", args![])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    )
}

fn expect_abandon_rejected(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    actor: &Actor,
    message: &str,
) {
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "abandon", args![])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn refund(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> ExecuteResult {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(actor.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    )
}

fn expect_refund_rejected(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    actor: &Actor,
    message: &str,
) {
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(actor.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn claim_bond(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> ExecuteResult {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "claim_bond", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(actor.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    )
}

fn expect_claim_bond_rejected(
    test: &mut TemplateTest,
    campaign: ComponentAddress,
    actor: &Actor,
    message: &str,
) {
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "claim_bond", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(actor.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    assert_reject_reason(reason, message);
}

fn has_event(result: &ExecuteResult, topic: &str) -> bool {
    result
        .finalize
        .events
        .iter()
        .any(|event| event.topic() == topic)
}

fn my_pledge(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> Amount {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "my_pledge", args![])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    test.expect_return(0)
}

fn my_veto(test: &mut TemplateTest, campaign: ComponentAddress, actor: &Actor) -> Amount {
    test.execute_expect_success(
        test.transaction()
            .call_method(campaign, "my_veto", args![])
            .build_and_seal(&actor.key),
        vec![actor.proof.clone()],
    );
    test.expect_return(0)
}

// ---------------------------------------------------------------------------
// v1 tests, updated only where v2 legitimately changes behavior.
// ---------------------------------------------------------------------------

#[test]
fn campaign_creation_records_state_and_emits_event() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let template = test.get_template_address(TEMPLATE_NAME);

    // Creation passes a bond bucket: the creator withdraws 100 TARI and the
    // template locks the whole bucket as the bond.
    let result = test.execute_expect_success(
        test.transaction()
            .call_method(creator.account, "withdraw", args![TARI_TOKEN, 100])
            .put_last_instruction_output_on_workspace("bond")
            .call_function(
                template,
                "new",
                args![
                    "Fund the community radio".to_string(),
                    PROMISE.to_string(),
                    1_000,
                    DEADLINE,
                    Workspace("bond")
                ],
            )
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert!(has_event(&result, "CrowdfundCampaign.CampaignCreated"));

    let (campaign, _) = test
        .read_only_state_store()
        .get_components_by_template_address(template)
        .unwrap()
        .remove(0);

    assert_eq!(
        test.call_method::<Amount>(campaign, "goal", args![], vec![]),
        amt(1_000)
    );
    assert_eq!(
        test.call_method::<u64>(campaign, "deadline_epoch", args![], vec![]),
        DEADLINE
    );
    assert_eq!(
        test.call_method::<String>(campaign, "title", args![], vec![]),
        "Fund the community radio"
    );
    assert_eq!(
        test.call_method::<tari_template_lib::prelude::RistrettoPublicKeyBytes>(
            campaign,
            "creator",
            args![],
            vec![]
        ),
        creator.public_key.to_byte_type()
    );
    assert_eq!(
        test.call_method::<String>(campaign, "promise", args![], vec![]),
        PROMISE
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "bond_amount", args![], vec![]),
        amt(100)
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "required_bond", args![], vec![]),
        amt(100)
    );
    assert_eq!(total_pledged(&mut test, campaign), Amount::zero());
    assert_eq!(pledge_count(&mut test, campaign), 0);
    assert!(!is_claimed(&mut test, campaign));
    assert!(!is_funded(&mut test, campaign));
    assert!(!is_vetoed(&mut test, campaign));
    assert!(!is_abandoned(&mut test, campaign));
    assert_eq!(tranches_released(&mut test, campaign), 0);
    assert_eq!(next_tranche_epoch(&mut test, campaign), DEADLINE);
    assert_eq!(veto_total(&mut test, campaign), Amount::zero());
    assert_eq!(my_pledge(&mut test, campaign, &creator), Amount::zero());
    assert_eq!(my_veto(&mut test, campaign, &creator), Amount::zero());
    assert_vaults(&mut test, campaign, 0, 100);

    // The component holds exactly two vaults (pledge + bond), and the state
    // store agrees with the getters.
    assert_eq!(
        test.read_only_state_store()
            .get_vaults_for_component(campaign)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(state_store_vault_sum(&test, campaign), amt(100));
}

#[test]
fn pledges_accumulate_and_funding_event_fires_once() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);

    let campaign = create_campaign(
        &mut test,
        &creator,
        "Open-source feature",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );

    let alice_before = account_tari_balance(&test, alice.account);
    let result = pledge(&mut test, campaign, &alice, 400);
    assert!(has_event(&result, "CrowdfundCampaign.Pledged"));
    assert!(!has_event(&result, "CrowdfundCampaign.Funded"));
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before - amt(400)
    );
    assert_eq!(my_pledge(&mut test, campaign, &alice), amt(400));
    assert_eq!(total_pledged(&mut test, campaign), amt(400));
    assert_vaults(&mut test, campaign, 400, 100);

    // Bob's pledge reaches the goal exactly: the Funded event fires.
    let result = pledge(&mut test, campaign, &bob, 600);
    assert!(has_event(&result, "CrowdfundCampaign.Funded"));
    assert!(is_funded(&mut test, campaign));
    assert_eq!(pledge_count(&mut test, campaign), 2);

    // Alice pledges again: amounts accumulate per backer, backer count stays
    // at 2, and the Funded event does NOT fire a second time. Overfunding is
    // allowed: the total may exceed the goal.
    let result = pledge(&mut test, campaign, &alice, 100);
    assert!(!has_event(&result, "CrowdfundCampaign.Funded"));
    assert_eq!(my_pledge(&mut test, campaign, &alice), amt(500));
    assert_eq!(my_pledge(&mut test, campaign, &bob), amt(600));
    assert_eq!(pledge_count(&mut test, campaign), 2);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_100));
    assert_vaults(&mut test, campaign, 1_100, 100);
}

#[test]
fn pledge_at_deadline_boundary() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Boundary", PROMISE, 1_000, 5, 100);

    // Epoch 4 < deadline 5: pledging is still open.
    set_epoch(&mut test, 4);
    pledge(&mut test, campaign, &alice, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(100));
    assert_vaults(&mut test, campaign, 100, 100);

    // Epoch 5 == deadline: pledging is closed, and the rejection commits
    // nothing.
    set_epoch(&mut test, 5);
    expect_pledge_rejected(
        &mut test,
        campaign,
        &alice,
        100,
        "Campaign deadline has passed",
    );
    assert_eq!(total_pledged(&mut test, campaign), amt(100));
    assert_vaults(&mut test, campaign, 100, 100);
}

#[test]
fn early_claim_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Early claim",
        PROMISE,
        500,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 500);

    // Goal met, but epoch 0 < deadline 10: the creator must wait.
    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "Campaign deadline has not been reached",
    );
    assert_vaults(&mut test, campaign, 500, 100);
    assert!(!is_claimed(&mut test, campaign));
    assert_eq!(tranches_released(&mut test, campaign), 0);
}

#[test]
fn claim_by_non_creator_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Not yours",
        PROMISE,
        500,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, DEADLINE);

    expect_claim_rejected(
        &mut test,
        campaign,
        &alice,
        "Only the campaign creator can claim the funds",
    );
    assert_vaults(&mut test, campaign, 500, 100);
}

#[test]
fn claim_on_success_releases_three_tranches() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test, &creator, "Success", PROMISE, 1_000, DEADLINE, 100,
    );
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);

    // Tranche 1 at the deadline gate: 1000 / 3 floors to 333. The campaign
    // is NOT complete yet, and the accumulator total stays at 1000.
    set_epoch(&mut test, DEADLINE);
    let creator_before = account_tari_balance(&test, creator.account);
    let result = claim(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.TrancheReleased"));
    assert!(!has_event(&result, "CrowdfundCampaign.CampaignCompleted"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(333)
    );
    assert_vaults(&mut test, campaign, 667, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert!(is_funded(&mut test, campaign));
    assert!(!is_claimed(&mut test, campaign));
    assert_eq!(tranches_released(&mut test, campaign), 1);
    assert_eq!(next_tranche_epoch(&mut test, campaign), 82);

    // Tranche 2 at deadline + 72: another 333.
    set_epoch(&mut test, 82);
    let result = claim(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.TrancheReleased"));
    assert!(!has_event(&result, "CrowdfundCampaign.CampaignCompleted"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(666)
    );
    assert_vaults(&mut test, campaign, 334, 100);
    assert_eq!(tranches_released(&mut test, campaign), 2);
    assert_eq!(next_tranche_epoch(&mut test, campaign), 154);
    assert!(!is_claimed(&mut test, campaign));

    // Tranche 3 at deadline + 144: the remainder, 334. The campaign
    // completes; the three tranches sum to exactly the 1000 pledged.
    set_epoch(&mut test, 154);
    let result = claim(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.TrancheReleased"));
    assert!(has_event(&result, "CrowdfundCampaign.CampaignCompleted"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(1_000)
    );
    assert_vaults(&mut test, campaign, 0, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert!(is_funded(&mut test, campaign));
    assert!(is_claimed(&mut test, campaign));
    assert_eq!(tranches_released(&mut test, campaign), 3);

    // A fourth claim is rejected: all tranches are released.
    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "Campaign funds have already been claimed",
    );
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(1_000)
    );
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn claim_when_goal_missed_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Missed", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, DEADLINE);

    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "Funding goal was not met; backers may refund instead",
    );
    assert_vaults(&mut test, campaign, 500, 100);
}

#[test]
fn refunds_on_failure_repay_every_backer_in_full() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let stranger = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Refund me",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );

    let alice_initial = account_tari_balance(&test, alice.account);
    let bob_initial = account_tari_balance(&test, bob.account);
    pledge(&mut test, campaign, &alice, 300);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);

    // Someone who never pledged has nothing to refund.
    expect_refund_rejected(
        &mut test,
        campaign,
        &stranger,
        "No pledge to refund for this backer",
    );

    let result = refund(&mut test, campaign, &alice);
    assert!(has_event(&result, "CrowdfundCampaign.Refunded"));
    assert_eq!(account_tari_balance(&test, alice.account), alice_initial);
    assert_vaults(&mut test, campaign, 400, 100);
    // The accumulator total is untouched by refunds.
    assert_eq!(total_pledged(&mut test, campaign), amt(700));

    refund(&mut test, campaign, &bob);
    assert_eq!(account_tari_balance(&test, bob.account), bob_initial);
    assert_vaults(&mut test, campaign, 0, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(700));
    assert_eq!(pledge_count(&mut test, campaign), 0);
    assert!(!is_claimed(&mut test, campaign));
}

#[test]
fn double_refund_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Once only",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 300);
    set_epoch(&mut test, DEADLINE);

    refund(&mut test, campaign, &alice);
    let balance_after_first = account_tari_balance(&test, alice.account);

    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "No pledge to refund for this backer",
    );
    assert_eq!(
        account_tari_balance(&test, alice.account),
        balance_after_first
    );
    assert_vaults(&mut test, campaign, 0, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(300));
}

#[test]
fn refund_after_success_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Funded", PROMISE, 500, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, DEADLINE);

    // Goal met but not yet claimed: refunds are closed because the campaign
    // succeeded.
    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign reached its goal; refunds are closed",
    );

    // After tranche 1 releases, the message is STILL the goal message: the
    // campaign is not complete, so the "funds were claimed" guard has not
    // engaged yet.
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 334, 100);
    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign reached its goal; refunds are closed",
    );

    // Only after ALL THREE tranches release does the "funds were claimed"
    // message appear.
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 0, 100);
    assert!(is_claimed(&mut test, campaign));
    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign funds were claimed; refunds are closed",
    );
}

#[test]
fn refund_before_deadline_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Too early",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 300);

    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "Refunds open after the campaign deadline",
    );
    assert_vaults(&mut test, campaign, 300, 100);
}

#[test]
fn pledge_after_claim_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let backer = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Claimed", PROMISE, 100, DEADLINE, 100);
    pledge(&mut test, campaign, &backer, 100);
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    assert!(is_claimed(&mut test, campaign));

    // Rewind the epoch below the deadline. Only the harness epoch override
    // can do this — on-chain epochs never go backward, so this path is a
    // defensive guard in production. The rewind makes the deadline check
    // pass, so the already-released check must be the one that fires.
    set_epoch(&mut test, 5);
    expect_pledge_rejected(
        &mut test,
        campaign,
        &backer,
        10,
        "Campaign funds have already been released",
    );
    // v2 accumulator semantics: the total STAYS at the pledged amount after
    // completion; only the vault balance drops to zero.
    assert_eq!(total_pledged(&mut test, campaign), amt(100));
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn zero_amount_pledge_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let backer = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Zero pledge",
        PROMISE,
        100,
        DEADLINE,
        100,
    );

    expect_pledge_rejected(
        &mut test,
        campaign,
        &backer,
        0,
        "Pledge must be greater than zero",
    );
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn pledge_with_non_tari_token_is_rejected() {
    // This test loads a second, test-only template (tests/fixtures/test_token)
    // whose `mint` function creates a fresh public fungible token. Paying the
    // campaign with that token must be rejected: pledges are TARI-only.
    let mut test = TemplateTest::new(".", [".", "tests/fixtures/test_token"]);
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "TARI only",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );

    let token_template = test.get_template_address("TestTokenMinter");
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_function(token_template, "mint", args![100u64])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(campaign, "pledge", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "Pledges must be paid in TARI");

    // The rejection commits nothing: no pledge recorded, pledge vault still
    // empty (the bond vault still holds the bond), and a later TARI pledge
    // from the same backer still works.
    assert_eq!(total_pledged(&mut test, campaign), Amount::zero());
    assert_vaults(&mut test, campaign, 0, 100);
    assert_eq!(pledge_count(&mut test, campaign), 0);
    pledge(&mut test, campaign, &alice, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(100));
    assert_vaults(&mut test, campaign, 100, 100);
}

#[test]
fn campaign_creation_validates_inputs() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let template = test.get_template_address(TEMPLATE_NAME);

    // Zero goal.
    expect_create_rejected(
        &mut test,
        &creator,
        "Zero goal",
        PROMISE,
        0,
        DEADLINE,
        100,
        "Funding goal must be greater than zero",
    );

    // Deadline not in the future (current epoch is 0).
    expect_create_rejected(
        &mut test,
        &creator,
        "Past deadline",
        PROMISE,
        100,
        0,
        100,
        "Deadline epoch must be in the future",
    );

    // Empty title.
    expect_create_rejected(
        &mut test,
        &creator,
        "",
        PROMISE,
        100,
        DEADLINE,
        100,
        "Campaign title must not be empty",
    );

    // Title over the 120-character limit.
    expect_create_rejected(
        &mut test,
        &creator,
        &"y".repeat(121),
        PROMISE,
        100,
        DEADLINE,
        100,
        "Campaign title is too long",
    );

    // Empty promise.
    expect_create_rejected(
        &mut test,
        &creator,
        "No promise",
        "",
        100,
        DEADLINE,
        100,
        "Campaign promise must not be empty",
    );

    // Promise over the 280-character limit.
    expect_create_rejected(
        &mut test,
        &creator,
        "Long promise",
        &"p".repeat(281),
        100,
        DEADLINE,
        100,
        "Campaign promise is too long",
    );

    // Bond below the 100-unit floor.
    expect_create_rejected(
        &mut test,
        &creator,
        "Tiny bond",
        PROMISE,
        1_000,
        DEADLINE,
        99,
        "Creator bond is below the required minimum",
    );

    // Bond below 10% of a larger goal (required: 200).
    expect_create_rejected(
        &mut test,
        &creator,
        "Small bond",
        PROMISE,
        2_000,
        DEADLINE,
        150,
        "Creator bond is below the required minimum",
    );

    // No campaign component was created by any rejected transaction.
    assert!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .is_empty()
    );

    // A title at exactly the 120-character limit and a promise at exactly
    // the 280-character limit are accepted (boundaries).
    let title_120 = "y".repeat(120);
    let promise_280 = "p".repeat(280);
    let campaign = create_campaign(
        &mut test,
        &creator,
        &title_120,
        &promise_280,
        100,
        DEADLINE,
        100,
    );
    assert_eq!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        test.call_method::<String>(campaign, "promise", args![], vec![]),
        promise_280
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "required_bond", args![], vec![]),
        amt(100)
    );
    assert_vaults(&mut test, campaign, 0, 100);
}

// ---------------------------------------------------------------------------
// Edge cases E1–E30 (docs/MECHANISM-V2.md §9).
// ---------------------------------------------------------------------------

#[test]
fn e01_veto_at_exactly_half_fails() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E1", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 500);
    pledge(&mut test, campaign, &bob, 500);
    set_epoch(&mut test, DEADLINE);

    // Exactly 50%: the vote is recorded, but the veto does NOT succeed —
    // the threshold is strictly greater than half.
    let result = veto(&mut test, campaign, &alice);
    assert!(has_event(&result, "CrowdfundCampaign.VetoCast"));
    assert!(!has_event(&result, "CrowdfundCampaign.VetoSucceeded"));
    assert_eq!(veto_total(&mut test, campaign), amt(500));
    assert_eq!(my_veto(&mut test, campaign, &alice), amt(500));
    assert!(!is_vetoed(&mut test, campaign));
    assert_vaults(&mut test, campaign, 1_000, 100);

    // Releases continue: the creator claims tranche 1, which also clears
    // the recorded tally.
    claim(&mut test, campaign, &creator);
    assert_eq!(tranches_released(&mut test, campaign), 1);
    assert_eq!(veto_total(&mut test, campaign), Amount::zero());
    assert_eq!(my_veto(&mut test, campaign, &alice), Amount::zero());
    assert_vaults(&mut test, campaign, 667, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
}

#[test]
fn e02_veto_at_half_plus_one_succeeds() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E2", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 501);
    pledge(&mut test, campaign, &bob, 499);
    set_epoch(&mut test, DEADLINE);

    // 50% + 1 unit: the veto succeeds immediately.
    let result = veto(&mut test, campaign, &alice);
    assert!(has_event(&result, "CrowdfundCampaign.VetoCast"));
    assert!(has_event(&result, "CrowdfundCampaign.VetoSucceeded"));
    assert!(has_event(&result, "CrowdfundCampaign.BondForfeited"));
    assert!(is_vetoed(&mut test, campaign));

    // Remaining tranches are frozen; the vault is untouched.
    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "Campaign was vetoed; remaining funds are refundable to backers",
    );
    assert_vaults(&mut test, campaign, 1_000, 100);

    // Refunds + bond shares open: Alice 501 + 50, then Bob (last) takes the
    // remainder 499 + 50. Both vaults end at exactly zero.
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(551)
    );
    assert_vaults(&mut test, campaign, 499, 50);
    let bob_before = account_tari_balance(&test, bob.account);
    refund(&mut test, campaign, &bob);
    assert_eq!(
        account_tari_balance(&test, bob.account),
        bob_before + amt(549)
    );
    assert_vaults(&mut test, campaign, 0, 0);
    assert_eq!(pledge_count(&mut test, campaign), 0);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
}

#[test]
fn e03_veto_after_tranche_1_released() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E3", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);

    // Tranche 1 (333) releases to the creator first.
    let creator_before = account_tari_balance(&test, creator.account);
    claim(&mut test, campaign, &creator);
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(333)
    );
    assert_vaults(&mut test, campaign, 667, 100);

    // Alice's veto (600 > 400) freezes only tranches 2–3; refunds are
    // pro-rata on the 667 remainder plus the 100 bond.
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));
    assert_eq!(tranches_released(&mut test, campaign), 1);

    // Alice: 600*667/1000 = 400 vault + 600*100/1000 = 60 bond = 460.
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(460)
    );
    assert_vaults(&mut test, campaign, 267, 40);

    // Bob (last): the 267 + 40 remainder. Tranche 1 stays with the creator.
    let bob_before = account_tari_balance(&test, bob.account);
    refund(&mut test, campaign, &bob);
    assert_eq!(
        account_tari_balance(&test, bob.account),
        bob_before + amt(307)
    );
    assert_vaults(&mut test, campaign, 0, 0);
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(333)
    );
}

#[test]
fn e04_veto_before_tranche_1_claimed() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E4", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);

    // The veto lands before any claim: ALL tranches freeze, including
    // tranche 1. The full pool + bond are refundable.
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));
    assert_eq!(tranches_released(&mut test, campaign), 0);

    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(660)
    );
    assert_vaults(&mut test, campaign, 400, 40);
    let bob_before = account_tari_balance(&test, bob.account);
    refund(&mut test, campaign, &bob);
    assert_eq!(
        account_tari_balance(&test, bob.account),
        bob_before + amt(440)
    );
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e05_veto_by_zero_pledge_account_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let stranger = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E5", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);

    expect_veto_rejected(
        &mut test,
        campaign,
        &stranger,
        "No pledge to veto with for this backer",
    );
    assert_eq!(veto_total(&mut test, campaign), Amount::zero());
    assert!(!is_vetoed(&mut test, campaign));
    assert_vaults(&mut test, campaign, 1_000, 100);
}

#[test]
fn e06_same_backer_vetoes_twice_in_one_window() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E6", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 400);
    pledge(&mut test, campaign, &bob, 600);
    set_epoch(&mut test, DEADLINE);

    veto(&mut test, campaign, &alice);
    assert_eq!(veto_total(&mut test, campaign), amt(400));
    expect_veto_rejected(
        &mut test,
        campaign,
        &alice,
        "Backer has already vetoed this release",
    );
    // The rejected second vote changes nothing.
    assert_eq!(veto_total(&mut test, campaign), amt(400));
    assert!(!is_vetoed(&mut test, campaign));
    assert_vaults(&mut test, campaign, 1_000, 100);

    // Bob's fresh vote pushes the tally over the threshold.
    veto(&mut test, campaign, &bob);
    assert!(is_vetoed(&mut test, campaign));
    assert_eq!(veto_total(&mut test, campaign), amt(1_000));
}

#[test]
fn e07_veto_tally_resets_on_release() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E7", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 400);
    pledge(&mut test, campaign, &bob, 600);
    set_epoch(&mut test, DEADLINE);

    // Window 1: Alice objects, but 400 is not a majority.
    veto(&mut test, campaign, &alice);
    assert_eq!(veto_total(&mut test, campaign), amt(400));

    // Tranche 1 releases: the tally resets. Votes from window 1 do not
    // count in window 2.
    claim(&mut test, campaign, &creator);
    assert_eq!(veto_total(&mut test, campaign), Amount::zero());
    assert_eq!(my_veto(&mut test, campaign, &alice), Amount::zero());
    assert_vaults(&mut test, campaign, 667, 100);

    // Alice must vote again in the new window — and may: the double-vote
    // guard is per-window.
    veto(&mut test, campaign, &alice);
    assert_eq!(veto_total(&mut test, campaign), amt(400));
    assert_eq!(my_veto(&mut test, campaign, &alice), amt(400));
    assert!(!is_vetoed(&mut test, campaign));
}

#[test]
fn e08_abandonment_when_creator_never_claims() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let stranger = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E8", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);

    // Anyone may call abandon() at deadline + 72: the trigger is objective.
    set_epoch(&mut test, 82);
    let result = abandon(&mut test, campaign, &stranger);
    assert!(has_event(&result, "CrowdfundCampaign.Abandoned"));
    assert!(has_event(&result, "CrowdfundCampaign.BondForfeited"));
    assert!(is_abandoned(&mut test, campaign));
    assert!(!is_vetoed(&mut test, campaign));

    // A second abandonment is rejected, and the bond is forfeited.
    expect_abandon_rejected(
        &mut test,
        campaign,
        &stranger,
        "Campaign was already abandoned",
    );
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond was forfeited to backers",
    );
    assert_vaults(&mut test, campaign, 1_000, 100);

    // Full pool + bond refundable pro-rata.
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(660)
    );
    let bob_before = account_tari_balance(&test, bob.account);
    refund(&mut test, campaign, &bob);
    assert_eq!(
        account_tari_balance(&test, bob.account),
        bob_before + amt(440)
    );
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e09_abandonment_after_tranche_1() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E9", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 667, 100);

    // With one tranche released, abandonment opens at deadline + 144.
    set_epoch(&mut test, 154);
    abandon(&mut test, campaign, &alice);
    assert!(is_abandoned(&mut test, campaign));
    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "Campaign was abandoned; remaining funds are refundable to backers",
    );

    // Remainder + bond refundable pro-rata, as after a veto.
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(460)
    );
    assert_vaults(&mut test, campaign, 267, 40);
    let bob_before = account_tari_balance(&test, bob.account);
    refund(&mut test, campaign, &bob);
    assert_eq!(
        account_tari_balance(&test, bob.account),
        bob_before + amt(307)
    );
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e10_abandon_one_epoch_too_early_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E10", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);

    // One epoch before the first abandonment threshold (deadline + 72).
    set_epoch(&mut test, 81);
    expect_abandon_rejected(
        &mut test,
        campaign,
        &alice,
        "Creator has not abandoned the campaign yet",
    );
    assert!(!is_abandoned(&mut test, campaign));
    assert_vaults(&mut test, campaign, 1_000, 100);

    // The creator claims tranche 1 at epoch 82; the next abandonment
    // threshold moves to deadline + 144, so epoch 153 is still too early.
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 153);
    expect_abandon_rejected(
        &mut test,
        campaign,
        &alice,
        "Creator has not abandoned the campaign yet",
    );
    assert!(!is_abandoned(&mut test, campaign));
    assert_vaults(&mut test, campaign, 667, 100);

    // At epoch 154 abandonment succeeds, and the sole backer (last
    // refunder) takes the whole remainder plus the whole bond.
    set_epoch(&mut test, 154);
    abandon(&mut test, campaign, &alice);
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(767)
    );
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e11_abandon_on_failed_campaign_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E11", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 500);

    // Goal missed: refunds are already open, so abandonment is meaningless
    // — at the deadline and long past it.
    set_epoch(&mut test, DEADLINE);
    expect_abandon_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign did not reach its goal; refunds are already open",
    );
    set_epoch(&mut test, 82);
    expect_abandon_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign did not reach its goal; refunds are already open",
    );
    assert!(!is_abandoned(&mut test, campaign));

    // The failure path still works: full refund, and the bond returns.
    refund(&mut test, campaign, &alice);
    assert_vaults(&mut test, campaign, 0, 100);
    let creator_before = account_tari_balance(&test, creator.account);
    claim_bond(&mut test, campaign, &creator);
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(100)
    );
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e12_pledge_after_funding_success_post_deadline_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E12", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);

    expect_pledge_rejected(
        &mut test,
        campaign,
        &alice,
        100,
        "Campaign deadline has passed",
    );
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert_vaults(&mut test, campaign, 1_000, 100);
}

#[test]
fn e13_refund_on_funded_campaign_before_veto_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E13", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);

    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign reached its goal; refunds are closed",
    );
    assert_vaults(&mut test, campaign, 1_000, 100);
    assert_eq!(pledge_count(&mut test, campaign), 1);
}

#[test]
fn e14_refund_after_veto_remainder_dust_goes_to_last_refunder() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let carol = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E14", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 333);
    pledge(&mut test, campaign, &bob, 333);
    pledge(&mut test, campaign, &carol, 334);
    set_epoch(&mut test, DEADLINE);

    // Tranche 1 releases (333), leaving a 667 pool; then Alice + Bob veto
    // (666 > 334), freezing the rest.
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 667, 100);
    veto(&mut test, campaign, &alice);
    assert!(!is_vetoed(&mut test, campaign));
    veto(&mut test, campaign, &bob);
    assert!(is_vetoed(&mut test, campaign));

    // Floor shares: 333*667/1000 = 222 vault + 333*100/1000 = 33 bond = 255.
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(255)
    );
    assert_vaults(&mut test, campaign, 445, 67);

    let bob_before = account_tari_balance(&test, bob.account);
    refund(&mut test, campaign, &bob);
    assert_eq!(
        account_tari_balance(&test, bob.account),
        bob_before + amt(255)
    );
    assert_vaults(&mut test, campaign, 223, 34);

    // Carol's computed share would be 222 + 33 = 255, but as the last
    // refunder she receives the entire remainder: 223 + 34 = 257, i.e. her
    // shares plus all rounding dust (1 vault + 1 bond). Both vaults end at
    // exactly zero — confirmed through the getters AND the state store.
    let carol_before = account_tari_balance(&test, carol.account);
    refund(&mut test, campaign, &carol);
    assert_eq!(
        account_tari_balance(&test, carol.account),
        carol_before + amt(257)
    );
    assert_vaults(&mut test, campaign, 0, 0);
    assert_eq!(state_store_vault_sum(&test, campaign), Amount::zero());
    assert_eq!(pledge_count(&mut test, campaign), 0);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
}

#[test]
fn e15_refund_after_veto_then_second_refund_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E15", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));

    refund(&mut test, campaign, &alice);
    let alice_after_first = account_tari_balance(&test, alice.account);
    assert_vaults(&mut test, campaign, 400, 40);

    expect_refund_rejected(
        &mut test,
        campaign,
        &alice,
        "No pledge to refund for this backer",
    );
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_after_first
    );
    assert_vaults(&mut test, campaign, 400, 40);

    refund(&mut test, campaign, &bob);
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e16_bond_below_minimum_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let template = test.get_template_address(TEMPLATE_NAME);

    // Below the 100-unit floor.
    expect_create_rejected(
        &mut test,
        &creator,
        "E16a",
        PROMISE,
        1_000,
        DEADLINE,
        99,
        "Creator bond is below the required minimum",
    );
    // Below 10% of a larger goal (required: 500).
    expect_create_rejected(
        &mut test,
        &creator,
        "E16b",
        PROMISE,
        5_000,
        DEADLINE,
        499,
        "Creator bond is below the required minimum",
    );
    // Below the floor for a tiny goal (required: 100, not 5).
    expect_create_rejected(
        &mut test,
        &creator,
        "E16c",
        PROMISE,
        50,
        DEADLINE,
        99,
        "Creator bond is below the required minimum",
    );

    // No component was created by any rejected transaction.
    assert!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .is_empty()
    );

    // Exactly the minimum is accepted: 500 for a 5,000 goal.
    let campaign = create_campaign(&mut test, &creator, "E16 ok", PROMISE, 5_000, DEADLINE, 500);
    assert_eq!(
        test.call_method::<Amount>(campaign, "required_bond", args![], vec![]),
        amt(500)
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "bond_amount", args![], vec![]),
        amt(500)
    );
    assert_vaults(&mut test, campaign, 0, 500);

    // The floor binds for a tiny goal: 100 for a goal of 50.
    let mut test2 = TemplateTest::my_crate();
    let creator2 = new_actor(&mut test2);
    let tiny = create_campaign(
        &mut test2, &creator2, "E16 tiny", PROMISE, 50, DEADLINE, 100,
    );
    assert_eq!(
        test2.call_method::<Amount>(tiny, "required_bond", args![], vec![]),
        amt(100)
    );
    assert_vaults(&mut test2, tiny, 0, 100);
}

#[test]
fn e17_bond_overpayment_becomes_a_larger_bond() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    // Required bond is 100; the creator deposits 250. The whole deposit
    // becomes the bond.
    let campaign = create_campaign(&mut test, &creator, "E17", PROMISE, 1_000, DEADLINE, 250);
    assert_eq!(
        test.call_method::<Amount>(campaign, "bond_amount", args![], vec![]),
        amt(250)
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "required_bond", args![], vec![]),
        amt(100)
    );
    assert_vaults(&mut test, campaign, 0, 250);

    // On failure, ALL of it returns.
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, DEADLINE);
    let result = claim_bond(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.BondReturned"));
    assert_vaults(&mut test, campaign, 500, 0);
    refund(&mut test, campaign, &alice);
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn bond_overpayment_forfeits_in_full() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E17b", PROMISE, 1_000, DEADLINE, 250);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);

    // On veto, ALL of the overpaid bond goes to backers: the sole backer
    // (last refunder) receives pool 1000 + bond 250.
    veto(&mut test, campaign, &alice);
    let alice_before = account_tari_balance(&test, alice.account);
    refund(&mut test, campaign, &alice);
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before + amt(1_250)
    );
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e18_bond_with_non_tari_token_is_rejected() {
    // As in `pledge_with_non_tari_token_is_rejected`, the second template
    // mints a throwaway token; using it as the bond must be rejected.
    let mut test = TemplateTest::new(".", [".", "tests/fixtures/test_token"]);
    let creator = new_actor(&mut test);
    let template = test.get_template_address(TEMPLATE_NAME);
    let token_template = test.get_template_address("TestTokenMinter");

    let reason = test.execute_expect_failure(
        test.transaction()
            .call_function(token_template, "mint", args![500u64])
            .put_last_instruction_output_on_workspace("bond")
            .call_function(
                template,
                "new",
                args![
                    "E18".to_string(),
                    PROMISE.to_string(),
                    1_000,
                    DEADLINE,
                    Workspace("bond")
                ],
            )
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Bond must be paid in TARI");
    assert!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .is_empty()
    );

    // A TARI bond from the same creator still works afterwards.
    let campaign = create_campaign(&mut test, &creator, "E18 ok", PROMISE, 1_000, DEADLINE, 100);
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn e19_bond_returns_on_failure_before_refunds() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E19", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 300);
    pledge(&mut test, campaign, &bob, 200);
    set_epoch(&mut test, DEADLINE);

    // The bond returns even though no backer has refunded yet.
    let creator_before = account_tari_balance(&test, creator.account);
    let result = claim_bond(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.BondReturned"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(100)
    );
    assert_vaults(&mut test, campaign, 500, 0);

    // Refunds still pay in full afterwards.
    refund(&mut test, campaign, &alice);
    refund(&mut test, campaign, &bob);
    assert_vaults(&mut test, campaign, 0, 0);
    assert_eq!(total_pledged(&mut test, campaign), amt(500));

    // The bond returns only once.
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond has already been claimed",
    );
}

#[test]
fn e20_bond_returns_on_completion() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E20", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    assert!(is_claimed(&mut test, campaign));
    assert_vaults(&mut test, campaign, 0, 100);

    let creator_before = account_tari_balance(&test, creator.account);
    claim_bond(&mut test, campaign, &creator);
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(100)
    );
    assert_vaults(&mut test, campaign, 0, 0);

    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond has already been claimed",
    );
}

#[test]
fn e21_claim_bond_on_vetoed_campaign_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E21", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));

    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond was forfeited to backers",
    );
    // The bond stays locked for backers until they refund.
    assert_vaults(&mut test, campaign, 1_000, 100);
    refund(&mut test, campaign, &alice);
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e22_claim_bond_locked_messages() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E22", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);

    // Before the deadline: locked until the deadline. The creator check
    // fires first: a non-creator gets the authorization message instead.
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &alice,
        "Only the campaign creator can claim the bond",
    );
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond is locked until the campaign deadline",
    );

    // Funded but incomplete: locked until all releases complete — before
    // any claim, and after tranches 1 and 2.
    set_epoch(&mut test, DEADLINE);
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond is locked until all releases complete",
    );
    claim(&mut test, campaign, &creator);
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond is locked until all releases complete",
    );
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    expect_claim_bond_rejected(
        &mut test,
        campaign,
        &creator,
        "Bond is locked until all releases complete",
    );
    assert_vaults(&mut test, campaign, 334, 100);

    // Completion unlocks the bond.
    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    claim_bond(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 0, 0);
}

#[test]
fn e23_claim_one_epoch_before_gate_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E23", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 667, 100);

    // Tranche 2 opens at deadline + 72 = 82; epoch 81 is one too early.
    set_epoch(&mut test, 81);
    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "The next release has not opened yet",
    );
    assert_vaults(&mut test, campaign, 667, 100);
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 334, 100);

    // Tranche 3 opens at deadline + 144 = 154; epoch 153 is one too early.
    set_epoch(&mut test, 153);
    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "The next release has not opened yet",
    );
    assert_vaults(&mut test, campaign, 334, 100);
    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 0, 100);
    assert!(is_claimed(&mut test, campaign));
}

#[test]
fn e24_claim_by_non_creator_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E24", PROMISE, 500, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, DEADLINE);

    expect_claim_rejected(
        &mut test,
        campaign,
        &alice,
        "Only the campaign creator can claim the funds",
    );
    assert_vaults(&mut test, campaign, 500, 100);
    assert_eq!(tranches_released(&mut test, campaign), 0);
}

#[test]
fn e25_tranche_amounts_with_remainder() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E25", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);

    // Total 1000 -> 333 + 333 + 334; the sum is exactly 1000.
    set_epoch(&mut test, DEADLINE);
    let creator_before = account_tari_balance(&test, creator.account);
    let result = claim(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.TrancheReleased"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(333)
    );
    assert_vaults(&mut test, campaign, 667, 100);

    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(666)
    );
    assert_vaults(&mut test, campaign, 334, 100);

    set_epoch(&mut test, 154);
    let result = claim(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.CampaignCompleted"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + amt(1_000)
    );
    assert_vaults(&mut test, campaign, 0, 100);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
}

#[test]
fn e26_promise_empty_and_too_long_are_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let template = test.get_template_address(TEMPLATE_NAME);

    expect_create_rejected(
        &mut test,
        &creator,
        "E26a",
        "",
        100,
        DEADLINE,
        100,
        "Campaign promise must not be empty",
    );
    expect_create_rejected(
        &mut test,
        &creator,
        "E26b",
        &"p".repeat(281),
        100,
        DEADLINE,
        100,
        "Campaign promise is too long",
    );
    assert!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .is_empty()
    );

    // The 280-character boundary is accepted, and the stored promise is
    // exactly what was supplied.
    let promise_280 = "p".repeat(280);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "E26 ok",
        &promise_280,
        100,
        DEADLINE,
        100,
    );
    assert_eq!(
        test.call_method::<String>(campaign, "promise", args![], vec![]),
        promise_280
    );
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn e27_pledge_after_tranche_released_with_rewound_epoch_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E27", PROMISE, 100, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 100);
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    assert_vaults(&mut test, campaign, 67, 100);

    // Rewind below the deadline (harness-only): the deadline check passes,
    // so the already-released guard must fire.
    set_epoch(&mut test, 5);
    expect_pledge_rejected(
        &mut test,
        campaign,
        &alice,
        10,
        "Campaign funds have already been released",
    );
    assert_eq!(total_pledged(&mut test, campaign), amt(100));
    assert_vaults(&mut test, campaign, 67, 100);
}

#[test]
fn e28_claim_after_veto_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E28", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));

    expect_claim_rejected(
        &mut test,
        campaign,
        &creator,
        "Campaign was vetoed; remaining funds are refundable to backers",
    );
    // The vault is untouched by the rejected claim.
    assert_vaults(&mut test, campaign, 1_000, 100);
    assert_eq!(tranches_released(&mut test, campaign), 0);
}

#[test]
fn e29_veto_on_failed_campaign_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E29", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, DEADLINE);

    expect_veto_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign did not reach its goal; refunds are already open",
    );
    assert!(!is_vetoed(&mut test, campaign));
    assert_eq!(veto_total(&mut test, campaign), Amount::zero());

    // Refunds are indeed already open.
    refund(&mut test, campaign, &alice);
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn e30_accumulator_totals_stable_after_releases() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "E30", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);

    // Before any release: total 1000, funded, vault holds everything.
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert!(is_funded(&mut test, campaign));
    assert_vaults(&mut test, campaign, 1_000, 100);
    assert_eq!(next_tranche_epoch(&mut test, campaign), 10);

    // After each release the accumulator totals stay put; only the vault
    // balance drops and the next gate advances.
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert!(is_funded(&mut test, campaign));
    assert_vaults(&mut test, campaign, 667, 100);
    assert_eq!(next_tranche_epoch(&mut test, campaign), 82);

    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert!(is_funded(&mut test, campaign));
    assert_vaults(&mut test, campaign, 334, 100);
    assert_eq!(next_tranche_epoch(&mut test, campaign), 154);

    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert!(is_funded(&mut test, campaign));
    assert!(is_claimed(&mut test, campaign));
    assert_vaults(&mut test, campaign, 0, 100);
    assert_eq!(next_tranche_epoch(&mut test, campaign), 226);
}

// ---------------------------------------------------------------------------
// Additional guard coverage: check-order corners the E-table implies but
// does not name individually.
// ---------------------------------------------------------------------------

#[test]
fn veto_before_deadline_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Early veto",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 1_000);

    expect_veto_rejected(
        &mut test,
        campaign,
        &alice,
        "Veto opens after the campaign deadline",
    );
    assert_eq!(veto_total(&mut test, campaign), Amount::zero());
    assert_vaults(&mut test, campaign, 1_000, 100);
}

#[test]
fn veto_and_abandon_after_completion_are_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test, &creator, "Complete", PROMISE, 1_000, DEADLINE, 100,
    );
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, DEADLINE);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 82);
    claim(&mut test, campaign, &creator);
    set_epoch(&mut test, 154);
    claim(&mut test, campaign, &creator);
    assert!(is_claimed(&mut test, campaign));

    expect_veto_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign is complete; veto is closed",
    );
    expect_abandon_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign is complete; abandonment is closed",
    );
    assert_vaults(&mut test, campaign, 0, 100);
}

#[test]
fn abandon_after_veto_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Vetoed", PROMISE, 1_000, DEADLINE, 100);
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, 82);
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));

    expect_abandon_rejected(&mut test, campaign, &alice, "Campaign was already vetoed");
    assert!(!is_abandoned(&mut test, campaign));
    assert_vaults(&mut test, campaign, 1_000, 100);
}

#[test]
fn veto_after_abandon_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Abandoned",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, 82);
    abandon(&mut test, campaign, &alice);
    assert!(is_abandoned(&mut test, campaign));

    expect_veto_rejected(
        &mut test,
        campaign,
        &alice,
        "Campaign was abandoned; veto is closed",
    );
    assert_vaults(&mut test, campaign, 1_000, 100);
}

#[test]
fn pledge_after_veto_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Vetoed pledges",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, DEADLINE);
    veto(&mut test, campaign, &alice);
    assert!(is_vetoed(&mut test, campaign));

    // Rewind below the deadline (harness-only) so the deadline and
    // already-released guards pass and the vetoed guard must fire.
    set_epoch(&mut test, 5);
    expect_pledge_rejected(
        &mut test,
        campaign,
        &bob,
        10,
        "Campaign was vetoed; pledges are closed",
    );
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert_vaults(&mut test, campaign, 1_000, 100);
}

#[test]
fn pledge_after_abandon_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(
        &mut test,
        &creator,
        "Abandoned pledges",
        PROMISE,
        1_000,
        DEADLINE,
        100,
    );
    pledge(&mut test, campaign, &alice, 1_000);
    set_epoch(&mut test, 82);
    abandon(&mut test, campaign, &alice);
    assert!(is_abandoned(&mut test, campaign));

    // Rewind below the deadline (harness-only) so the deadline and
    // already-released guards pass and the abandoned guard must fire.
    set_epoch(&mut test, 5);
    expect_pledge_rejected(
        &mut test,
        campaign,
        &alice,
        10,
        "Campaign was abandoned; pledges are closed",
    );
    assert_eq!(total_pledged(&mut test, campaign), amt(1_000));
    assert_vaults(&mut test, campaign, 1_000, 100);
}
