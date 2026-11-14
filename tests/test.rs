// Engine tests for the CrowdfundCampaign template.
//
// These run the real Ootle engine in-process (tari_template_test_tooling):
// a passing test means the engine accepted the transaction. No network,
// funds, or faucet is involved. Epochs are overridden with virtual substates.

use tari_template_lib::types::{
    Amount, ComponentAddress, NonFungibleAddress, constants::TARI_TOKEN,
};
use tari_template_test_tooling::{
    TemplateTest,
    crypto::RistrettoSecretKey,
    engine_types::{
        commit_result::ExecuteResult,
        virtual_substate::{VirtualSubstate, VirtualSubstateId},
    },
    support::assert_error::assert_reject_reason,
    transaction::args,
};

const TEMPLATE_NAME: &str = "CrowdfundCampaign";

/// One test identity: a funded account plus the key/proof that seals its txs.
struct Actor {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
}

fn new_actor(test: &mut TemplateTest) -> Actor {
    let (account, proof, key) = test.create_funded_account();
    Actor {
        account,
        proof,
        key,
    }
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(epoch),
    );
}

fn account_tari_balance(test: &TemplateTest, account: ComponentAddress) -> Amount {
    test.read_only_state_store()
        .get_vaults_for_account(account)
        .unwrap()
        .get(&TARI_TOKEN)
        .map(|vault| vault.balance())
        .unwrap_or_else(Amount::zero)
}

fn campaign_vault_balance(test: &TemplateTest, campaign: ComponentAddress) -> Amount {
    test.read_only_state_store()
        .get_vaults_for_component(campaign)
        .unwrap()
        .values()
        .map(|vault| vault.balance())
        .fold(Amount::zero(), |acc, balance| acc + balance)
}

fn create_campaign(
    test: &mut TemplateTest,
    creator: &Actor,
    title: &str,
    goal: u64,
    deadline: u64,
) -> ComponentAddress {
    let template = test.get_template_address(TEMPLATE_NAME);
    test.execute_expect_success(
        test.transaction()
            .call_function(template, "new", args![title.to_string(), goal, deadline])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    test.read_only_state_store()
        .get_components_by_template_address(template)
        .unwrap()
        .remove(0)
        .0
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

#[test]
fn campaign_creation_records_state_and_emits_event() {
    let mut test = TemplateTest::my_crate();
    let template = test.get_template_address(TEMPLATE_NAME);

    // The harness identity creates the campaign, so the recorded creator key
    // can be compared exactly against the harness public key bytes.
    let result = test.execute_expect_success(
        test.transaction()
            .call_function(
                template,
                "new",
                args!["Fund the community radio".to_string(), 1_000, 10],
            )
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
    assert!(has_event(&result, "CrowdfundCampaign.CampaignCreated"));

    let (campaign, _) = test
        .read_only_state_store()
        .get_components_by_template_address(template)
        .unwrap()
        .remove(0);

    assert_eq!(
        test.call_method::<Amount>(campaign, "goal", args![], vec![]),
        Amount::from(1_000u64)
    );
    assert_eq!(
        test.call_method::<u64>(campaign, "deadline_epoch", args![], vec![]),
        10
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
        test.to_public_key_bytes()
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::zero()
    );
    assert_eq!(
        test.call_method::<u64>(campaign, "pledge_count", args![], vec![]),
        0
    );
    assert!(!test.call_method::<bool>(campaign, "is_claimed", args![], vec![]));
    assert!(!test.call_method::<bool>(campaign, "is_funded", args![], vec![]));
    assert_eq!(campaign_vault_balance(&test, campaign), Amount::zero());
}

#[test]
fn pledges_accumulate_and_funding_event_fires_once() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);

    let campaign = create_campaign(&mut test, &creator, "Open-source feature", 1_000, 10);

    let alice_before = account_tari_balance(&test, alice.account);
    let result = pledge(&mut test, campaign, &alice, 400);
    assert!(has_event(&result, "CrowdfundCampaign.Pledged"));
    assert!(!has_event(&result, "CrowdfundCampaign.Funded"));
    assert_eq!(
        account_tari_balance(&test, alice.account),
        alice_before - Amount::from(400u64)
    );
    assert_eq!(my_pledge(&mut test, campaign, &alice), Amount::from(400u64));
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::from(400u64)
    );

    // Bob's pledge reaches the goal exactly: the Funded event fires.
    let result = pledge(&mut test, campaign, &bob, 600);
    assert!(has_event(&result, "CrowdfundCampaign.Funded"));
    assert!(test.call_method::<bool>(campaign, "is_funded", args![], vec![]));
    assert_eq!(
        test.call_method::<u64>(campaign, "pledge_count", args![], vec![]),
        2
    );

    // Alice pledges again: amounts accumulate per backer, backer count stays
    // at 2, and the Funded event does NOT fire a second time. Overfunding is
    // allowed: the total may exceed the goal.
    let result = pledge(&mut test, campaign, &alice, 100);
    assert!(!has_event(&result, "CrowdfundCampaign.Funded"));
    assert_eq!(my_pledge(&mut test, campaign, &alice), Amount::from(500u64));
    assert_eq!(my_pledge(&mut test, campaign, &bob), Amount::from(600u64));
    assert_eq!(
        test.call_method::<u64>(campaign, "pledge_count", args![], vec![]),
        2
    );
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::from(1_100u64)
    );
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(1_100u64)
    );
}

