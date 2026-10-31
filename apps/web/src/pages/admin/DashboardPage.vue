<script setup lang="ts">
/** Operational dashboard for S5: status widgets, schedules, jobs and system metrics (`P5-MON-04`).
 *
 * @module pages/admin/DashboardPage
 */

import DashboardWidgets from '@/components/admin/DashboardWidgets.vue';
</script>

<template>
  <v-container class="py-8" max-width="var(--mm-container-admin)">
    <h1 class="mm-display mb-6">Dashboard</h1>
    <DashboardWidgets />
  </v-container>
</template>
