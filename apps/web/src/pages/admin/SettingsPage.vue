<script setup lang="ts">
/** Editable application settings (`P5-ADM-02`, `13-ui-ux.md` §4 S13).
 *
 * The page validates both server responses and the complete draft against the shared Zod contract. PATCH contains only
 * changed allow-listed values. The confirmed snapshot is updated optimistically during save and rolled back on failure;
 * the user's draft remains in the form so a failed request never discards typed values.
 *
 * @module pages/admin/SettingsPage
 */

import '@/styles/settings.css';

import {
  AdminSettingCatalogTtlMinutesSchema,
  AdminSettingDiskReserveBytesSchema,
  AdminSettingDisplayNameSchema,
  AdminSettingDownloadsPerMinuteSchema,
  AdminSettingKeepVersionsSchema,
  AdminSettingsResponseSchema,
  AdminSettingsValuesSchema,
  AdminSettingsUpdateSchema,
  type AdminSettingsUpdate,
  type AdminSettingsValues,
} from '@mapirror/shared';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { useNotifications } from '@/stores/notifications';

const SETTINGS_API = '/_admin/api/settings';
const FIELD_NAMES = [
  'displayName',
  'keepVersions',
  'diskReserveBytes',
  'downloadsPerMinute',
  'catalogTtlMinutes',
] as const;
type SettingsField = (typeof FIELD_NAMES)[number];
type SettingsDraft = {
  displayName: string;
  keepVersions: string | number;
  diskReserveBytes: string | number;
  downloadsPerMinute: string | number;
  catalogTtlMinutes: string | number;
};

const FIELD_ERROR_COPY: Record<SettingsField, string> = {
  displayName: 'Enter a display name from 1 to 100 characters.',
  keepVersions: 'Choose a whole number from 1 to 10 versions.',
  diskReserveBytes: 'Enter a non-negative whole number of bytes within the safe integer range.',
  downloadsPerMinute: 'Enter a positive whole number within the safe integer range.',
  catalogTtlMinutes: 'Enter a positive whole number within the safe integer range.',
};

const api = useApi();
const notifications = useNotifications();
const settings = ref<AdminSettingsValues | null>(null);
const draft = reactive<SettingsDraft>({
  displayName: '',
  keepVersions: '',
  diskReserveBytes: '',
  downloadsPerMinute: '',
  catalogTtlMinutes: '',
});
const loading = ref(true);
const loadError = ref<string | null>(null);
const loadRequestId = ref<string | null>(null);
const fieldErrors = ref<Partial<Record<SettingsField, string>>>({});
const saveError = ref<string | null>(null);
const saveRequestId = ref<string | null>(null);
const saveMessage = ref<string | null>(null);
const saving = ref(false);
let loadController: AbortController | undefined;
let loadRequestNumber = 0;
let saveRequestNumber = 0;

function matchesNumber(value: string | number, expected: number): boolean {
  if (typeof value === 'string' && value.trim() === '') return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed === expected;
}

const dirty = computed(() => {
  const current = settings.value;
  return (
    current !== null &&
    (draft.displayName !== current.branding.displayName ||
      !matchesNumber(draft.keepVersions, current.cache.keepVersions) ||
      !matchesNumber(draft.diskReserveBytes, current.cache.diskReserveBytes) ||
      !matchesNumber(draft.downloadsPerMinute, current.public.downloadsPerMinute) ||
      !matchesNumber(draft.catalogTtlMinutes, current.source.catalogTtlMinutes))
  );
});

onMounted(() => void loadSettings());
onUnmounted(() => {
  loadRequestNumber += 1;
  saveRequestNumber += 1;
  loadController?.abort();
});

/** Loads and validates the safe settings projection. A newer request supersedes an older one. */
async function loadSettings(): Promise<void> {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const request = ++loadRequestNumber;
  loading.value = true;
  loadError.value = null;
  loadRequestId.value = null;
  saveMessage.value = null;
  try {
    const response = await api.get<unknown>(SETTINGS_API, { signal: controller.signal });
    if (controller.signal.aborted || request !== loadRequestNumber) return;
    const parsed = AdminSettingsResponseSchema.safeParse(response);
    if (!parsed.success) {
      settings.value = null;
      loadError.value = 'The settings response was not valid. Refresh and try again.';
      return;
    }
    settings.value = parsed.data.settings;
    copyToDraft(parsed.data.settings);
  } catch (cause) {
    if (controller.signal.aborted || request !== loadRequestNumber) return;
    settings.value = null;
    loadError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Settings could not be loaded. Check the connection.';
    loadRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (request === loadRequestNumber) loading.value = false;
  }
}

