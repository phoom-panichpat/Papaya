import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import SharedRecord from "./screens/SharedRecord.jsx";
import { BackStackProvider } from "./lib/backstack.jsx";

// /s/<token> is the PUBLIC read-only view of one shared record. It is decided
// here, before <App/> mounts, so a visitor never meets the auth gate: no
// account, no session, no sign-in. vercel.json's SPA rewrite already serves
// index.html for the path. No router library — one check is the whole routing.
const shared = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{16,})\/?$/);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BackStackProvider>
      {shared ? <SharedRecord token={shared[1]} /> : <App />}
    </BackStackProvider>
  </StrictMode>
);
