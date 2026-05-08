import { spawn } from "node:child_process";

// Agent tests currently crash under Stryker's Vitest sandbox on this Node/Vitest
// combination, so keep it opt-in until that path is stabilized.
const packageOrder = ["shared", "data", "runtime", "api", "mcp", "web"];
const packageNames = new Set([...packageOrder, "agent"]);

const requestedPackages = [];
const strykerArgs = [];

for (const arg of process.argv.slice(2)) {
  if (packageNames.has(arg)) {
    requestedPackages.push(arg);
  } else {
    strykerArgs.push(arg);
  }
}

const selectedPackages = requestedPackages.length > 0 ? requestedPackages : packageOrder;
const bin = process.platform === "win32" ? "npx.cmd" : "npx";

for (const packageName of selectedPackages) {
  console.log(`\n[mutation] ${packageName}`);

  const exitCode = await run(bin, ["stryker", "run", "stryker.conf.mjs", ...strykerArgs], {
    ...process.env,
    AIF_MUTATION_PACKAGE: packageName,
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
    });

    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`[mutation] command terminated by ${signal}`);
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });

    child.on("error", (error) => {
      console.error(`[mutation] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
  });
}
