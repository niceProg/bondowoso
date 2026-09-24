import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test pipeline memanggil CLI + fake-claude berkali-kali sebagai proses baru.
    testTimeout: 120_000,
  },
});
