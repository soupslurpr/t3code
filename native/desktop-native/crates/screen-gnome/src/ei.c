#include <errno.h>
#include <libei.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_DEVICES 64

struct t3_ei {
    struct ei *context;
    struct ei_seat *seat;
    struct ei_device *devices[MAX_DEVICES];
    uint32_t sequence;
    uint32_t group;
    bool used;
};

struct t3_ei *t3_ei_open(int fd) {
    struct t3_ei *client = calloc(1, sizeof(*client));
    if (!client || !(client->context = ei_new_sender(NULL))) {
        close(fd);
        free(client);
        return NULL;
    }
    ei_configure_name(client->context, "T3 Code");
    if (ei_setup_backend_fd(client->context, fd) != 0) {
        ei_unref(client->context);
        free(client);
        return NULL;
    }
    return client;
}

void t3_ei_close(struct t3_ei *client) {
    for (size_t i = 0; i < MAX_DEVICES; i++) {
        if (client->devices[i]) {
            ei_device_stop_emulating(client->devices[i]);
            ei_device_unref(client->devices[i]);
        }
    }
    ei_seat_unref(client->seat);
    ei_unref(client->context);
    free(client);
}

int t3_ei_fd(struct t3_ei *client) { return ei_get_fd(client->context); }

bool t3_ei_readable(struct t3_ei *client) {
    struct pollfd pfd = { .fd = ei_get_fd(client->context), .events = POLLIN };
    int rc;
    do {
        rc = poll(&pfd, 1, 0);
    } while (rc < 0 && errno == EINTR);
    return rc > 0 && !(pfd.revents & POLLNVAL);
}

static struct ei_device *device_for(struct t3_ei *client, enum ei_device_capability cap) {
    for (size_t i = 0; i < MAX_DEVICES; i++) {
        if (client->devices[i] && ei_device_has_capability(client->devices[i], cap))
            return client->devices[i];
    }
    return NULL;
}

static bool handle(struct t3_ei *client, struct ei_event *event) {
    struct ei_device *device;
    switch (ei_event_get_type(event)) {
    case EI_EVENT_DISCONNECT:
        return false;
    case EI_EVENT_SEAT_ADDED:
        if (!client->seat) {
            client->seat = ei_seat_ref(ei_event_get_seat(event));
            ei_seat_bind_capabilities(client->seat, EI_DEVICE_CAP_KEYBOARD,
                                      EI_DEVICE_CAP_POINTER_ABSOLUTE, EI_DEVICE_CAP_BUTTON,
                                      EI_DEVICE_CAP_SCROLL, NULL);
        }
        break;
    case EI_EVENT_SEAT_REMOVED:
        return ei_event_get_seat(event) != client->seat;
    case EI_EVENT_DEVICE_RESUMED:
        device = ei_event_get_device(event);
        for (size_t i = 0; i < MAX_DEVICES; i++) {
            if (!client->devices[i]) {
                client->devices[i] = ei_device_ref(device);
                ei_device_start_emulating(device, ++client->sequence);
                return true;
            }
        }
        return false;
    case EI_EVENT_DEVICE_PAUSED:
    case EI_EVENT_DEVICE_REMOVED:
        device = ei_event_get_device(event);
        for (size_t i = 0; i < MAX_DEVICES; i++) {
            if (device == client->devices[i]) {
                client->devices[i] = ei_device_unref(device);
                // A key-up must never go to a replacement device.
                return !client->used;
            }
        }
        break;
    case EI_EVENT_KEYBOARD_MODIFIERS:
        client->group = ei_event_keyboard_get_xkb_group(event);
        break;
    default:
        break;
    }
    return true;
}

// -1 disconnected, 0 negotiating, 1 ready.
int t3_ei_dispatch(struct t3_ei *client) {
    ei_dispatch(client->context);
    struct ei_event *event;
    while ((event = ei_get_event(client->context))) {
        bool valid = handle(client, event);
        ei_event_unref(event);
        if (!valid) return -1;
    }
    return device_for(client, EI_DEVICE_CAP_KEYBOARD) &&
           device_for(client, EI_DEVICE_CAP_POINTER_ABSOLUTE) &&
           device_for(client, EI_DEVICE_CAP_BUTTON) && device_for(client, EI_DEVICE_CAP_SCROLL);
}

int t3_ei_keymap(struct t3_ei *client, size_t *size, uint32_t *group, uint32_t *generation) {
    struct ei_device *keyboard = device_for(client, EI_DEVICE_CAP_KEYBOARD);
    struct ei_keymap *map = keyboard ? ei_device_keyboard_get_keymap(keyboard) : NULL;
    if (!map || ei_keymap_get_type(map) != EI_KEYMAP_TYPE_XKB) return -1;
    *size = ei_keymap_get_size(map);
    *group = client->group;
    *generation = client->sequence;
    return ei_keymap_get_fd(map);
}

static bool frame(struct t3_ei *client, struct ei_device *device) {
    client->used = true;
    ei_device_frame(device, ei_now(client->context));
    return true;
}

bool t3_ei_key(struct t3_ei *client, uint32_t key, bool down) {
    struct ei_device *device = device_for(client, EI_DEVICE_CAP_KEYBOARD);
    if (!device) return false;
    ei_device_keyboard_key(device, key, down);
    return frame(client, device);
}

bool t3_ei_button(struct t3_ei *client, uint32_t button, bool down) {
    struct ei_device *device = device_for(client, EI_DEVICE_CAP_BUTTON);
    if (!device) return false;
    ei_device_button_button(device, button, down);
    return frame(client, device);
}

bool t3_ei_scroll(struct t3_ei *client, int32_t x, int32_t y) {
    struct ei_device *device = device_for(client, EI_DEVICE_CAP_SCROLL);
    if (!device) return false;
    ei_device_scroll_discrete(device, x * 120, y * 120);
    return frame(client, device);
}

bool t3_ei_motion(struct t3_ei *client, const char *mapping, double u, double v,
                  double desktop_x, double desktop_y) {
    for (size_t i = 0; i < MAX_DEVICES; i++) {
        struct ei_device *device = client->devices[i];
        if (!device || !ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE)) continue;
        for (size_t j = 0;; j++) {
            struct ei_region *region = ei_device_get_region(device, j);
            if (!region) break;
            double x = desktop_x, y = desktop_y;
            if (mapping) {
                const char *id = ei_region_get_mapping_id(region);
                if (!id || strcmp(id, mapping)) continue;
                x = ei_region_get_x(region) + u * ei_region_get_width(region);
                y = ei_region_get_y(region) + v * ei_region_get_height(region);
            }
            if (ei_region_contains(region, x, y)) {
                ei_device_pointer_motion_absolute(device, x, y);
                return frame(client, device);
            }
        }
    }
    return false;
}
