# Third-party notices

The root [MIT license](LICENSE) covers Abalone's first-party code. Component
copyrights and licenses remain with their respective owners; the root license
does not replace them.

- The Pi fork retains [Mario Zechner's MIT notice](vendor/pi/LICENSE).
- ACI components retain their notices in [provider](vendor/phala-aci/provider/LICENSE),
  [verifier-ts](vendor/phala-aci/verifier-ts/LICENSE), [pi-provider-aci](vendor/phala-aci/pi-provider-aci/LICENSE),
  [pi-provider-phala-cloud](vendor/phala-aci/pi-provider-phala-cloud/LICENSE) and
  [pi-provider-redpill](vendor/phala-aci/pi-provider-redpill/LICENSE).
- The vendored dstack issuer verifier has its source and adaptation recorded in
  [its provenance document](lib/vendor/dstack-issuer/README.md). It is first-party
  code selected from the paired dsmack project; publishing this verifier does not
  publish the issuer service or its private repository history.
- Locked npm dependencies retain their own package licenses and notices. Built
  release archives include those installed dependency files. Review them together
  with the package-lock files when changing the dependency set.
