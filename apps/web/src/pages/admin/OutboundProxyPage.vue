<script setup lang="ts">
/** Configure the server's outbound proxy and verify the complete Geofabrik request path (`P6-OPS-04`, S16).
 *
 * Draft checks never change the current route. Applying persists and activates the endpoint before the same five bounded
 * checks run through it; failed checks remain visible without silently undoing the explicit apply.
 *
 * @module pages/admin/OutboundProxyPage
 */

import {
  ProxyApplyResponseSchema,
  ProxyConfigurationSchema,
  ProxyEndpointSchema,
  ProxyHealthReportSchema,
  type ProxyConfiguration,
  type ProxyHealthReport,
} from '@mapirror/shared';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';

const PROXY_API = '/_admin/api/network/proxy';
const api = useApi();
const configuration = ref<ProxyConfiguration | null>(null);
const draft = ref('');
const health = ref<ProxyHealthReport | null>(null);
const loading = ref(true);
const busy = ref(false);
const loadError = ref<string | null>(null);
const loadRequestId = ref<string | null>(null);
const operationError = ref<string | null>(null);
const operationRequestId = ref<string | null>(null);
const operationMessage = ref<string | null>(null);
const operationMessageType = ref<'success' | 'warning'>('success');
const operationController = ref<AbortController | null>(null);
let loadController: AbortController | undefined;

const parsedDraft = computed(() => {
  const value = draft.value.trim();
  return value === '' ? null : ProxyEndpointSchema.safeParse(value);
});
const draftError = computed(() => {
  if (draft.value.trim() === '') return '';
  const parsed = parsedDraft.value;
  return parsed?.success === false
    ? (parsed.error.issues[0]?.message ?? 'Enter a valid proxy endpoint.')
    : '';
});
const canApply = computed(() => parsedDraft.value?.success === true && !busy.value);

onMounted(() => void loadConfiguration());
onUnmounted(() => {
  loadController?.abort();
  operationController.value?.abort();
});

