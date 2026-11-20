use crate::{
    bus::{session_bus, token},
    error::{Error, Result},
    input::Inputs,
    portal::Session,
};
use atspi::{
    CoordType, Interface, ObjectRefOwned as Node, State, StateSet,
    proxy::{
        accessible::AccessibleProxy, action::ActionProxy, component::ComponentProxy,
        editable_text::EditableTextProxy, text::TextProxy,
    },
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::{Duration, Instant},
};
use tokio::time::timeout;
use zbus::{Connection, proxy::CacheProperties};

const DEADLINE: Duration = Duration::from_secs(3);
const CALL: Duration = Duration::from_millis(300);
const NODES: usize = 4000;
const TARGETS: usize = 256;
const WINDOWS: usize = 128;

fn stale() -> Error {
    Error::new(
        "stale-semantic-target",
        "The accessible window or target has changed. Observe again.",
    )
}
fn failed() -> Error {
    Error::new(
        "semantic-activation-failed",
        "The application did not accept semantic activation.",
    )
}
fn bounded(s: String, max: usize) -> String {
    // Public string limits are JavaScript UTF-16 lengths.
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= max
        })
        .collect()
}

macro_rules! proxy_for {
    ($name:ident, $ty:ident) => {
        async fn $name(bus: &Connection, n: &Node) -> zbus::Result<$ty<'static>> {
            $ty::builder(bus)
                .destination(n.name().cloned().ok_or(zbus::Error::MissingField)?)?
                .path(n.path().clone())?
                .cache_properties(CacheProperties::No)
                .build()
                .await
        }
    };
}

proxy_for!(accessible, AccessibleProxy);
proxy_for!(component, ComponentProxy);
proxy_for!(action, ActionProxy);
proxy_for!(editable_text, EditableTextProxy);
proxy_for!(text_proxy, TextProxy);

#[derive(Clone, PartialEq)]
struct Window {
    node: Node,
    app: String,
    name: String,
    focused: bool,
}

#[derive(Clone, PartialEq)]
enum Activation {
    Action(i32),
    Focus,
    Keyboard,
}

#[derive(Clone)]
struct Target {
    node: Node,
    window: Node,
    data: Value,
    activation: Activation,
}

#[derive(Default)]
pub struct Semantics {
    windows: HashMap<String, Window>,
    targets: HashMap<String, Target>,
}

async fn connect() -> Result<Connection> {
    // The high-level AT-SPI connection also starts a peer listener. The registry bus
    // already routes every operation this local client needs.
    timeout(Duration::from_secs(1), async {
        let bus = session_bus().await?;
        let address = atspi::proxy::bus::BusProxy::new(&bus)
            .await?
            .get_address()
            .await?;
        if !address.starts_with("unix:") || address.contains(';') {
            return Err(failed());
        }
        Ok(zbus::connection::Builder::address(address.as_str())?
            .method_timeout(CALL)
            .build()
            .await?)
    })
    .await
    .map_err(|_| failed())?
}

async fn inventory(bus: &Connection) -> Result<(Vec<Window>, bool)> {
    let root = AccessibleProxy::builder(bus)
        .destination("org.a11y.atspi.Registry")?
        .path("/org/a11y/atspi/accessible/root")?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let apps = root.get_children().await?;
    let deadline = Instant::now() + DEADLINE;
    let mut truncated = apps.len() > WINDOWS;
    let mut windows = Vec::new();
    for app in apps.into_iter().take(WINDOWS) {
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        let Ok(Ok((app, roots))) = timeout(CALL, async {
            let a = accessible(bus, &app).await?;
            let name = bounded(a.name().await?, 256);
            let lower = name.to_lowercase();
            if matches!(lower.as_str(), "gnome-shell" | "gnome shell")
                || lower.starts_with("xdg-desktop-portal")
            {
                return Ok::<_, zbus::Error>((name, vec![]));
            }
            Ok((name, a.get_children().await?))
        })
        .await
        else {
            continue;
        };
        for node in roots.into_iter().take(WINDOWS + 1) {
            if windows.len() == WINDOWS || Instant::now() >= deadline {
                truncated = true;
                break;
            }
            let w = timeout(CALL, async {
                let a = accessible(bus, &node).await?;
                let role = a.get_role_name().await?;
                if !matches!(role.as_str(), "frame" | "window" | "dialog" | "alert") {
                    return Ok::<_, zbus::Error>(None);
                }
                let states = a.get_state().await?;
                if states.contains(State::Defunct) {
                    return Ok(None);
                }
                Ok(Some(Window {
                    node: node.clone(),
                    app: app.clone(),
                    name: bounded(a.name().await?, 512),
                    focused: states.contains(State::Active) || states.contains(State::Focused),
                }))
            })
            .await;
            if let Ok(Ok(Some(w))) = w {
                windows.push(w);
            }
        }
    }
    Ok((windows, truncated))
}

