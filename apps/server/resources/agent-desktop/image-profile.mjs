export const PROVISIONED_MARKER = "T3 Agent desktop image provisioned";
export const AGENT_DESKTOP_PROFILE_VERSION = "arch-gnome-v1";

export const cloudConfig = `#cloud-config
hostname: t3-agent-desktop
manage_etc_hosts: true
timezone: Etc/UTC
locale: en_US.UTF-8
disable_root: true
ssh_pwauth: false
users:
  - name: t3agent
    gecos: T3 Agent
    groups: [wheel]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
package_update: true
package_upgrade: true
packages:
  - at-spi2-core
  - base-devel
  - chromium
  - curl
  - git
  - gjs
  - gdm
  - gnome-backgrounds
  - gnome-calculator
  - gnome-console
  - gnome-control-center
  - gnome-session
  - gnome-settings-daemon
  - gnome-shell
  - gnome-text-editor
  - gst-plugin-pipewire
  - gst-plugins-base-libs
  - gst-plugins-good
  - gstreamer
  - ibus
  - jq
  - mesa
  - nautilus
  - networkmanager
  - nodejs
  - noto-fonts
  - noto-fonts-emoji
  - npm
  - pipewire
  - python
  - qemu-guest-agent
  - ripgrep
  - mesa-utils
  - sudo
  - wireplumber
  - xdg-desktop-portal-gnome
  - xdg-user-dirs
  - xorg-xwayland
write_files:
  - path: /etc/t3-agent-desktop-profile
    permissions: "0644"
    content: |
      ${AGENT_DESKTOP_PROFILE_VERSION}
  - path: /etc/gdm/custom.conf
    permissions: "0644"
    defer: true
    content: |
      [daemon]
      AutomaticLoginEnable=True
      AutomaticLogin=t3agent

      [security]

      [xdmcp]

      [chooser]

      [debug]
  - path: /etc/dconf/profile/user
    permissions: "0644"
    content: |
      user-db:user
      system-db:local
  - path: /etc/dconf/db/local.d/00-t3-agent-desktop
    permissions: "0644"
    content: |
      [org/gnome/desktop/session]
      idle-delay=uint32 0

      [org/gnome/desktop/interface]
      toolkit-accessibility=true

      [org/gnome/desktop/screensaver]
      lock-enabled=false

      [org/gnome/settings-daemon/plugins/power]
      sleep-inactive-ac-type='nothing'
      sleep-inactive-battery-type='nothing'
  - path: /etc/t3-agent-desktop-user
    permissions: "0644"
    content: |
      t3agent
  - path: /var/lib/AccountsService/users/t3agent
    permissions: "0600"
    content: |
      [User]
      Language=en_US.UTF-8
      XSession=gnome
      SystemAccount=false
runcmd:
  - [dconf, update]
  - [install, -d, -o, t3agent, -g, t3agent, /home/t3agent/.config]
  - [touch, /home/t3agent/.config/gnome-initial-setup-done]
  - [chown, -R, t3agent:t3agent, /home/t3agent/.config]
  - [systemctl, enable, gdm.service]
  - [systemctl, enable, NetworkManager.service]
  - [systemctl, enable, qemu-guest-agent.service]
  - [systemctl, set-default, graphical.target]
  - [systemctl, disable, --now, sshd.service]
  - [systemctl, mask, sshd.service, sshd.socket]
  - [rm, -rf, /root/.ssh, /home/t3agent/.ssh]
  - [sh, -c, "rm -f /etc/ssh/ssh_host_* /var/lib/systemd/random-seed"]
  - [sh, -c, "rm -rf /var/cache/pacman/pkg/* /var/log/journal/*"]
  - [touch, /etc/cloud/cloud-init.disabled]
  - [sh, -c, ": > /etc/machine-id"]
  - [sync]
power_state:
  mode: poweroff
  message: Powering off the provisioned Agent desktop image
  timeout: 120
  condition: true
final_message: ${PROVISIONED_MARKER}
`;
