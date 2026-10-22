/**
 * Strips the AWS Node runtime prefix (`<ISO time>\t<requestId>\t<LEVEL>\t`) that
 * Text-format Lambda logs carry ahead of every application console line, so a
 * test asserts on what the handler printed rather than on the simulator clock
 * or the request ID. Lines without the prefix (START, END, REPORT, raw stdout)
 * are returned unchanged.
 */
export function applicationMessage(message: string): string {
  return message.replace(/^\d{4}-\d{2}-\d{2}T[^\t]*\t[^\t]*\t[A-Z]+\t/, "");
}
