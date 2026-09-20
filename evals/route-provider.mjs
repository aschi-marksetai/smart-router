import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUN_COMMAND = "bun";
const ROUTE_COMMAND = ["run", "src/cli.ts", "route"];

export default class RouteProvider {
  id() {
    return "smart-router:route";
  }

  async callApi(prompt, context) {
    const vars = context.vars;
    const args = [...ROUTE_COMMAND, prompt];

    if (vars.hint) args.push("--hint", vars.hint);
    if (vars.confidential) args.push("--confidential");

    try {
      const { stdout } = await execFileAsync(BUN_COMMAND, args, {
        cwd: REPO_ROOT,
      });
      return { output: JSON.parse(stdout) };
    } catch (error) {
      return { error: error.stderr || error.stdout || error.message };
    }
  }
}
