// Per-engine database/cache dashboards. Each panel is a curated PromQL query against the
// exporter metrics the DB agent forwards (every sample carries db_instance). `q(sel)` takes a
// label selector fragment like `db_instance="core"`. Metric names follow the common exporters
// (postgres_exporter, mysqld_exporter, redis_exporter, ...); a few engines vary by exporter config.
export type PanelKind = 'stat' | 'ts';
export interface Panel { title: string; kind: PanelKind; unit?: string; q: (sel: string) => string }

export function selector(instance: string): string { return `db_instance="${instance}"`; }

const ratio = (hit: string, miss: string, sel: string) =>
  `100 * sum(rate(${hit}{${sel}}[5m])) / clamp_min(sum(rate(${hit}{${sel}}[5m])) + sum(rate(${miss}{${sel}}[5m])), 1)`;

export const DB_DASHBOARDS: Record<string, Panel[]> = {
  postgres: [
    { title: 'Up', kind: 'stat', q: (s) => `max(pg_up{${s}})` },
    { title: 'Connections', kind: 'stat', q: (s) => `sum(pg_stat_activity_count{${s}})` },
    { title: 'Database size', kind: 'stat', unit: 'bytes', q: (s) => `sum(pg_database_size_bytes{${s}})` },
    { title: 'Commits / s', kind: 'ts', q: (s) => `sum(rate(pg_stat_database_xact_commit{${s}}[5m]))` },
    { title: 'Rollbacks / s', kind: 'ts', q: (s) => `sum(rate(pg_stat_database_xact_rollback{${s}}[5m]))` },
    { title: 'Cache hit ratio %', kind: 'ts', unit: 'percent', q: (s) => `100 * sum(pg_stat_database_blks_hit{${s}}) / clamp_min(sum(pg_stat_database_blks_hit{${s}}) + sum(pg_stat_database_blks_read{${s}}), 1)` },
    { title: 'Tuples fetched / s', kind: 'ts', q: (s) => `sum(rate(pg_stat_database_tup_fetched{${s}}[5m]))` },
    { title: 'Tuples written / s', kind: 'ts', q: (s) => `sum(rate(pg_stat_database_tup_inserted{${s}}[5m])) + sum(rate(pg_stat_database_tup_updated{${s}}[5m])) + sum(rate(pg_stat_database_tup_deleted{${s}}[5m]))` },
    { title: 'Deadlocks / s', kind: 'ts', q: (s) => `sum(rate(pg_stat_database_deadlocks{${s}}[5m]))` },
    { title: 'Replication lag (s)', kind: 'ts', unit: 's', q: (s) => `max(pg_replication_lag{${s}})` },
  ],
  mysql: [
    { title: 'Up', kind: 'stat', q: (s) => `max(mysql_up{${s}})` },
    { title: 'Threads connected', kind: 'stat', q: (s) => `max(mysql_global_status_threads_connected{${s}})` },
    { title: 'Queries / s', kind: 'ts', q: (s) => `rate(mysql_global_status_queries{${s}}[5m])` },
    { title: 'Slow queries / s', kind: 'ts', q: (s) => `rate(mysql_global_status_slow_queries{${s}}[5m])` },
    { title: 'Connections / s', kind: 'ts', q: (s) => `rate(mysql_global_status_connections{${s}}[5m])` },
    { title: 'Aborted connects / s', kind: 'ts', q: (s) => `rate(mysql_global_status_aborted_connects{${s}}[5m])` },
    { title: 'InnoDB buffer hit %', kind: 'ts', unit: 'percent', q: (s) => `100 * (1 - rate(mysql_global_status_innodb_buffer_pool_reads{${s}}[5m]) / clamp_min(rate(mysql_global_status_innodb_buffer_pool_read_requests{${s}}[5m]), 1))` },
    { title: 'Bytes received / s', kind: 'ts', unit: 'bytes', q: (s) => `rate(mysql_global_status_bytes_received{${s}}[5m])` },
    { title: 'Bytes sent / s', kind: 'ts', unit: 'bytes', q: (s) => `rate(mysql_global_status_bytes_sent{${s}}[5m])` },
    { title: 'Replication lag (s)', kind: 'ts', unit: 's', q: (s) => `max(mysql_slave_status_seconds_behind_master{${s}})` },
  ],
  redis: [
    { title: 'Up', kind: 'stat', q: (s) => `max(redis_up{${s}})` },
    { title: 'Connected clients', kind: 'stat', q: (s) => `max(redis_connected_clients{${s}})` },
    { title: 'Used memory', kind: 'ts', unit: 'bytes', q: (s) => `max(redis_memory_used_bytes{${s}})` },
    { title: 'Max memory', kind: 'stat', unit: 'bytes', q: (s) => `max(redis_memory_max_bytes{${s}})` },
    { title: 'Commands / s', kind: 'ts', q: (s) => `rate(redis_commands_processed_total{${s}}[5m])` },
    { title: 'Keyspace hit rate %', kind: 'ts', unit: 'percent', q: (s) => ratio('redis_keyspace_hits_total', 'redis_keyspace_misses_total', s) },
    { title: 'Evicted keys / s', kind: 'ts', q: (s) => `rate(redis_evicted_keys_total{${s}}[5m])` },
    { title: 'Blocked clients', kind: 'ts', q: (s) => `max(redis_blocked_clients{${s}})` },
    { title: 'Keys', kind: 'stat', q: (s) => `sum(redis_db_keys{${s}})` },
    { title: 'Network in / s', kind: 'ts', unit: 'bytes', q: (s) => `rate(redis_net_input_bytes_total{${s}}[5m])` },
  ],
  mssql: [
    { title: 'Up', kind: 'stat', q: (s) => `max(mssql_up{${s}})` },
    { title: 'Connections', kind: 'stat', q: (s) => `max(mssql_connections{${s}})` },
    { title: 'Batch requests / s', kind: 'ts', q: (s) => `rate(mssql_batch_requests{${s}}[5m])` },
    { title: 'Transactions / s', kind: 'ts', q: (s) => `rate(mssql_transactions{${s}}[5m])` },
    { title: 'Page life expectancy (s)', kind: 'ts', unit: 's', q: (s) => `max(mssql_page_life_expectancy{${s}})` },
    { title: 'Deadlocks / s', kind: 'ts', q: (s) => `rate(mssql_deadlocks{${s}}[5m])` },
  ],
  oracle: [
    { title: 'Up', kind: 'stat', q: (s) => `max(oracledb_up{${s}})` },
    { title: 'Sessions', kind: 'stat', q: (s) => `sum(oracledb_sessions_value{${s}})` },
    { title: 'Executions / s', kind: 'ts', q: (s) => `rate(oracledb_activity_execute_count{${s}}[5m])` },
    { title: 'User commits / s', kind: 'ts', q: (s) => `rate(oracledb_activity_user_commits{${s}}[5m])` },
    { title: 'Wait time', kind: 'ts', q: (s) => `max(oracledb_wait_time_value{${s}})` },
  ],
  kafka: [
    { title: 'Brokers', kind: 'stat', q: (s) => `max(kafka_brokers{${s}})` },
    { title: 'Consumer group lag', kind: 'ts', q: (s) => `sum(kafka_consumergroup_lag{${s}})` },
    { title: 'Under-replicated partitions', kind: 'stat', q: (s) => `sum(kafka_topic_partition_under_replicated_partition{${s}})` },
    { title: 'Messages in / s', kind: 'ts', q: (s) => `sum(rate(kafka_topic_partition_current_offset{${s}}[5m]))` },
  ],
  mongodb: [
    { title: 'Up', kind: 'stat', q: (s) => `max(mongodb_up{${s}})` },
    { title: 'Connections', kind: 'stat', q: (s) => `max(mongodb_connections{${s}})` },
    { title: 'Operations / s', kind: 'ts', q: (s) => `sum(rate(mongodb_op_counters_total{${s}}[5m]))` },
  ],
  memcached: [
    { title: 'Up', kind: 'stat', q: (s) => `max(memcached_up{${s}})` },
    { title: 'Current connections', kind: 'stat', q: (s) => `max(memcached_current_connections{${s}})` },
    { title: 'Bytes used', kind: 'stat', unit: 'bytes', q: (s) => `max(memcached_current_bytes{${s}})` },
    { title: 'Evictions / s', kind: 'ts', q: (s) => `rate(memcached_items_evicted_total{${s}}[5m])` },
  ],
};

export function dashboardFor(engine: string): Panel[] { return DB_DASHBOARDS[engine] ?? []; }
