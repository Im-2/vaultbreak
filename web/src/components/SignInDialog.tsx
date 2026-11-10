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
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dialog) { setErr(null); setTimeout(() => first.current?.focus(), 50); } }, [dialog]);
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
        <label>Passphrase<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="at least 6 characters" minLength={6} required autoComplete="current-password" /></label>
        {err && <div className="form-error" role="alert">{err}</div>}
        <p className="fine">Demo-grade sign-in: the server holds the play account. Do not reuse a real password, and do not put real funds here.</p>
        <div className="modal__actions"><Pill small onClick={closeDialog}>Cancel</Pill><Pill variant="solid" type="submit" arrow disabled={busy}>{busy ? "Opening…" : "Continue"}</Pill></div>
      </form>
    </div>
  );
}
