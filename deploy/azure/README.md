# Azure deployment contract

This directory is a reviewable template. Applying it to the VM is a separate,
explicit release operation.

- Repository: `/home/azureuser/shannon-ios`
- Writable data only: `/home/azureuser/shannon-ios-data`
- Secrets only: `/home/azureuser/.config/shannon-ios/api.env` (`0600`)
- Isolated Node 24 runtime: `/home/azureuser/shannon-ios-runtime/bin/node`
- Loopback API: `127.0.0.1:4319`
- Public HTTPS base: `https://sh4nnon.com/companion`
- Services: `shannon-ios.service` (response lane) and `shannon-ios-worker.service` (background/sleep lane)

The VM's system Node is currently v20 and cannot run `node:sqlite`. Do not
upgrade it in place because existing Shannon and Aether services use it. Install
an isolated Node 24 LTS runtime at the path above and verify its checksum before
the first release.

After the reviewed release is installed, an operator issues a 30-minute,
single-use code without printing any secret other than that code:

```sh
cd /home/azureuser/shannon-ios
set -a
. /home/azureuser/.config/shannon-ios/api.env
set +a
/home/azureuser/shannon-ios-runtime/bin/node --import tsx services/api/src/authCli.ts issue-code owner
```

List or revoke devices with `list` and `revoke <device-id>`. The database stores
only HMAC digests of codes and tokens. Back up `shannon.sqlite` and its WAL/SHM
files as one SQLite backup unit while preserving mode `0600`.

The API and worker deliberately share only the SQLite file. Install and enable
both unit templates together at the eventual reviewed release; do not run the
new API without the worker, because queued affect and memory updates would then
remain pending. The worker schedules one sleep job per owner/day; transient
failures can retry it up to five times. It uses `SHANNON_SLEEP_TIMEZONE` /
`SHANNON_SLEEP_HOUR` from its unit environment.
