#!/usr/bin/env node

import process from "node:process";

const args = process.argv.slice(2);

if (args[0] !== "mcp") {
  process.exitCode = 1;
} else if (args[1] === "list") {
  process.stdout.write("[]\n");
} else if (args[1] === "get") {
  process.exitCode = 1;
}
