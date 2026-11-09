//! Vaultbreak swarm pool (SPEC 5.3): agents pool NEAR, one controller attacks a Guardian with the pool's money, and any
//! winnings (plus unspent funds) are split pro rata to contributions.
//!
//! Model
//! * One pool contract holds many pools. The pool CONTRACT account is the on-chain `attacker` of the sessions it starts, so the
//!   vault pays the pot straight to this contract. (Consequence: a vault allows one open session per attacker, so only one
//!   pool session per vault is open at a time, across all pools. Documented limitation.)
//! * Vaults are trusted by NAME: only `<guardian_id>.<registry>` accounts are accepted, and only the registry (whose vault
//!   code is embedded and immutable) can create such an account. A pool therefore never trusts an arbitrary contract's claims.
//! * Winnings come from `vault.get_session(id).payout` (recorded by the vault when it releases), not from guesswork.
//! * Lifecycle: Funding -> (attacks) Attacking -> Won | Closed. Contributions are accepted only while Funding, so nobody can
//!   buy into a pool after fees were spent. `settle` is permissionless. `withdraw` pays
//!   `(winnings + contributions - fees_spent) * my_contribution / total_contributions`.
//! * Rounding is floor; at most (number of contributors) yoctoNEAR of dust stays in the contract.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const MIN_CONTRIBUTION: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
const MIN_DEADLINE_MS: u64 = 1_000;
const MAX_DEADLINE_MS: u64 = 30 * 24 * 3600 * 1000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PoolStatus {
    Funding,
    Attacking,
    Won,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Contribution {
    pub amount: u128,
    pub claimed: bool,
}

#[near(serializers = [borsh])]
pub struct Pool {
    pub id: u64,
    pub guardian_id: String,
    pub vault: AccountId,
    pub creator: AccountId,
    pub controller: AccountId,
    /// maximum total entry fees the controller may spend from this pool
    pub target_fee_budget: u128,
    pub deadline_ms: u64,
    pub status: PoolStatus,
    pub total: u128,
    pub spent: u128,
    pub winnings: u128,
    pub open_session: Option<u64>,
    pub attack_pending: bool,
    pub sessions: Vec<u64>,
    pub contributions: IterableMap<AccountId, Contribution>,
}

#[near(serializers = [json])]
pub struct PoolView {
    pub id: U64,
    pub guardian_id: String,
    pub vault: AccountId,
    pub creator: AccountId,
    pub controller: AccountId,
    pub target_fee_budget: U128,
    pub deadline_ms: U64,
    pub status: PoolStatus,
    pub total_contributed: U128,
    pub fees_spent: U128,
    pub winnings: U128,
    pub open_session: Option<U64>,
    pub sessions: Vec<U64>,
    pub contributors: u32,
}

/// The subset of the vault's `get_session` view that the pool reads.
#[near(serializers = [json])]
pub struct VaultSession {
    pub status: String,
    pub payout: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PoolContract {
    registry: AccountId,
    pools: LookupMap<u64, Pool>,
    next_id: u64,
    /// sum over pools of money the contract owes (contributions - fees paid out + winnings - withdrawn)
    held: u128,
}

/// floor(a * b / d) with a 256-bit intermediate. Panics if d == 0 or the result does not fit in u128.
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    require!(d > 0, "division by zero");
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & u64::MAX as u128) + (p10 & u64::MAX as u128);
    let lo = (p00 & u64::MAX as u128) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    // long division of the 256-bit (hi:lo) by d, bit by bit
    require!(hi < d, "mul_div overflow");
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    q
}

/// One contributor's share of the pool's final value.
pub fn share_of(value: u128, contribution: u128, total: u128) -> u128 {
    mul_div(value, contribution, total)
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "vaultbreak_pool", "version": "1.0.0", "event": event, "data": [data]})));
}

