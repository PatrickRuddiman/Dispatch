FROM node:20-slim

# Install system dependencies required by Dispatch
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# Install opencode globally from npm
RUN npm install -g opencode-ai

# Set a minimal git identity so Dispatch can make commits inside the container
RUN git config --global user.name "Dispatch E2E" && \
    git config --global user.email "e2e@dispatch.local"

# Copy the Dispatch source into the image and build it
WORKDIR /dispatch
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/

RUN npm run build

# Link the local build so `dispatch` is on PATH
RUN npm link

# Copy e2e scripts
COPY e2e/ ./e2e/
RUN chmod +x ./e2e/run-e2e.sh

# Verify both binaries are available
RUN dispatch --version && opencode --version

WORKDIR /workspace
