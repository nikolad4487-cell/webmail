// @ts-check
import { module } from "@prisma/composer";
import { rawPostgres } from "@prisma/composer-prisma-cloud";
import webmailService from "./service.mjs";

export default module("webmail", ({ provision }) => {
  const db = provision(rawPostgres({ name: "db" }), { id: "db" });
  provision(webmailService, { deps: { db } });
});
