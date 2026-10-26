import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { isInteractive, promptSecret } from '../lib/secret-prompt';

/**
 * The hidden prompt (`P1-AUTH-06`). AUTH-1 requires a password typed at a prompt to be hidden, and "hidden" is not
 * something a person notices when it breaks: the value is read correctly and printed to the terminal, the scrollback,
 * and the log of whatever captured the session.
 *
 * So the assertion is not "the value came back" — it is **"the value is in neither stream"**. A refactor that hands the
 * real output to `readline` (the natural-looking bug) fails here rather than in production.
 */

/**
 * Runs `promptSecret` against an in-memory terminal.
 *
 * @param keystrokes - What the "user types", newline included.
 * @param endEarly - End the stream without a newline, the way Ctrl-D does.
 * @returns The answer (or the error) and everything that reached the real output.
 */
async function prompt(
  keystrokes: string,
  endEarly = false,
): Promise<{ answer?: string; error?: unknown; written: string }> {
  const input = Readable.from([endEarly ? keystrokes : `${keystrokes}\n`]);
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  try {
    const answer = await promptSecret({ question: 'Password: ', input, output });
    return { answer, written: chunks.join('') };
  } catch (error) {
    return { error, written: chunks.join('') };
  }
}

describe('promptSecret', () => {
  it('returns what was typed and echoes none of it', async () => {
    const result = await prompt('zebra-quartz-58-lantern');

    expect(result.answer).toBe('zebra-quartz-58-lantern');
    expect(result.written).toBe('Password: \n');
    expect(result.written).not.toContain('zebra');
    expect(result.written).not.toContain('lantern');
  });

  it('writes the prompt before reading, and one newline after', async () => {
    // The newline matters: both the terminal's echo and readline's are suppressed, so without it the shell prompt
    // returns on the password line.
    const result = await prompt('x');
    expect(result.written).toBe('Password: \n');
  });

  it('returns the answer verbatim, without trimming it', async () => {
    // The policy rejects surrounding whitespace and says so. Trimming here would silently change the secret instead,
    // and the next login would fail with no explanation (the same rule as `hashPassword`).
    const result = await prompt(' spaces around ');
    // Both ends kept — `readline` removes the line terminator and nothing else (measured).
    expect(result.answer).toBe(' spaces around ');
  });

  it('returns an empty answer rather than inventing one', async () => {
    // An empty line is a legitimate answer for a prompt: the caller decides what it means, and the policy says it is
    // not a password. Guessing here would hide the operator's mistake.
    const result = await prompt('');
    expect(result.answer).toBe('');
  });

  it('fails instead of hanging when the terminal closes before a line arrives', async () => {
    const result = await prompt('half-typed', true);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('no input');
    // The newline is written even on the way out, so the shell prompt is not left mid-line.
    expect(result.written).toBe('Password: \n');
  });

  it('never writes the answer even for a long line', async () => {
    // Readline writes the whole line back on some platforms when the output is not muted; a long value makes that
    // visible in the captured output rather than truncated.
    const long = 'a1b2c3d4e5'.repeat(20);
    const result = await prompt(long);
    expect(result.written).not.toContain('a1b2c3d4e5');
  });
});

