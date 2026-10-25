<script setup lang="ts">
/**
 * The public home page — a placeholder that doubles as the token preview (`P1-WEB-01`, tokens from `P1-WEB-02`).
 *
 * **This is not the catalog.** Its job is to put something on the screen that only renders if the whole chain is
 * intact: the SFC compiled, Vuetify's components resolved and its styles loaded, the router matched `/_site/`, Pinia
 * and VueUse are installed, and the two themes are built from the palette. The real home — search, continent chips,
 * the country grid, the compact intro of `13-ui-ux.md` §3 — is `P3-WEB-01`, and it replaces this file wholesale.
 *
 * It says what is wired rather than showing a fake catalog: a placeholder that invents five countries teaches a
 * reviewer to distrust every screenshot in the repository.
 *
 * It also holds **no colour of its own** — every patch of ink below is a theme key (`bg-primary`, `mm-text-secondary`)
 * or a switch of theme scope (`.v-theme--dark`), which is the acceptance criterion of `P1-WEB-02` made visible:
 * `tests/tokens.spec.ts` scans this file and would fail on a hex.
 */

import { usePreferredDark } from '@vueuse/core';
import { computed } from 'vue';

import { DARK_PALETTE, LIGHT_PALETTE, type Palette } from '@/styles/tokens';

/** The stack, as the reader would check it against `09-development.md` §2. */
const STACK = [
  { label: 'Vue', version: '3.5' },
  { label: 'Vuetify', version: '3.13' },
  { label: 'Pinia', version: '3.0' },
  { label: 'Vue Router', version: '4.6' },
  { label: 'VueUse', version: '13.9' },
] as const;

/** The colours worth showing side by side: the two surfaces, the inks, and the two semantic extremes. */
const SWATCHES = [
  'background',
  'surface',
  'text-primary',
  'text-secondary',
  'primary',
  'accent',
  'success',
  'error',
] as const;

/** One row of the preview: a theme name, the class that switches Vuetify's variables to it, and its palette. */
const THEMES: readonly {
  readonly name: string;
  readonly scope: string;
  readonly palette: Palette;
}[] = [
  { name: 'Public · light', scope: '', palette: LIGHT_PALETTE },
  { name: 'Admin · dark', scope: 'v-theme--dark', palette: DARK_PALETTE },
];

// A live VueUse composable, so the dependency is *used* rather than merely installed: it subscribes to the OS colour
// preference and cleans itself up on unmount. `P1-WEB-02` uses the same composable for the login page's theme.
const prefersDark = usePreferredDark();
const systemNote = computed(() =>
  prefersDark.value ? 'Your system prefers dark.' : 'Your system prefers light.',
);

/**
 * The colour a swatch paints, from the palette rather than from a class.
 *
 * `bg-*` classes resolve against the *current* theme, so a dark preview inside a light page needs the value itself —
 * and `.v-theme--dark` on the wrapper makes Vuetify's own components inside it dark too.
 */
function swatch(name: (typeof SWATCHES)[number], palette: Palette): string {
  if (name === 'background') return palette.surface;
  if (name === 'surface') return palette['surface-variant'];
  return palette[name];
}
</script>

<template>
  <v-container class="py-12" max-width="var(--mm-container-public)">
    <v-row align="center" justify="center">
      <v-col cols="12">
        <p class="mm-caption mb-2">MapMirror</p>
        <h1 class="mm-display mb-3">A self-hosted mirror for OpenStreetMap extracts</h1>
        <p class="mm-body-public mm-text-secondary mb-6">
          The application shell is running. The catalog, the download flow and the admin panel
          arrive with their own tasks; this page exists so the wiring can be seen working end to
          end.
        </p>

        <v-card border flat rounded="lg">
          <v-card-text>
            <div class="mm-title mb-3">Wired and rendering</div>
            <div class="d-flex flex-wrap ga-2">
              <v-chip
                v-for="entry in STACK"
                :key="entry.label"
                color="primary"
                size="small"
                variant="tonal"
              >
                {{ entry.label }} <span class="mm-mono-small ms-1">{{ entry.version }}</span>
              </v-chip>
            </div>
            <v-divider class="my-4" />
            <p class="mm-caption ma-0">{{ systemNote }}</p>
          </v-card-text>
        </v-card>

        <div class="mm-title mt-8 mb-1">Theme tokens</div>
        <p class="mm-caption mb-4">
          Both palettes of <code>13-ui-ux.md</code> §2, painted from <code>styles/tokens.ts</code>.
          The admin row is scoped with <code>.v-theme--dark</code>, so it is the real dark theme
          rather than a screenshot of one.
        </p>

        <v-card v-for="theme in THEMES" :key="theme.name" border flat class="mb-4" rounded="lg">
          <div :class="theme.scope">
            <div class="pa-4" :style="{ background: theme.palette.surface }">
              <div class="mm-caption mb-3" :style="{ color: theme.palette['text-secondary'] }">
                {{ theme.name }}
              </div>
              <div class="d-flex flex-wrap ga-3">
                <div v-for="name in SWATCHES" :key="name" class="d-flex flex-column ga-1">
                  <div
                    class="rounded-sm mm-border-decorative"
                    :style="{
                      background: swatch(name, theme.palette),
                      width: '72px',
                      height: '40px',
                    }"
                  />
                  <span class="mm-mono-small" :style="{ color: theme.palette['text-secondary'] }">
                    {{ name }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </v-card>

        <p class="mm-caption ma-0">
          Placeholder page: the catalog, search and the download flow arrive with
          <code>P3-WEB-01</code>.
        </p>
      </v-col>
    </v-row>
  </v-container>
</template>
