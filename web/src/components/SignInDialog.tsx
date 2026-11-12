import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pill } from "./Pill";
import { useAuth } from "../lib/hooks";

/** Zero-wallet sign-in: a name and a passphrase. The server keeps a play account for you; no keys, gas or wallet pop-ups. */
export function SignInDialog() {
  const { dialog, closeDialog, signIn, refresh } = useAuth();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false); // passphrase visibility: display only; the value is sent exactly as typed
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dialog) { setErr(null); setShow(false); setTimeout(() => { if (!document.activeElement?.closest(".modal__card")) first.current?.focus(); }, 50); } }, [dialog]);
  useEffect(() => { if (!dialog) return; const k = (e: KeyboardEvent) => e.key === "Escape" && closeDialog(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [dialog, closeDialog]);
  if (!dialog) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await signIn(name, secret); refresh(); closeDialog(); setSecret(""); } catch (x: any) { setErr(x?.message ?? "Could not sign in"); } finally { setBusy(false); }
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Sign in" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <form className="modal__card" onSubmit={submit}>
        <small className="label">Play without a wallet</small>
        <h2>Pick a name.</h2>
        <p>We open a play account for you and pay the entry fee from it. New name = new account; existing name = same passphrase.</p>
        <label>Name<input ref={first} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ada" minLength={2} maxLength={32} required autoComplete="username" /></label>
        <label>Passphrase<span className="pw">
          <input type={show ? "text" : "password"} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="at least 6 characters" minLength={6} required autoComplete="current-password" />
        </span></label>
        <button type="button" className="pw__toggle" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide passphrase" : "Show passphrase"} aria-pressed={show} title={show ? "Hide passphrase" : "Show passphrase"}>
          {show ? (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 6.1A10.9 10.9 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4M6.5 7.6A13.3 13.3 0 0 0 2.5 12c1 2 4.5 6 9.5 6 1.5 0 2.8-.3 4-.9" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
        {err && <div className="form-error" role="alert">{err}</div>}
        <p className="fine">Demo-grade sign-in: the server holds the play account. Do not reuse a real password, and do not put real funds here.</p>
        <div className="modal__actions"><Pill small onClick={closeDialog}>Cancel</Pill><Pill variant="solid" type="submit" arrow disabled={busy}>{busy ? "Opening…" : "Continue"}</Pill></div>
      </form>
    </div>
  );
}
