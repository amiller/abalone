# Dsmack separate workspace service — staged prototype

The backend runs PTYs and SDK workers as portable-agent; the loopback UI proxies
over a kernel-peer-UID-checked Unix socket. No fallback to local execution occurs
in service mode. Direct CLI mode remains an explicit developer option.

## Authority boundary

Loopback HTTP Origin/CSRF checks protect browser cross-origin requests, NOT local
processes. An agent can fetch the status token and call that HTTP API. Therefore
vault lifecycle, credit secrets, funding approval and any privileged operation
MUST stay out of this API. These staged accounts receive no operator/credit/vault
groups. The [native terminal channel](../raspberry-pi/display/README.md) separately checks
kernel peer UIDs and transfers a PTY descriptor to the display client.
Sway/foot shells run as portable-agent, outside UI or operator groups.
Vault and payment capabilities remain outside both terminal interfaces.

## Offline staging plan (not deployed or qualified)

Review units/portable-workspace.sysusers against the target account database;
refuse pre-existing names with unexpected UID/group/home/shell or memberships.
Stage it under /usr/lib/sysusers.d and create accounts in the image build, not
on the development host. Stage the agent, UI, and workspace units under
/usr/lib/systemd/system.
All staged files and /opt/portable ancestors must be root-owned and non-writable
by service accounts. /opt/portable/bin/node must be the reviewed ARM executable,
not a symlink into a user home; workspace and SDK source remain root-owned.
Check firewall policy admits these exact target UIDs and blocks direct agent
network egress before enabling units. Firewall success is a prerequisite.
The agent owns volatile /run/portable-agent. The independent workspace unit owns
/run/portable-workspace as the agent account, mode0700, so a backend restart need
not remove native shells' working files. Only the IPC socket is group-writable.
No persistent vault is mounted by these units. See
[workspace lifetime and migration](units/workspace-lifetime.md) before changing
an existing guest; static unit changes do not prove terminal survival.

Run systemd-analyze verify on the final assembled image with its real firewall
unit and executable paths. These templates need actual guest qualification of
startup, UID/groups, mounts, firewall refusal and stop/restart before deployment.
PrivateTmp isolates service temporary files; native-client visibility requires
separate design. Service shutdown uses control-group killing; individual PTY
stop handles groups still within its PTY session. Deliberately detached setsid
jobs require cgroup containment and are not claimed contained per terminal.

## Offline tests

Use Node24: node --test portable/workspace-service/tests/service-protocol.test.mjs
portable/workspace/server.test.mjs portable/workspace/agent.test.mjs.
Run tests/run-uid-tests.sh for actual separate kernel UIDs in a private user/mount
namespace; explicit prerequisite skips are not qualification. No provider calls.

## Agent readiness

Status returns promptly with `agent.state: warming`; terminal creation never
waits for SDK imports. The browser refreshes warming/backoff readiness. Agent
starts during warmup or failed-probe backoff return HTTP503 `not-ready`, with no
fallback or queued execution. Internal manager.status() remains an explicit
await-probe helper; HTTP/IPC use the immediate readiness() snapshot.

Only SDK import probes retry: at most3 attempts, 1s then2s backoff. Each attempt
has a60s default deadline. Trusted serviceCLI `--probe-timeout-ms` accepts
1000..120000; request bodies cannot change it. Probe children are killed/reaped
before their outcomes settle; shutdown cancels probes and scheduled retries.
After attempt exhaustion, status stays unavailable until service restart.
No provider inference or paid requests are retried by this readiness mechanism.

Measured cold import in ARM64 QEMU TCG took18–20s; the former15s deadline failed.
This motivates the bounded default, not a physical Raspberry Pi speed claim.
Status/UI/terminals remain independent of agent warmup. The prototype's SDK
uses a scripted local model; ready does not mean live inference is configured.
