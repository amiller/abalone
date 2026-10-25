# Early persistent API policy

This source-only policy targets Linux EFI runtime variables and pstore. It is
not whole-system amnesia, firmware write prevention, or protection from trusted
root deliberately reversing the policy. No kernel boot has qualified it yet.

The earlier volatile-root rehearsal found writable efivarfs and pstore after
boot. Remounting those read-only proved only their later mount state. It did not
exclude earlier writes, or pstore backend writes on panic without a mount.

## Supported assembly

Prepare a literal, single kernel command line containing exactly one each of:

```text
efi=noruntime pstore.backend=none
```

The image assembler must bind the **actual kernel binary, matching configuration,
release, initramfs and bootloader-selected command line** in its reviewed manifest.
The stager records configuration/command-line hashes but does not prove that the
configuration belongs to the kernel binary. Only independently reviewed Linux
6.1/6.12 parameter semantics are considered here; another kernel needs review.
The runtime release check alone is not a kernel binary integrity check.

`CONFIG_EFI=y` or explicitly disabled is supported. `CONFIG_PSTORE=y` requires
an observed read-only backend parameter value `none`; explicitly disabled pstore
requires its module and sysfs API to remain absent. **Loadable pstore is refused**:
this slice does not rely on modprobe forwarding command-line parameters to a later
module load. Built-in pstore's backend selector is read-only and registration of
a different named backend is refused before its dump/console/pmsg callbacks are
registered. A future backend named `none` would invalidate this policy and needs
kernel review. Other persistent kernel interfaces are outside this narrow scope.

The selected Pi kernels also have `CONFIG_PSTORE_RAM=y`. Ramoops initializes
reserved RAM zones **before** calling `pstore_register()`. Therefore `none`
prevents recording callbacks, not all initialization writes by every potential
backend driver. A claim of zero backend writes additionally requires the actual
selected device tree/overlays and boot parameters to exclude ramoops reservations,
or a separately reviewed earlier inhibition. This slice does not claim that
stronger property. See [Linux 6.12 ramoops probe ordering](https://github.com/torvalds/linux/blob/v6.12/fs/pstore/ram.c).

Both staging passes are required. First use `stage-volatile-root.sh` as documented
in [README.md](README.md), then (using separately reviewed inputs):

```sh
python3 portable/raspberry-pi/image/stage-persistent-api.py \
  --sysroot /absolute/offline/tree \
  --kernel-release REVIEWED-RELEASE \
  --kernel-config /reviewed/kernel.config \
  --cmdline-file /reviewed/literal-cmdline.txt
```

This is a dry run. `--apply --confirm PERSISTENT-API-IMAGE` requires root and
writes only the checked, exclusively controlled offline tree. It never changes
kernel arguments, builds an initramfs, mounts anything, formats a device, or
changes the running host. Existing differing policy files, drop-ins, symlinks,
hardlinks and noncanonical root aliases refuse staging. No concurrent writer is
supported. After the separate authorized build, the mandatory archive audit now
requires both persistent-API scripts and their reviewed helper/config hashes.

## Boot order and refusal

1. Kernel parameters disable EFI runtime calls and pstore backend registration
   before initramfs userspace. Missing/conflicting/duplicate parameters refuse.
   The policy cannot retroactively undo writes on a misconfigured boot; such a
   boot never qualifies, even if the initramfs subsequently shuts down.
2. `00-portable-persistent-api` must be the **first init-top entry**, followed by
   `00-portable-volatile-guard`. It verifies the kernel release/backend and
   establishes tiny, empty, read-only tmpfs barriers over existing canonical
   pstore/efivars sysfs mountpoints. They are read-only on the first mount.
   Real pstore/efivarfs mounts anywhere, even already read-only, refuse instead
   of being covered up. Unknown, writable or stacked API mounts refuse.
3. The last init-bottom entry checks the barriers without repairing them. The
   reviewed `/init` must move the same `/sys` tree, with child mounts intact,
   after that check. Every generated ORDER entry and `/init` remains hash-reviewed;
   the audit is not a general shell-program proof of arbitrary init scripts.
4. Systemd's early `mount_setup()` runs before ordinary units and ignores unit
   masks for its internal mount table. It skips paths already mounted, so the
   barriers prevent new writable API mounts. A required, default-dependency-free
   sysinit checker verifies the actual namespace again; failure requests poweroff.
   Direct `Requires=` plus `After=` drop-ins also gate network-pre, networkd's
   service/socket, Tor/firewall, workspace/agent/UI/native/display, and the
   supported getty/user-session/display-manager entry points. This blocks their
   activation on checker failure even with `DefaultDependencies=no`; target
   ordering or `Wants=` alone would not. Other enabled early networking or
   interactive units must be inventoried and admitted before image qualification.
   Explicit pstore/efivars mount/automount units and systemd-pstore are masked to
   prevent later normal activation/archival. This does not constrain malicious
   root or an unreviewed privileged unit that manually remounts/unmounts paths.

Non-EFI Raspberry Pi boots may lack the EFI directory; absence is accepted
without creating a fake EFI interface. Pstore absence is accepted only for the
reviewed disabled configuration, not inferred from “this is a Pi.” Recovery/off
boot is not an exception in this new policy: use a separately identified,
non-private recovery image rather than silently bypassing these checks.

## Qualification still required

Offline fixtures exercise duplicate/conflicting arguments, wrong kernel/backend,
late-check missing barriers, loadable/unknown pstore, real API mounts, writable and
stacked barriers, hidden ancestors, non-EFI absence, staging containment/conflicts,
and generated ordering/helper/app-let omissions. They do not execute kernel mounts.

An isolated new image must establish actual cmdline/config/kernel binding, no
registered pstore backend, no active ramoops/pstore_blk/EFI backend for the chosen
configuration and actual selected device tree/overlays, first initramfs barriers and their read-only flags,
no intervening real API mounts, `/sys` child survival into PID1, successful required
sysinit gate, and unchanged firmware-variable backing across the bounded test.
Also qualify failure before interactive/network/agent service startup when a
parameter or barrier is missing. Firmware/bootloader activity before Linux's
parameter processing, other firmware interfaces, other storage devices and
privileged policy reversal remain outside the guarantee. No session-record
retention claim is admitted until that selected-image/device evidence exists.

## Primary sources

- Linux [EFI parameter implementation (6.1)](https://github.com/torvalds/linux/blob/v6.1/drivers/firmware/efi/efi.c)
  and [6.12](https://github.com/torvalds/linux/blob/v6.12/drivers/firmware/efi/efi.c):
  `noruntime` disables runtime; `runtime` can override it. EFI boot itself may
  still expose its sysfs directory, so absence of that directory is not required.
- Linux [pstore registration (6.1)](https://github.com/torvalds/linux/blob/v6.1/fs/pstore/platform.c)
  and [6.12](https://github.com/torvalds/linux/blob/v6.12/fs/pstore/platform.c):
  backend selection precedes callback registration; read-only filesystem views
  do not disable the backend's kernel writes.
- Systemd [v252 internal mount setup](https://github.com/systemd/systemd/blob/v252/src/shared/mount-setup.c)
  mounts both APIs early and skips already-mounted paths. Later systemd versions
  require the same source review before reusing this ordering argument.
- [systemd-pstore](https://github.com/systemd/systemd/blob/v252/man/systemd-pstore.service.xml)
  documents userspace archival, a separate mechanism from kernel persistence.
