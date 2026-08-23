# syntax=docker/dockerfile:1.7

FROM docker.io/library/postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73

COPY --chmod=0555 ops/mcp-pilot/postgres/beam-entrypoint.sh /usr/local/bin/beam-entrypoint.sh

RUN apk add --no-cache su-exec=0.3-r0 \
  && sed -i 's/exec gosu postgres/exec su-exec postgres:postgres/' /usr/local/bin/docker-entrypoint.sh \
  && rm -f /usr/local/bin/gosu

USER root
ENTRYPOINT ["/usr/local/bin/beam-entrypoint.sh"]
CMD ["postgres"]
