<script setup lang="ts">
/** Shared public header, theme preference and attribution footer (`P3-WEB-01`, `13-ui-ux.md` §3). */

import { useStorage } from '@vueuse/core';
import { useTheme } from 'vuetify';
import { watch } from 'vue';
import { useRoute } from 'vue-router';

import { attributionLine } from '@mapirror/shared';
import { DARK_THEME_NAME, LIGHT_THEME_NAME } from '@/styles/tokens';

const PUBLIC_THEME_STORAGE_KEY = 'mapirror.public-theme';
const theme = useTheme();
const route = useRoute();
const preference = useStorage(PUBLIC_THEME_STORAGE_KEY, LIGHT_THEME_NAME);

/** Applies only a validated explicit visitor preference; public visits otherwise default to light. */
function applyPublicTheme(): void {
  theme.change(preference.value === DARK_THEME_NAME ? DARK_THEME_NAME : LIGHT_THEME_NAME);
}

/** Switches and remembers the public theme for this browser. */
function toggleTheme(): void {
  preference.value =
    theme.global.name.value === DARK_THEME_NAME ? LIGHT_THEME_NAME : DARK_THEME_NAME;
}

applyPublicTheme();
watch(preference, applyPublicTheme);
// The global route policy restores the light public default after every navigation; re-apply an explicit preference
// after that hook so it persists across public screens without affecting the admin or login areas.
watch(() => route.fullPath, applyPublicTheme, { flush: 'post' });
</script>

<template>
  <div class="mm-public-layout">
    <header class="mm-public-header">
      <div class="mm-public-header-inner">
        <RouterLink class="mm-public-brand" to="/_site/">MapMirror</RouterLink>
        <nav class="mm-public-nav" aria-label="Main navigation">
          <RouterLink to="/_site/">Browse maps</RouterLink>
          <RouterLink to="/_site/api-docs">API</RouterLink>
        </nav>
        <button
          class="mm-public-theme-toggle"
          type="button"
          :aria-label="
            theme.global.name.value === DARK_THEME_NAME
              ? 'Switch to light theme'
              : 'Switch to dark theme'
          "
          :aria-pressed="theme.global.name.value === DARK_THEME_NAME"
          @click="toggleTheme"
        >
          {{ theme.global.name.value === DARK_THEME_NAME ? 'Light theme' : 'Dark theme' }}
        </button>
      </div>
    </header>

    <main class="mm-public-main">
      <slot />
    </main>

    <footer class="mm-public-footer">
      <div class="mm-public-footer-inner">{{ attributionLine() }}</div>
    </footer>
  </div>
</template>
