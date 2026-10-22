# syntax=docker/dockerfile:1
# The context is a git archive, never a live Sub2API working directory.
FROM golang:1.27.2-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOMAXPROCS=2 GOMEMLIMIT=768MiB
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
ARG SOURCE_COMMIT
RUN go build -p 1 -trimpath -ldflags="-s -w -X main.Commit=${SOURCE_COMMIT} -X main.BuildType=sentinel-integration" -o /out/sub2api ./cmd/server

FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -g 10001 api && adduser -D -u 10001 -G api api
WORKDIR /app
COPY --from=build /out/sub2api ./sub2api
COPY --from=build /src/resources ./resources
USER 10001:10001
ENTRYPOINT ["/app/sub2api"]
