import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, MotionProvider } from "./lib/hooks";
import { Cursor } from "./components/Cursor";
import { Loader } from "./components/Loader";
import { Nav } from "./components/Nav";
import { Footer } from "./components/Footer";
import { SignInDialog } from "./components/SignInDialog";
import { EmptyState } from "./components/States";
import { Pill } from "./components/Pill";
import Landing from "./pages/Landing";
import Arena from "./pages/Arena";
import GuardianPage from "./pages/GuardianPage";
import Create from "./pages/Create";
import Me from "./pages/Me";
import Swarms from "./pages/Swarms";
import Agents from "./pages/Agents";
import Proofs from "./pages/Proofs";

function ComingNext({ title }: { title: string }) {
  return (
    <main className="page page--narrow">
      <small className="label">Next up</small>
      <h1 className="display display--md">{title}</h1>
      <EmptyState title="Not built yet" text="This screen comes after the landing, arena and Guardian page have been reviewed." action={<Pill to="/arena" variant="solid" arrow>Back to the arena</Pill>} />
    </main>
  );
}

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

export default function App() {
  return (
    <MotionProvider>
      <AuthProvider>
        <Loader />
        <Cursor />
        <ScrollTop />
        <Nav />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/arena" element={<Arena />} />
          <Route path="/guardian/:id" element={<GuardianPage />} />
          <Route path="/create" element={<Create />} />
          <Route path="/me" element={<Me />} />
          <Route path="/swarms" element={<Swarms />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/proofs" element={<Proofs />} />
          <Route path="/proofs/:session" element={<Proofs />} />
          <Route path="*" element={<ComingNext title="Page not found" />} />
        </Routes>
        <Footer />
        <SignInDialog />
      </AuthProvider>
    </MotionProvider>
  );
}
