import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ax/Icon.tsx";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [8, 6, 4, 3, 2, 1.5];

const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** − / percent menu / + controls, the same steps and presets as Studio's document viewer. */
export const ZoomControls = ({ zoom, onZoom }: { readonly zoom: number; readonly onZoom: (zoom: number) => void }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [open]);
  const pick = (next: number) => {
    onZoom(next);
    setOpen(false);
  };
  return (
    <div ref={ref} className="zoom-ctl">
      <div className="seg">
        <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => onZoom(zoom - ZOOM_STEP)}>
          <Icon name="minus" />
        </button>
        <button type="button" className="zoom-pct" aria-label="Zoom presets" aria-expanded={open} onClick={() => setOpen(!open)}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => onZoom(zoom + ZOOM_STEP)}>
          <Icon name="plus" />
        </button>
      </div>
      {open && (
        <div className="popover menu zoom-menu">
          {ZOOM_PRESETS.map((preset) => (
            <button key={preset} type="button" className="menu-row" onClick={() => pick(preset)}>
              {Math.round(preset * 100)}%{Math.abs(zoom - preset) < 0.001 && " ✓"}
            </button>
          ))}
          <button type="button" className="menu-row" onClick={() => pick(1)}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
};

/** Zoom state for one viewport; `anchor` is the viewport point that stays fixed while zooming (default: its center). */
export const useZoom = () => {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const pending = useRef<{ x: number; y: number; ratio: number; at: { x: number; y: number } } | null>(null);

  const setZoom = useCallback((target: number, anchor?: { x: number; y: number }) => {
    const el = viewport.current;
    const next = clamp(Math.round(target * 100) / 100);
    if (next === zoomRef.current) return;
    if (el !== null) {
      const at = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      pending.current = { x: el.scrollLeft + at.x, y: el.scrollTop + at.y, ratio: next / zoomRef.current, at };
    }
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  useLayoutEffect(() => {
    const el = viewport.current;
    const p = pending.current;
    if (el === null || p === null || zoom <= 0) return;
    pending.current = null;
    el.scrollLeft = p.x * p.ratio - p.at.x;
    el.scrollTop = p.y * p.ratio - p.at.y;
  }, [zoom]);

  return useMemo(() => ({ viewport, zoom, zoomRef, setZoom }), [zoom, setZoom]);
};

/** An image in a scrollable viewport: zoom from the controls or by pinching, drag to pan. */
export const ZoomImage = ({
  src,
  alt,
  state: { viewport, zoom, zoomRef, setZoom },
}: {
  readonly src: string;
  readonly alt: string;
  readonly state: ReturnType<typeof useZoom>;
}) => {
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pannable = zoom > 1;

  // Ctrl/⌘ + wheel and trackpad pinch (which browsers report as ctrl + wheel) zoom around the cursor.
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setZoom(zoomRef.current * Math.exp(-e.deltaY * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [viewport, zoomRef, setZoom]);

  useEffect(() => {
    const el = viewport.current;
    if (el === null || src === "") return;
    el.scrollTo({ left: 0, top: 0 });
  }, [src, viewport]);

  return (
    <div
      ref={viewport}
      className={`zoom-view${pannable ? " pannable" : ""}${dragging ? " dragging" : ""}`}
      onPointerDown={(e) => {
        const el = viewport.current;
        if (!pannable || el === null || e.pointerType !== "mouse" || e.button !== 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const el = viewport.current;
        const d = drag.current;
        if (el === null || d === null) return;
        el.scrollLeft = d.left - (e.clientX - d.x);
        el.scrollTop = d.top - (e.clientY - d.y);
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      <img src={src} alt={alt} draggable={false} style={{ width: `${zoom * 100}%` }} />
    </div>
  );
};
