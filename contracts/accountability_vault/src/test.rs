use soroban_sdk::{Env, Vec};

use crate::{AccountabilityVaultContract, ContractError, MAX_MILESTONES, Milestone};

#[test]
fn create_vault_rejects_more_than_max_milestones() {
    let env = Env::default();
    let mut milestones = Vec::new(&env);
    for _ in 0..(MAX_MILESTONES + 1) {
        milestones.push_back(Milestone { verified: false });
    }

    let result = AccountabilityVaultContract::create_vault(env.clone(), milestones);
    assert_eq!(result, Err(ContractError::TooManyMilestones));
}

#[test]
fn create_vault_allows_max_milestones() {
    let env = Env::default();
    let mut milestones = Vec::new(&env);
    for _ in 0..MAX_MILESTONES {
        milestones.push_back(Milestone { verified: false });
    }

    let result = AccountabilityVaultContract::create_vault(env.clone(), milestones);
    assert!(result.is_ok());
#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, vec, Address, Env, String, Symbol,
};
use serde_json::json;
use std::fs;

/// Creates a deterministic 32-byte evidence hash for use in tests.
fn evidence_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        token::StellarAssetClient::new(env, &address),
    )
}

struct Setup {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    token: Address,
    creator: Address,
    verifier: Address,
    guardian: Address,
    success: Address,
    failure: Address,
    vault_id: String,
}

fn setup(milestone_due_offsets: &[u64], amounts: &[i128]) -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    let total: i128 = amounts.iter().sum();
    token_admin_client.mint(&creator, &total);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let vault_id = String::from_str(&env, "v1");

    let mut milestones = vec![&env];
    for (i, due) in milestone_due_offsets.iter().enumerate() {
        milestones.push_back(Milestone {
            title: String::from_str(&env, "m"),
            amount: amounts[i],
            due_date: 1_000 + due,
            verified: false,
            released: false,
        });
    }

    let end = 1_000 + milestone_due_offsets.iter().max().copied().unwrap_or(0);
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier,
        &token,
        &total,
        &success,
        &failure,
        &end,
        &milestones,
        &guardian,
    );

    let result = Contract::create_vault(
        env,
        contract,
        token,
        creator,
        600, // Total amount matches sum of milestones
        verifier,
        guardian,
        success,
        failure,
        vault_id,
    }
}

#[test]
fn test_create_and_stake() {
    let s = setup(&[100], &[500]);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Draft);

    s.contract.stake(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 0);
}

#[test]
fn test_abi_spec_snapshot() {
    // Build a stable JSON representation of the contract ABI.
    let spec = json!({
        "name": "AccountabilityVault",
        "functions": [
            {"name":"create_vault","params":["String","Address","VerifierSet","Option<Address>","Address","i128","Address","Address","u64","Vec<Milestone>","Address"],"result":"Result<(), Error>"},
            {"name":"stake","params":["String","Address"],"result":"Result<(), Error>"},
            {"name":"stake_from","params":["String","Address","Address"],"result":"Result<(), Error>"},
            {"name":"check_in","params":["Address","u32","BytesN<32>"],"result":"Result<(), Error>"},
            {"name":"extend_deadline","params":["String","Address","u64"],"result":"Result<(), Error>"},
            {"name":"slash_on_miss","params":[],"result":"Result<(), Error>"},
            {"name":"claim","params":["Address"],"result":"Result<(), Error>"},
            {"name":"claim_milestone","params":["Address","u32"],"result":"Result<(), Error>"},
            {"name":"cancel_vault","params":["String","Address"],"result":"Result<(), Error>"},
            {"name":"withdraw","params":["String","Address"],"result":"Result<(), Error>"},
            {"name":"admin_dispute","params":["String","Address"],"result":"Result<(), Error>"},
            {"name":"admin_resolve","params":["String","Address","VaultStatus"],"result":"Result<(), Error>"},
            {"name":"emergency_pause","params":["Address"],"result":"Result<(), Error>"},
            {"name":"emergency_unpause","params":["Address"],"result":"Result<(), Error>"},
            {"name":"get_vault","params":["String"],"result":"Result<Vault, Error>"},
            {"name":"reclaim_after_settlement","params":["Address"],"result":"Result<(), Error>"},
            {"name":"configure_window","params":["u64"],"result":"()"},
            {"name":"dispute_milestone","params":["String","Address","u32"],"result":"Result<(), Error>"}
        ]
    });

    let pretty = serde_json::to_string_pretty(&spec).unwrap();

    if std::env::var("UPDATE_SOROBAN_SPEC").is_ok() {
        fs::create_dir_all("spec").ok();
        fs::write("spec/AccountabilityVault.spec.json", &pretty).unwrap();
    } else {
        let want = fs::read_to_string("spec/AccountabilityVault.spec.json").expect("snapshot missing; set UPDATE_SOROBAN_SPEC=1 to update");
        assert_eq!(pretty, want);
    }
}

