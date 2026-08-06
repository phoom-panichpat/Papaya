import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BackStackProvider } from "./lib/backstack.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BackStackProvider>
      <App />
    </BackStackProvider>
  </StrictMode>
);
