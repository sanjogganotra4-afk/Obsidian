#!/usr/bin/env node
'use strict';

const path = require('path');
const { generate } = require('./lib');
const { parseArgs } = require('./args');

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (!flags.project) {
    console.error('Usage: node watch.js --project <name> [--target <repo-dir>] [--interval 60]');
    process.exit(1);
  }
  const root = path.resolve(__dirname, '..');
  const targetDir = flags.target ? path.resolve(flags.target) : null;
  const intervalMs = (Number(flags.interval) || 60) * 1000;

  function tick() {
    try {
      const out = generate(root, flags.project, targetDir);
      console.log(`[checkpoint] ${new Date().toISOString()} wrote ${out}`);
    } catch (err) {
      console.error('[checkpoint] generation failed:', err.message);
    }
  }

  console.log(
    `[checkpoint] watching project "${flags.project}"` +
      `${targetDir ? ` (target: ${targetDir})` : ''} every ${intervalMs / 1000}s. Ctrl+C to stop.`
  );
  tick();
  setInterval(tick, intervalMs);
}

main();