describe('promptSecret — terminal mode', () => {
  /**
   * A fake terminal that records the order of the two things that matter: putting the TTY into raw mode, and starting
   * to read. Raw mode first is the difference between a hidden password and an echoed one (see the module docstring);
   * both orders "work" for the value, so only an assertion on the order can catch a regression.
   */
  function fakeTerminal(keystrokes: string): {
    input: Readable & { isTTY: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
    calls: string[];
  } {
    const calls: string[] = [];
    const input = Readable.from([keystrokes]) as Readable & {
      isTTY: boolean;
      setRawMode?: (mode: boolean) => void;
      isRaw?: boolean;
    };
    input.isTTY = true;
    input.setRawMode = (mode: boolean) => {
      calls.push(mode ? 'raw:on' : 'raw:off');
      input.isRaw = mode;
    };
    // `Readable.from` starts flowing on the next tick; the listener registration is what has to come after raw mode.
    const on = input.on.bind(input);
    input.on = ((event: string, listener: (...args: never[]) => void) => {
      if (event === 'data') calls.push('read');
      return on(event, listener as never);
    }) as typeof input.on;
    return { input, calls };
  }

  it('answers two prompts from one paste, which arrives as a single chunk', async () => {
    // Asking for a new password and then for it again, an operator pastes the two-line block. A terminal delivers that
    // as one `data` event, and the first call consumes the whole chunk — so the second prompt used to wait for input
    // that had already arrived: a hang on a TTY, `no input` on a stream that then ends (measured, pass 28).
    const input = Readable.from(['first-password\nsecond-password\n']);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const first = await promptSecret({ question: 'New password: ', input, output });
    const second = await promptSecret({ question: 'Repeat: ', input, output });

    expect(first).toBe('first-password');
    expect(second).toBe('second-password');
  });

  it('splits a pasted block written with Windows line endings', async () => {
    // The same paste through a Windows terminal, or through a tool that normalises less than it promises. The `\r` is
    // the terminator's second half and belongs to neither password — an ending of `-password\r` would be rejected by
    // the policy with a message that looks like a typo.
    const input = Readable.from(['crlf-one\r\ncrlf-two\r\n']);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    expect(await promptSecret({ question: 'Password: ', input, output })).toBe('crlf-one');
    expect(await promptSecret({ question: 'Repeat: ', input, output })).toBe('crlf-two');
  });

  it('preserves a CRLF paste even when the stream splits the CR and LF across chunks', async () => {
    // Readable streams may split one logical input anywhere; CR and LF are not guaranteed to share a data event. Losing
    // the second chunk turns the second prompt into `no input` (reproduced with a segmented `Readable.from` source).
    const input = Readable.from(['split-one\r', '\nsplit-two\r', '\n']);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    expect(await promptSecret({ question: 'Password: ', input, output })).toBe('split-one');
    expect(await promptSecret({ question: 'Repeat: ', input, output })).toBe('split-two');
  });

  it('puts the terminal into raw mode before reading, and restores it afterwards', async () => {
    const { input, calls } = fakeTerminal('hunter2-very-long\n');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await promptSecret({ question: 'Password: ', input, output });

    // Raw mode on, then reading, then restored — in that order. The restore matters as much as the first call: a
    // terminal left in raw mode loses line editing until the operator runs `reset`.
    expect(calls).toEqual(['raw:on', 'read', 'raw:off']);
  });

  it('restores raw mode even when the password is never finished', async () => {
    const { input, calls } = fakeTerminal('\u0003');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await expect(promptSecret({ question: 'Password: ', input, output })).rejects.toThrow(
      /cancelled/u,
    );
    expect(calls).toEqual(['raw:on', 'read', 'raw:off']);
  });
});

describe('promptSecret — editing keys', () => {
  it('applies backspace the way a terminal would', async () => {
    // Backspace removes the last character; without this the operator cannot correct a typo that is invisible to them.
    expect((await prompt('abc\u007fd')).answer).toBe('abd');
  });

  it('deletes a complete non-BMP character with one backspace', async () => {
    // JavaScript stores an emoji as a surrogate pair. Removing one UTF-16 unit leaves an invisible lone surrogate in
    // the secret, so a correction the operator believes was deleted changes the password they actually set.
    expect((await prompt('abc😀\u007fd')).answer).toBe('abcd');
  });

  it('drops arrow-key escape sequences instead of typing them', async () => {
    // `\u001b[A` is the up arrow. Appending it would create a password containing `[A` that the operator cannot retype.
    expect((await prompt('abc\u001b[Adef')).answer).toBe('abcdef');
  });

  it('ignores a tab and other control characters', async () => {
    expect((await prompt('ab\tcd\u0001')).answer).toBe('abcd');
  });

  it('treats Ctrl-D after typing as the end of the password', async () => {
    // Ctrl-D finishes the line without a newline; with text on it, the text is the answer rather than "no input".
    expect((await prompt('secret-value\u0004')).answer).toBe('secret-value');
  });

  it('reports Ctrl-C as a cancellation rather than an empty password', async () => {
    const result = await prompt('\u0003');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('cancelled');
    expect(result.answer).toBeUndefined();
  });
});

describe('isInteractive', () => {
  it('is false for a stream with no isTTY, which is what a container has', () => {
    expect(isInteractive(Readable.from(['x']))).toBe(false);
    expect(isInteractive(undefined)).toBe(false);
  });

  it('is true only for an actual terminal', () => {
    // `=== true`, not truthiness: `isTTY` is `undefined` on a pipe and `1`/`true` on a TTY, and a truthy check would
    // read a closed stdin as interactive and then hang the boot waiting for a password nobody can type.
    const tty = Object.assign(Readable.from(['x']), { isTTY: true });
    const notQuite = Object.assign(Readable.from(['x']), { isTTY: 1 });
    expect(isInteractive(tty)).toBe(true);
    expect(isInteractive(notQuite as unknown as Readable)).toBe(false);
  });
});
