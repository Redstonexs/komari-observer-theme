import { Route, Routes } from "react-router";
import { useTranslation } from "react-i18next";
import { useBootstrap } from "@/hooks/useBootstrap";
import { useAppStore } from "@/store/app";
import { Background } from "@/components/Background";
import { Footer, Header } from "@/components/Chrome";
import { Dashboard } from "@/routes/Dashboard";
import { NodeDetail } from "@/routes/NodeDetail";
import { PingPage } from "@/routes/Ping";
import { UptimePage } from "@/routes/Uptime";

export function App() {
  useBootstrap();

  const ready = useAppStore((s) => s.ready);
  const bootError = useAppStore((s) => s.bootError);
  const needsLogin = useAppStore((s) => s.needsLogin);
  const maxWidth = useAppStore((s) => s.settings.max_width);

  const shellStyle = maxWidth > 0 ? { maxWidth: `${maxWidth}px` } : undefined;

  return (
    <>
      <Background />
      <Header />
      <main className="observer-main" style={shellStyle}>
        {!ready ? (
          <BootScreen />
        ) : needsLogin ? (
          <LoginGate />
        ) : bootError ? (
          <BootError message={bootError} />
        ) : (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/node/:uuid" element={<NodeDetail />} />
            <Route path="/ping" element={<PingPage />} />
            <Route path="/uptime" element={<UptimePage />} />
            {/* Komari serves index.html for unknown paths, so catch them here. */}
            <Route path="*" element={<Dashboard />} />
          </Routes>
        )}
      </main>
      <Footer />
    </>
  );
}

function BootScreen() {
  const { t } = useTranslation();
  return (
    <div className="observer-boot">
      <span className="observer-boot-bar" aria-hidden="true" />
      <span className="chrome">{t("boot.initializing")}</span>
    </div>
  );
}

function LoginGate() {
  const { t } = useTranslation();
  return (
    <div className="observer-notice panel">
      <h2>{t("error.privateSite")}</h2>
      <p>{t("error.loginPrompt")}</p>
      {/*
        Login lives in Komari's own built-in interface. /admin is force-served
        by the default theme server-side, so this must be a real navigation,
        not a client route.
      */}
      <a className="observer-button" href="/admin">
        {t("error.login")}
      </a>
    </div>
  );
}

function BootError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="observer-notice panel">
      <h2>{t("error.title")}</h2>
      {message && <p className="metric observer-notice-detail">{message}</p>}
      <button className="observer-button" type="button" onClick={() => window.location.reload()}>
        {t("error.retry")}
      </button>
    </div>
  );
}
