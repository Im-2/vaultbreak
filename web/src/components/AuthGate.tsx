import type { ReactNode } from "react";
import { Pill } from "./Pill";
import { Skeleton } from "./States";
import { useAuth } from "../lib/hooks";

/** Shows children only when signed in; otherwise an inviting zero-wallet sign-in prompt. */
export function AuthGate({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  const { token, ready, openDialog } = useAuth();
  if (!ready) return <div className="gate"><Skeleton h={28} w="40%" /><Skeleton h={80} r={20} /></div>;
  if (!token) {
    return (
      <div className="gate gate--prompt">
        <small className="label">Sign in</small>
        <h2 className="display display--md">{title}</h2>
        <p>{text}</p>
        <Pill variant="solid" arrow onClick={openDialog}>Sign in with a name</Pill>
        <small className="fine muted">No wallet, keys or gas. Demo-grade sign-in with play credits.</small>
      </div>
    );
  }
  return <>{children}</>;
}
