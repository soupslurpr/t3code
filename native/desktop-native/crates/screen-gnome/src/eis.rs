use crate::error::{Error, Result};
use std::{
    cell::RefCell,
    ffi::{CString, c_char, c_void},
    fs::File,
    os::fd::{BorrowedFd, IntoRawFd, OwnedFd},
    os::unix::fs::FileExt,
    ptr::NonNull,
    rc::Rc,
    time::Duration,
};
use tokio::{io::unix::AsyncFd, sync::watch, task::JoinHandle};
use xkbcommon::xkb;

unsafe extern "C" {
    fn t3_ei_open(fd: i32) -> *mut c_void;
    fn t3_ei_close(client: *mut c_void);
    fn t3_ei_fd(client: *mut c_void) -> i32;
    fn t3_ei_readable(client: *mut c_void) -> bool;
    fn t3_ei_dispatch(client: *mut c_void) -> i32;
    fn t3_ei_keymap(
        client: *mut c_void,
        size: *mut usize,
        group: *mut u32,
        generation: *mut u32,
    ) -> i32;
    fn t3_ei_key(client: *mut c_void, key: u32, down: bool) -> bool;
    fn t3_ei_button(client: *mut c_void, button: u32, down: bool) -> bool;
    fn t3_ei_scroll(client: *mut c_void, x: i32, y: i32) -> bool;
    fn t3_ei_motion(
        client: *mut c_void,
        mapping: *const c_char,
        u: f64,
        v: f64,
        x: f64,
        y: f64,
    ) -> bool;
}

struct Native(NonNull<c_void>);

impl Drop for Native {
    fn drop(&mut self) {
        unsafe { t3_ei_close(self.0.as_ptr()) }
    }
}

pub struct Eis {
    native: Rc<Native>,
    events: JoinHandle<()>,
    keymap: RefCell<Option<(u32, xkb::Keymap)>>,
}

impl Drop for Eis {
    fn drop(&mut self) {
        self.events.abort();
    }
}

