//! Unit + property tests for the seven invariants in SPEC.md 5.1.
use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;
use proptest::prelude::*;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const VAULT: &str = "v.test";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}
fn pk2() -> PublicKey {
    "ed25519:Gc5q7W1zQ6wH1D1B6a5oXG6Y9T8bB1mYkG2Xo3c9s4vH".parse().unwrap()
}
const HASH: &str = "aa00000000000000000000000000000000000000000000000000000000000001";

fn ctx(pred: &str, deposit: u128, ts_ms: u64, balance: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(VAULT))
        .predecessor_account_id(acct(pred))
        .signer_account_id(acct(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_ms * 1_000_000)
        .account_balance(NearToken::from_yoctonear(balance))
        .storage_usage(10_000);
    b
}
fn params() -> Params {
    Params { min_fee: U128(NEAR / 10), turns_max: 10, session_ttl_ms: U64(60_000), max_open_per_attacker: 1 }
}
fn new_vault(seed: u128) -> Vault {
    testing_env!(ctx("creator.test", seed, 0, 100 * NEAR).build());
    // testing_env! preserves mocked storage across calls (and across proptest cases): start clean.
    near_sdk::mock::with_mocked_blockchain(|b| {
        let _ = b.take_storage();
    });
    Vault::new(acct("creator.test"), acct("ops.test"), pk(), HASH.into(), params(), Some(acct("reg.test")))
}
fn start(v: &mut Vault, who: &str, fee: u128, ts: u64) -> u64 {
    testing_env!(ctx(who, fee, ts, 100 * NEAR).build());
    v.start_session().0
}
fn as_guardian(ts: u64, balance: u128) {
    testing_env!(ctx(VAULT, 0, ts, balance).build());
}
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}
fn owed(v: &Vault) -> u128 {
    v.pot + v.creator_balance + v.ops_balance
}

// ---- Invariant 1: release pays exactly `pot`, only to session.attacker ----
#[test]
fn inv1_release_pays_pot_to_recorded_attacker_only() {
    let mut v = new_vault(5 * NEAR);
    let id = start(&mut v, "alice.test", NEAR, 1);
    let pot_before = v.pot;
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(id));
    assert_eq!(transfers(), vec![("alice.test".to_string(), pot_before)]);
    assert_eq!(v.pot, 0);
}

proptest! {
    #[test]
    fn inv1_prop_release_amount_equals_pot(seed in 1u128..50*NEAR, fees in proptest::collection::vec(NEAR/10..5*NEAR, 1..6)) {
        let mut v = new_vault(seed);
        let mut last = 0;
        for (i, f) in fees.iter().enumerate() {
            last = start(&mut v, &format!("a{}.test", i), *f, 1);
        }
        let attacker = v.sessions.get(&last).unwrap().attacker.to_string();
        let pot = v.pot;
        as_guardian(2, 1000 * NEAR);
        let _ = v.release(U64(last));
        prop_assert_eq!(transfers(), vec![(attacker, pot)]);
    }

    // Invariant 2: balance (modelled as initial + all deposits) always covers accounted buckets + storage.
    #[test]
    fn inv2_prop_accounting_never_exceeds_balance(seed in 1u128..50*NEAR, fees in proptest::collection::vec(NEAR/10..5*NEAR, 1..8)) {
        let mut v = new_vault(seed);
        let mut balance = seed + 2 * NEAR; // storage/gas buffer funded at account creation
        for (i, f) in fees.iter().enumerate() {
            start(&mut v, &format!("a{}.test", i), *f, 1);
            balance += *f;
            let storage = 10_000u128 * env::storage_byte_cost().as_yoctonear();
            prop_assert!(balance >= owed(&v) + storage);
        }
    }

    // fee split never creates or destroys value
    #[test]
    fn split_conserves(net in 0u128..u128::MAX/200) {
        let (p, c, o) = split_fee(net);
        prop_assert_eq!(p + c + o, net);
    }
}

#[test]
#[should_panic(expected = "solvency invariant violated")]
fn inv2_release_refuses_when_balance_cannot_cover() {
    let mut v = new_vault(5 * NEAR);
    let id = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(2, v.pot / 2); // balance far below pot
    let _ = v.release(U64(id));
}

