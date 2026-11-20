use std::{
    ffi::c_void,
    fs::File,
    io::Write,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::Path,
    ptr, thread,
};
use tokio::sync::mpsc;
use xkbcommon::xkb;

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
    fn eis_event_get_device(event: Object) -> Object;
    fn eis_event_seat_has_capability(event: Object, cap: u32) -> bool;
    fn eis_client_connect(client: Object);
    fn eis_client_disconnect(client: Object);
    fn eis_client_new_seat(client: Object, name: *const std::ffi::c_char) -> Object;
    fn eis_seat_configure_capability(seat: Object, cap: u32);
    fn eis_seat_add(seat: Object);
    fn eis_seat_unref(seat: Object) -> Object;
    fn eis_seat_new_device(seat: Object) -> Object;
    fn eis_device_configure_name(device: Object, name: *const std::ffi::c_char);
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
    fn eis_event_keyboard_get_key(event: Object) -> u32;
    fn eis_event_keyboard_get_key_is_press(event: Object) -> bool;
    fn eis_event_scroll_get_discrete_dx(event: Object) -> i32;
    fn eis_event_scroll_get_discrete_dy(event: Object) -> i32;
}

#[repr(C)]
struct Poll {
    fd: i32,
    events: i16,
    revents: i16,
}
unsafe extern "C" {
    fn poll(fds: *mut Poll, n: usize, timeout: i32) -> i32;
}

pub struct Peer {
    pub fd: OwnedFd,
    pub keys: mpsc::UnboundedReceiver<(u32, bool)>,
    pub scroll: mpsc::UnboundedReceiver<(i32, i32)>,
}

impl Peer {
    pub fn open(directory: &Path) -> Self {
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
        let path = directory.join("fixture-keymap");
        File::create(&path)
            .unwrap()
            .write_all(map.as_bytes())
            .unwrap();
        let file = File::open(path).unwrap();
        let (ready, rx) = std::sync::mpsc::sync_channel(1);
        let (observed, keys) = mpsc::unbounded_channel();
        let (wheel, scroll) = mpsc::unbounded_channel();
        thread::spawn(move || unsafe {
            // This private libeis backend returns a socketpair. It never binds a socket.
            let ctx = eis_new(ptr::null_mut());
            assert!(!ctx.is_null());
            assert_eq!(eis_setup_backend_fd(ctx), 0);
            let fd = eis_backend_fd_add_client(ctx);
            assert!(fd >= 0);
            ready.send(OwnedFd::from_raw_fd(fd)).unwrap();
            let mut fd = Poll {
                fd: eis_get_fd(ctx),
                events: 1,
                revents: 0,
            };
            let mut connected = true;
            let mut devices: [Object; 2] = [ptr::null_mut(); 2];
            while connected && poll(&mut fd, 1, 10000) > 0 {
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
                            let seat = eis_client_new_seat(client, c"fixture".as_ptr());
                            for cap in [2, 4, 16, 32] {
                                eis_seat_configure_capability(seat, cap);
                            }
                            eis_seat_add(seat);
                            eis_seat_unref(seat);
                        }
                        2 => {
                            connected = false;
                            eis_client_disconnect(eis_event_get_client(event));
                        }
                        3 => {
                            let seat = eis_event_get_seat(event);
                            for (slot, caps) in devices.iter_mut().zip([&[4][..], &[2, 16, 32][..]])
                            {
                                if !slot.is_null()
                                    || !caps
                                        .iter()
                                        .all(|cap| eis_event_seat_has_capability(event, *cap))
                                {
                                    continue;
                                }
                                let device = eis_seat_new_device(seat);
                                eis_device_configure_name(device, c"Fixture input".as_ptr());
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
                                        file.as_raw_fd(),
                                        map.len(),
                                    );
                                    eis_keymap_add(keymap);
                                    eis_keymap_unref(keymap);
                                }
                                eis_device_add(device);
                                eis_device_resume(device);
                                *slot = device;
                            }
                        }
                        4 => {
                            let device = eis_event_get_device(event);
                            if let Some(slot) = devices.iter_mut().find(|x| **x == device) {
                                eis_device_remove(device);
                                *slot = eis_device_unref(device);
                            }
                        }
                        603 => {
                            let _ = wheel.send((
                                eis_event_scroll_get_discrete_dx(event),
                                eis_event_scroll_get_discrete_dy(event),
                            ));
                        }
                        700 => {
                            let _ = observed.send((
                                eis_event_keyboard_get_key(event),
                                eis_event_keyboard_get_key_is_press(event),
                            ));
                        }
                        _ => {}
                    }
                    eis_event_unref(event);
                }
            }
            for device in devices {
                if !device.is_null() {
                    eis_device_remove(device);
                    eis_device_unref(device);
                }
            }
            eis_unref(ctx);
        });
        Self {
            fd: rx.recv().unwrap(),
            keys,
            scroll,
        }
    }
}
