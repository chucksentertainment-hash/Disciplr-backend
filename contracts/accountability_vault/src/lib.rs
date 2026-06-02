#![no_std]
//! Disciplr Accountability Vault
//!
//! A Soroban smart contract implementing programmable time-locked capital vaults
//! for accountability staking. A creator stakes funds toward a goal with one or
//! more milestones. A designated verifier set confirms check-ins / milestone
//! completion via M-of-N threshold approval. On success the staked capital is
//! released to the `success_destination`; on a missed deadline the capital is
//! slashed to the `failure_destination` (e.g. a charity or forfeit address).
//!
//! Lifecycle: create_vault -> stake -> (check_in)* -> claim | slash_on_miss
//! Funds movement is modeled via the SEP-41 token client (`stake`, `claim`,
//! `slash_on_miss`, `withdraw`). The contract enforces the state machine,
//! authorization, and deadline rules on-chain.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, String, Symbol, Vec,
};

/// Maximum allowed horizon between vault creation and its deadline.
const MAX_DEADLINE_HORIZON: u64 = 5 * 365 * 24 * 60 * 60;

/// Storage keys for the contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Address allowed to manage deployment-wide settings.
    Admin,
    /// The vault configuration and current state.
    Vault(String),
    /// Whether a SEP-41 token contract may be selected by `create_vault`.
    AllowedToken(Address),
}

/// Lifecycle state of a vault.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultStatus {
    /// Created but not yet funded.
    Draft = 0,
    /// Funded and counting down to its deadline.
    Active = 1,
    /// All milestones verified; funds released to success destination.
    Completed = 2,
    /// Deadline passed without completion; funds slashed.
    Failed = 3,
    /// Cancelled before completion.
    Cancelled = 4,
}

/// A single accountability milestone within a vault.
#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    /// Human-readable title describing the milestone goal.
    pub title: String,
    /// Portion of the staked amount tied to this milestone.
    pub amount: i128,
    /// UNIX timestamp (seconds) by which the milestone must be checked in.
    pub due_date: u64,
    /// Whether the verifier has confirmed this milestone.
    pub verified: bool,
    /// Whether this milestone's funds have already been released.
    pub released: bool,
}

/// Full on-chain vault record.
#[contracttype]
#[derive(Clone)]
pub struct Vault {
    /// Address that created the vault and owns the staked funds.
    pub creator: Address,
    /// Address authorized to verify milestones.
    pub verifier: Address,
    /// SEP-41 token used for staking.
    pub token: Address,
    /// Total staked amount.
    pub amount: i128,
    /// Amount actually transferred into the contract via `stake`.
    pub staked: i128,
    /// Destination for released funds on success.
    pub success_destination: Address,
    /// Destination for slashed funds on a missed deadline.
    pub failure_destination: Address,
    /// Overall vault deadline.
    pub end_timestamp: u64,
    /// Current lifecycle state of the vault.
    pub status: VaultStatus,
    /// Ordered list of milestones.
    pub milestones: Vec<Milestone>,
    /// Address authorized to pause in future emergency flows.
    pub guardian: Address,
    /// Reserved pause flag for compatibility with the backend model.
    pub paused: bool,
}

/// Errors surfaced to callers. Numbered for stable client mapping.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    /// Vault storage already exists for the given `vault_id`.
    AlreadyInitialized = 1,
    /// No vault found for the given `vault_id`.
    NotInitialized = 2,
    /// Creator and verifier are the same address; role separation is required.
    CreatorIsVerifier = 26,
    /// Amount is zero or negative.
    InvalidAmount = 3,
    /// Deadline is in the past, exceeds vault end, or beyond the 5-year horizon.
    InvalidDeadline = 4,
    /// Milestone list is empty.
    NoMilestones = 5,
    /// Operation requires the vault to be in `Draft` state.
    NotDraft = 6,
    /// Operation requires the vault to be in `Active` state.
    NotActive = 7,
    /// Caller is not permitted for this operation.
    Unauthorized = 8,
    /// Vault has already been funded; cannot stake again.
    AlreadyStaked = 9,
    /// Milestone index is outside the valid range.
    MilestoneIndexOutOfRange = 10,
    /// Milestone has already been verified.
    MilestoneAlreadyVerified = 11,
    /// Current time is past the milestone or vault deadline.
    DeadlinePassed = 12,
    /// Current time has not yet reached the vault deadline.
    DeadlineNotReached = 13,
    /// Not all milestones have been verified.
    MilestonesIncomplete = 14,
    /// Vault staked balance is zero; nothing to withdraw.
    NothingToWithdraw = 15,
    /// Received amount does not match the declared vault amount.
    AmountMismatch = 16,
    /// Deadline is in the past.
    DeadlineInPast = 28,
}

