import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args?: string[], timeoutMs?: number): Promise<CommandResult>;
}

export const systemCommandRunner: CommandRunner = {
  async run(command, args = [], timeoutMs = 20_000) {
    try {
      const result = await execFileAsync(command, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};