/** Copies an authoritative or reverted snapshot into the editable form. */
function copyToDraft(values: AdminSettingsValues): void {
  draft.displayName = values.branding.displayName;
  draft.keepVersions = String(values.cache.keepVersions);
  draft.diskReserveBytes = String(values.cache.diskReserveBytes);
  draft.downloadsPerMinute = String(values.public.downloadsPerMinute);
  draft.catalogTtlMinutes = String(values.source.catalogTtlMinutes);
}

/** Converts number inputs only when they contain a complete finite numeric spelling. */
function numberInput(value: string | number): number {
  if (typeof value === 'number') return value;
  if (value.trim() === '') return Number.NaN;
  return Number(value);
}

/** Maps a shared-schema issue path to the corresponding form field. */
function fieldForPath(path: readonly PropertyKey[]): SettingsField | undefined {
  const key = path.join('.');
  const fields: Record<string, SettingsField> = {
    'branding.displayName': 'displayName',
    'cache.keepVersions': 'keepVersions',
    'cache.diskReserveBytes': 'diskReserveBytes',
    'public.downloadsPerMinute': 'downloadsPerMinute',
    'source.catalogTtlMinutes': 'catalogTtlMinutes',
  };
  return fields[key];
}

/** Adds validation feedback to the field named by the shared contract. */
function setValidationErrors(issues: readonly { readonly path: PropertyKey[] }[]): void {
  const next: Partial<Record<SettingsField, string>> = {};
  for (const issue of issues) {
    const field = fieldForPath(issue.path);
    if (field !== undefined) next[field] = FIELD_ERROR_COPY[field];
  }
  fieldErrors.value = next;
  if (Object.keys(next).length > 0) {
    const first = FIELD_NAMES.find((field) => next[field] !== undefined);
    if (first !== undefined) document.getElementById(`settings-${first}`)?.focus();
  }
}

/** Gives the alert a concise summary, including the number of fields when several need correction. */
function validationSummary(): string {
  const count = Object.keys(fieldErrors.value).length;
  if (count > 1) return `${count} settings need attention. Review the highlighted fields.`;
  return 'Review the highlighted setting and correct the value.';
}

/** Builds a complete candidate so every field is validated before any request is sent. */
function parseDraft(): AdminSettingsValues | null {
  const parsed = AdminSettingsValuesSchema.safeParse({
    branding: { displayName: draft.displayName },
    cache: {
      keepVersions: numberInput(draft.keepVersions),
      diskReserveBytes: numberInput(draft.diskReserveBytes),
    },
    public: { downloadsPerMinute: numberInput(draft.downloadsPerMinute) },
    source: { catalogTtlMinutes: numberInput(draft.catalogTtlMinutes) },
  });
  if (!parsed.success) {
    setValidationErrors(parsed.error.issues);
    saveError.value = validationSummary();
    return null;
  }
  return parsed.data;
}

/** Returns only the values that differ from the last confirmed server response. */
function changedValues(
  next: AdminSettingsValues,
  current: AdminSettingsValues,
): AdminSettingsUpdate {
  const update: {
    branding?: { displayName: string };
    cache?: { keepVersions?: number; diskReserveBytes?: number };
    public?: { downloadsPerMinute: number };
    source?: { catalogTtlMinutes: number };
  } = {};
  if (next.branding.displayName !== current.branding.displayName) {
    update.branding = { displayName: next.branding.displayName };
  }
  if (next.cache.keepVersions !== current.cache.keepVersions) {
    update.cache = { ...update.cache, keepVersions: next.cache.keepVersions };
  }
  if (next.cache.diskReserveBytes !== current.cache.diskReserveBytes) {
    update.cache = { ...update.cache, diskReserveBytes: next.cache.diskReserveBytes };
  }
  if (next.public.downloadsPerMinute !== current.public.downloadsPerMinute) {
    update.public = { downloadsPerMinute: next.public.downloadsPerMinute };
  }
  if (next.source.catalogTtlMinutes !== current.source.catalogTtlMinutes) {
    update.source = { catalogTtlMinutes: next.source.catalogTtlMinutes };
  }
  return update;
}

