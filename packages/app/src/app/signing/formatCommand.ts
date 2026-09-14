const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Format an argv vector as an unambiguous, compact POSIX shell command. */
export function formatCommand(command: string[]): string {
  return command.map(formatArgument).join(' ');
}

function formatArgument(argument: string): string {
  if (argument.length === 0) {
    return "''";
  }
  if (SAFE_ARGUMENT.test(argument)) {
    return argument;
  }

  return `'${argument.replaceAll("'", `'\\''`)}'`;
}
