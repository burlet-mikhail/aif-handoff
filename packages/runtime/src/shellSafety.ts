const WINDOWS_SHELL_METACHARACTERS = /[\r\n&|<>^%"]/;

export function assertSafeWindowsShellExecutablePath(value: string, label: string): void {
  if (WINDOWS_SHELL_METACHARACTERS.test(value)) {
    throw new Error(`Unsafe ${label} contains Windows shell metacharacters`);
  }
}

export function buildSafeWindowsShellCommandLine(
  executablePath: string,
  args: string[],
  label: string,
): string {
  return [executablePath, ...args].map((arg) => quoteSafeWindowsShellArg(arg, label)).join(" ");
}

function quoteSafeWindowsShellArg(arg: string, label: string): string {
  assertSafeWindowsShellExecutablePath(arg, `${label} command argument`);
  return /[\s()]/.test(arg) ? `"${arg}"` : arg;
}
