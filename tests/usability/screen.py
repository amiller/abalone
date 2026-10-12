"""First-screen checks for one tmux capture: screen.py <name> <width> <capture.ansi> <capture-joined.txt>.
Prints PASS|FAIL <name>-<check>; ready needs the editor rule, so an error screen with the wordmark fails. A near-black block is a run of 8+ cells on one row whose effective background
(after reverse video) is near-black: it clashes with light and tinted terminals."""
import re, sys, unicodedata

name, width, ansi, joined = sys.argv[1], int(sys.argv[2]), open(sys.argv[3]).read(), open(sys.argv[4]).read()
SGR = re.compile(r"\x1b\[([0-9;]*)m")

def near_black(color):
    kind, *v = color
    return (kind == "rgb" and max(v) <= 32) or (kind == "256" and (v[0] in (0, 16) or 232 <= v[0] <= 235)) or (kind == "16" and v[0] == 0)

def color(params, i):
    if params[i + 1] == 2: return ("rgb", *params[i + 2:i + 5]), i + 5
    return ("256", params[i + 2]), i + 3

def runs(line):
    fg = bg = None; rev = False; run = longest = 0; pos = 0
    for m in list(SGR.finditer(line)) + [None]:
        text = line[pos:m.start() if m else len(line)]
        for ch in text:
            if unicodedata.combining(ch): continue
            eff = fg if rev else bg
            run = run + 1 if eff and near_black(eff) else 0
            longest = max(longest, run)
        if not m: break
        pos, p = m.end(), [int(x) if x else 0 for x in m.group(1).split(";")]
        i = 0
        while i < len(p):
            c = p[i]
            if c == 0: fg = bg = None; rev = False; i += 1
            elif c == 7: rev = True; i += 1
            elif c == 27: rev = False; i += 1
            elif c == 38: fg, i = color(p, i)
            elif c == 48: bg, i = color(p, i)
            elif c == 39: fg = None; i += 1
            elif c == 49: bg = None; i += 1
            elif 30 <= c <= 37: fg = ("16", c - 30); i += 1
            elif 40 <= c <= 47: bg = ("16", c - 40); i += 1
            else: i += 1
    return longest

def cols(s): return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1 for c in s)

lines = joined.split("\n")
blocks = [n for n, l in enumerate(ansi.split("\n")) if runs(l) >= 8]
over = [l for l in lines if cols(l.rstrip()) > width]
warn = [l.strip() for l in lines if re.search(r"warning|⚠|INTEL-SA|out ?of ?date", l, re.I) and not l.startswith("SYNTHETIC FIXTURE")]
for check, ok, detail in [("wordmark", any(re.match(r"\s*abalone\b", l, re.I) for l in lines), ""),
                          ("ready", any(re.fullmatch(f"─{{{width // 2},}}", l.rstrip()) for l in lines), "the editor rule is drawn"),
                          ("dark-block", not blocks, f"{len(blocks)} rows with a near-black block"),
                          ("overflow", not over, f"{len(over)} lines wider than {width}"),
                          ("warnings", len(warn) <= 1, f"{len(warn)} warning lines")]:
    print(f"{'PASS' if ok else 'FAIL'} {name}-{check}" + (f" ({detail})" if detail else ""))
