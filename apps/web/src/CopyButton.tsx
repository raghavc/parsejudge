import { type CSSProperties, useEffect, useState } from "react";
import { Icon } from "./ax/Icon.tsx";

export const CopyButton = ({
  text,
  label,
  icon,
  className = "btn",
  style,
}: {
  readonly text: string;
  readonly label: string;
  readonly icon?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}) => {
  const [copiedAt, setCopiedAt] = useState(0);
  useEffect(() => {
    if (copiedAt === 0) return;
    const timer = setTimeout(() => setCopiedAt(0), 2000);
    return () => clearTimeout(timer);
  }, [copiedAt]);
  const copied = copiedAt !== 0;
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopiedAt(Date.now()))}
    >
      <span className="swap">
        <span data-hidden={copied} aria-hidden={copied}>
          {icon && <Icon name={icon} />}
          {label}
        </span>
        <span data-hidden={!copied} aria-hidden={!copied}>
          <svg width="12" height="10" viewBox="0 0 10 8" aria-hidden="true">
            <path d="M1 4l2.5 2.5L9 1" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Copied
        </span>
      </span>
    </button>
  );
};