// ---- Invariant 3: a session pays at most once ----
#[test]
#[should_panic(expected = "vault is defeated")]
fn inv3_second_release_same_session_fails() {
    let mut v = new_vault(5 * NEAR);
    let id = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(id));
    let _ = v.release(U64(id));
}
#[test]
#[should_panic(expected = "vault is defeated")]
fn inv3_cannot_release_other_session_after_defeat() {
    let mut v = new_vault(5 * NEAR);
    let a = start(&mut v, "alice.test", NEAR, 1);
    let b = start(&mut v, "bob.test", NEAR, 1);
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(a));
    let _ = v.release(U64(b));
}
#[test]
#[should_panic(expected = "vault is defeated")]
fn inv3_no_new_sessions_when_defeated() {
    let mut v = new_vault(5 * NEAR);
    let a = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(a));
    start(&mut v, "bob.test", NEAR, 3);
}
#[test]
fn inv3_failed_payout_restores_state_without_double_pay() {
    let mut v = new_vault(5 * NEAR);
    let id = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(id));
    as_guardian(3, 100 * NEAR);
    v.on_payout(PayoutKind::Pot, Some(U64(id)), U128(5 * NEAR), Err(PromiseError::Failed));
    assert_eq!(v.status, VaultStatus::Armed);
    assert_eq!(v.sessions.get(&id).unwrap().status, SessionStatus::Failed); // cannot be released again
    assert_eq!(v.sessions.get(&id).unwrap().payout, 0, "a bounced payout is not recorded as paid");
}

// ---- Invariant 4: only the vault's own keys can call release / close_session ----
#[test]
fn inv4_only_self_can_release_or_close() {
    for who in ["alice.test", "creator.test", "ops.test", "reg.test", "attacker.test"] {
        let mut v = new_vault(5 * NEAR);
        let id = start(&mut v, "alice.test", NEAR, 1);
        testing_env!(ctx(who, 0, 2, 100 * NEAR).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = v.release(U64(id));
        }));
        assert!(r.is_err(), "{who} must not release");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.close_session(U64(id), HASH.into(), 0)));
        assert!(r.is_err(), "{who} must not close");
        assert_eq!(v.sessions.get(&id).unwrap().status, SessionStatus::Open);
    }
}

// ---- Invariant 5: owner can never withdraw the pot ----
#[test]
fn inv5_owner_claim_pays_only_creator_balance() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "alice.test", NEAR, 1);
    let creator = v.creator_balance;
    let pot = v.pot;
    assert!(creator > 0 && pot > 0);
    testing_env!(ctx("creator.test", 0, 2, 100 * NEAR).build());
    let _ = v.claim_creator_fees();
    assert_eq!(transfers(), vec![("creator.test".to_string(), creator)]);
    assert_eq!(v.pot, pot);
}
#[test]
#[should_panic(expected = "vault is armed")]
fn inv5_owner_cannot_rearm_to_touch_pot_while_armed() {
    let mut v = new_vault(5 * NEAR);
    testing_env!(ctx("creator.test", NEAR, 2, 100 * NEAR).build());
    v.rearm();
}
#[test]
#[should_panic(expected = "only owner")]
fn inv5_non_owner_cannot_claim_creator_fees() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "alice.test", NEAR, 1);
    testing_env!(ctx("alice.test", 0, 2, 100 * NEAR).build());
    let _ = v.claim_creator_fees();
}
#[test]
fn inv5_rearm_after_defeat_reseeds() {
    let mut v = new_vault(5 * NEAR);
    let id = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(id));
    testing_env!(ctx("creator.test", 3 * NEAR, 3, 100 * NEAR).build());
    v.rearm();
    assert_eq!((v.status, v.pot), (VaultStatus::Armed, 3 * NEAR));
}

