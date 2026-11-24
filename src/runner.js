// Thin wrapper around the `claude` CLI in headless mode (no API key, uses your Claude Code login).
const { spawn, execFile } = require('child_process');

/**
 * Run one headless turn.
 * opts: { bin, cwd, prompt, sessionId, systemPromptFile, mcpConfigFile, permissionMode,
 *         allowedTools, disallowedTools, model, onEvent(ev), onExit({code, stderr}) }
 */
function runClaude(opts) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.systemPromptFile) args.push('--append-system-prompt-file', opts.systemPromptFile);
  if (opts.mcpConfigFile) args.push('--mcp-config', opts.mcpConfigFile, '--strict-mcp-config');
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  // variadic flag: keep it last. The prompt goes via stdin, so nothing follows it.
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));

  const child = spawn(opts.bin || 'claude', args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        opts.onEvent?.(JSON.parse(line));
      } catch {
        /* non-JSON line, ignore */
      }
    }
  });
  child.stderr.on('data', (c) => {
    stderr = (stderr + c).slice(-4000);
  });
  child.on('error', (err) => opts.onExit?.({ code: -1, stderr: String(err.message || err) }));
  child.on('close', (code) => opts.onExit?.({ code, stderr }));

  child.stdin.on('error', () => {});
  child.stdin.end(opts.prompt);
  return child;
}

/** Kill the process and everything it started (Windows needs taskkill /T). */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGTERM');
  }
}

/** Turn a stream-json event into zero or more compact log entries. */
function toLogEntries(ev) {
  const out = [];
  if (ev.parent_tool_use_id) return out; // ignore nested built-in sub-agent chatter
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: b.text.trim() });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', text: describeTool(b) });
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'tool_result' && b.is_error) {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push({ kind: 'error', text: t.slice(0, 300) });
      }
    }
  }
  return out;
}

function describeTool(b) {
  const i = b.input || {};
  const name = b.name.replace(/^mcp__[^_]+__/, '');
  const arg = i.command || i.file_path || i.pattern || i.url || i.query || i.path;
  return arg ? `${name}: ${String(arg).replace(/\s+/g, ' ').slice(0, 140)}` : name;
}

module.exports = { runClaude, killTree, toLogEntries };
