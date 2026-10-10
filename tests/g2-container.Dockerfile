FROM node:24.15.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap curl ca-certificates && rm -rf /var/lib/apt/lists/* && useradd -m friend
USER friend
WORKDIR /home/friend
