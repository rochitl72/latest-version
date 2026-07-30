// Undo/redo command stack — and the single place annotations are persisted.
//
// The "command pattern": every edit is an object that knows how to do() itself
// and undo() itself. `push()` runs a command's do() and puts it on the `past`
// stack; `undo()` pops it and runs undo(); `redo()` replays it. Commands are
// async because each one round-trips to the backend REST API (createAnnotation
// / updateAnnotation / deleteAnnotation) before updating the local editor
// store, so the server stays the source of truth.
//
import { create } from "zustand";
import {
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
} from "../lib/api/client";
import { useEditor } from "./editor";

const MAX_HISTORY = 100;

export const useHistory = create((set, get) => ({
  past: [],
  future: [],

  push: async (c) => {
    try {
      await c.do();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Could not save: ${msg}`);
      throw e;
    }
    set((s) => ({
      past: [...s.past, c].slice(-MAX_HISTORY),
      future: [],
    }));
  },

  undo: async () => {
    const { past } = get();
    if (past.length === 0) return;
    const cmd = past[past.length - 1];
    await cmd.undo();
    set((s) => ({
      past: s.past.slice(0, -1),
      future: [cmd, ...s.future].slice(0, MAX_HISTORY),
    }));
  },

  redo: async () => {
    const { future } = get();
    if (future.length === 0) return;
    const cmd = future[0];
    await cmd.do();
    set((s) => ({
      past: [...s.past, cmd].slice(-MAX_HISTORY),
      future: s.future.slice(1),
    }));
  },

  clear: () => set({ past: [], future: [] }),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}));

// ─── Command factories ────────────────────────────────────────────
// These wrap common edit patterns so callers can stay simple.

export function makeCreateCmd(payload) {
  let createdId = null;
  return {
    label: `Create ${payload.type}`,
    do: async () => {
      const ann = await createAnnotation(payload);
      createdId = ann.id;
      const ed = useEditor.getState();
      ed.addAnnotation(ann);
      // The server flips an image from "unannotated" to "in_progress" on its
      // first shape. It reports the resulting status here, so the workspace
      // reflects it straight away instead of showing a stale badge until the
      // page is reloaded. We apply whatever the server says rather than
      // re-deriving the rule client-side.
      if (ann.image_status && ann.image_status !== ed.imageStatus) {
        ed.setImageStatus(ann.image_status);
      }
    },
    undo: async () => {
      if (createdId == null) return;
      await deleteAnnotation(createdId);
      useEditor.getState().removeAnnotation(createdId);
    },
  };
}

export function makeUpdateGeometryCmd(ann, newGeometry) {
  const oldGeometry = JSON.parse(JSON.stringify(ann.geometry));
  return {
    label: `Edit ${ann.type}`,
    do: async () => {
      await updateAnnotation(ann.id, { geometry: newGeometry });
      useEditor
        .getState()
        .updateAnnotationLocal(ann.id, { geometry: newGeometry });
    },
    undo: async () => {
      await updateAnnotation(ann.id, { geometry: oldGeometry });
      useEditor
        .getState()
        .updateAnnotationLocal(ann.id, { geometry: oldGeometry });
    },
  };
}

export function makeDeleteCmd(ann) {
  const snapshot = { ...ann };
  let restoredId = null;
  return {
    label: `Delete ${ann.type}`,
    do: async () => {
      await deleteAnnotation(ann.id);
      useEditor.getState().removeAnnotation(ann.id);
    },
    undo: async () => {
      const restored = await createAnnotation({
        image_id: snapshot.image_id,
        label_id: snapshot.label_id,
        type: snapshot.type,
        geometry: snapshot.geometry,
        source: snapshot.source,
        confidence: snapshot.confidence,
      });
      restoredId = restored.id;
      useEditor.getState().addAnnotation(restored);
    },
  };
}
