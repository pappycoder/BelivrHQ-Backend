const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function dockerReadiness(run = spawnSync, wait = delay) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = run('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      timeout: 20000,
      killSignal: 'SIGKILL',
    });
    if (result.status === 0) return { ready: true };
    if (result.error?.code === 'ENOENT') return { ready: false, reason: 'Docker CLI missing' };
    if (attempt < 2) await wait(2000);
  }
  // Do not echo daemon output: it can contain private endpoints/configuration.
  const reason =
    result.error?.code === 'ETIMEDOUT'
      ? 'probe timed out'
      : Number.isInteger(result.status)
        ? `probe exited with status ${result.status}`
        : 'probe could not complete';
  return { ready: false, reason: `${reason} after 3 attempts` };
}

module.exports = { dockerReadiness };