#[test]
fn pledge_at_deadline_boundary() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Boundary", 1_000, 5);

    // Epoch 4 < deadline 5: pledging is still open.
    set_epoch(&mut test, 4);
    pledge(&mut test, campaign, &alice, 100);
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::from(100u64)
    );

    // Epoch 5 == deadline: pledging is closed, and the rejection commits
    // nothing.
    set_epoch(&mut test, 5);
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(alice.account, "withdraw", args![TARI_TOKEN, 100])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(campaign, "pledge", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign deadline has passed");
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::from(100u64)
    );
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(100u64)
    );
}

#[test]
fn early_claim_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Early claim", 500, 10);
    pledge(&mut test, campaign, &alice, 500);

    // Goal met, but epoch 0 < deadline 10: the creator must wait.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "claim", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(creator.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign deadline has not been reached");
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(500u64)
    );
    assert!(!test.call_method::<bool>(campaign, "is_claimed", args![], vec![]));
}

#[test]
fn claim_by_non_creator_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Not yours", 500, 10);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, 10);

    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "claim", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(alice.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "Only the campaign creator can claim the funds");
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(500u64)
    );
}

#[test]
fn claim_on_success_pays_creator_exactly_once() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Success", 1_000, 10);
    pledge(&mut test, campaign, &alice, 600);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, 10);

    let creator_before = account_tari_balance(&test, creator.account);
    let result = claim(&mut test, campaign, &creator);
    assert!(has_event(&result, "CrowdfundCampaign.Claimed"));
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + Amount::from(1_000u64)
    );
    assert_eq!(campaign_vault_balance(&test, campaign), Amount::zero());
    assert!(test.call_method::<bool>(campaign, "is_claimed", args![], vec![]));

    // A second claim is rejected: the vault is empty and `claimed` is set.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "claim", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(creator.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign funds have already been claimed");
    assert_eq!(
        account_tari_balance(&test, creator.account),
        creator_before + Amount::from(1_000u64)
    );
}

#[test]
fn claim_when_goal_missed_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Missed", 1_000, 10);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, 10);

    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "claim", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(creator.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Funding goal was not met");
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(500u64)
    );
}

#[test]
fn refunds_on_failure_repay_every_backer_in_full() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let bob = new_actor(&mut test);
    let stranger = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Refund me", 1_000, 10);

    let alice_initial = account_tari_balance(&test, alice.account);
    let bob_initial = account_tari_balance(&test, bob.account);
    pledge(&mut test, campaign, &alice, 300);
    pledge(&mut test, campaign, &bob, 400);
    set_epoch(&mut test, 10);

    // Someone who never pledged has nothing to refund.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(stranger.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&stranger.key),
        vec![stranger.proof.clone()],
    );
    assert_reject_reason(reason, "No pledge to refund for this backer");

    let result = refund(&mut test, campaign, &alice);
    assert!(has_event(&result, "CrowdfundCampaign.Refunded"));
    assert_eq!(account_tari_balance(&test, alice.account), alice_initial);
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(400u64)
    );

    refund(&mut test, campaign, &bob);
    assert_eq!(account_tari_balance(&test, bob.account), bob_initial);
    assert_eq!(campaign_vault_balance(&test, campaign), Amount::zero());
    assert_eq!(
        test.call_method::<u64>(campaign, "pledge_count", args![], vec![]),
        0
    );
    assert!(!test.call_method::<bool>(campaign, "is_claimed", args![], vec![]));
}

