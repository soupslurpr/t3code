use crate::{
    actions,
    error::{Error, Result},
    input::{Cleanup, Inputs},
    observation::Observation,
    portal::Session,
    power::Power,
    toolkit::Toolkit,
};
use serde_json::{Value, json};
use tokio::sync::watch;

pub struct Desktop {
    pub session: Option<Session>,
    inputs: Inputs,
    observation: Observation,
    power: Power,
    toolkit: Toolkit,
    remembered: [bool; 2],
    denied: bool,
}

impl Desktop {
    pub fn new() -> Self {
        Self {
            session: None,
            inputs: Inputs::default(),
            observation: Observation::default(),
            power: Power::new(),
            toolkit: Toolkit::default(),
            remembered: [false; 2],
            denied: false,
        }
    }

    pub async fn status(&mut self) -> Value {
        let available = self.power.probe().await;
        let display = self.power.state().await;
        if self.session.as_ref().is_some_and(|s| *s.revoked.borrow()) || display == "locked" {
            self.release().await;
        }
        self.status_value(available, display)
    }

    fn status_value(&self, available: bool, display: &str) -> Value {
        let permission = if !available {
            "unavailable"
        } else if let Some(s) = &self.session {
            if s.control() { "granted" } else { "view-only" }
        } else if self.remembered.contains(&true) {
            "remembered"
        } else if self.denied {
            "denied"
        } else {
            "prompt-required"
        };
        let remembered: Vec<_> = ["view", "control"]
            .into_iter()
            .zip(self.remembered)
            .filter_map(|(n, r)| r.then_some(n))
            .collect();
        let displays: Vec<_> = self
            .session
            .iter()
            .flat_map(|s| s.monitors.iter().map(|m| m.display()))
            .collect();
        json!({"available":available,"backend":available.then_some("gnome-wayland-portal"),"permission":permission,"rememberedAccess":remembered,
            "displayState":display,"keepAwake":self.power.held(),"displays":displays,"cursor":self.observation.status_cursor()})
    }

    async fn access(
        &mut self,
        control: bool,
        remember: bool,
        params: &Value,
        pending: &watch::Sender<Option<Value>>,
    ) -> Result<Value> {
        let restore = params
            .get("restoreToken")
            .map(|value| {
                value
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096)
                    .ok_or_else(|| Error::invalid("Invalid portal restore token."))
            })
            .transpose()?;
        let unconsumed = |mut error: Error| {
            if restore.is_some() {
                error.detail = Some(json!({"restoreTokenUnconsumed": true}));
            }
            error
        };
        let mut status = self.status().await;
        if status["available"] != true {
            return Err(unconsumed(Error::new(
                "unsupported-operation",
                "The GNOME Wayland screen portal is unavailable.",
            )));
        }
        self.power.prepare().await.map_err(unconsumed)?;
        if self.session.as_ref().is_some_and(|s| {
            (s.control() == control || (s.control() && !remember)) && (!remember || s.persistent)
        }) {
            // The caller withdrew its single-use token before dispatch. This grant reused the session.
            if let Some(token) = restore {
                status["restoreToken"] = token.into();
            }
            return Ok(status);
        }
        self.release().await;
        status["permission"] = "pending".into();
        status["displays"] = json!([]);
        status["cursor"] = Value::Null;
        pending.send_replace(Some(status));
        let prev_remembered = self.remembered[usize::from(control)];
        if restore.is_some() {
            self.remembered[usize::from(control)] = false;
        }
        let (session, token) = match Session::open(control, remember, restore).await {
            Ok(v) => v,
            Err(e) => {
                if e.detail
                    .as_ref()
                    .and_then(|d| d.get("restoreTokenUnconsumed"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    self.remembered[usize::from(control)] = prev_remembered;
                }
                self.denied = e.code == "permission-denied";
                return Err(e);
            }
        };
        self.toolkit.enable(&session.bus).await;
        let display = self.power.state().await;
        if *session.revoked.borrow() || display == "locked" {
            self.toolkit.restore().await;
            return Err(Error::cancelled());
        }
        if token.is_some() {
            self.remembered[usize::from(control)] = true;
        }
        self.denied = false;
        self.session = Some(session);
        let mut status = self.status_value(true, display);
        if let Some(token) = token {
            status["restoreToken"] = token.into();
        }
        Ok(status)
    }

    pub async fn release_inputs(&mut self) -> Cleanup {
        let mut cleanup = self.inputs.release(self.session.as_ref()).await;
        if cleanup.keys == "release-failed" || cleanup.buttons == "release-failed" {
            if let Some(s) = self.session.take() {
                s.close().await;
            }
            self.toolkit.restore().await;
            self.observation = Observation::default();
            if cleanup.keys == "release-failed" {
                cleanup.keys = "session-closed";
            }
            if cleanup.buttons == "release-failed" {
                cleanup.buttons = "session-closed";
            }
        }
        cleanup
    }

    pub async fn release(&mut self) {
        self.release_inputs().await;
        self.observation = Observation::default();
        if let Some(s) = self.session.take() {
            s.close().await;
        }
        self.toolkit.restore().await;
    }

    pub async fn finish(&mut self) {
        self.release().await;
        let _ = self.power.release().await;
    }

    pub async fn call(
        &mut self,
        method: &str,
        params: &Value,
        pending: &watch::Sender<Option<Value>>,
    ) -> Result<Value> {
        match method {
            "startup" | "status" => Ok(self.status().await),
            "requestView" | "rememberView" | "requestControl" | "rememberControl" => {
                self.access(
                    method.ends_with("Control"),
                    method.starts_with("remember"),
                    params,
                    pending,
                )
                .await
            }
            "requestAvailability" => {
                self.power.acquire().await?;
                Ok(self.status().await)
            }
            "releaseAvailability" => {
                self.power.release().await?;
                Ok(self.status().await)
            }
            "release" | "forget" => {
                self.release().await;
                if method == "forget" {
                    self.remembered = [false; 2];
                }
                self.denied = false;
                Ok(Value::Null)
            }
            "releaseInputs" => {
                let cleanup = self.release_inputs().await;
                self.observation = Observation::default();
                Ok(json!(cleanup))
            }
            "cancelPendingAccess" => Ok(Value::Null),
            "snapshot" => {
                let session = self.session.as_mut().ok_or_else(Error::denied)?;
                let id = params["desktopId"]
                    .as_str()
                    .ok_or_else(|| Error::invalid("Missing desktopId."))?;
                let empty = json!({});
                self.observation
                    .snapshot(
                        session,
                        id,
                        params.get("options").unwrap_or(&empty),
                        params["legacyDisplayId"].as_str(),
                    )
                    .await
            }
            "act" => {
                actions::act(
                    &mut self.observation,
                    &mut self.inputs,
                    self.session.as_ref().ok_or_else(Error::denied)?,
                    &params["action"],
                )
                .await
            }
            _ => Err(Error::new(
                "unsupported-operation",
                "Unknown GNOME helper method.",
            )),
        }
    }
}
