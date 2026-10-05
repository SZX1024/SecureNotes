import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ImageLightboxModal } from "./ImageLightboxModal";

afterEach(() => {
  cleanup();
});

describe("ImageLightboxModal", () => {
  it("renders image and control toolbar", () => {
    const onClose = vi.fn();
    render(
      <ImageLightboxModal
        src="blob:http://localhost/test.png"
        alt="diagram.png"
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "blob:http://localhost/test.png");
    expect(img).toHaveAttribute("alt", "diagram.png");
  });

  it("closes when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <ImageLightboxModal
        src="blob:http://localhost/test.png"
        alt="diagram.png"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTitle(/Close/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape key press", () => {
    const onClose = vi.fn();
    render(
      <ImageLightboxModal
        src="blob:http://localhost/test.png"
        alt="diagram.png"
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
