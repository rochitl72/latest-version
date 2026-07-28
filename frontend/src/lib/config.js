// config.js — resolves where the backend API lives.
//
// Two deployment shapes are supported:
//
//   1. Same-origin (default): the frontend is served by something (nginx,
//      Vite dev proxy, ...) that reverse-proxies /api to the backend on the
//      SAME host:port the browser loaded the page from. In this mode leave
//      VITE_API_BASE_URL unset — every URL below stays relative ("/api/...")
//      and just works.
//
//   2. Separate origin: the frontend is a static build served on its own
//      (e.g. a plain nginx/S3/CDN with no reverse proxy) and must call a
//      backend running on a different host or port. Set VITE_API_BASE_URL
//      to that backend's base URL — e.g. "http://192.168.1.50:8000" or
//      "https://api.example.com" — at BUILD time (see frontend/.env.example).
//      Vite bakes VITE_-prefixed vars into the compiled bundle, so this must
//      be set before `npm run build` / `docker build`, not at container
//      start.
//
// Input:   the VITE_API_BASE_URL build-time environment variable (or none).
// Process: normalises it (strips a trailing slash).
// Output:  API_ORIGIN and API_BASE (every REST call prefixes API_BASE).
const RAW = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

/** "" for same-origin, or the absolute backend origin, e.g. "http://host:8000". */
export const API_ORIGIN = RAW;

/** REST base every client.js call is prefixed with. Always ends in /api. */
export const API_BASE = `${RAW}/api`;
