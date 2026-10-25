// Phone build: the same calendar module as one folder of static files for the Android
// WebView (copied into the APK as assets/calendar/ by build.sh). Not committed.
import base from "./vite.config.mjs";

export default {
  ...base,
  base: "./",
  build: {
    ...base.build,
    outDir: "dist-phone",
    emptyOutDir: true,
    rollupOptions: { input: "phone.html" }
  }
};
