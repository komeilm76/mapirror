<script setup lang="ts">
/**
 * The application shell (`P1-WEB-01`, admin area from `P1-WEB-07`).
 *
 * `v-app` is not decoration: Vuetify's layout components (`v-main`, `v-app-bar`, `v-navigation-drawer`) resolve their
 * sizes from the provider it installs, so a page rendered outside it gets a broken grid rather than an error. It exists
 * exactly once, here.
 *
 * The admin layout is asynchronous so its shell, persistent job drawer, and Vuetify components do not enter the public
 * landing page's initial bundle. The public shell stays eager because it is part of the first public paint. ToastHost is
 * loaded only after a notification is queued; public visitors who have no notification do not fetch its overlay code or
 * the icon font it uses.
 *
 * `areaForPath` is the same segment-aware policy that selects the route theme. Public pages use the public header and
 * attribution; admin pages use their dedicated shell; login uses a focused bare `v-main`.
 *
 * @module App
 */

import { computed, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';

import PublicLayout from '@/layouts/PublicLayout.vue';
import { useNotifications } from '@/stores/notifications';
import { areaForPath } from '@/theme/policy';

const AdminLayout = defineAsyncComponent(() => import('@/layouts/AdminLayout.vue'));
const ToastHost = defineAsyncComponent(() => import('@/components/common/ToastHost.vue'));
const notifications = useNotifications();
const hasNotifications = computed(() => notifications.items.length > 0);
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

    <ToastHost v-if="hasNotifications" />
  </v-app>
</template>
