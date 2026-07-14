#!/usr/bin/env node
'use strict';

const path = require('path');
const { generate } = require('./lib');
const { parseArgs } = require('./args');

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (!flags.project) {
    console.error('Usage: node generate-canvas.js --project <name> [--target <repo-dir>]');
    process.exit(1);
  }
  const root = path.resolve(__dirname, '..');
  const out = generate(root, flags.project, flags.target ? path.resolve(flags.target) : null);
  console.log(`[checkpoint] wrote ${out}`);
}

main();
