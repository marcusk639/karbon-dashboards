import { defineRailway, image, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const postgresData = volume("postgres-data", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 50000 });
  const karbonApi = service("karbon-api", {
    build: "npm ci && npm run build",
    start: "npm run start:api",
    healthcheck: "/health",
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { drainingSeconds: 90 },
    networking: { privateNetworkEndpoint: "karbon-dashboards" },
    env: {
      DATABASE_CA_CERT: preserve(),
      DATABASE_URL: preserve(),
      INTERNAL_API_TOKEN: preserve(),
      ALERT_WEBHOOK_URL: preserve(),
      HEARTBEAT_URL: preserve(),
      PORT: "8080",
      DATA_MODE: "synthetic",
      ALLOW_SYNTHETIC_SCHEDULES: "1",
    },
  });
  const karbonMcp = service("karbon-mcp", {
    build: "npm ci && npm run build",
    start: "npm run start:mcp",
    healthcheck: "/health",
    replicas: { "us-east4-eqdc4a": 1 },
    env: {
      MCP_BEARER_TOKEN: preserve(),
      INTERNAL_API_TOKEN: preserve(),
      CORE_API_URL: `http://${karbonApi.env.RAILWAY_PRIVATE_DOMAIN}:${karbonApi.env.PORT}`,
      TRUST_PROXY_HOPS: "1",
    },
  });
  const postgres = service("postgres", {
    source: image("ghcr.io/railwayapp-templates/postgres-ssl:17"),
    replicas: { "us-east4-eqdc4a": 1 },
    volumeMounts: { "/var/lib/postgresql/data": postgresData },
    env: { PGDATA: preserve(), POSTGRES_DB: preserve(), POSTGRES_PASSWORD: preserve(), POSTGRES_USER: preserve() },
  });

  return project("karbon-dashboards", {
    variables: { managed: true },
    resources: [karbonApi, karbonMcp, postgres, postgresData],
  });
});
