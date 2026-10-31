<script setup lang="ts">
/**
 * Database-backed update count for the still-in-progress dashboard (`P4-UPD-04`).
 *
 * The cache list's filtered total is the authoritative count, so this does not keep a second client-side tally. It is
 * refreshed on mount, every 30 seconds while visible, and when the administrator explicitly asks.
 *
 * @module components/admin/DashboardUpdateCounter
 */

import { CacheListResponseSchema } from '@mapirror/shared';
import { onMounted, onUnmounted, ref } from 'vue';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { adminPagePaths } from '@/router/paths';

const api = useApi();
const count = ref<number | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
let controller: AbortController | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let mounted = true;

/** Reads the filtered cache-list total, which is returned from the same database query as its rows. */
async function refreshCount(): Promise<void> {
  if (!mounted || loading.value) return;
  loading.value = true;
  errorMessage.value = null;
  errorRequestId.value = null;
  const requestController = new AbortController();
  controller = requestController;

  try {
    const response = await api.get<unknown>('/_admin/api/cache', {
      query: { update: 'available', page: 1, limit: 1 },
      signal: requestController.signal,
    });
    if (!mounted || requestController.signal.aborted) return;
    const parsed = CacheListResponseSchema.safeParse(response);
    if (!parsed.success) {
      count.value = null;
      errorMessage.value = 'The update count response could not be read. Try again.';
      return;
    }
    count.value = parsed.data.meta.total;
  } catch (cause) {
    if (!mounted || requestController.signal.aborted) return;
    count.value = null;
    if (cause instanceof ApiError) {
      errorMessage.value = cause.message;
      errorRequestId.value = cause.requestId;
    } else {
      errorMessage.value =
        'The update count could not be loaded. Check your connection and try again.';
    }
  } finally {
    if (controller === requestController) controller = null;
    if (mounted) loading.value = false;
  }
}

function refreshWhenVisible(): void {
  if (document.visibilityState === 'visible') void refreshCount();
}

onMounted(() => {
  void refreshCount();
  document.addEventListener('visibilitychange', refreshWhenVisible);
  refreshTimer = setInterval(refreshWhenVisible, 30_000);
});

onUnmounted(() => {
  mounted = false;
  if (refreshTimer !== undefined) clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', refreshWhenVisible);
  controller?.abort();
  controller = null;
});
</script>

<template>
  <section aria-labelledby="mm-dashboard-update-count-title" :aria-busy="loading">
    <v-card border flat rounded="lg">
      <v-card-title id="mm-dashboard-update-count-title">Cached updates</v-card-title>
      <v-card-text>
        <p class="mm-body-public" role="status" aria-live="polite" aria-atomic="true">
          <template v-if="count !== null">
            {{ count.toLocaleString('en-GB') }} update{{ count === 1 ? '' : 's' }} available
          </template>
          <template v-else-if="loading">Loading update count…</template>
          <template v-else>Update count unavailable</template>
        </p>
        <div class="d-flex flex-wrap ga-2">
          <v-btn
            color="primary"
            :to="{ path: adminPagePaths.cache(), query: { update: 'available' } }"
            variant="tonal"
          >
            Review updates
          </v-btn>
          <v-btn :disabled="loading" variant="text" @click="refreshCount">
            {{ loading ? 'Refreshing…' : 'Refresh count' }}
          </v-btn>
        </div>
        <div v-if="errorMessage !== null" class="mt-3" role="alert">
          <p class="ma-0">{{ errorMessage }}</p>
          <p v-if="errorRequestId" class="mm-mono-small ma-0 mt-1">
            Request id: {{ errorRequestId }}
          </p>
        </div>
      </v-card-text>
    </v-card>
  </section>
</template>
