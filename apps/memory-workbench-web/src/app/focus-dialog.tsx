import { useEffect, useRef, type ReactNode } from "react";

type FocusDialogProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FocusDialog({
  open,
  title,
  children,
  onClose,
  returnFocusTo,
}: FocusDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialog === null) {
        return;
      }
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const firstElement = focusable[0];
      const lastElement = focusable.at(-1);
      if (firstElement === undefined || lastElement === undefined) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      returnFocusTo?.focus();
    };
  }, [onClose, open, returnFocusTo]);

  if (!open) {
    return null;
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="workbench-dialog-title"
        aria-modal="true"
        className="dialog-card"
        ref={dialogRef}
        role="dialog"
      >
        <p className="eyebrow">当前页面说明</p>
        <h2 id="workbench-dialog-title">{title}</h2>
        <div className="dialog-copy">{children}</div>
        <div className="dialog-actions">
          <a href="#main-content">跳到主要内容</a>
          <button className="button-primary" onClick={onClose} type="button">
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}
