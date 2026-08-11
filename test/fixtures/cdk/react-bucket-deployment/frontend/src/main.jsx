import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const variant = __FIXTURE_VARIANT__;

function App() {
  return (
    <main className="app-shell">
      <p className="eyebrow">Public S3 website</p>
      <h1>React on stacksim</h1>
      <p id="build-version">Deterministic fixture {variant}</p>
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
