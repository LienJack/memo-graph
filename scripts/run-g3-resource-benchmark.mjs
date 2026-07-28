import {
  runG3ResourceBenchmark,
} from "../packages/memory-kernel/dist/index.js";
import process from "node:process";

const report = await runG3ResourceBenchmark({
  evidence: 10_000,
  l1: 1_000,
  projections: 250,
  relations: 1_000,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
