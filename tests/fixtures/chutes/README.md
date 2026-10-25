# Chutes attestation fixtures

`attestation.json` is the existing recorded Chutes instance evidence and encrypted
request/reply fixture. `local-rim.json` contains the exact response bytes (base64)
from two anonymous HTTPS GETs to NVIDIA's public RIM service:

| Signed collateral | Retrieved UTC | Response SHA-256 |
| --- | --- | --- |
| [Driver 595.71.05](https://rim.attestation.nvidia.com/v1/rim/NV_GPU_DRIVER_GH100_595.71.05) | 2026-10-15T17:35:11.905110Z | `85da6189f061a6dd35cbadf1e52ac535d70d9c8d36de503f3797f446fe952589` |
| [VBIOS 96.00.D0.00.03](https://rim.attestation.nvidia.com/v1/rim/NV_GPU_VBIOS_G520_0280_895_9600D00003) | 2026-10-15T17:35:37.347365Z | `a93ec67179390b1bca92ff4c05bd32661b5f1ccf5512839252b3d99a73651bd4` |

These are NVIDIA third-party signed reference manifests, not first-party MIT
code. Retrieval did not establish an explicit redistribution license grant.
**Publication of the added collateral remains pending selected-source review.**
No license or permission is inferred from public availability.

The offline tests verify their certificate chains, XML signatures, validity at
the unchanged Chutes recording time, and measurements against the recorded GPU
reports. Chutes positive controls explicitly skip certificate revocation and
assert the corresponding warning. A separate test proves the default required
revocation mode refuses absent recorded OCSP responses. These fixtures do not
qualify Chutes revocation or current live-provider admission.