/** Validates, optimistically adopts and PATCHes changed values; failure restores the confirmed snapshot. */
async function saveSettings(): Promise<void> {
  const current = settings.value;
  if (current === null || saving.value) return;

  fieldErrors.value = {};
  saveError.value = null;
  saveRequestId.value = null;
  saveMessage.value = null;
  const next = parseDraft();
  if (next === null) return;

  const update = changedValues(next, current);
  if (Object.keys(update).length === 0) {
    copyToDraft(current);
    return;
  }
  const parsedUpdate = AdminSettingsUpdateSchema.safeParse(update);
  if (!parsedUpdate.success) {
    setValidationErrors(parsedUpdate.error.issues);
    saveError.value = validationSummary();
    return;
  }

  const request = ++saveRequestNumber;
  const confirmed = current;
  settings.value = next;
  copyToDraft(next);
  saving.value = true;
  saveMessage.value = 'Saving settings…';
  try {
    const response = await api.patch<unknown>(SETTINGS_API, parsedUpdate.data);
    if (request !== saveRequestNumber) return;
    const parsed = AdminSettingsResponseSchema.safeParse(response);
    if (!parsed.success) {
      settings.value = confirmed;
      saveMessage.value = null;
      saveError.value =
        'The saved settings response was not valid. Your edits are still in the form.';
      return;
    }
    settings.value = parsed.data.settings;
    copyToDraft(parsed.data.settings);
    saveMessage.value = 'Settings saved.';
    notifications.success('Settings saved.');
  } catch (cause) {
    if (request !== saveRequestNumber) return;
    settings.value = confirmed;
    saveMessage.value = null;
    saveError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Settings could not be saved. Check the connection and try again.';
    saveRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (request === saveRequestNumber) saving.value = false;
  }
}

/** Clears validation feedback as a user edits that field. */
function clearFieldError(field: SettingsField): void {
  if (fieldErrors.value[field] === undefined) return;
  const next = { ...fieldErrors.value };
  delete next[field];
  fieldErrors.value = next;
  if (Object.keys(next).length === 0) saveError.value = null;
}

/** Validates the field after it loses focus, without marking untouched fields invalid. */
function validateField(field: SettingsField): void {
  const value =
    field === 'displayName'
      ? draft.displayName
      : field === 'keepVersions'
        ? numberInput(draft.keepVersions)
        : field === 'diskReserveBytes'
          ? numberInput(draft.diskReserveBytes)
          : field === 'downloadsPerMinute'
            ? numberInput(draft.downloadsPerMinute)
            : numberInput(draft.catalogTtlMinutes);
  const valid =
    field === 'displayName'
      ? AdminSettingDisplayNameSchema.safeParse(value).success
      : field === 'keepVersions'
        ? AdminSettingKeepVersionsSchema.safeParse(value).success
        : field === 'diskReserveBytes'
          ? AdminSettingDiskReserveBytesSchema.safeParse(value).success
          : field === 'downloadsPerMinute'
            ? AdminSettingDownloadsPerMinuteSchema.safeParse(value).success
            : AdminSettingCatalogTtlMinutesSchema.safeParse(value).success;
  if (valid) {
    clearFieldError(field);
    return;
  }
  fieldErrors.value = { ...fieldErrors.value, [field]: FIELD_ERROR_COPY[field] };
  saveError.value = validationSummary();
}

/** Restores the last server-confirmed values without making a request. */
function discardChanges(): void {
  if (settings.value === null || saving.value) return;
  copyToDraft(settings.value);
  fieldErrors.value = {};
  saveError.value = null;
  saveRequestId.value = null;
  saveMessage.value = null;
}
</script>

