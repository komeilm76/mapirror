<script setup lang="ts">
/**
 * Who is signed in, and the way out (`P1-WEB-07`, `13-ui-ux.md` §3: "user menu (logout)").
 *
 * ## The name, or an honest stand-in
 *
 * The profile is not persisted (`stores/auth.ts`), so the first paint after a reload has a token and no name. The button
 * says **"Signed in"** until `/me` answers, rather than inventing a name, showing the token's prefix (`04-api.md` §1
 * keeps the token's own prefix for a sessions *list*, not for the bar) or hiding the control until it is sure.
 *
 * ## Signing out
 *
 * `auth.signOut(client)` sends the revoke, clears the state and empties the toast queue (`stores/auth.ts` explains why
 * that order is load-bearing); this component then says so and returns the reader to the login page **carrying the page
 * they were on**, so signing back in puts them where they left off. The destination is the same `loginRedirectFor` the
 * guard uses for a refused navigation — one function, two callers, so a signed-out reader and a refused one end up in the
 * same place.
 *
 * A sign-out the reader asked for must not wait for the network, which is why the navigation happens immediately: the
 * local session is already gone, and the revoke is a request the server will either honour or let expire.
 *
 * @module components/admin/UserMenu
 */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useApi } from '@/composables/useApi';
import { loginRedirectFor } from '@/router/redirect';
import { useAuth } from '@/stores/auth';
import { useNotifications } from '@/stores/notifications';

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const client = useApi();
const notifications = useNotifications();

/** The name to show: the profile's, or "Signed in" while `/me` has not answered. */
const label = computed(() => auth.username ?? 'Signed in');

/**
 * Ends the session: revoke, clear, say so, leave.
 *
 * The order is deliberate — the toast is pushed *after* `signOut`, because `signOut` empties the queue so that "Saved"
 * from the previous session does not follow this one out.
 */
async function signOut(): Promise<void> {
  const from = route.fullPath;
  auth.signOut(client);
  notifications.success('You have signed out.');
  await router.replace(loginRedirectFor(from));
}
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props }">
      <v-btn
        v-bind="props"
        aria-haspopup="menu"
        class="mr-2"
        :title="auth.username === null ? 'Signed in' : `Signed in as ${auth.username}`"
        variant="text"
      >
        {{ label }}
      </v-btn>
    </template>

    <v-list density="compact" min-width="220">
      <v-list-item :subtitle="auth.username ?? 'Session active'" title="Signed in" />
      <v-divider />
      <v-list-item data-test="sign-out" title="Sign out" @click="signOut" />
    </v-list>
  </v-menu>
</template>
