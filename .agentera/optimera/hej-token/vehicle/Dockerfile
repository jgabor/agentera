# Hermetic vehicle for optimera token-consumption measurements.
#
# Build context is assembled at runtime by the harness script. The host's
# claude CLI binary (/opt/claude-code/bin/claude) is copied into the context
# under the name `claude`; the source files below are also copied in.
#
# The image is deliberately minimal: one claude binary, python3 for the
# PostToolUse hook, git for hej's `git log` reads, ca-certificates for HTTPS
# to api.anthropic.com. Nothing else.

FROM debian:stable-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude CLI (copied from host at harness runtime).
COPY claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

# In-container benchmark assets.
RUN mkdir -p /opt/bench
COPY settings.json /opt/bench/settings.json
COPY log_reads.py /opt/bench/log_reads.py
RUN chmod +x /opt/bench/log_reads.py

COPY entrypoint.sh /opt/bench/entrypoint.sh
RUN chmod +x /opt/bench/entrypoint.sh

# Non-root user: claude CLI rejects --dangerously-skip-permissions when
# running as root. uid/gid 1000 matches the typical single-user Linux host
# so bind-mounted credentials, workspace, and /output paths read/write
# cleanly across the container boundary.
RUN groupadd --gid 1000 claude && \
    useradd  --uid 1000 --gid 1000 --create-home --shell /bin/bash claude

USER claude
ENV HOME=/home/claude

WORKDIR /workspace
ENTRYPOINT ["/opt/bench/entrypoint.sh"]
