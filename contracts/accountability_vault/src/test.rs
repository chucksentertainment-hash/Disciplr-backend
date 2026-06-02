#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token, vec, Address, Env, String};

struct Setup {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    admin: Address,
    token: Address,
    disallowed_token: Address,
    creator: Address,
    verifier: Address,
    guardian: Address,
    success: Address,
    failure: Address,
    contract_id: Address,
}

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        token::StellarAssetClient::new(env, &address),
    )
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let other_token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);
    let (disallowed_token, _) = create_token(&env, &other_token_admin);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    contract.init(&admin);

    Setup {
        env,
        contract,
        admin,
        token,
        disallowed_token,
        creator,
        verifier,
        guardian,
        success,
        failure,
        contract_id,
    }
}

fn milestones(env: &Env) -> Vec<Milestone> {
    vec![
        env,
        Milestone {
            title: String::from_str(env, "m1"),
            amount: 500,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ]
}

fn create_vault_with_token(s: &Setup, token: &Address, vault_id: &str) -> Result<(), Error> {
    s.contract
        .try_create_vault(
            &String::from_str(&s.env, vault_id),
            &s.creator,
            &s.verifier,
            token,
            &500,
            &s.success,
            &s.failure,
            &1_100,
            &milestones(&s.env),
            &s.guardian,
        )
        .unwrap()
}

#[test]
fn init_rejects_second_admin_initialization() {
    let s = setup();
    let other = Address::generate(&s.env);

    let result = s.contract.try_init(&other).unwrap();

    assert_eq!(result, Err(Error::AdminAlreadyInitialized));
}

#[test]
fn non_admin_cannot_update_token_allowlist() {
    let s = setup();
    let not_admin = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_allowed_token(&not_admin, &s.token, &true)
        .unwrap();

    assert_eq!(result, Err(Error::NotAdmin));
    assert!(!s.contract.is_allowed_token(&s.token));
}

#[test]
fn admin_can_add_and_remove_allowed_token() {
    let s = setup();

    s.contract.set_allowed_token(&s.admin, &s.token, &true);
    assert!(s.contract.is_allowed_token(&s.token));

    s.contract.set_allowed_token(&s.admin, &s.token, &false);
    assert!(!s.contract.is_allowed_token(&s.token));
}

#[test]
fn create_vault_rejects_token_when_allowlist_empty() {
    let s = setup();

    let result = create_vault_with_token(&s, &s.token, "v1");

    assert_eq!(result, Err(Error::TokenNotAllowed));
}

#[test]
fn create_vault_rejects_token_not_in_allowlist() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);

    let result = create_vault_with_token(&s, &s.disallowed_token, "v1");

    assert_eq!(result, Err(Error::TokenNotAllowed));
}

#[test]
fn create_vault_accepts_allowed_token_and_stake_uses_that_token() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);

    create_vault_with_token(&s, &s.token, "v1").expect("allowed token should create vault");
    let vault = s.contract.get_vault(&String::from_str(&s.env, "v1"));
    assert_eq!(vault.status, VaultStatus::Draft);
    assert_eq!(vault.token, s.token);

    s.contract
        .stake(&String::from_str(&s.env, "v1"), &s.creator);
    let vault = s.contract.get_vault(&String::from_str(&s.env, "v1"));
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 0);
    assert_eq!(token_client.balance(&s.contract_id), 500);
}

// ── #493: deterministic vault address derivation ──────────────────────────────
//
// The backend (src/services/soroban.ts) deploys one AccountabilityVault
// contract per vault and must correlate the on-chain address to the off-chain
// PersistedVault.id before the transaction is confirmed.
//
// Soroban derives contract addresses deterministically from (deployer, salt):
//
//   address = sha256("contract" || deployer_bytes || salt_bytes)
//
// This means the address can be predicted *before* deployment using:
//   env.deployer().with_address(deployer, salt).deployed_address()
//
// Salt convention used by the backend:
//   BytesN<32> = sha256(vault_id_string) — a 32-byte hash of the off-chain UUID
//   (see src/services/soroban.ts: saltFromVaultId)
//
// These tests exercise and document the pattern so the backend deploy flow can
// be validated and the address correlation logic can be unit-tested off-chain.

