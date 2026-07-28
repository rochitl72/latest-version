// ChangePasswordModal.jsx — dialog for changing your own password.
// Two modes: `forced` (must replace a default/first-login password and cannot
// be dismissed) and normal (opened voluntarily from the header). Submits to
// POST /api/auth/change-password; the server enforces the minimum length.

import { useState } from "react";
import { changePassword } from "../../lib/api/client";

/**
 * Password-change dialog. When `forced` is true (the seeded admin still on the
 * default password) it cannot be dismissed until the change succeeds.
 */
export default function ChangePasswordModal({ forced = false, onClose, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    // The real minimum is enforced server-side (configurable via
    // MIN_PASSWORD_LENGTH) — we only guard against an empty field here and let
    // the API's error message report the actual required length if it's short.
    if (next.length === 0) {
      setError("Enter a new password.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      onDone?.();
    } catch (err) {
      setError(err.message || "Could not change password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card" role="dialog" aria-modal="true">
        <h2 className="modal-title">Change password</h2>
        {forced && (
          <p className="modal-note">
            This account is still using the default password. Set a new one to
            continue.
          </p>
        )}
        <form onSubmit={submit} className="form-stack">
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            {!forced && (
              <button type="button" className="btn-text" onClick={onClose}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