/// Accountability vault contract entry point.
#[contract]
pub struct AccountabilityVault;

#[contractimpl]
impl AccountabilityVault {
    /// Initializes the deployment admin. This may be called exactly once.
    pub fn init(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AdminAlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Replaces the deployment admin. Only the current admin may rotate it.
    pub fn set_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), Error> {
        Self::require_admin(&env, &current_admin)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "admin_updated"), current_admin),
            new_admin,
        );
        Ok(())
    }

    /// Adds or removes a token contract from the deployment-wide allowlist.
    pub fn set_allowed_token(
        env: Env,
        admin: Address,
        token: Address,
        allowed: bool,
    ) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;
        let key = DataKey::AllowedToken(token.clone());
        if allowed {
            env.storage().instance().set(&key, &true);
        } else {
            env.storage().instance().remove(&key);
        }
        env.events()
            .publish((Symbol::new(&env, "allowed_token_set"), token), allowed);
        Ok(())
    }

    /// Returns whether a token contract is currently allowed for new vaults.
    pub fn is_allowed_token(env: Env, token: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AllowedToken(token))
            .unwrap_or(false)
    }

    /// Creates a new accountability vault in `Draft` state.
    pub fn create_vault(
        env: Env,
        vault_id: String,
        creator: Address,
        verifier: Address,
        token: Address,
        amount: i128,
        success_destination: Address,
        failure_destination: Address,
        end_timestamp: u64,
        milestones: Vec<Milestone>,
        guardian: Address,
    ) -> Result<(), Error> {
        creator.require_auth();

        let key = DataKey::Vault(vault_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyInitialized);
        }
        if !Self::is_allowed_token(env.clone(), token.clone()) {
            return Err(Error::TokenNotAllowed);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if end_timestamp <= env.ledger().timestamp() {
            return Err(Error::DeadlineInPast);
        }
        if end_timestamp > env.ledger().timestamp() + MAX_DEADLINE_HORIZON {
            return Err(Error::InvalidDeadline);
        }
        if milestones.is_empty() {
            return Err(Error::NoMilestones);
        }
        if milestones.len() > MAX_MILESTONES {
            return Err(Error::TooManyMilestones);
        }

        let mut sum = 0i128;
        let mut initialized = Vec::new(&env);
        for milestone in milestones.iter() {
            if milestone.amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            if milestone.due_date > end_timestamp || milestone.due_date <= now {
                return Err(Error::InvalidDeadline);
            }
            sum += milestone.amount;
            initialized.push_back(Milestone {
                title: milestone.title,
                amount: milestone.amount,
                due_date: milestone.due_date,
                verified: false,
                released: false,
            });
        }
        if sum != amount {
            return Err(Error::AmountMismatch);
        }

        let vault = Vault {
            creator: creator.clone(),
            verifier,
            token,
            amount,
            staked: 0,
            success_destination,
            failure_destination,
            end_timestamp,
            status: VaultStatus::Draft,
            milestones: initialized,
            guardian,
            paused: false,
        };
        env.storage().persistent().set(&key, &vault);
        env.events()
            .publish((Symbol::new(&env, "vault_created"), creator), amount);
        Ok(())
    }

    /// Funds the vault by transferring the configured token from the creator.
    pub fn stake(env: Env, vault_id: String, from: Address) -> Result<(), Error> {
        from.require_auth();
        let key = DataKey::Vault(vault_id);
        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;

        if vault.status != VaultStatus::Draft {
            return Err(Error::NotDraft);
        }
        if from != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.staked != 0 {
            return Err(Error::AlreadyStaked);
        }

        token::Client::new(&env, &vault.token).transfer(
            &from,
            &env.current_contract_address(),
            &vault.amount,
        );

        vault.staked = vault.amount;
        vault.status = VaultStatus::Active;
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        // Legacy event: preserved for backward-compatible listeners.
        env.events()
            .publish((Symbol::new(&env, "vault_staked"), from.clone()), vault.staked);

        // Rich funding event: carries token address so eventParser.ts can
        // reconcile the SEP-41 contract address without a separate Horizon query.
        env.events().publish(
            (Symbol::new(&env, "vault_funded"), vault.token.clone(), from),
            vault.staked,
        );
        Ok(())
    }

    /// Records the verifier's approval for a milestone before its due date.
    pub fn check_in(
        env: Env,
        vault_id: String,
        verifier: Address,
        milestone_index: u32,
    ) -> Result<(), Error> {
        verifier.require_auth();
        let key = DataKey::Vault(vault_id);
        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if verifier != vault.verifier {
            return Err(Error::Unauthorized);
        }
        if milestone_index >= vault.milestones.len() {
            return Err(Error::MilestoneIndexOutOfRange);
        }

        let mut milestone = vault
            .milestones
            .get(milestone_index)
            .ok_or(Error::MilestoneIndexOutOfRange)?;
        if milestone.verified {
            return Err(Error::MilestoneAlreadyVerified);
        }
        if env.ledger().timestamp() > milestone.due_date
            || env.ledger().timestamp() > vault.end_timestamp
        {
            return Err(Error::InvalidDeadline);
        }

        milestone.verified = true;
        vault.milestones.set(milestone_index, milestone);
        env.storage().persistent().set(&key, &vault);
        env.events().publish(
            (Symbol::new(&env, "milestone_checked_in"), verifier),
            milestone_index,
        );
        Ok(())
    }

    /// Slashes the staked capital to the `failure_destination` once the vault
    /// deadline has passed and not all milestones were verified. Permissionless:
    /// anyone may trigger the slash after the deadline (e.g. a backend keeper).
    ///
    /// Checks-Effects-Interactions: vault status is set to `Failed` and `staked`
    /// is zeroed in storage BEFORE the external token transfer is executed,
    /// ensuring the terminal state is committed even if the transfer call panics.
    pub fn slash_on_miss(env: Env, vault_id: String) -> Result<(), Error> {
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        // Check Disputed before NotActive so callers get the specific error code.
        if vault.status == VaultStatus::Disputed {
            return Err(Error::VaultDisputed);
        }
        Self::assert_active(&vault)?;
        if vault.paused {
            return Err(Error::Paused);
        }
        if env.ledger().timestamp() <= vault.end_timestamp {
            return Err(Error::DeadlineNotReached);
        }
        if Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }

        // CEI: capture transfer values, update and persist state, then call external token.
        let slashed = vault.staked;
        let failure_destination = vault.failure_destination.clone();
        let token_addr = vault.token.clone();
        vault.status = VaultStatus::Failed;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault(vault_id), &vault);

        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &failure_destination,
            &slashed,
        );

        env.events().publish(
            (
                Symbol::new(&env, "vault_slashed"),
                failure_destination,
            ),
            slashed,
        );
        Ok(())
    }

    /// Releases the staked capital to the `success_destination` once every
    /// milestone has been verified. Callable by the creator or any member of
    /// the verifier set.
    ///
    /// Checks-Effects-Interactions: vault status is set to `Completed` and
    /// `staked` is zeroed in storage BEFORE the external token transfer,
    /// ensuring the terminal state is committed even if the transfer call panics.
    pub fn claim(env: Env, vault_id: String, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let key = DataKey::Vault(vault_id);
        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;

        // Check Disputed before NotActive so callers get the specific error code.
        if vault.status == VaultStatus::Disputed {
            return Err(Error::VaultDisputed);
        }
        Self::assert_active(&vault)?;
        if vault.paused {
            return Err(Error::Paused);
        }
        let is_authorized =
            caller == vault.creator || vault.verifiers.iter().any(|v| v == caller);
        if !is_authorized {
            return Err(Error::Unauthorized);
        }
        if !Self::all_verified(env.clone(), vault.milestones.clone()) {
            return Err(Error::MilestonesIncomplete);
        }
        if vault.staked <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        let released = vault.staked;
        vault.staked = 0;
        vault.status = VaultStatus::Completed;
        env.storage().persistent().set(&key, &vault);
        token::Client::new(&env, &vault.token).transfer(
            &env.current_contract_address(),
            &vault.success_destination,
            &released,
        );
        env.events().publish(
            (
                Symbol::new(&env, "vault_completed"),
                vault.success_destination,
            ),
            released,
        );
        Ok(())
    }

    /// Slashes funds to the failure destination after the deadline if milestones remain incomplete.
    pub fn slash_on_miss(env: Env, vault_id: String) -> Result<(), Error> {
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events()
            .publish((String::from_str(&env, "vault_cancelled"), creator), 0i128);
        Ok(())
    }

    /// Refunds the creator for an `Active` vault that was never checked-in.
    /// This function is restricted to `Active` refund cases; callers that wish
    /// to cancel a Draft should call `cancel_vault` instead.
    pub fn withdraw(env: Env, vault_id: String, creator: Address) -> Result<(), Error> {
        creator.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        Self::assert_active(&vault)?;
        if vault.paused {
            return Err(Error::Paused);
        }
        if Self::any_verified(&vault) {
            return Err(Error::Unauthorized);
        }
        if vault.staked == 0 {
            return Err(Error::NothingToWithdraw);
        }

        // CEI: capture transfer values, update and persist state, then call external token.
        let refunded = vault.staked;
        let token_addr = vault.token.clone();
        vault.staked = 0;
        vault.status = VaultStatus::Cancelled;
        env.storage().instance().set(&DataKey::Vault, &vault);

        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &creator,
            &refunded,
        );

        env.events().publish(
            (Symbol::new(&env, "vault_withdrawn"), creator),
            refunded,
        );
        Ok(())
    }

    /// Transitions an `Active` vault into `Disputed`, blocking `slash_on_miss` and
    /// `claim` until an admin resolves the dispute.
    ///
    /// Only the `guardian` address may call this. The vault must be `Active`.
    pub fn admin_dispute(env: Env, vault_id: String, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if admin != vault.guardian {
            return Err(Error::Unauthorized);
        }
        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }

        vault.status = VaultStatus::Disputed;
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events()
            .publish((String::from_str(&env, "vault_disputed"), admin), ());
        Ok(())
    }

    /// Resolves a `Disputed` vault to `Active`, `Completed`, or `Failed`.
    ///
    /// Only the `guardian` address may call this. `target` must be one of those
    /// three statuses; any other value is rejected with `Error::NotActive`.
    ///
    /// Resolving to `Completed` or `Failed` is a terminal administrative decision
    /// and does **not** trigger a token transfer — settlement still goes through
    /// `claim` (for Completed) or `slash_on_miss` (for Failed) once the vault is
    /// back in the appropriate resolved state.
    pub fn admin_resolve(
        env: Env,
        vault_id: String,
        admin: Address,
        target: VaultStatus,
    ) -> Result<(), Error> {
        admin.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if admin != vault.guardian {
            return Err(Error::Unauthorized);
        }
        if vault.status != VaultStatus::Disputed {
            return Err(Error::VaultDisputed);
        }

        match target {
            VaultStatus::Active | VaultStatus::Completed | VaultStatus::Failed => {}
            _ => return Err(Error::NotActive),
        }

        vault.status = target;
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events()
            .publish((String::from_str(&env, "vault_dispute_resolved"), admin), target as u32);
        Ok(())
    }

    /// Pauses the vault, blocking `slash_on_miss`, `claim`, and active `withdraw`.
    ///
    /// Only the `guardian` address set at vault creation may call this function.
    /// Use to halt settlement during disputes or detected incidents.
    pub fn emergency_pause(
        env: Env,
        vault_id: String,
        guardian: Address,
    ) -> Result<(), Error> {
        guardian.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if guardian != vault.guardian {
            return Err(Error::Unauthorized);
        }
        vault.paused = true;
        env.storage().instance().set(&DataKey::Vault(vault_id), &vault);
        env.events()
            .publish((Symbol::new(&env, "vault_paused"), guardian), true);
        Ok(())
    }

    /// Unpauses the vault, re-enabling `slash_on_miss`, `claim`, and `withdraw`.
    ///
    /// Only the `guardian` address set at vault creation may call this function.
    pub fn emergency_unpause(
        env: Env,
        vault_id: String,
        guardian: Address,
    ) -> Result<(), Error> {
        guardian.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if guardian != vault.guardian {
            return Err(Error::Unauthorized);
        }
        vault.paused = false;
        env.storage().instance().set(&DataKey::Vault(vault_id), &vault);
        env.events()
            .publish((Symbol::new(&env, "vault_unpaused"), guardian), false);
        Ok(())
    }

    /// Read-only accessor returning the current vault record.
    pub fn get_vault(env: Env, vault_id: String) -> Result<Vault, Error> {
        Self::load(&env, &vault_id)
    }

    /// Returns indices of milestones that have not yet been verified, in order.
    ///
    /// Used by the backend deadline-check keeper (`src/jobs/handlers.ts`) to
    /// identify which milestones to pass to `slash_on_miss` without reading the
    /// full `Vault` struct and filtering client-side.
    pub fn get_unverified_milestone_indices(
        env: Env,
        vault_id: String,
    ) -> Result<Vec<u32>, Error> {
        let vault = Self::load(&env, &vault_id)?;
        let mut indices = Vec::new(&env);
        let mut i: u32 = 0;
        while i < vault.milestones.len() {
            if !vault.milestones.get(i).unwrap().verified {
                indices.push_back(i);
            }
            i += 1;
        }
        Ok(indices)
    }

    /// Sweeps any residual token balance held by the contract to the vault creator
    /// after a terminal settlement. Only the creator may call this, and only once
    /// `staked` has been zeroed by `claim`, `slash_on_miss`, or `withdraw`.
    pub fn reclaim_after_settlement(env: Env, vault_id: String, token_address: Address) -> Result<(), Error> {
        let vault: Vault = Self::load(&env, &vault_id)?;
        vault.creator.require_auth();

        // Only sweep after the vault has no outstanding stake.
        if vault.staked != 0 {
            return Err(Error::StakedRemaining);
        }

        let contract_addr = env.current_contract_address();
        let client = token::Client::new(&env, &token_address);
        let bal = client.balance(&contract_addr);
        if bal > 0 {
            client.transfer(&contract_addr, &vault.creator, &bal);
        }
        Ok(())
    }

    // ── internal helpers ────────────────────────────────────────────────


    pub fn configure_window(env: Env, window: u64) {
        env.storage().instance().set(&DataKey::DisputeWindow, &window);
    }

    pub fn dispute_milestone(env: Env, vault_id: String, creator: Address, index: u32) -> Result<(), Error> {
        creator.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if vault.creator != creator {
            return Err(Error::Unauthorized);
        }
        if index >= vault.milestones.len() {
            return Err(Error::MilestoneIndexOutOfRange);
        }

        let mut milestone = vault.milestones.get(index).unwrap();
        if !milestone.verified {
            return Err(Error::MilestonesIncomplete);
        }

        let dispute_window: u64 = env.storage().instance().get(&DataKey::DisputeWindow).unwrap_or(86400);
        let verified_at: u64 = env.storage().instance().get(&DataKey::CheckIn(index)).unwrap_or(0);
        
        if env.ledger().timestamp() > verified_at + dispute_window {
            return Err(Error::DeadlinePassed);
        }

        milestone.verified = false;
        vault.milestones.set(index, milestone);
        
        // Match upstream's storage format
        env.storage().instance().set(&DataKey::Vault, &vault);

        let event_name = soroban_sdk::Symbol::new(&env, "milestone_disputed");
        env.events().publish((event_name, creator), index);
        
        Ok(())
    }
    /// Asserts that the vault is in the Active state.
    fn assert_active(vault: &Vault) -> Result<(), Error> {
        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        Ok(())
    }

    fn load(env: &Env, vault_id: &String) -> Result<Vault, Error> {
        let key = DataKey::Vault(vault_id.clone());
        let vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if env.ledger().timestamp() < vault.end_timestamp {
            return Err(Error::DeadlineNotReached);
        }
        if Self::all_verified(env.clone(), vault.milestones.clone()) {
            return Err(Error::MilestonesIncomplete);
        }
        if vault.staked <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        let slashed = vault.staked;
        vault.staked = 0;
        vault.status = VaultStatus::Failed;
        env.storage().persistent().set(&key, &vault);
        token::Client::new(&env, &vault.token).transfer(
            &env.current_contract_address(),
            &vault.failure_destination,
            &slashed,
        );
        env.events().publish(
            (
                Symbol::new(&env, "vault_slashed"),
                vault.failure_destination,
            ),
            slashed,
        );
        Ok(())
    }

    /// Cancels an unfunded draft vault.
    pub fn cancel_vault(env: Env, vault_id: String, creator: Address) -> Result<(), Error> {
        creator.require_auth();
        let key = DataKey::Vault(vault_id);
        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.status != VaultStatus::Draft {
            return Err(Error::NotDraft);
        }
        vault.status = VaultStatus::Cancelled;
        env.storage().persistent().set(&key, &vault);
        env.events()
            .publish((Symbol::new(&env, "vault_cancelled"), creator), 0i128);
        Ok(())
    }

    /// Refunds the creator for an active vault that has no verified milestones.
    pub fn withdraw(env: Env, vault_id: String, creator: Address) -> Result<(), Error> {
        creator.require_auth();
        let key = DataKey::Vault(vault_id);
        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if vault.milestones.iter().any(|milestone| milestone.verified) {
            return Err(Error::MilestonesIncomplete);
        }
        if vault.staked <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        let refund = vault.staked;
        vault.staked = 0;
        vault.status = VaultStatus::Cancelled;
        env.storage().persistent().set(&key, &vault);
        token::Client::new(&env, &vault.token).transfer(
            &env.current_contract_address(),
            &vault.creator,
            &refund,
        );
        env.events()
            .publish((Symbol::new(&env, "vault_withdrawn"), creator), refund);
        Ok(())
    }

    /// Returns the current vault record.
    pub fn get_vault(env: Env, vault_id: String) -> Result<Vault, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(vault_id))
            .ok_or(Error::NotInitialized)
    }

    /// Returns true when every milestone is verified.
    pub fn all_verified(_env: Env, milestones: Vec<Milestone>) -> bool {
        milestones.iter().all(|milestone| milestone.verified)
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAdmin)?;
        if stored != *admin {
            return Err(Error::NotAdmin);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;

//! Accountability Vault Smart Contract
//!
//! Time-locked capital vaults with milestone-based accountability.
//! Users deposit tokens that are released only when milestones are validated.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol, Vec,
};

