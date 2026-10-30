<script setup lang="ts">
/**
 * Shared view for a screen that is not built yet (`P1-WEB-03`).
 *
 * Several screens in `13-ui-ux.md` §4 are still owed to later tasks, and the router has to know their paths today — the
 * law test walks the table, and a deep link that 404s is worse than one that explains itself. Rather
 * than eleven near-identical SFCs, every pending route points here and `meta` says which screen it stands in for
 * (`screen`), what it is called (`title`) and which task will replace it (`owner`).
 *
 * It shows **where you are** as well as what is missing: the path comes from the route rather than from `meta`, so this
 * page doubles as proof that the guard, the redirect parameter and the router's matching all did what the URL says —
 * which is exactly what a reviewer checking "unauthenticated `/_site/admin/*` lands on the login page" needs to see.
 *
 * No invented content: a placeholder that fakes a table of countries teaches a reviewer to distrust every screenshot in
 * the repository. It states the fact, names the task, and stops.
 */

import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

/** The `13-ui-ux.md` §4 row this route implements. */
const screen = computed(() => route.meta.screen);

/** The task that will build it. */
const owner = computed(() => route.meta.owner);

/** Where the browser actually is, query string included — the proof that the redirect kept its destination. */
const location = computed(() => route.fullPath);

/** The panel's heading: the screen's own name. */
const title = computed(() => route.meta.title);
</script>

<template>
  <v-container class="py-12" max-width="var(--mm-container-public)">
    <v-row justify="center">
      <v-col cols="12" md="9" lg="7">
        <p class="mm-caption mb-2">Screen {{ screen }} · 13-ui-ux.md §4</p>
        <h1 class="mm-display mb-4">{{ title }}</h1>

        <v-card border flat rounded="lg">
          <v-card-text>
            <p class="mm-body-public mb-4">
              This screen is not built yet. It arrives with <span class="mm-mono">{{ owner }}</span
              >.
            </p>

            <div class="mm-caption mb-1">You are here</div>
            <p class="mm-mono ma-0">{{ location }}</p>

            <v-divider class="my-4" />

            <p class="mm-caption ma-0">
              The route, its title and the guard that protects it are real (<span class="mm-mono"
                >P1-WEB-03</span
              >); only the contents are owed.
            </p>
          </v-card-text>
        </v-card>

        <v-btn class="mt-6" color="primary" :to="{ name: 'home' }" variant="tonal">
          Back to the site
        </v-btn>
      </v-col>
    </v-row>
  </v-container>
</template>
