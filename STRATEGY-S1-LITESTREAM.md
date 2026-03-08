# S1: Litestream — SQLite Streaming Replication

## Problem
Eine SQLite-Datei auf einem Fly.io Volume = Single Point of Failure.
Disk-Corruption, VM-Tod, Bad Deploy → gesamtes Beam Netzwerk offline.

## Lösung: Litestream → S3
Litestream repliziert SQLite-WAL-Changes in Echtzeit zu S3-kompatiblem Object Storage.

### Setup
1. **Object Storage:** Hetzner Object Storage (€5/mo für 1TB, S3-kompatibel, EU)
2. **Litestream** in Dockerfile installieren
3. **Startup:** `litestream restore` (falls DB nicht existiert) → `litestream replicate` als Wrapper um Node.js

### Dockerfile Changes
```dockerfile
# Add Litestream
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin/ && rm /tmp/litestream.tar.gz

COPY litestream.yml /etc/litestream.yml
CMD ["litestream", "replicate", "-exec", "node dist/index.js"]
```

### litestream.yml
```yaml
dbs:
  - path: /data/beam-directory.db
    replicas:
      - type: s3
        bucket: beam-protocol-backup
        path: beam-directory
        endpoint: https://fsn1.your-objectstorage.com
        region: fsn1
        retention: 72h
        sync-interval: 10s
```

### Fly.io Secrets
```
LITESTREAM_ACCESS_KEY_ID=<hetzner-key>
LITESTREAM_SECRET_ACCESS_KEY=<hetzner-secret>
```

### Recovery
```bash
# Restore from S3
litestream restore -o /data/beam-directory.db \
  -replica s3://beam-protocol-backup/beam-directory
```

### RPO/RTO
- **RPO (Recovery Point Objective):** ~10 Sekunden (sync-interval)
- **RTO (Recovery Time Objective):** ~30 Sekunden (restore + restart)

## Timeline: Diese Woche
## Kosten: €5/Monat
## Impact: Von "SPOF → Daten weg" zu "30s Downtime, 0 Datenverlust"
