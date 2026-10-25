# ZCon demo: an agent computer on a USB stick

For ZCon we built a small computer that runs a private AI agent and pays for it
with Zcash. It is a Raspberry Pi 4, a USB stick it boots from, and a Bluetooth
keyboard. There is no SD card and nothing is installed on the Pi itself.

The idea is to take the incognito session Abalone gives you on a laptop and
make the whole machine incognito. The system runs from RAM, every connection
goes through Tor, and anything worth keeping lives in an encrypted vault on the
stick. Pull the power and the session is gone.

## What you see

About ten seconds after power-on you get a shell. The top two lines keep
themselves up to date:

```
Tor √ NL 192.42.116.17 · Vault locked · Credit unknown
USB, read-only · Wi-Fi demo-network 10.0.0.23
```

That is the Tor exit the Pi is using right now, the vault state, the inference
credit, and how the system was booted. The demo is a handful of commands:

```sh
~/unlock     # open the encrypted vault (asks for the passphrase)
~/agent      # the agent, in the terminal
~/credit     # inference credit left
~/fund       # add credit with Zcash: shows a QR, then watches for the payment
~/lock       # close the vault
~/desktop    # graphical desktop
```

The desktop is the same thing with windows. Super+A opens the agent, Super+W the
wallet, Super+Enter a shell, Super+Z a funding window, and Super+Shift+E goes
back to the console. The bottom bar lists the keys and the top bar repeats the
status line.

## Who can do what

The agent runs shell commands on the same machine that holds the provider key
and the funding wallet, so each job runs as its own Unix user:

- The **operator** is root on the console. Only the operator unlocks the vault
  and starts funding.
- The **agent** runs as an unprivileged user. It can work on files in its
  workspace and send prompts, and that is all. It never holds the provider key.
- The **inference broker** holds the provider key. It accepts one request at a
  time from the agent's user, checked through the kernel (SO_PEERCRED), and
  forwards it to the model.
- **Funding** runs as a separate user with the funding wallet, started only by
  the operator.
- The **desktop** runs as yet another user. Its shell is the agent's, so it
  cannot fund. The Super+Z window gets around that with a small root service
  that runs exactly `~/fund` and nothing else, for the desktop user only.

## Private inference

The agent talks to GLM running on NEAR AI's TEE hosts. Before the first prompt,
the broker fetches the host's attestation: signed Intel TDX and NVIDIA evidence
that ties the running program to a public key. It checks the measurements
against pinned values, then encrypts each request to that key. NEAR's operator
sees encrypted traffic and the paying account, not the conversation. If the
check fails, no prompt is sent.

Failures that happen before an answer comes back (an HTTP error from the
endpoint, a Tor hiccup, a failed attestation fetch) are retried up to three
times. A response that fails validation is refused and never retried.

## Paying with Zcash

`~/fund` turns ZEC into inference credit without a card or an exchange account:

1. It asks NEAR Intents 1Click for a quote:
   your ZEC in, USDC out on Base, delivered to the stick's own Base address.
   The quote comes with a one-time Zcash deposit address, shown as a QR.
2. You send the ZEC from any wallet. The stick watches the swap.
3. When the USDC arrives, the stick pays a NEAR AI invoice with it (through
   Pingpay) and waits until the account credit goes up.
4. It raises the agent key's spending allowance to match.

A $2 top-up costs about $2.28 of ZEC with the swap's slippage allowance, and
takes a few minutes. One agent answer costs about half a cent.

## Where the code is

- [`raspberry-pi/`](../raspberry-pi/README.md): boot image, console and
  desktop ([display](../raspberry-pi/display/README.md)), encrypted
  [storage](../raspberry-pi/storage/README.md), Tor-only
  [network](../raspberry-pi/network/README.md), and the
  [clock](../raspberry-pi/clock/README.md), set from Tor because the Pi has no
  battery-backed clock.
- [`inference/`](../inference/README.md): the broker that holds the key and
  talks to NEAR.
- [`funding/`](../funding/README.md): the Zcash-to-credit flow.
- [`workspace/`](../workspace/README.md): the agent's workspace and tools.