#[test]
fn test_check_in_and_claim_success() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.contract.check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));
    s.contract.check_in(&s.vault_id, &s.verifier, &1, &evidence_hash(&s.env, 1));

    s.contract.claim(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Completed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 1000);
}

#[test]
fn test_check_in_out_of_range_returns_typed_error() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let result = s.contract.try_check_in(&s.verifier, &1);

    assert!(matches!(result, Err(Ok(Error::MilestoneIndexOutOfRange))));
}

#[test]
fn test_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Advance past the deadline without any check-in.
    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
}

#[test]
fn test_token_admin_balance_invariant_success_lifecycle() {
    let s = setup(&[100, 200], &[300, 700]);
    let token_client = token::Client::new(&s.env, &s.token);
    let admin_balance_before = token_client.balance(&s.token_admin);

    // Stake should only move creator -> vault.
    s.contract.stake(&s.vault_id, &s.creator);
    assert_token_admin_balance_unchanged(&token_client, &s.token_admin, admin_balance_before);

    // Check-ins should not move any tokens.
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 7));
    assert_token_admin_balance_unchanged(&token_client, &s.token_admin, admin_balance_before);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &1, &evidence_hash(&s.env, 9));
    assert_token_admin_balance_unchanged(&token_client, &s.token_admin, admin_balance_before);

    // Claim should move vault -> success destination only.
    s.contract.claim(&s.vault_id, &s.creator);
    assert_token_admin_balance_unchanged(&token_client, &s.token_admin, admin_balance_before);
}

#[test]
fn test_token_admin_balance_invariant_slash_lifecycle() {
    let s = setup(&[100], &[500]);
    let token_client = token::Client::new(&s.env, &s.token);
    let admin_balance_before = token_client.balance(&s.token_admin);

    // Stake should only move creator -> vault.
    s.contract.stake(&s.vault_id, &s.creator);
    assert_token_admin_balance_unchanged(&token_client, &s.token_admin, admin_balance_before);

    // Slash should move vault -> failure destination only.
    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss(&s.vault_id);
    assert_token_admin_balance_unchanged(&token_client, &s.token_admin, admin_balance_before);
}

#[test]
fn test_withdraw_draft_cancels() {
    let s = setup(&[100], &[500]);
    s.contract.cancel_vault(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Cancelled);
}

// ── cross-feature: stake_from then oracle check_in then claim ────────────────

#[test]
fn test_cancel_vault_then_stake_rejected_with_not_draft() {
    let s = setup(&[100], &[500]);
    s.contract.cancel_vault(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Cancelled);

    // Terminal-state regression guard: Cancelled vault must never accept stake.
    assert_stake_rejected_with_not_draft(&s);
}

#[test]
fn test_withdraw_active_refunds_creator() {
    let s = setup(&[100], &[500]);
    // Fund the vault and then call withdraw without any check-ins.
    s.contract.stake(&s.vault_id, &s.creator);

    s.contract.withdraw(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Cancelled);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 500);
}

#[test]
fn test_withdraw_cancelled_then_stake_rejected_with_not_draft() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.withdraw(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Cancelled);

    // Terminal-state regression guard: once cancelled via withdraw, staking is blocked.
    assert_stake_rejected_with_not_draft(&s);
}

