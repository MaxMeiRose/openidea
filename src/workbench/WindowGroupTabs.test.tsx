import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { useWindowGroup } from "@/platform/windowGroups";
import { usePlatform } from "@/platform/platformInfo";
import { WindowGroupTabs } from "./WindowGroupTabs";

vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: vi.fn(async () => {}),
}));

const platform = usePlatform.getState();

beforeEach(() => {
  usePlatform.setState({ overlayTitleBar: false });
  vi.mocked(executeAction).mockClear();
  useWindowGroup.setState({
    tabs: [
      { label: "main", name: "Frontend", root: "/front", current: true },
      { label: "project-1", name: "Backend", root: "/back", current: false },
    ],
  });
});

afterEach(() => usePlatform.setState(platform));

it("switches and closes the intended project with mouse and keyboard", () => {
  render(<WindowGroupTabs />);
  const first = screen.getByRole("tab", { name: "Frontend" });
  expect(first).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Backend" })).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "project-1");
  fireEvent.click(screen.getByRole("button", { name: "Close Backend" }));
  expect(executeAction).toHaveBeenLastCalledWith("window.closeTab", "project-1");
  fireEvent.click(first);
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "main");
});

it("removes the tab row when the group dissolves", () => {
  useWindowGroup.setState({ tabs: [] });
  render(<WindowGroupTabs />);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

it("uses the system project tabs on macOS without drawing a second tab row", () => {
  usePlatform.setState({ overlayTitleBar: true });
  render(<WindowGroupTabs />);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});
