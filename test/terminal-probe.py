"""Synthetic terminal regression only. No network, accounts or real credentials."""
import json, os, pty, select, subprocess, sys, termios, time

results = []
for mode in ['paste', 'separate', 'cancel', 'sigterm']:
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    child = subprocess.Popen([sys.argv[1], '--import', 'tsx', 'test/prompt-fixture.ts'], stdin=slave, stdout=slave, stderr=slave)
    output = bytearray()
    def wait_for(marker):
        deadline = time.monotonic() + 5
        while marker not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                output.extend(os.read(master, 8192))
        if marker not in output:
            raise RuntimeError('Terminal fixture did not reach the expected prompt')
    try:
        wait_for(b'Email (hidden):')
        if mode == 'paste':
            os.write(master, b'person@example.test\r\nSYNTHETIC_PASTE_SECRET\r\n')
        else:
            os.write(master, b'person@example.test\n')
            wait_for(b'Password (hidden):')
            if mode == 'separate': os.write(master, b'SYNTHETIC_PASTE_SECRET\n')
            elif mode == 'cancel': os.write(master, b'PARTIAL_SECRET\x03')
            else:
                os.write(master, b'PARTIAL_SECRET')
                child.terminate()
        wait_for(b'ACCEPTED' if mode in ['paste', 'separate'] else b'CANCELLED')
        child.wait(timeout=5)
        while select.select([master], [], [], 0.02)[0]: output.extend(os.read(master, 8192))
        results.append({'mode': mode, 'secret_visible': any(v in output for v in [b'SYNTHETIC_PASTE_SECRET', b'PARTIAL_SECRET']), 'email_visible': b'person@example.test' in output, 'echo_restored': (termios.tcgetattr(slave)[3] & termios.ECHO) == (original[3] & termios.ECHO), 'exit_code': child.returncode})
    finally:
        if child.poll() is None: child.kill(); child.wait()
        os.close(master); os.close(slave)
print(json.dumps(results))
