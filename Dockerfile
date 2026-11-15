FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.24-alpine AS api
WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /labturn .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=api /labturn /app/labturn
COPY --from=web /app/web/dist /app/web
USER app
ENV WEB_DIST=/app/web LISTEN_ADDR=:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --start-interval=1s --retries=3 CMD wget -q -O /dev/null http://localhost:8080/api/health
CMD ["/app/labturn"]
