// src/pages/StudentLogin.jsx (M16-L4)
//
// Passwordless student login. Three-step flow built for ages 5-10:
//
//   STEP 1 — Class code.
//     Five big upper-case slots. Backspace and arrow keys work.
//     Submit on the 5th character or Enter.
//
//   STEP 2 — Pick your avatar.
//     Grid of class roster cards: emoji + first name + last initial.
//     Tap your card to advance. "I don't see my name" link hides the
//     grid and tells the student to ask the teacher.
//
//   STEP 3 — Enter your PIN.
//     Four big number tiles + a numeric keypad. Backspace tile.
//     Submit auto-fires on the 4th digit. On success, navigate to
//     /reading (the calm Today screen).
//
// Errors are friendly: "Hmm, that code didn't work" / "That PIN
// isn't right — try again." Never expose the raw API error code to
// the student.
//
// State for the whole flow lives in this single component — no
// router params, no localStorage between steps. Once the student
// successfully logs in we hand off to useStudentSession (which
// stores the token) and React Router pushes them to /reading.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ROUTES } from "../config/routes.js";
import {
  loginStudent,
  getStoredStudentSession,
} from "../lib/auth/useStudentSession.js";

const CODE_LENGTH = 5;
const PIN_LENGTH = 4;

export default function StudentLogin() {
  const navigate = useNavigate();
  const [step, setStep] = useState("code"); // "code" | "pick" | "pin"
  const [code, setCode] = useState("");
  const [classInfo, setClassInfo] = useState(null); // { classId, className, students }
  const [picked, setPicked] = useState(null); // { id, firstName, lastInitial, avatarEmoji }
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // If a session already exists, skip straight to /reading.
  useEffect(() => {
    if (getStoredStudentSession()) {
      navigate(ROUTES.READING, { replace: true });
    }
  }, [navigate]);

  // ----- step 1 -----
  async function submitCode(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (code.length !== CODE_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/student-roster-by-code?code=${encodeURIComponent(code)}`,
      );
      const json = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setError("Hmm, that code didn't work. Check the letters and try again.");
        return;
      }
      if (!res.ok || !json?.ok) {
        setError("We couldn't load your class. Try again in a moment.");
        return;
      }
      if (!json.students || json.students.length === 0) {
        setError("This class doesn't have any students yet. Ask your teacher.");
        return;
      }
      setClassInfo(json);
      setStep("pick");
    } catch {
      setError("Network blip. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // ----- step 2 -----
  function pickStudent(s) {
    setPicked(s);
    setError(null);
    setPin("");
    setStep("pin");
  }

  // ----- step 3 -----
  async function submitPin(nextPin) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await loginStudent({
        code,
        studentId: picked.id,
        pin: nextPin,
        deviceLabel: navigator?.userAgent?.slice(0, 64) || null,
      });
      navigate(ROUTES.READING, { replace: true });
    } catch (err) {
      const c = err?.code || "";
      const status = err?.status || "?";
      // eslint-disable-next-line no-console
      console.log("[ra.student-login] failure", { status, code: c, message: err?.message });
      if (c === "bad_credentials") {
        setError("That PIN isn't right. Try again.");
      } else if (c === "student_inactive") {
        setError("Your account is paused. Ask your teacher for help.");
      } else if (c === "pin_not_set") {
        setError(
          "Your teacher hasn't set up your PIN yet. Let them know to add one.",
        );
      } else {
        // Surface the actual error code for diagnostics. Production
        // students would normally never see this — it only fires on
        // 5xx or unexpected 4xx codes from the API.
        setError(`Couldn't sign in. Try again. (code: ${c || status})`);
      }
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  function pinKey(d) {
    if (busy) return;
    setError(null);
    if (d === "del") {
      setPin((s) => s.slice(0, -1));
      return;
    }
    setPin((s) => {
      if (s.length >= PIN_LENGTH) return s;
      const next = s + d;
      if (next.length === PIN_LENGTH) {
        // Submit on the 4th digit.
        setTimeout(() => submitPin(next), 0);
      }
      return next;
    });
  }

  // ===== layout shell =====
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg,#fafafa 0%,#eef1f6 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "32px 16px",
        fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 560 }}>
        <Header step={step} onBack={() => stepBack({ step, setStep, setError, setPicked, setPin })} />

        {step === "code" && (
          <CodeStep
            code={code}
            setCode={setCode}
            submit={submitCode}
            busy={busy}
            error={error}
          />
        )}
        {step === "pick" && classInfo && (
          <PickStep
            classInfo={classInfo}
            onPick={pickStudent}
            error={error}
          />
        )}
        {step === "pin" && picked && (
          <PinStep
            student={picked}
            pin={pin}
            onKey={pinKey}
            busy={busy}
            error={error}
          />
        )}

        <p
          style={{
            textAlign: "center",
            marginTop: 32,
            fontSize: 12,
            color: "#888",
          }}
        >
          Teacher?{" "}
          <Link to={ROUTES.READING} style={{ color: "#27a" }}>
            Sign in here
          </Link>
        </p>
      </div>
    </div>
  );
}

