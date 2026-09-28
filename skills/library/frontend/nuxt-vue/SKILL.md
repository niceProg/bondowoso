---
name: nuxt-vue
description: Conventions for Nuxt 3/4 and Vue 3 code
tier: library
domains: [frontend]
trigger: nuxt, vue, .vue, composable, usefetch, pinia, nitro, ssr, hydration, script setup
---
- `<script setup lang="ts">` with typed `defineProps`/`defineEmits`; keep components small and
  presentational where possible, data fetching in pages or composables.
- Fetch with `useFetch`/`useAsyncData` and a stable key; handle `pending` and `error` states in
  the template. Parallel requests go in one `Promise.all`.
- Avoid hydration mismatches: no `Date.now()`, random values or `window` access during
  render; move browser-only code to `onMounted` or `<ClientOnly>`.
- Server-only secrets stay in `runtimeConfig` (not `public`) and are used only in server
  routes.
- Reuse existing components and design tokens before creating new ones.
