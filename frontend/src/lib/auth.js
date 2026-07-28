// Authentication against the backend.
//
// Credentials are verified server-side; this module only holds the JWT the
// server issues. Nothing secret lives in this file.
//
// API_BASE comes from lib/config.js — "/api" for the default same-origin
// deployment, or an absolute backend URL if VITE_API_BASE_URL was set at
// build time. When it's absolute (a different origin than the page), we also
// pass `credentials: "include"` so the httpOnly auth cookie (used by <img>
// tags to load protected files) still round-trips cross-origin.

import { API_BASE } from "./config";

const TOKEN_KEY = "rbg-studio-token";

// The current signed-in user (id, username, role, must_change_password …).
// Held in memory and refreshed from /api/auth/me; the whole role-based UI
// branches on this.
let currentUser = null;

export function getCurrentUser() {
  return currentUser;
}

export function isAdmin() {
  return currentUser?.role === "admin";
}

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function isAuthenticated() {
  return !!getToken();
}

export function setToken(token) {
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

/** Fetch the signed-in user from the server and cache it. Returns the user or null. */
export async function fetchCurrentUser() {
  if (!getToken()) {
    currentUser = null;
    return null;
  }
  try {
    const r = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      credentials: "include",
    });
    if (!r.ok) {
      currentUser = null;
      return null;
    }
    currentUser = await r.json();
    return currentUser;
  } catch {
    return currentUser;
  }
}

/** Drop the local token and ask the server to clear the image cookie. */
export async function logout() {
  const token = getToken();
  setToken(null);
  currentUser = null;
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
  } catch {
    // Already signed out locally; a failed call here doesn't matter.
  }
}

/**
 * Exchange username + password for a token.
 * Returns { ok: true } or { ok: false, error: "..." }.
 */
export async function login(username, password) {
  let r;
  try {
    r = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "Cannot reach the server. Is the backend running?" };
  }

  if (r.status === 401) {
    return { ok: false, error: "Incorrect username or password." };
  }
  if (!r.ok) {
    // Surface the server's specific message when it has one — e.g. the 403
    // "Your account is deactivated. Contact your administrator."
    let detail = `Login failed (${r.status}).`;
    try {
      const body = await r.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* keep the status-code fallback */
    }
    return { ok: false, error: detail };
  }

  const data = await r.json();
  setToken(data.access_token);
  currentUser = data.user || null;
  return { ok: true };
}

/** Check a stored token is still valid — it may have expired between visits.
 *  Also caches the current user so the UI knows the role immediately. */
export async function verifyToken() {
  if (!getToken()) return false;
  try {
    const r = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      credentials: "include",
    });
    if (!r.ok) {
      setToken(null);
      currentUser = null;
      return false;
    }
    currentUser = await r.json();
    return true;
  } catch {
    // Network error rather than a rejection — keep the token and let the
    // user retry instead of bouncing them to the login screen.
    return true;
  }
}