#[test]
fn double_refund_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Once only", 1_000, 10);
    pledge(&mut test, campaign, &alice, 300);
    set_epoch(&mut test, 10);

    refund(&mut test, campaign, &alice);
    let balance_after_first = account_tari_balance(&test, alice.account);

    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(alice.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "No pledge to refund for this backer");
    assert_eq!(
        account_tari_balance(&test, alice.account),
        balance_after_first
    );
    assert_eq!(campaign_vault_balance(&test, campaign), Amount::zero());
}

#[test]
fn refund_after_success_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Funded", 500, 10);
    pledge(&mut test, campaign, &alice, 500);
    set_epoch(&mut test, 10);

    // Goal met but not yet claimed: refunds are closed because the campaign
    // succeeded.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(alice.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign reached its goal; refunds are closed");

    // After the creator claims, refunds stay closed.
    claim(&mut test, campaign, &creator);
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(alice.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign funds were claimed; refunds are closed");
}

#[test]
fn refund_before_deadline_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "Too early", 1_000, 10);
    pledge(&mut test, campaign, &alice, 300);

    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(campaign, "refund", args![])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(alice.account, "deposit", args![Workspace("funds")])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(reason, "Refunds open after the campaign deadline");
    assert_eq!(
        campaign_vault_balance(&test, campaign),
        Amount::from(300u64)
    );
}

#[test]
fn pledge_with_non_tari_token_is_rejected() {
    // This test loads a second, test-only template (tests/fixtures/test_token)
    // whose `mint` function creates a fresh public fungible token. Paying the
    // campaign with that token must be rejected: pledges are TARI-only.
    let mut test = TemplateTest::new(".", [".", "tests/fixtures/test_token"]);
    let creator = new_actor(&mut test);
    let alice = new_actor(&mut test);
    let campaign = create_campaign(&mut test, &creator, "TARI only", 1_000, 10);

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

    // The rejection commits nothing: no pledge recorded, vault still empty,
    // and a later TARI pledge from the same backer still works.
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::zero()
    );
    assert_eq!(campaign_vault_balance(&test, campaign), Amount::zero());
    assert_eq!(
        test.call_method::<u64>(campaign, "pledge_count", args![], vec![]),
        0
    );
    pledge(&mut test, campaign, &alice, 100);
    assert_eq!(
        test.call_method::<Amount>(campaign, "total_pledged", args![], vec![]),
        Amount::from(100u64)
    );
}

#[test]
fn campaign_creation_validates_inputs() {
    let mut test = TemplateTest::my_crate();
    let creator = new_actor(&mut test);
    let template = test.get_template_address(TEMPLATE_NAME);

    // Zero goal.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args!["Zero goal".to_string(), 0, 10])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Funding goal must be greater than zero");

    // Deadline not in the future (current epoch is 0).
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args!["Past deadline".to_string(), 100, 0])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Deadline epoch must be in the future");

    // Empty title.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args!["".to_string(), 100, 10])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign title must not be empty");

    // Title over the 120-character limit.
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args!["y".repeat(121), 100, 10])
            .build_and_seal(&creator.key),
        vec![creator.proof.clone()],
    );
    assert_reject_reason(reason, "Campaign title is too long");

    // No campaign component was created by any rejected transaction.
    assert!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .is_empty()
    );

    // A title at exactly the 120-character limit is accepted (boundary).
    let title_120 = "y".repeat(120);
    let _campaign = create_campaign(&mut test, &creator, &title_120, 100, 10);
    assert_eq!(
        test.read_only_state_store()
            .get_components_by_template_address(template)
            .unwrap()
            .len(),
        1
    );
}
