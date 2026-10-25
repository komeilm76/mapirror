<script setup lang="ts">
/**
 * The public home page (`P1-WEB-01` placeholder).
 *
 * **This is a boot proof, not a design.** Its job is to put something on the screen that only renders if the whole
 * chain is intact: the SFC compiled, Vuetify's components resolved and its styles loaded, the router matched
 * `/_site/`, and Pinia and VueUse are installed. The real home — search, continent chips, the country grid, the
 * compact intro of `13-ui-ux.md` §3 — is `P3-WEB-01`, and the token/typography work underneath it is `P1-WEB-02`.
 *
 * It says what is wired rather than showing a fake catalog: a placeholder that invents five countries teaches a
 * reviewer to distrust every screenshot in the repository.
 */

import { usePreferredDark } from '@vueuse/core';
import { computed } from 'vue';

/** The stack, as the reader would check it against `09-development.md` §2. */
const STACK = [
  { label: 'Vue', version: '3' },
  { label: 'Vuetify', version: '3' },
  { label: 'Pinia', version: '3' },
  { label: 'Vue Router', version: '4' },
  { label: 'VueUse', version: '13' },
] as const;

// A live VueUse composable, so the dependency is *used* rather than merely installed: it subscribes to the OS colour
// preference and cleans itself up on unmount. `P1-WEB-02` turns this into the public theme toggle.
const prefersDark = usePreferredDark();
const themeNote = computed(() =>
  prefersDark.value ? 'Your system prefers dark.' : 'Your system prefers light.',
);
</script>

<template>
  <v-container class="py-12" max-width="880">
    <v-row align="center" justify="center">
      <v-col cols="12">
        <p class="text-overline text-medium-emphasis mb-2">MapMirror</p>
        <h1 class="text-h4 font-weight-bold mb-3">
          A self-hosted mirror for OpenStreetMap extracts
        </h1>
        <p class="text-body-1 text-medium-emphasis mb-6">
          The application shell is running. The catalog, the download flow and the admin panel
          arrive with their own tasks; this page exists so the wiring can be seen working end to
          end.
        </p>

        <v-card border flat rounded="lg">
          <v-card-text>
            <div class="text-subtitle-2 mb-3">Wired and rendering</div>
            <div class="d-flex flex-wrap ga-2">
              <v-chip
                v-for="entry in STACK"
                :key="entry.label"
                color="primary"
                size="small"
                variant="tonal"
              >
                {{ entry.label }} {{ entry.version }}
              </v-chip>
            </div>
            <v-divider class="my-4" />
            <p class="text-body-2 text-medium-emphasis ma-0">{{ themeNote }}</p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