#[test]
#[should_panic]
fn test_claim_before_all_verified_fails() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));
    // Second milestone not yet verified -> claim must fail.
    s.contract.claim(&s.vault_id, &s.creator);
}

#[test]
#[should_panic]
fn test_slash_before_deadline_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.slash_on_miss(&s.vault_id);
}


/// Extracts the first XDR-decoded topic from an emitted event tuple.
/// Soroban testutils return events as `(contract_id, topics_vec, data)`.
/// The topics vector is a `Vec<Val>` — we pull index 0 and try to read it as Symbol.
fn first_topic_as_symbol(env: &Env, event_index: usize) -> Option<Symbol> {
    use soroban_sdk::IntoVal;
    let events = env.events().all();
    let (_, topics, _) = events.get(event_index as u32)?;
    let raw: soroban_sdk::Val = topics.get(0)?;
    Symbol::try_from_val(env, &raw).ok()
}

#[test]
fn test_vault_created_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    // create_vault is called inside setup; it is the first (and only so far) event.
    let events = s.env.events().all();
    assert!(!events.is_empty(), "expected at least one event");
    let (_, topics, _) = events.get(0).unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let expected = Symbol::new(&s.env, "vault_created");
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, expected);
}

#[test]
fn test_vault_staked_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Events: [vault_created(0), vault_staked(1)]
    let events = s.env.events().all();
    assert!(events.len() >= 2, "expected at least vault_created + vault_staked");
    let (_, topics, _) = events.get(1).unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_staked"));
}

#[test]
fn test_milestone_checked_in_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0);

    // Events: [vault_created(0), vault_staked(1), milestone_checked_in(2)]
    let events = s.env.events().all();
    assert!(events.len() >= 3);
    let (_, topics, _) = events.get(2).unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "milestone_checked_in"));
}

#[test]
fn test_milestone_checked_in_source_topic_is_symbol() {
    // The third topic (source) must be a Symbol "verifier" or "oracle".
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0);

    let events = s.env.events().all();
    assert!(events.len() >= 3);
    let (_, topics, _) = events.get(2).unwrap();
    // topics: [milestone_checked_in, caller, source]
    let source_val: soroban_sdk::Val = topics.get(2).unwrap();
    let source = Symbol::try_from_val(&s.env, &source_val).expect("source topic must be a Symbol");
    // Verifier-driven check_in must carry source = "verifier"
    assert_eq!(source, soroban_sdk::symbol_short!("verifier"));
}

#[test]
fn test_oracle_check_in_source_topic_is_oracle_symbol() {
    // We need the oracle address generated in the same env as the setup.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let oracle = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &Some(oracle.clone()),
        &token,
        &500,
        &success,
        &failure,
        &1_200,
        &milestones,
        &guardian,
    );
    contract.stake(&vault_id, &creator);
    contract.check_in(&vault_id, &oracle, &0);

    // Events: [vault_created(0), vault_staked(1), milestone_checked_in(2)]
    let events = env.events().all();
    assert!(events.len() >= 3);
    let (_, topics, _) = events.get(2).unwrap();
    // topics: [milestone_checked_in, caller, source]
    let source_val: soroban_sdk::Val = topics.get(2).unwrap();
    let source = Symbol::try_from_val(&env, &source_val).expect("source topic must be a Symbol");
    assert_eq!(source, soroban_sdk::symbol_short!("oracle"));
}

#[test]
fn test_vault_slashed_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss(&s.vault_id);

    // Events: [vault_created(0), vault_staked(1), vault_slashed(2)]
    let events = s.env.events().all();
    assert!(events.len() >= 3);
    let (_, topics, _) = events.get(2).unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_slashed"));
}

#[test]
fn test_vault_completed_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0);
    s.contract.claim(&s.vault_id, &s.creator);

    // Events: [vault_created(0), vault_staked(1), milestone_checked_in(2), vault_completed(3)]
    let events = s.env.events().all();
    assert!(events.len() >= 4);
    let (_, topics, _) = events.last().unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_completed"));
}

