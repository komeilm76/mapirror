/**
 * Hidden terminal input for the operator scripts (`P1-AUTH-06`, `P1-AUTH-07`).
 *
 * AUTH-1 requires that a password typed at a prompt is **hidden**, and that requirement is easy to satisfy on paper and
 * easy to break in practice: the value is read correctly and echoed anyway, into a scrollback buffer, a `docker logs`
 * stream and someone's screenshot. Two measured findings decided this implementation (pass 26):
 *
 * 1. **`node:readline` echoes the *first* password typed after the process starts**, under Bun, in a real terminal. The
 *    interface's own `setRawMode(true)` runs before Bun has finished initialising the TTY, so the terminal keeps
 *    `ECHO` on for the first line; every prompt after it is silent, because by then the terminal has been in raw mode
 *    once (measured with three prompts in one PTY: the first echoed, the second and third did not). Calling
 *    `setRawMode(true)` *before* reading fixes it — which is the shape below, without readline.
 * 2. **Muting readline's output hides readline's echo, not the terminal's.** The earlier version handed readline a
 *    discarding `Writable`, and the in-memory tests passed while the terminal still echoed the line — an in-memory
 *    stream has no terminal driver to echo anything, which is exactly why it missed this. The suite therefore asserts
 *    the *mechanism* instead: `scripts/tests/secret-prompt.spec.ts` records that `setRawMode(true)` happens before the
 *    first read and that it is restored afterwards, and the end-to-end check was done once by hand in a PTY
 *    (`python3 -c 'pty.fork()…'` against `bun run admin:init`, output `Password: \r\nRepeat password: \r\n` with no
 *    keystrokes in it).
 *
 * Reading a line by hand is therefore not reinventing readline for its own sake: it is the only way to put the terminal
 * into raw mode *first* and to control what is (not) written. What the loop handles is what a password field needs —
 * Enter, backspace, Ctrl-C, Ctrl-D, and escape sequences (so a stray arrow key does not become part of the secret) —
 * and nothing else. No echo, no asterisks: like `sudo`, the operator sees nothing, which is honest about what is on
 * screen and in any recording of it.
 *
 * @module scripts/lib/secret-prompt
 */

import type { Readable, Writable } from 'node:stream';

/** A terminal, as this module needs it. `setRawMode` is what makes the difference above possible. */
export interface TerminalInput extends Readable {
  /** `true` on a TTY; absent on a pipe. */
  readonly isTTY?: boolean;
  /** Present only on a TTY; `undefined` in a test double. */
  setRawMode?: (mode: boolean) => void;
  /** Present only on a TTY. */
  isRaw?: boolean;
}

/**
 * Characters a previous prompt on the same terminal received but did not consume.
 *
 * A terminal can deliver a paste as one `data` event, newlines included, and a stream can also split those bytes across
 * events at any boundary. Pasting a two-line block at `New password:` may hand the first call `"secret\nsecret\n"`; the
 * first line is the answer, and the suffix belongs to the repeat prompt. Without keeping it, the repeat prompt waits for
 * input that has already arrived — a hang on a TTY, `no input` on a stream that then ends (measured, pass 28 and pass 46).
 * Keyed by the stream and weak, so nothing outlives the terminal it belongs to.
 */
const leftovers = new WeakMap<object, string>();

/** A CR ended the previous line; ignore its optional LF even if the stream delivered it in a later chunk. */
const pendingCarriageReturn = new WeakSet<object>();

/** How much unconsumed input is worth keeping. A password is at most 256 code points; the rest is dropped. */
const MAX_LEFTOVER_CHARACTERS = 512;

/** What the prompt needs. Streams are injectable so the behaviour can be asserted without a terminal. */
export interface SecretPromptOptions {
  /** Text shown before the cursor, e.g. `Password: `. */
  readonly question: string;
  /** Where the question is written. Defaults to `process.stdout`. */
  readonly output?: Writable;
  /** Where keystrokes are read. Defaults to `process.stdin`. */
  readonly input?: TerminalInput;
}

/**
 * Reports whether a stream is an interactive terminal.
 *
 * Every caller asks this before prompting: a container entrypoint has no TTY, and a prompt against a closed stdin
 * would either hang the boot or read an empty password. `isTTY` is absent from non-TTY streams, so the check is
 * `=== true` rather than truthy.
 *
 * @param input - Stream to inspect; defaults to `process.stdin`.
 * @returns `true` when the stream is a terminal.
 */
export function isInteractive(input: TerminalInput | undefined = process.stdin): boolean {
  return input?.isTTY === true;
}

/**
 * Reads one line from a terminal without echoing it.
 *
 * @param options - Question, output and input streams.
 * @returns Exactly what was typed, without the newline. Surrounding spaces are kept: the password policy rejects them
 * with a message, and trimming a secret would quietly change it.
 * @throws {Error} With `no input` when the stream ends before a line arrives (Ctrl-D on an empty line, or a pipe with
 * no content) — hanging is worse, and an empty string is not a password.
 * @throws {Error} With `cancelled` when Ctrl-C is pressed; the terminal is restored first.
 */
