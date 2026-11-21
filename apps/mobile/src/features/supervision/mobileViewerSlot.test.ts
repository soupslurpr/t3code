import { expect, it, vi } from "vite-plus/test";
import { createMobileViewerSlot } from "./mobileViewerSlot";

it("drains the previous screen and skips a route dismissed while it waits for control", async () => {
  const slot = createMobileViewerSlot();
  const release = Promise.withResolvers<void>();
  const first = { open: vi.fn(async () => {}), close: vi.fn(() => release.promise) };
  const middle = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const last = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };

  await slot.open(first, "control");
  const waiting = slot.open(middle, "view");
  const dismissed = slot.close(middle);
  const opened = slot.open(last, "control");
  expect(first.close).toHaveBeenCalledOnce();
  expect(middle.close).toHaveBeenCalledOnce();
  expect(last.open).not.toHaveBeenCalled();
  release.resolve();
  await Promise.all([waiting, dismissed, opened]);
  expect(middle.open).not.toHaveBeenCalled();
  expect(last.open).toHaveBeenCalledExactlyOnceWith("control");
});

it("reports failed handback before allowing a new acquire and supports an explicit retry", async () => {
  const slot = createMobileViewerSlot();
  const release = Promise.withResolvers<void>();
  const first = { open: vi.fn(async () => {}), close: vi.fn(() => release.promise) };
  const next = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  await slot.open(first, "control");
  const handback = slot.close(first);
  const switching = slot.open(next, "view");
  release.reject(new Error("Lease release failed"));
  await expect(handback).rejects.toThrow("Lease release failed");
  await expect(switching).rejects.toThrow("Lease release failed");
  expect(next.open).not.toHaveBeenCalled();
  await slot.close(next);
  await slot.open(next, "view");
  expect(next.open).toHaveBeenCalledExactlyOnceWith("view");
});
