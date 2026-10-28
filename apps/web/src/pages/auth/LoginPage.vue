<script setup lang="ts">
/**
 * The sign-in screen (`P1-WEB-06`, `13-ui-ux.md` §4 S1).
 *
 * One form, and every rule it implements is a sentence from the documents rather than a preference:
 *
 * | Rule | Where it comes from | Here |
 * |---|---|---|
 * | the fields are the API's | `04-api.md` §1 | both validated with the **shared** `LoginRequestSchema` — the same object the API parses, so a rule cannot differ between the two sides |
 * | validate on blur, and on submit | §6 | a field shows its error once it has been left, or once the form has been submitted; never while it is being typed |
 * | a summary when several fields fail | §6 | one line above the form, and both fields marked |
 * | never lose typed data | §6 | nothing is cleared on failure, including the password: focusing the field and keeping the characters is how a mistyped password gets fixed |
 * | Enter submits | §6, and the task's criterion | the form is a real `<form>` with a `type="submit"` button, so the browser does it — no key handler to forget |
 * | errors say what failed, why, and what to do | §5 | one `role="alert"` region, with the request id in small mono text for support; Vuetify's `VAlert` already emits that role, and the page states it anyway so the guarantee is the page's rather than a library default's |
 * | errors are tied to their field | §7 | Vuetify's `aria-describedby` on the input, asserted in `tests/login-page.spec.ts` |
 * | no icon the app cannot draw | §5, `ToastHost.vue`'s note | **Material Design icons are not installed**: no `@mdi/font`, and the built CSS has no `.mdi` rule at all, so `icon="mdi-eye"` renders an empty `<i>` — a control a sighted person cannot see and only a screen reader can find. The show/hide toggle is therefore a labelled text button (the toast's "Dismiss" is the same decision), and the alert turns Vuetify's default `$close-circle` off rather than leaving a gap where a glyph would be. `tests/login-page.spec.ts` asserts the page renders **no `.mdi` element**, so re-introducing one fails |
 *
 * ## What the page does *not* do
 *
 * It does not decide whether the session is valid. The token from `POST /_auth/api/login` goes into the auth store
 * (`P1-WEB-05`), the store is what the router's guard and the API client read, and the first `/_admin/api/*` request is
 * what proves the token works. The screen's whole job is to turn a form into that token, or into a sentence.
 *
 * The `redirect` parameter is attacker input (the login page is public), so it is read through `safeRedirectTarget` — the
 * same function the guard writes it with (`router/redirect.ts` says why both sides must check).
 *
 * @module pages/auth/LoginPage
 */

