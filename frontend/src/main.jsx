// main.jsx — application entry point.
// Mounts React, defines all client-side routes (project list, annotate view,
// admin pages, personal progress) and guards admin-only routes with <AdminRoute>.

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import ProjectList from "./components/projects/ProjectList";
import AnnotateView from "./components/annotate/AnnotateView";
import AdminDashboard from "./components/admin/AdminDashboard";
import UserManagement from "./components/admin/UserManagement";
import ActivityFeed from "./components/admin/ActivityFeed";
import MyProgress from "./components/home/MyProgress";
import { isAdmin } from "./lib/auth";
import "./styles.css";

/** Gate admin-only routes. Non-admins are bounced to the project list.
 *  (The backend enforces this too — this is just so the UI never shows a
 *  page the user can't use.) */
function AdminRoute({ children }) {
  return isAdmin() ? children : <Navigate to="/" replace />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<ProjectList />} />
          <Route path="me" element={<MyProgress />} />
          <Route
            path="projects/:projectId/annotate/:imageId"
            element={<AnnotateView />}
          />
          <Route path="admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
          <Route path="admin/users" element={<AdminRoute><UserManagement /></AdminRoute>} />
          <Route path="admin/activity" element={<AdminRoute><ActivityFeed /></AdminRoute>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
