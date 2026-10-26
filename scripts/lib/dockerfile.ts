/**
 * Reading a Dockerfile as data (tasks `P1-DOCK-01`, `P1-DOCK-02`).
 *
 * There is no container engine in this environment, so the images cannot be built by the suite. What *can* be asserted
 * is everything that makes an image wrong in a way a build would not catch: a base tag that floats, a `COPY` of a path
 * `.dockerignore` hides, a runtime stage with no user, an install that resolves past the lockfile, a config file the
 * server never reads. That needs the file parsed into stages and instructions, which is what this module does — once,
 * for both images.
 *
 * It is deliberately not a Dockerfile implementation: continuations are joined, comments and blanks dropped, and the
 * result is `keyword` + the rest of the line. `FROM` lines are the one thing it interprets, because a stage without a
 * name cannot be copied from and a `${ARG}` before the first `FROM` is how a base image is parameterised.
 *
 * @module scripts/lib/dockerfile
 */

/** One parsed instruction. */
export interface Instruction {
  /** Upper-case keyword, e.g. `COPY`. */
  readonly keyword: string;
  /** Everything after the keyword, whitespace-normalised. */
  readonly args: string;
  /** The whole logical line, for matching text that spans the keyword. */
  readonly raw: string;
}

/** One `FROM … AS …` and everything under it. */
export interface Stage {
  /** The name after `AS`, or `default` for an unnamed stage. */
  readonly name: string;
  /** The image reference, exactly as written — `${BUN_IMAGE}` stays unresolved. */
  readonly image: string;
  /** Instructions in file order. */
  readonly instructions: readonly Instruction[];
}

/** A parsed Dockerfile. */
export interface Dockerfile {
  /** Instructions above the first `FROM` — global `ARG`s, which is the only place a base image can be parameterised. */
  readonly preamble: readonly Instruction[];
  /** The stages, in file order. */
  readonly stages: readonly Stage[];
}

/** One `COPY`/`ADD`, split into its parts. */
export interface CopyInstruction {
  /** Source operands, before the destination. Wildcards are left as written. */
  readonly sources: readonly string[];
  /** The destination operand. */
  readonly dest: string;
  /** The stage a `--from=` copy reads from, when present. */
  readonly from?: string;
  /** The whole logical line. */
  readonly raw: string;
}

/**
 * Splits a Dockerfile into logical lines: continuations joined, comments and blank lines dropped.
 *
 * @param text - The file's contents.
 * @returns One string per instruction, whitespace-normalised.
 */
export function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let buffer = '';
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (buffer === '' && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      buffer += `${line.slice(0, -1)} `;
      continue;
    }
    buffer += line;
    lines.push(buffer.replace(/\s+/gu, ' ').trim());
    buffer = '';
  }
  return lines;
}

/**
 * Parses a Dockerfile into its preamble and stages.
 *
 * @param text - The file's contents.
 * @returns The parsed file.
 */
export function parseDockerfile(text: string): Dockerfile {
  const preamble: Instruction[] = [];
  const stages: Stage[] = [];

  for (const raw of logicalLines(text)) {
    const keyword = (raw.split(' ')[0] ?? '').toUpperCase();
    if (keyword === 'FROM') {
      const tokens = raw.split(' ');
      stages.push({ name: tokens[3] ?? 'default', image: tokens[1] ?? '', instructions: [] });
      continue;
    }
    const instruction: Instruction = { keyword, args: raw.slice(keyword.length).trim(), raw };
    const current = stages.at(-1);
    if (current === undefined) {
      preamble.push(instruction);
      continue;
    }
    (current.instructions as Instruction[]).push(instruction);
  }

  return { preamble, stages };
}

/**
 * The instructions of a stage that use a given keyword.
 *
 * @param stage - The stage to search.
 * @param keyword - Keyword to match, case-insensitive.
 * @returns Matching instructions, in order.
 */
export function instructionsOf(stage: Stage, keyword: string): Instruction[] {
  return stage.instructions.filter((instruction) => instruction.keyword === keyword.toUpperCase());
}

/**
 * Every `COPY` in a stage, split into sources, destination and `--from`.
 *
 * @param stage - The stage to read.
 * @returns One entry per copy, in order.
 */
export function copiesOf(stage: Stage): CopyInstruction[] {
  return instructionsOf(stage, 'COPY').map((instruction) => {
    const tokens = instruction.args.split(' ').filter((token) => token.length > 0);
    const flags = tokens.filter((token) => token.startsWith('--'));
    const operands = tokens.filter((token) => !token.startsWith('--'));
    const from = flags.find((flag) => flag.startsWith('--from='))?.slice('--from='.length);
    return {
      sources: operands.slice(0, -1),
      dest: operands.at(-1) ?? '',
      ...(from === undefined ? {} : { from }),
      raw: instruction.raw,
    };
  });
}

/**
 * The build-context paths an image copies — every `COPY` that does not read from another stage.
 *
 * @param dockerfile - A parsed Dockerfile.
 * @returns Normalised repository-relative paths, with `./` and trailing slashes removed.
 */
export function contextSources(dockerfile: Dockerfile): string[] {
  return dockerfile.stages
    .flatMap((stage) => copiesOf(stage))
    .filter((copy) => copy.from === undefined)
    .flatMap((copy) => copy.sources)
    .map((source) => source.replace(/^\.\//u, '').replace(/\/+$/u, ''));
}

/**
 * The single stage with a given name.
 *
 * @param dockerfile - A parsed Dockerfile.
 * @param name - Stage name.
 * @returns The stage.
 * @throws {Error} When there is no such stage, or more than one — both mean the file is not what the caller assumes.
 */
export function stageNamed(dockerfile: Dockerfile, name: string): Stage {
  const matches = dockerfile.stages.filter((stage) => stage.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one stage named ${name}, found ${String(matches.length)}`);
  }
  return matches[0] as Stage;
}
