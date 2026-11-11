# Cold-install harness (release story 12): a clean machine image with only
# Pi and the package under test. Nothing from the host is mounted into
# $HOME, the user is non-root, and credentials arrive only as environment
# variables at run time.
FROM node:22-bookworm-slim

# git for Pi's package handling, ripgrep for Pi's search tools, curl for the
# offline-mode network probe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pin the Pi version: a Pi change must not break the release gate silently
# (bump deliberately with the release).
ARG PI_VERSION=1.5.0
USER node
ENV PATH="/home/node/.npm-global/bin:${PATH}"
RUN npm config set prefix /home/node/.npm-global \
 && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

COPY entrypoint-e2e.mjs /opt/entrypoint-e2e.mjs

# compose mounts ../artifacts at /home/node/work/artifacts; create the
# parent here as the node user, otherwise the daemon creates it root-owned
# at run time and the entrypoint cannot write into it.
# compose mounts docker/models.json at /home/node/.pi/agent/models.json; the
# agent dir must exist as the node user for the same reason.
RUN mkdir -p /home/node/work /home/node/.pi/agent

# The cold context: exactly one extension installed at run time; assert the
# count against this number.
ENV E2E_EXPECTED_EXTENSIONS=1

ENTRYPOINT ["node", "/opt/entrypoint-e2e.mjs"]
