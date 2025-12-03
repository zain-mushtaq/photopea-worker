# Use the official Puppeteer image (comes with Chrome pre-installed!)
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root user to install your other libraries
USER root

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install Express, Google Drive API, etc.
RUN npm install

# Copy your server code
COPY . .

# Switch back to the secure user
USER pptruser

# Start the server
CMD ["node", "server.js"]
