/** Verifies idempotent native session cleanup without suppressing real portal failures. */
import { describe, expect, it } from "vite-plus/test";

import { isMissingPortalSessionError } from "../resources/computer-use/portal-session.js";

describe("portal session closure", () => {
  it.each([
    "GDBus.Error:org.freedesktop.DBus.Error.UnknownObject: Object does not exist",
    "GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Object does not exist",
    "Gio.DBusError: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface “org.freedesktop.portal.Session” on object at path /org/freedesktop/portal/desktop/session/1_10/session2",
  ])("accepts a session already removed by cancellation: %s", (message) => {
    expect(isMissingPortalSessionError(message)).toBe(true);
  });

  it.each([
    "GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Permission denied",
    "GDBus.Error:org.freedesktop.DBus.Error.NoReply: Session close timed out",
    "GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such method Close",
    "GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface org.freedesktop.portal.Request",
    "No such interface org.freedesktop.portal.Session",
  ])("preserves a real cleanup failure: %s", (message) => {
    expect(isMissingPortalSessionError(message)).toBe(false);
  });
});
