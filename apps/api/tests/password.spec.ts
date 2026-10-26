import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseOptions } from '@node-rs/argon2';
import { LOGIN_PASSWORD_MAX, LoginRequestSchema } from '@mapirror/shared';
import { describe, expect, it } from 'vitest';

import {
  ARGON2_PARAMS,
  assertPasswordAcceptable,
  generateStrongPassword,
  GENERATED_PASSWORD_LENGTH,
  hashPassword,
  passwordProblems,
  PasswordPolicyError,
  PASSWORD_POLICY,
  verifyPassword,
} from '../src/modules/auth/password';
import { WEAK_PASSWORDS, WEAK_PASSWORD_SET } from '../src/modules/auth/weak-passwords';

/**
 * Acceptance tests for `P1-AUTH-01`: Argon2id hashing with the documented parameters, verification that answers
 * instead of throwing, and a creation-time policy of length + blocklist.
 *
 * Two of the tests here are not about behaviour at all — they parse `docs/14-security.md` and `docs/04-api.md`
 * and compare what the docs *promise* with what the code *does*. Those numbers are the ones a future edit is
 * most likely to change in one place only, and the failure mode is silent (a password nobody can log in with, a
 * hash weaker than advertised).
 */

/** A good password that is not on any list; used by most cases so the policy noise stays out of the way. */
const GOOD = 'correct horse battery staple';

/** Reads a doc file relative to the repository root. */
function readDoc(name: string): string {
  return readFileSync(resolve(import.meta.dirname, '../../../docs', name), 'utf8');
}

describe('generateStrongPassword', () => {
  it('produces a password the policy accepts, for an account name that must be kept out of it', () => {
    // The generator's only contract is the policy: a reset script that has to check and retry would be a reset script
    // that sometimes stores a password it then refuses to use.
    const password = generateStrongPassword(undefined, { username: 'admin' });

    expect(passwordProblems(password, { username: 'admin' })).toEqual([]);
    expect([...password]).toHaveLength(GENERATED_PASSWORD_LENGTH);
  });

  it('uses only characters an operator can read off a screen without confusing them', () => {
    // The password is printed once, to be typed into a browser later. `0/O`, `1/l/I`, `5/S` and `2/Z` cost a second
    // reset when someone guesses wrong.
    const password = generateStrongPassword(64);

    expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/u);
  });

  it('does not repeat itself', () => {
    // A generator seeded from a constant would pass every assertion above. 200 draws of a 24-character password: a
    // collision here means the source is not random at all.
    const seen = new Set(
      Array.from({ length: 200 }, () => generateStrongPassword(undefined, { username: 'admin' })),
    );
    expect(seen.size).toBe(200);
  });

  it('rejects a length outside the policy bounds instead of generating a password the policy will refuse', () => {
    expect(() => generateStrongPassword(PASSWORD_POLICY.minLength - 1)).toThrow(RangeError);
    expect(() => generateStrongPassword(0)).toThrow(RangeError);
    expect(() => generateStrongPassword(12.5)).toThrow(RangeError);
    // The ceiling too: ten attempts at 300 characters would fail every time, and the error would blame randomness.
    expect(() => generateStrongPassword(PASSWORD_POLICY.maxLength + 1)).toThrow(RangeError);
    // The floor itself is accepted.
    expect(passwordProblems(generateStrongPassword(PASSWORD_POLICY.minLength))).toEqual([]);
  });

  it('honours a supplied alphabet', () => {
    // The alphabet is a parameter; with a degenerate one the output is fully predictable, which is also how the retry
    // limit below is reached rather than hoped for.
    expect(generateStrongPassword(12, {}, { alphabet: 'a' })).toBe('aaaaaaaaaaaa');
  });

  it('refuses an empty alphabet instead of looping on it', () => {
    expect(() => generateStrongPassword(12, {}, { alphabet: '' })).toThrow(/alphabet/u);
  });

  it('gives up after ten attempts rather than returning a password the policy refuses', () => {
    // A single-character alphabet, and a username made of it: every candidate contains the username, which the policy
    // refuses for names of three characters or more (`PASSWORD_POLICY.minUsernameLength`), so the loop must exhaust and
    // say so. Without the bound this is an infinite loop inside the reset script.
    expect(() => generateStrongPassword(12, { username: 'aaa' }, { alphabet: 'a' })).toThrow(
      /could not generate/u,
    );
  });

  it('keeps the account name out of the generated value', () => {
    // The policy rejects a password containing the username. With a name that *is* part of the alphabet this could in
    // principle collide, and the loop is what turns that into a retry instead of a password the policy refuses.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const password = generateStrongPassword(12, { username: 'abc' });
      expect(password.toLowerCase()).not.toContain('abc');
    }
  });
});

