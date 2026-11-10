import { Link } from "react-router-dom";
import { ScrambleText } from "./ScrambleText";
import { useConfig } from "../lib/hooks";

export function Footer() {
  const { data: cfg } = useConfig();
  return (
    <footer className="footer dark" style={{ backgroundImage: "linear-gradient(rgba(6,8,15,.72), rgba(6,8,15,.88)), url(/assets/metal.jpg)" }}>
      <div className="footer__inner">
        <div className="footer__cols">
          <div><h4>Play</h4><Link to="/arena">Arena</Link><Link to="/create">Create a Guardian</Link><Link to="/swarms">Swarms</Link><Link to="/me">My Guardians</Link></div>
          <div><h4>Build</h4><Link to="/agents">Agents &amp; API keys</Link><Link to="/proofs">Proofs</Link></div>
          <div className="footer__note">
            <h4>Honest by design</h4>
            <p>The vault contract, not the AI, decides whether money moves. The AI holds a restricted key that can only call <code>release</code> and <code>close_session</code>; the vault has no full-access key.</p>
            {cfg && <p className="footer__net">Network: {cfg.network}{cfg.demo ? " · demo data, play money" : ""} · model: {cfg.provider === "mock" ? "scripted demo model" : `${cfg.provider} / ${cfg.model}`}{cfg.attestation === "none" ? " · no TEE attestation" : ""}</p>}
          </div>
        </div>
        <ScrambleText as="div" className="footer__word" text="Vaultbreak" />
      </div>
    </footer>
  );
}
