'use strict';

const archiver = require('archiver');
const fs       = require('fs');
const path     = require('path');

const SRC_DIR  = path.join(__dirname, 'src');
const OUT_DIR  = path.join(__dirname, 'dist');
const ZIP_PATH = path.join(OUT_DIR, 'tab-sleeper.zip');

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR);

const output  = fs.createWriteStream(ZIP_PATH);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  const kb = (archive.pointer() / 1024).toFixed(1);
  console.log(`\nBuilt: dist/tab-sleeper.zip (${kb} KB)\n`);
});

archive.on('error', err => { throw err; });

archive.pipe(output);
archive.directory(SRC_DIR, false);
archive.finalize();
