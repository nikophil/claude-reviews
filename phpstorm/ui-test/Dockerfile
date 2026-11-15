# Gradle and a JDK for the UI tests, Node for the claude-reviews server they start, and what PhpStorm needs to draw on Xvfb.
FROM gradle:9.9.1-jdk25
COPY --from=node:25-trixie-slim /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth git zip curl libatomic1 fontconfig fonts-dejavu-core \
        libxext6 libxrender1 libxtst6 libxi6 libxrandr2 libfreetype6 libgl1 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*
# The named volume takes this directory on its first use: any user of the host writes there.
RUN mkdir -m 1777 /cache
ENV HOME=/cache/home GRADLE_USER_HOME=/cache/gradle
