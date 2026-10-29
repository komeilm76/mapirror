<script setup lang="ts">
/**
 * Public 404 page with the attempted route and a clear catalog return path (`P1-WEB-03`, `P3-WEB-05`, S15).
 *
 * The site catch-all renders at the URL the visitor typed rather than rewriting the address bar, so the typo remains
 * visible. This is a client-side miss, not an API failure; it has no request id to report.
 */

import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

/** What the visitor asked for, so a mistyped or stale address remains easy to identify. */
const attempted = computed(() => route.fullPath);
</script>

<template>
  <section class="mm-public-not-found" aria-labelledby="public-not-found-title">
    <div class="mm-public-not-found-card">
      <div class="mm-public-not-found-art" aria-hidden="true">
        <svg viewBox="0 0 64 64" focusable="false">
          <path class="mm-not-found-map" d="m7 14 15-5 20 6 15-5v40l-15 5-20-6-15 5V14Z" />
          <path class="mm-not-found-fold" d="M22 9v40m20-34v40" />
          <path class="mm-not-found-route" d="M16 37c5-9 9-9 14 0s9 9 14 0" />
          <circle class="mm-not-found-point" cx="16" cy="37" r="3" />
          <circle class="mm-not-found-point" cx="44" cy="37" r="3" />
        </svg>
      </div>
      <p class="mm-public-not-found-code">404</p>
      <h1 id="public-not-found-title" class="mm-display">Page not found</h1>
      <p class="mm-public-not-found-message">
        We couldn't find a page at this address. Start from the catalog to find a published map.
      </p>
      <div class="mm-public-not-found-address">
        <span>Requested address</span>
        <code>{{ attempted }}</code>
      </div>
      <RouterLink class="mm-public-not-found-action" :to="{ name: 'home' }">
        Browse published maps
      </RouterLink>
    </div>
  </section>
</template>
