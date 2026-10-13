import { defineConfig } from 'vite';

export default defineConfig({
  // Относительные пути к ресурсам: собранную страницу Electron открывает
  // через file://, и абсолютный «/assets/...» там не находится.
  base: './',
  server: { port: 5273 },
  // Демо-дракон (`src/assets/dragon.glb`) вшивается в сборку строкой data:.
  assetsInclude: ['**/*.glb'],
  build: { outDir: 'dist', emptyOutDir: true },
});
