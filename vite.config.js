import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Honor the PORT env var (the preview harness assigns one via autoPort) so the
// dev server lands on the port the browser proxy expects.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
});
