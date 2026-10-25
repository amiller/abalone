#!/usr/bin/python3
"""Enter Sway with the private writable runtime after PAM establishes the seat."""
import os
import pathlib
import stat

if os.getuid() != 971:
    raise SystemExit("Dsmack desktop requires the portable-ui identity")
runtime = pathlib.Path("/run/portable-display")
metadata = runtime.lstat()
if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 971
        or stat.S_IMODE(metadata.st_mode) != 0o700):
    raise SystemExit("Dsmack desktop runtime must be a private directory owned by portable-ui")
# PAM may set /run/user/971, which ProtectHome makes unavailable in this unit.
# Override immediately before exec; retain the PAM session and logind seat.
os.environ["XDG_RUNTIME_DIR"] = str(runtime)
os.execv("/usr/bin/sway", ["sway", "--config", "/opt/portable/portable/raspberry-pi/display/sway.config"])
