<script setup lang="ts">
/**
 * Renders the toast queue (`P1-WEB-04`; position and chrome are `P1-WEB-07`'s).
 *
 * One `v-snackbar` **per toast**, not one shared snackbar reading the head of a queue: an error must stay until it is
 * dismissed (`13-ui-ux.md` §5), and a single-slot host would hide a second failure behind the first — which is exactly
 * the moment two failures matter. Vuetify stacks them at the bottom-right of the viewport, teleported out of the page's
 * flow, so a toast never pushes the layout it is reporting on.
 *
 * `v-snackbar` brings the accessibility contract with it: the content is `role="status"` with `aria-live="polite"`
 * (`13-ui-ux.md` §7), announced without stealing focus from the form that just failed. Nothing here sets a colour:
 * `color="error"` resolves through the theme, and its label colour is the `on-error` the token tests pin at 4.5:1.
 *
 * **The three kinds use three documented colours**: `error`, `success` and — for a neutral note — `primary`. The first
 * version used `color="info"`, which `13-ui-ux.md` §2 does not define: Vuetify's own Material palette supplied a blue
 * for it, the same one in both themes, with no `on-info`, so the label was picked by Vuetify's APCA heuristic (pass 33;
 * the hex and the measurement are in `styles/tokens.ts`, which is the one file allowed to name a colour). The palette is
 * closed now and the token test asserts it, but the component names a colour the document names too.
 *
 * The countdown is Vuetify's, driven by `item.timeout`, and the mapping is done **here** because the constant is
 * Vuetify's and not a fact about toasts: `-1` is "wait for the close button", while `0` is "dismiss on the next tick"
 * (measured in pass 32 — the store's first version said `0` and errors vanished as they appeared). The store keeps no
 * timers, so this is the only place a dismissal can be timed.
 *
 * **Icons are text here on purpose.** The Material Design icon set is not installed yet (`01`/`P1-WEB-07` chooses it),
 * so `icon="mdi-close"` would render nothing at all — a close button that cannot be seen but can be tabbed to. The
 * button says "Dismiss"; `P5-UX-05`'s icon audit replaces the label with the set's icon and an `aria-label`.
 */
import { useNotifications } from '@/stores/notifications';

const notifications = useNotifications();

/**
 * The theme colour for a kind.
 *
 * @param kind - `success`, `info` or `error`.
 * @returns A Vuetify colour name from the palette in `13-ui-ux.md` §2.
 */
function colorFor(kind: 'success' | 'info' | 'error'): string {
  if (kind === 'error') return 'error';
  if (kind === 'success') return 'success';
  // A neutral note wears the brand colour, which is the most visible filled surface in both themes. `surface-variant`
  // was the other candidate and is only 1.05:1 against the page behind it — a toast has to be seen without being read
  // first, and a shadow alone is not enough at 200 % zoom.
  return 'primary';
}
</script>

<template>
  <div class="mm-toast-host">
    <v-snackbar
      v-for="item in notifications.items"
      :key="item.id"
      :model-value="true"
      :timeout="item.timeout ?? -1"
      :color="colorFor(item.kind)"
      location="bottom right"
      rounded="lg"
      @update:model-value="notifications.dismiss(item.id)"
    >
      <div>{{ item.message }}</div>
      <div v-if="item.detail" class="text-body-2 mt-1">{{ item.detail }}</div>
      <div v-if="item.requestId" class="mm-mono text-caption mt-1">
        Request {{ item.requestId }}
      </div>

      <template #actions>
        <v-btn variant="text" size="small" @click="notifications.dismiss(item.id)">Dismiss</v-btn>
      </template>
    </v-snackbar>
  </div>
</template>