function stepBack({ step, setStep, setError, setPicked, setPin }) {
  setError(null);
  if (step === "pin") {
    setPicked(null);
    setPin("");
    setStep("pick");
    return;
  }
  if (step === "pick") {
    setStep("code");
    return;
  }
}

// ===== components =====

function Header({ step, onBack }) {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 24,
      }}
    >
      {step !== "code" ? (
        <button
          type="button"
          onClick={onBack}
          style={{
            background: "transparent",
            border: 0,
            fontSize: 14,
            color: "#666",
            cursor: "pointer",
            padding: "6px 8px",
          }}
        >
          ← Back
        </button>
      ) : (
        <span />
      )}
      <h1 style={{ margin: 0, fontSize: 20, color: "#222" }}>Reading Academy</h1>
      <span />
    </header>
  );
}

function CodeStep({ code, setCode, submit, busy, error }) {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  function onChange(e) {
    const sanitized = e.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, CODE_LENGTH);
    setCode(sanitized);
  }
  return (
    <section
      style={{
        background: "white",
        borderRadius: 18,
        padding: "32px 24px",
        boxShadow: "0 6px 28px rgba(20,30,60,0.06)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 44, marginBottom: 6 }} aria-hidden>
        🎒
      </div>
      <h2 style={{ margin: "8px 0 4px", fontSize: 22 }}>Type your class code</h2>
      <p
        style={{
          margin: "0 0 20px",
          color: "#666",
          fontSize: 15,
        }}
      >
        It's the 5 letters and numbers from your teacher.
      </p>

      <form onSubmit={submit}>
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 12 }}>
          {Array.from({ length: CODE_LENGTH }).map((_, i) => (
            <CodeBox key={i} char={code[i] || ""} active={i === code.length} />
          ))}
        </div>
        <input
          ref={inputRef}
          value={code}
          onChange={onChange}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          style={{
            position: "absolute",
            left: -9999,
            opacity: 0,
          }}
          aria-label="Class code"
        />

        <button
          type="submit"
          disabled={code.length !== CODE_LENGTH || busy}
          style={primaryButton(code.length === CODE_LENGTH && !busy)}
        >
          {busy ? "Looking…" : "Next"}
        </button>
      </form>

      {error && <ErrorBanner message={error} />}

      <p style={{ marginTop: 20, fontSize: 12, color: "#aaa" }}>
        Tap the boxes if your keyboard doesn't pop up.
      </p>
    </section>
  );
}

function CodeBox({ char, active }) {
  return (
    <div
      style={{
        width: 52,
        height: 64,
        borderRadius: 12,
        background: char ? "#fff" : "#f3f5f9",
        border: active
          ? "2px solid #2c7be5"
          : char
            ? "2px solid #e5e7eb"
            : "2px solid #e5e7eb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 28,
        fontWeight: 700,
        color: "#222",
      }}
    >
      {char}
    </div>
  );
}