// SEP-41 Token client for interacting with any compliant token
use soroban_sdk::token::Client as TokenClient;

// ============================================================================
// Constants
// ============================================================================

/// Minimum supported token decimals (0 = whole units only)
pub const MIN_TOKEN_DECIMALS: u32 = 0;

/// Maximum supported token decimals (18 = standard ERC-20 max)
/// 
/// Rationale: The backend's src/services/soroban.ts assumes a fixed
/// decimals contract. Values above 18 could cause overflow in
/// JavaScript's Number type (IEEE 754) and are uncommon in practice.
/// Soroban itself caps at 18 decimals in the reference implementation.
pub const MAX_TOKEN_DECIMALS: u32 = 18;

// ============================================================================
// Error Types
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // General errors (1XX)
    AlreadyInitialized = 100,
    NotInitialized = 101,
    Unauthorized = 102,
    
    // Vault errors (2XX)
    VaultNotFound = 200,
    VaultAlreadyExists = 201,
    InvalidAmount = 202,
    InvalidTimestamp = 203,
    InvalidDestination = 204,
    
    // Milestone errors (3XX)
    MilestoneNotFound = 300,
    MilestoneAlreadyValidated = 301,
    InvalidVerifier = 302,
    
    // Token errors (4XX)
    /// Token decimals are outside the supported range [0, 18].
    /// This prevents integration issues with the backend's fixed-decimals
    /// assumptions and avoids JavaScript Number overflow.
    UnsupportedTokenDecimals = 400,
    TokenTransferFailed = 401,
    InsufficientBalance = 402,
}

