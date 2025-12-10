FROM node:20-bullseye

WORKDIR /app

RUN chown -R node:node /app
USER node

CMD ["sleep", "infinity"]