describe('hash format', () => {
  it('produces an Argon2id v19 PHC string with the documented parameters', async () => {
    const hash = await hashPassword(GOOD);

    // The literal prefix, not a constant this module also exports: a test that reuses the implementation's
    // own idea of the format cannot notice the format changing.
    expect(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);

    // And the same numbers, read back out of the string by the addon's parser, so a change to what is *encoded*
    // fails here even if the exported constant was updated to match it.
    const params = parseOptions(hash);
    expect(params.algorithm).toBe(2); // Argon2id
    expect(params.memoryCost).toBe(65_536); // KiB → 64 MiB
    expect(params.timeCost).toBe(3);
    expect(params.parallelism).toBe(1);
    expect(params.outputLen).toBe(32);
    expect(params.saltLen).toBe(16);
  });

  it('salts every hash, so the same password does not produce the same row twice', async () => {
    const [first, second] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);

    expect(first).not.toBe(second);
    // Both still verify: a random salt is only useful if the comparison reads it from the hash.
    expect(await verifyPassword(first, GOOD)).toBe(true);
    expect(await verifyPassword(second, GOOD)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects every near miss', async () => {
    const hash = await hashPassword(GOOD);

    expect(await verifyPassword(hash, GOOD)).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
    expect(await verifyPassword(hash, `${GOOD}e`)).toBe(false);
    // Case and surrounding whitespace are part of the password, not noise to be normalised away.
    expect(await verifyPassword(hash, GOOD.toUpperCase())).toBe(false);
    expect(await verifyPassword(hash, ` ${GOOD}`)).toBe(false);
  });

  it('verifies a hash produced by a different Argon2 implementation', async () => {
    // Generated by `hash-wasm` (an independent Argon2 compiled with Emscripten) for the password
    // `correct horse battery staple`, salt 0x0123456789abcdef0123456789abcdef, m=65536,t=3,p=1. If this ever
    // stops verifying, this module is hashing something other than the standard's byte sequence — the one
    // failure that would silently invalidate every stored password if the addon were swapped.
    const foreign =
      '$argon2id$v=19$m=65536,t=3,p=1$ASNFZ4mrze8BI0VniavN7w$v1B8OU3EKIAxxsyImp22QDP6w/RICCoGpCuLDlboyDA';

    expect(await verifyPassword(foreign, GOOD)).toBe(true);
    expect(await verifyPassword(foreign, 'not the password')).toBe(false);
  });

  it('answers false, rather than throwing, for a stored hash that cannot be decoded', async () => {
    // Measured: the addon throws `Error: Decoding failed` for all of these. Letting that escape turns a corrupt
    // row into a 500 that describes the internals, and turns "wrong password" into something an attacker can
    // distinguish from "no such user".
    for (const broken of [
      '',
      'not-a-hash',
      '$argon2id$v=19$m=65536,t=3,p=1$short', // truncated PHC
      '$2b$12$KIXQbHqL0vJ9jGS7lHm1Qe4z0mYh9tBv1k3o5v7n9q1r3s5t7u9w1', // a bcrypt hash
    ]) {
      await expect(verifyPassword(broken, GOOD)).resolves.toBe(false);
    }
  });

  it('treats Unicode encodings of the same password as equal', async () => {
    // `café` typed as `e` + U+0301 (macOS) or as U+00E9 (Linux) is the same visible password but different
    // bytes. Argon2 hashes bytes, so without normalisation one of the two keyboards cannot log in.
    const composed = 'café au lait crème brûlée';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed); // otherwise the test proves nothing

    const hash = await hashPassword(composed);
    expect(await verifyPassword(hash, decomposed)).toBe(true);
    expect(await verifyPassword(hash, composed)).toBe(true);

    // The other direction too: a password set decomposed must be accepted composed.
    const hashOfDecomposed = await hashPassword(decomposed);
    expect(await verifyPassword(hashOfDecomposed, composed)).toBe(true);
  });
});

