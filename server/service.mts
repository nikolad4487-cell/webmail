// @ts-check
// Runtime declaration of the webmail service, compiled with the server into
// dist/service.mjs: server code reads its database and port through it
// (service.load() / service.port()). Keep it in sync with the deploy-time
// declaration `service.mjs` at the repository root, which module.mjs
// provisions; this copy only rides along in the build output, so its build
// adapter is never consulted.
import node from "@prisma/composer/node";
import { compute, rawPostgres } from "@prisma/composer-prisma-cloud";

export default compute({
  name: "webmail",
  deps: { db: rawPostgres() },
  build: node({ module: import.meta.url, entry: "../dist/index.js", dependencies: "external" }),
});
