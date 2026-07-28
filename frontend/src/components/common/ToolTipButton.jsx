// ToolTipButton.jsx — reusable icon button with a hover tooltip + shortcut hint.

import { useState } from "react";

export default function ToolTipButton({
  label,
  shortcut,
  hint,
  children,
  className = "",
  disabled,
  onClick,
  active,
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className={`tool-tip-wrap ${active ? "active" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </button>
      {hover && !disabled && (
        <div className="tool-popover" role="tooltip">
          <div className="tool-popover-title">
            <span>{label}</span>
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>
          {hint && <p className="tool-popover-hint">{hint}</p>}
        </div>
      )}
    </div>
  );
}
