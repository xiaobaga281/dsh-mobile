# The relay has no dependencies and no state worth keeping: one small image.
FROM node:22-alpine

WORKDIR /app

# Only the relay file is needed; the plugin half runs inside the desktop app.
COPY relay/server.mjs ./relay/server.mjs

# Run unprivileged; the relay never touches the filesystem.
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay/server.mjs", "--port", "8787", "--host", "0.0.0.0"]