describe('passwordProblems', () => {
  it('accepts a long password that is not on the blocklist', () => {
    expect(passwordProblems(GOOD)).toEqual([]);
  });

  it('reports an empty password as one problem, not three', () => {
    expect(passwordProblems('').map((problem) => problem.rule)).toEqual(['empty']);
    expect(passwordProblems('').at(0)?.message).toBe('Enter a password.');
  });

  it('enforces the length floor in characters, and says how many it counted', () => {
    expect(passwordProblems('abcdefghijk')).toHaveLength(1);
    expect(passwordProblems('abcdefghijk').at(0)?.message).toContain('at least 12');
    expect(passwordProblems('abcdefghijk').at(0)?.message).toContain('has 11');
    expect(passwordProblems('abcdefghijkl')).toEqual([]);
  });

  it('counts code points, so six emoji are six characters and not twelve UTF-16 units', () => {
    // `'😀'.length === 2`. A policy written with `.length` would let this through a 12-character floor.
    expect('😀😀😀😀😀😀'.length).toBe(12);
    expect(passwordProblems('😀😀😀😀😀😀').map((p) => p.rule)).toEqual(['too-short']);
    expect(passwordProblems('😀😀😀😀😀😀😀😀😀😀😀😀')).toEqual([]);
  });

  it('enforces the minimum in both raw and NFKC forms', () => {
    // NFKC expands the four typed ligatures to twelve code points; counting only the normalized form bypassed the floor.
    const expands = 'ﬃ'.repeat(4);
    expect([...expands.normalize('NFKC')]).toHaveLength(PASSWORD_POLICY.minLength);
    expect(passwordProblems(expands).map((problem) => problem.rule)).toEqual(['too-short']);
    expect(passwordProblems(expands).at(0)?.message).toContain('has 4');

    // It can also contract: six decomposed accents are twelve raw code points but only six after normalization.
    const contracts = 'e\u0301'.repeat(6);
    expect([...contracts]).toHaveLength(PASSWORD_POLICY.minLength);
    expect([...contracts.normalize('NFKC')]).toHaveLength(6);
    expect(passwordProblems(contracts).map((problem) => problem.rule)).toEqual(['too-short']);
    expect(passwordProblems(contracts).at(0)?.message).toContain('has 6');
  });

  it('rejects a password longer than the login endpoint accepts', () => {
    const tooLong = 'a'.repeat(PASSWORD_POLICY.maxLength + 1);
    expect(passwordProblems(tooLong).map((p) => p.rule)).toEqual(['too-long']);
    expect(passwordProblems(tooLong).at(0)?.message).toContain('at most 256');
    expect(passwordProblems('a'.repeat(PASSWORD_POLICY.maxLength))).toEqual([]);
  });

  it('measures the ceiling in code points of the submitted string, which is what the login schema measures', () => {
    // Pass 20 assumed Zod's `.max()` counted UTF-16 units and changed this check to match; measurement in pass 23
    // showed Zod 4 counts **code points** (`'😀'.repeat(200)` is 400 units, 200 code points, and passes `.max(256)`).
    // The policy had therefore become stricter than the documented rule and rejected emoji a login accepts.
    const emoji = '😀'.repeat(200);
    expect([...emoji].length).toBe(200);
    expect(emoji.length).toBe(400);
    expect(passwordProblems(emoji)).toEqual([]); // 200 characters is under the 256 ceiling

    // 257 emoji is over it, and the message counts characters rather than UTF-16 units.
    const tooMany = '😀'.repeat(PASSWORD_POLICY.maxLength + 1);
    expect(passwordProblems(tooMany).map((p) => p.rule)).toEqual(['too-long']);
    expect(passwordProblems(tooMany).at(0)?.message).toContain('has 257');
  });

  it('counts the raw string, not the normalised one, so `e` + combining accent cannot slip past', () => {
    // 150 × "e◌́" is 300 code points as typed and 150 once normalised. The login schema sees the raw 300 and refuses it,
    // so the policy has to refuse it too — otherwise the account is created and can never be used.
    const decomposed = 'e\u0301'.repeat(150);
    expect([...decomposed].length).toBe(300);
    expect([...decomposed.normalize('NFKC')].length).toBe(150);
    expect(passwordProblems(decomposed).map((p) => p.rule)).toEqual(['too-long']);
  });

  it('rejects surrounding whitespace instead of silently trimming it', () => {
    // Trimming would mean the stored password is not the one that was typed, and the next login fails with no
    // explanation. Rejecting says so.
    expect(passwordProblems(` ${GOOD}`).map((p) => p.rule)).toEqual(['surrounding-whitespace']);
    expect(passwordProblems(`${GOOD} `).map((p) => p.rule)).toEqual(['surrounding-whitespace']);
  });

  it('rejects the blocklist exactly, case-insensitively, and with digits or symbols appended', () => {
    // `q1w2e3r4t5y6` is one of only nine blocklist entries that reach the length floor on its own.
    expect(passwordProblems('q1w2e3r4t5y6').map((p) => p.rule)).toEqual(['common']);
    expect(passwordProblems('Q1W2E3R4T5Y6').map((p) => p.rule)).toEqual(['common']);
    // The stem rule: nothing here is 12 characters long except after the appended digits, and the blocklist
    // holds `password`, `qwerty`, `iloveyou` and `dragon` — which is what makes the list usable at this floor.
    expect(passwordProblems('password2026').map((p) => p.rule)).toEqual(['common']);
    expect(passwordProblems('qwerty123456').map((p) => p.rule)).toEqual(['common']);
    expect(passwordProblems('iloveyou!!!!!').map((p) => p.rule)).toEqual(['common']);
    expect(passwordProblems('dragon-12345678').map((p) => p.rule)).toEqual(['common']);
  });

  it('does not invent a match for a password that merely ends in digits', () => {
    // The stem rule must not degrade into "anything with a number at the end is common".
    expect(passwordProblems('uncommon-phrase-42')).toEqual([]);
    expect(passwordProblems('tr0ub4dor&3horse')).toEqual([]);
  });

  it('rejects a password that contains the username', () => {
    expect(passwordProblems('my-admin-password-9', { username: 'admin' })).toMatchObject([
      { rule: 'contains-username' },
    ]);
    // Case-insensitive in both directions.
    expect(passwordProblems('MY-ADMIN-password-9', { username: 'Admin' })).toMatchObject([
      { rule: 'contains-username' },
    ]);
    // A username that is too short to be meaningful is not used as a substring: `ad` is inside `shadow`,
    // `header` and half the dictionary.
    expect(passwordProblems('shadowed-paddock-12', { username: 'ad' })).toEqual([]);
    // And a password that merely shares letters with the username is fine.
    expect(passwordProblems('correct horse battery staple', { username: 'admin' })).toEqual([]);
    // The username is normalised like the password, so a decomposed `José` is still found inside a composed
    // password — the case where a byte comparison would quietly skip the rule.
    expect(passwordProblems('José-let-me-in-9', { username: 'Jose\u0301' })).toMatchObject([
      { rule: 'contains-username' },
    ]);
  });

  it('reports every problem at once, in priority order', () => {
    // Two problems, one round trip for the person typing: "too short" and "common" together, never one per
    // attempt.
    expect(passwordProblems('password').map((p) => p.rule)).toEqual(['too-short', 'common']);
    expect(passwordProblems(' admin', { username: 'admin' }).map((p) => p.rule)).toEqual([
      'too-short',
      'surrounding-whitespace',
      'contains-username',
    ]);
  });

  it('never echoes the password in a message', () => {
    // A rejected password is often a password someone uses elsewhere, so it must not come back in the message
    // (and from there into a log). `password` itself is deliberately absent from this list: the sentences below
    // use the word in prose, and the property under test is that the *value* is never interpolated.
    for (const password of ['hunter2', 'iloveyou2024', ` ${GOOD}`, 'admin123', 'qwerty123456']) {
      for (const problem of passwordProblems(password, { username: 'admin' })) {
        expect(problem.message).not.toContain(password.trim());
      }
    }
  });
});

