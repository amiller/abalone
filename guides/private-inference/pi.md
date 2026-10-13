Status: draft

# Private inference in ordinary Pi

Use Chutes private inference from your usual Pi, with instance verification and
encrypted requests. This source preview adds a provider, not another agent
interface. Native read, edit and other tool requests are sealed with the complete
request. No coupon software, Abalone launcher, Linux sandbox or custom session
directory is loaded.

## Add the provider integration

You need [Pi](../../vendor/pi/packages/coding-agent/README.md) 1.1.0, Node
22.19 or newer, and private inference access from Chutes. The independent package
has been exercised with published Pi on Linux; macOS and Windows execution remain
untested. The commands below use Bash. These are requirements for this procedure,
not for reading the guides or using a different private inference provider.

From a checkout of this repository:

```sh
npm pack ./verifiers/chutes
private_inference_package="$PWD/abalone-pi-private-inference-chutes-0.1.0.tgz"
cd examples/private-inference
```

Pi manages the provider's dependencies outside this checkout when it loads the
archive. There is no root install or vendored Pi build, and no dependencies are
added inside the optional client's verified source tree. The package is not yet
published to npm. Inspect
[its source](../../verifiers/chutes/pi-extension.ts) before adding it to your Pi.

Read your Chutes private-inference API key privately, then launch your Pi:

```sh
read -rsp 'Chutes private-inference API key: ' CHUTES_API_KEY
echo
export CHUTES_API_KEY
pi -e "npm:$private_inference_package" --provider abalone-chutes --no-session
unset CHUTES_API_KEY
```

The key is in the environment inherited by Pi and its tools. This integration
does not save it to a credential store. Other processes running as you or your
administrator can inspect it. Use a scoped credential where available. Never
paste it in a prompt or put its value in a shell command.

`-e` loads the package for this invocation without adding it to Pi's saved package
settings. Pi still caches the package and its dependencies in its own directory.
To keep it in Pi's configuration, use `pi install "npm:$private_inference_package"`.
Select a model under **Chutes private inference (Abalone)**
with Pi's usual `/model` picker. The status starts at **not checked yet**.
Before a prompt is sent, the integration verifies the chosen instance, then
seals the entire request to its verified key. Provider model lists are contacted
at startup; Intel and NVIDIA verification services are contacted when checking
an instance. These contacts contain verification metadata, not your prompt.

## Get a useful result

The folder contains [sample.md](../../examples/private-inference/sample.md), a
synthetic meeting note. Try these in order:

1. “Read sample.md and summarize the decision and next action.”
2. “Who is responsible, and when should they finish?”
3. “Edit sample.md to change Status: draft to Status: ready.”

Pi's normal read and edit tools execute locally. Their arguments and results are
included in the protected requests. You can choose your own folder instead, or
ask a question without reading any files.

## Connections and retention

The integration adds private inference, not local isolation. Tools retain Pi's
ordinary filesystem and network access. Other installed providers and extensions
remain available; choosing another model changes the inference destination.
The private-inference status disappears when another provider is selected.
Pi's ordinary Chutes provider is separate from `abalone-chutes` and does not
provide this integration's protected path. Incompatible model/API overrides are
refused during credential resolution, including for history summaries.

`--no-session` disables Pi's conversation-file persistence. It does not move all
Pi state into memory, erase tool output, remove terminal scrollback or undo file
edits. Without it, Pi retains conversations according to its usual settings.
The included Abalone client's Linux sandbox and temporary-state preparation are
separate options with separate platform requirements.

Verification refuses invalid evidence before sending prompt bytes. Encrypted
replies are authenticated in full before being passed to Pi. There is no streaming
provider response: Chutes' current encrypted stream does not authenticate ordering.
Automatic billing retries are disabled; after a failed request, check provider
usage before explicitly trying again. Pi can still make further requests for
tool results or its normal session features.

The measurements pin Chutes' VM image. They do not measure the serving code that
reads your prompt, establish provider retention, or prove which model answers.
Chutes sees your account, selected model and instance, sizes and timing. See
[the provider coverage](../../verifiers/chutes/README.md) and
[security profiles](../../docs/security.md).

## Other private inference providers

The package is deliberately one provider integration. Other private inference
providers can use the same Pi package mechanism with their own verifier and
protected transport. NEAR needs a different adapter because native tool arguments
are outside its current encrypted fields. Existing NEAR coupons continue to use
[the included client](../../docs/abalone-coupon-redeem.md); do not use those
credentials as Chutes access.
