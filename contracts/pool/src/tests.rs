use super::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;
use proptest::prelude::*;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const POOL: &str = "pool.test";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(pred: &str, deposit: u128, ts_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(POOL))
        .predecessor_account_id(acct(pred))
        .signer_account_id(acct(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(10_000))
        .block_timestamp(ts_ms * 1_000_000);
    b
}
fn fresh() -> PoolContract {
    testing_env!(ctx("deployer.test", 0, 1).build());
    near_sdk::mock::with_mocked_blockchain(|b| {
        let _ = b.take_storage();
    });
    PoolContract::new(acct("reg.test"))
}
fn open(p: &mut PoolContract, controller: Option<&str>) -> U64 {
    testing_env!(ctx("alice.test", 0, 1).build());
    p.create_pool("g1".into(), U128(5 * NEAR), controller.map(acct), U64(600_000))
}
fn contribute(p: &mut PoolContract, id: U64, who: &str, amount: u128) {
    testing_env!(ctx(who, amount, 2).build());
    p.contribute(id);
}
fn self_call() {
    testing_env!(ctx(POOL, 0, 3).build());
}

// ---------------------------------------------------------------- math
#[test]
fn mul_div_known_values() {
    assert_eq!(mul_div(10, 3, 4), 7);
    assert_eq!(mul_div(0, 5, 3), 0);
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    assert_eq!(mul_div(u128::MAX, 1, 2), u128::MAX / 2);
    // 1e28 * 1e28 / 3e28 overflows u128 intermediates but must still be exact
    let big = 10_000 * NEAR;
    assert_eq!(mul_div(big, big, 3 * big), big / 3);
}

proptest! {
    // agrees with exact u128 arithmetic whenever that does not overflow
    #[test]
    fn mul_div_matches_reference(a in 0u128..u64::MAX as u128, b in 0u128..u64::MAX as u128, d in 1u128..u128::MAX) {
        let expect = (a * b) / d; // a*b < 2^128
        prop_assert_eq!(mul_div(a, b, d), expect);
    }

    // pro rata shares: never pay out more than the value, and lose at most (#contributors - 1) dust
    #[test]
    fn shares_conserve_value(contribs in proptest::collection::vec(1u128..1_000 * NEAR, 1..12), value in 0u128..100_000 * NEAR) {
        let total: u128 = contribs.iter().sum();
        let paid: u128 = contribs.iter().map(|c| share_of(value, *c, total)).sum();
        prop_assert!(paid <= value);
        prop_assert!(value - paid < contribs.len() as u128);
    }
}

// ---------------------------------------------------------------- creation + contribution rules
#[test]
fn create_pool_validates_inputs() {
    let mut p = fresh();
    testing_env!(ctx("alice.test", 0, 1).build());
    for (g, budget, dl, msg) in [("", 1u128, 600_000u64, "registry label"), ("a.b", 1, 600_000, "registry label"), ("g", 0, 600_000, "target_fee_budget"), ("g", 1, 10, "deadline_ms")] {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.create_pool(g.into(), U128(budget), None, U64(dl))));
        let e = res.unwrap_err();
        let m = e.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(m.contains(msg), "{g:?}: `{m}` should contain `{msg}`");
    }
    let id = p.create_pool("g1".into(), U128(NEAR), None, U64(60_000));
    let v = p.get_pool(id).unwrap();
    assert_eq!(v.vault, acct("g1.reg.test"), "vault is derived from the registry: never caller-chosen");
    assert_eq!(v.controller, acct("alice.test"), "controller defaults to the creator");
    assert_eq!(v.status, PoolStatus::Funding);
}

#[test]
fn contributions_accumulate_per_account_and_have_a_minimum() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    contribute(&mut p, id, "bob.test", 2 * NEAR);
    contribute(&mut p, id, "carol.test", NEAR);
    let v = p.get_pool(id).unwrap();
    assert_eq!((v.total_contributed.0, v.contributors), (4 * NEAR, 2));
    assert_eq!(p.get_contribution(id, acct("bob.test")).unwrap().amount, 3 * NEAR);
    assert_eq!(p.get_held().0, 4 * NEAR);
    testing_env!(ctx("dave.test", 1, 2).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.contribute(id))).is_err(), "below minimum");
}

