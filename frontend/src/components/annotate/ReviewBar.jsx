// ReviewBar.jsx — the per-image status / QA control strip in the annotator.
// Anyone may set the basic progress status (In progress / Done); the QA
// actions (Needs review / Approved / Rejected) are admin-only via isAdmin().
// Changing status calls PATCH /api/images/status.

import { useState } from "react";
import { updateImageStatus } from "../../lib/api/client";
import { isAdmin } from "../../lib/auth";

/** Simple image status — optional for team QA; not required to export. */
const PRIMARY = [
  { id: "in_progress", label: "In progress" },
  { id: "annotated", label: "Done" },
];

const QA = [
  { id: "needs_review", label: "Needs review" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

export default function ReviewBar({
  imageId,
  status,
  readOnly,
  onStatusChange,
}) {
  const [err, setErr] = useState(null);

  const setStatus = async (s) => {
    setErr(null);
    try {
      await updateImageStatus(imageId, s);
      onStatusChange(s);
    } catch (e) {
      // Review statuses (approved/rejected/needs_review) are admin-only, so a
      // plain user clicking them gets a 403. Say so instead of doing nothing.
      setErr(
        e?.status === 403
          ? "Only an admin can approve, reject or send an image for review."
          : e?.message || "Could not update the status.",
      );
    }
  };

  return (
    <section className="review-bar">
      <h4>Image status</h4>
      <p className="review-note">
        Optional — marks progress for your team. Export works anytime.
      </p>
      {readOnly && (
        <p className="review-lock">
          Approved — read-only. Set status to In progress to edit again.
        </p>
      )}
      {err && (
        <p className="panel-error" role="alert">
          {err}
          <button type="button" className="link-btn" onClick={() => setErr(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="status-chips">
        {PRIMARY.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`status-chip ${status === s.id ? "active" : ""}`}
            onClick={() => setStatus(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {isAdmin() && (
        <details className="review-qa-details">
          <summary>Review decision (admin)</summary>
          <div className="status-chips">
            {QA.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`status-chip ${status === s.id ? "active" : ""}`}
                onClick={() => setStatus(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
