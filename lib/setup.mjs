// `abalone setup --separate-user <folder> [--model <id>]`: prints the one-time root commands for the hardened mode
// (docs/threat-model.md). abalone never runs them. After them, abalone-mcp, the folder and the approvals store belong to
// the `abalone` user; the caller reaches abalone only through /run/abalone/mcp.sock; the human approves with sudo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./config.mjs";

export function separateUser(folder, model) {
  if (!folder || !model) throw new Error("usage: abalone setup --separate-user <folder> --model <provider/model>");
  const dir = fs.realpathSync(folder), node = path.resolve(process.execPath, "../.."), me = os.userInfo().username;
  const parents = dir.split(path.sep).slice(1, -1).map((_, i, a) => "/" + a.slice(0, i + 1).join("/"));
  const shut = parents.find((d) => !(fs.statSync(d).mode & 0o001));
  if (shut) throw new Error(`✗ the abalone user cannot reach ${dir}: ${shut} is not traversable by other users. Move the folder outside it (for example to /srv/abalone/), then run this again`);
  const as = "sudo -u abalone env HOME=/var/lib/abalone PATH=/opt/abalone/node/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/abalone /opt/abalone/app/bin/abalone";
  return `# Hardened mode: run these yourself, once. Run them from a clean checkout: abalone refuses to start if lib/ does not match
# curated/manifest.json. Afterwards ${dir} belongs to the abalone user; you read it with sudo.
sudo useradd --system --create-home --home-dir /var/lib/abalone --shell /usr/sbin/nologin abalone
sudo groupadd -f abalone-callers && sudo usermod -aG abalone-callers ${me}    # log in again for the group to apply
sudo mkdir -p /opt/abalone/app && sudo rsync -a --delete --exclude .git --exclude local-data --exclude runner-home --exclude secrets ${ROOT}/ /opt/abalone/app/
sudo mkdir -p /opt/abalone/app/runner-home && sudo cp -a ${node} /opt/abalone/node && sudo chown -R root:root /opt/abalone
sudo chown -R abalone:abalone ${dir} && sudo chmod -R go-rwx ${dir}
sudo tee /etc/systemd/system/abalone-mcp.service > /dev/null <<'UNIT'
[Unit]
Description=abalone-mcp for ${dir}
[Service]
User=abalone
Group=abalone-callers
WorkingDirectory=${dir}
UMask=0077
RuntimeDirectory=abalone
RuntimeDirectoryMode=0750
ExecStartPre=+/usr/bin/install -d -o abalone -g abalone -m 0700 /var/lib/abalone/.abalone /var/lib/abalone/.abalone/approvals
Environment=XDG_RUNTIME_DIR=/run/abalone PATH=/opt/abalone/node/bin:/usr/bin:/bin
ExecStart=/opt/abalone/app/bin/abalone-mcp --listen /run/abalone/mcp.sock --model ${model}
[Install]
WantedBy=multi-user.target
UNIT
${as} canary init ${dir}
${as} key add ${model.split("/")[0]}    # only for a ◈ attested model; paste its key
sudo systemctl daemon-reload && sudo systemctl enable --now abalone-mcp
stat -c '%a %U:%G %n' /run/abalone /run/abalone/mcp.sock    # expect: 750 abalone:abalone-callers, 660 abalone:abalone-callers
sudo stat -c '%a %U:%G %n' /var/lib/abalone/.abalone/approvals    # expect: 700 abalone:abalone

# Every day:
#   the caller's MCP config:  {"mcpServers":{"abalone":{"command":"${ROOT}/bin/abalone-connect","args":["/run/abalone/mcp.sock"]}}}
#   approve, in your own terminal (sudo asks your password; never add a NOPASSWD rule for this):
#     ${as} approvals
`;
}