// ---------------------------------------------------------------- attack authorisation + accounting
#[test]
fn only_the_controller_attacks_and_fees_are_bounded() {
    let mut p = fresh();
    let id = open(&mut p, Some("ctl.test"));
    contribute(&mut p, id, "bob.test", NEAR);
    for (who, fee, msg) in [("bob.test", NEAR / 2, "only the pool controller"), ("ctl.test", 2 * NEAR, "exceeds the pool's unspent"), ("ctl.test", 0, "fee must be > 0")] {
        testing_env!(ctx(who, 0, 3).build());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.attack_with_pool(id, U128(fee)); }));
        let m = res.unwrap_err().downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(m.contains(msg), "`{m}` should contain `{msg}`");
    }
    // target_fee_budget (5 NEAR) caps fees even if the pool has more money
    let mut p2 = fresh();
    let id2 = open(&mut p2, None);
    contribute(&mut p2, id2, "bob.test", 10 * NEAR);
    testing_env!(ctx("alice.test", 0, 3).build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p2.attack_with_pool(id2, U128(6 * NEAR)); }));
    assert!(res.unwrap_err().downcast_ref::<String>().unwrap().contains("target_fee_budget"));
}

#[test]
fn attack_reserves_the_fee_and_sends_start_session_with_the_fee_attached() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    testing_env!(ctx("alice.test", 0, 3).build());
    let _ = p.attack_with_pool(id, U128(NEAR / 10));
    let v = p.get_pool(id).unwrap();
    assert_eq!((v.fees_spent.0, v.status), (NEAR / 10, PoolStatus::Attacking));
    assert_eq!(p.get_held().0, NEAR - NEAR / 10);
    let r: Vec<_> = get_created_receipts().into_iter().filter(|r| r.receiver_id == acct("g1.reg.test")).collect();
    assert_eq!(r.len(), 1, "start_session goes to the vault named by the registry");
    // a second attack while the first is starting is refused
    testing_env!(ctx("alice.test", 0, 3).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.attack_with_pool(id, U128(1)); })).is_err());
}

#[test]
fn vault_refusal_restores_the_reserved_fee() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    testing_env!(ctx("alice.test", 0, 3).build());
    let _ = p.attack_with_pool(id, U128(NEAR / 10));
    self_call();
    assert!(p.on_attack_started(id, U128(NEAR / 10), Err(PromiseError::Failed)).is_none());
    let v = p.get_pool(id).unwrap();
    assert_eq!((v.fees_spent.0, v.status, v.open_session), (0, PoolStatus::Funding, None));
    assert_eq!(p.get_held().0, NEAR, "nothing left the pool");
    // and the pool can attack again
    testing_env!(ctx("alice.test", 0, 4).build());
    let _ = p.attack_with_pool(id, U128(NEAR / 10));
}

// ---------------------------------------------------------------- settlement + payouts
fn started(p: &mut PoolContract, id: U64, fee: u128, session: u64) {
    testing_env!(ctx("alice.test", 0, 3).build());
    let _ = p.attack_with_pool(id, U128(fee));
    self_call();
    assert_eq!(p.on_attack_started(id, U128(fee), Ok(U64(session))), Some(U64(session)));
}

#[test]
fn won_pool_splits_winnings_plus_unspent_pro_rata() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR); // 25%
    contribute(&mut p, id, "carol.test", 3 * NEAR); // 75%
    started(&mut p, id, NEAR / 10, 7);
    // a vault says Open -> nothing happens
    self_call();
    assert_eq!(p.on_session_status(id, U64(7), Ok(Some(VaultSession { status: "Open".into(), payout: None }))), "open");
    // Won with a 20 NEAR payout
    let payout = 20 * NEAR;
    testing_env!(ctx(POOL, 0, 3).account_balance(NearToken::from_near(10_000)).build());
    assert_eq!(p.on_session_status(id, U64(7), Ok(Some(VaultSession { status: "Won".into(), payout: Some(U128(payout)) }))), "won");
    let v = p.get_pool(id).unwrap();
    assert_eq!((v.status, v.winnings.0, v.open_session), (PoolStatus::Won, payout, None));
    let value = payout + 4 * NEAR - NEAR / 10; // winnings + unspent
    assert_eq!(p.preview_share(id, acct("bob.test")).0, value / 4);
    assert_eq!(p.preview_share(id, acct("carol.test")).0, value / 4 * 3);
    // bob withdraws once
    testing_env!(ctx("bob.test", 0, 4).build());
    let _ = p.withdraw(id);
    let r: Vec<_> = get_created_receipts().into_iter().filter(|r| r.receiver_id == acct("bob.test")).collect();
    assert_eq!(r.len(), 1);
    testing_env!(ctx("bob.test", 0, 5).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.withdraw(id); })).is_err(), "double claim refused");
    // a bounced transfer restores the claim and the books
    let held = p.get_held().0;
    self_call();
    assert!(!p.on_withdraw(id, acct("bob.test"), U128(value / 4), Err(PromiseError::Failed)));
    assert_eq!(p.get_held().0, held + value / 4);
    assert!(!p.get_contribution(id, acct("bob.test")).unwrap().claimed);
    // outsiders and refund-on-won are refused
    testing_env!(ctx("mallory.test", 0, 5).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.withdraw(id); })).is_err());
    testing_env!(ctx("carol.test", 0, 5).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.refund(id); })).is_err(), "refund is only for pools that did not win");
}

