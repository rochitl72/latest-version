// ApiStatusBanner.jsx — thin banner shown when the backend is unreachable.
// Polls /health and offers a manual retry so users know it is a server outage.

import { useCallback, useEffect, useState } from "react";
import { checkApiHealth } from "../../lib/api/client";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function ApiStatusBanner() {
  const [online, setOnline] = useState(null);
  const [checking, setChecking] = useState(false);

  const probe = useCallback(async () => {
    setChecking(true);
    setOnline(await checkApiHealth());
    setChecking(false);
  }, []);

  useEffect(() => {
    probe();
    const id = window.setInterval(probe, 8000);
    return () => clearInterval(id);
  }, [probe]);

  if (online !== false) return null;

  return (
    <div className="api-status-banner" role="alert">
      <AlertCircle size={18} />
      <div className="api-status-text">
        <strong>Cannot reach the server</strong>
        <span>
          Your work is saved on the server, so nothing is lost — but it is not
          responding right now. This is usually brief. Retry in a moment, and
          tell your administrator if it keeps happening.
        </span>
      </div>
      <button
        type="button"
        className="btn-secondary"
        onClick={probe}
        disabled={checking}
      >
        <RefreshCw size={14} className={checking ? "spin" : ""} />
        {checking ? "Checking…" : "Retry"}
      </button>
    </div>
  );
}
