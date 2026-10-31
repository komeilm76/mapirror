<script setup lang="ts">
/**
 * The admin shell (`P1-WEB-07`, `13-ui-ux.md` §3).
 *
 * ```
 * ┌────────────┬──────────────────────────────────────────────┐
 * │ MapMirror  │  Menu  Dashboard › Cache      [search] [user]│  64 px topbar
 * ├────────────┼──────────────────────────────────────────────┤
 * │ Dashboard  │                                              │
 * │ Catalog    │  <slot/> — the page's own container and title │
 * │ Cache      │                                              │
 * └────────────┴──────────────────────────────────────────────┘
 * ```
 *
 * Four decisions worth more than the markup:
 *
 * 1. **The drawer is one control at every size.** §3 calls for 248 px, collapsible on a desktop and a temporary drawer
 *    under 1024 px. One `open` ref gives both: on a desktop the panel pushes the content aside, on a phone it slides over
 *    it, and the same button toggles either. A permanent drawer plus a second mobile one would be two states to keep in
 *    step, and the handover is where they disagree.
 *
 *    **Who owns the responsive rules matters, and the first version of this file got it wrong.** It passed
 *    `:temporary="mobile"` and wrote a `watch(mobile)` that re-opened or closed the drawer on a resize — two statements of
 *    things Vuetify already does: `isTemporary` is `!permanent && (mobile || temporary)`, a `watch(isTemporary)` sets the
 *    drawer's own state on a resize, and a `watch(router.currentRoute)` closes a temporary drawer on every navigation
 *    (read in `VNavigationDrawer`, measured in pass 36 — a mutation that deleted this file's watcher changed nothing,
 *    which is how the duplication was found). Both were removed: the shell now states only what is *its* decision — which
 *    is open to begin with — and the three behaviours Vuetify supplies are **asserted** in `tests/admin-layout.spec.ts`,
 *    so an upgrade that drops one fails a test rather than quietly stranding a phone behind a panel.
 * 2. **The 1024 px boundary belongs to `useDisplay`.** `plugins/vuetify.ts` sets `display.mobileBreakpoint` to §3's
 *    number, so `mobile` is the same fact for the drawer and for any screen that asks later — and a test can prove it by
 *    setting `window.innerWidth` before the app is built.
 * 3. **The trail is not the page title.** §3 puts breadcrumbs in the topbar and §7 asks for one `h1` per page: the page
 *    owns the heading, the topbar owns the trail (`router/breadcrumbs.ts` says where it comes from).
 * 4. **Icons are deliberate, not decoration.** Material Design Icons are loaded globally; this shell keeps the menu
 *    action as the explicit "Menu" / "Hide menu" text and the breadcrumb separator as a decorative text chevron. The
 *    user-menu control retains its name. `tests/admin-layout.spec.ts` pins these labels and verifies no stray glyphs.
 *
 * The skip link (§7) is the shell's, and it is the first focusable element in the DOM so it is reachable before nine
 * sidebar entries. Its "hidden until focused" styling is in `styles/shell.css`: a rule, not a token.
 *
 * @module layouts/AdminLayout
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';

import AdminUserMenu from '@/components/admin/UserMenu.vue';
import JobProgressDrawer from '@/components/admin/JobProgressDrawer.vue';
import { useApi } from '@/composables/useApi';
import { breadcrumbsFor } from '@/router/breadcrumbs';
import { ADMIN_NAV, isNavItemActive } from '@/router/nav';
import { useAuth } from '@/stores/auth';
import { useBreadcrumbs } from '@/stores/breadcrumbs';
import { useJobProgress } from '@/stores/jobProgress';

import { MAIN_ID, SIDEBAR_WIDTH, TOPBAR_HEIGHT } from './adminShell';

const route = useRoute();
const router = useRouter();
const display = useDisplay();
const auth = useAuth();
const pageLabels = useBreadcrumbs();
const jobProgress = useJobProgress();
const client = useApi();

/** Whether the viewport is below §3's boundary. */
const mobile = computed(() => display.mobile.value);

/** Whether the sidebar is showing. Open on a desktop, closed on a phone, where it would cover the page. */
const drawerOpen = ref(!mobile.value);

/** The trail follows the path; a cached-country's API label replaces its UUID after detail loads. */
const crumbs = computed(() =>
  breadcrumbsFor({
    path: route.path,
    meta: {
      title: route.meta.title,
      breadcrumbLabel: pageLabels.cacheCountryLabel ?? route.meta.breadcrumbLabel,
    },
  }),
);

/** The catalog search term (§3: global search in the topbar). */
const search = ref('');

/** The live field follows a bookmarked catalog query, without rewriting the user's input while typing. */
watch(
  () => [route.name, route.query.q] as const,
  ([name, value]) => {
    if (name === 'admin-catalog') search.value = typeof value === 'string' ? value : '';
  },
  { immediate: true },
);