#[test]
fn lost_pool_refunds_unspent_funds_pro_rata() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    contribute(&mut p, id, "carol.test", 3 * NEAR);
    started(&mut p, id, NEAR / 2, 1);
    self_call();
    assert_eq!(p.on_session_status(id, U64(1), Ok(Some(VaultSession { status: "Failed".into(), payout: None }))), "lost");
    assert_eq!(p.get_pool(id).unwrap().status, PoolStatus::Attacking, "may try again");
    // not refundable while still running
    testing_env!(ctx("bob.test", 0, 4).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.refund(id); })).is_err());
    // only the controller closes before the deadline
    testing_env!(ctx("bob.test", 0, 4).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.close_pool(id))).is_err());
    testing_env!(ctx("alice.test", 0, 4).build());
    p.close_pool(id);
    let unspent = 4 * NEAR - NEAR / 2;
    assert_eq!(p.preview_share(id, acct("bob.test")).0, unspent / 4);
    testing_env!(ctx("carol.test", 0, 5).build());
    let _ = p.refund(id);
    assert_eq!(get_created_receipts().into_iter().filter(|r| r.receiver_id == acct("carol.test")).count(), 1);
}

#[test]
fn anyone_can_close_after_the_deadline_but_not_with_an_open_session() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    testing_env!(ctx("stranger.test", 0, 700_000).build());
    p.close_pool(id);
    assert_eq!(p.get_pool(id).unwrap().status, PoolStatus::Closed);
    // contributions are refused once closed
    testing_env!(ctx("bob.test", NEAR, 700_001).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.contribute(id))).is_err());
    // open session blocks closing
    let id2 = open(&mut p, None);
    contribute(&mut p, id2, "bob.test", NEAR);
    started(&mut p, id2, NEAR / 10, 9);
    testing_env!(ctx("alice.test", 0, 4).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.close_pool(id2))).is_err());
}

#[test]
fn contributions_closed_after_the_first_attack_so_nobody_buys_in_late() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    started(&mut p, id, NEAR / 10, 1);
    testing_env!(ctx("late.test", NEAR, 4).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.contribute(id))).is_err());
}

#[test]
fn settle_needs_an_open_session_and_ignores_stale_reports() {
    let mut p = fresh();
    let id = open(&mut p, None);
    testing_env!(ctx("anyone.test", 0, 3).build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = p.settle(id); })).is_err());
    contribute(&mut p, id, "bob.test", NEAR);
    started(&mut p, id, NEAR / 10, 5);
    testing_env!(ctx("anyone.test", 0, 3).build());
    let _ = p.settle(id); // permissionless: sends get_session to the vault
    assert_eq!(get_created_receipts().into_iter().filter(|r| r.receiver_id == acct("g1.reg.test")).count(), 1);
    self_call();
    assert_eq!(p.on_session_status(id, U64(99), Ok(None)), "stale");
}

#[test]
fn a_payout_the_contract_did_not_actually_receive_is_not_booked() {
    let mut p = fresh();
    let id = open(&mut p, None);
    contribute(&mut p, id, "bob.test", NEAR);
    started(&mut p, id, NEAR / 10, 1);
    // balance far below held + payout: a lying/early report must not create winnings out of thin air
    testing_env!(ctx(POOL, 0, 3).account_balance(NearToken::from_near(1)).build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.on_session_status(id, U64(1), Ok(Some(VaultSession { status: "Won".into(), payout: Some(U128(1_000 * NEAR)) })))));
    assert!(res.is_err());
}
