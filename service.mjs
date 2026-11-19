// @ts-check
// Deploy-time declaration of the webmail service: module.mjs provisions it.
// The runtime copy the server imports is `server/service.mts`; keep the two
// in sync.
import node from "@prisma/composer/node";
import { compute, rawPostgres } from "@prisma/composer-prisma-cloud";

export default compute({
  name: "webmail",
  deps: { db: rawPostgres() },
  build: node({ module: import.meta.url, dir: "dist", entry: "index.js", dependencies: "external" }),
});
