// App.jsx — root shell of the SPA.
// Handles the auth gate (login screen vs. app), the top navigation bar, the
// forced-password-change modal, and renders the active route via <Outlet/>.

import { useEffect, useState } from "react";
import { Outlet, Link } from "react-router-dom";
import { Home, LayoutDashboard, Users, Activity, KeyRound, LogOut } from "lucide-react";
import ApiStatusBanner from "./components/common/ApiStatusBanner";
import LoginPage from "./components/auth/LoginPage";
import ChangePasswordModal from "./components/auth/ChangePasswordModal";
import {
  isAuthenticated,
  logout,
  verifyToken,
  getCurrentUser,
  isAdmin,
} from "./lib/auth";

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated);
  // Until the stored token is checked we render nothing, so a stale token
  // never flashes the app open before the server rejects it.
  const [checking, setChecking] = useState(isAuthenticated);
  const [user, setUser] = useState(getCurrentUser);
  const [showPwChange, setShowPwChange] = useState(false);

  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    (async () => {
      const valid = await verifyToken();
      if (cancelled) return;
      setAuthed(valid);
      setUser(getCurrentUser());
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Force the seeded admin off the default password before anything else.
  useEffect(() => {
    if (authed && getCurrentUser()?.must_change_password) {
      setShowPwChange(true);
    }
  }, [authed]);

  const handleSignOut = async () => {
    await logout();
    setAuthed(false);
    setUser(null);
  };

  const onLoginSuccess = () => {
    setAuthed(true);
    setUser(getCurrentUser());
  };

  if (checking) return null;

  if (!authed) {
    return <LoginPage onSuccess={onLoginSuccess} />;
  }

  const forced = !!getCurrentUser()?.must_change_password;

  return (
    <div className="app-shell">
      <ApiStatusBanner />
      <header className="app-header">
        <Link to="/" className="app-logo">
          <img src="/logo.png" alt="RBG" className="logo-img" />
          <span className="logo-text">
            <strong>RBG Annotation Studio</strong>
            <small>Rehabilitation Bioengineering Group · IIT Madras</small>
          </span>
        </Link>
        <nav className="app-nav">
          <Link to="/" className="btn-text"><Home className="nav-ico" size={15} /> Home</Link>
          {isAdmin() ? (
            <>
              <Link to="/admin" className="btn-text"><LayoutDashboard className="nav-ico" size={15} /> Dashboard</Link>
              <Link to="/admin/users" className="btn-text"><Users className="nav-ico" size={15} /> Users</Link>
              <Link to="/admin/activity" className="btn-text"><Activity className="nav-ico" size={15} /> Activity</Link>
            </>
          ) : (
            <Link to="/me" className="btn-text"><Activity className="nav-ico" size={15} /> My progress</Link>
          )}
          {user && (
            <span className="app-user">
              {user.username}
              <span className={`role-chip role-${user.role}`}>{user.role}</span>
            </span>
          )}
          <button className="btn-text" onClick={() => setShowPwChange(true)}>
            <KeyRound className="nav-ico" size={15} /> Password
          </button>
          <button className="btn-text app-signout" onClick={handleSignOut}>
            <LogOut className="nav-ico" size={15} /> Sign out
          </button>
        </nav>
      </header>

      {showPwChange && (
        <ChangePasswordModal
          forced={forced}
          onClose={() => setShowPwChange(false)}
          onDone={() => {
            // Clear the forced flag locally so the modal doesn't reappear.
            const u = getCurrentUser();
            if (u) u.must_change_password = false;
            setShowPwChange(false);
            setUser({ ...getCurrentUser() });
          }}
        />
      )}

      <Outlet />
    </div>
  );
}