#[test]
fn removing_token_blocks_new_vaults_but_preserves_existing_vault() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);
    create_vault_with_token(&s, &s.token, "v1").expect("allowed token should create vault");

    s.contract.set_allowed_token(&s.admin, &s.token, &false);
    let result = create_vault_with_token(&s, &s.token, "v2");

    assert_eq!(result, Err(Error::TokenNotAllowed));
    let existing = s.contract.get_vault(&String::from_str(&s.env, "v1"));
    assert_eq!(existing.token, s.token);
}

#[test]
fn create_vault_rejects_more_than_max_milestones() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);
    let mut milestones = Vec::new(&s.env);
    for i in 0..(MAX_MILESTONES + 1) {
        milestones.push_back(Milestone {
            title: String::from_str(&s.env, "m"),
            amount: 1,
            due_date: 1_100 + u64::from(i),
            verified: false,
            released: false,
        });
    }

    let result = s
        .contract
        .try_create_vault(
            &String::from_str(&s.env, "v1"),
            &s.creator,
            &s.verifier,
            &s.token,
            &i128::from(MAX_MILESTONES + 1),
            &s.success,
            &s.failure,
            &2_000,
            &milestones,
            &s.guardian,
        )
        .unwrap();

    assert_eq!(result, Err(Error::TooManyMilestones));
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

#[cfg(test)]
mod scval_i128_parity_tests {
    use super::*;
    use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

    fn assert_scval_i128_roundtrip(env: &Env, amount: i128) {
        // Encodes the native i128 value into a Soroban Val type
        let encoded_val: Val = amount.into_val(env);
        
        // Decodes it back out to guarantee the format matches backend expectations
        let decoded_amount: i128 = i128::try_from_val(env, &encoded_val)
            .expect("Parity Gap: Unable to decode structural i128 asset value.");
            
        assert_eq!(amount, decoded_amount, "Parity Gap: Value changed during roundtrip conversion.");
    }

    #[test]
    fn test_lifecycle_events_i128_parity() {
        let env = Env::default();
        
        // Test zero, standard token scales, and large balance amounts
        assert_scval_i128_roundtrip(&env, 0);                               // Base case
        assert_scval_i128_roundtrip(&env, 100_000_000);                     // Stake / Slash amount
        assert_scval_i128_roundtrip(&env, 5_000_000_000);                   // Claim amount
        assert_scval_i128_roundtrip(&env, 123_456_789_012_345_678_901_i128); // High volume cap bounds
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

// ── #489: get_unverified_milestone_indices accessor ───────────────────────────

#[test]
fn test_unverified_indices_all_unverified_on_stake() {
    let s = setup(&[100, 200, 300], &[200, 300, 500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let indices = s.contract.get_unverified_milestone_indices(&s.vault_id).unwrap();
    assert_eq!(indices.len(), 3);
    assert_eq!(indices.get(0).unwrap(), 0u32);
    assert_eq!(indices.get(1).unwrap(), 1u32);
    assert_eq!(indices.get(2).unwrap(), 2u32);
}

#[test]
fn test_unverified_indices_partial_verification() {
    let s = setup(&[100, 200, 300], &[200, 300, 500]);
    s.contract.stake(&s.vault_id, &s.creator);
    // Verify milestone 1 only.
    s.contract.check_in(&s.vault_id, &s.verifier, &1, &evidence_hash(&s.env, 2));

    let indices = s.contract.get_unverified_milestone_indices(&s.vault_id).unwrap();
    assert_eq!(indices.len(), 2);
    assert_eq!(indices.get(0).unwrap(), 0u32);
    assert_eq!(indices.get(1).unwrap(), 2u32);
}

#[test]
fn test_unverified_indices_empty_when_all_verified() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));
    s.contract.check_in(&s.vault_id, &s.verifier, &1, &evidence_hash(&s.env, 2));

    let indices = s.contract.get_unverified_milestone_indices(&s.vault_id).unwrap();
    assert_eq!(indices.len(), 0);
}

#[test]
fn test_unverified_indices_not_initialized_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let result = contract.try_get_unverified_milestone_indices(&String::from_str(&env, "missing"));
    assert!(matches!(result, Err(Ok(Error::NotInitialized))));
}

