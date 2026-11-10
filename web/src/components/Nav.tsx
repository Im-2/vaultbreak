import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Mark } from "./Mark";
import { Pill } from "./Pill";
import { useAuth, useMotion } from "../lib/hooks";

const LINKS = [["Arena", "/arena"], ["Create", "/create"], ["Swarms", "/swarms"], ["Proofs", "/proofs"]] as const;

export function Nav() {
  const { reduced, toggle } = useMotion();
  const { me, openDialog, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  return (
    <header className="nav">
      <Link to="/" className="nav__brand" aria-label="Vaultbreak home"><Mark size={26} /><span>Vaultbreak</span></Link>
      <div className="nav__right">
        <button className={`toggle ${reduced ? "" : "is-on"}`} onClick={toggle} role="switch" aria-checked={!reduced} aria-label="Animations" title={reduced ? "Animations off" : "Animations on"} data-cursor><span /></button>
        <nav className={`nav__links ${open ? "is-open" : ""}`} aria-label="Main">
          {LINKS.map(([label, to]) => (
            <NavLink key={to} to={to} onClick={() => setOpen(false)} className={({ isActive }) => `pill pill--outline pill--sm ${isActive || loc.pathname.startsWith(to) ? "is-active" : ""}`}>{label}</NavLink>
          ))}
          {me
            ? <button className="pill pill--outline pill--sm nav__me" onClick={signOut} title="Sign out">{me.name ?? "You"}<span className="nav__credit">{me.credits ? `${(Number(BigInt(me.credits) / 10n ** 22n) / 100).toFixed(1)} credits` : ""}</span></button>
            : <button className="pill pill--outline pill--sm" onClick={() => { setOpen(false); openDialog(); }}>Sign in</button>}
        </nav>
        <Pill to="/arena" variant="solid" small arrow>Play now</Pill>
        <button className="nav__burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-cursor><span /><span /></button>
      </div>
    </header>
  );
}
