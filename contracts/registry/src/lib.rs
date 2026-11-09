//! Vaultbreak registry + factory (SPEC 5.2).
//!
//! * NEP-171 core (`nft_transfer`, `nft_token`), NEP-177 metadata, NEP-181 enumeration (via near-contract-standards)
//!   and NEP-199 payouts (royalties).
//! * `mint_guardian` is the factory: ONE batched promise creates the sub-account `<id>.<registry>`, funds it, deploys the
//!   vault wasm, calls `new`, and adds ONLY the guardian function-call key (never a full-access key). The NFT is minted in
//!   the callback only if the batch succeeded, so an NFT always has a vault and never the reverse.
//! * `nft_transfer` moves the NFT and calls `vault.set_owner(new_owner)` so the creator-fee claim right follows the NFT.
//!   If the vault refuses (e.g. the new owner has an open attack session), the NFT transfer is reverted.
//!
//! Deviations from the standards (documented in the README):
//!   * `nft_transfer_call` is unsupported (it would need owner-sync + receiver + resolver chaining); use `nft_transfer`.
//!   * No approval extension (NEP-178): only the owner can transfer, so `approval_id` is accepted and ignored.
//!   * `nft_transfer` returns whether the vault owner sync succeeded (NEP-171 specifies no return value).
//!   * Token `reference` points to a live JSON document, so it carries no `reference_hash` (NEP-177 asks for one).

use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};
use std::collections::HashMap;

#[cfg(not(test))]
const VAULT_WASM: &[u8] = include_bytes!("../../vault/out/vault.wasm");
#[cfg(test)]
const VAULT_WASM: &[u8] = &[0u8; 8];

pub const GUARDIAN_METHODS: &str = "release,close_session";
/// Kept by the registry per mint to pay for the NFT's own storage (token, metadata, enumeration, vault info).
pub const NFT_STORAGE_YOCTO: u128 = 20_000_000_000_000_000_000_000; // 0.02 NEAR
pub const MIN_SEED_YOCTO: u128 = 500_000_000_000_000_000_000_000; // 0.5 NEAR
pub const DEFAULT_ALLOWANCE_YOCTO: u128 = 250_000_000_000_000_000_000_000; // 0.25 NEAR
pub const GAS_BUFFER_EXTRA_YOCTO: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR on top of the allowance
pub const MAX_ROYALTY_BPS: u16 = 2_000; // 20%
const BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19 yocto per byte
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Metadata,
    Vaults,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct VaultParams {
    pub min_fee: U128,
    pub turns_max: u32,
    pub session_ttl_ms: U64,
    pub max_open_per_attacker: u32,
}

#[near(serializers = [json])]
pub struct MintArgs {
    /// Becomes the token id and the sub-account label: `<guardian_id>.<registry>`.
    pub guardian_id: String,
    pub ops_account: AccountId,
    pub guardian_pk: PublicKey,
    /// hex sha256 of the sealed system prompt (commitment, stored in the vault)
    pub prompt_hash: String,
    pub params: VaultParams,
    /// secondary-sale royalty to the original creator, basis points (max 2000)
    pub royalty_bps: u16,
    /// gas allowance of the guardian key in yoctoNEAR (default 0.25 NEAR)
    pub allowance: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct VaultInfo {
    pub vault: AccountId,
    pub creator: AccountId,
    pub royalty_bps: u16,
}

#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    vaults: LookupMap<TokenId, VaultInfo>,
    admin: AccountId,
    base_uri: String,
}

pub fn valid_guardian_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase() | b[0].is_ascii_digit()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

/// Basis-point split of a sale price: (royalty, remainder). Rounds the royalty down; never exceeds `balance`.
pub fn royalty_split(balance: u128, bps: u16) -> (u128, u128) {
    let royalty = balance / 10_000 * bps as u128 + (balance % 10_000) * bps as u128 / 10_000;
    (royalty, balance - royalty)
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "vaultbreak_registry", "version": "1.0.0", "event": event, "data": [data]})));
}

