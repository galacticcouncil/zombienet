# Stage 1: Build zombienet binary from source
FROM node:18-bookworm AS builder

WORKDIR /build

# Copy javascript source and install dependencies
COPY javascript/ javascript/

WORKDIR /build/javascript
RUN npm install
RUN npm run build
RUN npm run package:linux:x64

# Verify the binary was created
RUN ls -la /build/javascript/bins/zombienet-linux-x64 && \
    chmod +x /build/javascript/bins/zombienet-linux-x64

# Stage 2: Runtime
FROM node:18-bookworm

RUN apt-get update && apt-get install -y \
    curl \
    wget \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy zombienet binary built from source
COPY --from=builder /build/javascript/bins/zombienet-linux-x64 /usr/local/bin/zombienet
RUN chmod +x /usr/local/bin/zombienet
RUN zombienet version

# Download polkadot-sdk binaries (pinned version)
ARG POLKADOT_SDK_RELEASE=polkadot-stable2512-1
RUN mkdir -p /zombienet/polkadot-sdk/target/release
RUN for binary in polkadot polkadot-execute-worker polkadot-prepare-worker; do \
    wget -q https://github.com/paritytech/polkadot-sdk/releases/download/${POLKADOT_SDK_RELEASE}/$binary \
        -O /zombienet/polkadot-sdk/target/release/$binary \
    && chmod +x /zombienet/polkadot-sdk/target/release/$binary \
    && /zombienet/polkadot-sdk/target/release/$binary --version; \
    done

# Download hydradx and scraper binaries (pinned version)
ARG HYDRATION_BIN_URL=https://github.com/galacticcouncil/hydration-node/releases/download/v43.0.2

RUN mkdir -p /zombienet/hydration-node/target/release
RUN wget -q $HYDRATION_BIN_URL/hydradx -O /zombienet/hydration-node/target/release/hydradx && \
    wget -q $HYDRATION_BIN_URL/scraper -O /zombienet/hydration-node/target/release/scraper && \
    chmod +x /zombienet/hydration-node/target/release/*
RUN /zombienet/hydration-node/target/release/hydradx --version

WORKDIR /zombienet/hydration-node/launch-configs/fork

# Copy fork contents
COPY fork/ .

# Overwrite config.json and package.json with Docker-specific versions
COPY fork/config.docker.json config.json
COPY fork/package.docker.json package.json

RUN chmod +x get-state.sh
RUN npm install

EXPOSE 9999 9989 9944

VOLUME /zombienet/hydration-node/launch-configs/fork/data

CMD ["npm", "start"]
