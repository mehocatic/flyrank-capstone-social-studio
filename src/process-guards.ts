import process from 'node:process';
import { redactError } from './redact.js';

/**
 * Catches the two failures that Node prints **itself**, straight to stderr, before
 * any application code can see them: an unhandled promise rejection and an uncaught
 * exception. Node's own output includes the full error and stack, so a rejected
 * promise carrying the webhook URL would print the secret despite every other
 * redaction in this codebase. Registering handlers replaces that default output.
 *
 * Both are fatal. After an uncaught exception the process state is undefined, so the
 * only safe action is to report and exit, not to carry on serving requests.
 */
export function installFatalHandlers(onExit: (code: number) => void = (code) => process.exit(code)): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`[fatal] unhandled promise rejection: ${redactError(reason)}`);
    onExit(1);
  });

  process.on('uncaughtException', (error) => {
    console.error(`[fatal] uncaught exception: ${redactError(error)}`);
    onExit(1);
  });
}