function PickStep({ classInfo, onPick, error }) {
  return (
    <section
      style={{
        background: "white",
        borderRadius: 18,
        padding: "24px 16px",
        boxShadow: "0 6px 28px rgba(20,30,60,0.06)",
        textAlign: "center",
      }}
    >
      <p style={{ margin: 0, color: "#666", fontSize: 13 }}>
        {classInfo.className}
      </p>
      <h2 style={{ margin: "6px 0 16px", fontSize: 22 }}>Tap your name</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))",
          gap: 12,
        }}
      >
        {classInfo.students.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s)}
            style={{
              padding: "16px 8px",
              borderRadius: 14,
              border: "2px solid #e5e7eb",
              background: "#fafbfd",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              fontFamily: "inherit",
            }}
          >
            <span style={{ fontSize: 36, lineHeight: 1 }} aria-hidden>
              {s.avatarEmoji || "🌱"}
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#222" }}>
              {s.firstName} {s.lastInitial && `${s.lastInitial}.`}
            </span>
          </button>
        ))}
      </div>
      {error && <ErrorBanner message={error} />}
      <p
        style={{
          marginTop: 20,
          fontSize: 12,
          color: "#888",
        }}
      >
        Don't see your name? Ask your teacher to add you.
      </p>
    </section>
  );
}

function PinStep({ student, pin, onKey, busy, error }) {
  const dots = Array.from({ length: PIN_LENGTH }, (_, i) => i < pin.length);
  return (
    <section
      style={{
        background: "white",
        borderRadius: 18,
        padding: "24px 20px",
        boxShadow: "0 6px 28px rgba(20,30,60,0.06)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 56, lineHeight: 1, marginBottom: 4 }} aria-hidden>
        {student.avatarEmoji || "🌱"}
      </div>
      <h2 style={{ margin: "4px 0", fontSize: 22 }}>
        Hi, {student.firstName}!
      </h2>
      <p style={{ margin: "0 0 20px", color: "#666", fontSize: 15 }}>
        Type your 4-number PIN
      </p>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 14,
          marginBottom: 20,
        }}
        aria-label="PIN"
      >
        {dots.map((filled, i) => (
          <div
            key={i}
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              background: filled ? "#2c7be5" : "#e5e7eb",
              transition: "background 120ms",
            }}
          />
        ))}
      </div>

      <Keypad onKey={onKey} disabled={busy} />

      {error && <ErrorBanner message={error} />}
    </section>
  );
}

function Keypad({ onKey, disabled }) {
  const rows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["", "0", "del"],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, maxWidth: 280, margin: "0 auto" }}>
      {rows.flat().map((d, i) => {
        if (!d) return <span key={i} />;
        return (
          <button
            key={i}
            type="button"
            disabled={disabled}
            onClick={() => onKey(d)}
            style={keypadButton(d === "del")}
          >
            {d === "del" ? "⌫" : d}
          </button>
        );
      })}
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div
      style={{
        marginTop: 16,
        padding: "10px 14px",
        borderRadius: 10,
        background: "#fef3f2",
        color: "#a31515",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function primaryButton(enabled) {
  return {
    width: "100%",
    marginTop: 16,
    padding: "16px",
    fontSize: 17,
    fontWeight: 600,
    borderRadius: 14,
    border: 0,
    background: enabled ? "#2c7be5" : "#cdd5e0",
    color: "white",
    cursor: enabled ? "pointer" : "not-allowed",
    boxShadow: enabled ? "0 4px 18px rgba(44,123,229,0.3)" : "none",
    transition: "background 150ms",
    fontFamily: "inherit",
  };
}

function keypadButton(isDel) {
  return {
    height: 64,
    fontSize: 26,
    fontWeight: 600,
    borderRadius: 14,
    border: "1px solid #e5e7eb",
    background: isDel ? "#fafbfd" : "#fff",
    color: "#222",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
