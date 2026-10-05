import { useEffect, useState, useCallback } from "react";
import { Icon } from "./Icon";

export interface PrivacyShieldProps {
  autoBlur?: boolean;
  onActiveChange?: (active: boolean) => void;
}

export function PrivacyShield({ autoBlur = true, onActiveChange }: PrivacyShieldProps) {
  const [shieldActive, setShieldActive] = useState(false);

  const activate = useCallback(() => {
    setShieldActive(true);
    onActiveChange?.(true);
  }, [onActiveChange]);

  const deactivate = useCallback(() => {
    setShieldActive(false);
    onActiveChange?.(false);
  }, [onActiveChange]);

  // Tab switch auto-blur
  useEffect(() => {
    if (!autoBlur) return;
    const handleVisibility = () => {
      if (document.hidden) {
        activate();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [autoBlur, activate]);

  // Shortcut Ctrl+Alt+P or custom trigger
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (shieldActive) {
        deactivate();
        return;
      }
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        activate();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shieldActive, activate, deactivate]);

  if (!shieldActive) return null;

  return (
    <div
      className="privacy-shield-overlay"
      role="dialog"
      aria-label="Privacy Shield"
      onClick={deactivate}
    >
      <div className="privacy-shield-content">
        <Icon name="security" size={48} />
        <h2>Privacy Shield Active</h2>
        <p className="muted">Content is masked to prevent shoulder surfing.</p>
        <button type="button" className="primary" onClick={deactivate}>
          Click or press any key to resume
        </button>
      </div>
    </div>
  );
}