fn active(windows: &[Window]) -> Option<&Window> {
    let mut focused = windows.iter().filter(|w| w.focused);
    let first = focused.next()?;
    focused.next().is_none().then_some(first)
}

fn preferred(actions: &[atspi::Action], names: &[&str]) -> Option<i32> {
    names
        .iter()
        .find_map(|name| {
            actions
                .iter()
                .position(|a| a.name.eq_ignore_ascii_case(name))
        })
        .map(|i| i as i32)
}

async fn candidate(
    bus: &Connection,
    window: &Window,
    node: &Node,
    states: StateSet,
    size: (i32, i32),
) -> zbus::Result<Option<Target>> {
    if !states.contains(State::Showing) || !states.contains(State::Visible) {
        return Ok(None);
    }
    let a = accessible(bus, node).await?;
    let role = bounded(a.get_role_name().await?, 128);
    let focus_role = matches!(
        role.as_str(),
        "entry" | "password text" | "spin button" | "slider"
    ) || states.contains(State::Editable);
    if !focus_role
        && !matches!(
            role.as_str(),
            "button"
                | "push button"
                | "check box"
                | "check menu item"
                | "combo box"
                | "icon"
                | "link"
                | "list item"
                | "menu item"
                | "page tab"
                | "radio button"
                | "radio menu item"
                | "table cell"
                | "text"
                | "toggle button"
                | "tree item"
        )
    {
        return Ok(None);
    }
    let ifaces = a.get_interfaces().await?;
    if !ifaces.contains(Interface::Component) {
        return Ok(None);
    }
    let activation = if focus_role {
        Activation::Focus
    } else {
        let idx = if ifaces.contains(Interface::Action) {
            preferred(
                &action(bus, node).await?.get_actions().await?,
                &["click", "press", "activate", "open", "toggle", "select"],
            )
        } else {
            None
        };
        match idx {
            Some(i) => Activation::Action(i),
            None if states.contains(State::Focusable) => Activation::Keyboard,
            None => return Ok(None),
        }
    };
    let (x, y, w, h) = component(bus, node)
        .await?
        .get_extents(CoordType::Window)
        .await?;
    let (left, top, right, bottom) = (
        x.max(0),
        y.max(0),
        x.saturating_add(w).min(size.0),
        y.saturating_add(h).min(size.1),
    );
    if right <= left || bottom <= top {
        return Ok(None);
    }
    let mut data = json!({"application":window.app,"role":role,"name":bounded(a.name().await?,512),
        "bounds":{"x":left,"y":top,"width":right-left,"height":bottom-top},
        "activation":match activation { Activation::Focus=>"focus",Activation::Keyboard=>"keyboard",Activation::Action(_)=>"action" },
        "enabled":states.contains(State::Enabled), "focused":states.contains(State::Focused),
        "selected":states.contains(State::Selected), "checked":states.contains(State::Checked),"expanded":states.contains(State::Expanded)});
    if let Ok(s) = a.description().await
        && !s.is_empty()
    {
        data["description"] = bounded(s, 1024).into();
    }
    Ok(Some(Target {
        node: node.clone(),
        window: window.node.clone(),
        data,
        activation,
    }))
}

struct Walk {
    queue: VecDeque<Node>,
    seen: HashSet<(String, String)>,
    deadline: Instant,
    truncated: bool,
}

impl Walk {
    async fn new(bus: &Connection, root: &Node) -> Self {
        // Chromium exposes the window's descendants lazily when an assistive client reads its attributes.
        let _ = timeout(CALL, async {
            accessible(bus, root).await?.get_attributes().await
        })
        .await;
        Self {
            queue: VecDeque::from([root.clone()]),
            seen: HashSet::new(),
            deadline: Instant::now() + DEADLINE,
            truncated: false,
        }
    }

