# Runs a command at a 120x40 pseudo-terminal and answers its prompts in order, as a person at the keyboard would.
# Usage: python3 -I pty.py <timeout-s> '<[[regex, reply], ...]>' -- command...; "{1}" in a reply is the regex's first group.
# Prints {"code", "output", "unanswered", "timedOut"} as JSON; a timeout kills the command.
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time
timeout, steps, cmd = float(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
out, seen, deadline, timed_out = b"", 0, time.time() + timeout, False
while True:
    if not select.select([fd], [], [], max(0, deadline - time.time()))[0]:
        timed_out = True; os.kill(pid, signal.SIGKILL); break
    try: data = os.read(fd, 65536)
    except OSError: break
    if not data: break
    out += data
    m = steps and re.search(steps[0][0], out[seen:].decode(errors="replace"))
    if m:
        os.write(fd, steps.pop(0)[1].replace("{1}", m.group(1) if m.groups() else "").encode()); seen = len(out)
code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
print(json.dumps({"code": code, "output": out.decode(errors="replace"), "unanswered": [s[0] for s in steps], "timedOut": timed_out}))
