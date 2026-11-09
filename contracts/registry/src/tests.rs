use super::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const REG: &str = "reg.test";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}
fn ctx(pred: &str, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(REG))
        .predecessor_account_id(acct(pred))
        .signer_account_id(acct(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(1_000_000);
    b
}
fn fresh() -> Registry {
    testing_env!(ctx("admin.test", 0).build());
    near_sdk::mock::with_mocked_blockchain(|b| {
        let _ = b.take_storage();
    });
    Registry::new(acct("admin.test"), "https://api.example".to_string())
}
fn args(id: &str, bps: u16) -> MintArgs {
    MintArgs {
        guardian_id: id.to_string(),
        ops_account: acct("ops.test"),
        guardian_pk: pk(),
        prompt_hash: "aa".repeat(32),
        params: VaultParams { min_fee: U128(NEAR / 10), turns_max: 8, session_ttl_ms: U64(600_000), max_open_per_attacker: 1 },
        royalty_bps: bps,
        allowance: None,
    }
}
/// Simulates a successful vault batch: the callback mints the token.
fn mint(r: &mut Registry, id: &str, creator: &str, bps: u16) {
    testing_env!(ctx(REG, 0).build());
    let vault = acct(&format!("{id}.{REG}"));
    let t = r.on_vault_created(id.to_string(), acct(creator), vault, bps, U128(5 * NEAR), Ok(()));
    assert!(t.is_some());
}
fn big_deposit(r: &Registry) -> u128 {
    r.mint_requirements(None).0 + NEAR
}

#[test]
fn guardian_id_validation() {
    for ok in ["a", "strong", "g-1_x", "9lives", &"a".repeat(32)] {
        assert!(valid_guardian_id(ok), "{ok}");
    }
    for bad in ["", "-a", "_a", "A", "a.b", "a b", "ä", &"a".repeat(33)] {
        assert!(!valid_guardian_id(bad), "{bad}");
    }
}

#[test]
fn royalty_math_never_exceeds_balance_and_conserves_value() {
    for bal in [0u128, 1, 9_999, 10_000, 123_456_789, 10 * NEAR, u128::MAX / 4] {
        for bps in [0u16, 1, 250, 1_000, MAX_ROYALTY_BPS] {
            let (roy, rest) = royalty_split(bal, bps);
            assert_eq!(roy + rest, bal);
            assert!(roy <= bal, "royalty never exceeds the sale price");
            if bal < u128::MAX / 20_000 {
                assert!(roy <= bal * bps as u128 / 10_000 + 1);
            }
        }
    }
    assert_eq!(royalty_split(10_000, 500), (500, 9_500));
}

#[test]
fn mint_rejects_bad_ids_royalties_and_underfunding() {
    for (id, bps, dep, msg) in [
        ("Bad.Id", 100u16, None, "guardian_id must be"),
        ("ok", 2_001, None, "royalty_bps above 2000"),
        ("ok", 100, Some(NEAR), "attach at least"),
    ] {
        let mut r = fresh();
        let d = dep.unwrap_or_else(|| big_deposit(&r));
        testing_env!(ctx("creator.test", d).build());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = r.mint_guardian(args(id, bps));
        }));
        let err = *res.unwrap_err().downcast::<String>().unwrap_or_else(|e| Box::new(format!("{:?}", e.downcast_ref::<&str>())));
        assert!(err.contains(msg), "expected `{msg}` in `{err}`");
    }
}

#[test]
fn mint_batch_contains_only_a_function_call_key_never_full_access() {
    let mut r = fresh();
    let d = big_deposit(&r);
    testing_env!(ctx("creator.test", d).build());
    let _ = r.mint_guardian(args("g1", 500));
    let acts: Vec<_> = get_created_receipts().into_iter().flat_map(|x| x.actions).collect();
    use near_sdk::mock::MockAction::*;
    assert!(acts.iter().any(|a| matches!(a, CreateAccount { .. })));
    assert!(acts.iter().any(|a| matches!(a, DeployContract { .. })));
    assert!(acts.iter().any(|a| matches!(a, AddKeyWithFunctionCall { method_names, .. } if method_names == &vec!["release".to_string(), "close_session".to_string()])));
    assert!(!acts.iter().any(|a| matches!(a, AddKeyWithFullAccess { .. })), "no full-access key may ever be added");
}

#[test]
fn failed_vault_batch_mints_nothing_and_refunds_creator() {
    let mut r = fresh();
    testing_env!(ctx(REG, 0).build());
    let t = r.on_vault_created("g1".into(), acct("creator.test"), acct("g1.reg.test"), 100, U128(5 * NEAR), Err(PromiseError::Failed));
    assert!(t.is_none());
    assert_eq!(r.nft_total_supply().0, 0);
    let refund: Vec<_> = get_created_receipts().into_iter().filter(|x| x.receiver_id == acct("creator.test")).collect();
    assert_eq!(refund.len(), 1);
}

#[test]
fn minted_token_has_live_reference_and_enumeration() {
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 500);
    let t = r.nft_token("g1".into()).unwrap();
    assert_eq!(t.owner_id, acct("creator.test"));
    assert_eq!(t.metadata.unwrap().reference.unwrap(), "https://api.example/guardians/g1/metadata.json");
    assert_eq!(r.nft_supply_for_owner(acct("creator.test")).0, 1);
    assert_eq!(r.nft_tokens_for_owner(acct("creator.test"), None, None).len(), 1);
    assert_eq!(r.get_vault("g1".into()).unwrap().vault, acct("g1.reg.test"));
    assert_eq!(r.nft_metadata().symbol, "VBG");
}

