import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

let cachedShellConfig: { shell: string; args: string[] } | null = null;

/**
 * Find bash executable on PATH by running where wtih spawnSync
 */
function findBashOnPath(): string | null {
  try {
    const result = spawnSync("where", ["bash.exe"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch && existsSync(firstMatch)) {
        return firstMatch;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Get shell configuration based on platform.
 * on windows checks for git bash
 * for unix checks for bash and fallback to sh
 */
export function getShellConfig(): { shell: string; args: string[] } {
  if (cachedShellConfig) {
    return cachedShellConfig;
  }

  if (process.platform === "win32") {
    // 2. Try Git Bash in known locations
    const paths: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }

    for (const path of paths) {
      if (existsSync(path)) {
        cachedShellConfig = { shell: path, args: ["-c"] };
        return cachedShellConfig;
      }
    }

    // 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
    const bashOnPath = findBashOnPath();
    if (bashOnPath) {
      cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
      return cachedShellConfig;
    }

    throw new Error("No bash shell found");
  }

  if (existsSync("/bin/bash")) {
    cachedShellConfig = { shell: "/bin/bash", args: ["-c"] };
    return cachedShellConfig;
  }

  cachedShellConfig = { shell: "sh", args: ["-c"] };
  return cachedShellConfig;
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Use taskkill on Windows to kill process tree
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // Ignore errors
    }
  } else {
    // Use SIGKILL on Unix/Linux/Mac
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Fallback to killing just the child if process group kill fails
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // will reach here if process is already dead.
      }
    }
  }
}
