import React from "react";
import { Link } from "react-router-dom";
import { ROUTES } from "../../../config/routes.js";

export default function DiagnosticHeader({ onCancel }) {
  return (
    <header className="ra-header">
      {onCancel ? (
        <button type="button" className="ra-header-back" onClick={onCancel}>
          ← Cancel placement
        </button>
      ) : (
        <Link to={ROUTES.READING} className="ra-header-back">
          ← Reading Academy
        </Link>
      )}
      <h1 className="ra-header-title">Placement</h1>
      <p className="ra-header-status">
        A short check to figure out where to start. Three items per skill.
      </p>
    </header>
  );
}
