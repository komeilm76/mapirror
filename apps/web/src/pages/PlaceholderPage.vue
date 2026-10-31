<script setup lang="ts">
/** Shared view for an admin screen that is not built yet (`P1-WEB-03`). */

import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

/** The user-facing name of this pending screen. */
const title = computed(() => route.meta.title);
</script>

<template>
  <v-container class="py-12" max-width="var(--mm-container-public)">
    <v-row justify="center">
      <v-col cols="12" md="9" lg="7">
        <h1 class="mm-display mb-4">{{ title }}</h1>

        <v-card border flat rounded="lg">
          <v-card-text>
            <p class="mm-body-public mb-0">The {{ title }} page isn't available yet.</p>
            <p class="mm-caption mt-2 mb-0">
              Return to the dashboard to use the available admin tools.
            </p>
          </v-card-text>
        </v-card>

        <v-btn class="mt-6" color="primary" :to="{ name: 'admin-dashboard' }" variant="tonal">
          Go to dashboard
        </v-btn>
      </v-col>
    </v-row>
  </v-container>
</template>