async function loadConfiguration(): Promise<void> {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  loadError.value = null;
  loadRequestId.value = null;
  try {
    const response = await api.get<unknown>(PROXY_API, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const parsed = ProxyConfigurationSchema.safeParse(response);
    if (!parsed.success) {
      configuration.value = null;
      loadError.value = 'The proxy configuration response was not valid. Refresh and try again.';
      return;
    }
    configuration.value = parsed.data;
    draft.value = parsed.data.endpoint ?? '';
  } catch (cause) {
    if (controller.signal.aborted) return;
    configuration.value = null;
    loadError.value =
      cause instanceof ApiError ? cause.message : 'Proxy configuration could not be loaded.';
    loadRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (loadController === controller) {
      loadController = undefined;
      loading.value = false;
    }
  }
}

async function checkDraft(): Promise<void> {
  operationError.value = null;
  operationRequestId.value = null;
  operationMessage.value = null;
  const value = draft.value.trim();
  if (value !== '' && parsedDraft.value?.success !== true) return;
  health.value = null;

  await runOperation(async () => {
    const response = await api.post<unknown>(
      `${PROXY_API}/check`,
      value === '' ? {} : { endpoint: value },
      { signal: currentOperationSignal() },
    );
    const parsed = ProxyHealthReportSchema.safeParse(response);
    if (!parsed.success) throw new Error('The proxy health response was not valid.');
    health.value = parsed.data;
    operationMessageType.value = parsed.data.passed ? 'success' : 'warning';
    operationMessage.value = parsed.data.passed
      ? 'All external request checks passed.'
      : 'One or more checks failed. The current proxy configuration was not changed.';
  });
}

async function applyDraft(): Promise<void> {
  operationError.value = null;
  operationRequestId.value = null;
  operationMessage.value = null;
  const parsedEndpoint = parsedDraft.value;
  if (parsedEndpoint?.success !== true) return;
  health.value = null;

  await runOperation(async () => {
    const response = await api.put<unknown>(
      PROXY_API,
      { endpoint: parsedEndpoint.data },
      { signal: currentOperationSignal() },
    );
    const parsed = ProxyApplyResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('The proxy apply response was not valid.');
    health.value = parsed.data.health;
    configuration.value = parsed.data.configuration;
    if (parsed.data.applied) {
      draft.value = parsed.data.configuration.endpoint ?? '';
      operationMessageType.value = parsed.data.health.passed ? 'success' : 'warning';
      operationMessage.value = parsed.data.health.passed
        ? 'Proxy is active and all external request checks passed.'
        : 'Proxy is active, but one or more external checks failed. Review the results or remove the proxy.';
    } else {
      operationMessageType.value = 'warning';
      operationMessage.value = 'The proxy could not be activated. Review the health-check results.';
    }
  });
}

async function removeProxy(): Promise<void> {
  operationError.value = null;
  operationRequestId.value = null;
  operationMessage.value = null;
  await runOperation(async () => {
    const response = await api.delete<unknown>(PROXY_API, { signal: currentOperationSignal() });
    const parsed = ProxyConfigurationSchema.safeParse(response);
    if (!parsed.success) throw new Error('The proxy removal response was not valid.');
    configuration.value = parsed.data;
    draft.value = '';
    health.value = null;
    operationMessageType.value = 'success';
    operationMessage.value = 'Proxy removed. New external requests will connect directly.';
  });
}

function currentOperationSignal(): AbortSignal {
  const controller = operationController.value;
  if (controller === null) throw new Error('Proxy operation is not active.');
  return controller.signal;
}

async function runOperation(operation: () => Promise<void>): Promise<void> {
  operationController.value?.abort();
  const controller = new AbortController();
  operationController.value = controller;
  busy.value = true;
  try {
    await operation();
  } catch (cause) {
    if (controller.signal.aborted) return;
    operationError.value =
      cause instanceof ApiError ? cause.message : 'The proxy operation could not be completed.';
    operationRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (operationController.value === controller) {
      operationController.value = null;
      busy.value = false;
    }
  }
}

function displayCheckedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <v-container class="page-container py-6 py-md-8" fluid>
    <div class="page-heading mb-6">
      <div>
        <p class="text-overline text-secondary mb-1">Network</p>
        <h1 class="text-h4 font-weight-semibold">Outbound proxy</h1>
        <p class="text-body-2 text-secondary mt-2 mb-0">
          Route server-side Geofabrik catalog, metadata and map downloads through a proxy when
          external access depends on server location.
        </p>
      </div>
    </div>

    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-4" role="alert">
      <div>{{ loadError }}</div>
      <div v-if="loadRequestId" class="text-caption mt-1">Request ID: {{ loadRequestId }}</div>
      <template #append>
        <v-btn variant="text" :disabled="loading" @click="loadConfiguration">Retry</v-btn>
      </template>
    </v-alert>

    <v-card v-if="!loadError" class="settings-card mb-6" variant="outlined">
      <v-card-title class="text-h6">Proxy endpoint</v-card-title>
      <v-card-text>
        <v-skeleton-loader v-if="loading" type="list-item, actions" />
        <template v-else>
          <v-alert
            :type="configuration?.configured ? 'success' : 'info'"
            variant="tonal"
            class="mb-5"
            role="status"
          >
            {{
              configuration?.configured
                ? 'A proxy is active for new server-side external requests.'
                : 'No proxy is configured. External requests connect directly.'
            }}
          </v-alert>

          <v-text-field
            id="proxy-endpoint"
            v-model="draft"
            label="Proxy URL"
            placeholder="http://proxy.example.net:8080"
            hint="Supported: http://, https://, or socks5:// with a host and optional port."
            persistent-hint
            autocomplete="url"
            :error-messages="draftError"
            :disabled="busy"
          />
          <p class="text-body-2 text-secondary mt-3 mb-5">
            Proxy authentication is not supported. Do not include a username or password;
            credentials and URL paths are rejected. The configured endpoint is stored without
            authentication secrets.
          </p>

          <div class="d-flex flex-wrap ga-3">
            <v-btn
              data-testid="proxy-check-button"
              color="primary"
              variant="outlined"
              :loading="busy"
              :disabled="loading || busy || (draft.trim() !== '' && parsedDraft?.success !== true)"
              @click="checkDraft"
            >
              {{ draft.trim() === '' ? 'Check current route' : 'Test proxy' }}
            </v-btn>
            <v-btn
              data-testid="proxy-apply-button"
              color="primary"
              :loading="busy"
              :disabled="loading || !canApply"
              @click="applyDraft"
            >
              Apply and check
            </v-btn>
            <v-btn
              v-if="configuration?.configured"
              data-testid="proxy-remove-button"
              color="error"
              variant="text"
              :loading="busy"
              :disabled="loading || busy"
              @click="removeProxy"
            >
              Remove proxy
            </v-btn>
          </div>
        </template>
      </v-card-text>
    </v-card>

    <v-alert v-if="operationError" type="error" variant="tonal" class="mb-4" role="alert">
      <div>{{ operationError }}</div>
      <div v-if="operationRequestId" class="text-caption mt-1">
        Request ID: {{ operationRequestId }}
      </div>
    </v-alert>
    <v-alert
      v-if="operationMessage"
      :type="operationMessageType"
      variant="tonal"
      class="mb-4"
      role="status"
    >
      {{ operationMessage }}
    </v-alert>

    <section v-if="health" aria-labelledby="proxy-health-heading" class="health-section">
      <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-4">
        <div>
          <h2 id="proxy-health-heading" class="text-h6">External request checks</h2>
          <p class="text-caption text-secondary mt-1 mb-0">
            Checked {{ displayCheckedAt(health.checkedAt) }} ·
            {{
              health.proxyUsed
                ? 'Checks used a proxy endpoint'
                : 'Checks used the direct outbound route'
            }}
          </p>
        </div>
        <v-chip :color="health.passed ? 'success' : 'error'" variant="tonal">
          {{ health.passed ? 'All checks passed' : 'Some checks failed' }}
        </v-chip>
      </div>

      <div role="list" aria-label="Per-endpoint health results" class="d-flex flex-column ga-3">
        <v-card v-for="check in health.checks" :key="check.id" role="listitem" variant="outlined">
          <v-card-text>
            <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-3">
              <div>
                <h3 class="text-subtitle-1 font-weight-medium">{{ check.label }}</h3>
                <p class="text-caption text-secondary mb-0">{{ check.method }} · {{ check.url }}</p>
              </div>
              <v-chip :color="check.passed ? 'success' : 'error'" size="small" variant="tonal">
                {{ check.passed ? 'Passed' : 'Failed' }}
              </v-chip>
            </div>
            <dl class="health-details">
              <div>
                <dt>HTTP status</dt>
                <dd>
                  {{ check.status ?? 'No response'
                  }}<span v-if="check.statusText"> · {{ check.statusText }}</span>
                </dd>
              </div>
              <div>
                <dt>Expected</dt>
                <dd>{{ check.expected }}</dd>
              </div>
              <div>
                <dt>Response reason</dt>
                <dd>{{ check.reason }}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{{ check.durationMs }} ms</dd>
              </div>
            </dl>
          </v-card-text>
        </v-card>
      </div>
    </section>
  </v-container>
</template>

<style scoped>
.page-container {
  max-width: 1120px;
}

.page-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.health-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 24px;
  margin: 0;
}

.health-details dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.health-details dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .health-details {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
