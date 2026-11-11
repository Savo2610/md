// Baut den Browser-Teil nach public/assets und schreibt die Dateinamen (mit
// Hash) nach src/generated/manifest.json. Der Worker liest das Manifest, um
// die richtigen <script>- und <link>-Tags in die Seite zu schreiben.
//
//   node tools/build.mjs          einmal bauen
//   node tools/build.mjs --watch  bei jeder Änderung neu bauen (npm run dev)

import * as esbuild from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'public/assets';

const writeManifest = {
  name: 'manifest',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length || !result.metafile) return;
      const manifest = {};
      for (const [file, info] of Object.entries(result.metafile.outputs)) {
        if (!info.entryPoint) continue;
        const url = '/' + relative('public', file);
        if (info.entryPoint.endsWith('main.ts')) manifest.js = url;
        else if (info.entryPoint.endsWith('style.css')) manifest.css = url;
        else if (info.entryPoint.includes('katex')) manifest.katexCss = url;
      }
      mkdirSync('src/generated', { recursive: true });
      writeFileSync('src/generated/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
      console.log(`[build] ${new Date().toLocaleTimeString()} ${manifest.js}`);
    });
  },
};

const options = {
  entryPoints: [
    'src/client/main.ts',
    'src/client/style.css',
    'node_modules/katex/dist/katex.min.css',
  ],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: watch ? 'linked' : false,
  metafile: true,
  entryNames: '[name]-[hash]',
  chunkNames: 'c/[name]-[hash]',
  assetNames: 'f/[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  // Schriften liegen fest unter /fonts (public/fonts), nicht im Bundle.
  external: ['/fonts/*'],
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [writeManifest],
};

rmSync(outdir, { recursive: true, force: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
