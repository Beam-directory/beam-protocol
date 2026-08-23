# syntax=docker/dockerfile:1.7

FROM quay.io/keycloak/keycloak@sha256:f1f1f01e472c8a78df40d8f2a49a925274eda4d3d80d5f6edbb5c880ee3c01c6 AS builder

ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true \
    KC_FEATURES=cimd:v1,resource-indicators:v1

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak@sha256:f1f1f01e472c8a78df40d8f2a49a925274eda4d3d80d5f6edbb5c880ee3c01c6

COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY --chmod=0555 ops/mcp-pilot/keycloak/beam-entrypoint.sh /opt/keycloak/bin/beam-entrypoint.sh

ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true \
    KC_FEATURES=cimd:v1,resource-indicators:v1

USER 1000
ENTRYPOINT ["/opt/keycloak/bin/beam-entrypoint.sh"]
CMD ["start", "--optimized"]
