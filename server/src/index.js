import { createApp } from "./app.js";

process.umask(0o077);
const app = await createApp({ logger: true });
const { config } = app.context;
await app.listen({ host: config.HOST, port: config.PORT });
process.send?.({ port: app.server.address().port });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await app.close(); });