// ============================================================================
// Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub id: u32,
    pub description: String,
    pub verifier: Address,
    pub validated: bool,
    pub validated_at: u64,
    pub evidence_hash: Option<String>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vault {
    pub id: String,
    pub creator: Address,
    pub token: Address,
    pub amount: i128,
    pub end_timestamp: u64,
    pub success_destination: Address,
    pub failure_destination: Address,
    pub milestones: Vec<Milestone>,
    pub state: VaultState,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultState {
    Active,
    Completed,
    Cancelled,
    Slashed,
}

// ============================================================================
// Storage Keys
// ============================================================================

#[contracttype]
pub enum DataKey {
    Admin,
    Vault(String),
    VaultCount,
    TokenDecimals(Address), // Cache validated token decimals
}

// ============================================================================
// Contract Implementation
// ============================================================================

#[contract]
pub struct AccountabilityVault;

#[contractimpl]
impl AccountabilityVault {
    // =====================================================================
    // Initialization
    // =====================================================================
    
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        
        env.events().publish(
            (symbol_short!("init"), admin.clone()),
            env.ledger().timestamp(),
        );
        
        Ok(())
    }

    // =====================================================================
    // Vault Creation (with token decimals validation)
    // =====================================================================

    /// Create a new accountability vault.
    ///
    /// # Arguments
    /// * `creator` - The address creating the vault (must authenticate)
    /// * `token` - The SEP-41 token contract address to deposit
    /// * `amount` - The amount of tokens to lock
    /// * `end_timestamp` - Unix timestamp when the vault expires
    /// * `success_destination` - Address to receive funds on success
    /// * `failure_destination` - Address to receive funds on failure
    /// * `milestones` - List of milestones that must be validated
    ///
    /// # Errors
    /// * `Error::UnsupportedTokenDecimals` - If token.decimals() is not in [0, 18]
    /// * `Error::InvalidAmount` - If amount is <= 0
    /// * `Error::InvalidTimestamp` - If end_timestamp is in the past
    pub fn create_vault(
        env: Env,
        creator: Address,
        token: Address,
        amount: i128,
        end_timestamp: u64,
        success_destination: Address,
        failure_destination: Address,
        milestones: Vec<Milestone>,
    ) -> Result<String, Error> {
        // Authentication
        creator.require_auth();
        
        // Validate basic inputs
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        
        let current_time = env.ledger().timestamp();
        if end_timestamp <= current_time {
            return Err(Error::InvalidTimestamp);
        }
        
        // =================================================================
        // TOKEN DECIMALS VALIDATION (Issue #491)
        // =================================================================
        // Query the token's decimals via SEP-41 interface.
        // Reject tokens with unsupported decimals to prevent:
        // 1. Backend integration issues (src/services/soroban.ts assumes fixed decimals)
        // 2. JavaScript Number overflow (IEEE 754 precision loss above ~15 digits)
        // 3. UI display inconsistencies
        // =================================================================
        
        let token_client = TokenClient::new(&env, &token);
        let decimals = token_client.decimals();
        
        if decimals < MIN_TOKEN_DECIMALS || decimals > MAX_TOKEN_DECIMALS {
            return Err(Error::UnsupportedTokenDecimals);
        }
        
        // Cache the validated decimals for future reference
        env.storage().persistent().set(
            &DataKey::TokenDecimals(token.clone()),
            &decimals,
        );
        
        // Generate vault ID
        let vault_count: u64 = env.storage().persistent()
            .get(&DataKey::VaultCount)
            .unwrap_or(0);
        let vault_id = format!("vault_{}", vault_count);
        
        // Transfer tokens from creator to vault
        token_client.transfer(&creator, &env.current_contract_address(), &amount);
        
        // Create vault record
        let vault = Vault {
            id: vault_id.clone(),
            creator,
            token,
            amount,
            end_timestamp,
            success_destination,
            failure_destination,
            milestones,
            state: VaultState::Active,
            created_at: current_time,
        };
        
        // Store vault
        env.storage().persistent().set(&DataKey::Vault(vault_id.clone()), &vault);
        env.storage().persistent().set(&DataKey::VaultCount, &(vault_count + 1));
        
        // Emit event
        env.events().publish(
            (symbol_short!("vault_created"), vault_id.clone()),
            (creator, token, amount),
        );
        
        Ok(vault_id)
    }

    // =====================================================================
    // Milestone Validation
    // =====================================================================

    pub fn validate_milestone(
        env: Env,
        vault_id: String,
        milestone_id: u32,
        evidence_hash: Option<String>,
    ) -> Result<(), Error> {
        let mut vault: Vault = env.storage().persistent()
            .get(&DataKey::Vault(vault_id.clone()))
            .ok_or(Error::VaultNotFound)?;
        
        // Only active vaults can have milestones validated
        if vault.state != VaultState::Active {
            return Err(Error::Unauthorized);
        }
        
        // Find milestone
        let milestone = vault.milestones.iter()
            .find(|m| m.id == milestone_id)
            .ok_or(Error::MilestoneNotFound)?;
        
        // Verify the caller is the assigned verifier
        milestone.verifier.require_auth();
        
        if milestone.validated {
            return Err(Error::MilestoneAlreadyValidated);
        }
        
        // Update milestone
        let updated_milestones: Vec<Milestone> = vault.milestones.iter()
            .map(|m| {
                if m.id == milestone_id {
                    Milestone {
                        id: m.id,
                        description: m.description.clone(),
                        verifier: m.verifier.clone(),
                        validated: true,
                        validated_at: env.ledger().timestamp(),
                        evidence_hash: evidence_hash.clone(),
                    }
                } else {
                    m.clone()
                }
            })
            .collect();
        
        vault.milestones = updated_milestones;
        
        // Check if all milestones are validated
        let all_validated = vault.milestones.iter().all(|m| m.validated);
        if all_validated {
            vault.state = VaultState::Completed;
            
            // Transfer funds to success destination
            let token_client = TokenClient::new(&env, &vault.token);
            token_client.transfer(
                &env.current_contract_address(),
                &vault.success_destination,
                &vault.amount,
            );
            
            env.events().publish(
                (symbol_short!("vault_completed"), vault_id.clone()),
                (vault.success_destination.clone(), vault.amount),
            );
        }
        
        env.storage().persistent().set(&DataKey::Vault(vault_id.clone()), &vault);
        
        env.events().publish(
            (symbol_short!("milestone_validated"), vault_id),
            (milestone_id, milestone.verifier),
        );
        
        Ok(())
    }

    // =====================================================================
    // Vault Cancellation
    // =====================================================================

    pub fn cancel_vault(env: Env, vault_id: String) -> Result<(), Error> {
        let mut vault: Vault = env.storage().persistent()
            .get(&DataKey::Vault(vault_id.clone()))
            .ok_or(Error::VaultNotFound)?;
        
        // Only creator or admin can cancel
        let caller = env.current_contract_address(); // In practice, get from auth context
        if vault.creator != caller {
            // Check admin
            let admin: Address = env.storage().instance()
                .get(&DataKey::Admin)
                .ok_or(Error::NotInitialized)?;
            if admin != caller {
                return Err(Error::Unauthorized);
            }
        }
        
        vault.creator.require_auth();
        
        if vault.state != VaultState::Active {
            return Err(Error::Unauthorized);
        }
        
        vault.state = VaultState::Cancelled;
        
        // Return funds to creator
        let token_client = TokenClient::new(&env, &vault.token);
        token_client.transfer(
            &env.current_contract_address(),
            &vault.creator,
            &vault.amount,
        );
        
        env.storage().persistent().set(&DataKey::Vault(vault_id.clone()), &vault);
        
        env.events().publish(
            (symbol_short!("vault_cancelled"), vault_id),
            (vault.creator, vault.amount),
        );
        
        Ok(())
    }

    // =====================================================================
    // Slashing (on missed deadline)
    // =====================================================================

    pub fn slash_vault(env: Env, vault_id: String) -> Result<(), Error> {
        let mut vault: Vault = env.storage().persistent()
            .get(&DataKey::Vault(vault_id.clone()))
            .ok_or(Error::VaultNotFound)?;
        
        if vault.state != VaultState::Active {
            return Err(Error::Unauthorized);
        }
        
        let current_time = env.ledger().timestamp();
        if current_time <= vault.end_timestamp {
            return Err(Error::InvalidTimestamp);
        }
        
        vault.state = VaultState::Slashed;
        
        // Transfer funds to failure destination
        let token_client = TokenClient::new(&env, &vault.token);
        token_client.transfer(
            &env.current_contract_address(),
            &vault.failure_destination,
            &vault.amount,
        );
        
        env.storage().persistent().set(&DataKey::Vault(vault_id.clone()), &vault);
        
        env.events().publish(
            (symbol_short!("vault_slashed"), vault_id),
            (vault.failure_destination, vault.amount),
        );
        
        Ok(())
    }

    // =====================================================================
    // Query Functions
    // =====================================================================

    pub fn get_vault(env: Env, vault_id: String) -> Result<Vault, Error> {
        env.storage().persistent()
            .get(&DataKey::Vault(vault_id))
            .ok_or(Error::VaultNotFound)
    }

    pub fn get_vault_count(env: Env) -> u64 {
        env.storage().persistent()
            .get(&DataKey::VaultCount)
            .unwrap_or(0)
    }

    pub fn get_token_decimals(env: Env, token: Address) -> Option<u32> {
        env.storage().persistent()
            .get(&DataKey::TokenDecimals(token))
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage().instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}