#[test]
#[should_panic(expected = "token_id must be unique")]
fn duplicate_mint_callback_is_rejected_by_the_library() {
    // on_vault_created checks first and refunds; reaching the library check means an id collision slipped through
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 0);
    r.tokens.internal_mint_with_refund("g1".into(), acct("x.test"), Some(TokenMetadata::default()), None);
}

#[test]
fn only_the_owner_can_transfer_and_one_yocto_is_required() {
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 0);
    testing_env!(ctx("mallory.test", 1).build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = r.nft_transfer(acct("mallory.test"), "g1".into(), None, None);
    }));
    assert!(res.is_err(), "non-owner must not transfer");
    testing_env!(ctx("creator.test", 0).build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = r.nft_transfer(acct("bob.test"), "g1".into(), None, None);
    }));
    assert!(res.is_err(), "needs exactly 1 yoctoNEAR");
    assert_eq!(r.nft_token("g1".into()).unwrap().owner_id, acct("creator.test"));
}

#[test]
fn transfer_calls_vault_set_owner_and_a_refusal_reverts_the_nft() {
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 0);
    testing_env!(ctx("creator.test", 1).build());
    let _ = r.nft_transfer(acct("bob.test"), "g1".into(), None, None);
    assert_eq!(r.nft_token("g1".into()).unwrap().owner_id, acct("bob.test"));
    let calls: Vec<_> = get_created_receipts().into_iter().filter(|x| x.receiver_id == acct("g1.reg.test")).collect();
    assert_eq!(calls.len(), 1, "set_owner is sent to the vault");
    // vault refuses -> callback reverts
    testing_env!(ctx(REG, 0).build());
    let ok = r.on_owner_synced("g1".into(), acct("creator.test"), acct("bob.test"), Err(PromiseError::Failed));
    assert!(!ok);
    assert_eq!(r.nft_token("g1".into()).unwrap().owner_id, acct("creator.test"));
    assert_eq!(r.nft_supply_for_owner(acct("bob.test")).0, 0);
    // vault accepts -> NFT stays with the receiver
    testing_env!(ctx("creator.test", 1).build());
    let _ = r.nft_transfer(acct("bob.test"), "g1".into(), None, None);
    testing_env!(ctx(REG, 0).build());
    assert!(r.on_owner_synced("g1".into(), acct("creator.test"), acct("bob.test"), Ok(())));
    assert_eq!(r.nft_token("g1".into()).unwrap().owner_id, acct("bob.test"));
}

#[test]
#[should_panic(expected = "nft_transfer_call is not supported")]
fn nft_transfer_call_is_explicitly_unsupported() {
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 0);
    testing_env!(ctx("creator.test", 1).build());
    r.nft_transfer_call(acct("bob.test"), "g1".into(), None, None, "".into());
}

#[test]
fn nep199_payout_pays_creator_royalty_and_seller_remainder() {
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 500); // 5%
    let p = r.nft_payout("g1".into(), U128(100 * NEAR), None).payout;
    assert_eq!(p.get(&acct("creator.test")).unwrap().0, 100 * NEAR); // creator is also the seller: 5 + 95 merged
    assert_eq!(p.len(), 1);
    // after a transfer the new owner is the seller; creator keeps the royalty
    testing_env!(ctx("creator.test", 1).build());
    let _ = r.nft_transfer(acct("bob.test"), "g1".into(), None, None);
    let p = r.nft_payout("g1".into(), U128(100 * NEAR), Some(2)).payout;
    assert_eq!(p.get(&acct("creator.test")).unwrap().0, 5 * NEAR);
    assert_eq!(p.get(&acct("bob.test")).unwrap().0, 95 * NEAR);
    assert_eq!(p.values().map(|v| v.0).sum::<u128>(), 100 * NEAR);
    // max_len_payout smaller than the map must fail
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| r.nft_payout("g1".into(), U128(100 * NEAR), Some(1))));
    assert!(res.is_err());
}

#[test]
fn nft_transfer_payout_transfers_and_returns_seller_payout() {
    let mut r = fresh();
    mint(&mut r, "g1", "creator.test", 1_000); // 10%
    testing_env!(ctx("creator.test", 1).build());
    let _ = r.nft_transfer(acct("bob.test"), "g1".into(), None, None); // bob owns now
    testing_env!(ctx("bob.test", 1).build());
    let p = r.nft_transfer_payout(acct("carol.test"), "g1".into(), None, None, U128(10 * NEAR), Some(10)).payout;
    assert_eq!(p.get(&acct("creator.test")).unwrap().0, NEAR);
    assert_eq!(p.get(&acct("bob.test")).unwrap().0, 9 * NEAR); // computed for the SELLER (previous owner)
    assert_eq!(r.nft_token("g1".into()).unwrap().owner_id, acct("carol.test"));
}

#[test]
fn only_admin_can_set_base_uri() {
    let mut r = fresh();
    testing_env!(ctx("mallory.test", 0).build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| r.set_base_uri("https://evil".into())));
    assert!(res.is_err());
    testing_env!(ctx("admin.test", 0).build());
    r.set_base_uri("https://new.example/".into());
    mint(&mut r, "g2", "creator.test", 0);
    assert_eq!(r.nft_token("g2".into()).unwrap().metadata.unwrap().reference.unwrap(), "https://new.example/guardians/g2/metadata.json");
}

#[test]
fn registry_source_never_adds_full_access_keys() {
    let src = include_str!("lib.rs");
    let prod = src.split("#[cfg(test)]
mod tests;").next().unwrap();
    // scan code only (comments may mention the forbidden names)
    let code: String = prod.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("
");
    for banned in ["add_full_access_key", "FullAccess", "full_access", "delete_account", "add_access_key("] {
        assert!(!code.contains(banned), "registry code must not use `{banned}`");
    }
    assert!(code.contains("add_access_key_allowance"), "the only key it adds is the restricted function-call key");
}
