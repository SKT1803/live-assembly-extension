import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "",
  build: {
    outDir: "../media/dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: {
      input: "index.html",
      output: {
        entryFileNames: "bundle.js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css"))
            return "style.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
});
