import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IncomingPopup } from "./views/IncomingPopup";

const popup = window.location.hash === "#incoming";
if (popup) document.documentElement.classList.add("popup");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{popup ? <IncomingPopup /> : <App />}</StrictMode>);
}
