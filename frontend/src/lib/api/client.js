// client.js — the single typed wrapper around every backend REST call.
// Centralises the API base URL, attaches the bearer token, and logs the user
// out automatically on a 401. Every component talks to the server through here.
//
// BASE comes from lib/config.js: "/api" (same-origin, the default) unless
// VITE_API_BASE_URL was set at build time to point at a separately-hosted
// backend — see config.js for the full explanation.

import { getToken, logout } from "../auth";
import { API_BASE, API_ORIGIN } from "../config";

const BASE = API_BASE;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

/** Authorization header for the current session, if we have a token. */
function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** An expired or rejected token means the session is over — bounce to login. */
function handleUnauthorized() {
  logout();
  window.location.reload();
}

async function req(path, init) {
  let r;
  try {
    r = await fetch(`${BASE}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init?.headers || {}),
      },
      ...init,
    });
  } catch {
    throw new ApiError(
      "Cannot reach the annotation server. Check your network connection, " +
        "then retry. If it persists, contact your administrator.",
    );
  }
  if (r.status === 401) {
    handleUnauthorized();
    throw new ApiError("Session expired. Please sign in again.", 401);
  }
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const body = await r.json();
      if (body.detail)
        detail =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(`${r.status} ${detail}`, r.status);
  }
  return r.json();
}

/** Is the backend reachable?
 *
 *  Hits `/health`, which is deliberately unauthenticated: it answers "is the
 *  server up", not "am I logged in". Probing an authenticated endpoint instead
 *  would report a 401/403 as an outage and show the user a misleading
 *  "server offline" banner. Note `/health` sits at the ORIGIN root, not under
 *  /api, so it is derived from API_ORIGIN rather than BASE.
 */
export const checkApiHealth = async () => {
  try {
    const r = await fetch(`${API_ORIGIN}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
};

export const listProjects = () => req("/projects");
export const createProject = (data) =>
  req("/projects", { method: "POST", body: JSON.stringify(data) });
export const deleteProject = (id) =>
  req(`/projects/${id}`, { method: "DELETE" });

export const listLabels = (projectId) => req(`/projects/${projectId}/labels`);
export const createLabel = (projectId, data) =>
  req(`/projects/${projectId}/labels`, {
    method: "POST",
    body: JSON.stringify(data),
  });
export const deleteLabel = (projectId, labelId) =>
  req(`/projects/${projectId}/labels/${labelId}`, {
    method: "DELETE",
  });

export const listImages = (projectId) => req(`/projects/${projectId}/images`);

export const uploadImages = async (projectId, files) => {
  const form = new FormData();
  Array.from(files).forEach((f) => form.append("files", f));
  // Note: no Content-Type here on purpose - the browser sets the multipart
  // boundary itself.
  const r = await fetch(`${BASE}/projects/${projectId}/images/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (r.status === 401) {
    handleUnauthorized();
    throw new ApiError("Session expired. Please sign in again.", 401);
  }
  if (!r.ok) {
    let detail = `Upload failed: ${r.status}`;
    try {
      const body = await r.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* keep the status-code message */
    }
    throw new ApiError(detail, r.status);
  }
  return r.json();
};

export const imageFileUrl = (projectId, imageId) =>
  `${BASE}/projects/${projectId}/images/${imageId}/file`;

export const listAnnotations = (imageId) =>
  req(`/images/${imageId}/annotations`);
export const createAnnotation = (data) =>
  req("/annotations", { method: "POST", body: JSON.stringify(data) });
export const updateAnnotation = (id, data) =>
  req(`/annotations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
export const deleteAnnotation = (id) =>
  req(`/annotations/${id}`, { method: "DELETE" });

export const exportYoloUrl = (projectId) =>
  `${BASE}/projects/${projectId}/export/yolo`;

export const exportCocoUrl = (projectId) =>
  `${BASE}/projects/${projectId}/export/coco`;

// Single zip: original images + overlay (drawn-on) copies + YOLO .txt labels +
// one COCO json + classes.txt + manifest. Open to any project member, not
// just admin — this is the "download my labeled images and labels" button.
export const exportLabeledZipUrl = (projectId, onlyAnnotated = true) =>
  `${BASE}/projects/${projectId}/export/labeled-zip?only_annotated=${onlyAnnotated}`;

export const exportToDownloads = (projectId, onlyAnnotated = true) =>
  req(
    `/projects/${projectId}/export/downloads?only_annotated=${onlyAnnotated}`,
    { method: "POST" },
  );

// Versions
export const listVersions = (projectId) =>
  req(`/projects/${projectId}/versions`);
export const createVersion = (projectId, name, freeze = false) =>
  req(`/projects/${projectId}/versions`, {
    method: "POST",
    body: JSON.stringify({ name, freeze }),
  });
export const activateVersion = (projectId, versionId) =>
  req(`/projects/${projectId}/versions/${versionId}/activate`, {
    method: "POST",
  });

// Workflow
export const updateImageStatus = (imageId, status) =>
  req("/images/status", {
    method: "PATCH",
    body: JSON.stringify({ image_id: imageId, status }),
  });
export const bulkUpdateStatus = (imageIds, status) =>
  req("/images/bulk-status", {
    method: "POST",
    body: JSON.stringify({ image_ids: imageIds, status }),
  });
export const workflowStats = (projectId) =>
  req(`/projects/${projectId}/workflow-stats`);

// Splits
export const setImageSplit = (imageId, split) =>
  req("/images/split", {
    method: "PATCH",
    body: JSON.stringify({ image_id: imageId, split }),
  });
export const autoSplit = (
  projectId,
  train = 0.7,
  val = 0.2,
  test = 0.1,
  onlyAnnotated = false,
) =>
  req("/projects/auto-split", {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      train_pct: train,
      val_pct: val,
      test_pct: test,
      only_annotated: onlyAnnotated,
    }),
  });

// ─── Users (admin) ───────────────────────────────────────────────────
export const listUsers = () => req("/users");
export const createUser = (data) =>
  req("/users", { method: "POST", body: JSON.stringify(data) });
export const updateUser = (id, data) =>
  req(`/users/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deactivateUser = (id) =>
  req(`/users/${id}`, { method: "DELETE" });
export const myStats = () => req("/users/me/stats");

// ─── Account ─────────────────────────────────────────────────────────
export const changePassword = (currentPassword, newPassword) =>
  req("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });

// ─── Project assignment (admin) ──────────────────────────────────────
// One user per project. GET reads the current assignee; PUT sets or changes it
// (pass user_id: null to clear). Reassigning moves the project's files to the
// new owner on the server side.
export const getAssignee = (projectId) =>
  req(`/projects/${projectId}/assignee`);
export const setAssignee = (projectId, userId) =>
  req(`/projects/${projectId}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ user_id: userId }),
  });

