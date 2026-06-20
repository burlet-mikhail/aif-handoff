#!/bin/sh
# Installs language toolchains used by AI subagents to run tests against the
# user projects mounted at /home/www. The `agent` container is the primary
# executor (planner/implementer/reviewer subagents), and `api` runs fastFix —
# both shell out to project test suites (PHP, Go, Node/Next.js).
#
# Node/Next.js already ships with the node:22-slim base image, so only PHP and
# Go are added here. Versions are overridable via build args:
#   PHP_VERSION (default 8.4) — installed from packages.sury.org (current
#                               releases; Debian's bundled PHP lags behind).
#   GO_VERSION  (default 1.24.4) — fetched from the official go.dev tarball
#                                  (distro Go is far behind upstream).
#
# Relies on the `apt-install` wrapper (copied into the image in the base stage)
# for resilient apt-get installs that clean /var/lib/apt/lists on exit.
set -eu

PHP_VERSION="${PHP_VERSION:-8.4}"
GO_VERSION="${GO_VERSION:-1.24.4}"

# ---- PHP (sury.org repo) + Composer ----
apt-install curl ca-certificates
curl -fsSL https://packages.sury.org/php/apt.gpg -o /usr/share/keyrings/sury-php.gpg
# Derive the Debian codename dynamically so the repo line stays correct if the
# node base image moves between Debian releases (bookworm -> trixie -> ...).
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${VERSION_CODENAME} main" \
    > /etc/apt/sources.list.d/sury-php.list
apt-install \
    "php${PHP_VERSION}-cli" \
    "php${PHP_VERSION}-common" \
    "php${PHP_VERSION}-mbstring" \
    "php${PHP_VERSION}-xml" \
    "php${PHP_VERSION}-curl" \
    "php${PHP_VERSION}-zip" \
    "php${PHP_VERSION}-sqlite3" \
    "php${PHP_VERSION}-bcmath" \
    "php${PHP_VERSION}-intl"

# Composer — project dependency manager; bootstraps phpunit/pest test runners.
curl -fsSL https://getcomposer.org/installer | php -- \
    --install-dir=/usr/local/bin --filename=composer

# ---- Go (official tarball) ----
GO_ARCH="$(dpkg --print-architecture)"  # amd64 / arm64 — matches go.dev naming
curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" -o /tmp/go.tar.gz
rm -rf /usr/local/go
tar -C /usr/local -xzf /tmp/go.tar.gz
rm -f /tmp/go.tar.gz

# Put Go on PATH for login/interactive shells too — subagents may invoke test
# commands through a profile-sourcing shell, which resets PATH from /etc/profile
# and would otherwise drop the image-level ENV PATH addition.
cat > /etc/profile.d/go-toolchain.sh <<'EOF'
export PATH="/usr/local/go/bin:${HOME:-/home/node}/go/bin:$PATH"
EOF
chmod +x /etc/profile.d/go-toolchain.sh

php --version
"/usr/local/go/bin/go" version
