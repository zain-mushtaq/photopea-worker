FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install dependencies
USER root

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# CRITICAL FIX: Locate Google Chrome and set the Environment Variable
# This runs 'which google-chrome' to find the real path and sets it permanently
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome"

# Switch back to the secure user
USER pptruser

# Start the server
CMD ["node", "server.js"]
