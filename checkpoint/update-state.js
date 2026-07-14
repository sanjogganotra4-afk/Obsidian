#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadState, saveState } = require('./lib');
const { parseArgs } = require('./args');

function usage() {
  console.error(`Usage:
  node update-state.js --project <name> start-phase <id>
  node update-state.js --project <name> complete-phase <id> [file1,file2,...]
  node update-state.js --project <name> block <id> <reason...>
  node update-state.js --project <name> unblock <id>
  node update-state.js --project <name> note <text...>`);
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const project = flags.project;
  const [cmd, ...rest] = positional;
  if (!project || !cmd) {
    usage();
    process.exit(1);
  }

  const root = path.resolve(__dirname, '..');
  const state = loadState(root, project);
  state.phases = state.phases || {};
  state.blockers = state.blockers || [];
  state.notes = state.notes || [];

  switch (cmd) {
    case 'start-phase': {
      const id = rest[0];
      state.phases[id] = { ...(state.phases[id] || {}), status: 'in_progress' };
      state.currentPhase = id;
      break;
    }
    case 'complete-phase': {
      const id = rest[0];
      const files = (rest[1] || '').split(',').filter(Boolean);
      state.phases[id] = {
        status: 'done',
        files: files.length ? files : (state.phases[id] || {}).files || [],
      };
      break;
    }
    case 'block': {
      const id = rest[0];
      const reason = rest.slice(1).join(' ');
      state.phases[id] = { ...(state.phases[id] || {}), status: 'blocked' };
      state.blockers.push(`Phase ${id}: ${reason}`);
      break;
    }
    case 'unblock': {
      const id = rest[0];
      state.blockers = state.blockers.filter((b) => !b.startsWith(`Phase ${id}:`));
      if (state.phases[id]) state.phases[id].status = 'in_progress';
      break;
    }
    case 'note': {
      state.notes.push(rest.join(' '));
      break;
    }
    default:
      usage();
      process.exit(1);
  }

  saveState(root, project, state);
  console.log(`[checkpoint] state updated for project "${project}"`);
}

main();
