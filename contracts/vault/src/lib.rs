//! Vaultbreak vault: one instance per Guardian, deployed to its own account.
//!
//! Security model (see SPEC.md 3.1):
//! * The account is created with NO full-access key. The only key is the
//!   Guardian's function-call key restricted to `release` / `close_session`.
//! * `release(session_id)` takes no recipient or amount. It pays the whole pot
//!   to the attacker recorded when they paid.
//! * Nothing in this crate ever adds a full-access key (invariant 7, enforced by
//!   a source-scan test).
//!
//! Gas note: gas burned by the Guardian's key is charged to this account's
//! balance, outside the accounting below. It is bounded by the key's allowance;
//! the deploy script funds a gas buffer at least as large as the allowance.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

/// Fee split in percent. Constants in v1 (SPEC 5.1).
pub const POT_PCT: u128 = 70;
pub const CREATOR_PCT: u128 = 20;
pub const OPS_PCT: u128 = 10;
/// Bytes of storage reserved (and charged to the fee) per session record.
pub const SESSION_STORAGE_BYTES: u128 = 400;
pub const GUARDIAN_METHODS: &str = "release,close_session";
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VaultStatus {
    Armed,
    Defeated,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SessionStatus {
    Open,
    Won,
    Failed,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayoutKind {
    Pot,
    Creator,
    Ops,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Params {
    pub min_fee: U128,
    pub turns_max: u32,
    pub session_ttl_ms: U64,
    pub max_open_per_attacker: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Session {
    pub id: u64,
    pub attacker: AccountId,
    pub fee: u128,
    pub started_at: u64,
    pub expires_at: u64,
    pub status: SessionStatus,
    pub transcript_hash: Option<[u8; 32]>,
}

#[near(serializers = [json])]
pub struct SessionView {
    pub id: U64,
    pub attacker: AccountId,
    pub fee: U128,
    pub started_at: U64,
    pub expires_at: U64,
    pub status: SessionStatus,
    pub transcript_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default, Debug)]
pub struct Stats {
    pub attempts: u64,
    pub wins: u64,
    pub closed_failed: u64,
    pub streak: u64,
    pub blocked_reported: u64,
    pub total_fees: U128,
}

#[near(serializers = [json])]
pub struct StateView {
    pub owner: AccountId,
    pub registry: Option<AccountId>,
    pub ops_account: AccountId,
    pub guardian_pk: PublicKey,
    pub pot: U128,
    pub creator_balance: U128,
    pub ops_balance: U128,
    pub prompt_hash: String,
    pub status: VaultStatus,
    pub next_session_id: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    registry: Option<AccountId>,
    ops_account: AccountId,
    guardian_pk: PublicKey,
    pot: u128,
    creator_balance: u128,
    ops_balance: u128,
    prompt_hash: [u8; 32],
    params: Params,
    sessions: LookupMap<u64, Session>,
    open_by_attacker: LookupMap<AccountId, u32>,
    next_session_id: u64,
    stats: Stats,
    status: VaultStatus,
}

pub fn parse_hash(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    require!(s.len() == 64, "hash must be 32 bytes of hex");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("bad hex"));
    }
    out
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "vaultbreak", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

/// Splits a net fee into (pot, creator, ops). Rounding dust goes to the pot.
pub fn split_fee(net: u128) -> (u128, u128, u128) {
    let creator = net * CREATOR_PCT / 100;
    let ops = net * OPS_PCT / 100;
    (net - creator - ops, creator, ops)
}

#[near]
impl Vault {
    /// Initialises the vault. The attached deposit seeds the pot.
    #[init]
    #[payable]
    pub fn new(
        owner: AccountId,
        ops_account: AccountId,
        guardian_pk: PublicKey,
        prompt_hash: String,
        params: Params,
        registry: Option<AccountId>,
    ) -> Self {
        require!(!env::state_exists(), "already initialised");
        require!(params.min_fee.0 > 0, "min_fee must be > 0");
        require!(params.turns_max > 0, "turns_max must be > 0");
        require!(params.session_ttl_ms.0 > 0, "ttl must be > 0");
        require!(params.max_open_per_attacker > 0, "max_open must be > 0");
        let seed = env::attached_deposit().as_yoctonear();
        require!(seed > 0, "attach a seed deposit for the pot");
        let this = Self {
            owner: owner.clone(),
            registry,
            ops_account,
            guardian_pk,
            pot: seed,
            creator_balance: 0,
            ops_balance: 0,
            prompt_hash: parse_hash(&prompt_hash),
            params,
            sessions: LookupMap::new(b"s"),
            open_by_attacker: LookupMap::new(b"o"),
            next_session_id: 1,
            stats: Stats::default(),
            status: VaultStatus::Armed,
        };
        emit("created", json!({"owner": owner, "pot": U128(seed).0.to_string()}));
        this
    }

    /// Attacker pays the entry fee and opens a session.
    #[payable]
    pub fn start_session(&mut self) -> U64 {
        require!(self.status == VaultStatus::Armed, "vault is defeated");
        let attacker = env::predecessor_account_id();
        require!(attacker != self.owner, "owner cannot attack own vault");
        require!(attacker != env::current_account_id(), "vault cannot attack itself");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.params.min_fee.0, "deposit below min_fee");
        let open = self.open_by_attacker.get(&attacker).copied().unwrap_or(0);
        require!(open < self.params.max_open_per_attacker, "too many open sessions");

        let storage_cost = SESSION_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear();
        require!(deposit > storage_cost, "fee does not cover storage");
        let net = deposit - storage_cost;
        let (to_pot, to_creator, to_ops) = split_fee(net);
        self.pot += to_pot;
        self.creator_balance += to_creator;
        self.ops_balance += to_ops;
        self.stats.attempts += 1;
        self.stats.total_fees = U128(self.stats.total_fees.0 + deposit);

        let id = self.next_session_id;
        self.next_session_id += 1;
        let now = env::block_timestamp_ms();
        let expires_at = now + self.params.session_ttl_ms.0;
        self.sessions.insert(
            id,
            Session {
                id,
                attacker: attacker.clone(),
                fee: deposit,
                started_at: now,
                expires_at,
                status: SessionStatus::Open,
                transcript_hash: None,
            },
        );
        self.open_by_attacker.insert(attacker.clone(), open + 1);
        emit(
            "session_started",
            json!({"session_id": id, "attacker": attacker, "fee": deposit.to_string(),
                   "pot": self.pot.to_string(), "expires_at": expires_at}),
        );
        U64(id)
    }

    /// Guardian-only. Pays the whole pot to the session's attacker.
    pub fn release(&mut self, session_id: U64) -> Promise {
        self.assert_guardian();
        require!(self.status == VaultStatus::Armed, "vault is defeated");
        let mut s = self.sessions.get(&session_id.0).cloned().unwrap_or_else(|| env::panic_str("no such session"));
        require!(s.status == SessionStatus::Open, "session not open");
        require!(env::block_timestamp_ms() <= s.expires_at, "session expired");
        let amount = self.pot;
        require!(amount > 0, "empty pot");
        s.status = SessionStatus::Won;
        let attacker = s.attacker.clone();
        self.sessions.insert(session_id.0, s);
        self.dec_open(&attacker);
        self.pot = 0;
        self.status = VaultStatus::Defeated;
        self.stats.wins += 1;
        self.stats.streak = 0;
        self.assert_solvent(amount);
        emit("released", json!({"session_id": session_id.0, "attacker": attacker, "amount": amount.to_string()}));
        Promise::new(attacker)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_payout(
                PayoutKind::Pot,
                Some(session_id),
                U128(amount),
            ))
    }

    /// Guardian-only. Marks an open session as failed (attacker did not win).
    pub fn close_session(&mut self, session_id: U64, transcript_hash: String, blocked_attempts: u32) {
        self.assert_guardian();
        let mut s = self.sessions.get(&session_id.0).cloned().unwrap_or_else(|| env::panic_str("no such session"));
        require!(s.status == SessionStatus::Open, "session not open");
        s.status = SessionStatus::Failed;
        s.transcript_hash = Some(parse_hash(&transcript_hash));
        let attacker = s.attacker.clone();
        self.sessions.insert(session_id.0, s);
        self.dec_open(&attacker);
        self.stats.closed_failed += 1;
        self.stats.streak += 1;
        self.stats.blocked_reported += blocked_attempts as u64;
        emit(
            "session_closed",
            json!({"session_id": session_id.0, "blocked_attempts": blocked_attempts, "transcript_hash": transcript_hash}),
        );
    }

    /// Anyone. Expires an open session after its TTL (stops griefing).
    pub fn expire_session(&mut self, session_id: U64) {
        let mut s = self.sessions.get(&session_id.0).cloned().unwrap_or_else(|| env::panic_str("no such session"));
        require!(s.status == SessionStatus::Open, "session not open");
        require!(env::block_timestamp_ms() > s.expires_at, "not expired yet");
        s.status = SessionStatus::Expired;
        let attacker = s.attacker.clone();
        self.sessions.insert(session_id.0, s);
        self.dec_open(&attacker);
        self.stats.closed_failed += 1;
        self.stats.streak += 1;
        emit("session_expired", json!({"session_id": session_id.0}));
    }

    /// Owner. After a defeat, the attached deposit re-seeds the pot.
    #[payable]
    pub fn rearm(&mut self) {
        self.assert_owner();
        require!(self.status == VaultStatus::Defeated, "vault is armed");
        let top_up = env::attached_deposit().as_yoctonear();
        require!(top_up > 0, "attach a deposit to re-seed the pot");
        self.pot = top_up;
        self.status = VaultStatus::Armed;
        emit("rearmed", json!({"pot": top_up.to_string()}));
    }

    /// Owner. Withdraws accrued creator fees only (never the pot).
    pub fn claim_creator_fees(&mut self) -> Promise {
        self.assert_owner();
        let amount = self.creator_balance;
        require!(amount > 0, "nothing to claim");
        self.creator_balance = 0;
        self.assert_solvent(amount);
        Promise::new(self.owner.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_payout(
                PayoutKind::Creator,
                None,
                U128(amount),
            ))
    }

    /// Ops account. Withdraws the accrued operations share.
    pub fn claim_ops(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.ops_account, "only ops account");
        let amount = self.ops_balance;
        require!(amount > 0, "nothing to claim");
        self.ops_balance = 0;
        self.assert_solvent(amount);
        Promise::new(self.ops_account.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_payout(
                PayoutKind::Ops,
                None,
                U128(amount),
            ))
    }

    /// Owner. Adds a new restricted function-call key (never full-access) and
    /// removes the old one.
    pub fn rotate_guardian_key(&mut self, pk: PublicKey, allowance: U128) -> Promise {
        self.assert_owner();
        require!(allowance.0 > 0, "allowance must be > 0");
        require!(pk != self.guardian_pk, "key is already the guardian key");
        let old = self.guardian_pk.clone();
        self.guardian_pk = pk.clone();
        emit("guardian_key_rotated", json!({"new_pk": String::from(&pk)}));
        Promise::new(env::current_account_id())
            .add_access_key_allowance(
                pk,
                Allowance::limited(NearToken::from_yoctonear(allowance.0)).unwrap_or_else(|| env::panic_str("bad allowance")),
                env::current_account_id(),
                GUARDIAN_METHODS.to_string(),
            )
            .delete_key(old)
    }

    /// Registry only (Layer 3): owner follows the NFT.
    pub fn set_owner(&mut self, new_owner: AccountId) {
        require!(self.registry.as_ref() == Some(&env::predecessor_account_id()), "only registry");
        require!(self.open_by_attacker.get(&new_owner).copied().unwrap_or(0) == 0, "new owner has open sessions");
        self.owner = new_owner.clone();
        emit("owner_changed", json!({"owner": new_owner}));
    }

    #[private]
    pub fn on_payout(&mut self, kind: PayoutKind, session_id: Option<U64>, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_ok() {
            return;
        }
        // Transfer failed (e.g. recipient account deleted). Funds returned to the vault; restore accounting.
        match kind {
            PayoutKind::Pot => {
                self.pot += amount.0;
                self.status = VaultStatus::Armed;
                self.stats.wins = self.stats.wins.saturating_sub(1);
                if let Some(id) = session_id {
                    if let Some(mut s) = self.sessions.get(&id.0).cloned() {
                        s.status = SessionStatus::Failed;
                        self.sessions.insert(id.0, s);
                    }
                }
            }
            PayoutKind::Creator => self.creator_balance += amount.0,
            PayoutKind::Ops => self.ops_balance += amount.0,
        }
        emit("payout_failed", json!({"kind": format!("{:?}", kind), "amount": amount.0.to_string()}));
    }

    // ---- views ----
    pub fn get_state(&self) -> StateView {
        StateView {
            owner: self.owner.clone(),
            registry: self.registry.clone(),
            ops_account: self.ops_account.clone(),
            guardian_pk: self.guardian_pk.clone(),
            pot: U128(self.pot),
            creator_balance: U128(self.creator_balance),
            ops_balance: U128(self.ops_balance),
            prompt_hash: hex(&self.prompt_hash),
            status: self.status,
            next_session_id: U64(self.next_session_id),
        }
    }

    pub fn get_session(&self, session_id: U64) -> Option<SessionView> {
        self.sessions.get(&session_id.0).map(|s| SessionView {
            id: U64(s.id),
            attacker: s.attacker.clone(),
            fee: U128(s.fee),
            started_at: U64(s.started_at),
            expires_at: U64(s.expires_at),
            status: s.status,
            transcript_hash: s.transcript_hash.map(|h| hex(&h)),
        })
    }

    pub fn get_stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_open_count(&self, account_id: AccountId) -> u32 {
        self.open_by_attacker.get(&account_id).copied().unwrap_or(0)
    }
}

impl Vault {
    fn assert_guardian(&self) {
        // Only the vault's own keys produce predecessor == current_account_id.
        require!(env::predecessor_account_id() == env::current_account_id(), "only the guardian key");
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
    }

    fn dec_open(&mut self, attacker: &AccountId) {
        let n = self.open_by_attacker.get(attacker).copied().unwrap_or(0);
        if n <= 1 {
            self.open_by_attacker.remove(attacker);
        } else {
            self.open_by_attacker.insert(attacker.clone(), n - 1);
        }
    }

    /// Invariant 2: after `outgoing` leaves, the balance still covers every
    /// accounted bucket plus the storage stake.
    fn assert_solvent(&self, outgoing: u128) {
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let owed = self.pot + self.creator_balance + self.ops_balance + storage;
        require!(
            env::account_balance().as_yoctonear() >= owed + outgoing,
            "solvency invariant violated"
        );
    }
}

#[cfg(test)]
mod tests;
