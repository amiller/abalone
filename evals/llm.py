"""Pluggable model calls. A model is a shell command that reads the prompt on stdin and writes the reply on stdout,
e.g. "bin/abalone sandbox -p --no-skills --model redpill/<id>" or "claude -p" or "python3 evals/pour/fixtures/fake.py judge"."""
import json, subprocess

def ask(cmd, prompt, timeout=900):
    return subprocess.run(cmd, shell=True, input=prompt, capture_output=True, text=True, check=True, timeout=timeout).stdout

def parse_json(text):
    i, j = text.index("{"), text.rindex("}")
    return json.loads(text[i:j + 1])
