<script setup lang="ts">
/**
 * The application shell (`P1-WEB-01`).
 *
 * `v-app` is not decoration: Vuetify's layout components (`v-main`, `v-app-bar`, `v-navigation-drawer`) resolve their
 * sizes from the provider it installs, so a page rendered outside it gets a broken grid rather than an error. Every
 * layout in `13-ui-ux.md` §3 — the admin sidebar and the public header — therefore nests inside this element, and
 * this element exists exactly once, here.
 *
 * `v-main` is the scroll container the router renders into. The layouts that wrap individual pages (`AdminLayout`,
 * `PublicLayout`, `AuthLayout`) are `P1-WEB-07` and `P2`'s work; until then every route renders straight into the
 * main region, which is why the placeholder page below carries its own container.
 *
 * `ToastHost` sits inside `v-app` (`P1-WEB-04`) so that toasts inherit both the theme and the locale, and outside
 * `v-main` so a toast is never part of the scrollable page it is reporting on.
 */
import ToastHost from '@/components/common/ToastHost.vue';
</script>

<template>
  <v-app>
    <v-main>
      <router-view />
    </v-main>

    <ToastHost />
  </v-app>
</template>
