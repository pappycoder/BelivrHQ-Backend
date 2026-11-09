"""Optional POSIX pseudo-terminal smoke test; no database or service access."""
import os
import pathlib
import pty
import select
import shlex
import signal
import tempfile
import time

root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='belivrhq-terminal-') as directory:
    fixture = pathlib.Path(directory) / 'fixture.cjs'
    # Paths are passed as argv, never embedded into evaluated JavaScript.
    fixture.write_text("""const core=require(process.argv[2]);core.readFields();
core.child(process.execPath,['-e',"console.log('TTY_READY='+process.stdin.isTTY);process.stdin.once('data',data=>{console.log('CHILD_INPUT='+data.toString().trim());process.exit(0);});"],{root:process.cwd(),env:process.env});
""")
    pid, descriptor = pty.fork()
    if pid == 0:
        command = "printf 'confirmation\\0' | node " + shlex.quote(str(fixture)) + ' ' + shlex.quote(str(root / 'scripts/ops/core.cjs'))
        os.execvp('bash', ['bash', '-c', command])
    output = b''
    sent = False
    status = None
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            ready, _, _ = select.select([descriptor], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(descriptor, 65536)
                except OSError:
                    chunk = b''
                output += chunk
                if not sent and b'TTY_READY=true' in output:
                    os.write(descriptor, b'operator-input\n')
                    sent = True
            ended, result = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = result
                break
        assert status == 0 and b'TTY_READY=true' in output and b'CHILD_INPUT=operator-input' in output, output.decode(errors='replace')
        print('PASS: interactive child retains the controlling terminal after piped confirmation input')
    finally:
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(descriptor)
