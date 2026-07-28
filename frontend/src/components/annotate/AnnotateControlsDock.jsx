// AnnotateControlsDock.jsx — collapsible bottom toolbar in the annotate view.
// Surfaces the common actions (save draft, undo/redo, delete, mark done) plus
// the contextual ToolHintBar for the active drawing tool.

import { useState } from "react";
import {
  ChevronUp,
  ChevronDown,
  Check,
  Undo2,
  Redo2,
  Trash2,
  Save,
  Info,
} from "lucide-react";
import ToolHintBar from "./ToolHintBar";

export default function AnnotateControlsDock({
  tool,
  hasLabel,
  canUndo,
  canRedo,
  hasSelection,
  readOnly,
  draftLabel,
  onSaveDraft,
  onUndo,
  onRedo,
  onDelete,
  onMarkImageDone,
  imageDone,
}) {
  const [expanded, setExpanded] = useState(false);
  const [showHints, setShowHints] = useState(false);

  return (
    <div
      className={`annotate-controls-dock ${expanded ? "expanded" : "minimized"}`}
    >
      <div className="dock-toolbar">
        {draftLabel && !readOnly && (
          <button
            type="button"
            className="dock-icon-btn dock-save"
            onClick={onSaveDraft}
            title={draftLabel}
          >
            <Save size={15} />
          </button>
        )}
        <button
          type="button"
          className="dock-icon-btn"
          onClick={onUndo}
          disabled={!canUndo || readOnly}
          title="Undo (⌘Z)"
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          className="dock-icon-btn"
          onClick={onRedo}
          disabled={!canRedo || readOnly}
          title="Redo (⌘⇧Z)"
        >
          <Redo2 size={15} />
        </button>
        <button
          type="button"
          className="dock-icon-btn"
          onClick={onDelete}
          disabled={!hasSelection || readOnly}
          title="Delete (Del)"
        >
          <Trash2 size={15} />
        </button>
        <button
          type="button"
          className={`dock-icon-btn dock-done ${imageDone ? "is-done" : ""}`}
          onClick={onMarkImageDone}
          disabled={readOnly}
          title="Mark image done"
        >
          <Check size={15} />
        </button>
        <button
          type="button"
          className={`dock-icon-btn ${showHints ? "active" : ""}`}
          onClick={() => setShowHints((v) => !v)}
          title="Tool help"
        >
          <Info size={15} />
        </button>
        <button
          type="button"
          className="dock-expand-btn"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Minimize" : "Expand controls"}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {(expanded || showHints) && (
        <div className="dock-panel">
          {showHints && (
            <ToolHintBar tool={tool} hasLabel={hasLabel} embedded />
          )}
          {expanded && (
            <div className="dock-labels">
              {draftLabel && !readOnly && (
                <button
                  type="button"
                  className="dock-text-btn primary"
                  onClick={onSaveDraft}
                >
                  {draftLabel}
                </button>
              )}
              <button
                type="button"
                className="dock-text-btn"
                onClick={onMarkImageDone}
                disabled={readOnly}
              >
                {imageDone ? "Image saved" : "Mark image done"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