#[test]
fn test_unverified_indices_order_preserved() {
    // Verify milestones 0 and 2; expect remaining [1, 3] in ascending order.
    let s = setup(&[50, 100, 150, 200], &[100, 200, 300, 400]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));
    s.contract.check_in(&s.vault_id, &s.verifier, &2, &evidence_hash(&s.env, 2));

    let indices = s.contract.get_unverified_milestone_indices(&s.vault_id).unwrap();
    assert_eq!(indices.len(), 2);
    assert_eq!(indices.get(0).unwrap(), 1u32);
    assert_eq!(indices.get(1).unwrap(), 3u32);
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

// ── #481: vault_funded event with token address ───────────────────────────────

#[test]
fn test_vault_funded_event_emitted_on_stake() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Events: [vault_created(0), vault_staked(1), vault_funded(2)]
    let events = s.env.events().all();
    assert!(events.len() >= 3, "expected vault_created + vault_staked + vault_funded");

    let (_, topics, data) = events.get(2).unwrap();
    // topic[0] = "vault_funded"
    let name = Symbol::try_from_val(&s.env, &topics.get(0).unwrap())
        .expect("topic[0] must be Symbol");
    assert_eq!(name, Symbol::new(&s.env, "vault_funded"));
    // topic[1] = token address
    let token_val: Address = Address::try_from_val(&s.env, &topics.get(1).unwrap())
        .expect("topic[1] must be an Address (token)");
    assert_eq!(token_val, s.token);
    // topic[2] = from (creator)
    let from_val: Address = Address::try_from_val(&s.env, &topics.get(2).unwrap())
        .expect("topic[2] must be an Address (from)");
    assert_eq!(from_val, s.creator);
    // data = net staked amount
    let amount: i128 = i128::try_from_val(&s.env, &data).expect("data must be i128");
    assert_eq!(amount, 500);
}

#[test]
fn test_vault_funded_token_matches_vault_token() {
    // Ensure the token emitted in vault_funded is the same as vault.token.
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    let events = s.env.events().all();
    // Find the vault_funded event.
    let funded_event = events.iter().find(|(_, topics, _)| {
        topics.get(0)
            .and_then(|v| Symbol::try_from_val(&s.env, &v).ok())
            .map(|sym| sym == Symbol::new(&s.env, "vault_funded"))
            .unwrap_or(false)
    });
    assert!(funded_event.is_some(), "vault_funded event not found");
    let (_, topics, data) = funded_event.unwrap();
    let token_val: Address = Address::try_from_val(&s.env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(token_val, vault.token);
    let amount: i128 = i128::try_from_val(&s.env, &data).unwrap();
    assert_eq!(amount, vault.staked);
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

#[test]
#[should_panic(expected = "Error::DeadlineInPast")]
fn test_create_vault_deadline_in_past_fails() {
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
            due_date: 900,
            verified: false,
        },
    ];

    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &500,
        &success,
        &failure,
        &900,
        &milestones,
        &guardian,
    );
}

#[test]
#[should_panic(expected = "Error::InvalidDeadline")]
fn test_create_vault_milestone_due_date_exceeds_end_fails() {
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
            due_date: 1_300,
            verified: false,
        },
    ];

    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &500,
        &success,
        &failure,
        &1_200,
        &milestones,
        &guardian,
    );
}