impl Eis {
    pub async fn connect(fd: OwnedFd, revoked: watch::Sender<bool>) -> Result<Self> {
        let raw = NonNull::new(unsafe { t3_ei_open(fd.into_raw_fd()) })
            .ok_or_else(|| Error::input("Could not initialize the portal EIS connection."))?;
        let native = Rc::new(Native(raw));
        let fd = unsafe { BorrowedFd::borrow_raw(t3_ei_fd(raw.as_ptr())) };
        let owned = fd.try_clone_to_owned().map_err(Error::input)?;
        // AsyncFd owns this duplicate exclusively for its entire registration.
        let poll = unsafe { AsyncFd::register_with_interest(owned, tokio::io::Interest::READABLE) }
            .map_err(Error::input)?;
        let (updates, mut ready) = watch::channel(0);
        let owner = native.clone();
        let events = tokio::task::spawn_local(async move {
            let mut negotiated = false;
            loop {
                let mut dispatched = 0_u32;
                let state = loop {
                    let state = unsafe { t3_ei_dispatch(owner.0.as_ptr()) };
                    negotiated |= state == 1;
                    updates.send_if_modified(|previous| {
                        let changed = state != *previous;
                        *previous = state;
                        changed
                    });
                    if state < 0 || (negotiated && state == 0) {
                        break state;
                    }
                    // libei stops recvmsg before EAGAIN on <1 KiB reads such as SCM_RIGHTS keymap
                    // boundaries, leaving its level-triggered epoll fd ready. Drain it before
                    // clearing readiness on Tokio's edge-triggered AsyncFd.
                    if !unsafe { t3_ei_readable(owner.0.as_ptr()) } {
                        break state;
                    }
                    dispatched += 1;
                    if dispatched >= 64 {
                        tokio::task::yield_now().await;
                        dispatched = 0;
                    }
                };
                if state < 0 || (negotiated && state == 0) {
                    break;
                }
                let Ok(mut guard) = poll.readable().await else {
                    break;
                };
                guard.clear_ready();
            }
            if negotiated {
                revoked.send_replace(true);
            }
        });
        let client = Self {
            native,
            events,
            keymap: RefCell::default(),
        };
        let ready = tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|v| *v != 0)).await;
        if !matches!(ready, Ok(Ok(value)) if *value == 1) {
            return Err(Error::input(
                "EIS did not grant active keyboard, pointer, button and scroll devices.",
            ));
        }
        Ok(client)
    }

    // A keymap belongs to its resumed device. Read a bounded copy before returning to the event loop.
    pub fn resolve(&self, symbol: u32) -> Result<(u32, bool)> {
        let (mut size, mut group, mut generation) = (0, 0, 0);
        let fd = unsafe {
            t3_ei_keymap(
                self.native.0.as_ptr(),
                &mut size,
                &mut group,
                &mut generation,
            )
        };
        if fd < 0 || !(1..=4 * 1024 * 1024).contains(&size) {
            return Err(Error::input(
                "EIS did not provide a usable keyboard layout.",
            ));
        }
        let mut cache = self.keymap.borrow_mut();
        if cache.as_ref().is_none_or(|(old, _)| *old != generation) {
            let file = File::from(
                unsafe { BorrowedFd::borrow_raw(fd) }
                    .try_clone_to_owned()
                    .map_err(Error::input)?,
            );
            let mut data = vec![0; size];
            file.read_exact_at(&mut data, 0).map_err(Error::input)?;
            if data.last() == Some(&0) {
                data.pop();
            }
            if data.contains(&0) {
                return Err(Error::input("Invalid EIS keymap."));
            }
            let map = xkb::Keymap::new_from_string(
                &xkb::Context::new(xkb::CONTEXT_NO_FLAGS),
                String::from_utf8(data).map_err(Error::input)?,
                xkb::KEYMAP_FORMAT_TEXT_V1,
                xkb::KEYMAP_COMPILE_NO_FLAGS,
            )
            .ok_or_else(|| Error::input("Could not read the EIS keyboard layout."))?;
            *cache = Some((generation, map));
        }
        let map = &cache.as_ref().unwrap().1;
        let mut best = None;
        map.key_for_each(|map, key| {
            let layout_count = map.num_layouts_for_key(key);
            if layout_count == 0 || key.raw() < 8 {
                return;
            }
            let layout = group % layout_count;
            for level in 0..map.num_levels_for_key(key, layout).min(2) {
                if map
                    .key_get_syms_by_level(key, layout, level)
                    .iter()
                    .any(|k| k.raw() == symbol)
                    && best.is_none_or(|(_, shifted)| shifted && level == 0)
                {
                    best = Some((key.raw() - 8, level == 1));
                }
            }
        });
        best.ok_or_else(|| {
            Error::new(
                "invalid-key-name",
                "The key is unavailable on the active EIS keyboard layout.",
            )
        })
    }

    fn sent(success: bool) -> Result<()> {
        success
            .then_some(())
            .ok_or_else(|| Error::input("The EIS device or display region is unavailable."))
    }

    pub fn key(&self, code: u32, down: bool) -> Result<()> {
        Self::sent(unsafe { t3_ei_key(self.native.0.as_ptr(), code, down) })
    }

    pub fn button(&self, code: u32, down: bool) -> Result<()> {
        Self::sent(unsafe { t3_ei_button(self.native.0.as_ptr(), code, down) })
    }

    pub fn scroll(&self, x: i32, y: i32) -> Result<()> {
        Self::sent(unsafe { t3_ei_scroll(self.native.0.as_ptr(), x, y) })
    }

    pub fn motion(&self, mapping: Option<&str>, unit: (f64, f64), point: (f64, f64)) -> Result<()> {
        let mapping = mapping
            .map(CString::new)
            .transpose()
            .map_err(Error::input)?;
        Self::sent(unsafe {
            t3_ei_motion(
                self.native.0.as_ptr(),
                mapping.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                unit.0,
                unit.1,
                point.0,
                point.1,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::fd::{AsRawFd, FromRawFd},
        ptr,
    };

    type Object = *mut c_void;
    #[link(name = "eis")]
    unsafe extern "C" {
        fn eis_new(data: Object) -> Object;
        fn eis_unref(ctx: Object) -> Object;
        fn eis_setup_backend_fd(ctx: Object) -> i32;
        fn eis_backend_fd_add_client(ctx: Object) -> i32;
        fn eis_get_fd(ctx: Object) -> i32;
        fn eis_dispatch(ctx: Object);
        fn eis_get_event(ctx: Object) -> Object;
        fn eis_event_unref(event: Object) -> Object;
        fn eis_event_get_type(event: Object) -> u32;
        fn eis_event_get_client(event: Object) -> Object;
        fn eis_event_get_seat(event: Object) -> Object;
        fn eis_client_connect(client: Object);
        fn eis_client_new_seat(client: Object, name: *const c_char) -> Object;
        fn eis_seat_configure_capability(seat: Object, cap: u32);
        fn eis_seat_add(seat: Object);
        fn eis_seat_unref(seat: Object) -> Object;
        fn eis_seat_new_device(seat: Object) -> Object;
        fn eis_device_configure_name(device: Object, name: *const c_char);
        fn eis_device_configure_capability(device: Object, cap: u32);
        fn eis_device_new_region(device: Object) -> Object;
        fn eis_region_set_size(region: Object, width: u32, height: u32);
        fn eis_region_add(region: Object);
        fn eis_region_unref(region: Object) -> Object;
        fn eis_device_new_keymap(device: Object, kind: u32, fd: i32, size: usize) -> Object;
        fn eis_keymap_add(map: Object);
        fn eis_keymap_unref(map: Object) -> Object;
        fn eis_device_add(device: Object);
        fn eis_device_resume(device: Object);
        fn eis_device_remove(device: Object);
        fn eis_device_unref(device: Object) -> Object;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connect_drains_buffered_devices_past_scm_rights_keymap_boundary() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let map = xkb::Keymap::new_from_names(
                    &xkb::Context::new(xkb::CONTEXT_NO_FLAGS),
                    "",
                    "",
                    "us",
                    "",
                    None,
                    0,
                )
                .unwrap()
                .get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1);
                let keymap_path =
                    std::env::temp_dir().join(format!("t3-eis-keymap-{}", std::process::id()));
                File::create(&keymap_path)
                    .unwrap()
                    .write_all(map.as_bytes())
                    .unwrap();
                let keymap_file = File::open(&keymap_path).unwrap();
                let _ = std::fs::remove_file(&keymap_path);

                let ctx = unsafe { eis_new(ptr::null_mut()) };
                assert!(!ctx.is_null());
                assert_eq!(unsafe { eis_setup_backend_fd(ctx) }, 0);
                let client_fd = unsafe { OwnedFd::from_raw_fd(eis_backend_fd_add_client(ctx)) };
                let server_fd = unsafe { BorrowedFd::borrow_raw(eis_get_fd(ctx)) }
                    .try_clone_to_owned()
                    .unwrap();
                let server_poll = unsafe {
                    AsyncFd::register_with_interest(server_fd, tokio::io::Interest::READABLE)
                }
                .unwrap();

                let server = tokio::task::spawn_local(async move {
                    let mut devices: [Object; 2] = [ptr::null_mut(); 2];
                    let mut done = false;
                    while !done {
                        unsafe {
                            eis_dispatch(ctx);
                            loop {
                                let event = eis_get_event(ctx);
                                if event.is_null() {
                                    break;
                                }
                                match eis_event_get_type(event) {
                                    1 => {
                                        let client = eis_event_get_client(event);
                                        eis_client_connect(client);
                                        let seat = eis_client_new_seat(client, c"seat".as_ptr());
                                        for cap in [2, 4, 16, 32] {
                                            eis_seat_configure_capability(seat, cap);
                                        }
                                        eis_seat_add(seat);
                                        eis_seat_unref(seat);
                                    }
                                    2 => {
                                        done = true;
                                        break;
                                    }
                                    3 => {
                                        // Synchronously burst keyboard (with SCM_RIGHTS keymap fd)
                                        // followed by pointer before yielding back to the client.
                                        let seat = eis_event_get_seat(event);
                                        for (slot, caps) in
                                            devices.iter_mut().zip([&[4][..], &[2, 16, 32][..]])
                                        {
                                            let device = eis_seat_new_device(seat);
                                            eis_device_configure_name(device, c"Burst".as_ptr());
                                            for cap in caps {
                                                eis_device_configure_capability(device, *cap);
                                            }
                                            if caps.contains(&2) {
                                                let region = eis_device_new_region(device);
                                                eis_region_set_size(region, 640, 480);
                                                eis_region_add(region);
                                                eis_region_unref(region);
                                            } else {
                                                let keymap = eis_device_new_keymap(
                                                    device,
                                                    1,
                                                    keymap_file.as_raw_fd(),
                                                    map.len(),
                                                );
                                                eis_keymap_add(keymap);
                                                eis_keymap_unref(keymap);
                                            }
                                            eis_device_add(device);
                                            eis_device_resume(device);
                                            *slot = device;
                                        }
                                        done = true;
                                    }
                                    _ => {}
                                }
                                eis_event_unref(event);
                            }
                        }
                        if !done {
                            let Ok(mut guard) = server_poll.readable().await else {
                                break;
                            };
                            guard.clear_ready();
                        }
                    }
                    // Keep devices alive until client finishes connecting and drops.
                    tokio::task::yield_now().await;
                    (ctx, devices)
                });

                let (revoked, _) = watch::channel(false);
                let connected = Eis::connect(client_fd, revoked).await;
                let client = match connected {
                    Ok(client) => client,
                    Err(error) => {
                        server.abort();
                        let _ = server.await;
                        panic!("EIS connect should drain past SCM_RIGHTS keymap: {error:?}");
                    }
                };
                assert_eq!(client.resolve(0x0061).unwrap(), (30, false));
                drop(client);
                let (ctx, devices) = server.await.unwrap();
                unsafe {
                    for device in devices {
                        if !device.is_null() {
                            eis_device_remove(device);
                            eis_device_unref(device);
                        }
                    }
                    eis_unref(ctx);
                }
            })
            .await;
    }
}