describe('assertPasswordAcceptable', () => {
  it('accepts a password that meets the policy and throws the reasons otherwise', () => {
    expect(() => {
      assertPasswordAcceptable(GOOD, { username: 'admin' });
    }).not.toThrow();

    expect(() => {
      assertPasswordAcceptable('short', { username: 'admin' });
    }).toThrow(PasswordPolicyError);

    try {
      assertPasswordAcceptable('password', { username: 'admin' });
      expect.unreachable('a weak password must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordPolicyError);
      const policyError = error as PasswordPolicyError;
      expect(policyError.problems.map((problem) => problem.rule)).toEqual(['too-short', 'common']);
      // The message is the join of the problem messages, so a CLI can print one string and be complete.
      expect(policyError.message).toContain('at least 12 characters');
      expect(policyError.message).toContain('common-password list');
    }
  });

  it('is what hashPassword deliberately does not do', async () => {
    // Hashing and policy are separate: hashing a policy-violating string still works, because login must be able
    // to verify accounts created under an older, weaker policy.
    const hash = await hashPassword('short');
    expect(await verifyPassword(hash, 'short')).toBe(true);
  });
});

describe('WEAK_PASSWORDS', () => {
  it('holds 1 000 unique, lower-case, whitespace-free entries', () => {
    expect(WEAK_PASSWORDS).toHaveLength(1_000);
    expect(new Set(WEAK_PASSWORDS).size).toBe(1_000);
    for (const entry of WEAK_PASSWORDS) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry).toBe(entry.trim());
      expect(entry).toMatch(/^[\x20-\x7e]+$/u);
    }
  });

  it('is the same list as a set', () => {
    expect(WEAK_PASSWORD_SET.size).toBe(1_000);
    for (const entry of WEAK_PASSWORDS) expect(WEAK_PASSWORD_SET.has(entry)).toBe(true);
  });

  it('rejects every entry that is long enough to be submitted at all', () => {
    // Every one of them, not a sample: the policy must reject the list it ships, not the list plus exceptions.
    const longEnough = WEAK_PASSWORDS.filter(
      (entry) => [...entry].length >= PASSWORD_POLICY.minLength,
    );
    expect(longEnough.length).toBeGreaterThan(0);
    for (const entry of longEnough) {
      expect(passwordProblems(entry).map((problem) => problem.rule)).toContain('common');
    }
  });
});

