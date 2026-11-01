<script setup lang="ts">
/**
 * Searchable, paginated admin audit log (`P5-ADM-04`, `13-ui-ux.md` §4 S14).
 *
 * Action and page state are kept in the URL so links, refresh, and browser history retain the selected view. CSV export
 * includes only the safe entries on the visible page; the API response intentionally contains no IP or credentials.
 *
 * @module pages/admin/AuditPage
 */

import {
  AUDIT_ACTION_VALUES,
  AuditListResponseSchema,
  type AuditEntry,
  type AuditListResponse,
} from '@mapirror/shared';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import {
  auditActionLabel,
  downloadAuditCsv,
  formatAuditDate,
  formatAuditMetadata,
} from '@/audit/presentation';

const PAGE_SIZE = 25;
const ACTION_FILTER_VALUES = AUDIT_ACTION_VALUES;
const route = useRoute();
const router = useRouter();
const api = useApi();
const result = ref<AuditListResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryNumber = ref(0);
let controller: AbortController | undefined;
let requestNumber = 0;

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pageFromQuery(value: unknown): number {
  const text = queryText(value);
  if (text === undefined || !/^\d+$/u.test(text)) return 1;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

const actionFilter = computed(() => {
  const value = queryText(route.query.action)?.trim();
  return value !== undefined && value.length > 0 && value.length <= 128 ? value : '';
});
const page = computed(() => pageFromQuery(route.query.page));
const KNOWN_ACTION_VALUES: readonly string[] = ACTION_FILTER_VALUES;
const actionOptions = computed<readonly string[]>(() =>
  actionFilter.value !== '' && !KNOWN_ACTION_VALUES.includes(actionFilter.value)
    ? [...ACTION_FILTER_VALUES, actionFilter.value]
    : ACTION_FILTER_VALUES,
);

/** Fetches a validated page; an aborted or superseded request can never replace newer URL state. */
async function loadAuditLog(): Promise<void> {
  controller?.abort();
  const requestController = new AbortController();
  controller = requestController;
  const currentRequest = ++requestNumber;
  loading.value = result.value === null;
  errorMessage.value = null;
  errorRequestId.value = null;

  const query: Record<string, string | number> = { page: page.value, limit: PAGE_SIZE };
  if (actionFilter.value !== '') query.action = actionFilter.value;
  try {
    const response = await api.get<unknown>('/_admin/api/audit', {
      query,
      signal: requestController.signal,
    });
    if (requestController.signal.aborted || currentRequest !== requestNumber) return;
    const parsed = AuditListResponseSchema.safeParse(response);
    if (!parsed.success) {
      errorMessage.value = "We couldn't read the audit log.";
      errorRequestId.value = null;
      return;
    }
    const lastPage = Math.max(1, parsed.data.meta.totalPages);
    if (page.value > lastPage) {
      await setPage(lastPage);
      return;
    }
    result.value = parsed.data;
  } catch (cause) {
    if (requestController.signal.aborted || currentRequest !== requestNumber) return;
    if (cause instanceof ApiError) {
      errorMessage.value = cause.message;
      errorRequestId.value = cause.requestId;
    } else {
      errorMessage.value = 'The audit log could not be loaded. Check the connection and retry.';
      errorRequestId.value = null;
    }
  } finally {
    if (currentRequest === requestNumber) {
      loading.value = false;
      if (controller === requestController) controller = undefined;
    }
  }
}

function actionChanged(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value;
  if (typeof value === 'string') void updateAction(value);
}

async function updateAction(value: string): Promise<void> {
  const query = { ...route.query };
  if (value === '') delete query.action;
  else query.action = value;
  delete query.page;
  await router.replace({ name: 'admin-audit', query });
}

async function setPage(nextPage: number): Promise<void> {
  const bounded = Math.max(1, nextPage);
  await router.replace({ name: 'admin-audit', query: { ...route.query, page: String(bounded) } });
}

function retry(): void {
  retryNumber.value += 1;
}

function exportCurrentPage(): void {
  if (result.value === null || result.value.data.length === 0 || loading.value) return;
  downloadAuditCsv(result.value.data, result.value.meta.page);
}

function targetLabel(entry: AuditEntry): string {
  if (entry.targetType === null && entry.targetId === null) return '—';
  if (entry.targetType === null) return entry.targetId ?? '—';
  if (entry.targetId === null) return entry.targetType;
  return `${entry.targetType} · ${entry.targetId}`;
}

onUnmounted(() => controller?.abort());

watch(
  () => [route.query.action, route.query.page] as const,
  () => {
    controller?.abort();
    result.value = null;
    void loadAuditLog();
  },
  { immediate: true },
);

watch(retryNumber, () => void loadAuditLog());
</script>

<template>
  <main class="mm-audit-page" aria-labelledby="mm-audit-title">
    <header class="mm-audit-heading">
      <div>
        <p class="mm-caption mb-2">Administration · Accountability</p>
        <h1 id="mm-audit-title" class="mm-display">Audit log</h1>
        <p class="mm-body-public mm-audit-intro">
          Review admin and system activity. IP addresses and credentials are never shown.
        </p>
      </div>
      <v-btn variant="tonal" :disabled="loading" @click="retry">Refresh</v-btn>
    </header>

    <section class="mm-audit-toolbar" aria-label="Audit log controls">
      <div class="mm-audit-filter">
        <label for="mm-audit-action">Action</label>
        <select id="mm-audit-action" :value="actionFilter" @change="actionChanged">
          <option value="">All actions</option>
          <option v-for="action in actionOptions" :key="action" :value="action">
            {{ auditActionLabel(action) }}
          </option>
        </select>
      </div>
      <span class="mm-caption mm-audit-count" :aria-live="result ? 'polite' : 'off'">
        {{
          result
            ? `${result.meta.total.toLocaleString('en-GB')} ${result.meta.total === 1 ? 'entry' : 'entries'}`
            : 'Loading audit entries…'
        }}
      </span>
      <v-btn
        variant="tonal"
        :disabled="result === null || result.data.length === 0 || loading"
        @click="exportCurrentPage"
      >
        Export this page (CSV)
      </v-btn>
    </section>

    <div v-if="loading && result === null" class="mm-audit-loading">
      <p class="sr-only" role="status">Loading audit entries…</p>
      <div class="mm-audit-skeleton" aria-busy="true" aria-hidden="true">
        <div class="mm-audit-table-wrap">
          <table class="mm-audit-table">
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in 5" :key="row">
                <td v-for="column in 5" :key="column">
                  <span class="mm-audit-skeleton-line" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mm-audit-mobile-list">
          <article v-for="card in 3" :key="card" class="mm-audit-mobile-card">
            <span class="mm-audit-skeleton-line mm-audit-skeleton-wide" />
            <span class="mm-audit-skeleton-line" />
            <span class="mm-audit-skeleton-line mm-audit-skeleton-medium" />
          </article>
        </div>
      </div>
    </div>

    <section v-else-if="errorMessage && result === null" class="mm-audit-state" role="alert">
      <h2 class="mm-heading">Audit log could not be loaded</h2>
      <p class="mm-body-public">{{ errorMessage }}</p>
      <p v-if="errorRequestId" class="mm-caption">Request ID: {{ errorRequestId }}</p>
      <v-btn class="mt-3" variant="tonal" @click="retry">Retry</v-btn>
    </section>

    <div v-else-if="result" class="mm-audit-results" :aria-busy="loading">
      <p v-if="errorMessage" class="mm-audit-refresh-error" role="status">
        {{ errorMessage }} The last successful page is still shown.
        <span v-if="errorRequestId">Request ID: {{ errorRequestId }}</span>
      </p>

      <section v-if="result.data.length === 0" class="mm-audit-state" role="status">
        <h2 class="mm-heading">
          {{ actionFilter === '' ? 'No audit entries yet' : 'No entries match this action' }}
        </h2>
        <p class="mm-body-public">
          {{
            actionFilter === ''
              ? 'Activity will appear here as administrators and background services make changes.'
              : 'Choose another action or clear the filter to see the full audit log.'
          }}
        </p>
        <v-btn v-if="actionFilter !== ''" variant="tonal" @click="updateAction('')">
          Clear action filter
        </v-btn>
      </section>

      <template v-else>
        <div class="mm-audit-table-wrap">
          <table class="mm-audit-table">
            <caption class="sr-only">
              Admin and system audit entries, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in result.data" :key="entry.id">
                <td class="mm-audit-time">
                  <time :datetime="entry.createdAt">{{ formatAuditDate(entry.createdAt) }}</time>
                </td>
                <td class="mm-audit-actor">{{ entry.actorName }}</td>
                <td>
                  <span class="mm-audit-action">{{ auditActionLabel(entry.action) }}</span>
                  <span class="mm-audit-action-code mm-mono">{{ entry.action }}</span>
                </td>
                <td class="mm-audit-target mm-mono">{{ targetLabel(entry) }}</td>
                <td>
                  <details v-if="Object.keys(entry.metadata).length > 0" class="mm-audit-details">
                    <summary>View details</summary>
                    <pre>{{ formatAuditMetadata(entry.metadata) }}</pre>
                  </details>
                  <span v-else class="mm-caption">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mm-audit-mobile-list">
          <article
            v-for="entry in result.data"
            :key="`mobile-${entry.id}`"
            class="mm-audit-mobile-card"
          >
            <div class="mm-audit-mobile-heading">
              <strong>{{ auditActionLabel(entry.action) }}</strong>
              <time :datetime="entry.createdAt">{{ formatAuditDate(entry.createdAt) }}</time>
            </div>
            <dl class="mm-audit-facts">
              <div>
                <dt>Actor</dt>
                <dd>{{ entry.actorName }}</dd>
              </div>
              <div>
                <dt>Action</dt>
                <dd class="mm-mono">{{ entry.action }}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd class="mm-mono">{{ targetLabel(entry) }}</dd>
              </div>
            </dl>
            <details v-if="Object.keys(entry.metadata).length > 0" class="mm-audit-details">
              <summary>View details</summary>
              <pre>{{ formatAuditMetadata(entry.metadata) }}</pre>
            </details>
          </article>
        </div>

        <nav class="mm-audit-pagination" aria-label="Audit log pages">
          <span class="mm-caption">
            Page {{ result.meta.page }} of {{ result.meta.totalPages }}
          </span>
          <div class="mm-audit-page-buttons">
            <v-btn :disabled="page <= 1 || loading" variant="tonal" @click="setPage(page - 1)">
              Previous
            </v-btn>
            <v-btn
              :disabled="page >= result.meta.totalPages || loading"
              variant="tonal"
              @click="setPage(page + 1)"
            >
              Next
            </v-btn>
          </div>
        </nav>
      </template>
    </div>
  </main>
</template>
