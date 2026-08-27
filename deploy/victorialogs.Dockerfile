# syntax=docker/dockerfile:1.7
#
# VictoriaLogs, plus the one thing it is missing: a way to check itself.
#
# The upstream image is `scratch` — the server binary and nothing else, no
# shell, no wget, no curl. That is the right way to ship a server and it makes
# a Docker healthcheck impossible, because a healthcheck is a command run
# *inside* the container.
#
# So one statically linked busybox (about 1 MB, uclibc, no loader needed) goes
# in beside it, purely so `busybox wget` can ask /health. Nothing else changes:
# same pinned upstream image, same entrypoint, same flags from compose.
#
#   docker build -f deploy/victorialogs.Dockerfile -t solenoid-victorialogs:local .

ARG VICTORIALOGS_VERSION=v1.52.0

FROM busybox:1.37-uclibc AS probe

FROM victoriametrics/victoria-logs:${VICTORIALOGS_VERSION}
COPY --from=probe /bin/busybox /bin/busybox
