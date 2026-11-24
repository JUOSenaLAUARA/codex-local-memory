import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));

export function associateUpstream(snapshot) {
  return runPython('association.py', [], snapshot);
}

export function pythonWorker(script, args, options = {}) {
  const python = path.join(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return spawn(python, [path.join(directory, script), ...args], {
    windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}

export function runPython(script, args, input, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = pythonWorker(script, args);
    let output = '';
    let errorText = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('本地记忆检索超时')), timeout);
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > 1000000) finish(new Error('关联检索返回超出上限'));
    });
    child.stderr.on('data', (data) => { errorText = (errorText + data).slice(-2000); });
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error(`上游关联检索失败 (${code}): ${errorText}`));
      try { finish(null, JSON.parse(output)); } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
