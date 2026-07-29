FROM debian:stable-slim AS builder

RUN apt-get update \
  && apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  libssl-dev \
  pkg-config \
  xz-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV MISE_DATA_DIR=/mise
ENV MISE_CONFIG_DIR=/mise
ENV MISE_CACHE_DIR=/mise/cache
ENV MISE_INSTALL_PATH=/usr/local/bin/mise
ENV PATH=/mise/shims:$PATH

RUN curl https://mise.run | sh

WORKDIR /app
COPY . .

RUN mise trust mise.toml && mise install
RUN pnpm install --frozen-lockfile
RUN pnpm build:production

FROM debian:stable-slim

RUN apt-get update \
  && apt-get install -y ca-certificates --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/agent-witness /var/lib/agent-witness

COPY --from=builder /app/target/release/agent-witness /usr/local/bin/

EXPOSE 9345

ENTRYPOINT ["agent-witness", "--config", "/etc/agent-witness.toml"]
CMD ["serve"]
