# syntax=docker/dockerfile:1.7

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS privilege-helper

RUN apk add --no-cache su-exec=0.3-r0

FROM quay.io/keycloak/keycloak@sha256:f1f1f01e472c8a78df40d8f2a49a925274eda4d3d80d5f6edbb5c880ee3c01c6 AS builder

ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true \
    KC_FEATURES=cimd:v1,resource-indicators:v1

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak@sha256:f1f1f01e472c8a78df40d8f2a49a925274eda4d3d80d5f6edbb5c880ee3c01c6

COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY --from=privilege-helper /sbin/su-exec /opt/beam/bin/su-exec
COPY --from=privilege-helper /lib/ld-musl-*.so.1 /lib/
COPY --chmod=0555 ops/mcp-pilot/keycloak/beam-entrypoint.sh /opt/keycloak/bin/beam-entrypoint.sh

ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true \
    KC_FEATURES=cimd:v1,resource-indicators:v1

USER root
ENTRYPOINT ["/opt/keycloak/bin/beam-entrypoint.sh"]
CMD ["start", "--optimized"]
