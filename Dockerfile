FROM node:18-slim

# Install Xvfb for virtual display + Chrome and dependencies
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    xvfb \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY . .

# Create non-root user WITH proper home directory
RUN groupadd -r pptruser && \
    useradd -r -g pptruser -G audio,video pptruser \
    -d /home/pptruser \
    --create-home && \
    mkdir -p /home/pptruser/Downloads /home/pptruser/.cache /home/pptruser/.local/share && \
    chown -R pptruser:pptruser /home/pptruser && \
    chown -R pptruser:pptruser /usr/src/app

USER pptruser

# Start Xvfb (virtual display) before running node
CMD Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & \
    sleep 2 && \
    node server.js