#[near]
impl PoolContract {
    #[init]
    pub fn new(registry: AccountId) -> Self {
        require!(!env::state_exists(), "already initialised");
        Self { registry, pools: LookupMap::new(b"p"), next_id: 1, held: 0 }
    }

    /// Opens a pool aimed at the guardian `<guardian_id>.<registry>`. The caller is the creator; `controller` (default: the
    /// creator) is the only account that may start attacks. `deadline_ms` is relative to now.
    pub fn create_pool(&mut self, guardian_id: String, target_fee_budget: U128, controller: Option<AccountId>, deadline_ms: U64) -> U64 {
        require!(!guardian_id.is_empty() && !guardian_id.contains('.'), "guardian_id must be a registry label");
        require!(target_fee_budget.0 > 0, "target_fee_budget must be > 0");
        require!(deadline_ms.0 >= MIN_DEADLINE_MS && deadline_ms.0 <= MAX_DEADLINE_MS, "deadline_ms out of range");
        let vault: AccountId = format!("{}.{}", guardian_id, self.registry).parse().unwrap_or_else(|_| env::panic_str("invalid guardian_id"));
        let creator = env::predecessor_account_id();
        let id = self.next_id;
        self.next_id += 1;
        let mut prefix = b"c".to_vec();
        prefix.extend_from_slice(&id.to_le_bytes());
        let pool = Pool {
            id,
            guardian_id,
            vault: vault.clone(),
            controller: controller.unwrap_or_else(|| creator.clone()),
            creator: creator.clone(),
            target_fee_budget: target_fee_budget.0,
            deadline_ms: env::block_timestamp_ms() + deadline_ms.0,
            status: PoolStatus::Funding,
            total: 0,
            spent: 0,
            winnings: 0,
            open_session: None,
            attack_pending: false,
            sessions: vec![],
            contributions: IterableMap::new(prefix),
        };
        emit("pool_created", json!({"pool_id": id, "vault": vault, "creator": creator, "controller": pool.controller}));
        self.pools.insert(id, pool);
        U64(id)
    }

