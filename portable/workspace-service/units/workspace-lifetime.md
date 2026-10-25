# RAM workspace lifetime

`portable-workspace.service` owns `/run/portable-workspace` as portable-agent
(UID/GID970 in the image account graph), mode0700. It is a oneshot remaining
active after `/usr/bin/true` exits. It does not depend on the SDK backend, Tor,
UI, or native terminal. It has no PartOf, BindsTo, or StopWhenUnneeded relation.
Stopping the workspace unit explicitly removes its RAM directory and stops its
required consumers; ordinary backend stop/restart must not do that.

Both backend and native terminal require/order after the workspace owner.
The backend owns only `/run/portable-agent`; its restart closes backend-owned
web PTYs/agent runs but does not own/remove the shared workspace. Native terminal
requires workspace+firewall, with no agent Requires/After/Wants dependency, so
native shells and Sway can survive an SDK outage. The UI's existing Wants relation
to the backend does not propagate its stop. This change adds no filesystem or
financial authority to UI UID971; the private RAM directory remains UID970.

Source-only review does not prove runtime survival. Before migration, preserve
current guest evidence, record workspace device/inode/owner/mode and a synthetic
marker, and capture actual loaded dependency/RuntimeDirectory properties. The
old agent unit owns the workspace: stopping it before safe handoff could delete
all RAM files. Use a separately reviewed cutover with temporary old-unit
RuntimeDirectoryPreserve=yes and verified daemon-reload/effective configuration,
then establish the independent owner and remove the old dependency/ownership.
Do not blindly restart the old unit or assume changing a file updates the loaded
unit. Remove the temporary preservation override only after the ownership graph
has been verified. This document authorizes no guest mutation.

Required later proof: same workspace dev/inode/marker before and after backend
stop/start; workspace service remains active; native daemon, native PTY shell,
Sway and UI process identities survive; backend operations unavailable then recover;
UID971/974 still cannot read the mode0700 workspace directly. Firewall failure
must still stop the native terminal via its retained Requires dependency. This
is RAM lifetime, not reboot persistence or encrypted vault integration.
