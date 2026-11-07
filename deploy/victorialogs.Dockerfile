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

# Pinned by digest: this is an always-on box, and a rebuild that silently pulls
# a new log store is not a thing to find out about later. Dependabot proposes
# bumps (see .github/dependabot.yml); merge them deliberately.
FROM busybox:1.37-uclibc@sha256:7aa3d3c53cc1ed823c6a5967ebaac87700a5b0766af45ff599dbca3506c8b072 AS probe

FROM victoriametrics/victoria-logs:v1.53.0@sha256:251121fa882af99b95ba0c230a4a2f412ea602d2698c64a96c58dc9842bb755d
COPY --from=probe /bin/busybox /bin/busybox