export async function promptSecret(options: SecretPromptOptions): Promise<string> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  // Restored on the way out, so the operator's shell is not left in raw mode — the failure that makes a terminal
  // "lose" its line editing until `reset` is typed.
  const wasRaw = input.isRaw === true;

  output.write(options.question);
  // Before reading anything (finding 1 above).
  input.setRawMode?.(true);

  let value = '';
  let afterLine = '';
  let lineFinished = false;
  let settled = false;
  let skipLf = pendingCarriageReturn.has(input);
  pendingCarriageReturn.delete(input);
  let cleanup = (): void => undefined;
  // 0 = normal, 1 = just saw ESC, 2 = inside a CSI/SS3 sequence. Escape sequences are dropped whole; keeping only part
  // of one would put `[A` into the secret.
  let escape = 0;

  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (): void => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('close', onEnd);
      };
      cleanup = finish;

      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        finish();
        reject(new Error('no input: the terminal closed before a line was read'));
      };

      const onData = (chunk: string | Buffer): void => {
        let text = String(chunk);
        // CR and LF are one line ending, but a stream is allowed to split them into separate data events. Remember the
        // CR across calls, and remove at most the first LF from the next non-empty chunk.
        if (skipLf && text.length > 0) {
          if (text.charAt(0) === '\n') text = text.slice(1);
          skipLf = false;
        }
        if (text.length === 0) return;

        // Once this prompt has a line, continue collecting the rest of the current paste until the outer `finally`
        // pauses the input. Otherwise Readable streams can emit the next chunk between prompts and lose it.
        if (lineFinished) {
          afterLine = (afterLine + text).slice(0, MAX_LEFTOVER_CHARACTERS);
          return;
        }

        for (let index = 0; index < text.length; index += 1) {
          // `charAt` rather than `text[index]`: it is typed as `string` (an index is `string | undefined` under
          // `noUncheckedIndexedAccess`), and iterating by code unit keeps `slice(index + 1)` pointing at the character
          // after the newline even when the password contains astral characters.
          const character = text.charAt(index);
          // A terminal sends escape sequences for arrow keys, Home, Delete… Dropping the sequence keeps them out of the
          // secret instead of appending `[A` to a password the operator will then be unable to reproduce.
          const code = character.codePointAt(0) ?? 0;
          if (escape === 1) {
            // `ESC [` (CSI) and `ESC O` (SS3) open a sequence; `ESC x` is a two-character sequence and is now complete.
            escape = character === '[' || character === 'O' ? 2 : 0;
            continue;
          }
          if (escape === 2) {
            // A sequence ends with a byte in 0x40–0x7E (`A` for the up arrow, `~` for Delete…).
            if (code >= 0x40 && code <= 0x7e) escape = 0;
            continue;
          }
          if (character === '\u001b') {
            escape = 1;
            continue;
          }
          if (character === '\r' || character === '\n') {
            // Whatever followed the newline belongs to the *next* prompt, not to the bin. A paste of both lines is the
            // common case, but keep collecting later chunks too. CRLF may be split at the chunk boundary.
            const isCrLf = character === '\r' && text.charAt(index + 1) === '\n';
            const after = isCrLf ? index + 2 : index + 1;
            afterLine = text.slice(after, after + MAX_LEFTOVER_CHARACTERS);
            skipLf = character === '\r' && !isCrLf;
            lineFinished = true;
            settled = true;
            resolve(value);
            return;
          }
          if (character === '\u0003') {
            // Ctrl-C: raw mode would otherwise swallow it and leave a script that cannot be interrupted.
            lineFinished = true;
            settled = true;
            finish();
            reject(new Error('cancelled'));
            return;
          }
          if (character === '\u0004') {
            // Ctrl-D: end of input. With something typed it means "that is the password"; on an empty line it is the
            // shell's "nothing to give you".
            afterLine = text.slice(index + 1, index + 1 + MAX_LEFTOVER_CHARACTERS);
            lineFinished = true;
            settled = true;
            finish();
            if (value.length === 0)
              reject(new Error('no input: the terminal closed before a line was read'));
            else resolve(value);
            return;
          }
          if (character === '\u007f' || character === '\b') {
            // Password length is measured in Unicode code points; deleting one UTF-16 code unit would leave half of an
            // emoji (a lone surrogate) and silently set a different password than the operator intended.
            value = [...value].slice(0, -1).join('');
            continue;
          }
          // Every other control character is dropped: none of them belongs in a password, and a tab would otherwise
          // arrive as a literal `\t` the operator cannot see.
          if (code < 0x20) continue;
          value += character;
        }
      };

      input.setEncoding?.('utf8');
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('close', onEnd);

      // Typed ahead of the question: a paste that contained two lines, or keystrokes that arrived while the previous
      // prompt was still closing. Consumed first, and if it already contains a newline the promise settles here.
      const pending = leftovers.get(input);
      if (pending !== undefined) {
        leftovers.delete(input);
        onData(pending);
      }
      // Resume only after listeners exist; a buffered chunk must never be emitted between resume and registration.
      input.resume();
    });
  } finally {
    input.pause();
    cleanup();
    if (afterLine.length > 0) leftovers.set(input, afterLine.slice(0, MAX_LEFTOVER_CHARACTERS));
    else leftovers.delete(input);
    if (skipLf) pendingCarriageReturn.add(input);
    else pendingCarriageReturn.delete(input);
    input.setRawMode?.(wasRaw);
    // The newline the terminal would have echoed. Written on every path, so the shell prompt returns to column zero.
    output.write('\n');
  }
}
