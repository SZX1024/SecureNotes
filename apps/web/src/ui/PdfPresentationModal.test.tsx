import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfPresentationModal } from "./PdfPresentationModal";

afterEach(() => {
  cleanup();
});

// Mock pdfjs-dist to avoid loading canvas binary/worker in jsdom
vi.mock("pdfjs-dist", () => {
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 5,
        destroy: vi.fn(),
        getPage: () =>
          Promise.resolve({
            getViewport: () => ({ width: 800, height: 600 }),
            render: () => ({
              promise: Promise.resolve(),
              cancel: vi.fn(),
            }),
          }),
      }),
      destroy: vi.fn(),
    }),
  };
});

describe("PdfPresentationModal", () => {
  it("renders the presentation dialog with filename and controls", async () => {
    const onClose = vi.fn();
    render(
      <PdfPresentationModal
        filename="sample-deck.pdf"
        bytes={new Uint8Array([1, 2, 3])}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("sample-deck.pdf")).toBeInTheDocument();
    expect(screen.getByLabelText("Previous page")).toBeInTheDocument();
    expect(screen.getByLabelText("Next page")).toBeInTheDocument();
    expect(screen.getByLabelText("Close presentation")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <PdfPresentationModal
        filename="deck.pdf"
        bytes={new Uint8Array([1, 2, 3])}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByLabelText("Close presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(
      <PdfPresentationModal
        filename="deck.pdf"
        bytes={new Uint8Array([1, 2, 3])}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("displays loading status when loading is true", () => {
    render(
      <PdfPresentationModal filename="loading.pdf" bytes={null} loading={true} onClose={vi.fn()} />,
    );

    expect(screen.getByText(/Decrypting and loading PDF/i)).toBeInTheDocument();
  });

  it("navigates pages on Next and ArrowRight", async () => {
    render(
      <PdfPresentationModal
        filename="deck.pdf"
        bytes={new Uint8Array([1, 2, 3])}
        onClose={vi.fn()}
      />,
    );

    // Initial page: 1 / 5
    expect(await screen.findByText("1 / 5")).toBeInTheDocument();

    // Click next page
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(screen.getByText("2 / 5")).toBeInTheDocument();

    // Keyboard next page
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("3 / 5")).toBeInTheDocument();

    // Keyboard previous page
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("2 / 5")).toBeInTheDocument();
  });
});
