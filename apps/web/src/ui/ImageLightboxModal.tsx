import { useEffect, useState, useRef, useCallback } from "react";
import { Icon } from "./Icon";

export interface ImageLightboxModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImageLightboxModal({ src, alt, onClose }: ImageLightboxModalProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 4));
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));
  const resetZoom = () => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  };
  const rotateRight = () => setRotation((r) => (r + 90) % 360);

  const downloadImage = () => {
    const a = document.createElement("a");
    a.href = src;
    a.download = alt.trim().length > 0 ? alt : "image";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setScale((s) => Math.min(s + 0.15, 4));
    } else {
      setScale((s) => Math.max(s - 0.15, 0.5));
    }
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const onMouseUp = () => {
    setIsDragging(false);
  };

  return (
    <div
      className="image-lightbox-overlay"
      role="dialog"
      aria-label="Image preview"
      onClick={onClose}
    >
      <div
        className="image-lightbox-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{ cursor: scale > 1 ? (isDragging ? "grabbing" : "grab") : "default" }}
      >
        <img
          src={src}
          alt={alt}
          className="lightbox-image"
          draggable={false}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: isDragging ? "none" : "transform 0.15s ease-out",
          }}
        />
      </div>

      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="lightbox-btn" onClick={zoomOut} title="Zoom out">
          -
        </button>
        <button type="button" className="lightbox-btn" onClick={resetZoom} title="Reset scale">
          {Math.round(scale * 100)}%
        </button>
        <button type="button" className="lightbox-btn" onClick={zoomIn} title="Zoom in">
          +
        </button>
        <button type="button" className="lightbox-btn" onClick={rotateRight} title="Rotate 90°">
          <Icon name="sync" size={14} />
        </button>
        <button
          type="button"
          className="lightbox-btn"
          onClick={downloadImage}
          title="Download image"
        >
          <Icon name="export" size={14} />
        </button>
        <button
          type="button"
          className="lightbox-btn lightbox-btn-close"
          onClick={onClose}
          title="Close (Esc)"
        >
          <Icon name="remove" size={14} />
        </button>
      </div>
    </div>
  );
}
