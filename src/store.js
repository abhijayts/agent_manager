// Central in-memory state, persisted to data/state.json.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const FILE = path.join(__dirname, '..', 'data', 'state.json');
const bus = new EventEmitter(); // 'changed' | 'chat' (entry) | 'log' ({agentId, entry})

const state = {
  seq: { task: 0, agent: 0, chat: 0 },
  tasks: [],
  agents: [],
  chat: [],
  // one supervisor per top-level task (keyed by task id) plus 'general'
  supervisors: {},
};

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    Object.assign(state, saved, { seq: { ...state.seq, ...saved.seq } });
  } catch {
    /* first run */
  }
}

let timer = null;
function flush() {
  clearTimeout(timer);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}
function changed() {
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
  bus.emit('changed');
}

const nextId = (kind, prefix) => `${prefix}${++state.seq[kind]}`;

module.exports = { state, bus, load, flush, changed, nextId };
