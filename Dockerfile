# Use the official Puppeteer image (Comes with Chrome pre-installed)
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install dependencies
USER root

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (Express, Google APIs)
# Note: We use 'npm ci' for a cleaner install and skip puppeteer download since it's in the base image
RUN npm install

# Copy source code
COPY . .

# --- IMPORTANT: WE REMOVED THE ENV LINE HERE ---
# The base image already sets PUPPETEER_EXECUTABLE_PATH correctly.
# Do not overwrite it.

# Switch back to the secure user
USER pptruser

# Start the server
CMD ["node", "server.js"]
