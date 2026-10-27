# One image for the API and the worker; the command selects the process.
#   api:    docker run IMAGE            (npm start)
#   worker: docker run IMAGE npm run start:worker
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY workers ./workers
COPY migrations ./migrations
COPY contracts ./contracts
USER node
EXPOSE 3000
CMD ["npm", "start"]
