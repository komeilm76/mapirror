<script setup lang="ts">
/**
 * The not-found page (`P1-WEB-03`; copy and illustration are `P3-WEB-05`'s).
 *
 * `13-ui-ux.md` §4 S15: "friendly 404 + link home", and §5's empty-state rule applies to it in spirit — an icon, one
 * sentence, and the next action as a button, never a dead end.
 *
 * It renders **at the URL the visitor typed** (`/_site/:pathMatch(.*)*` matches without redirecting), because a 404 that
 * silently rewrites the address bar hides the typo the visitor needs to see. The one case where the URL changes is a
 * path outside `/_site/` altogether, which the route table redirects here — L1 has no page outside the site but
 * `/_auth/login`, so there is no page to render *at* that address.
 *
 * The wording is deliberately plain: "Not found" is what the reader needs, and the request id belongs to error states
 * that come from the API (`P2-WEB-07`), not to a client-side miss.
 */

import { useRoute } from 'vue-router';
import { computed } from 'vue';

const route = useRoute();

/** What the visitor asked for, so the page can name it back to them. */
const attempted = computed(() => route.fullPath);
</script>

<template>
  <v-container class="py-16" max-width="var(--mm-container-public)">
    <v-row justify="center">
      <v-col cols="12" md="8" lg="6" class="text-center">
        <p class="mm-caption mb-2">404</p>
        <h1 class="mm-display mb-4">That page does not exist</h1>
        <p class="mm-body-public mm-text-secondary mb-2">
          Nothing is published at this address. Check the link, or start from the catalog.
        </p>
        <p class="mm-mono-small mm-text-secondary mb-8">{{ attempted }}</p>

        <v-btn color="primary" :to="{ name: 'home' }">Browse the catalog</v-btn>
      </v-col>
    </v-row>
  </v-container>
</template>
