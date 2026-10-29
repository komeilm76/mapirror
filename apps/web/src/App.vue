<script setup lang="ts">
/**
 * The application shell (`P1-WEB-01`, admin area from `P1-WEB-07`).
 *
 * `v-app` is not decoration: Vuetify's layout components (`v-main`, `v-app-bar`, `v-navigation-drawer`) resolve their
 * sizes from the provider it installs, so a page rendered outside it gets a broken grid rather than an error. It exists
 * exactly once, here.
 *
 * ## Why the admin area has its own branch
 *
 * The admin shell (`layouts/AdminLayout.vue`) owns an app bar, a drawer **and** the `v-main` those two offset — Vuetify
 * computes the main region's padding from the bars and drawers registered with the layout, so a `v-main` wrapped around a
 * drawer by a parent would leave the content under the bar. Everywhere else the page is the whole screen and a bare
 * `v-main` is exactly right, so the branch is on the **area**, from the same predicate the theme uses
 * (`theme/policy.ts`, `areaForPath`): a path is in the admin panel or it is not, and both the theme and the shell ask the
 * same function rather than each keeping a list.
 *
 * The public shell owns the public header, visitor theme toggle and attribution footer (`P3-WEB-01`). Auth remains a
 * focused bare `v-main`; its theme follows the operating system.
 *
 * `ToastHost` sits inside `v-app` (`P1-WEB-04`) so toasts inherit the theme, and outside `v-main` so a toast is never
 * part of the scrollable page it is reporting on.
 *
 * @module App
 */

import { computed } from 'vue';
import { useRoute } from 'vue-router';

import ToastHost from '@/components/common/ToastHost.vue';
import AdminLayout from '@/layouts/AdminLayout.vue';
import PublicLayout from '@/layouts/PublicLayout.vue';
import { areaForPath } from '@/theme/policy';

const route = useRoute();

/** Whether the current page belongs to the admin panel. */
const isAdmin = computed(() => areaForPath(route.path) === 'admin');
/** Public pages share their shell; login remains a focused standalone page. */
const isPublic = computed(() => areaForPath(route.path) === 'public');
</script>

<template>
  <v-app>
    <AdminLayout v-if="isAdmin">
      <router-view />
    </AdminLayout>

    <PublicLayout v-else-if="isPublic">
      <router-view />
    </PublicLayout>

    <v-main v-else>
      <router-view />
    </v-main>

    <ToastHost />
  </v-app>
</template>