    async fn next(&mut self, bus: &Connection) -> Option<(Node, StateSet)> {
        while let Some(node) = self.queue.pop_front() {
            if self.seen.len() >= NODES || Instant::now() >= self.deadline {
                self.truncated = true;
                break;
            }
            let Some(name) = node.name_as_str() else {
                continue;
            };
            if !self
                .seen
                .insert((name.to_string(), node.path_as_str().to_string()))
            {
                continue;
            }
            let Ok(Ok((states, children))) = timeout(CALL, async {
                let a = accessible(bus, &node).await?;
                let states = a.get_state().await?;
                let children = if states.contains(State::Defunct) {
                    Vec::new()
                } else {
                    a.get_children().await.unwrap_or_default()
                };
                Ok::<_, zbus::Error>((states, children))
            })
            .await
            else {
                self.truncated = true;
                continue;
            };
            let remaining = (NODES - self.seen.len())
                .saturating_sub(self.queue.len())
                .min(500);
            self.truncated |= children.len() > remaining;
            self.queue.extend(children.into_iter().take(remaining));
            if !states.contains(State::Defunct) {
                return Some((node, states));
            }
        }
        None
    }
}

impl Semantics {
    pub async fn snapshot(&mut self) -> Value {
        *self = Self::default();
        let mut view = json!({"available":false,"coordinateSpace":"focused-window","window":null,"windows":[],"targets":[],"truncated":false});
        let conn = match connect().await {
            Ok(conn) => conn,
            Err(_) => {
                view["detail"] = "The desktop accessibility bus is unavailable.".into();
                return view;
            }
        };
        let Ok(Ok((windows, mut truncated))) = timeout(DEADLINE, inventory(&conn)).await else {
            return view;
        };
        view["available"] = true.into();
        let generation = token();
        for (i, w) in windows.iter().enumerate() {
            let id = format!("{generation}_w{i}");
            view["windows"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":id,"application":w.app,"name":w.name,"focused":w.focused}));
            self.windows.insert(id, w.clone());
        }
        let Some(w) = active(&windows) else {
            view["truncated"] = truncated.into();
            return view;
        };
        let bus = &conn;
        let Ok(Ok((_, _, width, height))) = timeout(CALL, async {
            component(bus, &w.node)
                .await?
                .get_extents(CoordType::Window)
                .await
        })
        .await
        else {
            return view;
        };
        if width <= 0 || height <= 0 {
            return view;
        }
        view["window"] =
            json!({"application":w.app,"name":w.name,"size":{"width":width,"height":height}});
        let mut walk = Walk::new(bus, &w.node).await;
        while let Some((n, states)) = walk.next(bus).await {
            let Ok(Ok(Some(mut target))) =
                timeout(CALL, candidate(bus, w, &n, states, (width, height))).await
            else {
                continue;
            };
            let id = format!("{generation}_t{}", self.targets.len());
            target.data["id"] = id.clone().into();
            view["targets"]
                .as_array_mut()
                .unwrap()
                .push(target.data.clone());
            self.targets.insert(id, target);
            if self.targets.len() == TARGETS {
                truncated = true;
                break;
            }
        }
        view["truncated"] = (truncated || walk.truncated).into();
        view
    }

    pub async fn activate(
        self,
        id: &str,
        window: bool,
        inputs: &mut Inputs,
        session: &Session,
    ) -> Result<bool> {
        if (window && !self.windows.contains_key(id)) || (!window && !self.targets.contains_key(id))
        {
            return Err(stale());
        }
        let conn = connect().await?;
        let bus = &conn;
        let (windows, truncated) = inventory(&conn).await?;
        if window {
            let old = self.windows.get(id).ok_or_else(stale)?;
            let current = windows
                .iter()
                .find(|w| w.node == old.node && w.name == old.name && w.app == old.app)
                .ok_or_else(stale)?;
            if current.focused {
                return Ok(false);
            }
            let mut accepted = false;
            if let Ok(actions) = action(bus, &current.node).await?.get_actions().await
                && let Some(i) = preferred(&actions, &["activate", "raise", "present"])
            {
                accepted = action(bus, &current.node).await?.do_action(i).await?;
            }
            if !accepted {
                accepted = component(bus, &current.node)
                    .await?
                    .grab_focus()
                    .await
                    .unwrap_or(false);
            }
            if accepted {
                let a = accessible(bus, &current.node).await?;
                for _ in 0..10 {
                    let state = a.get_state().await?;
                    if state.contains(State::Active) || state.contains(State::Focused) {
                        return Ok(false);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            if truncated || active(&windows).is_none() {
                return Err(failed());
            }
            // Wayland applications cannot always raise their own toplevel. GNOME's
            // window switcher updates its MRU order each time Alt is released.
            for count in 1..windows.len() {
                inputs.switch_window(session, count).await?;
                tokio::time::sleep(Duration::from_millis(100)).await;
                let (now, truncated) = inventory(&conn).await?;
                if truncated
                    || now.len() != windows.len()
                    || now.iter().any(|new| {
                        !windows.iter().any(|old| {
                            old.node == new.node && old.name == new.name && old.app == new.app
                        })
                    })
                {
                    return Err(stale());
                }
                let selected = active(&now).ok_or_else(stale)?;
                if selected.node == current.node {
                    return Ok(false);
                }
            }
            return Err(failed());
        }
        let old = self.targets.get(id).ok_or_else(stale)?;
        let w = active(&windows)
            .filter(|w| w.node == old.window)
            .ok_or_else(stale)?;
        let mut walk = Walk::new(bus, &w.node).await;
        let states = loop {
            let (n, states) = walk.next(bus).await.ok_or_else(stale)?;
            if n == old.node {
                break states;
            }
        };
        let a = accessible(bus, &old.node).await?;
        let (_, _, width, height) = component(bus, &w.node)
            .await?
            .get_extents(CoordType::Window)
            .await?;
        let current = candidate(bus, w, &old.node, states, (width, height))
            .await?
            .ok_or_else(stale)?;
        if !states.contains(State::Enabled)
            || ["role", "name", "bounds", "application"]
                .iter()
                .any(|f| old.data[*f] != current.data[*f])
            || old.activation != current.activation
        {
            return Err(stale());
        }
        match current.activation {
            Activation::Action(i) if action(bus, &old.node).await?.do_action(i).await? => Ok(false),
            Activation::Focus | Activation::Keyboard
                if component(bus, &old.node).await?.grab_focus().await? =>
            {
                if matches!(current.activation, Activation::Keyboard) {
                    let root = accessible(bus, &w.node).await?.get_state().await?;
                    if !(root.contains(State::Active) || root.contains(State::Focused))
                        || !a.get_state().await?.contains(State::Focused)
                    {
                        return Err(stale());
                    }
                }
                Ok(matches!(current.activation, Activation::Keyboard))
            }
            _ => Err(failed()),
        }
    }
}

pub struct Editable {
    pub node: AccessibleProxy<'static>,
    pub text: TextProxy<'static>,
    pub edit: EditableTextProxy<'static>,
    pub multiline: bool,
    window: AccessibleProxy<'static>,
}

impl Editable {
    pub async fn focused(&self) -> bool {
        let (n, w) = tokio::join!(self.node.get_state(), self.window.get_state());
        n.is_ok_and(|s| {
            s.contains(State::Focused) && s.contains(State::Editable) && !s.contains(State::Defunct)
        }) && w.is_ok_and(|s| s.contains(State::Active) || s.contains(State::Focused))
    }

    pub async fn find() -> Option<Self> {
        let conn = connect().await.ok()?;
        let bus = &conn;
        let (windows, _) = inventory(&conn).await.ok()?;
        let root = active(&windows)?;
        let mut walk = Walk::new(bus, &root.node).await;
        while let Some((n, s)) = walk.next(bus).await {
            if !s.contains(State::Focused)
                || !s.contains(State::Editable)
                || s.contains(State::ReadOnly)
            {
                continue;
            }
            let node = accessible(bus, &n).await.ok()?;
            let ifaces = node.get_interfaces().await.ok()?;
            if !ifaces.contains(Interface::Text) || !ifaces.contains(Interface::EditableText) {
                continue;
            }
            return Some(Self {
                node,
                window: accessible(bus, &root.node).await.ok()?,
                text: text_proxy(bus, &n).await.ok()?,
                edit: editable_text(bus, &n).await.ok()?,
                multiline: s.contains(State::MultiLine),
            });
        }
        None
    }
}