#[test]
fn test_vault_cancelled_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.withdraw(&s.vault_id, &s.creator);

    // Events: [vault_created(0), vault_cancelled(1)]
    let events = s.env.events().all();
    assert!(events.len() >= 2);
    let (_, topics, _) = events.get(1).unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_cancelled"));
}

#[test]
fn test_vault_withdrawn_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    // Advance to deadline without any check-in, then try withdraw — but since
    // withdraw on an Active vault with no verified milestones is allowed, use that path.
    s.contract.withdraw(&s.vault_id, &s.creator);

    // Events: [vault_created(0), vault_staked(1), vault_withdrawn(2)]
    let events = s.env.events().all();
    assert!(events.len() >= 3);
    let (_, topics, _) = events.last().unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_withdrawn"));
}

#[test]
fn test_deadline_extended_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    s.contract.extend_deadline(&s.vault_id, &s.creator, &(vault.end_timestamp + 500));

    // Events: [vault_created(0), vault_staked(1), deadline_extended(2)]
    let events = s.env.events().all();
    assert!(events.len() >= 3);
    let (_, topics, _) = events.last().unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "deadline_extended"));
}

#[test]
fn test_vault_paused_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.emergency_pause(&s.vault_id, &s.guardian);

    let events = s.env.events().all();
    let (_, topics, _) = events.last().unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_paused"));
}

#[test]
fn test_vault_unpaused_emits_symbol_topic() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.emergency_pause(&s.vault_id, &s.guardian);
    s.contract.emergency_unpause(&s.vault_id, &s.guardian);

    let events = s.env.events().all();
    let (_, topics, _) = events.last().unwrap();
    let topic0: soroban_sdk::Val = topics.get(0).unwrap();
    let actual = Symbol::try_from_val(&s.env, &topic0).expect("topic[0] must be a Symbol");
    assert_eq!(actual, Symbol::new(&s.env, "vault_unpaused"));
}

// ── security: cap deadline horizon to MAX_DEADLINE_HORIZON (5 years) ──────────

#[test]
#[should_panic]
fn test_create_vault_deadline_exceeds_max_horizon_fails() {
    // end_timestamp more than 5 years in the future must be rejected.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _) = create_token(&env, &token_admin);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_000 + MAX_DEADLINE_HORIZON + 1,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    // 5 years + 1 second — must fail with InvalidDeadline.
    let end_timestamp = 1_000 + MAX_DEADLINE_HORIZON + 1;
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &500,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
        &guardian,
    );
}

#[test]
fn test_create_vault_deadline_at_max_horizon_succeeds() {
    // end_timestamp exactly at the 5-year boundary should succeed.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_000 + MAX_DEADLINE_HORIZON,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    // Exactly 5 years — should succeed.
    let end_timestamp = 1_000 + MAX_DEADLINE_HORIZON;
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &500,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
        &guardian,
    );

    let vault = contract.get_vault(&vault_id);
    assert_eq!(vault.end_timestamp, end_timestamp);
    assert_eq!(vault.status, VaultStatus::Draft);
}

// ── security: reject failure_destination equal to creator (slash-to-self) ─────

#[test]
#[should_panic]
fn test_create_vault_failure_destination_equals_creator_fails() {
    // Setting failure_destination == creator would nullify accountability:
    // a missed deadline simply returns funds to the creator.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _) = create_token(&env, &token_admin);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    // failure_destination is the same as creator — must fail with InvalidFailureDestination.
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &500,
        &success,
        &creator,
        &1_200,
        &milestones,
        &guardian,
    );
}

// ── pre-init paths ───────────────────────────────────────────────────────────

#[test]
fn test_get_vault_not_initialized() {
    let env = Env::default();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");

    let result = contract.try_get_vault(&vault_id);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_stake_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");
    let creator = Address::generate(&env);

    let result = contract.try_stake(&vault_id, &creator);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_check_in_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");
    let verifier = Address::generate(&env);

    let result = contract.try_check_in(&vault_id, &verifier, &0);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_claim_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");
    let creator = Address::generate(&env);

    let result = contract.try_claim(&vault_id, &creator);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}