#[near]
impl Registry {
    #[init]
    pub fn new(admin: AccountId, base_uri: String) -> Self {
        require!(!env::state_exists(), "already initialised");
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Vaultbreak Guardians".to_string(),
            symbol: "VBG".to_string(),
            icon: None,
            base_uri: Some(base_uri.clone()),
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                admin.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                None::<StorageKey>,
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            vaults: LookupMap::new(StorageKey::Vaults),
            admin,
            base_uri,
        }
    }

    /// Admin only: where the live metadata JSON is served (the Vaultbreak API). Affects tokens minted afterwards.
    pub fn set_base_uri(&mut self, base_uri: String) {
        require!(env::predecessor_account_id() == self.admin, "only admin");
        self.base_uri = base_uri;
    }

    // ------------------------------------------------------------------ factory
    /// Mints a Guardian: creates its vault account + NFT. The attached deposit is split into the vault's storage reserve, a
    /// gas buffer for the guardian key, the NFT storage fee, and the initial pot (the rest, at least 0.5 NEAR).
    /// Attach ~300 Tgas. The caller becomes the NFT owner and the vault owner.
    #[payable]
    pub fn mint_guardian(&mut self, args: MintArgs) -> Promise {
        let creator = env::predecessor_account_id();
        require!(valid_guardian_id(&args.guardian_id), "guardian_id must be 1-32 chars of [a-z0-9_-], starting with a letter or digit");
        require!(args.royalty_bps <= MAX_ROYALTY_BPS, "royalty_bps above 2000 (20%)");
        require!(self.tokens.owner_by_id.get(&args.guardian_id).is_none(), "guardian_id already minted");
        let allowance = args.allowance.map(|a| a.0).unwrap_or(DEFAULT_ALLOWANCE_YOCTO);
        require!(allowance > 0, "allowance must be > 0");
        let vault_storage = (VAULT_WASM.len() as u128 + 20_000) * BYTE_COST;
        let gas_buffer = allowance + GAS_BUFFER_EXTRA_YOCTO;
        let deposit = env::attached_deposit().as_yoctonear();
        let fixed = vault_storage + gas_buffer + NFT_STORAGE_YOCTO;
        require!(deposit >= fixed + MIN_SEED_YOCTO, format!("attach at least {} yoctoNEAR (storage {} + gas buffer {} + NFT {} + min pot {})", fixed + MIN_SEED_YOCTO, vault_storage, gas_buffer, NFT_STORAGE_YOCTO, MIN_SEED_YOCTO));
        let seed = deposit - fixed;

        let vault: AccountId = format!("{}.{}", args.guardian_id, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid vault account id"));
        let init_args = json!({
            "owner": creator,
            "ops_account": args.ops_account,
            "guardian_pk": args.guardian_pk,
            "prompt_hash": args.prompt_hash,
            "params": args.params,
            "registry": env::current_account_id(),
        });
        // One batch to ONE receiver => one receipt: if any action fails, every action (incl. account creation) reverts.
        Promise::new(vault.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(vault_storage + gas_buffer))
            .deploy_contract(VAULT_WASM.to_vec())
            .function_call("new".to_string(), init_args.to_string().into_bytes(), NearToken::from_yoctonear(seed), Gas::from_tgas(60))
            // ONLY a restricted function-call key; there is no add_full_access_key anywhere in this contract.
            .add_access_key_allowance(
                args.guardian_pk.clone(),
                Allowance::limited(NearToken::from_yoctonear(allowance)).unwrap_or_else(|| env::panic_str("bad allowance")),
                vault.clone(),
                GUARDIAN_METHODS.to_string(),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_vault_created(
                args.guardian_id,
                creator,
                vault,
                args.royalty_bps,
                U128(deposit),
            ))
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        guardian_id: String,
        creator: AccountId,
        vault: AccountId,
        royalty_bps: u16,
        deposit: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Option<Token> {
        if result.is_err() || self.tokens.owner_by_id.get(&guardian_id).is_some() {
            // The batch reverted (e.g. the vault account already exists). Give the caller their money back.
            emit("mint_failed", json!({"guardian_id": guardian_id, "creator": creator}));
            let _ = Promise::new(creator).transfer(NearToken::from_yoctonear(deposit.0));
            return None;
        }
        let reference = format!("{}/guardians/{}/metadata.json", self.base_uri.trim_end_matches('/'), guardian_id);
        let md = TokenMetadata {
            title: Some(format!("Guardian {}", guardian_id)),
            description: Some("A Vaultbreak AI guardian holding a pot of NEAR. Live stats at `reference`.".to_string()),
            reference: Some(reference),
            extra: Some(json!({"vault": vault}).to_string()),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            ..Default::default()
        };
        // storage is paid from the registry balance (NFT_STORAGE_YOCTO was retained from the deposit)
        let token = self.tokens.internal_mint_with_refund(guardian_id.clone(), creator.clone(), Some(md), None);
        self.vaults.insert(guardian_id.clone(), VaultInfo { vault: vault.clone(), creator: creator.clone(), royalty_bps });
        emit("guardian_minted", json!({"guardian_id": guardian_id, "vault": vault, "creator": creator, "royalty_bps": royalty_bps}));
        Some(token)
    }

    // ------------------------------------------------------------------ NEP-171 (+ owner follows the NFT)
    /// Transfers the NFT and the vault's owner role (creator-fee claims) to `receiver_id`.
    /// Returns `true` if the vault accepted the new owner; `false` if it refused and the NFT transfer was reverted.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) -> Promise {
        assert_one_yocto();
        let _ = approval_id; // no approval extension: only the owner may transfer
        let sender = env::predecessor_account_id();
        let (previous_owner, _) = self.tokens.internal_transfer(&sender, &receiver_id, &token_id, None, memo);
        self.sync_vault_owner(token_id, previous_owner, receiver_id)
    }

    /// NEP-171 `nft_transfer_call` is intentionally unsupported (see module docs).
    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("nft_transfer_call is not supported: use nft_transfer (it keeps the vault owner in sync)");
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }

    #[private]
    pub fn on_owner_synced(
        &mut self,
        token_id: TokenId,
        previous_owner: AccountId,
        new_owner: AccountId,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        // Vault refused: put the NFT back so token owner == vault owner stays true.
        if self.tokens.owner_by_id.get(&token_id).as_ref() == Some(&new_owner) {
            self.tokens.internal_transfer_unguarded(&token_id, &new_owner, &previous_owner);
        }
        emit("transfer_reverted", json!({"token_id": token_id, "previous_owner": previous_owner, "attempted_owner": new_owner}));
        false
    }

    // ------------------------------------------------------------------ NEP-199 royalties
    pub fn nft_payout(&self, token_id: TokenId, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("Token not found"));
        let info = self.vaults.get(&token_id).unwrap_or_else(|| env::panic_str("no vault for token"));
        let (royalty, rest) = royalty_split(balance.0, info.royalty_bps);
        let mut payout: HashMap<AccountId, U128> = HashMap::new();
        if royalty > 0 {
            payout.insert(info.creator.clone(), U128(royalty));
        }
        let e = payout.entry(owner).or_insert(U128(0));
        e.0 += rest;
        if let Some(max) = max_len_payout {
            require!(payout.len() as u32 <= max, "payout longer than max_len_payout");
        }
        Payout { payout }
    }

    /// NEP-199: transfers the token and returns who must be paid from `balance` (royalty to the creator, rest to the
    /// seller). The payout is computed BEFORE the transfer, as the seller is the previous owner.
    #[payable]
    pub fn nft_transfer_payout(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> Payout {
        assert_one_yocto();
        let payout = self.nft_payout(token_id.clone(), balance, max_len_payout);
        let _ = approval_id;
        let sender = env::predecessor_account_id();
        let (previous_owner, _) = self.tokens.internal_transfer(&sender, &receiver_id, &token_id, None, memo);
        // fire-and-forget owner sync (the callback reverts the transfer if the vault refuses)
        let _ = self.sync_vault_owner(token_id, previous_owner, receiver_id);
        payout
    }

    // ------------------------------------------------------------------ views
    pub fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
    pub fn get_vault(&self, token_id: TokenId) -> Option<VaultInfo> {
        self.vaults.get(&token_id).cloned()
    }
    pub fn vault_account(&self, guardian_id: String) -> AccountId {
        format!("{}.{}", guardian_id, env::current_account_id()).parse().unwrap()
    }
    pub fn mint_requirements(&self, allowance: Option<U128>) -> U128 {
        let allowance = allowance.map(|a| a.0).unwrap_or(DEFAULT_ALLOWANCE_YOCTO);
        U128((VAULT_WASM.len() as u128 + 20_000) * BYTE_COST + allowance + GAS_BUFFER_EXTRA_YOCTO + NFT_STORAGE_YOCTO + MIN_SEED_YOCTO)
    }

    // NEP-181 enumeration
    pub fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

impl Registry {
    fn sync_vault_owner(&self, token_id: TokenId, previous_owner: AccountId, new_owner: AccountId) -> Promise {
        let vault = self.vaults.get(&token_id).unwrap_or_else(|| env::panic_str("no vault for token")).vault.clone();
        Promise::new(vault)
            .function_call("set_owner".to_string(), json!({"new_owner": new_owner}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(20))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_owner_synced(token_id, previous_owner, new_owner))
    }
}

#[cfg(test)]
mod tests;
