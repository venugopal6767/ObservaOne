# ObservaOne DEMO DATA generator (test data only). promtool comes from the same Prometheus image the
# stack uses; it turns the generated history into Prometheus data blocks.
FROM prom/prometheus:v3.15.0 AS prom

FROM node:22-alpine
COPY --from=prom /bin/promtool /usr/local/bin/promtool
WORKDIR /app
COPY generator/ ./
ENTRYPOINT ["node", "/app/gen.mjs"]
CMD ["serve"]
