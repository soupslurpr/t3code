/** Recognizes portal session removal during concurrent request cancellation. */
const UNKNOWN_OBJECT_ERROR = "org.freedesktop.DBus.Error.UnknownObject";
const UNKNOWN_METHOD_ERROR = "org.freedesktop.DBus.Error.UnknownMethod";
const SESSION_INTERFACE = "org.freedesktop.portal.Session";

/** Returns whether a failed Close call confirms that the session is already absent. */
export function isMissingPortalSessionError(message) {
  return (
    message.includes(UNKNOWN_OBJECT_ERROR) ||
    (message.includes(UNKNOWN_METHOD_ERROR) &&
      (message.includes("Object does not exist") ||
        (message.includes("No such interface") && message.includes(SESSION_INTERFACE))))
  );
}