<template>
  <v-container class="mm-settings-page py-8" max-width="var(--mm-container-admin)">
    <header class="mm-settings-heading">
      <div>
        <h1 class="mm-display">Settings</h1>
        <p class="mm-settings-intro">
          Edit the settings saved for MapMirror. Only the values shown here are editable; secrets
          are never returned by this page.
        </p>
      </div>
      <span v-if="dirty && !saving" class="mm-settings-unsaved">Unsaved changes</span>
    </header>

    <p v-if="saveMessage" class="mm-settings-status" role="status" aria-live="polite">
      {{ saveMessage }}
    </p>

    <p v-if="loading && settings === null" class="sr-only" role="status">Loading settings…</p>
    <section
      v-if="loading && settings === null"
      class="mm-settings-skeleton-grid"
      aria-busy="true"
      aria-hidden="true"
    >
      <article v-for="index in 4" :key="index" class="mm-settings-card mm-settings-skeleton-card">
        <span class="mm-settings-skeleton mm-settings-skeleton-title" />
        <span class="mm-settings-skeleton mm-settings-skeleton-copy" />
        <span class="mm-settings-skeleton mm-settings-skeleton-field" />
        <span class="mm-settings-skeleton mm-settings-skeleton-field" />
      </article>
    </section>

    <section v-else-if="loadError" class="mm-settings-state" role="alert">
      <h2>Settings could not be loaded</h2>
      <p>{{ loadError }}</p>
      <p v-if="loadRequestId" class="mm-mono">Request ID: {{ loadRequestId }}</p>
      <button
        class="mm-settings-button mm-settings-button--primary"
        type="button"
        @click="loadSettings"
      >
        Retry
      </button>
    </section>

    <form
      v-else-if="settings !== null"
      class="mm-settings-form"
      novalidate
      @submit.prevent="saveSettings"
    >
      <div v-if="saveError" class="mm-settings-alert" role="alert">
        <p>{{ saveError }}</p>
        <p v-if="saveRequestId" class="mm-mono">Request ID: {{ saveRequestId }}</p>
        <p v-if="dirty && !saving" class="mm-settings-help">
          Your edits are still in the form. Correct them or try saving again.
        </p>
      </div>

      <div class="mm-settings-grid">
        <section class="mm-settings-card" aria-labelledby="settings-branding-heading">
          <div class="mm-settings-card-heading">
            <h2 id="settings-branding-heading">Branding</h2>
            <p>Choose the name shown across the public site.</p>
          </div>
          <label class="mm-settings-field" for="settings-displayName">
            <span>Display name</span>
            <input
              id="settings-displayName"
              v-model="draft.displayName"
              type="text"
              maxlength="100"
              autocomplete="organization"
              required
              :aria-invalid="fieldErrors.displayName !== undefined"
              :aria-describedby="
                fieldErrors.displayName
                  ? 'settings-displayName-hint settings-displayName-error'
                  : 'settings-displayName-hint'
              "
              :disabled="saving"
              @input="clearFieldError('displayName')"
              @blur="validateField('displayName')"
            />
            <small id="settings-displayName-hint"
              >1–100 characters. Leading and trailing spaces are removed when saved.</small
            >
            <small
              v-if="fieldErrors.displayName"
              id="settings-displayName-error"
              class="mm-settings-field-error"
            >
              {{ fieldErrors.displayName }}
            </small>
          </label>
        </section>

        <section class="mm-settings-card" aria-labelledby="settings-cache-heading">
          <div class="mm-settings-card-heading">
            <h2 id="settings-cache-heading">Cache and retention</h2>
            <p>Choose the saved version-retention default and disk-space reserve.</p>
          </div>
          <label class="mm-settings-field" for="settings-keepVersions">
            <span>Versions to retain</span>
            <input
              id="settings-keepVersions"
              v-model="draft.keepVersions"
              type="number"
              inputmode="numeric"
              min="1"
              max="10"
              step="1"
              required
              :aria-invalid="fieldErrors.keepVersions !== undefined"
              :aria-describedby="
                fieldErrors.keepVersions
                  ? 'settings-keepVersions-hint settings-keepVersions-error'
                  : 'settings-keepVersions-hint'
              "
              :disabled="saving"
              @input="clearFieldError('keepVersions')"
              @blur="validateField('keepVersions')"
            />
            <small id="settings-keepVersions-hint">Choose from 1 to 10 versions.</small>
            <small
              v-if="fieldErrors.keepVersions"
              id="settings-keepVersions-error"
              class="mm-settings-field-error"
            >
              {{ fieldErrors.keepVersions }}
            </small>
          </label>
          <label class="mm-settings-field" for="settings-diskReserveBytes">
            <span>Disk reserve (bytes)</span>
            <input
              id="settings-diskReserveBytes"
              v-model="draft.diskReserveBytes"
              type="number"
              inputmode="numeric"
              min="0"
              max="9007199254740991"
              step="1"
              required
              :aria-invalid="fieldErrors.diskReserveBytes !== undefined"
              :aria-describedby="
                fieldErrors.diskReserveBytes
                  ? 'settings-diskReserveBytes-hint settings-diskReserveBytes-error'
                  : 'settings-diskReserveBytes-hint'
              "
              :disabled="saving"
              @input="clearFieldError('diskReserveBytes')"
              @blur="validateField('diskReserveBytes')"
            />
            <small id="settings-diskReserveBytes-hint"
              >Whole bytes; zero disables the reserve threshold.</small
            >
            <small
              v-if="fieldErrors.diskReserveBytes"
              id="settings-diskReserveBytes-error"
              class="mm-settings-field-error"
            >
              {{ fieldErrors.diskReserveBytes }}
            </small>
          </label>
        </section>

        <section class="mm-settings-card" aria-labelledby="settings-public-heading">
          <div class="mm-settings-card-heading">
            <h2 id="settings-public-heading">Public downloads</h2>
            <p>Set the saved anonymous download limit for each client IP.</p>
          </div>
          <label class="mm-settings-field" for="settings-downloadsPerMinute">
            <span>Downloads per minute</span>
            <input
              id="settings-downloadsPerMinute"
              v-model="draft.downloadsPerMinute"
              type="number"
              inputmode="numeric"
              min="1"
              max="9007199254740991"
              step="1"
              required
              :aria-invalid="fieldErrors.downloadsPerMinute !== undefined"
              :aria-describedby="
                fieldErrors.downloadsPerMinute
                  ? 'settings-downloadsPerMinute-hint settings-downloadsPerMinute-error'
                  : 'settings-downloadsPerMinute-hint'
              "
              :disabled="saving"
              @input="clearFieldError('downloadsPerMinute')"
              @blur="validateField('downloadsPerMinute')"
            />
            <small id="settings-downloadsPerMinute-hint">A positive whole number.</small>
            <small
              v-if="fieldErrors.downloadsPerMinute"
              id="settings-downloadsPerMinute-error"
              class="mm-settings-field-error"
            >
              {{ fieldErrors.downloadsPerMinute }}
            </small>
          </label>
        </section>

        <section class="mm-settings-card" aria-labelledby="settings-source-heading">
          <div class="mm-settings-card-heading">
            <h2 id="settings-source-heading">Source catalog</h2>
            <p>Set the saved default time-to-live for the Geofabrik catalog.</p>
          </div>
          <label class="mm-settings-field" for="settings-catalogTtlMinutes">
            <span>Refresh interval (minutes)</span>
            <input
              id="settings-catalogTtlMinutes"
              v-model="draft.catalogTtlMinutes"
              type="number"
              inputmode="numeric"
              min="1"
              max="9007199254740991"
              step="1"
              required
              :aria-invalid="fieldErrors.catalogTtlMinutes !== undefined"
              :aria-describedby="
                fieldErrors.catalogTtlMinutes
                  ? 'settings-catalogTtlMinutes-hint settings-catalogTtlMinutes-error'
                  : 'settings-catalogTtlMinutes-hint'
              "
              :disabled="saving"
              @input="clearFieldError('catalogTtlMinutes')"
              @blur="validateField('catalogTtlMinutes')"
            />
            <small id="settings-catalogTtlMinutes-hint">A positive whole number of minutes.</small>
            <small
              v-if="fieldErrors.catalogTtlMinutes"
              id="settings-catalogTtlMinutes-error"
              class="mm-settings-field-error"
            >
              {{ fieldErrors.catalogTtlMinutes }}
            </small>
          </label>
        </section>
      </div>

      <div class="mm-settings-actions">
        <p class="mm-settings-help">
          Changes are stored only after you save. Secret values are managed outside this page.
        </p>
        <div class="mm-settings-action-buttons">
          <button
            class="mm-settings-button mm-settings-button--secondary"
            type="button"
            :disabled="!dirty || saving"
            @click="discardChanges"
          >
            Discard changes
          </button>
          <button
            class="mm-settings-button mm-settings-button--primary"
            type="submit"
            :disabled="!dirty || saving || loading"
          >
            {{ saving ? 'Saving…' : 'Save settings' }}
          </button>
        </div>
      </div>
    </form>
  </v-container>
</template>
