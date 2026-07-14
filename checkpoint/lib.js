'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Mirrors the Phase 1A-1I / Phase 2 build order from the TradeAI
// architecture doc so the map reflects that project's real milestones.
const PHASES = [
  { id: '1A', name: 'Backend foundation', detail: 'FastAPI, DB, models, migrations' },
  { id: '1B', name: 'Market data layer', detail: 'yfinance provider, indicators' },
  { id: '1C', name: 'Paper trading engine', detail: 'Paper trading engine + risk guard' },
  { id: '1D', name: 'Claude agents', detail: 'Research, Strategy, Risk, Execution' },
  { id: '1E', name: 'Gemini + AI Council', detail: 'Arbitrator, all voting modes' },
  { id: '1F', name: 'Orchestrator', detail: 'Orchestrator + Scheduler + Position monitor' },
  { id: '1G', name: 'WebSocket + alerts', detail: 'WebSocket manager + alert system' },
  { id: '1H', name: 'REST API routers', detail: 'All REST API routers' },
  { id: '1I', name: 'React frontend', detail: 'All 5 screens, PWA config' },
  { id: '2', name: 'Kite live trading', detail: 'Kite Connect live trading (Phase 2)' },
];

const STATUS_COLOR = { done: '4', in_progress: '3', blocked: '1' };

function vaultDir(root, project) {
  return path.join(root, 'vault', project);
}

function stateFilePath(root, project) {
  return path.join(vaultDir(root, project), 'state.json');
}

function canvasFilePath(root, project) {
  return path.join(vaultDir(root, project), 'PROGRESS-MAP.canvas');
}

function loadState(root, project) {
  const f = stateFilePath(root, project);
  if (!fs.existsSync(f)) {
    return { phases: {}, blockers: [], notes: [], currentPhase: null, lastUpdated: null };
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveState(root, project, state) {
  const dir = vaultDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(stateFilePath(root, project), JSON.stringify(state, null, 2));
}

function gitInfo(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return { branch: null, lastCommit: null, changedFiles: [] };
  }
  const git = (args) => execFileSync('git', args, { cwd: targetDir }).toString().trim();
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const lastCommit = git(['log', '-1', '--pretty=format:%h %s (%cr)']);
    const changed = git(['status', '--porcelain']);
    const changedFiles = changed ? changed.split('\n').map((l) => l.trim()).slice(0, 20) : [];
    return { branch, lastCommit, changedFiles };
  } catch (e) {
    return { branch: null, lastCommit: null, changedFiles: [] };
  }
}

function buildCanvas(state, git) {
  const nodes = [];
  const edges = [];
  const colWidth = 280;
  const rowHeight = 160;
  const perRow = 5;

  PHASES.forEach((phase, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const st = state.phases[phase.id] || { status: 'pending' };
    const filesLine = st.files && st.files.length ? `\nFiles: ${st.files.join(', ')}` : '';
    const node = {
      id: `phase-${phase.id}`,
      type: 'text',
      x: col * colWidth,
      y: row * rowHeight,
      width: 260,
      height: 140,
      text: `**Phase ${phase.id} — ${phase.name}**\n${phase.detail}\nStatus: ${st.status}${filesLine}`,
    };
    if (STATUS_COLOR[st.status]) node.color = STATUS_COLOR[st.status];
    nodes.push(node);

    if (col > 0) {
      const prev = PHASES[i - 1];
      edges.push({
        id: `edge-${prev.id}-${phase.id}`,
        fromNode: `phase-${prev.id}`,
        fromSide: 'right',
        toNode: `phase-${phase.id}`,
        toSide: 'left',
      });
    } else if (row > 0) {
      const prev = PHASES[i - 1];
      edges.push({
        id: `edge-${prev.id}-${phase.id}`,
        fromNode: `phase-${prev.id}`,
        fromSide: 'bottom',
        toNode: `phase-${phase.id}`,
        toSide: 'top',
      });
    }
  });

  const resumeY = (Math.ceil(PHASES.length / perRow) + 1) * rowHeight;
  const blockersText = state.blockers && state.blockers.length
    ? state.blockers.map((b) => `- ${b}`).join('\n')
    : 'NONE';
  const notesText = state.notes && state.notes.length
    ? state.notes.slice(-5).map((n) => `- ${n}`).join('\n')
    : '(none)';
  const changedFilesText = git.changedFiles.length
    ? git.changedFiles.join('\n')
    : '(clean working tree, or target repo not found)';

  nodes.push({
    id: 'resume-here',
    type: 'text',
    x: 0,
    y: resumeY,
    width: 560,
    height: 260,
    color: '5',
    text: [
      '## RESUME HERE',
      `Branch: ${git.branch || 'unknown'}`,
      `Last commit: ${git.lastCommit || 'unknown'}`,
      `Current phase: ${state.currentPhase || 'not started'}`,
      `Last updated: ${state.lastUpdated || 'never'}`,
      '',
      '**Blockers:**',
      blockersText,
      '',
      '**Recent notes:**',
      notesText,
    ].join('\n'),
  });

  nodes.push({
    id: 'changed-files',
    type: 'text',
    x: 600,
    y: resumeY,
    width: 400,
    height: 260,
    text: `## Working tree changes\n${changedFilesText}`,
  });

  return { nodes, edges };
}

function generate(root, project, targetDir) {
  const state = loadState(root, project);
  const git = gitInfo(targetDir);
  const canvas = buildCanvas(state, git);
  const dir = vaultDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(canvasFilePath(root, project), JSON.stringify(canvas, null, 2));
  return canvasFilePath(root, project);
}

module.exports = {
  PHASES,
  loadState,
  saveState,
  gitInfo,
  buildCanvas,
  generate,
  vaultDir,
  stateFilePath,
  canvasFilePath,
};
