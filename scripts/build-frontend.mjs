#!/usr/bin/env node

import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { sanitizePublicPayload, sanitizePublicText } from '../lib/public-language.js';

const stripNonVisibleHtml = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, '')
  .replace(/<[^>]+>/g, ' ');

const [indexHtml, termsHtml, savedDemo] = await Promise.all([
  readFile('index.html', 'utf8'),
  readFile('terms.html', 'utf8'),
  readFile('data/demo/saved-verified-report.json', 'utf8').then(JSON.parse)
]);
sanitizePublicText(stripNonVisibleHtml(indexHtml));
sanitizePublicText(stripNonVisibleHtml(termsHtml));
sanitizePublicPayload(savedDemo);

await build({
  entryPoints: ['src/app.jsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: 'app.js',
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info'
});

// Vercel's project-level output directory is `public`. Keep the root bundle
// for integrity/pre-push verification, then stage only deployable static files
// so repository source and medical data cannot be served as static assets.
await mkdir('public', { recursive: true });
await Promise.all([
  copyFile('index.html', 'public/index.html'),
  copyFile('terms.html', 'public/terms.html'),
  copyFile('app.js', 'public/app.js')
]);