// ---- Invariant 6: owner can't attack; per-attacker open limit ----
#[test]
#[should_panic(expected = "owner cannot attack")]
fn inv6_owner_cannot_start_session() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "creator.test", NEAR, 1);
}
#[test]
#[should_panic(expected = "too many open sessions")]
fn inv6_max_open_enforced() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "alice.test", NEAR, 1);
    start(&mut v, "alice.test", NEAR, 2);
}
#[test]
fn inv6_slot_frees_after_close_and_expire() {
    let mut v = new_vault(5 * NEAR);
    let a = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(2, 100 * NEAR);
    v.close_session(U64(a), HASH.into(), 2);
    assert_eq!(v.get_open_count(acct("alice.test")), 0);
    let b = start(&mut v, "alice.test", NEAR, 3);
    testing_env!(ctx("anyone.test", 0, 1_000_000, 100 * NEAR).build());
    v.expire_session(U64(b)); // anyone may expire after TTL
    assert_eq!(v.get_open_count(acct("alice.test")), 0);
    assert_eq!(v.get_stats().blocked_reported, 2);
}
#[test]
#[should_panic(expected = "not expired yet")]
fn expire_before_ttl_fails() {
    let mut v = new_vault(5 * NEAR);
    let a = start(&mut v, "alice.test", NEAR, 1);
    testing_env!(ctx("anyone.test", 0, 5, 100 * NEAR).build());
    v.expire_session(U64(a));
}
#[test]
#[should_panic(expected = "session expired")]
fn release_after_ttl_fails() {
    let mut v = new_vault(5 * NEAR);
    let a = start(&mut v, "alice.test", NEAR, 1);
    as_guardian(1_000_000, 100 * NEAR);
    let _ = v.release(U64(a));
}
#[test]
#[should_panic(expected = "deposit below min_fee")]
fn fee_below_min_rejected() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "alice.test", NEAR / 100, 1);
}

// ---- Fee split, ops, rotation, registry ----
#[test]
fn fee_split_is_70_20_10() {
    assert_eq!(split_fee(1000), (700, 200, 100));
}
#[test]
fn ops_claim_only_by_ops_account() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "alice.test", NEAR, 1);
    let ops = v.ops_balance;
    testing_env!(ctx("ops.test", 0, 2, 100 * NEAR).build());
    let _ = v.claim_ops();
    assert_eq!(transfers(), vec![("ops.test".to_string(), ops)]);
}
#[test]
#[should_panic(expected = "only ops account")]
fn ops_claim_rejected_for_others() {
    let mut v = new_vault(5 * NEAR);
    start(&mut v, "alice.test", NEAR, 1);
    testing_env!(ctx("creator.test", 0, 2, 100 * NEAR).build());
    let _ = v.claim_ops();
}
#[test]
fn rotate_adds_only_function_call_key_and_deletes_old() {
    let mut v = new_vault(5 * NEAR);
    testing_env!(ctx("creator.test", 0, 2, 100 * NEAR).build());
    let _ = v.rotate_guardian_key(pk2(), U128(NEAR / 10));
    let acts: Vec<_> = get_created_receipts().into_iter().flat_map(|r| r.actions).collect();
    assert!(acts.iter().any(|a| matches!(a, MockAction::AddKeyWithFunctionCall { method_names, .. } if method_names == &vec!["release".to_string(), "close_session".to_string()])));
    assert!(acts.iter().any(|a| matches!(a, MockAction::DeleteKey { .. })));
    assert!(!acts.iter().any(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. })));
}
#[test]
#[should_panic(expected = "only owner")]
fn rotate_owner_only() {
    let mut v = new_vault(5 * NEAR);
    testing_env!(ctx("alice.test", 0, 2, 100 * NEAR).build());
    let _ = v.rotate_guardian_key(pk2(), U128(1));
}
#[test]
#[should_panic(expected = "only registry")]
fn set_owner_registry_only() {
    let mut v = new_vault(5 * NEAR);
    testing_env!(ctx("creator.test", 0, 2, 100 * NEAR).build());
    v.set_owner(acct("x.test"));
}

// ---- Invariant 7: no code path adds a full-access key ----
#[test]
fn inv7_source_never_adds_full_access_or_unrestricted_keys() {
    let src = include_str!("lib.rs");
    let prod = src.split("#[cfg(test)]").next().unwrap();
    for banned in ["add_full_access_key", "FullAccess", "full_access", "deploy_contract", "add_access_key(", "create_account", "delete_account"] {
        assert!(!prod.contains(banned), "vault source must not contain `{banned}`");
    }
}

// ---- Layer 4: the session records exactly what it paid (pools settle from this) ----
#[test]
fn released_session_records_payout_for_pool_settlement() {
    let mut v = new_vault(5 * NEAR);
    let id = start(&mut v, "alice.test", NEAR, 1);
    assert_eq!(v.get_session(U64(id)).unwrap().payout.0, 0, "nothing paid yet");
    let pot = v.pot;
    as_guardian(2, 100 * NEAR);
    let _ = v.release(U64(id));
    let s = v.get_session(U64(id)).unwrap();
    assert_eq!(s.status, SessionStatus::Won);
    assert_eq!(s.payout.0, pot);
}