/** Pending search timer, cleared when a new character arrives or the layout is unmounted. */
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Sends a stable search term to the catalog.
 *
 * When already on the catalog it replaces the query in place and preserves other filters; from another admin page it
 * navigates there once. Keeping the query in the URL makes the search refreshable and bookmarkable.
 */
async function applySearch(): Promise<void> {
  const term = search.value.trim();
  if (route.name === 'admin-catalog') {
    const query = { ...route.query };
    if (term === '') delete query.q;
    else query.q = term;
    delete query.page;
    if ((typeof route.query.q === 'string' ? route.query.q : '') === term) return;
    await router.replace({ name: 'admin-catalog', query });
    return;
  }

  await router.push({
    name: 'admin-catalog',
    ...(term === '' ? {} : { query: { q: term } }),
  });
}

watch(search, () => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    void applySearch();
  }, 300);
});

onUnmounted(() => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
});

/** Submits immediately on Enter; typing alone is debounced by 300 ms. */
async function submitSearch(): Promise<void> {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = undefined;
  await applySearch();
}

onMounted(() => {
  // The boot check of `04-api.md` §1: the token survived the reload, the profile did not (`stores/auth.ts` keeps it out of
  // `sessionStorage` on purpose), and the topbar is the first thing that needs a name. A session that cannot be checked —
  // offline, a proxy in the way — is left alone: `restore()` answers `unverified` and the menu falls back to "Signed in".
  if (auth.isAuthenticated && auth.admin === null) void auth.restore(client);
});
</script>

<template>
  <a class="mm-skip-link" :href="`#${MAIN_ID}`">Skip to content</a>

  <v-app-bar flat :height="TOPBAR_HEIGHT">
    <v-btn
      aria-controls="mm-admin-drawer"
      :aria-expanded="drawerOpen"
      class="ml-2"
      variant="text"
      @click="drawerOpen = !drawerOpen"
    >
      {{ drawerOpen ? 'Hide menu' : 'Menu' }}
    </v-btn>

    <nav v-if="crumbs.length > 0" aria-label="Breadcrumb">
      <ol class="mm-breadcrumbs">
        <li v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${String(index)}`">
          <router-link v-if="crumb.to !== null" class="mm-breadcrumb-link" :to="crumb.to">{{
            crumb.label
          }}</router-link>
          <span v-else aria-current="page">{{ crumb.label }}</span>
          <span v-if="index < crumbs.length - 1" aria-hidden="true" class="mm-breadcrumb-divider"
            >›</span
          >
        </li>
      </ol>
    </nav>

    <v-spacer />

    <form class="mm-admin-search" role="search" @submit.prevent="submitSearch">
      <v-text-field
        v-model="search"
        aria-label="Search the catalog"
        density="compact"
        hide-details
        maxlength="128"
        placeholder="Search catalog"
        single-line
        type="search"
        variant="solo"
      />
    </form>

    <v-btn
      aria-controls="mm-job-progress-drawer"
      :aria-expanded="jobProgress.isOpen"
      :aria-label="
        jobProgress.activeCount > 0
          ? `${jobProgress.activeCount} active ${jobProgress.activeCount === 1 ? 'job' : 'jobs'}. Open job progress`
          : 'Open job progress'
      "
      class="mx-1"
      variant="text"
      @click="jobProgress.open()"
    >
      Jobs<span v-if="jobProgress.activeCount > 0" aria-hidden="true" class="mm-job-active-dot" />
    </v-btn>

    <AdminUserMenu />
  </v-app-bar>

  <v-navigation-drawer id="mm-admin-drawer" v-model="drawerOpen" :width="SIDEBAR_WIDTH">
    <div class="px-4 py-4">
      <p class="mm-caption ma-0">MapMirror</p>
      <p class="mm-body-public ma-0">Administration</p>
    </div>

    <v-divider />

    <v-list aria-label="Administration" density="compact" nav>
      <v-list-item
        v-for="item in ADMIN_NAV"
        :key="item.name"
        :active="isNavItemActive(item, route.path)"
        :aria-current="isNavItemActive(item, route.path) ? 'page' : undefined"
        :title="item.label"
        :aria-label="
          item.name === 'admin-jobs' && jobProgress.activeCount > 0
            ? `Jobs, ${jobProgress.activeCount} active`
            : item.label
        "
        :to="{ name: item.name }"
      >
        <template v-if="item.name === 'admin-jobs' && jobProgress.activeCount > 0" #append>
          <span aria-hidden="true" class="mm-job-active-dot" />
        </template>
      </v-list-item>
    </v-list>
  </v-navigation-drawer>

  <v-main :id="MAIN_ID" tabindex="-1">
    <div class="mm-admin-content mx-auto" :style="{ maxWidth: 'var(--mm-container-admin)' }">
      <slot />
    </div>
  </v-main>

  <JobProgressDrawer />
</template>
