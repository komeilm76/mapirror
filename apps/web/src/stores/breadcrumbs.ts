/** Reactive page labels that are loaded after navigation (`P2-WEB-04`). */

import { defineStore } from 'pinia';
import { ref } from 'vue';

/** The API-backed label for the current cached-country detail breadcrumb. */
export const useBreadcrumbs = defineStore('breadcrumbs', () => {
  const cacheCountryLabel = ref<string | null>(null);

  /** Sets or clears the cached-country label as the detail request changes. */
  function setCacheCountryLabel(label: string | null): void {
    cacheCountryLabel.value = label;
  }

  return { cacheCountryLabel, setCacheCountryLabel };
});
