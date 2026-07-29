// LoginPage.jsx — username/password sign-in form.
// Calls lib/auth.login(); on success the parent App swaps in the app shell.

import { useState } from "react";
import { login } from "../../lib/auth";

export default function LoginPage({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError("");
    // Credentials go to the server; nothing is checked in the browser.
    const result = await login(username.trim(), password);
    setBusy(false);

    if (result.ok) {
      onSuccess();
    } else {
      setError(result.error);
      setPassword("");
    }
  }

  const clearError = () => setError("");

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <img src="/logo.png" alt="RBG" className="logo-img" />
          <div>
            <h1>RBG Annotation Studio</h1>
            <p>Sign in to continue</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clearError();
              }}
              autoComplete="username"
              disabled={busy}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              autoComplete="current-password"
              disabled={busy}
              /* No `required` on purpose. This app has no password rules at
                 all, so an account may legitimately have an EMPTY password —
                 and the browser's required check would make such an account
                 impossible to sign in to. The server decides, not the form. */
            />
          </label>
          {error && (
            <div className="login-denied" role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="btn-primary login-submit"
            disabled={busy}
          >
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