import {
  LoginRateLimitDetailsSchema,
  LoginRequestSchema,
  LoginResponseSchema,
} from '@mapirror/shared';
import { useIntervalFn } from '@vueuse/core';
import { computed, onMounted, reactive, ref, useTemplateRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { errorCopyFor } from '@/api/error-copy';
import { ApiError, validationIssues } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { safeRedirectTarget } from '@/router/redirect';
import { useAuth } from '@/stores/auth';
import { useNotifications } from '@/stores/notifications';

/** `POST /_auth/api/login` (`04-api.md` §1). Named here because this page is its only caller. */
const LOGIN_API = '/_auth/api/login';

/** The two fields, as the schema names them. */
type Field = 'username' | 'password';

/** What a failed attempt shows: what happened, what to do, and how to quote it. */
interface Failure {
  readonly message: string;
  readonly detail: string | null;
  readonly requestId: string | null;
}

const route = useRoute();
const router = useRouter();
const client = useApi();
const auth = useAuth();
const notifications = useNotifications();

const username = ref('');
const password = ref('');
const showPassword = ref(false);

/** Whether a field has been left at least once — the "validate on blur" half. */
const left = reactive<Record<Field, boolean>>({ username: false, password: false });

/** Whether the form has been submitted at least once — the other half. */
const submitted = ref(false);

const submitting = ref(false);
const failure = ref<Failure | null>(null);

/** Field errors the API sent back (`VALIDATION_ERROR`), which outrank the local parse until the value changes. */
const serverErrors = reactive<Record<Field, string | null>>({ username: null, password: null });

// Only `focus()` is used, so only `focus()` is claimed: the template ref is a component instance, and typing it as the
// whole of `VTextField` would let this page call anything the component happens to expose.
const usernameField = useTemplateRef<{ focus: () => void }>('usernameField');
const passwordField = useTemplateRef<{ focus: () => void }>('passwordField');

/** Where to go after signing in: the validated `redirect`, or the dashboard. */
const destination = computed(() => safeRedirectTarget(route.query['redirect']));

/** Whether the form is ready to be used at all — the page is for people without a session. */
const alreadySignedIn = computed(() => auth.isAuthenticated);

/**
 * The current values, parsed by the API's own schema.
 *
 * One parse for both fields: a second, hand-written rule set is how a form and an endpoint start disagreeing about what a
 * username is, and the disagreement is invisible until someone types the edge case.
 */
const parsed = computed(() =>
  LoginRequestSchema.safeParse({ username: username.value, password: password.value }),
);

/**
 * The message for one field, or `null`.
 *
 * @param field - The field to ask about.
 * @returns The sentence to show, or `null` when the field is fine, untouched, or not yet submitted.
 */
function errorFor(field: Field): string | null {
  if (serverErrors[field] !== null) return serverErrors[field];
  if (!submitted.value && !left[field]) return null;
  if (parsed.value.success) return null;
  return parsed.value.error.issues.find((issue) => issue.path[0] === field)?.message ?? null;
}

/** The line above the form: §6 asks for a summary rather than leaving the reader to find every mark. */
const summary = computed(() => {
  const failing = (['username', 'password'] as const).filter((field) => errorFor(field) !== null);
  if (failing.length === 0) return null;
  return failing.length === 1 ? 'One field needs attention.' : 'Two fields need attention.';
});

/**
 * The instant a rate limit lifts, in epoch milliseconds — `0` when the form is not limited.
 *
 * Held as a *deadline* rather than a countdown, because a counter that is decremented once per interval drifts: a
 * background tab throttles timers to once a minute, and a decrementing counter would then promise a retry that is still
 * an hour away.
 */
const retryAt = ref(0);
const now = ref(Date.now());

const { pause, resume } = useIntervalFn(
  () => {
    now.value = Date.now();
    // Re-enable the form the moment the deadline passes, and stop the timer so an idle page is not waking up.
    if (now.value >= retryAt.value) {
      retryAt.value = 0;
      pause();
    }
  },
  1_000,
  { immediate: false },
);

/** Whole seconds until the form may be used again; `0` when it may be used now. */
const lockedFor = computed(() => Math.max(0, Math.ceil((retryAt.value - now.value) / 1_000)));

/** `m:ss`, because a person reads a clock and a machine reads seconds. */
const lockedForClock = computed(() => {
  const seconds = lockedFor.value;
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
});

/** The sentence shown while the form is limited — recomputed every second, so the number on screen is true. */
const failureText = computed(() => {
  if (failure.value === null) return null;
  if (lockedFor.value === 0) return failure.value.detail;
  return `Try again in ${lockedForClock.value}.`;
});

/** What the reader is told after a refusal: the plain sentence, then the next step. */
const REFUSALS: Readonly<Record<string, Failure>> = {
  INVALID_CREDENTIALS: {
    message: errorCopyFor('INVALID_CREDENTIALS').message,
    detail: errorCopyFor('INVALID_CREDENTIALS').action,
    requestId: null,
  },
  ACCOUNT_DISABLED: {
    message: errorCopyFor('ACCOUNT_DISABLED').message,
    detail: errorCopyFor('ACCOUNT_DISABLED').action,
    requestId: null,
  },
};

/**
 * Turns any failure into something a person can act on.
 *
 * @param cause - Whatever the client threw: always an `ApiError`, but not assumed.
 */
function showFailure(cause: unknown): void {
  if (!(cause instanceof ApiError)) {
    const copy = errorCopyFor('UNKNOWN');
    failure.value = { message: copy.message, detail: copy.action, requestId: null };
    return;
  }

  const known = REFUSALS[cause.code];
  if (known !== undefined) {
    failure.value = { ...known, requestId: cause.requestId };
    // The refusal is about the pair, and the password is the half people mistype; its characters are left alone.
    passwordField.value?.focus();
    return;
  }

  if (cause.code === 'RATE_LIMITED') {
    // `retryAfterSeconds` authoritative, because it is the number the `Retry-After` header carries; the schema check is
    // what keeps a proxy's HTML error page from being read as a number.
    const details = LoginRateLimitDetailsSchema.safeParse(cause.details);
    const seconds = details.success ? details.data.retryAfterSeconds : 30;
    failure.value = { message: 'Too many attempts.', detail: null, requestId: cause.requestId };
    now.value = Date.now();
    retryAt.value = now.value + seconds * 1_000;
    resume();
    return;
  }

  if (cause.code === 'VALIDATION_ERROR') {
    // The server has the last word on its own schema, and the issue's `path` is the field name.
    for (const issue of validationIssues(cause)) {
      if (issue.path === 'username' || issue.path === 'password')
        serverErrors[issue.path] = issue.message;
    }
    failure.value = null;
    return;
  }

  // Every remaining documented code uses the shared human copy and next-step guidance; the machine code stays hidden.
  const copy = errorCopyFor(cause.code);
  failure.value = { message: copy.message, detail: copy.action, requestId: cause.requestId };
}

/** Clears the server's field errors as soon as the reader changes the field they describe. */
function forgetServerErrors(): void {
  serverErrors.username = null;
  serverErrors.password = null;
}

/** Runs on every keystroke: a live "nothing here" error is noise, and a stale one is a lie. */
function onInput(): void {
  forgetServerErrors();
}

/**
 * Submits the form.
 *
 * Called by the form's own `submit` event, which is what makes Enter work: the browser fires it for a `type="submit"`
 * button and for Enter in a single-line input, and no key handler has to agree with either.
 */
async function submit(): Promise<void> {
  if (submitting.value || lockedFor.value > 0) return;

  submitted.value = true;
  failure.value = null;
  forgetServerErrors();

  const request = parsed.value;
  if (!request.success) {
    // Focus the first field that is wrong, so a keyboard user is taken to the problem rather than told it exists.
    if (request.error.issues.some((issue) => issue.path[0] === 'username'))
      usernameField.value?.focus();
    else passwordField.value?.focus();
    return;
  }

  submitting.value = true;
  try {
    const payload = await client.post<unknown>(LOGIN_API, request.data);
    // The body crossed the network: it is a profile and a token only if the shared schema says so (`09-development.md` §9).
    const answer = LoginResponseSchema.safeParse(payload);
    if (!answer.success) {
      failure.value = {
        message: 'The server sent an answer this page could not read.',
        detail: 'Try again. If it keeps happening, the server and this page are out of step.',
        requestId: null,
      };
      return;
    }

    // A session that cannot be persisted still works for this tab (`stores/auth.ts`), and saying so is the difference
    // between "weird, it forgot me" and a warning the reader has already seen.
    if (!auth.signIn(answer.data)) {
      notifications.push({
        message:
          'This browser is not keeping the session: you will be signed out when this tab closes.',
      });
    }

    // `replace`, not `push`: the login form is not a page the back button should return to.
    await router.replace(destination.value);
  } catch (cause) {
    showFailure(cause);
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  // The one field a visitor came to fill. `autofocus` is not used: it would also fire on a re-render, and Vuetify's own
  // focus path is what makes the label animate correctly.
  usernameField.value?.focus();
});
</script>

<template>
  <v-container class="py-12" max-width="var(--mm-container-public)">
    <v-row justify="center">
      <v-col cols="12" sm="10" md="6">
        <p class="mm-caption mb-2">MapMirror</p>
        <h1 class="mm-display mb-2">Sign in</h1>
        <p class="mm-body-public mm-text-secondary mb-6">
          Administration. Reading and downloading published maps needs no account.
        </p>

        <v-card border flat rounded="lg">
          <v-card-text>
            <p v-if="alreadySignedIn" class="mm-body-public mb-4">
              You are already signed in.
              <v-btn :to="destination" class="ml-2" size="small" variant="text">Continue</v-btn>
            </p>

            <v-alert
              v-if="failure"
              class="mb-5"
              density="comfortable"
              :icon="false"
              role="alert"
              type="error"
              variant="tonal"
            >
              <p class="mm-body-public mb-1">{{ failure.message }}</p>
              <p v-if="failureText" class="mm-caption mb-1">{{ failureText }}</p>
              <p v-else-if="lockedFor > 0" class="mm-caption mb-1">
                Try again in {{ lockedForClock }}.
              </p>
              <p v-if="failure.requestId" class="mm-mono ma-0">
                Request ID: {{ failure.requestId }}
              </p>
            </v-alert>

            <p v-if="summary" class="mm-caption mb-3" role="alert">{{ summary }}</p>

            <v-form novalidate @submit.prevent="submit">
              <v-text-field
                ref="usernameField"
                v-model="username"
                autocomplete="username"
                :error-messages="errorFor('username') ?? []"
                label="Username"
                name="username"
                @blur="left.username = true"
                @update:model-value="onInput"
              />

              <v-text-field
                ref="passwordField"
                v-model="password"
                autocomplete="current-password"
                :error-messages="errorFor('password') ?? []"
                label="Password"
                name="password"
                :type="showPassword ? 'text' : 'password'"
                @blur="left.password = true"
                @update:model-value="onInput"
              >
                <template #append-inner>
                  <v-btn
                    :aria-pressed="showPassword"
                    class="mr-n2"
                    size="small"
                    type="button"
                    variant="text"
                    @click="showPassword = !showPassword"
                  >
                    {{ showPassword ? 'Hide' : 'Show' }}
                  </v-btn>
                </template>
              </v-text-field>

              <v-btn
                block
                class="mt-2"
                color="primary"
                :disabled="lockedFor > 0"
                :loading="submitting"
                size="large"
                type="submit"
              >
                Sign in
              </v-btn>
            </v-form>
          </v-card-text>
        </v-card>

        <p class="mm-caption mt-4 mb-0">
          Sessions last twelve hours. Closing the tab signs this browser out.
        </p>
      </v-col>
    </v-row>
  </v-container>
</template>
