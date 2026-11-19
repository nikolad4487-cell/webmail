// @ts-check
import { module } from "@prisma/composer";
import webmailService from "./service.mjs";

export default module("webmail", ({ provision }) => {
  provision(webmailService);
});
