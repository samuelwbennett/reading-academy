import React from "react";
import { Link } from "react-router-dom";
import { ROUTES } from "../../../config/routes.js";

export default function ReadingHeader({ nodeCount, valid }) {
  return (
    <header className="ra-header">
      <Link to={ROUTES.HOME} className="ra-header-back">
        ← VPA Learning OS
      </Link>
      <h1 className="ra-header-title">Reading Academy</h1>
      <p className="ra-header-status">
        <span className={`ra-header-dot ${valid ? "ok" : "bad"}`} />
        {nodeCount}-node graph loaded{valid ? "" : " (validation errors — see console)"}
      </p>
    </header>
  );
}
