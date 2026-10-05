import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Icon } from "./Icon";

// Configure pdfjs worker to use the bundled same-origin worker script
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PdfPresentationModalProps {
  filename: string;
  bytes: Uint8Array | null;
  loading?: boolean;
  onClose: () => void;
}

export function PdfPresentationModal({
  filename,
  bytes,
  loading = false,
  onClose,
}: PdfPresentationModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);

  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  // Load the PDF Document when bytes are provided
  useEffect(() => {
    if (!bytes) return;

    let active = true;

    const loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(), // provide a copy of the buffer
    });

    loadingTask.promise
      .then((doc) => {
        if (!active) {
          doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setError(null);
        setCurrentPage(1);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setPdfDoc(null);
        setNumPages(0);
        setError(err instanceof Error ? err.message : "Failed to load PDF document.");
      });

    return () => {
      active = false;
      loadingTask.destroy();
    };
  }, [bytes]);

  // Render current page onto canvas
  const renderCurrentPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current || currentPage < 1) return;

    try {
      const page = await pdfDoc.getPage(currentPage);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;

      const unscaledViewport = page.getViewport({ scale: 1 });
      const padding = 32;
      const availableW = window.innerWidth - padding * 2;
      const availableH = window.innerHeight - padding * 2;

      const scaleX = availableW / unscaledViewport.width;
      const scaleY = availableH / unscaledViewport.height;
      const fitScale = Math.min(scaleX, scaleY);
      const dpr = window.devicePixelRatio || 1;

      const viewport = page.getViewport({ scale: fitScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Cancel previous render task if active
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // cancelled task
        }
        renderTaskRef.current = null;
      }

      const renderTask = page.render({
        canvasContext: context,
        viewport,
      });
      renderTaskRef.current = renderTask;

      await renderTask.promise;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "RenderingCancelledException") {
        return;
      }
      console.error("[pdf] render page error:", err);
    }
  }, [pdfDoc, currentPage]);

  useEffect(() => {
    void renderCurrentPage();
  }, [renderCurrentPage]);

  // Handle window resize to re-render page with optimal fit
  useEffect(() => {
    const handleResize = () => {
      void renderCurrentPage();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [renderCurrentPage]);

  // Page navigation
  const prevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  const nextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(p + 1, numPages));
  }, [numPages]);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen();
          setIsFullscreen(true);
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
          setIsFullscreen(false);
        }
      }
    } catch {
      // Fullscreen not allowed or failed
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Auto-hide controls
  const handleMouseMove = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
    }
    hideControlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (hideControlsTimerRef.current !== null) {
        window.clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
        case "Enter":
          event.preventDefault();
          nextPage();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
          event.preventDefault();
          prevPage();
          break;
        case "Home":
          event.preventDefault();
          setCurrentPage(1);
          break;
        case "End":
          event.preventDefault();
          if (numPages > 0) setCurrentPage(numPages);
          break;
        case "f":
        case "F":
        case "F5":
          event.preventDefault();
          void toggleFullscreen();
          break;
        case "Escape":
          event.preventDefault();
          if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else {
            onClose();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nextPage, prevPage, numPages, toggleFullscreen, onClose]);

  // Click on slide to advance or go back
  const handleSlideClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < rect.width * 0.25) {
      prevPage();
    } else {
      nextPage();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`pdf-presentation-overlay ${controlsVisible ? "controls-visible" : "controls-hidden"}`}
      role="dialog"
      aria-label={`PDF Presentation: ${filename}`}
      onMouseMove={handleMouseMove}
    >
      <div className="pdf-slide-container" onClick={handleSlideClick}>
        {loading && <div className="pdf-status">Decrypting and loading PDF…</div>}
        {error && <div className="pdf-status error">{error}</div>}
        <canvas ref={canvasRef} className="pdf-canvas" />
      </div>

      <div
        className="pdf-presentation-toolbar"
        onClick={(e) => e.stopPropagation()}
        aria-label="Presentation controls"
      >
        <span className="pdf-filename" title={filename}>
          {filename}
        </span>

        <div className="pdf-nav-group">
          <button
            type="button"
            className="pdf-btn"
            disabled={currentPage <= 1}
            onClick={prevPage}
            title="Previous slide (← / PageUp)"
            aria-label="Previous page"
          >
            <Icon name="prev" />
          </button>
          <span className="pdf-page-indicator">
            {currentPage} / {numPages || 1}
          </span>
          <button
            type="button"
            className="pdf-btn"
            disabled={currentPage >= numPages}
            onClick={nextPage}
            title="Next slide (→ / Space / PageDown)"
            aria-label="Next page"
          >
            <Icon name="next" />
          </button>
        </div>

        <div className="pdf-action-group">
          <button
            type="button"
            className="pdf-btn"
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? "Exit Fullscreen (F)" : "Enter Fullscreen (F)"}
            aria-label="Toggle Fullscreen"
          >
            <Icon name={isFullscreen ? "minimize" : "maximize"} />
          </button>
          <button
            type="button"
            className="pdf-btn pdf-btn-close"
            onClick={onClose}
            title="Exit Presentation (Esc)"
            aria-label="Close presentation"
          >
            <Icon name="remove" />
          </button>
        </div>
      </div>
    </div>
  );
}
