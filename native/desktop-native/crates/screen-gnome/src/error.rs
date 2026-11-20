use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(code: &'static str, message: impl std::fmt::Display) -> Self {
        Self {
            code,
            message: message.to_string().chars().take(500).collect(),
            detail: None,
        }
    }

    pub fn invalid(message: impl std::fmt::Display) -> Self {
        Self::new("invalid-action", message)
    }

    pub fn capture(message: impl std::fmt::Display) -> Self {
        Self::new("capture-failed", message)
    }

    pub fn input(message: impl std::fmt::Display) -> Self {
        Self::new("input-injection-failed", message)
    }

    pub fn cancelled() -> Self {
        Self::new(
            "request-cancelled",
            "Desktop access was released or interrupted.",
        )
    }

    pub fn denied() -> Self {
        Self::new(
            "permission-denied",
            "The required desktop session is not active.",
        )
    }

    pub fn text(message: impl std::fmt::Display) -> Self {
        Self::new("exact-text-unavailable", message)
    }
}

impl From<zbus::Error> for Error {
    fn from(error: zbus::Error) -> Self {
        Self::new("execution-failed", error)
    }
}

impl From<zbus::zvariant::Error> for Error {
    fn from(error: zbus::zvariant::Error) -> Self {
        Self::new("execution-failed", error)
    }
}