    /// Adds the attached deposit to the pool. Only while Funding (before any fee was spent).
    #[payable]
    pub fn contribute(&mut self, pool_id: U64) {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        require!(pool.status == PoolStatus::Funding, "pool is no longer accepting contributions");
        require!(env::block_timestamp_ms() <= pool.deadline_ms, "pool deadline passed");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_CONTRIBUTION, "minimum contribution is 0.01 NEAR");
        let who = env::predecessor_account_id();
        let mut c = pool.contributions.get(&who).cloned().unwrap_or_default();
        c.amount += amount;
        pool.contributions.insert(who.clone(), c);
        pool.total += amount;
        self.held += amount;
        emit("contributed", json!({"pool_id": pool_id.0, "account": who, "amount": amount.to_string()}));
    }

    /// Controller only. Pays `fee` from the pool to open a session on the vault (the pool contract becomes the attacker).
    pub fn attack_with_pool(&mut self, pool_id: U64, fee: U128) -> Promise {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        require!(env::predecessor_account_id() == pool.controller, "only the pool controller can attack");
        require!(matches!(pool.status, PoolStatus::Funding | PoolStatus::Attacking), "pool is closed");
        require!(env::block_timestamp_ms() <= pool.deadline_ms, "pool deadline passed");
        require!(pool.open_session.is_none() && !pool.attack_pending, "a session is already open or starting");
        require!(fee.0 > 0, "fee must be > 0");
        require!(pool.spent + fee.0 <= pool.total, "fee exceeds the pool's unspent funds");
        require!(pool.spent + fee.0 <= pool.target_fee_budget, "fee exceeds target_fee_budget");
        require!(env::account_balance().as_yoctonear() >= self.held, "pool contract is insolvent");
        // reserve first; the callback undoes it if the vault refuses
        pool.spent += fee.0;
        pool.attack_pending = true;
        pool.status = PoolStatus::Attacking;
        self.held -= fee.0;
        let vault = pool.vault.clone();
        Promise::new(vault)
            .function_call("start_session".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(fee.0), Gas::from_tgas(30))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_attack_started(pool_id, fee))
    }

    #[private]
    pub fn on_attack_started(&mut self, pool_id: U64, fee: U128, #[callback_result] result: Result<U64, PromiseError>) -> Option<U64> {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        pool.attack_pending = false;
        match result {
            Ok(session_id) => {
                pool.open_session = Some(session_id.0);
                pool.sessions.push(session_id.0);
                emit("attack_started", json!({"pool_id": pool_id.0, "session_id": session_id.0, "fee": fee.0.to_string()}));
                Some(session_id)
            }
            Err(_) => {
                // The vault refused (defeated, session open for this pool contract, fee below min, ...): the deposit came back.
                pool.spent -= fee.0;
                self.held += fee.0;
                if pool.sessions.is_empty() {
                    pool.status = PoolStatus::Funding;
                }
                emit("attack_failed", json!({"pool_id": pool_id.0, "fee": fee.0.to_string()}));
                None
            }
        }
    }

    /// Permissionless. Reads the open session's outcome from the vault and books the winnings if it was Won.
    pub fn settle(&mut self, pool_id: U64) -> Promise {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        let session = pool.open_session.unwrap_or_else(|| env::panic_str("no open session to settle"));
        Promise::new(pool.vault.clone())
            .function_call("get_session".to_string(), json!({"session_id": U64(session)}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_session_status(pool_id, U64(session)))
    }

    #[private]
    pub fn on_session_status(&mut self, pool_id: U64, session_id: U64, #[callback_result] result: Result<Option<VaultSession>, PromiseError>) -> String {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        if pool.open_session != Some(session_id.0) {
            return "stale".to_string();
        }
        let s = match result {
            Ok(Some(s)) => s,
            _ => env::panic_str("could not read the session from the vault"),
        };
        match s.status.as_str() {
            "Open" => "open".to_string(),
            "Won" => {
                let payout = s.payout.unwrap_or_else(|| env::panic_str("vault did not report a payout")).0;
                require!(payout > 0, "vault reported an empty payout");
                self.held += payout;
                // the vault paid this contract before reporting Won: the books must be covered by real balance
                require!(env::account_balance().as_yoctonear() >= self.held, "payout not received yet; retry settle");
                pool.winnings += payout;
                pool.status = PoolStatus::Won;
                pool.open_session = None;
                emit("won", json!({"pool_id": pool_id.0, "session_id": session_id.0, "payout": payout.to_string()}));
                "won".to_string()
            }
            _ => {
                // Failed / Expired: the fee is gone, the pool may try again or close
                pool.open_session = None;
                emit("session_lost", json!({"pool_id": pool_id.0, "session_id": session_id.0, "status": s.status}));
                "lost".to_string()
            }
        }
    }

    /// Ends the pool without (more) attacks. Controller anytime; anyone after the deadline. Needs no open session.
    pub fn close_pool(&mut self, pool_id: U64) {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        let caller = env::predecessor_account_id();
        require!(caller == pool.controller || env::block_timestamp_ms() > pool.deadline_ms, "only the controller can close before the deadline");
        require!(pool.open_session.is_none() && !pool.attack_pending, "settle the open session first");
        require!(pool.status != PoolStatus::Won, "pool already won");
        pool.status = PoolStatus::Closed;
        emit("closed", json!({"pool_id": pool_id.0}));
    }

    /// A contributor takes their pro rata share: (winnings + unspent) * contribution / total.
    pub fn withdraw(&mut self, pool_id: U64) -> Promise {
        self.pay_out(pool_id, false)
    }

    /// Same payout as `withdraw`, but only for pools that never won (SPEC name for returning unspent funds).
    pub fn refund(&mut self, pool_id: U64) -> Promise {
        self.pay_out(pool_id, true)
    }

    #[private]
    pub fn on_withdraw(&mut self, pool_id: U64, account: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        // transfer bounced (e.g. recipient deleted): restore the claim
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        if let Some(mut c) = pool.contributions.get(&account).cloned() {
            c.claimed = false;
            pool.contributions.insert(account.clone(), c);
        }
        self.held += amount.0;
        emit("withdraw_failed", json!({"pool_id": pool_id.0, "account": account, "amount": amount.0.to_string()}));
        false
    }

    // ------------------------------------------------------------------ views
    pub fn get_pool(&self, pool_id: U64) -> Option<PoolView> {
        self.pools.get(&pool_id.0).map(view)
    }
    pub fn get_contribution(&self, pool_id: U64, account_id: AccountId) -> Option<Contribution> {
        self.pools.get(&pool_id.0).and_then(|p| p.contributions.get(&account_id).cloned())
    }
    /// What `account_id` would receive if the pool settled now (0 until Won/Closed).
    pub fn preview_share(&self, pool_id: U64, account_id: AccountId) -> U128 {
        let Some(pool) = self.pools.get(&pool_id.0) else { return U128(0) };
        let Some(c) = pool.contributions.get(&account_id) else { return U128(0) };
        if !matches!(pool.status, PoolStatus::Won | PoolStatus::Closed) || pool.total == 0 {
            return U128(0);
        }
        U128(share_of(pool.winnings + pool.total - pool.spent, c.amount, pool.total))
    }
    pub fn list_pools(&self, from_index: Option<U64>, limit: Option<u64>) -> Vec<PoolView> {
        let from = from_index.map(|x| x.0).unwrap_or(1).max(1);
        let to = (from + limit.unwrap_or(50).min(100)).min(self.next_id);
        (from..to).filter_map(|i| self.pools.get(&i).map(view)).collect()
    }
    pub fn get_registry(&self) -> AccountId {
        self.registry.clone()
    }
    pub fn get_held(&self) -> U128 {
        U128(self.held)
    }
}

