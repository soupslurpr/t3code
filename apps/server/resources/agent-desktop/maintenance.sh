#!/usr/bin/bash
set -euo pipefail

profile_version=${1:?missing Agent desktop profile version}
if [[ ! $profile_version =~ ^[a-z0-9.-]{1,128}$ ]]; then
  echo "invalid Agent desktop profile version" >&2
  exit 2
fi

/usr/bin/pacman -Syu --needed --noconfirm \
  at-spi2-core \
  base-devel \
  chromium \
  curl \
  git \
  gjs \
  gdm \
  gnome-backgrounds \
  gnome-calculator \
  gnome-console \
  gnome-control-center \
  gnome-session \
  gnome-settings-daemon \
  gnome-shell \
  gnome-text-editor \
  gst-plugin-pipewire \
  gst-plugins-base-libs \
  gst-plugins-good \
  gstreamer \
  ibus \
  jq \
  mesa \
  mesa-utils \
  nautilus \
  networkmanager \
  nodejs \
  noto-fonts \
  noto-fonts-emoji \
  npm \
  pipewire \
  python \
  qemu-guest-agent \
  ripgrep \
  sudo \
  wireplumber \
  xdg-desktop-portal-gnome \
  xdg-user-dirs \
  xorg-xwayland

/usr/bin/install -d /etc/dconf/profile /etc/dconf/db/local.d
/usr/bin/tee /etc/dconf/profile/user >/dev/null <<'EOF'
user-db:user
system-db:local
EOF
/usr/bin/tee /etc/dconf/db/local.d/00-t3-agent-desktop >/dev/null <<'EOF'
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/interface]
toolkit-accessibility=true

[org/gnome/desktop/screensaver]
lock-enabled=false

[org/gnome/settings-daemon/plugins/power]
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'
EOF
/usr/bin/dconf update

/usr/bin/systemctl enable gdm.service NetworkManager.service qemu-guest-agent.service
/usr/bin/systemctl set-default graphical.target
/usr/bin/systemctl disable --now sshd.service >/dev/null 2>&1 || true
/usr/bin/systemctl mask sshd.service sshd.socket >/dev/null 2>&1 || true
/usr/bin/rm -rf /root/.ssh /home/t3agent/.ssh
/usr/bin/rm -f /etc/ssh/ssh_host_*
/usr/bin/printf '%s\n' "$profile_version" >/etc/t3-agent-desktop-profile
/usr/bin/sync
