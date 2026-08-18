FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node server.mjs /app/server.mjs
COPY --chown=node:node site/ /app/site/
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV PORTAL_DATA_DIR=/app/data

USER node
EXPOSE 8080

CMD ["node", "/app/server.mjs"]