// ─── Dashboard (admin) ───────────────────────────────────────────────
const qp = (projectId) => (projectId ? `?project_id=${projectId}` : "");
export const dashOverview = (projectId) =>
  req(`/dashboard/overview${qp(projectId)}`);
export const dashVelocity = (projectId) =>
  req(`/dashboard/velocity${qp(projectId)}`);
export const dashContributors = (projectId) =>
  req(`/dashboard/contributors${qp(projectId)}`);
export const dashQuality = (projectId) =>
  req(`/dashboard/quality${qp(projectId)}`);
export const dashReviewQueue = (projectId) =>
  req(`/dashboard/review-queue${qp(projectId)}`);
export const dashWorkload = (projectId) =>
  req(`/dashboard/workload${qp(projectId)}`);

// ─── Activity / audit log ────────────────────────────────────────────
export const listActivity = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return req(`/activity${q ? `?${q}` : ""}`);
};
export const userActivity = (userId) => req(`/activity/users/${userId}`);

// ─── System & Storage (admin) ────────────────────────────────────────
// Read-only inspector: database facts, per-user disk usage, and a DB-vs-disk
// consistency check. See backend app/api/admin/system.py.
export const systemOverview = () => req("/system/overview");
export const systemStorage = () => req("/system/storage");
export const systemIntegrity = () => req("/system/integrity");
export const systemUser = (id) => req(`/system/user/${id}`);

// CSV downloads. Opened as <a href> so the browser saves the file, which means
// they authenticate with the login cookie rather than a bearer header.
export const csvUrl = (name) => `${BASE}/system/export/${name}.csv`;