fn view(p: &Pool) -> PoolView {
    PoolView {
        id: U64(p.id), guardian_id: p.guardian_id.clone(), vault: p.vault.clone(), creator: p.creator.clone(), controller: p.controller.clone(),
        target_fee_budget: U128(p.target_fee_budget), deadline_ms: U64(p.deadline_ms), status: p.status, total_contributed: U128(p.total),
        fees_spent: U128(p.spent), winnings: U128(p.winnings), open_session: p.open_session.map(U64), sessions: p.sessions.iter().map(|s| U64(*s)).collect(),
        contributors: p.contributions.len(),
    }
}

impl PoolContract {
    fn pay_out(&mut self, pool_id: U64, refund_only: bool) -> Promise {
        let pool = self.pools.get_mut(&pool_id.0).unwrap_or_else(|| env::panic_str("no such pool"));
        require!(matches!(pool.status, PoolStatus::Won | PoolStatus::Closed), "pool is still running: wait for Won/Closed");
        require!(!(refund_only && pool.status == PoolStatus::Won), "pool won: use withdraw");
        require!(pool.open_session.is_none(), "settle the open session first");
        let who = env::predecessor_account_id();
        let mut c = pool.contributions.get(&who).cloned().unwrap_or_else(|| env::panic_str("not a contributor"));
        require!(!c.claimed, "already claimed");
        let amount = share_of(pool.winnings + pool.total - pool.spent, c.amount, pool.total);
        require!(amount > 0, "nothing to withdraw");
        c.claimed = true;
        pool.contributions.insert(who.clone(), c);
        require!(self.held >= amount, "accounting error: held < amount");
        self.held -= amount;
        require!(env::account_balance().as_yoctonear() >= self.held + amount, "pool contract is insolvent");
        emit("withdrawn", json!({"pool_id": pool_id.0, "account": who, "amount": amount.to_string()}));
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_withdraw(pool_id, who, U128(amount)))
    }
}

#[cfg(test)]
mod tests;