describe('documentation matches the code', () => {
  it('documents the hash parameters this module uses', () => {
    const security = readDoc('14-security.md');
    const row = /^\| Hashing \| (.+?) \|$/mu.exec(security)?.[1];
    expect(row).toBeDefined();

    expect(row).toContain('Argon2id');
    // The doc states MiB; the addon's `memoryCost` is KiB. Compare in MiB, so a change to either unit breaks here.
    expect(Number(/memory (\d+) MiB/u.exec(row ?? '')?.[1])).toBe(ARGON2_PARAMS.memoryCost / 1024);
    expect(Number(/iterations (\d+)/u.exec(row ?? '')?.[1])).toBe(ARGON2_PARAMS.timeCost);
    expect(Number(/parallelism (\d+)/u.exec(row ?? '')?.[1])).toBe(ARGON2_PARAMS.parallelism);
  });

  it('documents the policy this module enforces', () => {
    const row = /^\| Password policy \| (.+?) \|$/mu.exec(readDoc('14-security.md'))?.[1];
    expect(row).toBeDefined();

    expect(Number(/≥ (\d+) chars/u.exec(row ?? '')?.[1])).toBe(PASSWORD_POLICY.minLength);
    expect(Number(/top-(\d+) weak list/u.exec(row ?? '')?.[1])).toBe(WEAK_PASSWORDS.length);
    expect(row).toContain('username substring');
  });

  it('documents a login password limit that a created password can satisfy', () => {
    // Three numbers that must agree: the document's, the login schema's and this policy's.
    const api = readDoc('04-api.md');
    const limit = Number(/password 1–(\d+) chars/u.exec(api)?.[1]);

    expect(limit).toBe(PASSWORD_POLICY.maxLength);
    expect(LOGIN_PASSWORD_MAX).toBe(PASSWORD_POLICY.maxLength);
  });

  it('never accepts a password the login schema would refuse', () => {
    // The invariant, as a property over the inputs that make units and characters disagree: anything creation accepts
    // must be usable at login. It guards the **dangerous** direction — an account that can be created and never used —
    // and it fires if the ceiling is measured on the normalised string (the decomposed case below is accepted by the
    // policy then, and refused by the login schema). The *opposite* mistake, being stricter than the login schema, is
    // caught by the emoji test above; between them, both directions are covered.
    const awkward = [
      'correct horse battery staple',
      '😀'.repeat(200), // 200 code points, 400 UTF-16 units
      '😀'.repeat(PASSWORD_POLICY.maxLength), // exactly at the ceiling
      'e\u0301'.repeat(150), // 300 code points, 150 after NFKC
      'a'.repeat(PASSWORD_POLICY.maxLength),
      '\ud800' + 'a'.repeat(PASSWORD_POLICY.maxLength - 1), // a lone surrogate, which JSON can carry
      '🎉'.repeat(10) + ' long passphrase',
    ];

    for (const password of awkward) {
      const problems = passwordProblems(password);
      const acceptedHere = problems.every((problem) => problem.rule !== 'too-long');
      const acceptedAtLogin = LoginRequestSchema.safeParse({ username: 'admin', password }).success;

      if (acceptedHere) {
        expect(acceptedAtLogin, JSON.stringify([...password]).slice(0, 60)).toBe(true);
      }
    }

    // ...and the other direction is checked too, so the test cannot pass by accepting nothing: at least one of these
    // awkward strings really is accepted for creation.
    expect(
      awkward.filter((password) => passwordProblems(password).length === 0).length,
    ).toBeGreaterThan(2);
  });
});
