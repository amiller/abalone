# Third-party binaries on the stick

The stick runs three programs this repository does not build. Each script here
fetches or builds a pinned upstream version and refuses when a hash does not
match.

| Script | Produces | Installed at | Pin |
| --- | --- | --- | --- |
| [fetch-zkool.sh](fetch-zkool.sh) | Zkool 6.34.0 desktop wallet (Super+W) | `/opt/zkool/` | release deb sha256 `c772f238…`; six Debian library debs by version and sha256 from Debian's signed indexes |
| [build-teep.sh](build-teep.sh) | teep, the attestation re-check the broker records | `/opt/portable/vendor/teep/teep` with its `LICENSE` | commit `d24119c8…`, Go 1.27.3, binary sha256 `e19e1d29…` |
| [build-zkool-graphql.sh](build-zkool-graphql.sh) | `zkool_graphql`, the headless Zkool server behind the agent wallet | `/opt/zkool-graphql/zkool_graphql` | tag `zkool-v6.34.0` at commit `51df4f0b…` |

Zkool's aarch64 build needs a newer glibc, libstdc++ and GLib than bookworm has.
fetch-zkool.sh copies those libraries from trixie into `/opt/zkool/lib` and
points the binary's interpreter and rpath there, so the rest of the system
stays on bookworm. Debian drops superseded versions from its indexes, so the
script stops working once one of the pinned versions is replaced; update the
version and hash from the new signed index.

teep is AGPL-3.0. Ship its `LICENSE` and the commit beside the binary.

zkool_graphql has no upstream binary for this target. The script cross-builds
it in a `debian:bookworm` container (not pinned by digest) with the Rust
toolchain the source selects (1.99.0). A rebuild has not been compared with the
binary on the demo stick (sha256 `8610f8dc4ff19f6e10a5196e5ca61684a1595e92dbe0dbee72564fec4ef99ced`,
the stripped output of this build), and Rust builds are not reproducible by
default, so check its hash against your own record.
