#!/usr/bin/env python3
"""Exercise the real terminal through the loopback HTTP API inside a guest."""
import json
import time
import urllib.request

base = "http://127.0.0.1:8765"

def request(path, body=None, method=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Workspace-Token"] = token
    req = urllib.request.Request(base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)

status = request("/api/status")
token = status["csrfToken"]
terminal = request("/api/terminals", {}, token=token)["id"]
try:
    request(f"/api/terminals/{terminal}/input",
            {"input": "printf 'ARM_TERMINAL_'; uname -m\n"}, token=token)
    output = ""
    for _ in range(30):
        output = request(f"/api/terminals/{terminal}/output?after=0")["output"]
        if "ARM_TERMINAL_aarch64" in output:
            break
        time.sleep(1)
    assert "ARM_TERMINAL_aarch64" in output, output
    print(json.dumps({"terminal": "passed", "architecture": "aarch64",
                      "qualification": status.get("qualification")}))
finally:
    request(f"/api/terminals/{terminal}", method="DELETE", token=token)
